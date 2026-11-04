// @ts-check
// Real-browser validation of the Admin Lock System: the actual Admin Portal and backend, the
// dedicated humancare_test database, Chromium's virtual authenticator (real WebAuthn, user
// verification enabled), the local mail sink, passkey enforcement ON. See playwright.real.config.js.
//
// One serial story with its own @e2e.humancare.invalid accounts; no database wipe or reset.
const { test, expect } = require('@playwright/test');
const S = require('./support');

test.describe.configure({ mode: 'serial' });

/** @type {Record<string, any>} */
const accounts = {};
/** @type {Record<string, any>} */
const people = {};
const world = { requestIds: {}, evidence: {} };

// Clicks Log out and returns what the BACKEND answered: the portal ignores a failed logout call by
// design, so the page alone cannot prove the session ended.
const signOutOf = async (page) => {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/logout') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Log out' }).click(),
  ]);
  const headers = await response.allHeaders();
  if (response.status() !== 200) console.log(`LOGOUT RESPONSE ${response.status()} ${await response.text()} set-cookie=${JSON.stringify(headers['set-cookie'] || null)}`);
  expect(response.status(), 'the logout request must succeed').toBe(200);
  await expect(page).toHaveURL(/\/login$/);
  return { response, headers };
};

async function onboard(browser, { tag, name, role }) {
  const account = await S.provision({ tag, name, role });
  accounts[tag] = account;
  const person = await S.newPerson(browser, tag);
  people[tag] = person;
  const mail = await S.waitForMail(account.email, (m) => m.text.includes('/accept-invite#token='));
  const link = S.linkFrom(mail, '/accept-invite');
  account.invitationLink = link;
  await S.acceptInvitation(person.page, link);
  return { account, person };
}

test.beforeAll(async () => {
  await S.assertIsolatedDb('suite start');
  world.otherAdminsBefore = await S.db.countOtherAdmins();
});

test.afterAll(async () => {
  for (const person of Object.values(people)) await person.context.close().catch(() => {});
  const removed = await S.cleanupRun();
  const remaining = await S.db.countRunAdmins();
  const otherAfter = await S.db.countOtherAdmins();
  const summary = {
    database: S.isolationChecks.at(-1),
    isolationChecks: S.isolationChecks.length,
    distinctAnswers: [...new Set(S.isolationChecks.map((c) => `${c.database} / ${c.account}`))],
    cleanupRemoved: removed,
    runAccountsRemaining: remaining,
    otherAdminRowsBefore: world.otherAdminsBefore,
    otherAdminRowsAfter: otherAfter,
  };
  console.log(`\nE2E ISOLATION EVIDENCE ${JSON.stringify(summary, null, 2)}`);
  expect(remaining).toBe(0);
  expect(otherAfter).toBe(world.otherAdminsBefore); // rows that were not created by this run are untouched
});

// ---- environment ---------------------------------------------------------------------------------

test('00 the environment is the isolated test environment, with passkey enforcement ON', async ({ request }) => {
  const live = await S.assertIsolatedDb('environment');
  expect(live.database).toBe('humancare_test');
  expect(live.account).toMatch(/^humancare_test/);
  expect(S.testEnv.ADMIN_PASSKEY_ENFORCEMENT).toBe('true');
  expect(S.testEnv.UPLOAD_DIR).toBe('.e2e-uploads');
  expect(S.testEnv.SMTP_HOST).toBe('127.0.0.1');
  expect(S.API).not.toContain(':4000');
  expect((await request.get(`${S.API}/health`)).ok()).toBe(true);
  expect(await S.mailbox()).toEqual([]); // a fresh sink: nothing from any earlier run
});

// ---- 1-3: invitation acceptance, password setup, real passkey registration -----------------------------

test('01 onboard a superadmin: invitation email -> password -> real browser passkey', async ({ browser }) => {
  const { account, person } = await onboard(browser, { tag: 's1', name: 'E2E Super One', role: 'superadmin' });

  // Real WebAuthn in the page - not the mocked suite's stand-in.
  expect(await person.page.evaluate(() => typeof window.__webauthn)).toBe('undefined');
  expect(await person.page.evaluate(() => typeof window.PublicKeyCredential)).toBe('function');

  const credentials = await person.authenticator.credentials();
  expect(credentials).toHaveLength(1);
  expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' });

  const row = await S.db.admin(account.email);
  expect(row).toMatchObject({ status: 'active', role: 'superadmin' });
  expect(row.passwordHash).toBeTruthy(); // set by the person, never by us
  const passkeys = await S.db.passkeys(account.id);
  expect(passkeys.filter((p) => !p.revokedAt)).toHaveLength(1);
  expect(passkeys[0].label).toBe('E2E virtual key');
});

test('02 onboard a second superadmin, a target, a second target and a third superadmin', async ({ browser }) => {
  await onboard(browser, { tag: 's2', name: 'E2E Super Two', role: 'superadmin' });
  await onboard(browser, { tag: 't', name: 'E2E Target', role: 'admin' });
  await onboard(browser, { tag: 't2', name: 'E2E Target Two', role: 'admin' });
  await onboard(browser, { tag: 's3', name: 'E2E Super Three', role: 'superadmin' });
  for (const tag of ['s2', 't', 't2', 's3']) {
    expect((await S.db.admin(accounts[tag].email)).status).toBe('active');
    expect(await people[tag].authenticator.credentials()).toHaveLength(1);
  }
});

test('03 an invitation link is single use', async () => {
  const page = people.s1.page;
  await page.goto('/login'); // a full navigation: a fragment-only change on the same page would not reload the app
  await page.goto(accounts.s1.invitationLink);
  await expect(page.getByRole('heading', { name: 'Invitation not available' })).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
});

// ---- 4-5: password + passkey sign-in, protected routes -----------------------------------------------------

test('04 password and passkey sign-in for every account; the session lives only in HttpOnly cookies', async () => {
  for (const tag of ['s1', 's2', 't', 't2', 's3']) {
    const { page, context } = people[tag];
    await S.signIn(page, accounts[tag].email);
    const cookies = await S.sessionCookies(context);
    expect(cookies.map((c) => c.name).sort()).toEqual(['hc_admin_refresh', 'hc_admin_token']);
    cookies.forEach((c) => {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
    });
    expect(await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }))).toBe('{"l":{},"s":{},"c":""}');
    const sessions = await S.db.sessions(accounts[tag].id);
    expect(sessions.filter((s) => !s.revokedAt)).toHaveLength(1);
  }
  const top = await people.s1.page.locator('header').innerText();
  expect(top).toContain('E2E Super One');
});

test('05 a wrong password is refused and the passkey is never asked for', async ({ browser }) => {
  const person = await S.newPerson(browser, 'wrong-password');
  people.wrongPassword = person;
  const page = person.page;
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(accounts.t.email);
  await page.getByLabel('Password', { exact: true }).fill('Not-the-password-1');
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid credentials');
  await expect(page).toHaveURL(/\/login$/);
  expect(await S.sessionCookies(person.context)).toHaveLength(0);
});

test('06 user verification cannot be bypassed: an unverified authenticator signs nobody in', async () => {
  const { page, context, authenticator } = people.t2;
  await signOutOf(page);
  await authenticator.setUserVerified(false);
  await page.getByLabel('Email', { exact: true }).fill(accounts.t2.email);
  await page.getByLabel('Password', { exact: true }).fill(S.PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(await S.sessionCookies(context)).toHaveLength(0);

  await authenticator.setUserVerified(true);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('07 the password alone never makes a session, and the Origin and CSRF guards hold in the real stack', async ({ request }) => {
  // The old password-only route must not give anyone a session while passkey enforcement is on.
  await request.post(`${S.API}/admin/login`, { data: { email: accounts.s1.email, password: S.PASSWORD }, failOnStatusCode: false });
  expect((await request.get(`${S.API}/admin/me`, { failOnStatusCode: false })).status()).toBe(401);

  const ctx = people.s1.context.request;
  const foreign = await ctx.post(`${S.API}/admin/logout`, { headers: { Origin: 'http://evil.example', 'X-HC-Admin': '1' }, failOnStatusCode: false });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).code).toBe('origin_not_allowed');
  const noCsrf = await ctx.post(`${S.API}/admin/logout`, { headers: { Origin: S.PORTAL }, failOnStatusCode: false });
  expect(noCsrf.status()).toBe(403);
  expect((await noCsrf.json()).code).toBe('csrf_required');
  expect((await ctx.get(`${S.API}/admin/me`)).status()).toBe(200); // and S1 is still signed in
});

test('08 protected routes: signed-out visitors go to sign-in, a regular admin is refused, a superadmin gets in', async ({ browser }) => {
  const anonymous = await browser.newContext({ baseURL: S.PORTAL });
  const anonPage = await anonymous.newPage();
  for (const path of ['/dashboard', '/recovery', '/admins']) {
    await anonPage.goto(path);
    await expect(anonPage).toHaveURL(/\/login$/);
  }
  const anonApi = await anonymous.request.get(`${S.API}/admin/recovery/requests`, { failOnStatusCode: false });
  expect(anonApi.status()).toBe(401);
  await anonymous.close();

  const target = people.t;
  await target.page.goto('/recovery');
  await expect(target.page).toHaveURL(/\/forbidden$/);
  await expect(target.page.getByRole('navigation', { name: 'Main navigation' }).first().getByRole('link', { name: 'Recovery' })).toHaveCount(0);
  const asRegular = await target.context.request.get(`${S.API}/admin/recovery/requests`, { failOnStatusCode: false });
  expect(asRegular.status()).toBe(403);

  await people.s1.page.goto('/recovery');
  await expect(people.s1.page.getByRole('heading', { name: 'Recovery approvals' })).toBeVisible();
});

// ---- 6-7: recovery request and queue --------------------------------------------------------------------

test('09 an operator opens a recovery request (the real CLI); the target is told, without any link', async () => {
  const result = await S.runCli('admin-recovery.js', ['request', '--email', accounts.t.email, '--reason', 'E2E: lost the laptop holding my passkey']);
  expect(result.status, result.stderr).toBe(0);
  const request = await S.db.latestRequest(accounts.t.id);
  world.requestIds.t = request.id;
  expect(request).toMatchObject({ status: 'pending', approvalsRequired: 2, requestedVia: 'operator' });

  const mail = await S.waitForMail(accounts.t.email, (m) => /recovery was requested/i.test(m.subject));
  expect(mail.text).not.toMatch(/https?:|#token|password/i);
  expect(mail.html).not.toMatch(/href|#token/i);
});

test('10 the queue shows the request to both superadmins - target, reason and approval count - and not to the target', async () => {
  const id = world.requestIds.t;
  for (const tag of ['s1', 's2']) {
    const page = people[tag].page;
    await page.goto('/recovery');
    const card = page.getByRole('article', { name: `Recovery request ${id}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('E2E Target');
    await expect(card).toContainText(accounts.t.email);
    await expect(card).toContainText('E2E: lost the laptop holding my passkey');
    await expect(card).toContainText('0 of 2');
  }
  const apiAsTarget = await people.t.context.request.get(`${S.API}/admin/recovery/requests`, { failOnStatusCode: false });
  expect(apiAsTarget.status()).toBe(403);
});

// ---- 8-9: two distinct approvals ------------------------------------------------------------------------------

test('11 the first superadmin approves with a real passkey step-up; nothing is sent yet', async () => {
  const id = world.requestIds.t;
  const page = people.s1.page;
  await page.goto('/recovery');
  await page.getByRole('article', { name: `Recovery request ${id}` }).getByRole('button', { name: 'Review and approve' }).click();
  await expect(page.getByRole('region', { name: 'Decision' })).toContainText('E2E Target');
  await page.getByLabel('Note (optional)').fill('E2E: confirmed by phone');
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await expect(page.getByText('Your approval is recorded (1 of 2 needed)')).toBeVisible();

  const request = await S.db.request(id);
  expect(request.status).toBe('pending');
  const approvals = await S.db.approvals(id);
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({ approverId: accounts.s1.id, decision: 'approved', approverRole: 'superadmin' });
  expect(await S.db.invitations(id)).toHaveLength(0);
  const toTarget = (await S.mailbox()).filter((m) => m.to.includes(accounts.t.email) && /recovery link/i.test(m.subject));
  expect(toTarget).toHaveLength(0);

  // S1 has decided: the request no longer appears for S1, but still does for S2
  await expect(page.getByRole('article', { name: `Recovery request ${id}` })).toHaveCount(0);
  await people.s2.page.goto('/recovery');
  await expect(people.s2.page.getByRole('article', { name: `Recovery request ${id}` })).toContainText('1 of 2');
});

test('12 a second, distinct superadmin approves; the recovery invitation is created and emailed once', async () => {
  const id = world.requestIds.t;
  const page = people.s2.page;
  await page.getByRole('article', { name: `Recovery request ${id}` }).getByRole('button', { name: 'Review and approve' }).click();
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await expect(page.getByText('final one needed')).toBeVisible();

  const request = await S.db.request(id);
  expect(request.status).toBe('approved');
  expect((await S.db.approvals(id)).map((a) => a.approverId).sort()).toEqual([accounts.s1.id, accounts.s2.id].sort());
  const invitations = await S.db.invitations(id);
  expect(invitations).toHaveLength(1);
  expect(invitations[0]).toMatchObject({ purpose: 'passkey_recovery', adminId: accounts.t.id, usedAt: null, revokedAt: null });
  expect(invitations[0].expiresAt.getTime()).toBeLessThanOrEqual(request.expiresAt.getTime());

  const mail = await S.waitForMail(accounts.t.email, (m) => m.text.includes('/recover-passkey#token='));
  const link = S.linkFrom(mail, '/recover-passkey');
  world.recoveryLink = link;
  const token = S.tokenOf(link);
  // only the hash is stored, and the raw token is nowhere in the database or the audit trail
  expect(invitations[0].tokenHash).toBe(S.hashToken(token));
  expect(invitations[0].tokenHash).not.toContain(token);
  const ids = Object.values(accounts).map((a) => a.id);
  expect(await S.db.auditText(ids)).not.toContain(token);
  expect((await S.mailbox()).filter((m) => m.to.includes(accounts.t.email) && m.text.includes('#token=') && /recovery/i.test(m.subject))).toHaveLength(1);
});

// ---- 10-14: recovery by the target on a new device ----------------------------------------------------------------

test('13 the target redeems the link with the CURRENT password and registers a new passkey; no session is created', async ({ browser }) => {
  const id = world.requestIds.t;
  const before = await S.db.sessions(accounts.t.id);
  expect(before.filter((s) => !s.revokedAt).length).toBeGreaterThan(0);
  world.sessionsBeforeRecovery = before.length;

  const device = await S.newPerson(browser, 't-new-device');
  people.tNew = device;
  const page = device.page;
  await page.goto(world.recoveryLink);
  await expect(page.getByRole('heading', { name: 'Recover your passkey' })).toBeVisible();
  expect(page.url()).not.toContain('#'); // the one-time token left the address bar

  await page.getByLabel('Current password', { exact: true }).fill('Not-the-password-1');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText("didn't work");
  expect((await S.db.invitations(id))[0].usedAt).toBeNull(); // a wrong password burns nothing but an attempt

  await page.getByLabel('Current password', { exact: true }).fill(S.PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your new passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Passkey recovered' })).toBeVisible();
  await expect(page.getByText('signed out everywhere')).toBeVisible();

  expect(await device.authenticator.credentials()).toHaveLength(1);
  expect(await S.sessionCookies(device.context)).toHaveLength(0);
  expect(await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }))).toBe('{"l":{},"s":{},"c":""}');
  expect(page.url()).not.toContain(S.tokenOf(world.recoveryLink));

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/); // recovery did not sign anyone in
});

test('14 in the database: old passkey and every old session and refresh token revoked, request completed, nothing new created', async () => {
  const id = world.requestIds.t;
  const request = await S.db.request(id);
  expect(request.status).toBe('completed');
  expect(request.completedAt).toBeTruthy();
  expect((await S.db.invitations(id))[0].usedAt).toBeTruthy();

  const passkeys = await S.db.passkeys(accounts.t.id);
  const live = passkeys.filter((p) => !p.revokedAt);
  const revoked = passkeys.filter((p) => p.revokedAt);
  expect(live).toHaveLength(1);
  expect(revoked).toHaveLength(1);
  expect(revoked[0].revokedReason).toBe('recovery');

  const sessions = await S.db.sessions(accounts.t.id);
  expect(sessions).toHaveLength(world.sessionsBeforeRecovery); // recovery created no session
  expect(sessions.every((s) => s.revokedAt && s.revokedReason === 'passkey_recovery')).toBe(true);
  const tokens = await S.db.refreshTokens(sessions.map((s) => s.id));
  expect(tokens.length).toBeGreaterThan(0);
  expect(tokens.every((t) => t.revokedAt)).toBe(true);

  // other people's sessions were left alone
  for (const tag of ['s1', 's2', 's3', 't2']) {
    expect((await S.db.sessions(accounts[tag].id)).some((s) => !s.revokedAt)).toBe(true);
  }
});

test('15 the old device is signed out and its old passkey no longer works', async () => {
  const { page, context } = people.t;
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  const api = await context.request.get(`${S.API}/admin/me`, { failOnStatusCode: false });
  expect(api.status()).toBe(401);

  // password is right, but the only passkey this device holds was revoked
  await page.getByLabel('Email', { exact: true }).fill(accounts.t.email);
  await page.getByLabel('Password', { exact: true }).fill(S.PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 150_000 });
  await expect(page).toHaveURL(/\/login$/);
  expect(await S.sessionCookies(context)).toHaveLength(0);
});

test('16 the new passkey signs the target in (only now is a session created)', async () => {
  const { page } = people.tNew;
  await S.signIn(page, accounts.t.email);
  const sessions = await S.db.sessions(accounts.t.id);
  expect(sessions).toHaveLength(world.sessionsBeforeRecovery + 1);
  expect(sessions.filter((s) => !s.revokedAt)).toHaveLength(1);
  const credentials = await people.tNew.authenticator.credentials();
  expect(credentials[0].signCount).toBeGreaterThan(0);
});

test('17 logout ends the session for good: cookies replayed against the API are refused', async ({ request }) => {
  const { page, context } = people.tNew;
  const jar = await S.sessionCookies(context);
  const access = jar.find((c) => c.name === 'hc_admin_token');
  const refresh = jar.find((c) => c.name === 'hc_admin_refresh');
  expect(access && refresh).toBeTruthy();
  await signOutOf(page);
  expect(await S.sessionCookies(context)).toHaveLength(0);

  const live = (await S.db.sessions(accounts.t.id)).filter((s) => !s.revokedAt);
  expect(live).toHaveLength(0);
  const replayAccess = await request.get(`${S.API}/admin/me`, { headers: { Cookie: `hc_admin_token=${access.value}` }, failOnStatusCode: false });
  expect(replayAccess.status()).toBe(401);
  const replayRefresh = await request.post(`${S.API}/admin/refresh`, { headers: { Origin: S.PORTAL, 'X-HC-Admin': '1', Cookie: `hc_admin_refresh=${refresh.value}` }, failOnStatusCode: false });
  expect(replayRefresh.status()).toBe(401);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

// ---- 17: rejection with a reason ---------------------------------------------------------------------------------

test('18 a superadmin rejects a recovery request with a reason; the target keeps their passkey and is told', async () => {
  const result = await S.runCli('admin-recovery.js', ['request', '--email', accounts.t2.email, '--reason', 'E2E: second request to be rejected']);
  expect(result.status, result.stderr).toBe(0);
  const request = await S.db.latestRequest(accounts.t2.id);
  world.requestIds.t2 = request.id;
  const id = request.id;

  const page = people.s1.page;
  await page.goto('/recovery');
  const card = page.getByRole('article', { name: `Recovery request ${id}` });
  await expect(card).toContainText('E2E Target Two');
  await card.getByRole('button', { name: 'Review and reject' }).click();
  await page.getByRole('button', { name: 'Reject with passkey' }).click();
  await expect(page.getByText('Give a reason for rejecting')).toBeVisible();
  expect(await S.db.approvals(id)).toHaveLength(0); // nothing was sent without a reason

  await page.getByLabel('Reason (required)').fill('E2E: nobody asked for this');
  await page.getByRole('button', { name: 'Reject with passkey' }).click();
  await expect(page.getByText('The request was rejected')).toBeVisible();

  expect((await S.db.request(id)).status).toBe('rejected');
  const approvals = await S.db.approvals(id);
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({ approverId: accounts.s1.id, decision: 'rejected', reason: 'E2E: nobody asked for this' });
  expect(await S.db.invitations(id)).toHaveLength(0); // a rejection never issues a link
  const mail = await S.waitForMail(accounts.t2.email, (m) => /was rejected/i.test(m.subject));
  expect(mail.text).not.toMatch(/#token/);

  // S2 can no longer act on it
  await people.s2.page.goto('/recovery');
  await expect(people.s2.page.getByRole('article', { name: `Recovery request ${id}` })).toHaveCount(0);

  // the target's passkey is untouched: sign out and in again with the ORIGINAL authenticator
  const t2 = people.t2.page;
  await t2.goto('/dashboard');
  await signOutOf(t2);
  await S.signIn(t2, accounts.t2.email);
  expect((await S.db.passkeys(accounts.t2.id)).filter((p) => !p.revokedAt)).toHaveLength(1);
});

// ---- self-approval ------------------------------------------------------------------------------------------------

test('19 a superadmin who is the target cannot see or decide on their own recovery', async () => {
  const result = await S.runCli('admin-recovery.js', ['request', '--email', accounts.s3.email, '--reason', 'E2E: superadmin recovery']);
  expect(result.status, result.stderr).toBe(0);
  const request = await S.db.latestRequest(accounts.s3.id);
  const id = request.id;

  const own = people.s3.page;
  await own.goto('/recovery');
  await expect(own.getByRole('article', { name: `Recovery request ${id}` })).toHaveCount(0);
  await own.getByLabel('Request reference').fill(String(id));
  await own.getByRole('button', { name: 'Continue' }).click();
  await own.getByRole('button', { name: 'Approve', exact: true }).click();
  await own.getByRole('button', { name: 'Approve with passkey' }).click();
  await expect(own.getByRole('alert')).toContainText("isn't available to you");
  await own.getByRole('button', { name: 'Change' }).click();
  await own.getByLabel('Request reference').fill(String(id));
  await own.getByRole('button', { name: 'Continue' }).click();
  await own.getByRole('button', { name: 'Reject', exact: true }).click();
  await own.getByLabel('Reason (required)').fill('E2E: trying to reject my own recovery');
  await own.getByRole('button', { name: 'Reject with passkey' }).click();
  await expect(own.getByRole('alert')).toContainText("isn't available to you");
  expect(await S.db.approvals(id)).toHaveLength(0);
  expect((await S.db.request(id)).status).toBe('pending');

  // another superadmin does see it
  await people.s1.page.goto('/recovery');
  await expect(people.s1.page.getByRole('article', { name: `Recovery request ${id}` })).toContainText('E2E Super Three');

  // the operator withdraws it (the real CLI), which leaves nothing open
  const cancelled = await S.runCli('admin-recovery.js', ['cancel', '--id', String(id), '--reason', 'E2E: finished']);
  expect(cancelled.status, cancelled.stderr).toBe(0);
  expect((await S.db.request(id)).status).toBe('cancelled');
});

// ---- mail ---------------------------------------------------------------------------------------------------------

test('20 every email of the run went to the local sink, to a test address only', async () => {
  const messages = await S.mailbox();
  expect(messages.length).toBeGreaterThanOrEqual(10);
  for (const m of messages) {
    expect(m.to.every((a) => /@e2e\.humancare\.invalid$/.test(a))).toBe(true);
    expect(m.to.every((a) => S.RUN_EMAIL.test(a))).toBe(true);
  }
  const withLinks = messages.filter((m) => m.text.includes('#token='));
  expect(withLinks.length).toBeGreaterThan(0);
  console.log(`\nE2E MAIL EVIDENCE ${JSON.stringify({ total: messages.length, withOneTimeLinks: withLinks.length, subjects: [...new Set(messages.map((m) => m.subject))] }, null, 2)}`);
});
