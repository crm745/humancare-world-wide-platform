// Admin endpoints for sharing a request's documents with the Bitrix24 Deal (all behind the Admin login; see admin.routes.js).
//   GET  /admin/requests/:id/shares                        the shares with their status, attempts and last error code
//   POST /admin/requests/:id/documents/:docId/share        authorize ONE document to be attached to the Deal
//   POST /admin/requests/:id/shares/:shareId/revoke        { reason } remove the Bitrix attachment (the original stays)
//   POST /admin/requests/:id/shares/:shareId/retry         retry a share that failed for good
//   POST /admin/requests/:id/document-requests             { description, reason? } ask the patient for more documents after approval
const { authorizeShare, revokeShare, retryShare, listShares } = require('./deal-document.service');
const { openDocumentRequest } = require('../request-review/request-review.service');

async function getShares(req, res, next) {
  try {
    res.json({ shares: await listShares(req.params.id) });
  } catch (err) {
    next(err);
  }
}

async function postShare(req, res, next) {
  try {
    const result = await authorizeShare({ requestId: req.params.id, documentId: req.params.docId, adminId: req.user.id });
    res.status(result.alreadyAuthorized ? 200 : 201).json(result);
  } catch (err) {
    next(err);
  }
}

async function postRevokeShare(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const result = await revokeShare({ requestId: req.params.id, shareId: req.params.shareId, adminId: req.user.id, reason: body.reason });
    res.status(result.alreadyRevoked ? 200 : 202).json(result);
  } catch (err) {
    next(err);
  }
}

async function postRetryShare(req, res, next) {
  try {
    res.status(202).json(await retryShare({ requestId: req.params.id, shareId: req.params.shareId, adminId: req.user.id }));
  } catch (err) {
    next(err);
  }
}

async function postDocumentRequest(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    res.status(201).json(await openDocumentRequest({ requestId: req.params.id, adminId: req.user.id, description: body.description, reason: body.reason }));
  } catch (err) {
    next(err);
  }
}

module.exports = { getShares, postShare, postRevokeShare, postRetryShare, postDocumentRequest };
