// @ts-check
// Phase H: the Dashboard's figures against the MOCKED API (tests/helpers/mockApi.js). The mock answers like the real
// GET /admin/requests?status=...&limit=1: one row and the FULL count in `total` (drafts only when asked for).
// The dashboard shows four request counts and no Cases figure: no existing API separates Cases created by approval from
// legacy Cases (the legacy flow also sets serviceRequestId), so it neither counts Cases nor borrows another figure.
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

test.describe('the four figures', () => {
  test('four are the real counts (drafts excluded); there is no Cases figure', async ({ page, context }) => {
    await open(page, context);
    await expect(card(page, 'Total Requests')).toContainText('6'); // 2 + 1 + 3; the draft is excluded
    await expect(card(page, 'Pending Submissions')).toContainText('2');
    await expect(card(page, 'Awaiting Patient Documents')).toContainText('1');
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(page.getByRole('list', { name: 'Dashboard statistics' }).getByRole('listitem')).toHaveCount(4);
    await expect(page.getByText('Operational Cases')).toHaveCount(0);
    await expect(page.getByText('Unavailable')).toHaveCount(0);
    await expect(page.getByTestId('stat-cases')).toHaveCount(0);
    // Nothing failed: no warning and no retry prompt.
    await expect(page.getByRole('status').filter({ hasText: 'could not be loaded' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('no Cases figure appears whatever Cases exist, and Approved is not borrowed for one', async ({ page, context }) => {
    const api = await open(page, context, { cases: [...cases, caseRow(4, { serviceRequestId: 42 }), caseRow(5, { serviceRequestId: 43 }), caseRow(6, { serviceRequestId: 44 })] });
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(page.getByText('Operational Cases')).toHaveCount(0);
    await expect(page.getByTestId('stat-cases')).toHaveCount(0);
    expect(caseCalls(api)).toHaveLength(0); // the Case list is not even requested
  });

  test('use the backend status names, one-row count pages and one latest-requests page, with no duplicate calls', async ({ page, context }) => {
    const api = await open(page, context);
    await expect(card(page, 'Approved Requests')).toContainText('3');
    await expect(page.getByRole('link', { name: 'REQ-1001' })).toBeVisible(); // the latest-requests load has finished too
    const calls = requestCalls(api);
    const counts = calls.filter((c) => c.query.limit === '1');
    expect(counts.map((c) => c.query.status).sort()).toEqual(['approved', 'changes_requested', 'in_review']); // only the server's total is used, never a partial list
    // The one other call is the small "latest open requests" page: the same filter as Incomplete Submissions, newest first.
    const lists = calls.filter((c) => c.query.limit !== '1');
    expect(lists).toHaveLength(1);
    expect(lists[0].query.status).toBe('in_review,changes_requested');
    expect(lists[0].query.limit).toBe('8');
    expect(calls).toHaveLength(4);
    expect(caseCalls(api)).toHaveLength(0);
  });

  test('zero is shown as 0 for the four counts, with a note when nothing exists', async ({ page, context }) => {
    await open(page, context, { requests: [], cases: [] });
    for (const name of ['Total Requests', 'Pending Submissions', 'Awaiting Patient Documents', 'Approved Requests']) {
      await expect(card(page, name).getByText('0', { exact: true })).toBeVisible();
    }
    await expect(page.getByText('No requests have been submitted yet.')).toBeVisible();
  });

  test('the cards still link to the pages that list them', async ({ page, context }) => {
    await open(page, context);
    await expect(card(page, 'Pending Submissions').getByRole('link')).toHaveAttribute('href', '/requests');
    await expect(card(page, 'Total Requests').getByRole('link')).toHaveAttribute('href', '/requests');
    await expect(card(page, 'Awaiting Patient Documents').getByRole('link')).toHaveAttribute('href', '/requests');
    await expect(card(page, 'Approved Requests').getByRole('link')).toHaveCount(0); // no list is dedicated to approved requests
    await card(page, 'Pending Submissions').getByRole('link').click();
    await expect(page).toHaveURL(/\/requests$/);
  });
});

test.describe('loading, errors and retry', () => {
  test('shows a busy state while loading', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests, cases });
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.fallback();
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('list', { name: 'Dashboard statistics' })).toHaveAttribute('aria-busy', 'true');
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
    // Two independent failures: the figures, and the latest-requests panel. Each has its own message and Try again.
    const figuresAlert = page.getByRole('alert').filter({ hasText: 'dashboard figures' });
    await expect(figuresAlert).toContainText('could not be loaded');
    await expect(page.getByText('Unavailable')).toHaveCount(4);
    await expect(page.getByTestId(/^stat-/)).toHaveCount(0);
    api.requestsStatus = 200;
    await figuresAlert.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, 'Total Requests')).toContainText('6');
    await expect(figuresAlert).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(1); // the panel's own error stays until it is retried
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('link', { name: 'REQ-1001' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Unavailable')).toHaveCount(0);
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

  test('Refresh loads the counts and the latest requests again, once each', async ({ page, context }) => {
    const api = await open(page, context);
    await expect(card(page, 'Pending Submissions')).toContainText('2');
    api.requests.push(req(8, 'in_review'));
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(card(page, 'Pending Submissions')).toContainText('3');
    await expect(page.getByRole('link', { name: 'REQ-1008' })).toBeVisible(); // the latest list reloaded too
    expect(requestCalls(api)).toHaveLength(8); // four calls per load: three counts and the latest page
    expect(requestCalls(api).filter((c) => c.query.limit === '1')).toHaveLength(6);
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
    test(`${width}px: four cards, no horizontal overflow`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, requests, cases });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dashboard');
      await expect(card(page, 'Approved Requests')).toContainText('3');
      await expect(page.getByRole('list', { name: 'Dashboard statistics' }).getByRole('listitem')).toHaveCount(4);
      await expect(page.getByRole('heading', { level: 2, name: 'Latest open requests' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'REQ-1001' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('latest open requests', () => {
  const panel = (page) => page.getByRole('region', { name: 'Latest open requests' });
  const LATEST = 'in_review,changes_requested';
  const rich = [
    { ...req(1, 'in_review'), urgency: 'urgent_24h', origin: 'Mumbai', destination: 'London', submittedAt: '2026-11-10T09:15:00.000Z', documents: { current: 2, awaitingScan: 0, scanFailed: 0, infected: 0, awaitingReview: 1, approved: 1, rejected: 0 } },
    { ...req(3, 'changes_requested'), documentsRequestReason: 'Passport scan unreadable', documents: { current: 1, awaitingScan: 0, scanFailed: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 1 } },
    req(4, 'approved'), // approved: not an open request
    req(7, 'awaiting_documents'), // a draft: not an open request
  ];

  test('lists the open requests only, with their status, documents and a link to each one', async ({ page, context }) => {
    await open(page, context, { requests: rich });
    const p = panel(page);
    await expect(p.getByRole('link', { name: 'REQ-1001' })).toHaveAttribute('href', '/requests/1');
    await expect(p.getByRole('link', { name: 'REQ-1003' })).toHaveAttribute('href', '/requests/3');
    await expect(p.getByRole('link', { name: 'REQ-1004' })).toHaveCount(0); // approved
    await expect(p.getByRole('link', { name: 'REQ-1007' })).toHaveCount(0); // draft
    const row = p.getByRole('row').filter({ hasText: 'REQ-1001' });
    await expect(row).toContainText('Patient 1');
    await expect(row).toContainText('Mumbai');
    await expect(row).toContainText('Urgent (24h)');
    await expect(row).toContainText('In review');
    await expect(row).toContainText('Awaiting review');
    await expect(p.getByRole('row').filter({ hasText: 'REQ-1003' })).toContainText('Changes requested');
    await expect(p.getByRole('row').filter({ hasText: 'REQ-1003' })).toContainText('Rejected, awaiting replacement');
    await expect(p.getByText('Showing the latest')).toHaveCount(0); // everything fits: no "N of M" note
  });

  test('says how many open requests are not shown, using the server total', async ({ page, context }) => {
    const many = Array.from({ length: 11 }, (_, i) => req(i + 1, i % 2 ? 'changes_requested' : 'in_review'));
    await open(page, context, { requests: many });
    const p = panel(page);
    await expect(p.getByRole('row')).toHaveCount(9); // header + the 8 newest
    await expect(p.getByText('Showing the latest 8 of 11 open requests.')).toBeVisible();
    await expect(p.getByRole('link', { name: 'See all 11' })).toHaveAttribute('href', '/requests');
  });

  test('View all and the row link navigate to the real pages', async ({ page, context }) => {
    await open(page, context, { requests: rich });
    await panel(page).getByRole('link', { name: /View all/ }).click();
    await expect(page).toHaveURL(/\/requests$/);
    await page.goBack();
    await panel(page).getByRole('link', { name: 'REQ-1001' }).click();
    await expect(page).toHaveURL(/\/requests\/1$/);
  });

  test('an empty result is a calm message, not an error', async ({ page, context }) => {
    await open(page, context, { requests: [req(4, 'approved')] });
    await expect(panel(page).getByText('No open requests')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('shows a loading state, then the rows', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests: rich, cases });
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      if (statusOf(route) === LATEST) await new Promise((r) => setTimeout(r, 700));
      await route.fallback();
    });
    await page.goto('/dashboard');
    await expect(panel(page).getByRole('status', { name: 'Loading latest requests' })).toBeVisible();
    await expect(card(page, 'Approved Requests')).toContainText('1'); // the figures do not wait for the list
    await expect(panel(page).getByRole('link', { name: 'REQ-1001' })).toBeVisible();
    await expect(panel(page).getByRole('status', { name: 'Loading latest requests' })).toHaveCount(0);
  });

  test('a failing list shows its own error and Try again, and leaves the figures alone', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests: rich, cases });
    let fail = true;
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      if (fail && statusOf(route) === LATEST) return route.fulfill({ status: 500, headers: CORS, body: JSON.stringify({ error: 'Internal server error' }) });
      return route.fallback();
    });
    await page.goto('/dashboard');
    await expect(panel(page).getByRole('alert')).toBeVisible();
    await expect(card(page, 'Total Requests')).toContainText('3');
    await expect(page.getByRole('alert')).toHaveCount(1); // only the panel's: the figures loaded fine
    await expect(page.getByRole('status').filter({ hasText: 'could not be loaded' })).toHaveCount(0);
    fail = false;
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByRole('link', { name: 'REQ-1001' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a 401 on the list returns to login through the existing session handling', async ({ page, context }) => {
    await installMockApi(context, { authed: true, requests: rich, cases });
    await context.route(`${API_ORIGIN}/admin/requests*`, async (route) => {
      if (statusOf(route) === LATEST) return route.fulfill({ status: 401, headers: CORS, body: JSON.stringify({ error: 'Token expired' }) });
      return route.fallback();
    });
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
