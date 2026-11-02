// @ts-check
const { test, expect } = require('@playwright/test');

// Foundation smoke tests for the cookie-based session. Feature specs (cases, billing,
// registrations, ...) are ported from the pre-rebuild suite as each module is rebuilt;
// that suite is in Git history, e.g. `git show origin/main:apps/admin-portal/tests/billing.spec.js`.

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects a protected route to the login page', async ({ page }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
  });

  test('rejects a wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill('nobody@example.com');
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('signed in (cookie from global-setup)', () => {
  test('shows the app shell and keeps no token in web storage', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).first()).toBeVisible();
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage.local).toEqual({});
    expect(storage.session).toEqual({});
  });

  test('survives a reload, and log out ends the session', async ({ page }) => {
    await page.goto('/dashboard');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
  });
});
