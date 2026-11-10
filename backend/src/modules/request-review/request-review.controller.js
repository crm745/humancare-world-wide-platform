// Admin endpoints of the request-first review workflow. Mounted under /admin, so every route is
// already behind requireAuth(['admin']): every Admin (admin or superadmin) can review documents,
// there is no separate permission for it.
const {
  listReviewRequests, countReviewRequests, getReviewRequest, resolveAdminDownload, reviewDocument, requestAdditionalDocuments, approveRequest,
} = require('./request-review.service');

async function getRequests(req, res, next) {
  try {
    const { status, search, limit, offset } = req.query;
    const [requests, total] = await Promise.all([
      listReviewRequests({ status, search, limit, offset }),
      countReviewRequests({ status, search }),
    ]);
    res.json({ requests, total });
  } catch (err) {
    next(err);
  }
}

async function getRequest(req, res, next) {
  try {
    res.json({ request: await getReviewRequest(req.params.id) });
  } catch (err) {
    next(err);
  }
}

// Sends the stored file as a download. Refused unless its virus scan is clean and the file still matches
// its checksum (see the service); what is sent is the very buffer that was verified.
async function downloadDocument(req, res, next) {
  try {
    const { buffer, name } = await resolveAdminDownload({ requestId: req.params.id, documentId: req.params.docId, adminId: req.user.id });
    res.set('X-Content-Type-Options', 'nosniff');
    res.attachment(name);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

async function postDocumentReview(req, res, next) {
  try {
    const body = req.body || {};
    const document = await reviewDocument({
      requestId: req.params.id, documentId: req.params.docId, adminId: req.user.id, decision: body.decision, reason: body.reason,
    });
    res.json({ document });
  } catch (err) {
    next(err);
  }
}

async function postRequestDocuments(req, res, next) {
  try {
    const request = await requestAdditionalDocuments({ requestId: req.params.id, adminId: req.user.id, reason: (req.body || {}).reason });
    res.json({ request });
  } catch (err) {
    next(err);
  }
}

// 409 with `blockers` (what is still missing) when the request cannot be approved yet.
async function postApproval(req, res, next) {
  try {
    const result = await approveRequest({ requestId: req.params.id, adminId: req.user.id });
    res.status(result.alreadyApproved ? 200 : 201).json(result);
  } catch (err) {
    if (err.publicCode === 'approval_blocked') {
      return res.status(409).json({ error: err.message, code: err.publicCode, blockers: err.blockers });
    }
    return next(err);
  }
}

module.exports = { getRequests, getRequest, downloadDocument, postDocumentReview, postRequestDocuments, postApproval };
