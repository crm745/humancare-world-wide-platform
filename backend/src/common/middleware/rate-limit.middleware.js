const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// The test suite logs in dozens of times per file from the same supertest "IP" —
// real throttling there would fail unrelated tests, not catch a real attacker.
const skipInTest = () => process.env.NODE_ENV === 'test';

// Brute-force guard for password logins (corporate + admin). Keyed by IP only —
// failed attempts share the same budget as successful ones, which is fine here
// since a legitimate user logs in rarely enough not to notice.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

// Keyed by IP + the identifier being requested, so one attacker rotating through many
// phone numbers/emails is still capped per number, and one legitimate user retrying
// isn't blocked by someone else's traffic from a shared IP (office NAT, etc.).
const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.identifier || req.body?.email || req.body?.mobile || ''}`,
  skip: skipInTest,
  message: { error: 'Too many verification codes requested. Please wait a few minutes before trying again.' },
});

// Every endpoint that can send a code, keyed by IP alone: caps how many different
// numbers/emails one source can make us text, on top of the per-destination cap
// enforced in issueOtp (which also covers many IPs aiming at one phone).
const otpSendIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'Too many verification codes requested. Please try again later.' },
});

// Patient password login. Only failures count, so a shared office/mobile-carrier IP
// isn't blocked by its own successful logins; per-account lockout lives in the
// controller and catches an attacker spreading guesses across many IPs.
const patientLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: skipInTest,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

// OTP verify endpoints. Each code already dies after 5 wrong tries; this stops one IP
// cycling through many tickets.
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: skipInTest,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

module.exports = { loginLimiter, otpRequestLimiter, otpSendIpLimiter, patientLoginLimiter, otpVerifyLimiter };
