const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { uploadPatient } = require('../../middleware/upload.middleware');
const { attachErrorCodes } = require('../../common/errors/error-codes');
const { requestSubmitLimiters, requestUploadLimiters } = require('../../common/middleware/rate-limit.middleware');
const {
  submitRequest,
  listMyRequests,
  getMyRequestById,
  getMyRequestByClientRequestId,
  listMyDocuments,
  uploadRequestDocument,
  downloadRequestSummary,
} = require('./requests.controller');
const { getMyRequestQuotation } = require('../quotations/patient-quotations.controller');

const requestsRouter = Router();
// Every 4xx answer of this router also carries a stable error code (and field / params / fieldCodes where they apply) so the app can show it in the person's language; the English text and the status are unchanged (common/errors/error-codes.js).
requestsRouter.use(attachErrorCodes);

// Per-patient limits (rate-limit.middleware.js), after requireAuth so an unauthenticated call is a 401 first and the counter is the patient's own.
requestsRouter.post('/', requireAuth(['patient']), requestSubmitLimiters, submitRequest);
requestsRouter.get('/me', requireAuth(['patient']), listMyRequests);
// Must come before /me/:id, or Express would try to parse "documents" as an id.
requestsRouter.get('/me/documents', requireAuth(['patient']), listMyDocuments);
// "Check status" by the idempotency key (before /me/:id, which would read "by-client-request" as an id).
requestsRouter.get('/me/by-client-request/:clientRequestId', requireAuth(['patient']), getMyRequestByClientRequestId);
requestsRouter.get('/me/:id', requireAuth(['patient']), getMyRequestById);
requestsRouter.get('/me/:id/summary', requireAuth(['patient']), downloadRequestSummary);
// The ONE active published quotation of the patient's own request (null when there is none).
requestsRouter.get('/me/:id/quotation', requireAuth(['patient']), getMyRequestQuotation);
requestsRouter.post('/me/:id/documents', requireAuth(['patient']), requestUploadLimiters, uploadPatient.single('file'), uploadRequestDocument);
// No unauthenticated "guest" lookup by reference + mobile — every case view requires
// a logged-in session now, removed per product decision (no access without login).

module.exports = { requestsRouter };
