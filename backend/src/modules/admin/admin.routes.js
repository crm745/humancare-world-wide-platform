const { Router } = require('express');
const { requireAuth, requireSuperAdmin } = require('../../middleware/auth.middleware');
const { loginLimiter, otpSendIpLimiter } = require('../../middleware/rate-limit.middleware');
const { requireCorporateReviewer } = require('./corporate-reviewer');
const {
  login,
  me,
  logout,
  getAdmins,
  postAdmin,
  deleteAdminAccount,
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

const adminRouter = Router();

adminRouter.post('/login', loginLimiter, login);

adminRouter.use(requireAuth(['admin']));

adminRouter.get('/me', me);
adminRouter.post('/logout', logout);

// Admin-account management is superadmin-only.
adminRouter.get('/admins', requireSuperAdmin, getAdmins);
adminRouter.post('/admins', requireSuperAdmin, postAdmin);
adminRouter.delete('/admins/:id', requireSuperAdmin, deleteAdminAccount);

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

adminRouter.get('/cases', getCases);
adminRouter.get('/cases/:id', getCase);
adminRouter.patch('/cases/:id/assign', patchCaseAssign);
adminRouter.patch('/cases/:id/stage', patchCaseStage);

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

module.exports = { adminRouter };
