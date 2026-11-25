// The controlled backfill of scan records for LEGACY documents (the `documents` table): files uploaded before scanning existed, whose scan_status is NULL (never scanned = not clean).
// Run by hand (scripts/backfill-legacy-document-scans.js); nothing schedules it.
//
//   dry run (the default)   READ ONLY: counts the rows by status, picks the ones a run would process, and looks at each stored file (does it exist, can it be read). It claims nothing,
//                           scans nothing, writes nothing, moves nothing.
//   execute                 for each selected row: CLAIM it (a compare-and-swap that also takes a lease, so two runs never scan the same row), hash the file, scan it with the existing ClamAV
//                           client, hash it again, then record the outcome TOGETHER WITH its audit entry in one transaction (if the audit cannot be written the verdict is not recorded and the
//                           claim expires). An infected file is MOVED to the quarantine folder, never deleted.
//
// OUTCOMES (documents/document-scan.js has the meaning of each status)
//   clean       confirmed clean verdict, the file unchanged around the scan: sha256, engine and time are recorded
//   infected    quarantined; recorded with the signature name for Operations
//   error       no verdict (scanner answered with an error, the file changed while scanned, a transient read problem): retried with bounded backoff (BACKOFF_MINUTES), up to MAX_ATTEMPTS
//   failed      can never be scanned: the file is missing (and the storage is healthy), unreadable, or the retries are used up. Final: a human decides.
// If ClamAV itself is not answering the attempt is given back and the run STOPS (an outage must not use up retries or fail valid documents).
//
// WHERE THE FILE IS. A row whose file_url is a bare name or "/uploads/<name>" was written by the old local-disk code and is read from the upload folder, exactly as before. A row whose
// file_url is a GENERATED storage key ("<area>/<yyyy>/<mm>/<hex>.<ext>": written through the storage service, in S3 or in the local adapter) is read THROUGH THE STORAGE SERVICE: the object is
// streamed into a private temporary file (object-staging.js: a 0700 folder, a 0600 file, size-capped, removed afterwards), hashed, scanned and hashed again, so the verdict is bound to exactly those bytes. Nothing
// assumes an object is under the upload folder, and an object that is not there is never read as a local path.
//   an object that is genuinely missing is `failed` (final), but only when the object storage can be confirmed healthy: a known-clean object of the same storage must still be reachable. A wrong
//   bucket or region, a revoked credential, an outage or an unconfirmed state would otherwise "lose" every object at once; those are `error` (retried with backoff), never final.
//   an object that cannot be read for any other reason, or that the scanner cannot judge, is `error` (retried) or, when it is larger than the upload limit, `failed`: it is never marked clean.
//   an INFECTED object keeps its `infected` verdict (which blocks every use of it, the owner included) but is NOT moved or deleted here: that would be an object-storage action nobody approved.
//   It is listed in the report (infectedObjectsInStorage) for Operations; the temporary copy is deleted.
//
// IDEMPOTENT AND SAFE TO RERUN: only rows with no verdict yet (NULL), an expired claim, or an 'error' that is due and under the attempt limit are selected. clean, infected and failed are final and
// are never selected again, so a confirmed clean result is never overwritten (there is deliberately no "rescan" option: that would be a separate, reviewed policy).
//
// AUDIT: one `audit_logs` row per processed document through the existing business-audit writer (entity "document", action "legacy_document_scan", the outcome as a reason code and in
// afterData.status; ids and state names only, never a file name or content). No new table is needed. audit_logs comes from migration M3: an execute run refuses to start if it is not there.
//
// Pure of the database client and the file system: both are injected, so the tests run it on a fake database and temporary files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { keyFromStoredReference } = require('../../storage/keys');
const { stageObject, releaseStaged } = require('./object-staging');
const { isNotFound } = require('../../storage/errors');

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [5, 15, 60, 240]; // after the 1st..4th failed attempt; the 5th is final
const LEASE_MINUTES = 15; // how long a claim is honoured before another run may take the row over
const DEFAULT_LIMIT = 200;
const UNREADABLE_FS = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);
const MAX_OBJECT_BYTES = 10 * 1024 * 1024; // the upload limit (storage/ingest.js MAX_UPLOAD_BYTES): a legacy object larger than this cannot have come through an upload
const WITNESSES = 5; // how many known-clean objects are tried to confirm that the object storage itself is healthy

const minutes = (n) => n * 60 * 1000;
const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

function hashFileWith(fsApi) {
  return (file) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fsApi.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// The rows still to be processed: no verdict yet, a claim that was abandoned (its lease ran out), or a retryable error that is due.
const selectionWhere = (nowMs) => ({
  OR: [
    { scanStatus: null },
    { scanStatus: 'pending', scanNextAttemptAt: { lt: new Date(nowMs) } },
    { scanStatus: 'error', scanAttempts: { lt: MAX_ATTEMPTS }, OR: [{ scanNextAttemptAt: null }, { scanNextAttemptAt: { lte: new Date(nowMs) } }] },
  ],
});

const CANDIDATE_SELECT = {
  id: true, caseId: true, type: true, fileUrl: true, scanStatus: true, scanAttempts: true,
  case: { select: { id: true, referenceNumber: true, bitrixLeadId: true, serviceRequest: { select: { id: true, referenceNumber: true, bitrixLeadId: true } } } },
};

// Where this row's report line points, and whether the code and data can say it was probably forwarded to Bitrix24. A Medical Report on a Case whose request or Case has a Bitrix24 lead
// WAS sent to that lead at upload time or by the retry sweep (both did, before the clean-scan gate): that is an inference from the lead's existence, not a record of a send.
function describeRow(row) {
  const kase = row.case || {};
  const request = kase.serviceRequest || null;
  const leadId = (request && request.bitrixLeadId) || kase.bitrixLeadId || null;
  return {
    documentId: row.id,
    caseId: row.caseId,
    caseReference: kase.referenceNumber || null,
    requestId: request ? request.id : null,
    requestReference: request ? request.referenceNumber : null,
    type: row.type || null,
    bitrixLeadId: leadId,
    possiblyForwardedToBitrix: row.type === 'Medical Report' && !!leadId,
  };
}

// A generated storage key lives in the storage service (S3 or the local adapter); a bare name or "/uploads/<name>" was written by the old local-disk code.
const isStoredObject = (fileUrl) => keyFromStoredReference(fileUrl).includes('/');

// The row's key, and the adapter that holds it (the storage service decides: a local adapter for a legacy key, the configured provider otherwise).
const adapterFor = (storage, key) => storage.storageFor(key);

// Is the object storage itself healthy? True only when a known-CLEAN object (one a new upload stored, scan_status 'clean', with a generated key) can still be found in it. No such object, or
// any error, is "not sure" (false): a missing object is then retried, never failed for good.
async function objectStorageHealthy({ db, storage }) {
  let rows = [];
  try {
    rows = await db.document.findMany({ where: { scanStatus: 'clean', NOT: { fileUrl: { startsWith: '/uploads/' } } }, orderBy: { id: 'desc' }, take: WITNESSES * 4, select: { fileUrl: true } });
  } catch {
    return false;
  }
  let tried = 0;
  for (const row of rows) {
    if (!row.fileUrl || !isStoredObject(row.fileUrl)) continue;
    const key = keyFromStoredReference(row.fileUrl);
    try {
      if (await adapterFor(storage, key).getMetadata(key)) return true;
    } catch {
      return false; // the storage could not be asked: not sure
    }
    tried += 1;
    if (tried >= WITNESSES) break;
  }
  return false;
}

// READ ONLY look at one stored object: 'readable' (it is there), 'missing' (the storage answered that it is not) or 'storage_unavailable' (it could not be asked).
async function inspectObject(storage, key) {
  try {
    return (await adapterFor(storage, key).getMetadata(key)) ? 'readable' : 'missing';
  } catch {
    return 'storage_unavailable';
  }
}

async function backfillLegacyDocuments({
  db, execute = false, limit = DEFAULT_LIMIT, scanner, ping, uploadDir, quarantineDir, fsApi = fs, clock = Date.now, runId = `backfill-${Date.now()}`, log = () => {},
  storage = null, tempDir = os.tmpdir(), maxObjectBytes = MAX_OBJECT_BYTES,
}) {
  const hash = hashFileWith(fsApi);
  // The storage service, only touched for a row that lives in it (a run over local legacy files alone never loads it).
  const theStorage = () => storage || require('../../storage');
  const started = clock();
  const report = {
    mode: execute ? 'execute' : 'dry-run', runId, startedAt: new Date(started).toISOString(), finishedAt: null, limit,
    legacyRowsByStatus: {}, selected: 0, processed: 0,
    outcomes: { clean: 0, infected: 0, error: 0, failed: 0, skipped: 0 },
    scannerUnavailable: false, aborted: null, quarantineFailures: 0,
    items: [], infectedPossiblyForwardedToBitrix: [], infectedObjectsInStorage: [],
  };

  // Where the documents are by status (a read-only count).
  const grouped = await db.document.groupBy({ by: ['scanStatus'], _count: { _all: true } });
  for (const g of grouped) report.legacyRowsByStatus[g.scanStatus === null ? 'unscanned' : g.scanStatus] = g._count._all;

  if (execute) {
    // Refuse to start when what the run needs is not there: the scan columns and the audit table. Nothing is touched.
    try { await db.document.findFirst({ select: { scanStatus: true } }); } catch { report.aborted = 'scan_columns_missing'; return finish(report, clock); }
    try { await db.auditLog.findFirst({ select: { id: true } }); } catch { report.aborted = 'audit_unavailable'; return finish(report, clock); }
  }

  const candidates = await db.document.findMany({ where: selectionWhere(clock()), orderBy: { id: 'asc' }, take: limit, select: CANDIDATE_SELECT });
  report.selected = candidates.length;

  for (const row of candidates) {
    const stored = isStoredObject(row.fileUrl || '');
    const key = stored ? keyFromStoredReference(row.fileUrl) : null;
    const file = stored ? null : path.join(uploadDir, path.basename(row.fileUrl || ''));
    const item = { ...describeRow(row), previousStatus: row.scanStatus === null ? 'unscanned' : row.scanStatus, source: stored ? 'object' : 'local' };

    if (!execute && stored) {
      // READ ONLY: does the storage service have the object?
      item.file = await inspectObject(theStorage(), key);
      report.items.push(item);
      continue;
    }
    if (!execute) {
      // READ ONLY: does the stored file exist and can it be read?
      try {
        if (!(await fsApi.promises.stat(file)).isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
        await fsApi.promises.access(file, fs.constants.R_OK);
        item.file = 'readable';
      } catch (err) {
        item.file = err.code === 'ENOENT' ? 'missing' : 'unreadable';
      }
      report.items.push(item);
      continue;
    }

    // 1. CLAIM (compare-and-swap + lease). Another run that got there first leaves this row alone.
    const attempts = row.scanAttempts + 1;
    const claim = await db.document.updateMany({
      where: { id: row.id, scanStatus: row.scanStatus, scanAttempts: row.scanAttempts },
      data: { scanStatus: 'pending', scanAttempts: attempts, scanNextAttemptAt: new Date(clock() + minutes(LEASE_MINUTES)) },
    });
    if (claim.count !== 1) { report.outcomes.skipped += 1; item.outcome = 'skipped'; item.detail = 'claimed by another run'; report.items.push(item); continue; }

    // 2. HASH, SCAN, HASH.
    const verdict = stored
      ? await evaluateObject({ key, db, storage: theStorage(), scanner, tempDir, maxBytes: maxObjectBytes })
      : await evaluate({ file, hash, scanner, fsApi, uploadDir });
    let status = verdict.status;
    let detail = clip(verdict.detail, 255);
    let nextAttemptAt = null;
    let savedAttempts = attempts;

    if (status === 'error') {
      // An error verdict while ClamAV itself is not answering is not this document's fault: give the attempt back and stop the whole run.
      if (verdict.scanner && !(await ping())) {
        await db.document.updateMany({
          where: { id: row.id, scanStatus: 'pending', scanAttempts: attempts },
          data: { scanStatus: row.scanStatus, scanAttempts: row.scanAttempts, scanNextAttemptAt: null },
        });
        report.scannerUnavailable = true;
        item.outcome = 'not processed'; item.detail = 'the scanner is not answering; the attempt was given back';
        report.items.push(item);
        break;
      }
      if (attempts >= MAX_ATTEMPTS) { status = 'failed'; detail = clip(`retries used up (${attempts}): ${detail || 'no verdict'}`, 255); } else nextAttemptAt = new Date(clock() + minutes(BACKOFF_MINUTES[attempts - 1]));
    }

    // 3. RECORD the outcome and its audit entry together. Only a row still claimed by THIS run is written (the first verdict stands).
    const data = { scanStatus: status, scanEngine: status === 'clean' || status === 'infected' ? verdict.engine || null : null, scanDetail: detail, scannedAt: new Date(clock()), scanAttempts: savedAttempts, scanNextAttemptAt: nextAttemptAt };
    if (verdict.sha256) data.sha256 = verdict.sha256;
    try {
      await db.$transaction(async (tx) => {
        const written = await tx.document.updateMany({ where: { id: row.id, scanStatus: 'pending', scanAttempts: attempts }, data });
        if (written.count !== 1) throw new Error('the claim was lost');
        await appendAuditLog(tx, {
          caseId: row.caseId, entityType: 'document', entityId: String(row.id), action: 'legacy_document_scan', actorType: 'system', actorId: 'backfill', source: 'backfill',
          reasonCode: `scan_${status}`, beforeData: { status: row.scanStatus === null ? 'unscanned' : row.scanStatus }, afterData: { status, caseId: row.caseId }, correlationId: runId,
        });
      });
    } catch (err) {
      // Not recorded (the audit entry or the write failed): the row stays claimed until its lease runs out, then a later run tries again.
      report.outcomes.skipped += 1; item.outcome = 'not recorded'; item.detail = clip(err.message, 120); report.items.push(item); log(`document ${row.id}: outcome not recorded (${err.message})`);
      continue;
    }

    // 4. QUARANTINE (after the verdict is saved): move, never delete.
    if (status === 'infected') {
      if (stored) {
        // An object in the storage service is neither moved nor deleted here (no approved object-storage action): its `infected` verdict blocks every use of it, and Operations are told.
        item.quarantined = false;
        item.objectLeftInStorage = true;
        report.infectedObjectsInStorage.push({ documentId: item.documentId, caseReference: item.caseReference, signature: clip(verdict.signature, 120) });
      } else {
        item.quarantined = await quarantine(file, quarantineDir, fsApi);
        if (!item.quarantined) report.quarantineFailures += 1;
      }
      item.signature = clip(verdict.signature, 120); // (a file name is never copied into the report)
      if (item.possiblyForwardedToBitrix) report.infectedPossiblyForwardedToBitrix.push({ documentId: item.documentId, caseReference: item.caseReference, requestReference: item.requestReference, bitrixLeadId: item.bitrixLeadId, signature: item.signature });
    }
    report.processed += 1;
    report.outcomes[status] += 1;
    item.outcome = status;
    if (detail && status !== 'infected') item.detail = detail;
    report.items.push(item);
    log(`document ${row.id}: ${status}`);
  }
  return finish(report, clock);
}

function finish(report, clock) {
  report.finishedAt = new Date(clock()).toISOString();
  return report;
}

// Hash, scan, hash. Resolves { status, detail, sha256, engine, signature, scanner } and never throws.
async function evaluate({ file, hash, scanner, fsApi, uploadDir }) {
  let before;
  try {
    before = await hash(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // A missing file is final only if the storage itself is healthy (a folder that is gone or empty would "lose" every file at once, and a retry brings them back).
      return (await storageHealthy(uploadDir, fsApi)) ? { status: 'failed', detail: 'the stored file is missing' } : { status: 'error', detail: 'the stored file was not found and the upload folder looks unavailable' };
    }
    if (UNREADABLE_FS.has(err.code)) return { status: 'failed', detail: `the stored file cannot be read (${err.code})` };
    return { status: 'error', detail: `the file could not be read for now (${err.code || 'unknown error'})` };
  }
  return judge({ file, before, hash, scanner });
}

// Scan a file whose digest is already known (`before`), hash it again and decide. Shared by local files and staged objects. Resolves { status, detail, sha256, engine, signature, scanner }.
async function judge({ file, before, hash, scanner }) {
  let result;
  try {
    result = await scanner(file);
  } catch {
    result = { status: 'error', detail: 'the scanner could not be reached' };
  }
  if (result && result.status === 'infected') return { status: 'infected', detail: 'infected', signature: result.signature, sha256: before, engine: result.engine || 'clamav' };
  if (!result || result.status !== 'clean') return { status: 'error', detail: (result && result.detail) || 'no verdict', scanner: true };
  let after;
  try { after = await hash(file); } catch { after = null; }
  if (after !== before) return { status: 'error', detail: 'the file changed while it was being scanned' };
  return { status: 'clean', sha256: before, engine: result.engine || 'clamav' };
}

// One object in the storage service: stage it, scan the staged copy, decide; the staged copy is always removed. Never throws.
async function evaluateObject({ key, db, storage, scanner, tempDir, maxBytes }) {
  let staged;
  try {
    staged = await stageObject(adapterFor(storage, key), key, { tempDir, maxBytes });
  } catch (err) {
    if (err && err.code === 'too_large') return { status: 'failed', detail: 'the stored object is larger than the upload limit, so it cannot be scanned' };
    if (isNotFound(err)) {
      // Missing is final only if the object storage is confirmed healthy (a wrong bucket, a revoked credential or an outage would "lose" every object at once, and a retry brings them back).
      return (await objectStorageHealthy({ db, storage })) ? { status: 'failed', detail: 'the stored object is missing' } : { status: 'error', detail: 'the stored object was not found and the object storage could not be confirmed healthy' };
    }
    return { status: 'error', detail: `the object could not be read for now (${(err && err.code) || (err && err.name) || 'unknown error'})` };
  }
  try {
    return await judge({ file: staged.file, before: staged.sha256, hash: hashFileWith(fs), scanner });
  } finally {
    await releaseStaged(staged); // only its own private temporary copy
  }
}

async function storageHealthy(uploadDir, fsApi) {
  try {
    const entries = await fsApi.promises.readdir(uploadDir);
    return entries.some((name) => name !== 'quarantine');
  } catch {
    return false;
  }
}

// Moves an infected file into the quarantine folder (never deletes it). true when it is there (also when it already was).
async function quarantine(file, quarantineDir, fsApi) {
  const target = path.join(quarantineDir, path.basename(file));
  try {
    await fsApi.promises.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    await fsApi.promises.rename(file, target);
    // Restrictive permissions, like the storage service's own folders (0700) and files (0600): a quarantined file is for Operations only. Best effort: it never undoes the move.
    if (typeof fsApi.promises.chmod === 'function') {
      await fsApi.promises.chmod(quarantineDir, 0o700).catch(() => undefined);
      await fsApi.promises.chmod(target, 0o600).catch(() => undefined);
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') { try { await fsApi.promises.access(target); return true; } catch { return false; } }
    return false;
  }
}

module.exports = { backfillLegacyDocuments, selectionWhere, isStoredObject, objectStorageHealthy, MAX_ATTEMPTS, BACKOFF_MINUTES, LEASE_MINUTES, DEFAULT_LIMIT, MAX_OBJECT_BYTES };
