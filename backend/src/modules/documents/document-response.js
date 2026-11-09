// What a Case document looks like in an API response. The stored row also holds `fileUrl` ("/uploads/<storage key>"),
// which only the backend may read (the download endpoints use it to find the file); it must never be sent to a client.
// Both pieces below allow-list the safe fields, so a column added to `documents` later is private until it is added here.

// For Prisma `select` / nested `include`: the database never even returns the stored path.
const SAFE_DOCUMENT_SELECT = { id: true, caseId: true, type: true, name: true, fileSizeBytes: true, uploadedAt: true };

// For a row that was read in full because the backend itself needs `fileUrl` (e.g. to send the file to Bitrix24).
function toSafeDocument(document) {
  if (!document) return document;
  const { id, caseId, type, name, fileSizeBytes, uploadedAt } = document;
  return { id, caseId, type, name, fileSizeBytes, uploadedAt };
}

module.exports = { SAFE_DOCUMENT_SELECT, toSafeDocument };
