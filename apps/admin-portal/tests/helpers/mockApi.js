// A fake backend for browser tests that must never touch the real API or database.
// Every request to the API origin is intercepted and answered here; anything not listed
// gets a 404, so a forgotten endpoint fails loudly instead of leaking out.
const APP_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000';

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

const json = (status, body) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
    loginStatus: 200, // set to 401/429 to make login fail
    loginError: 'Invalid credentials',
    meNetworkFail: false,
    casesStatus: 200,
    calls: [], // { method, path, cookie }
    ...initial,
  };

  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    state.calls.push({ method: req.method(), path: pathname, cookie: req.headers().cookie || null });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    if (pathname === '/admin/login') {
      if (state.loginStatus !== 200) return route.fulfill(json(state.loginStatus, { error: state.loginError }));
      state.authed = true;
      return route.fulfill(
        json(200, {
          token: 'SECRET-JWT-SHOULD-NEVER-REACH-THE-PAGE',
          refreshToken: 'SECRET-REFRESH-SHOULD-NEVER-REACH-THE-PAGE',
          admin: { id: 1, name: state.name, email: 'admin@example.com', role: state.role },
        }),
      );
    }
    if (pathname === '/admin/me') {
      if (state.meNetworkFail) return route.abort('connectionrefused');
      if (!state.authed) return route.fulfill(json(401, { error: 'Missing or malformed Authorization header' }));
      const isSuper = state.role === 'superadmin';
      return route.fulfill(
        json(200, { ok: true, admin: { id: 1, role: 'admin', corporateId: null, adminRole: state.role, corporateReview: isSuper || state.corporateReview } }),
      );
    }
    if (pathname === '/admin/logout') {
      state.authed = false;
      return route.fulfill(json(200, { message: 'Logged out.' }));
    }
    if (pathname === '/admin/cases') {
      return route.fulfill(state.casesStatus === 200 ? json(200, { cases: [] }) : json(state.casesStatus, { error: 'Token expired' }));
    }
    return route.fulfill(json(404, { error: `unmocked endpoint ${pathname}` }));
  });

  return state;
}

const meCalls = (state) => state.calls.filter((c) => c.path === '/admin/me').length;

module.exports = { installMockApi, meCalls, APP_ORIGIN, API_ORIGIN };
