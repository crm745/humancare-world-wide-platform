// Moves a freshly uploaded file from multer's temporary file into the storage service, after checking it.
//
//   1. the file must be non-empty and within MAX_UPLOAD_BYTES;
//   2. its type is read from its OWN first bytes, must be allowed by the upload POLICY and agree with the declared MIME type and
//      the extension of its name. Policies: 'patient' = PDF, JPEG, PNG, WEBP; 'organization' (corporate and registration uploads)
//      = the same plus DOCX. DOC (legacy OLE) is accepted nowhere: it cannot be validated;
//   2b. the file's STRUCTURE is validated (src/storage/structure): complete image structure with nothing appended, PDFs parsed with
//      no encryption / JavaScript / launch / embedded-file features, DOCX packages without macros, ActiveX, embedded objects or
//      encrypted / oversize entries. Anything that cannot be validated is refused;
//   3. SHA-256 of the temporary file;
//   4. `scan: 'inline'` (every upload path that has no scan column of its own): ClamAV must be READY (answering, and its signatures
//      no older than CLAMAV_MAX_SIGNATURE_AGE_DAYS, default 7) and must answer "clean" BEFORE the file is stored. Not ready,
//      infected, unavailable, timed out or any other answer refuses the upload and nothing is stored (fail closed).
//      `scan: 'deferred'` (the request-review workflow): the file is stored as "pending" and its worker scans it from storage
//      before anyone can open it;
//   5. the file is streamed to storage under a generated, unpredictable key; the hash computed while streaming must equal the
//      hash that was scanned, so a "clean" verdict is bound to exactly the bytes that were stored.
// The temporary file is always removed, success or failure.
const fs = require('fs');
const path = require('path');
const { StorageError } = require('./errors');
const { validateStructure } = require('./structure');
const { generateKey } = require('./keys');
const { storageFor, getStorage } = require('./index');
const { hashStream } = require('./meter');
const clamav = require('../integrations/clamav/clamav');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Which detected types each upload policy accepts. Unknown policy names accept nothing.
const POLICIES = Object.freeze({
  patient: ['pdf', 'jpeg', 'png', 'webp'],
  organization: ['pdf', 'jpeg', 'png', 'webp', 'docx'],
});

const TYPES = {
  pdf: { ext: '.pdf', mime: 'application/pdf', names: ['.pdf'] },
  jpeg: { ext: '.jpg', mime: 'image/jpeg', names: ['.jpg', '.jpeg'] },
  png: { ext: '.png', mime: 'image/png', names: ['.png'] },
  webp: { ext: '.webp', mime: 'image/webp', names: ['.webp'] },
  doc: { ext: '.doc', mime: 'application/msword', names: ['.doc'] },
  docx: { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', names: ['.docx'] },
};

function refuse(statusCode, publicCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.publicCode = publicCode;
  return err;
}

// What the bytes say the file is: 'pdf' | 'jpeg' | 'png' | 'webp' | 'doc' | 'docx' | null.
function detectType(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'doc';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'docx'; // a zip: ClamAV covers what is inside
  return null;
}

async function readHead(file, bytes = 16) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Checks size, type, MIME and extension. Returns the detected type's description or throws a 400 / 413.
async function validateUpload(file, { policy = 'patient' } = {}) {
  if (!file || !file.path) throw refuse(400, 'file_required', 'file is required');
  const allowed = POLICIES[policy];
  if (!allowed) throw refuse(500, 'upload_policy_invalid', 'Unknown upload policy.');
  const stat = await fs.promises.stat(file.path);
  if (!stat.size) throw refuse(400, 'file_empty', 'The file is empty.');
  if (stat.size > MAX_UPLOAD_BYTES) throw refuse(413, 'file_too_large', 'The file is larger than 10 MB.');
  const key = detectType(await readHead(file.path));
  if (!key) throw refuse(400, 'file_type_invalid', 'The file content is not a supported document type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.');
  if (!allowed.includes(key)) throw refuse(400, 'file_type_not_allowed', 'This file type is not accepted here. Allowed: ' + allowed.map((k) => TYPES[k].ext.slice(1).toUpperCase()).join(', ') + '.');
  const type = TYPES[key];
  const declared = String(file.mimetype || '').toLowerCase();
  if (declared !== type.mime) throw refuse(400, 'file_type_mismatch', 'The file content does not match its declared type.');
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  if (!type.names.includes(extension)) throw refuse(400, 'file_extension_invalid', 'The file extension does not match its content.');
  const problem = await validateStructure(key, await fs.promises.readFile(file.path));
  if (problem) {
    const err = refuse(400, problem.code === 'trailing_data' ? 'file_trailing_data' : problem.code.endsWith('_encrypted') ? 'file_encrypted' : 'file_structure_invalid', 'The file was rejected by the document safety checks.');
    err.structureCode = problem.code; // for logs and tests only; never sent to the client
    throw err;
  }
  return { type: key, extension: type.ext, contentType: type.mime, size: stat.size };
}

function scanFailure(verdict) {
  if (verdict && verdict.status === 'infected') return refuse(422, 'file_infected', 'The file was rejected by the virus scan.');
  return refuse(503, 'scan_unavailable', 'The file could not be virus-scanned right now, so it was not accepted. Please try again later.');
}

// `policy`: 'patient' (default, the strict one) or 'organization'. `health`: the scanner readiness check; by default ClamAV's own
// (daemon answering + signatures fresh) whenever the real scanner is used. An injected `scanner` skips it unless `health` is given too.
async function ingestUpload({ file, area, scan = 'inline', scanner, health, storage, policy = 'patient' }) {
  try {
    const checked = await validateUpload(file, { policy });
    const before = (await hashStream(fs.createReadStream(file.path))).sha256;

    let scanVerdict = null;
    if (scan === 'inline') {
      const check = health || (scanner ? null : clamav.ready);
      if (check) {
        const state = await check();
        if (!(state === true || (state && state.ok === true))) throw scanFailure(null);
      }
      scanVerdict = await (scanner || clamav.scanFile)(file.path);
      if (!scanVerdict || scanVerdict.status !== 'clean') throw scanFailure(scanVerdict);
    }

    const target = storage || getStorage();
    const key = generateKey(area, checked.extension);
    let stored;
    try {
      stored = await target.upload(key, fs.createReadStream(file.path), { contentType: checked.contentType, maxBytes: MAX_UPLOAD_BYTES });
    } catch (err) {
      if (err instanceof StorageError && err.code === 'too_large') throw refuse(413, 'file_too_large', 'The file is larger than 10 MB.');
      throw err;
    }
    if (stored.sha256 !== before) {
      await target.delete(key).catch(() => undefined);
      throw new StorageError('file_changed', 'The file changed while it was being stored.');
    }
    return {
      key, sha256: before, size: stored.size, contentType: checked.contentType, type: checked.type, provider: target.provider,
      versionId: stored.versionId || null, etag: stored.etag || null, scanned: Boolean(scanVerdict),
    };
  } finally {
    await fs.promises.rm(file.path, { force: true }).catch(() => undefined);
  }
}

// Removes an object, never throwing (used to clean up after a refused database write).
const discardStored = (key) => storageFor(key).delete(key).catch(() => undefined);

// Removes temporary files multer wrote for a refused request.
const discardTemp = (files) => Promise.all((Array.isArray(files) ? files : [files]).filter(Boolean).map((f) => fs.promises.rm(f.path, { force: true }).catch(() => undefined)));

module.exports = { ingestUpload, validateUpload, detectType, discardStored, discardTemp, MAX_UPLOAD_BYTES };
