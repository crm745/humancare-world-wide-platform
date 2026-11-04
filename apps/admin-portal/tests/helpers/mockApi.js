// A fake backend for browser tests that must never touch the real API or database.
// Every request to the API origin is intercepted and answered here; anything not listed
// gets a 404, so a forgotten endpoint fails loudly instead of leaking out.
//
// It also installs the fake WebAuthn API (see fakeWebAuthn.js), so sign-in and the passkey steps
// run without an authenticator. Individual tests change what the "server" does by editing `state`
// or by adding `state.override['POST /path'] = { status, body }` (or a function returning one).
const { installFakeWebAuthn } = require('./fakeWebAuthn');

const APP_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000';

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type,x-hc-admin',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

const json = (status, body) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const b64u = (n, fill) => Buffer.alloc(n, fill).toString('base64url');
const REQUEST_OPTIONS = () => ({ challenge: b64u(32, 9), rpId: 'localhost', timeout: 120000, allowCredentials: [{ id: b64u(16, 1), type: 'public-key', transports: ['internal'] }], userVerification: 'required' });
const CREATION_OPTIONS = () => ({
  rp: { name: 'HumanCare World Wide Admin', id: 'localhost' },
  user: { id: b64u(32, 8), name: 'admin@example.com', displayName: 'Test Admin' },
  challenge: b64u(32, 9),
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 120000,
  attestation: 'none',
  excludeCredentials: [{ id: b64u(16, 2), type: 'public-key' }],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
});

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {object} [initial]
 * @returns the mutable `state`; tests flip fields to change what the "server" does.
 */
async function installMockApi(context, initial = {}) {
  const state = {
    authed: false, // does the (fake) session cookie count as valid?
    role: 'superadmin', // 'admin' | 'superadmin'
    corporateReview: false,
    name: 'Test Admin',
    loginStatus: 200, // set to 401/429 to make the password step fail
    loginError: 'Invalid credentials',
    passkeyStatus: 200, // the passkey step of sign-in
    refreshStatus: 401, // what POST /admin/refresh answers (200 = the session is renewed)
    meNetworkFail: false,
    casesStatus: 200,
    invite: { valid: true, state: 'valid', adminName: 'New Person', maskedEmail: 'ne***@example.org', purpose: 'activation' },
    decision: { status: 'pending', validApprovals: 1 }, // what an approval answers
    requests: [], // what GET /admin/recovery/requests lists
    override: {},
    calls: [], // { method, path, cookie, csrf, origin, body }
    ...initial,
  };

  await installFakeWebAuthn(context, { supported: initial.webauthnSupported !== false });

  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const headers = req.headers();
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = null;
    }
    const key = `${req.method()} ${pathname}`;
    state.calls.push({ method: req.method(), path: pathname, rawBody: req.postData() || null, cookie: headers.cookie || null, csrf: headers['x-hc-admin'] || null, origin: headers.origin || null, body });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    const override = state.override[key];
    if (override) {
      const out = typeof override === 'function' ? override(body, state) : override;
      if (out.abort) return route.abort(out.abort); // simulate a network failure
      return route.fulfill(json(out.status, out.body));
    }

    // ---- sign-in -------------------------------------------------------------------------
    if (key === 'POST /admin/login/password') {
      if (state.loginStatus !== 200) return route.fulfill(json(state.loginStatus, { error: state.loginError, code: 'invalid_credentials' }));
      return route.fulfill(json(200, { loginTicket: 'LOGIN-TICKET', options: REQUEST_OPTIONS(), loginTicketExpiresInSeconds: 120 }));
    }
    if (key === 'POST /admin/login/passkey') {
      if (state.passkeyStatus !== 200) return route.fulfill(json(state.passkeyStatus, { error: 'Invalid credentials', code: 'invalid_credentials' }));
      state.authed = true;
      return route.fulfill(
        json(200, { admin: { id: 1, name: state.name, email: 'admin@example.com', role: state.role }, accessTokenExpiresInSeconds: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' }),
      );
    }
    if (key === 'POST /admin/refresh') {
      if (state.refreshStatus === 200) {
        state.authed = true;
        return route.fulfill(json(200, { accessTokenExpiresInSeconds: 900 }));
      }
      return route.fulfill(json(state.refreshStatus, { error: 'Invalid token' }));
    }
    if (pathname === '/admin/me') {
      if (state.meNetworkFail) return route.abort('connectionrefused');
      if (!state.authed) return route.fulfill(json(401, { error: 'Missing or malformed Authorization header' }));
      const isSuper = state.role === 'superadmin';
      return route.fulfill(
        json(200, { ok: true, admin: { id: 1, role: 'admin', corporateId: null, adminRole: state.role, corporateReview: isSuper || state.corporateReview } }),
      );
    }
    if (key === 'POST /admin/logout') {
      // The real backend's strict JSON parser refuses any body here that is not an object or array,
      // such as the text "null" (this once left logout failing silently in the real browser).
      if (req.postData()) return route.fulfill(json(400, { error: 'Malformed JSON body', code: 'invalid_json' }));
      if (headers['x-hc-admin'] !== '1') return route.fulfill(json(403, { error: 'Forbidden', code: 'csrf_required' }));
      state.authed = false;
      return route.fulfill(json(200, { message: 'Logged out.' }));
    }
    if (pathname === '/admin/cases') {
      return route.fulfill(state.casesStatus === 200 ? json(200, { cases: [] }) : json(state.casesStatus, { error: 'Token expired' }));
    }

    // ---- invitation links and first passkey ------------------------------------------------
    if (key === 'POST /admin/invitations/inspect') return route.fulfill(json(200, state.invite));
    if (key === 'POST /admin/invitations/accept') {
      return route.fulfill(json(200, { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: 'ENROLL-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/enrollment/redeem') {
      return route.fulfill(json(200, { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: 'ENROLL-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/passkeys/registration/options') return route.fulfill(json(200, { options: CREATION_OPTIONS() }));
    if (key === 'POST /admin/passkeys/registration/verify') return route.fulfill(json(200, { status: 'active', nextStep: 'sign_in' }));

    // ---- recovery: the target Admin's side --------------------------------------------------
    if (key === 'POST /admin/recovery/redeem') {
      return route.fulfill(json(200, { status: 'approved', nextStep: 'passkey_registration', recoveryTicket: 'RECOVERY-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/recovery/passkeys/registration/options') return route.fulfill(json(200, { options: CREATION_OPTIONS() }));
    if (key === 'POST /admin/recovery/passkeys/registration/verify') return route.fulfill(json(200, { status: 'recovered', nextStep: 'sign_in' }));

    // ---- recovery: a superadmin's decision ---------------------------------------------------
    if (key === 'GET /admin/recovery/requests') {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      return route.fulfill(json(200, { requests: state.requests }));
    }
    const stepUp = /^\/admin\/recovery\/requests\/(\d+)\/(approval|rejection)\/options$/.exec(pathname);
    if (req.method() === 'POST' && stepUp) {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      return route.fulfill(json(200, { decision: stepUp[2] === 'approval' ? 'approve' : 'reject', requestId: Number(stepUp[1]), options: REQUEST_OPTIONS(), expiresAt: '2030-01-01T00:00:00Z' }));
    }
    const decide = /^\/admin\/recovery\/requests\/(\d+)\/(approve|reject)$/.exec(pathname);
    if (req.method() === 'POST' && decide) {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      const rejected = decide[2] === 'reject';
      return route.fulfill(
        json(200, { decision: decide[2], requestId: Number(decide[1]), status: rejected ? 'rejected' : state.decision.status, validApprovals: rejected ? 0 : state.decision.validApprovals }),
      );
    }

    return route.fulfill(json(404, { error: `unmocked endpoint ${pathname}` }));
  });

  return state;
}

const meCalls = (state) => state.calls.filter((c) => c.path === '/admin/me').length;

module.exports = { installMockApi, meCalls, APP_ORIGIN, API_ORIGIN, REQUEST_OPTIONS, CREATION_OPTIONS };
