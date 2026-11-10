// Per-IP rate limits for the Admin authentication endpoints. They are an outer limit only: the
// real protections (5 failed sign-ins per account, 5 enrollment-redemption attempts per link, 120 s
// tickets) live in the services and are not affected by anything here.
//
// Keyed by IP alone. `trust proxy` is not configured (no deployment evidence), so behind a reverse
// proxy req.ip would be the proxy for everyone and these would share one bucket; that needs a
// deployment decision before production.
//
// Like the other limiters these do nothing under NODE_ENV=test, but the decision goes through
// `control.skip`, which a test can replace (setAdminAuthLimiterSkip) to exercise real limiting
// without touching environment variables. Each limiter has its own store so tests can reset them.
const { rateLimit, ipKeyGenerator, MemoryStore } = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;

const defaultSkip = () => process.env.NODE_ENV === 'test';
const control = { skip: defaultSkip };

function setAdminAuthLimiterSkip(fn) {
  control.skip = typeof fn === 'function' ? fn : defaultSkip;
}

const stores = [];

function limiter(limit) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
    skip: (req, res) => control.skip(req, res),
    message: { error: 'Too many requests. Please try again later.', code: 'rate_limited' },
  });
}

const adminAuthLimiters = {
  inspect: limiter(60),
  accept: limiter(10),
  redeem: limiter(10),
  registrationOptions: limiter(20),
  registrationVerify: limiter(20),
  loginPassword: limiter(20),
  loginPasskey: limiter(30),
  refresh: limiter(120),
  logout: limiter(30),
  // Recovery. Redemption is the password-guessing surface (the service also allows only five
  // attempts per link), so it is as strict as the enrollment redemption.
  recoveryRedeem: limiter(10),
  recoveryRegistrationOptions: limiter(20),
  recoveryRegistrationVerify: limiter(20),
  recoveryStepUp: limiter(30),
  recoveryDecision: limiter(20),
  recoveryList: limiter(60),
};

async function resetAdminAuthLimiters() {
  await Promise.all(stores.map((store) => store.resetAll()));
}

module.exports = { adminAuthLimiters, setAdminAuthLimiterSkip, resetAdminAuthLimiters };
