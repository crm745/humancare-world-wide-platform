// Malware scanning, content identity and duplicate protection for the ORIGINAL document path (the `documents` table, attached to a Case). Used by the patient upload
// (POST /requests/me/:id/documents for requests outside the review workflow) and by the corporate case upload (POST /cases/:id/documents).
//
// SCAN BEFORE STORE. The review workflow keeps a document in `request_documents` with a scan status and lets nobody open it until ClamAV has said "clean" (the scan worker retries a
// scan that could not run). The original path has no status columns, so it gets the same guarantee a different way, with no second scanner and no schema change: a document is
// scanned BEFORE its row exists. The uploaded file sits in the uploads folder, unreferenced, while it is scanned; the row is created only after a confirmed "clean" verdict, and only then
// can anything (the patient's download, the corporate portal, the Bitrix24 medical-report message and its retry sweep) ever see the document. So:
//   clean                      the row is created and the rest happens as before
//   infected                   422 `file_infected`; the file is moved to the quarantine folder; no row, nothing sent anywhere
//   scanner down, timeout, an unexpected answer, an unreadable file, or the bytes changed while they were scanned
//                              503 `scan_unavailable`; the file is deleted; no row, nothing sent anywhere. FAIL CLOSED: "no verdict" is never "clean"
// A refused upload leaves nothing behind that could be opened, so there is no pending state to recover: the app tells the person, and the same upload (same id) can simply be sent
// again once the scanner is back. (The unscanned documents that existed before this change are untouched and served as they always were.)
//
// The scan is bound to the file's SHA-256, taken before and after: "clean" describes exactly the bytes that are kept.
const fs = require('fs');
const path = require('path');
const clamav = require('../../integrations/clamav/clamav');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const { httpError, hashFile } = require('../request-review/request-review.files');
const { keyFromStoredReference } = require('../../storage/keys');
const { storageFor } = require('../../storage');
const { hashStream } = require('../../storage/meter');

const ENGINE = clamav.ENGINE || 'clamav';

// QUARANTINE (local disk only). An infected upload is the multer temporary file of THIS request: it was never stored, so it is the only thing that can be here (an infected object in the storage
// service is never copied here). The folder is created 0700 and each quarantined file 0600, like the storage service's own folders and files (storage/local.adapter.js): only the account the
// server runs as can read them. Nothing in the application ever serves, reads or deletes this folder.
//
// RETENTION (approved policy):
//   * a quarantined file is retained for 30 days, for Operations to look at the scan report and the audit entry;
//   * retention is extended, up to 90 days, when an investigation requires it;
//   * NO automatic deletion and NO cleanup script is approved or implemented: nothing in the application removes a file from this folder, so removing one once its retention has passed is a
//     manual action by a person;
//   * an infected object in the storage service (S3) is never moved or deleted by this code or by the legacy backfill (documents/legacy-backfill.js): its scan verdict blocks every use of it,
//     and moving or deleting it needs explicit review and approval;
//   * this folder is on the host's own disk, so it is lost on a redeploy and is per instance. The audit entry and the scan verdict are the record that outlives the file; a file is never copied
//     to object storage without a separate decision.
const QUARANTINE_DIR = path.join(UPLOAD_DIR, 'quarantine');
const QUARANTINE_DIR_MODE = 0o700;
const QUARANTINE_FILE_MODE = 0o600;

const remove = (file) => fs.promises.rm(file, { force: true }).catch(() => {});

// Moves an infected upload out of the uploads folder, for the record. If that cannot be done the file is deleted instead: an infected file must not stay where it was.
async function quarantine(file) {
  try {
    await fs.promises.mkdir(QUARANTINE_DIR, { recursive: true, mode: QUARANTINE_DIR_MODE });
    const target = path.join(QUARANTINE_DIR, path.basename(file.path));
    await fs.promises.rename(file.path, target);
    // The mode of mkdir only applies to a folder that is created now (and is cut by the umask), so both are set explicitly. Best effort: it never undoes the move.
    await fs.promises.chmod(QUARANTINE_DIR, QUARANTINE_DIR_MODE).catch(() => undefined);
    await fs.promises.chmod(target, QUARANTINE_FILE_MODE).catch(() => undefined);
  } catch (err) {
    console.error(`[scan] an INFECTED upload could not be moved to quarantine (${err.code || 'unknown error'}); it was deleted instead.`);
    await remove(file.path);
  }
}

const unavailable = () => httpError(
  503, 'We could not scan this file for viruses right now, so it was not saved. Please try again in a moment.', 'scan_unavailable',
);

// Resolves { sha256, engine, scannedAt } only after a CONFIRMED clean verdict (the record the new row stores); otherwise throws (and the file is quarantined or deleted). `expectedSha256` (optional) is the digest the caller
// already took: the file must still be exactly that. `scanner` is injectable for tests; production uses ClamAV.
async function scanBeforeStore(file, { expectedSha256, scanner } = {}) {
  const scan = scanner || clamav.scanFile;
  let before;
  try {
    before = await hashFile(file.path);
  } catch {
    await remove(file.path);
    throw unavailable();
  }
  if (expectedSha256 && before !== expectedSha256) {
    await remove(file.path);
    throw unavailable(); // the file is not what was received: it cannot be vouched for
  }
  let verdict;
  try {
    verdict = await scan(file.path);
  } catch {
    verdict = { status: 'error' };
  }
  if (verdict && verdict.status === 'infected') {
    await quarantine(file);
    throw httpError(422, 'This file was blocked because it may contain a virus. It was not saved.', 'file_infected');
  }
  if (!verdict || verdict.status !== 'clean') {
    await remove(file.path); // no verdict is not "clean"
    throw unavailable();
  }
  let after;
  try {
    after = await hashFile(file.path);
  } catch {
    after = null;
  }
  if (after !== before) {
    await remove(file.path);
    throw unavailable(); // the file changed while it was scanned
  }
  return { sha256: before, engine: ENGINE, scannedAt: new Date() };
}

// Whether the stored file of a saved document has exactly this content. A document stored with a clean scan record carries the digest of the bytes that were kept, which is compared
// directly; an older row has none, so the stored object is hashed (through the storage service: a local file or an object-storage key). A file that cannot be read is NOT vouched
// for: a repeat is only ever answered with a document whose content is known to be the same.
async function sameStoredContent(document, sha256) {
  if (!sha256 || !document || !document.fileUrl) return false;
  if (document.sha256) return document.sha256 === sha256;
  try {
    const key = keyFromStoredReference(document.fileUrl); // a storage key, or "/uploads/<filename>" for a file stored before object storage
    const object = await storageFor(key).download(key);
    return (await hashStream(object.stream)).sha256 === sha256;
  } catch {
    return false;
  }
}

// One upload id at a time (per process): a second copy of the same upload waits for the first, then finds its document and is answered from it, so it is neither scanned nor sent to
// Bitrix a second time. The unique index remains the final protection across processes.
const queues = new Map();
function withUploadLock(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

module.exports = { scanBeforeStore, sameStoredContent, withUploadLock, QUARANTINE_DIR, QUARANTINE_DIR_MODE, QUARANTINE_FILE_MODE, ENGINE };
