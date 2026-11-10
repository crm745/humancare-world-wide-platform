// Pure rules for sending more documents to a request that already exists (no React, no native
// modules), so they can be unit-tested. Two kinds of upload, both to the same endpoint the request
// form uses, POST /requests/me/:id/documents:
//   additional   a new document; it replaces nothing
//   replacement  one file that replaces one earlier (rejected, current) document, by sending its id as
//                `replacesDocumentId`; the server keeps the old version in the history
// Neither creates a request or a Case: the request id is the one the screen is already showing.
import { MAX_DOCUMENTS_PER_REQUEST } from './requestDocuments';
import { runSubmission } from './requestUploads';

export const uploadPath = (requestId) => `/requests/me/${requestId}/documents`;

// How many more versions the request can take (every version counts, replaced ones included).
export const remainingSlots = (documents) => Math.max(0, MAX_DOCUMENTS_PER_REQUEST - (Array.isArray(documents) ? documents.length : 0));

// The files to send for one upload panel. `target` is the document being replaced ({ id }), or null for
// additional documents.
//   additional   every file, with any replacesDocumentId removed: it can never replace by accident
//   replacement  only the first file (one replacement per document), carrying the target's id
export function filesToSend(target, files) {
  const list = Array.isArray(files) ? files : [];
  if (target) return list.length ? [{ ...list[0], replacesDocumentId: target.id }] : [];
  return list.map((file) => {
    const copy = { ...file };
    delete copy.replacesDocumentId;
    return copy;
  });
}

// The extra multipart fields for one file: only a replacement has any.
export const fieldsFor = (file) => (file && file.replacesDocumentId != null && file.replacesDocumentId !== '' ? { replacesDocumentId: file.replacesDocumentId } : undefined);

// Uploads the files not yet accepted, one at a time, to the existing request. A failed file never stops
// the others, a file already accepted is never sent again, and the request is never created or changed.
// Resolves { sentRequest, uploaded, uploadErrors }, the same shape as runSubmission, so a retry is
// another call with those values.
//   send(path, file, onProgress, fields) -> resolves when the server has the file, throws when it has not
//   onProgress({ index, total, progress })
export function sendAdditionalDocuments({ requestId, target, files, uploaded, uploadErrors, send, onProgress }) {
  if (requestId === undefined || requestId === null || requestId === '') throw new Error('No request to add documents to.');
  return runSubmission({
    sentRequest: { id: requestId },
    uploaded,
    uploadErrors,
    files: filesToSend(target, files),
    upload: (file, report, sent) => send(uploadPath(sent.id), file, report, fieldsFor(file)),
    onProgress,
  });
}
