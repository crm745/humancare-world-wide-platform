// @ts-check
const { test, expect } = require('@playwright/test');
const { installMockApi, meCalls } = require('../helpers/mockApi');

const email = (page) => page.getByLabel('Email', { exact: true });
const password = (page) => page.getByLabel('Password', { exact: true });
const signIn = (page) => page.getByRole('button', { name: 'Sign in' });
const mainNav = (page) => page.getByRole('navigation', { name: 'Main navigation' }).first();

async function fillAndSubmit(page, e = 'admin@example.com', p = 'pw') {
  await email(page).fill(e);
  await password(page).fill(p);
  await signIn(page).click();
}

test.describe('login form', () => {
  test('validates empty and malformed input without calling the API', async ({ page, context }) => {
    const api = await installMockApi(context);
    await page.goto('/login');
    await expect(page).toHaveTitle(/Sign in/);

    await signIn(page).click();
    await expect(page.getByText('Enter your email address.')).toBeVisible();
    await expect(page.getByText('Enter your password.')).toBeVisible();
    await expect(email(page)).toBeFocused();

    await email(page).fill('not-an-email');
    await password(page).fill('x');
    await signIn(page).click();
    await expect(page.getByText(/valid email address/)).toBeVisible();
    await expect(email(page)).toHaveAttribute('aria-invalid', 'true');

    expect(api.calls.some((c) => c.path.startsWith('/admin/login'))).toBe(false);
  });

  test('shows the server message for 401 and 429, and recovers from a network failure', async ({ page, context }) => {
    const api = await installMockApi(context, { loginStatus: 401 });
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page.getByRole('alert')).toContainText('Invalid credentials');
    await expect(page).toHaveURL(/\/login$/);

    api.loginStatus = 429;
    api.loginError = 'Too many login attempts. Please try again in a few minutes.';
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('Too many login attempts');

    await context.route('http://localhost:4000/admin/login/password', (r) => r.abort('connectionrefused'));
    await signIn(page).click();
    await expect(page.getByRole('alert')).toContainText('Unable to reach the server');
    await expect(signIn(page)).toBeEnabled();
  });

  test('password can be shown and hidden', async ({ page, context }) => {
    await installMockApi(context);
    await page.goto('/login');
    await expect(password(page)).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password(page)).toHaveAttribute('type', 'text');
  });
});

test.describe('session lifecycle', () => {
  test('signed-out visit redirects to login; signing in returns to the requested page', async ({ page, context }) => {
    await installMockApi(context);
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toHaveCount(0);

    await fillAndSubmit(page);
    await expect(page).toHaveURL(/\/cases$/);
  });

  test('uses the cookie, keeps web storage empty and never exposes the response tokens', async ({ page, context }) => {
    const api = await installMockApi(context);
    // Stand-in for the server's Set-Cookie: proves the browser sends cookies to the API.
    await context.addCookies([{ name: 'hc_admin_token', value: 'fake-cookie', url: 'http://localhost/' }]);
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page).toHaveURL(/\/dashboard$/);

    const me = api.calls.filter((c) => c.path === '/admin/me').pop();
    expect(me?.cookie).toContain('hc_admin_token=fake-cookie');
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).toBe('{"local":{},"session":{}}');
    expect(await page.content()).not.toContain('SHOULD-NEVER-REACH-THE-PAGE');
  });

  test('top bar shows the name after login and the role (not a placeholder) after reload', async ({ page, context }) => {
    await installMockApi(context);
    await page.goto('/login');
    await fillAndSubmit(page);
    await expect(page.locator('header')).toContainText('Test Admin');
    await expect(page.locator('header')).toContainText('Superadmin');

    await page.reload();
    await expect(page.locator('header')).toContainText('Superadmin');
    await expect(page.locator('header')).not.toContainText('Signed in');
  });

  test('logout lands on a clean login and the next sign-in does not inherit the old page', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/cases');
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/admin/logout')).toBe(true);
    await expect(page.getByText('Your session expired')).toHaveCount(0);

    await fillAndSubmit(page, 'other@example.com');
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a 401 mid-session returns to login with a notice, then back to the same page', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

    api.authed = false;
    api.casesStatus = 401;
    // Goes through the app's real axios client and interceptor.
    await page.evaluate(async () => {
      const { http } = await import('/src/services/http.js');
      await http.get('/admin/cases').catch(() => {});
    });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toBeVisible();

    await fillAndSubmit(page);
    await expect(page).toHaveURL(/\/billing$/);
  });

  test('backend unreachable at start shows a clear message, and Try again recovers', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, meNetworkFail: true });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('alert')).toContainText('Unable to reach the server');

    api.meNetworkFail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('a plain 401 at start is a quiet sign-out, not a server error', async ({ page, context }) => {
    await installMockApi(context);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('shows a loading state while the session is checked', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await context.route('http://localhost:4000/admin/me', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.fallback();
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

test.describe('tab-focus session check', () => {
  const fireFocus = (page) =>
    page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

  test('does not re-check when focus returns quickly, and de-duplicates simultaneous events', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const before = meCalls(api);
    await fireFocus(page);
    await fireFocus(page);
    await page.waitForTimeout(300);
    expect(meCalls(api)).toBe(before);
  });

  test('re-checks after a while (once, even with focus + visibility together) and signs out on 401', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true });
    await page.clock.install();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const before = meCalls(api);

    await page.clock.fastForward('01:00');
    await fireFocus(page);
    await expect.poll(() => meCalls(api)).toBe(before + 1);
    await page.waitForTimeout(200);
    expect(meCalls(api)).toBe(before + 1);

    api.authed = false;
    await page.clock.fastForward('01:00');
    await fireFocus(page);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session expired')).toBeVisible();
  });

  test('picks up a role change without a new login', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, role: 'superadmin' });
    await page.clock.install();
    await page.goto('/dashboard');
    await expect(mainNav(page).getByRole('link', { name: 'Admins' })).toBeVisible();

    api.role = 'admin';
    await page.clock.fastForward('01:00');
    await fireFocus(page);
    await expect(mainNav(page).getByRole('link', { name: 'Admins' })).toHaveCount(0);
  });
});

test.describe('role-based navigation', () => {
  const cases = [
    // Nine items for every admin (Incomplete Submissions and Drafts are open to all), plus Partner
    // Applications with corporate review, plus Admins and Recovery (the Lock branch's) for a superadmin.
    { label: 'regular admin', state: { role: 'admin', corporateReview: false }, count: 9, blocked: ['/admins', '/registrations', '/recovery'] },
    { label: 'admin with corporate review', state: { role: 'admin', corporateReview: true }, count: 10, blocked: ['/admins', '/recovery'] },
    { label: 'superadmin', state: { role: 'superadmin' }, count: 12, blocked: [] },
  ];
  for (const { label, state, count, blocked } of cases) {
    test(`${label}: ${count} nav items; restricted pages show an access-denied state`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, ...state });
      await page.goto('/dashboard');
      await expect(mainNav(page).locator('a')).toHaveCount(count);
      for (const path of blocked) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/forbidden$/);
        await expect(page.getByRole('alert')).toContainText("You don't have access");
        await expect(page).toHaveTitle(/Access denied/);
      }
    });
  }

  test('forbidden page says what is needed', async ({ page, context }) => {
    await installMockApi(context, { authed: true, role: 'admin' });
    await page.goto('/admins');
    await expect(page.getByRole('alert')).toContainText('only available to superadmins');
    await page.goto('/registrations');
    await expect(page.getByRole('alert')).toContainText('corporate review access');
  });

  test('unknown URL shows not-found inside the app shell', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.goto('/nope');
    await expect(page.getByText('Page not found').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  });
});

test.describe('page titles', () => {
  test('each page sets its own document title', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.goto('/dashboard');
    await expect(page).toHaveTitle('Dashboard · HumanCare Admin');
    await mainNav(page).getByRole('link', { name: 'Cases' }).click();
    await expect(page).toHaveTitle('Cases · HumanCare Admin');
    await page.goto('/nope');
    await expect(page).toHaveTitle('Page not found · HumanCare Admin');
  });
});

test.describe('error boundary', () => {
  test('a failed page load shows a recoverable error inside the shell', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.route(/\/features\/cases\/pages\/CasesPage\.jsx/, (r) => r.abort());
    await mainNav(page).getByRole('link', { name: 'Cases' }).click();
    await expect(page.getByRole('alert')).toContainText('Something went wrong');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible(); // shell still works
    await expect(mainNav(page)).toBeVisible();

    // Another page still works without a reload.
    await mainNav(page).getByRole('link', { name: 'Billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

    await page.unroute(/\/features\/cases\/pages\/CasesPage\.jsx/);
    await mainNav(page).getByRole('link', { name: 'Cases' }).click();
    await page.getByRole('button', { name: 'Reload page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
  });
});

test.describe('responsive layout and mobile drawer', () => {
  for (const width of [1280, 1024, 768, 375, 320]) {
    test(`${width}px: no horizontal overflow and the right navigation pattern`, async ({ page, context }) => {
      await installMockApi(context, { authed: true });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (width >= 1024) await expect(menu).toBeHidden();
      else await expect(menu).toBeVisible();
    });
  }

  test('drawer: focus, Tab trap, Escape, scroll lock and focus return', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/dashboard');
    const menu = page.getByRole('button', { name: 'Open menu' });
    await menu.click();

    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');

    // Tab through more stops than the drawer has: focus must never leave it.
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(menu).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  });

  test('drawer: a link navigates and closes it; the backdrop and window growth close it too', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/dashboard');

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Billing' }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.mouse.click(360, 400); // backdrop, right of the 288px panel
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  });

  test('drawer header: the divider spans the full panel width', async ({ page, context }) => {
    await installMockApi(context, { authed: true });
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const panel = await page.getByRole('dialog').boundingBox();
    const bar = await page.getByRole('dialog').locator('div.border-b').first().boundingBox();
    expect(Math.round(bar.width)).toBe(Math.round(panel.width));
  });
});
