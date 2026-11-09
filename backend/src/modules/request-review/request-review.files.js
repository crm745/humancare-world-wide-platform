// Stored-file integrity for documents of the request-first review workflow.
//
// A document that came through the workflow was hashed when it was uploaded (request_documents.sha256),
// scanned by ClamAV, and approved by an Admin. Everything that hands such a file to a person goes
// through this file, so the same rules apply wherever it is opened:
//   - the file must exist and be exactly as large as when it was uploaded;
//   - its SHA-256 must equal the stored one (a document with no stored checksum is refused: fail closed);
//   - the file is read into memory ONCE, hashed, and that same buffer is what is sent, so it cannot be
//     swapped between the check and the download (uploads are capped at 10 MB).
//
// Documents that predate the workflow (the original `documents` rows, which have no scan metadata at all)
// are NOT handled here and are never refused for lacking it: see findWorkflowSource.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../../db/prisma');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');

function httpError(statusCode, message, publicCode, extra) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  if (extra) Object.assign(err, extra);
  return err;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

const storedPath = (storageKey) => path.join(UPLOAD_DIR, path.basename(storageKey));

// What is wrong with the stored file of a request document, or null when it is intact. Streams the file
// through the hash, so it is cheap on memory (the approval checks every document of a request).
async function fileProblem(requestDocument) {
  if (!requestDocument.sha256) return { code: 'checksum_missing', message: 'No checksum was recorded for this document, so it cannot be verified.' };
  const file = storedPath(requestDocument.storageKey);
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return { code: 'file_missing', message: 'The stored file is missing.' };
  }
  if (!stat.isFile() || stat.size !== requestDocument.sizeBytes) return { code: 'file_changed', message: 'The stored file no longer matches what was scanned.' };
  let actual;
  try {
    actual = await hashFile(file);
  } catch {
    return { code: 'file_missing', message: 'The stored file could not be read.' };
  }
  return actual === requestDocument.sha256 ? null : { code: 'file_changed', message: 'The stored file no longer matches what was scanned.' };
}

const STATUS_BY_PROBLEM = { file_missing: 404, file_changed: 409, checksum_missing: 409 };

// The verified bytes of the document, or an error (404 file_missing / 409 file_changed, checksum_missing).
async function readVerifiedFile(requestDocument) {
  if (!requestDocument.sha256) throw httpError(409, 'No checksum was recorded for this document, so it will not be opened.', 'checksum_missing');
  const file = storedPath(requestDocument.storageKey);
  let buffer;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size !== requestDocument.sizeBytes) throw httpError(409, 'The stored file no longer matches what was scanned, so it will not be opened.', 'file_changed');
    buffer = await fs.promises.readFile(file);
  } catch (err) {
    if (err.publicCode) throw err;
    throw httpError(404, 'The stored file is missing.', 'file_missing');
  }
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== requestDocument.sha256) {
    throw httpError(409, 'The stored file no longer matches what was scanned, so it will not be opened.', 'file_changed');
  }
  return buffer;
}

// A document the original (pre-workflow) code stored has no request_documents row; one that came through
// the workflow always has, and its storage key is unique. Looking the owner of the file up by that key means
// a `documents` row can never be used to reach a workflow file without the workflow's checks.
function findWorkflowSource(fileUrl) {
  return prisma.requestDocument.findUnique({ where: { storageKey: path.basename(String(fileUrl || '')) } });
}

// The `documents` row of a workflow document must be the one the approval created for it, and the file must
// have been clean and approved. Anything else is refused, never served.
function assertCaseDocumentServable(source, document) {
  if (source.caseDocumentId !== document.id) {
    throw httpError(409, 'This document is not linked to a verified upload, so it will not be opened.', 'not_verified');
  }
  if (source.scanStatus !== 'clean' || source.reviewStatus !== 'approved') {
    throw httpError(409, 'This document has not passed its virus scan and approval, so it will not be opened.', 'document_not_clean');
  }
}

// What a patient-chosen file name may look like once it is stored as text: no control characters or path
// separators, at most 191 characters. It is only ever displayed or used as a download name, never as a path.
function cleanOriginalName(name) {
  // eslint-disable-next-line no-control-regex
  const text = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f\\/]/g, '').trim();
  if (text.length <= 191) return text || 'document';
  // Too long: shorten the start of the name, keeping its extension.
  const extension = path.extname(text).slice(0, 10);
  return text.slice(0, 191 - extension.length) + extension;
}

module.exports = {
  httpError, hashFile, storedPath, fileProblem, readVerifiedFile, findWorkflowSource, assertCaseDocumentServable,
  cleanOriginalName, STATUS_BY_PROBLEM,
};
