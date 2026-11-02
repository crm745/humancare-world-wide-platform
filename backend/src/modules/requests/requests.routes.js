const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { upload } = require('../../middleware/upload.middleware');
const {
  submitRequest,
  listMyRequests,
  getMyRequestById,
  listMyDocuments,
  uploadRequestDocument,
  downloadRequestSummary,
} = require('./requests.controller');

const requestsRouter = Router();

requestsRouter.post('/', requireAuth(['patient']), submitRequest);
requestsRouter.get('/me', requireAuth(['patient']), listMyRequests);
// Must come before /me/:id, or Express would try to parse "documents" as an id.
requestsRouter.get('/me/documents', requireAuth(['patient']), listMyDocuments);
requestsRouter.get('/me/:id', requireAuth(['patient']), getMyRequestById);
requestsRouter.get('/me/:id/summary', requireAuth(['patient']), downloadRequestSummary);
requestsRouter.post('/me/:id/documents', requireAuth(['patient']), upload.single('file'), uploadRequestDocument);
// No unauthenticated "guest" lookup by reference + mobile — every case view requires
// a logged-in session now, removed per product decision (no access without login).

module.exports = { requestsRouter };
