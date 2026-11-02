const { Router } = require('express');
const { upload } = require('../../middleware/upload.middleware');
const { otpRequestLimiter, otpVerifyLimiter } = require('../../common/middleware/rate-limit.middleware');
const { requireRegistrationProof } = require('./registration-proof');
const { requirePhoneProof } = require('./phone-proof');
const {
  postRegister,
  getRegistration,
  postResendVerification,
  patchEmail,
  getVerifyEmail,
  postVerifyLegacyMobile,
  DOCUMENT_KEYS,
} = require('./corporate-registration.controller');

const corporateRegistrationRouter = Router();

// Public (no account exists yet) — the corporate-portal's /register wizard.
//
// Nothing here can create a login: accounts come only from an authorised Admin
// provisioning an approved registration (POST /admin/corporate-registrations/:id/provision).
//
// Submitting needs a verified Firebase phone proof. It is checked BEFORE the upload
// middleware so an unverified request never gets a file written to disk.
corporateRegistrationRouter.post(
  '/register',
  otpRequestLimiter,
  requirePhoneProof,
  upload.fields(DOCUMENT_KEYS.map((key) => ({ name: key, maxCount: 1 }))),
  postRegister,
);

// Everything about an existing application needs the registration proof issued to the
// applicant (X-Registration-Token), bound to this id and its current email. The failed-
// attempts limiter comes first so guessing is throttled.
corporateRegistrationRouter.get('/registrations/:id', otpVerifyLimiter, requireRegistrationProof, getRegistration);
corporateRegistrationRouter.post('/registrations/:id/resend-verification', otpVerifyLimiter, otpRequestLimiter, requireRegistrationProof, postResendVerification);
// Correcting the email also needs a fresh Firebase proof of the registered mobile.
corporateRegistrationRouter.patch('/registrations/:id/email', otpVerifyLimiter, otpRequestLimiter, requireRegistrationProof, requirePhoneProof, patchEmail);

// The emailed verification link carries its own single-use token.
corporateRegistrationRouter.get('/verify-email', getVerifyEmail);

// Older registrations: the Admin-emailed link (in the body) plus a Firebase proof.
corporateRegistrationRouter.post('/registrations/verify-mobile', otpVerifyLimiter, requirePhoneProof, postVerifyLegacyMobile);

module.exports = { corporateRegistrationRouter };
