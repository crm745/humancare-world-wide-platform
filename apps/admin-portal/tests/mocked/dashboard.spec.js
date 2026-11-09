// @ts-check
// Phase H: the Dashboard's figures against the MOCKED API (tests/helpers/mockApi.js). The mock answers like the real
// GET /admin/requests?status=...&limit=1: one row and the FULL count in `total` (drafts only when asked for).
// Operational Cases is always "Unavailable": no existing API separates Cases created by approval from legacy Cases
// (the legacy flow also sets serviceRequestId), so the dashboard neither counts Cases nor borrows another figure.
const { test, expect } = require('@playwright/test');
const { installMockApi, API_ORIGIN } = require('../helpers/mockApi');

const req = (id, reviewStatus) => ({ id, referenceNumber: `REQ-${1000 + id}`, patientName: `Patient ${id}`, serviceType: 'Private Charter', reviewStatus });
const requests = [
  req(1, 'in_review'), req(2, 'in_review'),
  req(3, 'changes_requested'),
  req(4, 'approved'), req(5, 'approved'), req(6, 'approved'),
  req(7, 'awaiting_documents'), // a draft: not submitted, not counted
];
const caseRow = (id, over = {}) => ({ id, referenceNumber: `CASE-${1000 + id}`, patientName: 'P', serviceType: 'Private Charter', origin: 'A', destination: 'B', status: 'submitted', createdAt: '2026-11-02T09:00:00.000Z', serviceRequestId: null, corporateId: null, ...over });
// Legacy-flow Cases also carry a serviceRequestId, and corporate Cases do not: neither may change any figure.
const cases = [caseRow(1, { serviceRequestId: 40 }), caseRow(2, { serviceRequestId: 41 }), caseRow(3, { corporateId: 2, corporate: { id: 2, companyName: 'Acme' } })];

const CORS = { 'access-control-allow-origin': 'http://localhost:3000', 'access-control-allow-credentials': 'true', 'content-type': 'application/json' };
const card = (page, name) => page.getByRole('list', { name: 'Dashboard statistics' }).getByRole('listitem', { name });
const open = async (page, context, initial = {}) => {
  const api = await installMockApi(context, { authed: true, requests, cases, ...initial });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  return api;
};
const requestCalls = (api) => api.calls.filter((c) => c.path === '/admin/requests');
const caseCalls = (api) => api.calls.filter((c) => c.path === '/admin/cases');
const statusOf = (route) => new URL(route.request().url()).searchParams.get('status');

test.describe('the five figures', () => {
  test('four are the real counts (drafts excluded); Operational Cases is unavailable', async ({ page, context }) => {
    await open(page, context);
    await expect(card(page, 'Total Requests')).toContainText('6'); // 2 + 1 + 3; the draft is excluded
    await expect(card(page, 'Pending Submissions')).toContainText('2');
    await expect(card(page, 'Awaiting Patient Documents')).toContainText('1');
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(card(page, 'Operational Cases')).toContainText('Unavailable');
    await expect(card(page, 'Operational Cases')).toContainText('no existing API separates Cases created by approval from legacy Cases');
    await expect(page.getByText('Unavailable')).toHaveCount(1);
    await expect(page.getByTestId('stat-cases')).toHaveCount(0);
    // Unavailable-by-design is not a failure: no warning and no retry prompt.
    await expect(page.getByRole('status').filter({ hasText: 'could not be loaded' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Operational Cases stays unavailable whatever Cases exist, and equals neither the Case count nor Approved', async ({ page, context }) => {
    const api = await open(page, context, { cases: [...cases, caseRow(4, { serviceRequestId: 42 }), caseRow(5, { serviceRequestId: 43 }), caseRow(6, { serviceRequestId: 44 })] });
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(card(page, 'Operational Cases')).toContainText('Unavailable');
    await expect(page.getByTestId('stat-cases')).toHaveCount(0);
    expect(caseCalls(api)).toHaveLength(0); // the Case list is not even requested
  });

  test('use the backend status names and one-row pages, with no duplicate calls', async ({ page, context }) => {
    const api = await open(page, context);
    await expect(card(page, 'Approved Requests')).toContainText('3');
    const calls = requestCalls(api);
    expect(calls.map((c) => c.query.status).sort()).toEqual(['approved', 'changes_requested', 'in_review']);
    for (const c of calls) expect(c.query.limit).toBe('1'); // only the server's total is used, never a partial list
    expect(caseCalls(api)).toHaveLength(0);
  });

  test('zero is shown as 0 for the four counts, with a note when nothing exists', async ({ page, context }) => {
    await open(page, context, { requests: [], cases: [] });
    for (const name of ['Total Requests', 'Pending Submissions', 'Awaiting Patient Documents', 'Approved Requests']) {
      await expect(card(page, name).getByText('0', { exact: true })).toBeVisible();
    }
    await expect(card(page, 'Operational Cases')).toContainText('Unavailable');
    await expect(page.getByText('No requests have been submitted yet.')).toBeVisible();
  });

  test('the cards still link to the pages that list them', async ({ page, context }) => {
    await open(page, context);
    await expect(card(page, 'Pending Submissions').getByRole('link')).toHaveAttribute('href', '/requests');
    await expect(card(page, 'Operational Cases').getByRole('link')).toHaveAttribute('href', '/cases');
    await card(page, 'Operational Cases').getByRole('link').click();
    await expect(page).toHaveURL(/\/cases$/);
  });
});

test.describe('loading, errors and retry', () => {
  test('shows a busy state while loading, and the unsupported card is not a skeleton', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests, cases });
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.fallback();
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('list', { name: 'Dashboard statistics' })).toHaveAttribute('aria-busy', 'true');
    await expect(card(page, 'Operational Cases')).toContainText('Unavailable');
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(page.getByRole('list', { name: 'Dashboard statistics' })).not.toHaveAttribute('aria-busy', 'true');
  });

  test('one failing count leaves the others correct and marks only its own figures unavailable; Try again recovers', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests, cases });
    let failApproved = true;
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      if (failApproved && statusOf(route) === 'approved') return route.fulfill({ status: 500, headers: CORS, body: JSON.stringify({ error: 'Internal server error' }) });
      return route.fallback();
    });
    await page.goto('/dashboard');
    await expect(card(page, 'Pending Submissions')).toContainText('2');
    await expect(card(page, 'Awaiting Patient Documents')).toContainText('1');
    await expect(card(page, 'Approved Requests')).toContainText('Unavailable');
    await expect(card(page, 'Total Requests')).toContainText('Unavailable'); // needs all three parts: never a partial sum
    await expect(page.getByRole('status').filter({ hasText: 'Some figures could not be loaded' })).toBeVisible();
    failApproved = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(card(page, 'Total Requests')).toContainText('6');
    await expect(page.getByRole('status').filter({ hasText: 'could not be loaded' })).toHaveCount(0);
  });

  test('every count failing shows an error, never zeros, and Try again recovers', async ({ page, context }) => {
    const api = await open(page, context, { requestsStatus: 500 });
    await expect(page.getByRole('alert')).toContainText('could not be loaded');
    await expect(page.getByText('Unavailable')).toHaveCount(5);
    await expect(page.getByTestId(/^stat-/)).toHaveCount(0);
    api.requestsStatus = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, 'Total Requests')).toContainText('6');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Unavailable')).toHaveCount(1);
  });

  test('a response without a usable total is shown as unavailable, not as 0', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests, cases });
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      if (statusOf(route) === 'in_review') return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ requests: [] }) });
      return route.fallback();
    });
    await page.goto('/dashboard');
    await expect(card(page, 'Pending Submissions')).toContainText('Unavailable');
    await expect(card(page, 'Total Requests')).toContainText('Unavailable');
    await expect(card(page, 'Approved Requests')).toContainText('3');
  });

  test('Refresh loads the three counts again, once each', async ({ page, context }) => {
    const api = await open(page, context);
    await expect(card(page, 'Pending Submissions')).toContainText('2');
    api.requests.push(req(8, 'in_review'));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(card(page, 'Pending Submissions')).toContainText('3');
    expect(requestCalls(api)).toHaveLength(6);
    expect(caseCalls(api)).toHaveLength(0);
  });

  test('a 401 returns to login through the existing session handling', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests, cases, requestsStatus: 401 });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 768, 375, 320]) {
    test(`${width}px: five cards, no horizontal overflow`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, requests, cases });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dashboard');
      await expect(card(page, 'Approved Requests')).toContainText('3');
      await expect(page.getByRole('list', { name: 'Dashboard statistics' }).getByRole('listitem')).toHaveCount(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
