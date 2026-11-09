// @ts-check
// Phase E1 (aligned with the E2 backend guards): "Request additional documents" on the details page, against the
// MOCKED API (tests/helpers/mockApi.js), whose POST .../request-documents follows the real server's checks in order:
// reason 3 to 1000 characters (400) -> request found (404) -> approved (409 request_approved) -> draft (409
// request_is_draft) -> already waiting for the patient (409 documents_request_already_pending) -> status becomes
// changes_requested, reason stored, `documents_requested` event. It changes `details`, so a refetch shows the result.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const doc = (id, requestId, name, over = {}) => ({
  id, serviceRequestId: requestId, originalName: name, sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z',
  reviewStatus: 'pending', reviewedByAdminId: null, reviewedAt: null, rejectionReason: null, caseDocumentId: null, ...over,
});
const summary = { current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 1, approved: 0, rejected: 0 };
const base = (id, over = {}) => ({
  id, userId: 9, referenceNumber: `REQ-${1000 + id}`, serviceType: 'Private Charter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
  origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null, urgency: 'urgent_24h',
  createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'in_review', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null,
  user: { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: '+971501234567' },
  requestDocuments: [doc(id * 10, id, 'report.pdf')], requestEvents: [], case: null, documentSummary: summary, ...over,
});
const EARLIER_ASK = 'Please add the fitness-to-fly certificate.';
const details = {
  701: base(701), // in review: the only state that may be asked
  702: base(702, { // already waiting for the patient because an Admin asked
    reviewStatus: 'changes_requested', documentsRequestReason: EARLIER_ASK,
    requestEvents: [{ id: 1, serviceRequestId: 702, documentId: null, action: 'documents_requested', fromStatus: 'in_review', toStatus: 'changes_requested', actorType: 'admin', actorId: 7, detail: { reason: EARLIER_ASK }, occurredAt: '2026-11-01T11:00:00.000Z' }],
  }),
  703: base(703, { reviewStatus: 'awaiting_documents', submittedAt: null, requestDocuments: [], documentSummary: { ...summary, current: 0, awaitingReview: 0 } }), // draft
  704: base(704, { reviewStatus: 'approved', case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted' } }),
  705: base(705, { reviewStatus: 'changes_requested', documentsRequestReason: null, requestDocuments: [doc(7050, 705, 'blurry.pdf', { reviewStatus: 'rejected', rejectionReason: 'Too blurry.' })] }), // waiting because a document was rejected
};

const ask = (page) => page.getByRole('button', { name: 'Request additional documents' });
const anyAsk = (page) => page.getByRole('button', { name: /additional documents|document request/i });
const dialog = (page) => page.getByRole('dialog');
const reasonBox = (page) => dialog(page).getByLabel('Reason (visible to the patient)');
const send = (page) => dialog(page).getByRole('button', { name: 'Send request' });
const detailCalls = (api) => api.calls.filter((c) => /^\/admin\/requests\/\d+$/.test(c.path));
const header = (page) => page.getByRole('main').locator('header');
const open = async (page, context, initial = {}, id = 701) => {
  const api = await installMockApi(context, { authed: true, details, ...initial });
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
};

test.describe('when the action is offered: only while the request is in review', () => {
  test('in review: "Request additional documents"', async ({ page, context }) => {
    await open(page, context, {}, 701);
    await expect(ask(page)).toBeVisible();
  });

  test('already waiting for the patient because an Admin asked: no action, the banner explains', async ({ page, context }) => {
    const api = await open(page, context, {}, 702);
    await expect(anyAsk(page)).toHaveCount(0); // neither an ask nor an "update"
    await expect(header(page)).toContainText('Documents requested from the patient:');
    await expect(header(page)).toContainText(EARLIER_ASK);
    await expect(header(page)).toContainText('Waiting for the patient to upload');
    expect(api.requestDocs).toHaveLength(0);
  });

  test('waiting only because a document was rejected (no Admin ask): no action either', async ({ page, context }) => {
    await open(page, context, {}, 705);
    await expect(header(page).getByText('Changes requested', { exact: true })).toBeVisible();
    await expect(anyAsk(page)).toHaveCount(0);
  });

  test('drafts and approved requests: hidden, and nothing is sent', async ({ page, context }) => {
    const api = await open(page, context, {}, 703);
    await expect(header(page)).toContainText('Draft');
    await expect(anyAsk(page)).toHaveCount(0);
    await page.goto('/requests/704');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1704' })).toBeVisible();
    await expect(anyAsk(page)).toHaveCount(0);
    expect(api.requestDocs).toHaveLength(0);
  });

  test('there is no "update" variant, and the dialog has no earlier-request panel', async ({ page, context }) => {
    await open(page, context, {}, 701);
    await expect(page.getByRole('button', { name: /update document request/i })).toHaveCount(0);
    await ask(page).click();
    await expect(dialog(page).getByRole('heading', { name: 'Request additional documents' })).toBeVisible();
    await expect(dialog(page)).not.toContainText('earlier request');
    await expect(dialog(page)).not.toContainText('replaces what the patient sees');
  });
});

test.describe('the dialog', () => {
  test('explains that the patient will see the reason, and Cancel sends nothing', async ({ page, context }) => {
    const api = await open(page, context);
    await ask(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('REQ-1701');
    await expect(dialog(page)).toContainText('The patient will see this reason.');
    await expect(dialog(page)).toContainText('earlier documents stay in the history');
    await expect(dialog(page)).toContainText('cannot be approved until the patient has answered');
    await expect(reasonBox(page)).toBeFocused();
    await expect(send(page)).toBeDisabled();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(api.requestDocs).toHaveLength(0);
  });

  test('the reason is mandatory: 3 to 1000 characters after trimming', async ({ page, context }) => {
    const api = await open(page, context);
    await ask(page).click();
    await reasonBox(page).focus();
    await reasonBox(page).blur();
    await expect(dialog(page)).toContainText('Enter the reason for requesting additional documents.');
    await expect(send(page)).toBeDisabled();

    await reasonBox(page).fill('ab');
    await expect(dialog(page)).toContainText('The reason must be at least 3 characters.');
    await expect(reasonBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(send(page)).toBeDisabled();
    await reasonBox(page).fill('     ab     '); // spaces do not count
    await expect(send(page)).toBeDisabled();

    await reasonBox(page).fill('abc');
    await expect(send(page)).toBeEnabled();
    await expect(dialog(page)).not.toContainText('at least 3 characters');

    await reasonBox(page).fill('x'.repeat(1005)); // the box stops at 1000
    await expect(reasonBox(page)).toHaveValue('x'.repeat(1000));
    await expect(dialog(page)).toContainText('1000/1000');
    await expect(send(page)).toBeEnabled();
    expect(api.requestDocs).toHaveLength(0); // nothing reached the server while it was invalid
  });

  test('a reason typed and cancelled is not kept the next time', async ({ page, context }) => {
    await open(page, context);
    await ask(page).click();
    await reasonBox(page).fill('Typed and abandoned.');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await ask(page).click();
    await expect(reasonBox(page)).toHaveValue('');
  });
});

test.describe('sending the request', () => {
  test('sends the trimmed reason, then refetches: status, banner and timeline are updated and the action goes away', async ({ page, context }) => {
    const api = await open(page, context);
    const before = detailCalls(api).length;
    await expect(header(page).getByText('In review', { exact: true })).toBeVisible();
    await expect(page.getByText('No events recorded.')).toBeVisible();

    await ask(page).click();
    await reasonBox(page).fill('  Please upload the discharge summary.  ');
    await send(page).click();

    await expect(page.getByRole('status').filter({ hasText: 'Additional documents were requested.' })).toBeVisible();
    expect(api.requestDocs).toEqual([{ id: 701, body: { reason: 'Please upload the discharge summary.' } }]);
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
    await expect(dialog(page)).toHaveCount(0);
    // What the page shows now is what the server returned on the refetch.
    await expect(header(page).getByText('Changes requested', { exact: true })).toBeVisible();
    await expect(header(page)).toContainText('Documents requested from the patient:');
    await expect(header(page)).toContainText('Please upload the discharge summary.');
    await expect(header(page).getByLabel('Document status').getByText('Documents requested')).toBeVisible();
    const timeline = page.getByRole('list', { name: 'Request timeline' });
    await expect(timeline.getByText('Additional documents requested')).toBeVisible();
    await expect(timeline).toContainText('Reason: Please upload the discharge summary.');
    await expect(timeline).toContainText('Admin #1');
    // The request is now waiting for the patient: no second ask can be started from this page.
    await expect(anyAsk(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1701' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Document history' }).getByRole('listitem')).toHaveCount(1); // history untouched
  });

  test('no Case is created and nothing is approved by asking for documents', async ({ page, context }) => {
    await open(page, context);
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Additional documents were requested.' })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Linked Case' }) })).toContainText('No Case yet');
    await expect(page.getByRole('button', { name: 'Approve request' })).toBeDisabled(); // waiting for the patient
    await expect(page.getByRole('button', { name: /create case/i })).toHaveCount(0);
  });
});

test.describe('duplicate submissions and in-flight protection', () => {
  test('double-clicking "Send request" sends one request', async ({ page, context }) => {
    const api = await open(page, context, { requestDocsDelayMs: 600 });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).dblclick();
    await expect(dialog(page)).toHaveCount(0, { timeout: 10000 });
    expect(api.requestDocs).toHaveLength(1);
  });

  test('while saving, the dialog cannot be dismissed and its controls are disabled', async ({ page, context }) => {
    const api = await open(page, context, { requestDocsDelayMs: 800 });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect(reasonBox(page)).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5); // the backdrop
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0, { timeout: 10000 });
    expect(api.requestDocs).toHaveLength(1);
  });
});

test.describe('errors and stale state', () => {
  test('a server validation error (400) keeps the dialog and the typed reason, and can be retried', async ({ page, context }) => {
    const api = await open(page, context, { requestDocsResponses: { 701: { status: 400, body: { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_required' } } } });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('A reason of 3 to 1000 characters is required.');
    await expect(reasonBox(page)).toHaveValue('Please send the certificate.');
    await expect(send(page)).toBeEnabled();
    delete api.requestDocsResponses[701];
    await send(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page)).toContainText('Please send the certificate.');
    expect(api.requestDocs).toHaveLength(2);
  });

  test('a failed save (500) keeps the dialog open and never reports success', async ({ page, context }) => {
    await open(page, context, { requestDocsResponses: { 701: { status: 500, body: { error: 'Internal server error' } } } });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    await expect(dialog(page).getByRole('alert')).toContainText('Internal server error');
    await expect(page.getByText('Additional documents were requested.')).toHaveCount(0);
    await expect(header(page).getByText('In review', { exact: true })).toBeVisible(); // nothing changed
  });

  test('another Admin asked first (409 documents_request_already_pending): dialog closes, their reason is shown, no second ask', async ({ page, context }) => {
    const api = await open(page, context);
    // After this page loaded, another Admin already asked the patient.
    Object.assign(api.details[701], { reviewStatus: 'changes_requested', documentsRequestReason: 'Asked by another Admin: the insurance letter.', reviewedAt: '2026-11-02T08:00:00.000Z' });
    await expect(ask(page)).toBeVisible(); // the page still shows the old state
    await ask(page).click();
    await reasonBox(page).fill('My own request for the same thing.');
    await send(page).click();

    const notice = page.getByRole('status').filter({ hasText: 'already been asked for changes' });
    await expect(notice).toContainText('The page has been refreshed with the current state.');
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page).getByText('Changes requested', { exact: true })).toBeVisible();
    await expect(header(page)).toContainText('Asked by another Admin: the insurance letter.'); // their reason is kept, not overwritten
    await expect(header(page)).not.toContainText('My own request for the same thing.');
    await expect(anyAsk(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1701' })).toBeVisible(); // page state kept
    expect(api.requestDocs).toHaveLength(1);
  });

  test('the request is a draft after all (409 request_is_draft): dialog closes, the server message is shown, the action is gone', async ({ page, context }) => {
    const api = await open(page, context);
    Object.assign(api.details[701], { reviewStatus: 'awaiting_documents', submittedAt: null });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    const notice = page.getByRole('status').filter({ hasText: 'still a draft' });
    await expect(notice).toContainText('The page has been refreshed with the current state.');
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page)).toContainText('Draft');
    await expect(anyAsk(page)).toHaveCount(0);
    expect(api.requestDocs).toHaveLength(1);
  });

  test('approved meanwhile (409 request_approved): dialog closes, the server message is shown, the page refreshes and the action disappears', async ({ page, context }) => {
    const api = await open(page, context);
    api.details[701].reviewStatus = 'approved'; // another Admin approved it after this page loaded
    await expect(ask(page)).toBeVisible(); // the page still shows the old state
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();

    const notice = page.getByRole('status').filter({ hasText: 'already been approved' });
    await expect(notice).toContainText('The page has been refreshed with the current state.');
    await expect(dialog(page)).toHaveCount(0);
    await expect(header(page).getByText('Approved', { exact: true })).toBeVisible();
    await expect(anyAsk(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1701' })).toBeVisible(); // page state kept
    expect(api.requestDocs).toHaveLength(1);
  });

  test('the request disappeared (404): explained, and the page is refreshed', async ({ page, context }) => {
    const api = await open(page, context, { requestDocsResponses: { 701: { status: 404, body: { error: 'Request not found' } } } });
    const before = detailCalls(api).length;
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    await send(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Request not found' })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
  });

  test('a 401 returns to login through the existing session handling', async ({ page, context }) => {
    const api = await open(page, context, { requestDocsResponses: { 701: { status: 401, body: { error: 'Token expired' } } } });
    await ask(page).click();
    await reasonBox(page).fill('Please send the certificate.');
    api.authed = false;
    await send(page).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 375, 320]) {
    test(`${width}px: the header actions and the dialog fit without horizontal overflow`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, details });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/requests/701');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await ask(page).click();
      await expect(dialog(page)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await dialog(page).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
      await expect(send(page)).toBeVisible();
    });
  }
});
