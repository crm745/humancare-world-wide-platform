// One upload policy for a patient's document uploads (POST /requests/me/:id/documents), whichever service the request is for and whichever storage path it takes (the original `documents`
// table on a Case, or `request_documents` in the Private Charter review workflow). Before this, the limits were uneven: only Mortal Remains had a file-count cap and a content check on the
// original path, nothing stopped an upload to a cancelled or completed request, and an empty file was accepted.
//
//   per-request file count   30 for every service (the review workflow's cap and the app's MAX_DOCUMENTS_PER_REQUEST; every version counts, replaced ones included).
//                            Mortal Remains keeps its own, stricter, approved cap of 10.
//   file size                10 MB, enforced by multer (upload.middleware.js, shared and untouched); an empty (0 byte) file is refused here.
//   file content             the first bytes must be what the declared type AND the file name's extension say (PDF, JPEG, PNG, WEBP, DOC, DOCX): the client's MIME type is never trusted alone.
//   request status           no uploads to a cancelled or completed request.
//
// Pure helpers plus one small file read; no database, no network. ClamAV scanning, idempotent uploads (clientUploadId) and upload recovery are in the callers and are not touched here.
const fs = require('fs');
const { SIGNATURE_BYTES, contentMatchesDeclared } = require('../../common/utils/file-signature');
const { MAX_DOCUMENTS_PER_REQUEST } = require('../request-review/request-review.config');
const { isMortalRequestKey } = require('./mortal-remains.validation');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NAME_MAX = 191; // the documents.name column is VARCHAR(191): 191 characters
const MORTAL_MAX_FILES = 10;
const CLOSED_STATUSES = Object.freeze(['completed', 'cancelled']);

const maxFilesFor = (serviceKey) => (isMortalRequestKey(serviceKey) ? MORTAL_MAX_FILES : MAX_DOCUMENTS_PER_REQUEST);

// { status, body } when the request no longer takes documents, else null. `request.case.status` is the Case's own copy of the status.
function closedRequestProblem(request) {
  const status = request && (request.status || (request.case && request.case.status));
  if (!CLOSED_STATUSES.includes(status)) return null;
  return { status: 409, body: { error: `This request is ${status}, so documents can no longer be added to it. Please contact HumanCare if you need to share something.`, code: 'request_closed' } };
}

// { status, body } when `count` documents already fill the request, else null. (Mortal Remains keeps its original wording.)
function fileCountProblem(count, serviceKey) {
  const max = maxFilesFor(serviceKey);
  if (count < max) return null;
  const error = isMortalRequestKey(serviceKey) ? `A Mortal Remains request can have at most ${max} documents.` : `A request can hold at most ${max} documents.`;
  return { status: 400, body: { error, code: 'too_many_documents' } };
}

// { status, body } when the stored file is empty, too big, unreadable, or not what it claims to be; else null. `file` is multer's { path, size, mimetype, originalname }.
async function fileContentProblem(file) {
  if (!file || !(file.size > 0)) return { status: 400, body: { error: 'The uploaded file is empty.', code: 'file_empty' } };
  if (file.size > MAX_FILE_BYTES) return { status: 400, body: { error: 'The file is larger than 10 MB.', code: 'file_too_large' } };
  let head = Buffer.alloc(0);
  try {
    const handle = await fs.promises.open(file.path, 'r');
    try {
      const buffer = Buffer.alloc(SIGNATURE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return { status: 400, body: { error: 'The uploaded file could not be read.', code: 'file_unreadable' } };
  }
  if (!contentMatchesDeclared(head, file.mimetype, file.originalname)) {
    return { status: 400, body: { error: 'The file content does not match its type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', code: 'file_type_mismatch' } };
  }
  return null;
}

// The name a patient's file is stored under (documents.name): only ever displayed or used as a download name, never as a path (the file itself is stored under a name multer made).
//   - control characters, path separators, line and paragraph separators, zero-width and bidirectional-override characters (the "evil.exe" shown as "evilfdp.exe" trick) and unpaired
//     surrogates are removed; the text is normalised (NFC), runs of white space become one space, and leading or trailing dots and spaces are dropped (no hidden or Windows-odd names)
//   - at most 191 characters, counted as the database counts them (code points, never half of an emoji), cutting the START of a long name and keeping a short extension
//   - nothing left means "document"
// Pure. The file's CONTENT and the extension check in fileContentProblem use the original name and are not affected.
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\\/\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;
function safeDocumentName(name) {
  let text = String(name === null || name === undefined ? '' : name);
  try { text = text.normalize('NFC'); } catch { /* keep as is */ }
  const kept = Array.from(text).filter((ch) => { const c = ch.codePointAt(0); return !(c >= 0xd800 && c <= 0xdfff); }).join('');
  // White space of every kind (tabs, line breaks, the Unicode separators) becomes one space FIRST, so "line1\nline2" does not run together; then the rest is removed.
  text = kept.replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(UNWANTED, '').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (text === '') return 'document';
  const chars = Array.from(text);
  if (chars.length <= NAME_MAX) return text;
  const extension = (/\.[\p{L}\p{N}]{1,9}$/u.exec(text) || [''])[0];
  const base = Array.from(extension ? text.slice(0, text.length - extension.length) : text);
  const cut = base.slice(0, NAME_MAX - Array.from(extension).length).join('').replace(/[.\s]+$/, '');
  return (cut + extension) || 'document';
}

module.exports = { NAME_MAX, safeDocumentName, MAX_FILE_BYTES, MORTAL_MAX_FILES, MAX_DOCUMENTS_PER_REQUEST, CLOSED_STATUSES, maxFilesFor, closedRequestProblem, fileCountProblem, fileContentProblem };
