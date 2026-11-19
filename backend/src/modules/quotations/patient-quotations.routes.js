const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { downloadQuotationFile, postAccept, postReject, postEnsureInvoice } = require('./patient-quotations.controller');

// Keyed by the signed-in patient, not the IP (`trust proxy` is not configured). Runs after requireAuth. Skipped in tests, like the other limiters.
const decisionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req) => `patient:${req.user && req.user.id}`,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many requests. Please wait a minute.', code: 'rate_limited' },
});

const patientQuotationsRouter = Router();

// Patient only. The quotation must belong to a Case the patient owns and be a version published to them (404 otherwise, the same answer as for a missing one).
patientQuotationsRouter.get('/:id/file', requireAuth(['patient']), downloadQuotationFile);
patientQuotationsRouter.post('/:id/accept', requireAuth(['patient']), decisionLimiter, postAccept);
patientQuotationsRouter.post('/:id/reject', requireAuth(['patient']), decisionLimiter, postReject);
// Retry / refresh of the invoice of an accepted quotation (idempotent; never changes the decision).
patientQuotationsRouter.post('/:id/invoice', requireAuth(['patient']), decisionLimiter, postEnsureInvoice);

module.exports = { patientQuotationsRouter };
