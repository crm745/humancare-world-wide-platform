// @ts-check
// Phase F: "Approve request" on the details page, against the MOCKED API (tests/helpers/mockApi.js), whose
// POST .../approve follows the real server: 404, already approved (200 + existing Case), blockers (409
// approval_blocked), otherwise 201 with a new CASE-... and the request becomes approved. Nothing here touches a real backend.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const doc = (id, requestId, name, over = {}) => ({
  id, serviceRequestId: requestId, originalName: name, sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z',
  reviewStatus: 'approved', reviewedByAdminId: 7, reviewedAt: '2026-11-01T11:00:00.000Z', rejectionReason: null, caseDocumentId: null, ...over,
});
const ready = { current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 1, rejected: 0 };
const base = (id, over = {}) => ({
  id, userId: 9, referenceNumber: `REQ-${1000 + id}`, serviceType: 'Private Charter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
  origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null, urgency: 'urgent_24h',
  createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'in_review', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null,
  user: { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: '+971501234567' },
  requestDocuments: [doc(id * 10, id, 'report.pdf')], requestEvents: [], case: null, documentSummary: ready, ...over,
});
const pendingDoc = (id) => doc(id * 10, id, 'report.pdf', { reviewStatus: 'pending', reviewedAt: null, reviewedByAdminId: null });
const details = {
  801: base(801), // ready
  802: base(802, { requestDocuments: [pendingDoc(802)], documentSummary: { ...ready, awaitingReview: 1, approved: 0 } }),
  803: base(803, { requestDocuments: [doc(8030, 803, 'report.pdf', { scanStatus: 'pending', scannedAt: null, reviewStatus: 'pending' })], documentSummary: { ...ready, awaitingScan: 1, approved: 0 } }),
  804: base(804, { requestDocuments: [doc(8040, 804, 'virus.pdf', { scanStatus: 'infected', reviewStatus: 'pending' })], documentSummary: { ...ready, infected: 1, approved: 0 } }),
  805: base(805, { requestDocuments: [doc(8050, 805, 'broken.pdf', { scanStatus: 'error', reviewStatus: 'pending' })], documentSummary: { ...ready, awaitingScan: 1, scanErrors: 1, approved: 0 } }),
  806: base(806, { requestDocuments: [doc(8060, 806, 'blurry.pdf', { reviewStatus: 'rejected', rejectionReason: 'Too blurry.' })], documentSummary: { ...ready, rejected: 1, approved: 0 }, reviewStatus: 'changes_requested' }),
  807: base(807, { reviewStatus: 'changes_requested', documentsRequestReason: 'Please add the certificate.' }), // awaiting patient response
  808: base(808, { reviewStatus: 'awaiting_documents', submittedAt: null, requestDocuments: [], documentSummary: { ...ready, current: 0, approved: 0 } }), // draft
  809: base(809, { reviewStatus: 'approved', case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted' } }),
  // A scan that can never succeed (the stored file is gone): the worker marks it "failed", and it blocks approval until replaced.
  810: base(810, { requestDocuments: [doc(8100, 810, 'gone.pdf', { scanStatus: 'failed', scanDetail: 'the stored file is missing', reviewStatus: 'pending', reviewedAt: null, reviewedByAdminId: null })], documentSummary: { ...ready, scanFailed: 1, approved: 0 } }),
};

const approveBtn = (page) => page.getByRole('button', { name: 'Approve request' });
const dialog = (page) => page.getByRole('dialog');
const confirm = (page) => dialog(page).getByRole('button', { name: 'Approve and create Case' });
const header = (page) => page.getByRole('main').locator('header');
const detailCalls = (api) => api.calls.filter((c) => /^\/admin\/requests\/\d+$/.test(c.path));
const open = async (page, context, initial = {}, id = 801) => {
  const api = await installMockApi(context, { authed: true, details, ...initial });
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
};

test.describe('eligibility', () => {
  test('ready: every current document clean and approved enables the button, with no blockers shown', async ({ page, context }) => {
    await open(page, context);
    await expect(approveBtn(page)).toBeEnabled();
    await expect(page.getByLabel('Approval blockers')).toHaveCount(0);
  });

  const blocked = [
    [802, /waiting for your review/],
    [803, /not been scanned yet/],
    [804, /failed the virus scan/],
    [805, /could not be scanned/],
    [806, /rejected and not replaced/],
    [807, /Additional documents were requested/],
  ];
  for (const [id, reason] of blocked) {
    test(`request ${id}: approval is disabled and the reason is shown`, async ({ page, context }) => {
      const api = await open(page, context, {}, id);
      await expect(approveBtn(page)).toBeDisabled();
      await expect(page.getByLabel('Approval blockers')).toContainText(reason);
      expect(api.approvals).toHaveLength(0);
    });
  }

  test('a document whose scan failed for good: badge, explanation, no document actions, and approval is blocked with a reason', async ({ page, context }) => {
    const api = await open(page, context, {}, 810);
    await expect(header(page).getByLabel('Document status')).toContainText('Scan failed, needs a replacement');
    await expect(approveBtn(page)).toBeDisabled();
    await expect(page.getByLabel('Approval blockers')).toContainText('can never be scanned');
    await expect(page.getByLabel('Approval blockers')).toContainText('upload a replacement');
    const card = page.getByRole('list', { name: 'Document history' }).getByRole('listitem');
    await expect(card).toContainText('Scan failed');
    await expect(card).toContainText('can never be scanned (it is missing or was altered)');
    await expect(card).toContainText('the stored file is missing');
    await expect(card).toHaveAttribute('data-severity', 'scan_failed');
    await expect(page.getByRole('list', { name: 'Document history' }).getByRole('button')).toHaveCount(0); // no download, approve or reject on the file
    expect(api.approvals).toHaveLength(0);
  });

  test('a draft offers no approval; an approved request offers none and hides the other review actions', async ({ page, context }) => {
    await open(page, context, {}, 808);
    await expect(approveBtn(page)).toHaveCount(0);
    await page.goto('/requests/809');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1809' })).toBeVisible();
    await expect(approveBtn(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /additional documents/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Approve|Reject) / })).toHaveCount(0);
  });
});

test.describe('confirming', () => {
  test('the dialog explains that a Case is created; Cancel sends nothing', async ({ page, context }) => {
    const api = await open(page, context);
    await approveBtn(page).click();
    await expect(dialog(page)).toContainText('creates an operational Case');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(api.approvals).toHaveLength(0);
  });

  test('success: refetches, shows the new CASE- reference prominently, status Approved, actions gone', async ({ page, context }) => {
    const api = await open(page, context);
    const before = detailCalls(api).length;
    await approveBtn(page).click();
    await confirm(page).click();

    await expect(page.getByRole('status').filter({ hasText: 'Case CASE-1050 was created.' })).toBeVisible();
    expect(api.approvals).toEqual([801]);
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page).getByText('Approved', { exact: true })).toBeVisible();
    await expect(header(page).getByLabel('Approved request')).toContainText('CASE-1050');
    await expect(page.getByRole('list', { name: 'Request timeline' })).toContainText('CASE-1050');
    await expect(approveBtn(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /additional documents/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Approve|Reject) / })).toHaveCount(0);
    // Phase G: the Case page exists, so the reference is linked from the banner and from the Linked Case section.
    await expect(header(page).getByRole('link', { name: 'Open Case' })).toHaveAttribute('href', '/cases/50');
    await expect(page.getByRole('link', { name: 'Open Case' })).toHaveCount(2);
  });
});

test.describe('in-flight guard', () => {
  test('a double click approves once, and the dialog cannot be dismissed while saving', async ({ page, context }) => {
    const api = await open(page, context, { approveDelayMs: 700 });
    await approveBtn(page).click();
    await confirm(page).dblclick();
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0, { timeout: 10000 });
    expect(api.approvals).toHaveLength(1);
  });
});

test.describe('errors', () => {
  test('400 keeps the dialog open with the message, and can be retried', async ({ page, context }) => {
    const api = await open(page, context, { approveResponses: { 801: { status: 400, body: { error: 'The request id is invalid.' } } } });
    await approveBtn(page).click();
    await confirm(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('The request id is invalid.');
    delete api.approveResponses[801];
    await confirm(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page).getByLabel('Approved request')).toBeVisible();
    expect(api.approvals).toHaveLength(2);
  });

  test('409 approval_blocked: documents changed meanwhile; the blockers are listed and the page refreshed', async ({ page, context }) => {
    const api = await open(page, context);
    // After the page loaded, a new document was added that still needs a review.
    api.details[801].requestDocuments.push(pendingDoc(801));
    api.details[801].requestDocuments[1].id = 8011;
    api.details[801].requestDocuments[1].originalName = 'extra.pdf';
    await expect(approveBtn(page)).toBeEnabled(); // the page still shows the old state
    await approveBtn(page).click();
    await confirm(page).click();
    const notice = page.getByRole('status').filter({ hasText: 'This request cannot be approved yet.' });
    await expect(notice).toContainText('"extra.pdf" is waiting for review.');
    await expect(notice).toContainText('The page has been refreshed with the current state.');
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page).getByText('In review', { exact: true })).toBeVisible();
    expect(api.approvals).toHaveLength(1);
  });

  test('404: explained, dialog closes and the page is refreshed', async ({ page, context }) => {
    const api = await open(page, context, { approveResponses: { 801: { status: 404, body: { error: 'Request not found' } } } });
    const before = detailCalls(api).length;
    await approveBtn(page).click();
    await confirm(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Request not found' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
  });

  test('another Admin approved first: the server answers 200 with the existing Case, and no second Case appears', async ({ page, context }) => {
    const api = await open(page, context);
    Object.assign(api.details[801], { reviewStatus: 'approved', case: { id: 7, referenceNumber: 'CASE-1007', status: 'submitted' } });
    await approveBtn(page).click();
    await confirm(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'already approved. Its Case is CASE-1007' })).toBeVisible();
    await expect(header(page).getByLabel('Approved request')).toContainText('CASE-1007');
    expect(api.details[801].case.id).toBe(7);
  });

  test('401 returns to login through the existing session handling', async ({ page, context }) => {
    const api = await open(page, context, { approveResponses: { 801: { status: 401, body: { error: 'Token expired' } } } });
    await approveBtn(page).click();
    api.authed = false;
    await confirm(page).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('500 keeps the dialog open and never reports success', async ({ page, context }) => {
    await open(page, context, { approveResponses: { 801: { status: 500, body: { error: 'Internal server error' } } } });
    await approveBtn(page).click();
    await confirm(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('Internal server error');
    await expect(page.getByText('was created.')).toHaveCount(0);
    await expect(header(page).getByText('In review', { exact: true })).toBeVisible();
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 375, 320]) {
    test(`${width}px: header, approved banner and dialog fit without horizontal overflow`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, details });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/requests/801');
      await approveBtn(page).click();
      await expect(dialog(page)).toBeVisible();
      await confirm(page).click();
      await expect(header(page).getByLabel('Approved request')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
