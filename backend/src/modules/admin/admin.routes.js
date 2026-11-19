const { Router } = require('express');
const { requireSuperAdmin } = require('../../common/middleware/auth.middleware');
const { loginLimiter, otpSendIpLimiter } = require('../../common/middleware/rate-limit.middleware');
const { requireCorporateReviewer } = require('./corporate-reviewer');
const { requireAdminAuth } = require('./auth/admin-session.middleware');
const { adminNoStore, adminAuthErrorHandler } = require('./auth/admin-auth.errors');
const { adminAuthRouter } = require('./auth/admin-auth.routes');
const { adminRecoveryRouter } = require('./auth/admin-recovery.routes');
const { adminOriginGuard } = require('./auth/admin-origin.middleware');
const {
  login,
  me,
  getAdmins,
  getPendingRegistrations,
  getRegistration,
  postApproveRegistration,
  postRejectRegistration,
  postProvisionRegistration,
  postSendMobileLink,
  postReviewContactEmail,
  downloadRegistrationDocument,
  getCorporates,
  postCorporate,
  postCorporateUser,
  getCases,
  getCase,
  patchCaseAssign,
  getBilling,
  patchCaseBilling,
  getPatients,
  patchCaseStage,
  getTickets,
  getTicket,
  postTicketReply,
  patchTicketStatus,
} = require('./admin.controller');
const {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
} = require('../services/services.controller');

const {
  getRequests, getRequest, downloadDocument, postDocumentReview, postRequestDocuments, postApproval,
} = require('../request-review/request-review.controller');

const { postDealRecovery } = require('../bitrix/deal-recovery.controller');
const quotations = require('../quotations/quotations.controller');
const { getShares, postShare, postRevokeShare, postRetryShare, postDocumentRequest } = require('../bitrix/deal-document.controller');

const adminRouter = Router();

// Middleware order:
//   1. no-store on every Admin response;
//   2. the new authentication routes (public invitation / registration / login steps, refresh and
//      logout), each with its own strict origin guard, rate limit and validation - mounted before
//      any authentication middleware, so credentials sent to the public ones are never consulted;
//      The recovery routes (approval / rejection step-ups and decisions behind a superadmin
//      session, link redemption and the replacement-passkey steps) are mounted the same way.
//   3. the legacy password-only login, unchanged;
//   4. everything else: the (lenient) origin guard, then the database-backed Admin auth, which
//      accepts new session tokens and - only while enforcement is off and the Admin has no
//      passkey - legacy tokens;
//   5. the Admin error mapper (last), which leaves unknown errors to the app's generic 500.
adminRouter.use(adminNoStore);
adminRouter.use(adminAuthRouter);
adminRouter.use(adminRecoveryRouter);

adminRouter.post('/login', loginLimiter, login);

adminRouter.use(adminOriginGuard({ strict: false }));
adminRouter.use(requireAdminAuth(['admin']));

adminRouter.get('/me', me);

// Listing Admin accounts is superadmin-only. Accounts are created and disabled only by the
// operator scripts (scripts/admin-create.js, admin-invitation.js, admin-account.js); there is
// deliberately no HTTP route that creates or deletes an Admin.
adminRouter.get('/admins', requireSuperAdmin, getAdmins);

// Corporate-registration review — creating a real Corporate/CorporateUser account is a
// sensitive action, so it is not open to every admin: only a superadmin or an admin who was
// explicitly granted `corporate_review` (checked against the database on each call).
// Bank details and the bank-proof document stay superadmin-only inside the handlers.
adminRouter.get('/corporate-registrations', requireCorporateReviewer, getPendingRegistrations);
adminRouter.get('/corporate-registrations/:id', requireCorporateReviewer, getRegistration);
adminRouter.post('/corporate-registrations/:id/approve', requireCorporateReviewer, postApproveRegistration);
adminRouter.post('/corporate-registrations/:id/reject', requireCorporateReviewer, postRejectRegistration);
// Creates the company and its initial Owner. Separate from adding employees below.
adminRouter.post('/corporate-registrations/:id/provision', requireCorporateReviewer, postProvisionRegistration);
// Older registrations (no verified mobile yet) and contact emails that changed after submission.
adminRouter.post('/corporate-registrations/:id/send-mobile-verification', requireCorporateReviewer, otpSendIpLimiter, postSendMobileLink);
adminRouter.post('/corporate-registrations/:id/review-contact-email', requireCorporateReviewer, postReviewContactEmail);
adminRouter.get('/corporate-registrations/:id/documents/:key', requireCorporateReviewer, downloadRegistrationDocument);

adminRouter.get('/corporates', getCorporates);
adminRouter.post('/corporates', postCorporate);
// Adds a subsequent employee login to a company that already has an Owner; it can never
// create a company's first login (see createCorporateUser).
adminRouter.post('/corporates/:id/users', postCorporateUser);

// Request-first review workflow (Private Charter): any Admin can review documents and approve.
adminRouter.get('/requests', getRequests);
adminRouter.get('/requests/:id', getRequest);
adminRouter.get('/requests/:id/documents/:docId/file', downloadDocument);
adminRouter.post('/requests/:id/documents/:docId/review', postDocumentReview);
adminRouter.post('/requests/:id/request-documents', postRequestDocuments);
adminRouter.post('/requests/:id/approve', postApproval);
// Sharing documents with the Bitrix24 Deal. Reviewing a document never shares it: an Admin authorizes each document explicitly.
// Any Admin may authorize, revoke or retry (there is no separate permission, as for document review).
adminRouter.get('/requests/:id/shares', getShares);
adminRouter.post('/requests/:id/documents/:docId/share', postShare);
adminRouter.post('/requests/:id/shares/:shareId/revoke', postRevokeShare);
adminRouter.post('/requests/:id/shares/:shareId/retry', postRetryShare);
// Ask the patient for more documents after the approval (a document request on the Case).
adminRouter.post('/requests/:id/document-requests', postDocumentRequest);

adminRouter.get('/cases', getCases);
adminRouter.get('/cases/:id', getCase);
// Operations quotation management (Private Charter): any Admin or Superadmin session may view, confirm, publish and withdraw a quotation version.
// Confirm and publish are separate actions; every state change is audited, runs under the Case row lock and names the revision the Admin looked at.
// See modules/quotations/quotations.service.js.
adminRouter.get('/cases/:id/quotations', quotations.getCaseQuotations);
adminRouter.get('/quotations/:id', quotations.getQuotation);
adminRouter.get('/quotations/:id/file', quotations.downloadQuotationFile);
adminRouter.post('/quotations/:id/confirm', quotations.postConfirm);
adminRouter.post('/quotations/:id/publish', quotations.postPublish);
adminRouter.post('/quotations/:id/withdraw', quotations.postWithdraw);
adminRouter.post('/quotations/:id/new-version', quotations.postNewVersion);
// Invoice of an accepted quotation (Phase 4): accepted quotations still without an invoice, a manual retry, and the partial-payment authorization.
// See modules/quotations/quotation-invoice.service.js.
adminRouter.get('/invoices/awaiting', quotations.getAwaitingInvoice);
adminRouter.post('/quotations/:id/invoice', quotations.postEnsureInvoice);
adminRouter.post('/invoices/:id/partial-payment', quotations.postPartialPayment);
adminRouter.patch('/cases/:id/assign', patchCaseAssign);
adminRouter.patch('/cases/:id/stage', patchCaseStage);
// Safe manual recovery of a Private Charter Bitrix Deal event that failed or needs manual review. Superadmin only:
// it can authorise a new Deal-creation event. See modules/bitrix/deal-recovery.service.js.
adminRouter.post('/cases/:id/deal-recovery', requireSuperAdmin, postDealRecovery);

// Billing — step 1, a manual Ops/Finance tracker, same access level as the rest of
// case data (not a sensitive-settings action like admin accounts or the catalog).
adminRouter.get('/billing', getBilling);
adminRouter.patch('/cases/:id/billing', patchCaseBilling);

adminRouter.get('/patients', getPatients);

adminRouter.get('/tickets', getTickets);
adminRouter.get('/tickets/:id', getTicket);
adminRouter.post('/tickets/:id/messages', postTicketReply);
adminRouter.patch('/tickets/:id/status', patchTicketStatus);

// Viewing the catalog is fine for any admin; changing what patients see is a
// sensitive-settings action, so it's superadmin-only.
adminRouter.get('/services', listServices);
adminRouter.post('/services', requireSuperAdmin, createService);
adminRouter.patch('/services/:slug', requireSuperAdmin, updateService);
adminRouter.delete('/services/:slug', requireSuperAdmin, deleteService);

adminRouter.use(adminAuthErrorHandler);

module.exports = { adminRouter };
