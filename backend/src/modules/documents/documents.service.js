const { prisma } = require('../../db/prisma');
const { cleanScanRecord } = require('./document-scan');

// `scan` (what scanBeforeStore established: { sha256, engine, scannedAt }) is stored with the row as a CLEAN scan record. A row is created only after a confirmed clean verdict, so every new
// upload passes it; a caller with nothing to pass creates a row with no scan record (NULL = not scanned = not clean).
async function addDocumentToCase(caseId, { type, name, fileUrl, fileSizeBytes, clientUploadId, scan }) {
  return prisma.document.create({
    data: {
      caseId: Number(caseId), type: type || null, name, fileUrl, fileSizeBytes: fileSizeBytes || null, ...(clientUploadId && { clientUploadId }), ...(scan ? cleanScanRecord(scan) : {}),
    },
  });
}

// The document already saved on this case for the app's upload id, or null. Only ever called for a case that belongs to the signed-in patient (the controller loads the request
// for its owner first), and scoped to that case.
async function findCaseDocumentByClientUploadId(caseId, clientUploadId) {
  return prisma.document.findFirst({ where: { caseId: Number(caseId), clientUploadId } });
}

async function listDocumentsForCase(caseId) {
  return prisma.document.findMany({ where: { caseId: Number(caseId) }, orderBy: { uploadedAt: 'desc' } });
}

// A patient may only read their own documents; a corporate only the ones on cases they
// submitted. Throws (rather than returning null) so the controller can 404 either way
// without leaking whether the document exists to someone who shouldn't see it.
async function getDocumentForUser(documentId, user) {
  const document = await prisma.document.findUnique({
    where: { id: Number(documentId) },
    include: { case: { select: { corporateId: true, serviceRequest: { select: { userId: true } } } } },
  });

  const owned = document && (
    (user.role === 'patient' && document.case.serviceRequest?.userId === user.id) ||
    (user.role === 'corporate' && document.case.corporateId === user.corporateId)
  );
  if (!owned) {
    const err = new Error('Document not found');
    err.statusCode = 404;
    throw err;
  }
  return document;
}

module.exports = { addDocumentToCase, findCaseDocumentByClientUploadId, listDocumentsForCase, getDocumentForUser };
