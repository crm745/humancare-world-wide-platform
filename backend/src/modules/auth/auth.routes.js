const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const {
  loginLimiter,
  otpRequestLimiter,
  otpSendIpLimiter,
  patientLoginLimiter,
  otpVerifyLimiter,
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
// New Google/Apple people: mobile + consents, then the same OTP step as /register.
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

authRouter.post('/refresh', refreshAccessToken);
authRouter.get('/me', requireAuth(undefined, { allowPasswordChangePending: true }), getMe);
authRouter.patch('/me', requireAuth(['patient']), updateMe);
// Mobile/email changes: the new value, then an OTP to that new value (no password, no code to the old contact).
authRouter.post('/me/contact', requireAuth(['patient']), patientLoginLimiter, otpSendIpLimiter, requestContactChange);
authRouter.post('/me/contact/verify-otp', requireAuth(['patient']), otpVerifyLimiter, verifyContactChange);
authRouter.post('/push-token', requireAuth(['patient']), savePushToken);

module.exports = { authRouter };
