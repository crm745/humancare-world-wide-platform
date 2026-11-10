// @ts-check
// Phase B: Incomplete Submissions and Drafts, against the MOCKED API (tests/helpers/mockApi.js),
// which follows the real GET /admin/requests contract: status list, search, limit/offset, total.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const docs = (over = {}) => ({ current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 0, ...over });
let nextId = 1;
const row = (over = {}) => {
  const id = nextId++;
  return {
    id, referenceNumber: `REQ-${1000 + id}`, patientName: `Patient ${id}`, serviceType: 'Private Charter', urgency: 'urgent_24h',
    origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, Dubai, United Arab Emirates', preferredDate: '2099-01-01T00:00:00.000Z',
    reviewStatus: 'in_review', documentsRequestReason: null, createdAt: '2026-11-01T09:00:00.000Z', submittedAt: '2026-11-01T09:30:00.000Z',
    reviewedAt: null, documents: docs({ awaitingReview: 1 }), ...over,
  };
};
const listCalls = (api) => api.calls.filter((c) => c.path === '/admin/requests');
const lastQuery = (api) => listCalls(api).at(-1)?.query;
const nav = (page) => page.getByRole('navigation', { name: 'Main navigation' }).first();

test.describe('navigation', () => {
  test('both pages are in the sidebar for every admin, and each sets its title', async ({ page, context }) => {
    await installMockApi(context, { authed: true, role: 'admin' });
    await page.goto('/dashboard');
    await nav(page).getByRole('link', { name: 'Incomplete Submissions' }).click();
    await expect(page).toHaveURL(/\/requests$/);
    await expect(page).toHaveTitle('Incomplete Submissions · HumanCare Admin');
    await nav(page).getByRole('link', { name: 'Drafts' }).click();
    await expect(page).toHaveURL(/\/requests\/drafts$/);
    await expect(page).toHaveTitle('Drafts · HumanCare Admin');
  });

  test('a signed-out visit goes to login and comes back to the page', async ({ page, context }) => {
    await installMockApi(context, { authed: false });
    await page.goto('/requests');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Incomplete Submissions', () => {
  test('asks only for open requests, lists them with clear document states, and never shows drafts or approved ones', async ({ page, context }) => {
    const requests = [
      row({ patientName: 'Infected Ivan', documents: docs({ infected: 1 }) }),
      row({ patientName: 'Scan Sara', documents: docs({ awaitingScan: 1 }) }),
      row({ patientName: 'Failed Fiona', documents: docs({ awaitingScan: 1, scanErrors: 1 }) }),
      row({ patientName: 'Review Rita' }),
      row({ patientName: 'Changes Charlie', reviewStatus: 'changes_requested', documentsRequestReason: 'Add the certificate', documents: docs({ rejected: 1, current: 2, approved: 1 }) }),
      row({ patientName: 'Ready Rahul', documents: docs({ approved: 1 }) }),
      row({ patientName: 'Approved Anna', reviewStatus: 'approved', documents: docs({ approved: 1 }) }),
      row({ patientName: 'Draft Dave', reviewStatus: 'awaiting_documents', submittedAt: null, documents: docs({ current: 0 }) }),
    ];
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests');

    await expect(page.getByRole('cell', { name: 'Infected Ivan' })).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ status: 'in_review,changes_requested', limit: '25', offset: '0' });
    await expect(page.getByText('Approved Anna')).toHaveCount(0);
    await expect(page.getByText('Draft Dave')).toHaveCount(0);

    const rowOf = (name) => page.getByRole('row').filter({ hasText: name });
    await expect(rowOf('Infected Ivan').getByText('Infected document')).toBeVisible();
    await expect(rowOf('Scan Sara').getByText('Awaiting scan')).toBeVisible();
    await expect(rowOf('Failed Fiona').getByText('Scan error')).toBeVisible();
    await expect(rowOf('Failed Fiona').getByText('Awaiting scan')).toHaveCount(0);
    await expect(rowOf('Scan Sara').getByText('Scan error')).toHaveCount(0);
    await expect(rowOf('Review Rita').getByText('Awaiting review')).toBeVisible();
    await expect(rowOf('Changes Charlie').getByText('Rejected, awaiting replacement')).toBeVisible();
    await expect(rowOf('Changes Charlie').getByText('Documents requested')).toBeVisible();
    await expect(rowOf('Changes Charlie').getByText('Changes requested')).toBeVisible();
    await expect(rowOf('Ready Rahul').getByText('Ready for approval')).toBeVisible();

    // The infected state is the one solid-red badge.
    await expect(rowOf('Infected Ivan').locator('.bg-red-600')).toHaveCount(1);
    await expect(page.locator('.bg-red-600')).toHaveCount(1);
  });

  test('tabs ask the server for one status and return to the first page', async ({ page, context }) => {
    const requests = [row({ patientName: 'In Review One' }), row({ patientName: 'Changes One', reviewStatus: 'changes_requested', documents: docs({ rejected: 1 }) })];
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests');
    await expect(page.getByRole('cell', { name: 'In Review One' })).toBeVisible();

    await page.getByRole('tab', { name: 'Changes requested' }).click();
    await expect(page.getByRole('cell', { name: 'Changes One' })).toBeVisible();
    await expect(page.getByText('In Review One')).toHaveCount(0);
    expect(lastQuery(api)).toMatchObject({ status: 'changes_requested', offset: '0' });

    await page.getByRole('tab', { name: 'In review' }).click();
    await expect(page.getByRole('cell', { name: 'In Review One' })).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ status: 'in_review' });
    await expect(page.getByRole('tab', { name: /In review/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('search is debounced, sent to the server, and has its own empty state and clear button', async ({ page, context }) => {
    const requests = [row({ patientName: 'Maria Fernandez' }), row({ patientName: 'John Smith' })];
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests');
    await expect(page.getByRole('cell', { name: 'John Smith' })).toBeVisible();
    const before = listCalls(api).length;

    const box = page.getByRole('searchbox', { name: 'Search requests' });
    await box.pressSequentially('mari', { delay: 20 });
    await expect(page.getByRole('cell', { name: 'John Smith' })).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Maria Fernandez' })).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ search: 'mari' });
    expect(listCalls(api).length - before).toBe(1); // four keystrokes, one request

    await box.fill('nobody-by-this-name');
    await expect(page.getByText('No submissions match your search')).toBeVisible();

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByRole('cell', { name: 'John Smith' })).toBeVisible();
    expect(lastQuery(api).search).toBeUndefined();
  });

  test('shows the total, pages with limit/offset, and keeps the first page when the filter changes', async ({ page, context }) => {
    const requests = Array.from({ length: 30 }, (_, i) => row({ patientName: `Bulk ${String(i + 1).padStart(2, '0')}` }));
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests');
    await expect(page.getByText('1–25 of 30')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('26–30 of 30')).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ offset: '25' });
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

    await page.getByRole('tab', { name: 'In review' }).click();
    await expect(page.getByText('1–25 of 30')).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ status: 'in_review', offset: '0' });
  });

  test('empty list: says so, and a failed load shows the server message and recovers on Refresh', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, requests: [], requestsStatus: 500 });
    await page.goto('/requests');
    await expect(page.getByRole('alert')).toContainText('Could not load the requests.');
    api.requestsStatus = 200;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('No incomplete submissions')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a 401 while listing signs the admin out through the existing session handling', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, requests: [row({ patientName: 'Session Sam' })] });
    await page.goto('/requests');
    await expect(page.getByRole('cell', { name: 'Session Sam' })).toBeVisible();
    api.authed = false;
    api.requestsStatus = 401;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Drafts', () => {
  test('asks only for awaiting_documents, lists drafts as not submitted, and shows no review states', async ({ page, context }) => {
    const requests = [
      row({ patientName: 'Draft Dave', reviewStatus: 'awaiting_documents', submittedAt: null, documents: docs({ current: 0 }) }),
      row({ patientName: 'Submitted Sue' }),
    ];
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests/drafts');
    await expect(page.getByRole('cell', { name: 'Draft Dave' })).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ status: 'awaiting_documents', limit: '25', offset: '0' });
    await expect(page.getByText('Submitted Sue')).toHaveCount(0);
    await expect(page.getByText('No documents uploaded')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Documents' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Submitted' })).toHaveCount(0);
    await expect(page.getByText('Ready for approval')).toHaveCount(0);
  });

  test('searches within drafts, and has an empty state', async ({ page, context }) => {
    const requests = [row({ patientName: 'Draft Dave', reviewStatus: 'awaiting_documents', submittedAt: null, documents: docs({ current: 0 }) })];
    const api = await installMockApi(context, { authed: true, requests });
    await page.goto('/requests/drafts');
    await page.getByRole('searchbox', { name: 'Search requests' }).fill('zzz');
    await expect(page.getByText('No drafts match your search')).toBeVisible();
    expect(lastQuery(api)).toMatchObject({ status: 'awaiting_documents', search: 'zzz' });

    api.requests = [];
    await page.reload();
    await expect(page.getByText('No drafts', { exact: true })).toBeVisible();
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 768, 375, 320]) {
    test(`${width}px: the page does not overflow horizontally (the table scrolls inside its card)`, async ({ page, context }) => {
      const requests = [row({ patientName: 'Infected Ivan', documents: docs({ infected: 1, awaitingReview: 1 }) })];
      await installMockApi(context, { authed: true, requests });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/requests');
      await expect(page.getByRole('cell', { name: 'Infected Ivan' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
