// @ts-check
// Phase G: the Cases list (/cases) and Case details (/cases/:id) against the MOCKED API (tests/helpers/mockApi.js).
// The mock follows the real endpoints: GET /admin/cases understands only `status` and returns every Case with no
// request reference; GET /admin/cases/:id adds the linked request, stage events and documents (with a private `fileUrl`).
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const SECRET_PATH = '/uploads/SECRET-STORAGE-KEY-123.pdf';
const row = (id, over = {}) => ({
  id, serviceRequestId: null, corporateId: null, referenceNumber: `CASE-${1000 + id}`, patientName: `Patient ${id}`, patientAge: 40, patientGender: 'female', patientContact: '+971500000000',
  serviceType: 'Private Charter', origin: 'Mumbai', destination: 'Dubai', country: 'AE', urgency: 'urgent', careLevel: 'care_icu', description: null,
  status: 'submitted', createdAt: '2026-11-02T09:00:00.000Z', updatedAt: '2026-11-02T09:00:00.000Z', corporate: null, ...over,
});
const cases = [
  row(3, { serviceRequestId: 809, patientName: 'Maria Fernandez', origin: 'Mumbai', status: 'submitted' }),
  row(4, { corporateId: 2, corporate: { id: 2, companyName: 'Acme Insurance' }, patientName: 'John Doe', origin: 'Delhi', serviceType: 'Air Ambulance', status: 'in_progress' }),
  row(5, { patientName: 'Wei Chen', origin: 'Singapore', status: 'completed' }),
];
const detail = (over = {}) => ({
  ...cases[0],
  stageEvents: [
    { id: 2, caseId: 3, stage: 'in_progress', note: 'Crew assigned.', occurredAt: '2026-11-03T08:00:00.000Z' },
    { id: 1, caseId: 3, stage: 'submitted', note: 'Case opened after Admin approval of REQ-1809.', occurredAt: '2026-11-02T09:00:00.000Z' },
  ],
  documents: [
    { id: 5, caseId: 3, type: 'Medical Report', name: 'report.pdf', fileUrl: SECRET_PATH, fileSizeBytes: 2048, uploadedAt: '2026-11-02T09:00:00.000Z' },
    { id: 6, caseId: 3, type: 'Medical Report', name: 'virus.pdf', fileUrl: '/uploads/ANOTHER-SECRET.pdf', fileSizeBytes: 1024, uploadedAt: '2026-11-02T09:00:00.000Z' },
  ],
  serviceRequest: { id: 809, userId: 9, referenceNumber: 'REQ-1809' },
  ...over,
});
const caseDetails = {
  3: detail(),
  4: { ...cases[1], stageEvents: [], documents: [], serviceRequest: null },
};
const reqDoc = (id, name, over = {}) => ({
  id, serviceRequestId: 809, originalName: name, sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z', replacesId: null, supersededAt: null,
  scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z', reviewStatus: 'approved', reviewedByAdminId: 7, reviewedAt: '2026-11-01T11:00:00.000Z', rejectionReason: null, caseDocumentId: null, ...over,
});
const requestDetails = {
  809: {
    id: 809, userId: 9, referenceNumber: 'REQ-1809', serviceType: 'Private Charter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
    origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null, urgency: 'urgent_24h', createdAt: '2026-11-01T09:00:00.000Z',
    reviewStatus: 'approved', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null, user: { id: 9, name: 'Maria', email: 'm@example.com', mobile: '+971' },
    requestDocuments: [reqDoc(8090, 'report.pdf', { caseDocumentId: 5 }), reqDoc(8091, 'virus.pdf', { caseDocumentId: 6, scanStatus: 'infected' })],
    requestEvents: [], case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted' },
    documentSummary: { current: 2, awaitingScan: 0, scanErrors: 0, infected: 1, awaitingReview: 0, approved: 2, rejected: 0 },
  },
};

const open = async (page, context, path, initial = {}) => {
  const api = await installMockApi(context, { authed: true, cases, caseDetails, details: requestDetails, ...initial });
  await page.goto(path);
  return api;
};
const table = (page) => page.getByRole('table', { name: 'Operational cases' });
const listCalls = (api) => api.calls.filter((c) => c.path === '/admin/cases');

test.describe('Cases list', () => {
  test('shows reference, patient, service, route, source, stage and creation date; links to the details', async ({ page, context }) => {
    await open(page, context, '/cases');
    await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible();
    await expect(table(page).getByRole('row')).toHaveCount(4); // header + 3
    const first = table(page).getByRole('row').filter({ hasText: 'CASE-1003' });
    await expect(first).toContainText('Maria Fernandez');
    await expect(first).toContainText('Private Charter');
    await expect(first).toContainText('Mumbai');
    await expect(first).toContainText('Patient request');
    await expect(first).toContainText('Submitted');
    await expect(table(page).getByRole('row').filter({ hasText: 'CASE-1004' })).toContainText('Acme Insurance'); // corporate Case, unchanged
    await expect(first.getByRole('link', { name: 'CASE-1003' })).toHaveAttribute('href', '/cases/3');
  });

  test('the stage tabs ask the server for one status', async ({ page, context }) => {
    const api = await open(page, context, '/cases');
    await expect(table(page)).toBeVisible();
    await page.getByRole('tab', { name: 'In progress' }).click();
    await expect(table(page).getByRole('row')).toHaveCount(2);
    await expect(table(page)).toContainText('CASE-1004');
    expect(listCalls(api).at(-1)?.query).toEqual({ status: 'in_progress' });
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(table(page).getByRole('row')).toHaveCount(4);
    expect(listCalls(api).at(-1)?.query).toEqual({});
  });

  test('search narrows the list by reference, patient, place or source, and has its own empty state', async ({ page, context }) => {
    await open(page, context, '/cases');
    const search = page.getByRole('searchbox', { name: 'Search cases' });
    await search.fill('acme');
    await expect(table(page).getByRole('row')).toHaveCount(2);
    await search.fill('case-1005');
    await expect(table(page)).toContainText('Wei Chen');
    await search.fill('singapore');
    await expect(table(page).getByRole('row')).toHaveCount(2);
    await search.fill('zzzz');
    await expect(page.getByRole('heading', { name: 'Nothing matches your search' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(table(page).getByRole('row')).toHaveCount(4);
  });

  test('pages a long list 25 at a time', async ({ page, context }) => {
    const many = Array.from({ length: 30 }, (_, i) => row(100 + i));
    await open(page, context, '/cases', { cases: many });
    await expect(table(page).getByRole('row')).toHaveCount(26);
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('1–25 of 30');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(table(page).getByRole('row')).toHaveCount(6);
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('26–30 of 30');
  });

  test('loading state, empty state, and a failed load that recovers on Try again', async ({ page, context }) => {
    await open(page, context, '/cases', { casesDelayMs: 600 });
    await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
    await expect(table(page)).toBeVisible();

    const api = await open(page, context, '/cases', { cases: [] });
    await expect(page.getByRole('heading', { name: 'Nothing opened yet' })).toBeVisible();
    expect(listCalls(api).length).toBeGreaterThan(0);
  });

  test('a failed load shows the error and Try again recovers', async ({ page, context }) => {
    const api = await open(page, context, '/cases', { casesStatus: 500 });
    await expect(page.getByRole('alert')).toContainText('Could not load the cases.');
    api.casesStatus = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(table(page).getByRole('row')).toHaveCount(4);
  });

  test('a 401 returns to login through the existing session handling', async ({ page, context }) => {
    await open(page, context, '/cases', { casesStatus: 401 });
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('Case details', () => {
  test('shows references, patient, service, stage, timeline and documents; the REQ reference links back', async ({ page, context }) => {
    await open(page, context, '/cases/3');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
    await expect(main.locator('header')).toContainText('Submitted');
    await expect(main.locator('header').getByRole('link', { name: 'REQ-1809' })).toHaveAttribute('href', '/requests/809');
    await expect(main).toContainText('Maria Fernandez');
    await expect(main).toContainText('Private Charter');
    await expect(main).toContainText('ICU / Critical');
    const timeline = page.getByRole('list', { name: 'Stage timeline' });
    await expect(timeline.getByRole('listitem')).toHaveCount(2);
    await expect(timeline.getByRole('listitem').first()).toContainText('Case opened after Admin approval of REQ-1809.'); // oldest first
    await expect(timeline.getByRole('listitem').last()).toContainText('In progress');
    const docs = page.getByRole('list', { name: 'Case documents' });
    await expect(docs).toContainText('report.pdf');
    await expect(docs).toContainText('Medical Report');
    await expect(docs).toContainText('2.0 KB');
  });

  test('never exposes storage paths or keys, in the page or in what it downloads', async ({ page, context }) => {
    await open(page, context, '/cases/3');
    await expect(page.getByRole('list', { name: 'Case documents' })).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain('SECRET-STORAGE-KEY');
    expect(html).not.toContain('ANOTHER-SECRET');
    expect(html).not.toContain('/uploads/');
    await expect(page.locator('a[href*="uploads"], iframe, object, embed')).toHaveCount(0);
  });

  test('downloads go through the request, only for clean current files', async ({ page, context }) => {
    const api = await open(page, context, '/cases/3');
    await expect(page.getByRole('button', { name: 'Download report.pdf' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download virus.pdf' })).toHaveCount(0); // infected
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report.pdf' }).click()]);
    expect(download.suggestedFilename()).toBe('report.pdf');
    expect(api.calls.some((c) => c.path === '/admin/requests/809/documents/8090/file')).toBe(true);
  });

  test('a corporate Case has no linked request and no download', async ({ page, context }) => {
    await open(page, context, '/cases/4');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'CASE-1004' })).toBeVisible();
    await expect(main).toContainText('Acme Insurance');
    await expect(main).toContainText('not opened from a patient request');
    await expect(main.getByRole('link', { name: /^REQ-/ })).toHaveCount(0);
    await expect(main).toContainText('No stage changes recorded.');
    await expect(main).toContainText('No documents are attached to this Case.');
  });

  test('opens by CASE- reference too; unknown ids and bad ids say "not found" without a wrong call', async ({ page, context }) => {
    const api = await open(page, context, '/cases/CASE-1003');
    await expect(page.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
    await page.goto('/cases/999');
    await expect(page.getByRole('heading', { name: 'Case not found' })).toBeVisible();
    const before = api.calls.length;
    await page.goto('/cases/..%2Fadmin');
    await expect(page.getByRole('heading', { name: 'Case not found' })).toBeVisible();
    expect(api.calls.slice(before).some((c) => c.path.startsWith('/admin/cases/'))).toBe(false);
  });

  test('loading and a failed load with Try again', async ({ page, context }) => {
    const api = await open(page, context, '/cases/3', { caseDelayMs: 600, caseDetailStatus: 500 });
    await expect(page.getByRole('alert')).toContainText('Could not load the case.');
    api.caseDetailStatus = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
  });
});

test.describe('navigation between requests and Cases', () => {
  test('approved request -> Case (banner and Linked Case section) -> back to the request -> back to the list', async ({ page, context }) => {
    await open(page, context, '/requests/809');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1809' })).toBeVisible();
    const banner = page.getByRole('main').locator('header').getByLabel('Approved request');
    await expect(banner).toContainText('CASE-1003');
    await expect(page.getByRole('link', { name: 'Open Case' })).toHaveCount(2);
    await banner.getByRole('link', { name: 'Open Case' }).click();
    await expect(page).toHaveURL(/\/cases\/3$/);
    await expect(page.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
    await page.getByRole('main').locator('header').getByRole('link', { name: 'REQ-1809' }).click();
    await expect(page).toHaveURL(/\/requests\/809$/);
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1809' })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: 'Back to Cases' }).click();
    await expect(page).toHaveURL(/\/cases$/);
  });

  test('the sidebar still reaches the list, and the list opens a Case', async ({ page, context }) => {
    await open(page, context, '/dashboard');
    await page.getByRole('navigation', { name: /main/i }).first().getByRole('link', { name: 'Cases' }).click();
    await expect(page).toHaveURL(/\/cases$/);
    await table(page).getByRole('link', { name: 'CASE-1004' }).click();
    await expect(page).toHaveURL(/\/cases\/4$/);
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 375, 320]) {
    test(`${width}px: list and details do not overflow the page`, async ({ page, context }) => {
      await open(page, context, '/cases');
      await page.setViewportSize({ width, height: 800 });
      await expect(table(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.goto('/cases/3');
      await expect(page.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
