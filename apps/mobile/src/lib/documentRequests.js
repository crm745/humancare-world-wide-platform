// Pure rules for the documents an Admin asks a patient for AFTER the request was approved and its Case opened (no React, no native
// modules), so they can be unit-tested.
//
// GET /requests/me/:id lists the open ones as `case.documentRequests` ({ id, description, reason, createdAt }, safe fields only).
// A patient answers one by sending files to the usual upload endpoint with the extra field `documentRequestId`; the server
// accepts a document on an approved request ONLY with the id of an open request, and closes the request when every document
// sent for it has been approved by the Admin.

const isId = (value) => Number.isInteger(value) && value > 0;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// The open document requests of a request, oldest first, each with only what a screen shows. Anything else in the response is ignored.
export function openDocumentRequests(request) {
  const list = Array.isArray(request?.case?.documentRequests) ? request.case.documentRequests : [];
  return list
    .filter((item) => item && isId(item.id) && text(item.description))
    .map((item) => ({ id: item.id, description: text(item.description), reason: text(item.reason) || null, createdAt: item.createdAt || null }))
    .sort((a, b) => a.id - b.id);
}

// The extra multipart field that ties an upload to the document request it answers.
export const documentRequestFields = (documentRequest) => (documentRequest && isId(documentRequest.id) ? { documentRequestId: documentRequest.id } : undefined);
