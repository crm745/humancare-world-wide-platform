// @ts-check
// The Admin Lock System in the browser (Step 7.9.8): passkey sign-in, invitation acceptance and
// passkey setup, the recovery pages and a superadmin's approval screen. The React app runs against
// a MOCKED API and a FAKE WebAuthn API (tests/helpers). No backend, no database, no real account.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 base64url characters, like a real link token
const PASSWORD = 'Sunrise2027x';
const TICKET_SECRETS = ['RECOVERY-TICKET-SECRET', 'ENROLL-TICKET-SECRET', 'LOGIN-TICKET'];

const signIn = (page) => page.getByRole('button', { name: /^(Sign in|Waiting for passkey)$/ });
const fillLogin = async (page) => {
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('pw');
};
const callsTo = (api, method, path) => api.calls.filter((c) => c.method === method && c.path === path);
const webauthnCalls = (page) => page.evaluate(() => window.__webauthn.calls);
const setWebauthnMode = (page, mode) => page.evaluate((m) => { window.__webauthn.mode = m; }, mode);

/** Collects everything the page logs, to prove secrets never reach the console. */
function watchConsole(page) {
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  page.on('pageerror', (e) => lines.push(String(e)));
  return lines;
}

async function storageAndCookies(page) {
  return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// ---- sign-in: password, then passkey --------------------------------------------------------

test.describe('sign-in with a passkey', () => {
  test('asks for the password, then the passkey (user verification required), and sends the CSRF header', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/login');
    await fillLogin(page);
    await signIn(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    const order = api.calls.filter((c) => c.method === 'POST' && c.path !== '/admin/refresh').map((c) => c.path); // the boot probe may try one refresh first
    expect(order).toEqual(['/admin/login/password', '/admin/login/passkey']);
    expect(api.calls.some((c) => c.path === '/admin/login')).toBe(false); // the old password-only route is gone

    const [get] = await webauthnCalls(page);
    expect(get).toMatchObject({ type: 'get', userVerification: 'required', challengeIsBytes: true, rpId: 'localhost', allowIds: [true] });

    const password = callsTo(api, 'POST', '/admin/login/password')[0];
    expect(password.body).toEqual({ email: 'admin@example.com', password: 'pw' });
    expect(password.csrf).toBe('1');
    const passkey = callsTo(api, 'POST', '/admin/login/passkey')[0];
    expect(passkey.csrf).toBe('1');
    expect(passkey.body.loginTicket).toBe('LOGIN-TICKET');
    expect(Object.keys(passkey.body.response.response).sort()).toEqual(['authenticatorData', 'clientDataJSON', 'signature', 'userHandle']);
    for (const value of Object.values(passkey.body.response.response)) expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(passkey.body.response.rawId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('shows the passkey prompt while waiting and blocks a second submission', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/login');
    await setWebauthnMode(page, 'hang');
    await fillLogin(page);
    await signIn(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Confirm with your passkey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Waiting for passkey' })).toBeDisabled();
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await page.waitForTimeout(200);
    expect(callsTo(api, 'POST', '/admin/login/password')).toHaveLength(1);
    expect(callsTo(api, 'POST', '/admin/login/passkey')).toHaveLength(0);
  });

  test('a cancelled passkey prompt is a clear message, nothing is sent, and the form works again', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/login');
    await setWebauthnMode(page, 'NotAllowedError');
    await fillLogin(page);
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('cancelled or timed out');
    await expect(page).toHaveURL(/\/login$/);
    expect(callsTo(api, 'POST', '/admin/login/passkey')).toHaveLength(0);
    await expect(signIn(page)).toBeEnabled();

    await setWebauthnMode(page, 'ok');
    await signIn(page).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a wrong password never reaches the passkey step; a refused passkey is the generic error', async ({ page, context }) => {
    const api = await installMockApi(context, { loginStatus: 401 });
    await page.goto('/login');
    await fillLogin(page);
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('Invalid credentials');
    expect(await webauthnCalls(page)).toHaveLength(0);

    api.loginStatus = 200;
    api.passkeyStatus = 401;
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('Invalid credentials');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toHaveCount(0);
  });

  test('a browser without passkey support is told so and cannot submit', async ({ page, context }) => {
    const api = await installMockApi(context, { webauthnSupported: false });
    await page.goto('/login');
    await expect(page.getByText("can't use passkeys")).toBeVisible();
    await fillLogin(page);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(callsTo(api, 'POST', '/admin/login/password')).toHaveLength(0);
  });
});

// ---- protected routes, logout, session expiry -----------------------------------------------

test.describe('sessions', () => {
  test('protected pages (including the approvals page) send a signed-out visitor to sign in', async ({ page, context }) => {
    await installMockApi(context);
    for (const path of ['/recovery', '/cases', '/admins']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });

  test('the invitation and recovery pages are reachable without a session', async ({ page, context }) => {
    await installMockApi(context);
    for (const path of ['/accept-invite', '/enroll-passkey', '/recover-passkey']) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
  });

  test('logout sends the CSRF header, lands on a clean login, and the app is locked again', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/cases');
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(callsTo(api, 'POST', '/admin/logout')[0].csrf).toBe('1');
    expect(callsTo(api, 'POST', '/admin/logout')[0].rawBody).toBeNull(); // no body: the real backend refuses the text "null"
    expect(api.authed).toBe(false);
    await page.goto('/recovery');
    await expect(page).toHaveURL(/\/login$/);
  });

  test.describe('logout outcomes', () => {
    const LOGOUT = 'POST /admin/logout';
    const REFRESH = 'POST /admin/refresh';
    const openCases = async (page, context) => {
      const api = await installMockApi(context, { authed: true });
      await page.goto('/cases');
      await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
      return api;
    };
    const clickLogout = (page) => page.getByRole('button', { name: 'Log out' }).click();
    const expectStillSignedIn = async (page, api) => {
      await expect(page.getByRole('alert')).toContainText('still signed in');
      await expect(page).toHaveURL(/\/cases$/);
      await expect(page.getByRole('button', { name: 'Log out' })).toBeEnabled();
      expect(api.authed).toBe(true);
    };

    test('success: one logout request, no refresh, signed out', async ({ page, context }) => {
      const api = await openCases(page, context);
      await clickLogout(page);
      await expect(page).toHaveURL(/\/login$/);
      expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(1);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(0);
    });

    test('expired access token: one refresh, then logout succeeds and the user is signed out', async ({ page, context }) => {
      const api = await openCases(page, context);
      api.override[REFRESH] = (_b, s) => { s.refreshed = true; return { status: 200, body: { accessTokenExpiresInSeconds: 900 } }; };
      api.override[LOGOUT] = (_b, s) => (s.refreshed ? { status: 200, body: { message: 'Logged out.' } } : { status: 401, body: { error: 'Token expired' } });
      await clickLogout(page);
      await expect(page).toHaveURL(/\/login$/);
      expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(2);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(1);
    });

    test('401 with a dead session (refresh refused too): treated as revoked and signed out, no retry loop', async ({ page, context }) => {
      const api = await openCases(page, context);
      api.override[LOGOUT] = { status: 401, body: { error: 'Invalid token' } };
      api.refreshStatus = 401;
      await clickLogout(page);
      await expect(page).toHaveURL(/\/login$/);
      expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(1);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(1);
    });

    test('401 even after a successful refresh: the session is gone, signed out after exactly two logout calls', async ({ page, context }) => {
      const api = await openCases(page, context);
      api.override[LOGOUT] = { status: 401, body: { error: 'Invalid token' } };
      api.refreshStatus = 200;
      await clickLogout(page);
      await expect(page).toHaveURL(/\/login$/);
      expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(2);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(1);
    });

    test('network failure: error shown, still signed in, and a later attempt can succeed', async ({ page, context }) => {
      const api = await openCases(page, context);
      api.override[LOGOUT] = { abort: 'connectionrefused' };
      await clickLogout(page);
      await expectStillSignedIn(page, api);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(0);
      delete api.override[LOGOUT];
      await clickLogout(page);
      await expect(page).toHaveURL(/\/login$/);
      expect(api.authed).toBe(false);
    });

    for (const status of [500, 503, 403]) {
      test(`HTTP ${status}: error shown, still signed in, no refresh and no retry`, async ({ page, context }) => {
        const api = await openCases(page, context);
        api.override[LOGOUT] = { status, body: { error: 'nope' } };
        await clickLogout(page);
        await expectStillSignedIn(page, api);
        expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(1);
        expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(0);
      });
    }

    test('401 but the refresh endpoint is down (5xx): not confirmed, so still signed in', async ({ page, context }) => {
      const api = await openCases(page, context);
      api.override[LOGOUT] = { status: 401, body: { error: 'Token expired' } };
      api.override[REFRESH] = { status: 500, body: { error: 'boom' } };
      await clickLogout(page);
      await expectStillSignedIn(page, api);
      expect(callsTo(api, 'POST', '/admin/logout')).toHaveLength(1);
      expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(1);
    });
  });

  test('an expired access cookie is renewed once, quietly, and the request is repeated', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    api.override['POST /admin/refresh'] = (_b, s) => { s.refreshed = true; return { status: 200, body: { accessTokenExpiresInSeconds: 900 } }; };
    api.override['GET /admin/cases'] = (_b, s) => (s.refreshed ? { status: 200, body: { cases: [] } } : { status: 401, body: { error: 'Token expired' } });
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    const statuses = await page.evaluate(async () => {
      const { http } = await import('/src/services/http.js');
      const results = await Promise.all([http.get('/admin/cases'), http.get('/admin/cases'), http.get('/admin/cases')]);
      return results.map((r) => r.status);
    });
    expect(statuses).toEqual([200, 200, 200]);
    const refreshes = callsTo(api, 'POST', '/admin/refresh');
    expect(refreshes).toHaveLength(1); // three 401s share one refresh
    expect(refreshes[0].csrf).toBe('1');
    await expect(page).toHaveURL(/\/billing$/);
  });

  test('when the session cannot be renewed the app returns to sign-in with a notice', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    api.authed = false;
    api.casesStatus = 401;
    await page.evaluate(async () => {
      const { http } = await import('/src/services/http.js');
      await http.get('/admin/cases').catch(() => {});
    });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/refresh').length).toBeGreaterThanOrEqual(1);
  });

  test('a returning visitor whose access cookie lapsed but whose refresh cookie is alive stays signed in', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: false, refreshStatus: 200 });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/refresh')).toHaveLength(1);
  });
});

// ---- invitation acceptance and first passkey -------------------------------------------------

test.describe('accepting an invitation', () => {
  test('checks the link, sets the password, creates the passkey, and keeps everything out of storage, URL and console', async ({ page, context }) => {
    const api = await installMockApi(context);
    await context.addCookies([{ name: 'hc_admin_token', value: 'ADMIN-SESSION-COOKIE', url: 'http://localhost/' }]);
    const logs = watchConsole(page);
    await page.goto(`/accept-invite#token=${TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Welcome to HumanCare Admin' })).toBeVisible();
    await expect(page.getByText('ne***@example.org')).toBeVisible();
    expect(page.url()).not.toContain('token'); // the fragment is gone from the address bar

    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save password and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create your passkey' })).toBeVisible();

    await page.getByLabel('Passkey name (optional)').fill('Work laptop');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');

    expect(callsTo(api, 'POST', '/admin/invitations/inspect')[0].body).toEqual({ token: TOKEN });
    expect(callsTo(api, 'POST', '/admin/invitations/accept')[0].body).toEqual({ token: TOKEN, password: PASSWORD });
    expect(callsTo(api, 'POST', '/admin/passkeys/registration/options')[0].body).toEqual({ ticket: 'ENROLL-TICKET-SECRET' });
    const verify = callsTo(api, 'POST', '/admin/passkeys/registration/verify')[0].body;
    expect(verify).toMatchObject({ ticket: 'ENROLL-TICKET-SECRET', label: 'Work laptop' });
    expect(Object.keys(verify.response.response).sort()).toEqual(['attestationObject', 'clientDataJSON', 'transports']);

    const [create] = await webauthnCalls(page);
    expect(create).toMatchObject({ type: 'create', userVerification: 'required', challengeIsBytes: true, userIdIsBytes: true, excludeIds: [true] });

    // public calls never carry the session cookie; the signed-in probe does
    const publicCalls = api.calls.filter((c) => c.path.startsWith('/admin/invitations') || c.path.startsWith('/admin/passkeys'));
    expect(publicCalls.length).toBeGreaterThan(0);
    publicCalls.forEach((c) => expect(c.cookie).toBeNull());

    const stored = await storageAndCookies(page);
    for (const secret of [TOKEN, PASSWORD, ...TICKET_SECRETS]) {
      expect(stored).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(page.url()).not.toContain(secret);
    }
    expect(JSON.parse(stored).local).toEqual({});
    expect(JSON.parse(stored).session).toEqual({});
  });

  test('catches a weak or mismatched password before any request', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    const submit = page.getByRole('button', { name: 'Save password and continue' });

    await page.getByLabel('New password', { exact: true }).fill('short1');
    await submit.click();
    await expect(page.getByText('at least 8 characters')).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill('onlyletters');
    await submit.click();
    await expect(page.getByText('at least one letter and one number')).toBeVisible();

    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill('Different2027');
    await submit.click();
    await expect(page.getByText('do not match')).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/invitations/accept')).toHaveLength(0);
  });

  for (const [state, text] of [['used', 'already been used'], ['revoked', 'was cancelled'], ['expired', 'has expired'], ['invalid', 'not valid']]) {
    test(`a ${state} link says so and offers nothing else`, async ({ page, context }) => {
      await installMockApi(context, { invite: { valid: false, state } });
      await page.goto(`/accept-invite#token=${TOKEN}`);
      await expect(page.getByRole('heading', { name: 'Invitation not available' })).toBeVisible();
      await expect(page.getByRole('status')).toContainText(text);
      await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    });
  }

  test('no token, a malformed token, or a link of another kind is refused without calling the API', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/accept-invite');
    await expect(page.getByRole('heading', { name: 'Invitation not available' })).toBeVisible();
    await page.goto('/accept-invite#token=short');
    await expect(page.getByRole('heading', { name: 'Invitation not available' })).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/invitations/inspect')).toHaveLength(0);

    api.invite = { valid: true, state: 'valid', purpose: 'passkey_recovery', adminName: 'X', maskedEmail: 'x***@e.org' };
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Invitation not available' })).toBeVisible();
  });

  test('a cancelled prompt and an already-registered device are explained, and a retry works', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save password and continue' }).click();
    const create = page.getByRole('button', { name: 'Create passkey' });

    await setWebauthnMode(page, 'NotAllowedError');
    await create.click();
    await expect(page.getByRole('alert')).toContainText('cancelled or timed out');
    expect(callsTo(api, 'POST', '/admin/passkeys/registration/verify')).toHaveLength(0);

    await setWebauthnMode(page, 'InvalidStateError');
    await create.click();
    await expect(page.getByRole('alert')).toContainText('already has a passkey');

    await setWebauthnMode(page, 'ok');
    await create.click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  });

  test('a setup ticket the server no longer accepts ends the session with a clear message', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/passkeys/registration/options'] = { status: 400, body: { error: 'This passkey setup session is not valid. Please start again.', code: 'invalid_enrollment' } };
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save password and continue' }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Setup session ended' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create passkey' })).toHaveCount(0);
  });

  test('the server\'s weak-password answer is shown and the form stays usable', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/invitations/accept'] = { status: 400, body: { error: 'Password must include at least one letter and one number.', code: 'weak_password' } };
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save password and continue' }).click();
    await expect(page.getByRole('alert')).toContainText('at least one letter and one number');
    await expect(page.getByRole('button', { name: 'Save password and continue' })).toBeEnabled();
  });
});

test.describe('finishing passkey setup from the passkey email', () => {
  test('current password, then passkey, then done; a wrong password is generic and retryable', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto(`/enroll-passkey#token=${TOKEN}`);
    await expect(page).not.toHaveURL(/token/);

    api.override['POST /admin/enrollment/redeem'] = { status: 400, body: { error: 'This invitation link is not valid.', code: 'invalid_invitation' } };
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText("didn't work");
    await expect(page.getByLabel('Password', { exact: true })).toBeEnabled();

    delete api.override['POST /admin/enrollment/redeem'];
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/enrollment/redeem').pop().body).toEqual({ token: TOKEN, password: PASSWORD });
    expect(callsTo(api, 'POST', '/admin/enrollment/redeem').every((c) => c.cookie === null)).toBe(true);
  });

  test('without a link it explains and calls nothing', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/enroll-passkey');
    await expect(page.getByRole('heading', { name: 'Setup link not valid' })).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

// ---- recovery: the target Admin's side ---------------------------------------------------------

test.describe('recovering a lost passkey', () => {
  test('link -> current password -> new passkey -> sign in again, with no session and no secrets left behind', async ({ page, context }) => {
    const api = await installMockApi(context);
    // an ordinary Admin session cookie in the same browser must not be attached to recovery calls
    await context.addCookies([{ name: 'hc_admin_token', value: 'ADMIN-SESSION-COOKIE', url: 'http://localhost/' }]);
    const logs = watchConsole(page);
    await page.goto(`/recover-passkey#token=${TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Recover your passkey' })).toBeVisible();
    expect(page.url()).not.toContain('token');
    expect(page.url()).not.toContain('#');

    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create your new passkey' })).toBeVisible();

    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Passkey recovered' })).toBeVisible();
    await expect(page.getByText('signed out everywhere')).toBeVisible();

    // exact backend contract
    expect(callsTo(api, 'POST', '/admin/recovery/redeem')[0].body).toEqual({ token: TOKEN, password: PASSWORD });
    expect(callsTo(api, 'POST', '/admin/recovery/passkeys/registration/options')[0].body).toEqual({ ticket: 'RECOVERY-TICKET-SECRET' });
    const verify = callsTo(api, 'POST', '/admin/recovery/passkeys/registration/verify')[0].body;
    expect(verify.ticket).toBe('RECOVERY-TICKET-SECRET');
    expect(verify.response.type).toBe('public-key');
    const [create] = await webauthnCalls(page);
    expect(create).toMatchObject({ type: 'create', userVerification: 'required', challengeIsBytes: true });

    // public recovery endpoints get no ordinary-session credentials at all
    const recoveryCalls = api.calls.filter((c) => c.path.startsWith('/admin/recovery/'));
    expect(recoveryCalls).toHaveLength(3);
    recoveryCalls.forEach((c) => {
      expect(c.cookie).toBeNull();
      expect(c.csrf).toBeNull();
    });

    // no session was created by recovery
    expect(api.calls.some((c) => c.path.startsWith('/admin/login'))).toBe(false);
    expect(api.calls.some((c) => c.path === '/admin/refresh')).toBe(false);
    expect(api.authed).toBe(false);

    // nothing sensitive in storage, cookies the page can see, URL or console
    const stored = await storageAndCookies(page);
    for (const secret of [TOKEN, PASSWORD, 'RECOVERY-TICKET-SECRET']) {
      expect(stored).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(page.url()).not.toContain(secret);
    }
    expect(JSON.parse(stored).local).toEqual({});
    expect(JSON.parse(stored).session).toEqual({});

    // "Sign in" goes to the login page, not into the app
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password is one generic message, keeps the form, and never shows the ticket step', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/recovery/redeem'] = { status: 400, body: { error: 'This passkey recovery session is not valid. Please start again.', code: 'invalid_recovery' } };
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText("didn't work");
    await expect(page.getByLabel('Current password', { exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Create your new passkey' })).toHaveCount(0);

    api.override['POST /admin/recovery/redeem'] = { status: 429, body: { error: 'Too many requests. Please try again later.', code: 'rate_limited' } };
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('Too many requests');
  });

  test('requires a password before calling the API, and blocks duplicate submissions', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/recovery/redeem'] = { status: 400, body: { error: 'x', code: 'invalid_recovery' } };
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Enter your current password.')).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/recovery/redeem')).toHaveLength(0);

    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    // two submissions in the same tick, before React can re-render the disabled state
    await page.evaluate(() => {
      const form = document.querySelector('form');
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page.getByRole('alert')).toBeVisible();
    expect(callsTo(api, 'POST', '/admin/recovery/redeem')).toHaveLength(1);
    // and the validation failure above did not leave the form stuck
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => callsTo(api, 'POST', '/admin/recovery/redeem').length).toBe(2);
  });

  test('a missing or malformed link is refused without calling the API', async ({ page, context }) => {
    const api = await installMockApi(context);
    for (const url of ['/recover-passkey', '/recover-passkey#token=', '/recover-passkey#token=not-a-real-token', `/recover-passkey?token=${TOKEN}`]) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Recovery link not valid' })).toBeVisible();
    }
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('the recovery ticket expires after ten minutes: the passkey step is withdrawn and nothing is kept', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.clock.install();
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create your new passkey' })).toBeVisible();

    await page.clock.fastForward('09:30');
    await expect(page.getByRole('heading', { name: 'Create your new passkey' })).toBeVisible();
    await page.clock.fastForward('01:00');
    await expect(page.getByRole('heading', { name: 'Recovery session ended' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create passkey' })).toHaveCount(0);
    expect(callsTo(api, 'POST', '/admin/recovery/passkeys/registration/options')).toHaveLength(0);
    expect(await storageAndCookies(page)).not.toContain('RECOVERY-TICKET-SECRET');
  });

  test('a ticket the server rejects (cancelled, expired, replaced) ends the session cleanly', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/recovery/passkeys/registration/verify'] = { status: 400, body: { error: 'This passkey recovery session is not valid. Please start again.', code: 'invalid_recovery' } };
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery session ended' })).toBeVisible();
    await expect(page.getByText('Nothing was changed on your account')).toBeVisible();
  });

  test('cancelling the passkey prompt or reusing a device is explained, and the new passkey can still be made', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    const create = page.getByRole('button', { name: 'Create passkey' });

    await setWebauthnMode(page, 'NotAllowedError');
    await create.click();
    await expect(page.getByRole('alert')).toContainText('cancelled or timed out');
    await setWebauthnMode(page, 'NotSupportedError');
    await create.click();
    await expect(page.getByRole('alert')).toContainText("can't create the kind of passkey");
    await setWebauthnMode(page, 'SecurityError');
    await create.click();
    await expect(page.getByRole('alert')).toContainText('secure (HTTPS) address');
    expect(callsTo(api, 'POST', '/admin/recovery/passkeys/registration/verify')).toHaveLength(0);

    await setWebauthnMode(page, 'ok');
    await create.click();
    await expect(page.getByRole('heading', { name: 'Passkey recovered' })).toBeVisible();
  });

  test('the server never sees user verification weakened: options without it are refused by the page', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/recovery/passkeys/registration/options'] = {
      status: 200,
      body: { options: { rp: { name: 'x', id: 'localhost' }, user: { id: 'AAAA', name: 'a', displayName: 'a' }, challenge: 'AAAA', pubKeyCredParams: [], authenticatorSelection: { userVerification: 'discouraged' } } },
    };
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('alert')).toContainText('not valid');
    expect(await webauthnCalls(page)).toHaveLength(0); // the browser was never asked
    expect(callsTo(api, 'POST', '/admin/recovery/passkeys/registration/verify')).toHaveLength(0);
  });

  test('a browser without passkey support is told before the password is asked for', async ({ page, context }) => {
    await installMockApi(context, { webauthnSupported: false });
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await expect(page.getByText("can't use passkeys")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});

// ---- recovery: a superadmin's decision ---------------------------------------------------------

test.describe('recovery approvals', () => {
  const reference = (page) => page.getByLabel('Request reference');

  async function open(page, id = '12') {
    await page.goto('/recovery');
    await reference(page).fill(id);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(`Reference ${id}`)).toBeVisible();
  }

  test('is in the navigation for a superadmin only, and a regular admin is refused', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, role: 'superadmin' });
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).first().getByRole('link', { name: 'Recovery' })).toBeVisible();

    api.role = 'admin';
    await page.goto('/recovery');
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).first().getByRole('link', { name: 'Recovery' })).toHaveCount(0);
  });

  test('validates the reference number before anything else', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/recovery');
    for (const bad of ['', 'abc', '0', '1.5', '-3', '12345678901']) {
      await reference(page).fill(bad);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('Enter the request reference number')).toBeVisible();
    }
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'))).toHaveLength(0);
  });

  test('approve: step-up, passkey, then the decision - identity comes from the session, not the body', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await context.addCookies([{ name: 'hc_admin_token', value: 'ADMIN-SESSION-COOKIE', url: 'http://localhost/' }]);
    const logs = watchConsole(page);
    await open(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByLabel('Note (optional)').fill('Confirmed by phone');
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Your approval is recorded (1 of 2 needed)' })).toBeVisible();

    const recovery = api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'));
    expect(recovery.map((c) => c.path)).toEqual(['/admin/recovery/requests/12/approval/options', '/admin/recovery/requests/12/approve']);
    recovery.forEach((c) => {
      expect(c.csrf).toBe('1');
      expect(c.cookie).toContain('hc_admin_token=ADMIN-SESSION-COOKIE'); // this one IS the signed-in session
    });
    expect(recovery[0].body).toBeNull();
    expect(Object.keys(recovery[1].body).sort()).toEqual(['reason', 'response']); // no adminId, sessionId or requestId
    expect(recovery[1].body.reason).toBe('Confirmed by phone');
    const [get] = await webauthnCalls(page);
    expect(get).toMatchObject({ type: 'get', userVerification: 'required' });
    expect(logs.join('\n')).not.toMatch(/signature|clientDataJSON|authenticatorData/);
    expect(JSON.parse(await storageAndCookies(page)).local).toEqual({});
    // the screen is ready for another request
    await expect(reference(page)).toBeVisible();
  });

  test('the final approval says the recovery link is on its way', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    api.decision = { status: 'approved', validApprovals: 2 };
    await open(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByText('final one needed')).toBeVisible();
  });

  test('reject needs a reason, uses its own step-up, and reports the outcome', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await open(page, '7');
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.getByRole('button', { name: 'Reject with passkey' }).click();
    await expect(page.getByText('Give a reason for rejecting')).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'))).toHaveLength(0);
    expect(await webauthnCalls(page)).toHaveLength(0);

    await page.getByLabel('Reason (required)').fill('Not requested by the admin');
    await page.getByRole('button', { name: 'Reject with passkey' }).click();
    await expect(page.getByText('The request was rejected')).toBeVisible();
    const recovery = api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'));
    expect(recovery.map((c) => c.path)).toEqual(['/admin/recovery/requests/7/rejection/options', '/admin/recovery/requests/7/reject']);
    expect(recovery[1].body.reason).toBe('Not requested by the admin');
  });

  const failures = [
    ['not_available', 404, 'isn\'t available to you', 'own recovery'],
    ['already_decided', 409, 'already decided', null],
    ['step_up_failed', 400, "wasn't accepted", null],
  ];
  for (const [code, status, text, extra] of failures) {
    test(`shows a clear message for ${code}`, async ({ page, context }) => {
      const api = await installMockApi(context, { authed: true });
      api.override['POST /admin/recovery/requests/12/approval/options'] = { status, body: { error: 'server text', code } };
      await open(page);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByRole('button', { name: 'Approve with passkey' }).click();
      await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: text })).toBeVisible();
      if (extra) await expect(page.getByText(extra)).toBeVisible();
      await expect(page.getByText('Reference 12')).toBeVisible(); // can try again or change it
    });
  }

  test('a failed decision after the passkey is reported and recorded nowhere on the page', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    api.override['POST /admin/recovery/requests/12/approve'] = { status: 400, body: { error: 'The passkey confirmation was not accepted.', code: 'step_up_failed' } };
    await open(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText("wasn't accepted");
    await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled();
  });

  test('a cancelled passkey prompt sends no decision', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await open(page);
    await setWebauthnMode(page, 'NotAllowedError');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText('cancelled or timed out');
    expect(callsTo(api, 'POST', '/admin/recovery/requests/12/approve')).toHaveLength(0);
  });

  test('blocks duplicate submissions while the passkey prompt is open', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await open(page);
    await setWebauthnMode(page, 'hang');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    const waiting = page.getByRole('button', { name: 'Waiting for your passkey' });
    await expect(waiting).toBeDisabled();
    await waiting.click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
    expect(callsTo(api, 'POST', '/admin/recovery/requests/12/approval/options')).toHaveLength(1);
  });

  test('frontend role checks are not authorization: a 403 from the server is shown', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    api.override['POST /admin/recovery/requests/12/approval/options'] = { status: 403, body: { error: 'Superadmin access required' } };
    await open(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText('Only superadmins');
  });

  test('an expired session during a decision returns to sign-in with a notice', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await open(page);
    api.authed = false;
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toBeVisible();
  });
});

// ---- recovery approvals: the list of requests waiting for the superadmin -------------------------

test.describe('recovery approvals list', () => {
  const REQUESTS = [
    {
      id: 12,
      status: 'pending',
      reason: 'Lost the only laptop with my security key',
      createdAt: '2027-03-01T10:00:00.000Z',
      expiresAt: '2027-03-08T10:00:00.000Z',
      approvalsReceived: 1,
      approvalsRequired: 2,
      target: { id: 7, name: 'Tara Target', email: 'tara@example.org' },
    },
    {
      id: 15,
      status: 'pending',
      reason: null,
      createdAt: '2027-03-02T10:00:00.000Z',
      expiresAt: '2027-03-09T10:00:00.000Z',
      approvalsReceived: 0,
      approvalsRequired: 2,
      target: { id: 9, name: 'Omar Other', email: 'omar@example.org' },
    },
  ];
  const card = (page, id) => page.getByRole('article', { name: `Recovery request ${id}` });

  test('shows each waiting request with the Admin, reason, dates and approval count - no reference number needed', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: REQUESTS });
    await context.addCookies([{ name: 'hc_admin_token', value: 'ADMIN-SESSION-COOKIE', url: 'http://localhost/' }]);
    await page.goto('/recovery');

    await expect(card(page, 12)).toContainText('Tara Target');
    await expect(card(page, 12)).toContainText('tara@example.org');
    await expect(card(page, 12)).toContainText('Lost the only laptop with my security key');
    await expect(card(page, 12)).toContainText('1 of 2');
    await expect(card(page, 12)).toContainText('Reference 12');
    await expect(card(page, 15)).toContainText('Omar Other');
    await expect(card(page, 15)).toContainText('No reason recorded.');
    await expect(card(page, 15)).toContainText('0 of 2');
    await expect(card(page, 12)).not.toContainText('Invalid Date');

    const list = api.calls.filter((c) => c.method === 'GET' && c.path === '/admin/recovery/requests');
    expect(list.length).toBeGreaterThanOrEqual(1); // (React StrictMode runs the effect twice in development)
    expect(list[0].csrf).toBeNull(); // a read: no CSRF header
    expect(list[0].cookie).toContain('hc_admin_token=ADMIN-SESSION-COOKIE'); // the signed-in session
    expect(await page.content()).not.toMatch(/tokenHash|passwordHash/);
  });

  test('approving from the list keeps the target and reason in front of the decision, then refreshes the list', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: REQUESTS });
    await page.goto('/recovery');
    await card(page, 12).getByRole('button', { name: 'Review and approve' }).click();

    const panel = page.getByRole('region', { name: 'Decision' });
    await expect(panel).toContainText('Reference 12');
    await expect(panel).toContainText('Tara Target');
    await expect(panel).toContainText('Lost the only laptop with my security key');
    await expect(panel.getByText('Approve request 12 for Tara Target')).toBeVisible();

    api.recoveryRequests = [REQUESTS[1]]; // what the server will list after the decision
    await panel.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByText('Your approval is recorded (1 of 2 needed)')).toBeVisible();

    const posts = api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery')).map((c) => c.path);
    expect(posts).toEqual(['/admin/recovery/requests/12/approval/options', '/admin/recovery/requests/12/approve']);
    await expect(card(page, 15)).toBeVisible();
    await expect(card(page, 12)).toHaveCount(0);
    const lists = api.calls.filter((c) => c.method === 'GET' && c.path === '/admin/recovery/requests');
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(api.calls.at(-1).path).toBe('/admin/recovery/requests'); // the list was fetched again after the decision
  });

  test('rejecting from the list needs a reason and uses the rejection step-up for that request', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: REQUESTS });
    await page.goto('/recovery');
    await card(page, 15).getByRole('button', { name: 'Review and reject' }).click();
    await expect(page.getByText('Reject request 15 for Omar Other')).toBeVisible();

    await page.getByRole('button', { name: 'Reject with passkey' }).click();
    await expect(page.getByText('Give a reason for rejecting')).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'))).toHaveLength(0);

    await page.getByLabel('Reason (required)').fill('Nobody asked for this');
    await page.getByRole('button', { name: 'Reject with passkey' }).click();
    await expect(page.getByText('The request was rejected')).toBeVisible();
    const posts = api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'));
    expect(posts.map((c) => c.path)).toEqual(['/admin/recovery/requests/15/rejection/options', '/admin/recovery/requests/15/reject']);
    expect(posts[1].body.reason).toBe('Nobody asked for this');
  });

  test('Change returns to the list without sending anything', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: REQUESTS });
    await page.goto('/recovery');
    await card(page, 12).getByRole('button', { name: 'Review and approve' }).click();
    await page.getByRole('button', { name: 'Change' }).click();
    await expect(card(page, 12)).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'))).toHaveLength(0);
  });

  test('shows an empty state, and the reference fallback still works', async ({ page, context }) => {
    await installMockApi(context, { authed: true, recoveryRequests: [] });
    await page.goto('/recovery');
    await expect(page.getByText('No recovery requests are waiting for you')).toBeVisible();
    await expect(page.getByLabel('Request reference')).toBeVisible();
    await page.getByLabel('Request reference').fill('44');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Reference 44')).toBeVisible();
    await expect(page.getByText("can't be shown")).toBeVisible(); // no target known for a typed reference
  });

  test('shows a loading state, then a clear error with a working Try again', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: REQUESTS });
    let fail = true;
    await context.route('http://localhost:4000/admin/recovery/requests', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await new Promise((r) => setTimeout(r, 400));
      if (fail) {
        return route.fulfill({
          status: 500,
          headers: { 'access-control-allow-origin': 'http://localhost:3000', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'Internal server error' }),
        });
      }
      return route.fallback();
    });
    await page.goto('/recovery');
    await expect(page.getByRole('status', { name: 'Loading requests' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Internal server error');
    await expect(page.getByText('No recovery requests are waiting for you')).toHaveCount(0);

    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, 12)).toBeVisible();
    expect(api.calls.filter((c) => c.path === '/admin/recovery/requests').length).toBeGreaterThanOrEqual(1);
  });

  test('an expired session while loading returns to sign-in', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await context.route('http://localhost:4000/admin/recovery/requests', (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 401, headers: { 'access-control-allow-origin': 'http://localhost:3000', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Invalid token' }) });
    });
    await page.getByRole('navigation', { name: 'Main navigation' }).first().getByRole('link', { name: 'Recovery' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toBeVisible();
  });

  for (const width of [1280, 375, 320]) {
    test(`the list fits a ${width}px screen with long names, emails and reasons`, async ({ page, context }) => {
      const long = {
        ...REQUESTS[0],
        reason: 'A very long reason '.repeat(30),
        target: { id: 7, name: 'Aleksandrina-Maximiliana Wolfeschlegelsteinhausenbergerdorff', email: 'a.very.long.email.address.indeed@subdomain.example-company.org' },
      };
      await installMockApi(context, { authed: true, recoveryRequests: [long, REQUESTS[1]] });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/recovery');
      await expect(card(page, 12)).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
      const button = card(page, 12).getByRole('button', { name: 'Review and approve' });
      const box = await button.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    });
  }
});

// ---- Step 7.9.9: failure paths -----------------------------------------------------------------------

test.describe('unsupported browsers, stale requests and server errors', () => {
  const LISTED = {
    id: 12,
    status: 'pending',
    reason: 'Lost laptop',
    createdAt: '2027-03-01T10:00:00.000Z',
    expiresAt: '2027-03-08T10:00:00.000Z',
    approvalsReceived: 0,
    approvalsRequired: 2,
    target: { id: 7, name: 'Tara Target', email: 'tara@example.org' },
  };
  const card = (page) => page.getByRole('article', { name: 'Recovery request 12' });

  test('passkey creation in an unsupported browser is blocked before the server is asked for a challenge', async ({ page, context }) => {
    const api = await installMockApi(context, { webauthnSupported: false });
    await page.goto(`/accept-invite#token=${TOKEN}`);
    await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save password and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create your passkey' })).toBeVisible();
    await expect(page.getByText("can't use passkeys")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create passkey' })).toBeDisabled();
    expect(callsTo(api, 'POST', '/admin/passkeys/registration/options')).toHaveLength(0);
  });

  test('recovery approvals in an unsupported browser cannot start a step-up', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: [LISTED], webauthnSupported: false });
    await page.goto('/recovery');
    await card(page).getByRole('button', { name: 'Review and approve' }).click();
    await expect(page.getByText("can't use passkeys, so you can't approve or reject")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeDisabled();
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/admin/recovery'))).toHaveLength(0);
  });

  test('a stale request: the server says it is gone, the message is shown and the entry leaves the list', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: [LISTED] });
    api.override['POST /admin/recovery/requests/12/approval/options'] = { status: 404, body: { error: 'This recovery request is not available to you.', code: 'not_available' } };
    await page.goto('/recovery');
    await card(page).getByRole('button', { name: 'Review and approve' }).click();

    api.recoveryRequests = []; // someone else has decided in the meantime
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText("isn't available to you");
    expect(callsTo(api, 'POST', '/admin/recovery/requests/12/approve')).toHaveLength(0);

    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByText('No recovery requests are waiting for you')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('an already-decided answer is a calm warning and also refreshes the list', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: [LISTED] });
    api.override['POST /admin/recovery/requests/12/approval/options'] = { status: 409, body: { error: 'You have already decided on this recovery request.', code: 'already_decided' } };
    await page.goto('/recovery');
    await card(page).getByRole('button', { name: 'Review and approve' }).click();
    const before = api.calls.filter((c) => c.method === 'GET' && c.path === '/admin/recovery/requests').length;
    api.recoveryRequests = [];
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'already decided' })).toBeVisible();
    await expect.poll(() => api.calls.filter((c) => c.method === 'GET' && c.path === '/admin/recovery/requests').length).toBeGreaterThan(before);
  });

  test('a server error or a rate limit on a decision is shown plainly, and the decision can be retried', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, recoveryRequests: [LISTED] });
    await page.goto('/recovery');
    await card(page).getByRole('button', { name: 'Review and approve' }).click();

    api.override['POST /admin/recovery/requests/12/approve'] = { status: 500, body: { error: 'Internal server error' } };
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('alert')).toContainText('Internal server error');
    await expect(page.getByRole('button', { name: 'Approve with passkey' })).toBeEnabled();

    api.override['POST /admin/recovery/requests/12/approve'] = { status: 429, body: { error: 'Too many requests. Please try again later.', code: 'rate_limited' } };
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Too many attempts' })).toBeVisible();

    delete api.override['POST /admin/recovery/requests/12/approve'];
    await page.getByRole('button', { name: 'Approve with passkey' }).click();
    await expect(page.getByText('Your approval is recorded')).toBeVisible();
  });

  test('an unreachable server during sign-in is a clear message and the form recovers', async ({ page, context }) => {
    await installMockApi(context);
    await page.goto('/login');
    await context.route('http://localhost:4000/admin/login/passkey', (r) => r.abort('connectionrefused'));
    await fillLogin(page);
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('Unable to reach the server');
    await expect(signIn(page)).toBeEnabled();
  });

  test('a server error on recovery redemption is shown without leaking the link or password', async ({ page, context }) => {
    const api = await installMockApi(context);
    api.override['POST /admin/recovery/redeem'] = { status: 500, body: { error: 'Internal server error' } };
    const logs = watchConsole(page);
    await page.goto(`/recover-passkey#token=${TOKEN}`);
    await page.getByLabel('Current password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText('Internal server error');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(PASSWORD);
    await expect(page.getByLabel('Current password', { exact: true })).toBeEnabled();
  });
});

// ---- layout ----------------------------------------------------------------------------------------

test.describe('desktop and mobile layout', () => {
  const widths = [1280, 768, 375, 320];
  const pages = [
    ['login', '/login', false],
    ['accept invitation', `/accept-invite#token=${TOKEN}`, false],
    ['recovery', `/recover-passkey#token=${TOKEN}`, false],
    ['approvals', '/recovery', true],
  ];
  for (const width of widths) {
    for (const [label, url, authed] of pages) {
      test(`${label} at ${width}px: no horizontal scroll, controls reachable and tappable`, async ({ page, context }) => {
        await installMockApi(context, { authed });
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url);
        const button = page.getByRole('button', { name: /^(Sign in|Continue|Save password and continue)$/ }).first();
        await expect(button).toBeVisible();
        expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(40);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      });
    }
  }

  test('the approval decision panel fits a 320px screen', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/recovery');
    await page.getByLabel('Request reference').fill('12');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reject with passkey' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
