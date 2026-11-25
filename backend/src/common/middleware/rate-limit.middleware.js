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

// Sign out (POST /auth/logout): the call only revokes, so the cap is generous; it stops one IP from hammering the endpoint.
const logoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'Too many requests. Please try again in a few minutes.' },
});

// City type-ahead (GET /geo/cities): per signed-in account, since a person typing sends a request
// every few letters. The lookup is a local database query, so this only stops scraping.
const geoSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip)),
  skip: skipInTest,
  message: { error: 'Too many searches. Please wait a moment and try again.' },
});

// Patient writes that cost us real resources: POST /requests (a request, its Case and a CRM lead) and the document upload (disk space, a virus scan, a CRM message). Keyed by the signed-in
// PATIENT, never by IP, so a shared office or mobile-carrier address does not make patients share a budget, and one patient's traffic never uses up another's. They run AFTER requireAuth (an
// unauthenticated caller is a 401 before anything is counted) and, for uploads, BEFORE multer (a refused caller never makes the server write a file).
// The numbers are far above what a person does (a handful of requests a day; at most 10 to 30 documents per request, a retry or two each) and far below what a script does. Every call counts,
// including a retry with the same clientRequestId / clientUploadId: a retry is rare, and a client stuck in a loop is exactly what this stops.
// The counters live in this process's memory (express-rate-limit's default store): they reset when the server restarts and are per instance.
// Tests normally skip every limiter (the suites call the same endpoints dozens of times from one account); the rate-limit tests turn enforcement on with RATE_LIMIT_ENFORCE_IN_TEST=true.
const skipUnlessEnforced = () => process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENFORCE_IN_TEST !== 'true';
const perPatient = (req) => (req.user && req.user.id !== undefined ? `patient:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`);

const patientWriteLimiter = ({ windowMs, limit, message }) => rateLimit({
  windowMs,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: perPatient,
  skip: skipUnlessEnforced,
  message: { error: message, code: 'rate_limited' },
});

// POST /requests: 20 in 15 minutes (a burst) and 100 in 24 hours.
const requestSubmitLimiters = [
  patientWriteLimiter({ windowMs: 15 * 60 * 1000, limit: 20, message: 'You are sending requests too quickly. Please wait a few minutes and try again.' }),
  patientWriteLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: 100, message: 'You have reached the daily limit for requests. Please try again tomorrow or contact Humancare World Wide.' }),
];

// POST /requests/me/:id/documents: 60 in 15 minutes (several requests with a full set of files, retries included) and 300 in 24 hours.
const requestUploadLimiters = [
  patientWriteLimiter({ windowMs: 15 * 60 * 1000, limit: 60, message: 'You are uploading files too quickly. Please wait a few minutes and try again.' }),
  patientWriteLimiter({ windowMs: 24 * 60 * 60 * 1000, limit: 300, message: 'You have reached the daily limit for uploads. Please try again tomorrow or contact Humancare World Wide.' }),
];

module.exports = {
  loginLimiter, otpRequestLimiter, otpSendIpLimiter, patientLoginLimiter, otpVerifyLimiter, geoSearchLimiter, logoutLimiter,
  requestSubmitLimiters, requestUploadLimiters,
};
