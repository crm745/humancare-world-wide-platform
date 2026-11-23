const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const {
  loginLimiter,
  otpRequestLimiter,
  otpSendIpLimiter,
  patientLoginLimiter,
  otpVerifyLimiter,
  logoutLimiter,
} = require('../../common/middleware/rate-limit.middleware');
const {
  register,
  registerVerifyOtp,
  login,
  loginVerifyOtp,
  forgotPassword,
  verifyPasswordResetOtp,
  setPassword,
  resendOtp,
  googleLogin,
  appleLogin,
  socialRegister,
  corporateLogin,
  corporateVerifyOtp,
  refreshAccessToken,
  getMe,
  updateMe,
  requestContactChange,
  verifyContactChange,
  savePushToken,
  requestPasswordReset,
  resetPassword,
  changePassword,
  corporateLogout,
  logout,
  listMySessions,
  revokeMySession,
  revokeOtherSessions,
  startAccountDeletion,
  confirmAccountDeletion,
} = require('./auth.controller');

const authRouter = Router();

// Patients: password first, then an OTP to their mobile (each step hands back a ticket
// the next step requires). Google/Apple skip both for an existing account, since the
// provider authenticated them.
authRouter.post('/register', otpSendIpLimiter, otpRequestLimiter, register);
authRouter.post('/register/verify-otp', otpVerifyLimiter, registerVerifyOtp);
authRouter.post('/login', patientLoginLimiter, login);
authRouter.post('/login/verify-otp', otpVerifyLimiter, loginVerifyOtp);
authRouter.post('/otp/resend', otpSendIpLimiter, resendOtp);
authRouter.post('/password/forgot', otpSendIpLimiter, otpRequestLimiter, forgotPassword);
authRouter.post('/password/forgot/verify-otp', otpVerifyLimiter, verifyPasswordResetOtp);
authRouter.post('/password/set', setPassword);
authRouter.post('/google', googleLogin);
authRouter.post('/apple', appleLogin);
// New Apple people (a new Google user is signed up directly by /google): mobile + consents, then the same OTP step as /register.
authRouter.post('/social/register', otpSendIpLimiter, otpRequestLimiter, socialRegister);

// Corporates authenticate with password + OTP (two factors, since these accounts
// can see patient case/medical data).
authRouter.post('/corporate/login', loginLimiter, corporateLogin);
authRouter.post('/corporate/otp/verify', corporateVerifyOtp);
authRouter.post('/forgot-password', otpRequestLimiter, requestPasswordReset);
authRouter.post('/reset-password', resetPassword);
// Same two handlers, reachable under /corporate/* too — the corporate-portal web app calls
// them by this name. Patients reset through /password/* above.
authRouter.post('/corporate/forgot-password', otpRequestLimiter, requestPasswordReset);
authRouter.post('/corporate/reset-password', resetPassword);
// The two routes a restricted (first-login) corporate token may still use.
authRouter.post('/corporate/change-password', requireAuth(['corporate'], { allowPasswordChangePending: true }), changePassword);
authRouter.post('/corporate/logout', corporateLogout);
// Patient sign-out: revokes the session on the server (see logout in auth.controller.js).
authRouter.post('/logout', logoutLimiter, logout);
// The signed-in devices: list them, sign one out, sign all the others out (patients and corporate users; a corporate user with a restricted first-login session cannot).
authRouter.get('/sessions', requireAuth(['patient', 'corporate']), listMySessions);
authRouter.post('/sessions/revoke-others', logoutLimiter, requireAuth(['patient', 'corporate']), revokeOtherSessions);
authRouter.delete('/sessions/:id', logoutLimiter, requireAuth(['patient', 'corporate']), revokeMySession);

authRouter.post('/refresh', refreshAccessToken);
authRouter.get('/me', requireAuth(undefined, { allowPasswordChangePending: true }), getMe);
authRouter.patch('/me', requireAuth(['patient']), updateMe);
// Mobile/email changes: the new value, then an OTP to that new value (no password, no code to the old contact).
authRouter.post('/me/contact', requireAuth(['patient']), patientLoginLimiter, otpSendIpLimiter, requestContactChange);
authRouter.post('/me/contact/verify-otp', requireAuth(['patient']), otpVerifyLimiter, verifyContactChange);
authRouter.post('/push-token', requireAuth(['patient']), savePushToken);
// Retire the signed-in PATIENT's own account (never a corporate or admin one: the role list refuses them). Step 1 sends a code to the account's own contact
// (no password is asked for); step 2 needs that code, the step-1 ticket and the explicit confirmation. The row is kept and anonymised, never deleted: see auth.controller.js.
authRouter.post('/me/delete/start', requireAuth(['patient']), patientLoginLimiter, otpSendIpLimiter, startAccountDeletion);
authRouter.post('/me/delete/confirm', requireAuth(['patient']), otpVerifyLimiter, confirmAccountDeletion);

module.exports = { authRouter };
