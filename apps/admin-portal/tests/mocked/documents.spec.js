// @ts-check
// Phase D: document download and review on the details page, against the MOCKED API
// (tests/helpers/mockApi.js), whose file and review endpoints follow the real server's rules
// (clean + current only; approve only while pending; 409 codes) and change `details`, so a refetch
// shows what a decision did.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const doc = (id, name, over = {}) => ({
  id, serviceRequestId: 601, originalName: name, sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z',
  reviewStatus: 'pending', reviewedByAdminId: null, reviewedAt: null, rejectionReason: null, caseDocumentId: null, ...over,
});
const request = (over = {}) => ({
  id: 601, userId: 9, referenceNumber: 'REQ-1601', serviceType: 'Private Charter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
  origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null, urgency: 'urgent_24h',
  createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'in_review', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null,
  user: { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: '+971501234567' },
  requestDocuments: [
    doc(1, 'clean-pending.pdf', { replacesId: 7 }),
    doc(2, 'approved.pdf', { reviewStatus: 'approved', reviewedByAdminId: 7, reviewedAt: '2026-11-01T10:30:00.000Z' }),
    doc(3, 'rejected.pdf', { reviewStatus: 'rejected', rejectionReason: 'Too blurry.', reviewedByAdminId: 7, reviewedAt: '2026-11-01T10:30:00.000Z' }),
    doc(4, 'virus.pdf', { scanStatus: 'infected' }),
    doc(5, 'waiting.pdf', { scanStatus: 'pending', scannedAt: null }),
    doc(6, 'broken.pdf', { scanStatus: 'error', scanDetail: 'the scanner was unavailable' }),
    doc(7, 'old.pdf', { supersededAt: '2026-11-01T12:00:00.000Z', reviewStatus: 'rejected', rejectionReason: 'Wrong file.' }),
  ],
  requestEvents: [],
  case: null,
  documentSummary: { current: 6, awaitingScan: 2, scanErrors: 1, infected: 1, awaitingReview: 1, approved: 1, rejected: 1 },
  ...over,
});
const approvedRequest = request({ id: 602, referenceNumber: 'REQ-1602', reviewStatus: 'approved', requestDocuments: [doc(20, 'final.pdf', { serviceRequestId: 602, reviewStatus: 'approved', reviewedByAdminId: 7 })] });
const details = { 601: request(), 602: approvedRequest };

const card = (page, name) => page.getByRole('list', { name: 'Document history' }).getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
const button = (page, verb, name) => page.getByRole('button', { name: `${verb} ${name}` });
const detailCalls = (api) => api.calls.filter((c) => /^\/admin\/requests\/\d+$/.test(c.path));
const fileCalls = (api) => api.calls.filter((c) => /\/file$/.test(c.path));
const open = async (page, context, initial = {}, id = 601) => {
  const api = await installMockApi(context, { authed: true, details, ...initial });
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
};

test.describe('what is offered', () => {
  test('only clean, current documents can be opened; only pending ones approved; decided and unsafe ones are left alone', async ({ page, context }) => {
    await open(page, context);
    const offered = async (name) => ({
      download: await button(page, 'Download', name).count(),
      approve: await button(page, 'Approve', name).count(),
      reject: await button(page, 'Reject', name).count(),
    });
    expect(await offered('clean-pending.pdf')).toEqual({ download: 1, approve: 1, reject: 1 });
    expect(await offered('approved.pdf')).toEqual({ download: 1, approve: 0, reject: 1 }); // may still be rejected
    expect(await offered('rejected.pdf')).toEqual({ download: 1, approve: 0, reject: 0 }); // waiting for a replacement
    expect(await offered('virus.pdf')).toEqual({ download: 0, approve: 0, reject: 0 });
    expect(await offered('waiting.pdf')).toEqual({ download: 0, approve: 0, reject: 0 });
    expect(await offered('broken.pdf')).toEqual({ download: 0, approve: 0, reject: 0 });
    expect(await offered('old.pdf')).toEqual({ download: 0, approve: 0, reject: 0 }); // superseded
    await expect(card(page, 'old.pdf')).toContainText('Only the current version can be opened or reviewed');
    await expect(card(page, 'waiting.pdf')).toContainText('Available once the virus scan completes cleanly');
    await expect(card(page, 'rejected.pdf')).toContainText('Waiting for the patient to upload a replacement');
  });

  test('on an approved request nothing can be reviewed, but the clean file can still be opened', async ({ page, context }) => {
    await open(page, context, {}, 602);
    await expect(button(page, 'Download', 'final.pdf')).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Approve|Reject) / })).toHaveCount(0);
    await expect(card(page, 'final.pdf')).toContainText('can no longer be reviewed');
  });

  test('files are never previewed or linked: no iframe, no object, no link to the file endpoint', async ({ page, context }) => {
    await open(page, context);
    await expect(page.locator('iframe, embed, object')).toHaveCount(0);
    await expect(page.locator('a[href*="/file"], a[href^="blob:"]')).toHaveCount(0);
  });
});

test.describe('download', () => {
  test('saves the file through the secure endpoint under its original name', async ({ page, context }) => {
    const api = await open(page, context, { fileContent: 'SECURE-FILE-BYTES' });
    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Download', 'clean-pending.pdf').click()]);
    expect(download.suggestedFilename()).toBe('clean-pending.pdf');
    expect(fs.readFileSync(/** @type {string} */ (await download.path()), 'utf8')).toBe('SECURE-FILE-BYTES');
    expect(fileCalls(api).map((c) => c.path)).toEqual(['/admin/requests/601/documents/1/file']);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(button(page, 'Download', 'clean-pending.pdf')).toBeEnabled(); // ready for another
  });

  test('a successful download refreshes the request, so the new "document opened" event shows in the timeline at once', async ({ page, context }) => {
    const api = await open(page, context);
    const timeline = page.getByRole('list', { name: 'Request timeline' });
    await expect(page.getByText('No events recorded.')).toBeVisible();
    await expect(timeline).toHaveCount(0);
    const before = detailCalls(api).length;

    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Download', 'clean-pending.pdf').click()]);
    expect(download.suggestedFilename()).toBe('clean-pending.pdf');

    // No manual Refresh: the page fetched the request again by itself and the server's new event is shown.
    await expect(timeline.getByText('Document opened by an Admin')).toBeVisible();
    await expect(timeline).toContainText('clean-pending.pdf');
    await expect(timeline).toContainText('Admin #1');
    expect(detailCalls(api).length).toBe(before + 1);
    expect(fileCalls(api)).toHaveLength(1);
    // The rest of the page is as it was.
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1601' })).toBeVisible();
    await expect(button(page, 'Download', 'clean-pending.pdf')).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('uses the same name when the browser is allowed to read Content-Disposition', async ({ page, context }) => {
    await open(page, context, { exposeDisposition: true });
    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Download', 'approved.pdf').click()]);
    expect(download.suggestedFilename()).toBe('approved.pdf');
  });

  for (const [label, status, body, shown] of [
    ['409 the file is not clean', 409, { error: 'This document cannot be opened: its virus scan is "infected".', code: 'document_not_clean' }, 'its virus scan is "infected"'],
    ['409 the stored file changed', 409, { error: 'The stored file no longer matches what was scanned, so it will not be opened.', code: 'file_changed' }, 'no longer matches what was scanned'],
    ['404 the stored file is missing', 404, { error: 'The stored file is missing.', code: 'file_missing' }, 'The stored file is missing.'],
    ['404 the document is gone', 404, { error: 'Document not found' }, 'Document not found'],
    ['500 a server error', 500, { error: 'Something broke on the server.' }, 'Something broke on the server.'],
  ]) {
    test(`a refused download (${label}) shows the server's message, saves nothing, and keeps the page`, async ({ page, context }) => {
      const api = await open(page, context, { fileResponses: { 1: { status, body } } });
      let downloaded = false;
      page.on('download', () => { downloaded = true; });
      const before = detailCalls(api).length;
      await button(page, 'Download', 'clean-pending.pdf').click();
      // The error body arrives as a Blob (responseType: 'blob'); it is read back into the message.
      await expect(page.getByRole('alert')).toContainText('"clean-pending.pdf" could not be downloaded.');
      await expect(page.getByRole('alert')).toContainText(shown);
      expect(downloaded).toBe(false);
      await expect(page.getByRole('heading', { level: 1, name: 'REQ-1601' })).toBeVisible();
      await expect(button(page, 'Download', 'clean-pending.pdf')).toBeEnabled();
      if (status === 404 || status === 409) await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before); // stale: refreshed
      else expect(detailCalls(api).length).toBe(before);
    });
  }

  test('double-clicking Download makes one request', async ({ page, context }) => {
    const api = await open(page, context, { fileDelayMs: 600 });
    await button(page, 'Download', 'clean-pending.pdf').dblclick();
    await expect(button(page, 'Download', 'clean-pending.pdf')).toBeEnabled({ timeout: 10000 });
    expect(fileCalls(api)).toHaveLength(1);
  });

  test('while one download runs the other Download buttons wait', async ({ page, context }) => {
    await open(page, context, { fileDelayMs: 600 });
    await button(page, 'Download', 'clean-pending.pdf').click();
    await expect(button(page, 'Download', 'approved.pdf')).toBeDisabled();
    await expect(button(page, 'Download', 'approved.pdf')).toBeEnabled({ timeout: 10000 });
  });
});

test.describe('approve', () => {
  test('asks first; Cancel sends nothing', async ({ page, context }) => {
    const api = await open(page, context);
    await button(page, 'Approve', 'clean-pending.pdf').click();
    const dialog = page.getByRole('dialog', { name: 'Approve this document?' });
    await expect(dialog).toContainText('clean-pending.pdf');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(api.reviews).toHaveLength(0);
    await expect(button(page, 'Approve', 'clean-pending.pdf')).toBeVisible();
  });

  test('confirming sends the decision without a reason, then the document history is refreshed', async ({ page, context }) => {
    const api = await open(page, context);
    const before = detailCalls(api).length;
    await expect(page.getByLabel('Document status').getByText('Awaiting review')).toBeVisible();
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();

    await expect(page.getByRole('status').filter({ hasText: '"clean-pending.pdf" was approved.' })).toBeVisible();
    expect(api.reviews).toEqual([{ id: 601, docId: 1, body: { decision: 'approved' } }]);
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
    // What the page shows now is what the server returned on the refetch.
    await expect(button(page, 'Approve', 'clean-pending.pdf')).toHaveCount(0);
    await expect(card(page, 'clean-pending.pdf')).toContainText('Approved');
    await expect(card(page, 'clean-pending.pdf')).toContainText('by Admin #1');
    await expect(page.getByLabel('Document status').getByText('Awaiting review')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Request timeline' })).toContainText('Document approved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('reject', () => {
  const reasonBox = (page) => page.getByRole('dialog').getByLabel('Reason (shown to the patient)');
  const confirm = (page) => page.getByRole('dialog').getByRole('button', { name: 'Reject document' });

  test('the reason is mandatory: 3 to 1000 characters after trimming', async ({ page, context }) => {
    const api = await open(page, context);
    await button(page, 'Reject', 'clean-pending.pdf').click();
    await expect(confirm(page)).toBeDisabled(); // nothing typed
    await reasonBox(page).focus();
    await reasonBox(page).blur();
    await expect(page.getByRole('dialog')).toContainText('Enter the reason for rejecting this document.');

    await reasonBox(page).fill('ab');
    await expect(page.getByRole('dialog')).toContainText('at least 3 characters');
    await expect(reasonBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(confirm(page)).toBeDisabled();
    await reasonBox(page).fill('     ab     '); // spaces do not count
    await expect(confirm(page)).toBeDisabled();

    await reasonBox(page).fill('abc');
    await expect(confirm(page)).toBeEnabled();
    await expect(page.getByRole('dialog')).not.toContainText('at least 3 characters');

    // The box stops at 1000 characters and says how many are used.
    await reasonBox(page).fill('x'.repeat(1005));
    await expect(reasonBox(page)).toHaveValue('x'.repeat(1000));
    await expect(page.getByRole('dialog')).toContainText('1000/1000');
    await expect(confirm(page)).toBeEnabled();
    expect(api.reviews).toHaveLength(0); // nothing reached the server while it was invalid
  });

  test('confirming sends the trimmed reason; the history, status and timeline are refreshed', async ({ page, context }) => {
    const api = await open(page, context);
    await button(page, 'Reject', 'clean-pending.pdf').click();
    await expect(page.getByRole('dialog')).toContainText('changes requested');
    await reasonBox(page).fill('  The scan is cut off at the bottom.  ');
    await confirm(page).click();

    await expect(page.getByRole('status').filter({ hasText: '"clean-pending.pdf" was rejected.' })).toBeVisible();
    expect(api.reviews).toEqual([{ id: 601, docId: 1, body: { decision: 'rejected', reason: 'The scan is cut off at the bottom.' } }]);
    await expect(card(page, 'clean-pending.pdf')).toContainText('Rejection reason');
    await expect(card(page, 'clean-pending.pdf')).toContainText('The scan is cut off at the bottom.');
    await expect(button(page, 'Reject', 'clean-pending.pdf')).toHaveCount(0); // already rejected
    await expect(page.getByRole('main').locator('header').getByText('Changes requested', { exact: true })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Request timeline' })).toContainText('Reason: The scan is cut off at the bottom.');
  });

  test('a document that was approved can be rejected, and the dialog says it reverses the approval', async ({ page, context }) => {
    const api = await open(page, context);
    await button(page, 'Reject', 'approved.pdf').click();
    await expect(page.getByRole('dialog')).toContainText('approved earlier');
    await reasonBox(page).fill('Approved by mistake.');
    await confirm(page).click();
    await expect(card(page, 'approved.pdf')).toContainText('Approved by mistake.');
    expect(api.reviews[0].body.decision).toBe('rejected');
  });

  test('a reason typed for one document is not carried to another', async ({ page, context }) => {
    await open(page, context);
    await button(page, 'Reject', 'clean-pending.pdf').click();
    await reasonBox(page).fill('Typed for the first one.');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await button(page, 'Reject', 'approved.pdf').click();
    await expect(reasonBox(page)).toHaveValue('');
  });

  test('a validation error from the server keeps the dialog and the typed reason, and can be retried', async ({ page, context }) => {
    const api = await open(page, context, { reviewResponses: { 1: { status: 400, body: { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_required' } } } });
    await button(page, 'Reject', 'clean-pending.pdf').click();
    await reasonBox(page).fill('Needs a clearer copy.');
    await confirm(page).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('A reason of 3 to 1000 characters is required.');
    await expect(reasonBox(page)).toHaveValue('Needs a clearer copy.');
    await expect(confirm(page)).toBeEnabled();
    delete api.reviewResponses[1];
    await confirm(page).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card(page, 'clean-pending.pdf')).toContainText('Needs a clearer copy.');
    expect(api.reviews).toHaveLength(2);
  });
});

test.describe('duplicate and in-flight protection', () => {
  test('double-clicking the confirm button saves one decision', async ({ page, context }) => {
    const api = await open(page, context, { reviewDelayMs: 600 });
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).dblclick();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10000 });
    expect(api.reviews).toHaveLength(1);
  });

  test('while saving, the dialog cannot be dismissed and its buttons are disabled', async ({ page, context }) => {
    const api = await open(page, context, { reviewDelayMs: 800 });
    await button(page, 'Approve', 'clean-pending.pdf').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Approve document' }).click();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5); // the backdrop
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCount(0, { timeout: 10000 }); // closes by itself when the save finishes
    expect(api.reviews).toHaveLength(1);
  });
});

test.describe('stale decisions and concurrent Admins', () => {
  test('another Admin approved it first: 409 closes the dialog, explains, and shows the current state', async ({ page, context }) => {
    const api = await open(page, context);
    // After this page loaded, someone else approved the document.
    Object.assign(api.details[601].requestDocuments[0], { reviewStatus: 'approved', reviewedByAdminId: 3, reviewedAt: '2026-11-02T09:00:00.000Z' });
    await expect(button(page, 'Approve', 'clean-pending.pdf')).toBeVisible(); // the page still shows the old state
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();

    const notice = page.getByRole('status').filter({ hasText: 'already approved' });
    await expect(notice).toContainText('The page has been refreshed with the current state.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(button(page, 'Approve', 'clean-pending.pdf')).toHaveCount(0);
    await expect(card(page, 'clean-pending.pdf')).toContainText('by Admin #3');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1601' })).toBeVisible(); // page state kept
    expect(api.reviews).toHaveLength(1);
  });

  test('another Admin already rejected it: approving is refused with the server message', async ({ page, context }) => {
    const api = await open(page, context);
    Object.assign(api.details[601].requestDocuments[0], { reviewStatus: 'rejected', rejectionReason: 'Rejected elsewhere.' });
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'already rejected' })).toBeVisible();
    await expect(card(page, 'clean-pending.pdf')).toContainText('Rejected elsewhere.');
    await expect(button(page, 'Reject', 'clean-pending.pdf')).toHaveCount(0);
  });

  test('the patient replaced the document meanwhile: 409, and the old version is shown as replaced', async ({ page, context }) => {
    const api = await open(page, context);
    api.details[601].requestDocuments[0].supersededAt = '2026-11-02T08:00:00.000Z';
    await button(page, 'Reject', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByLabel('Reason (shown to the patient)').fill('Please resend.');
    await page.getByRole('dialog').getByRole('button', { name: 'Reject document' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'was replaced by a newer one' })).toBeVisible();
    await expect(card(page, 'clean-pending.pdf')).toContainText('Replaced');
    await expect(button(page, 'Reject', 'clean-pending.pdf')).toHaveCount(0);
    await expect(button(page, 'Download', 'clean-pending.pdf')).toHaveCount(0);
  });

  test('the request was approved meanwhile: 409, and review controls disappear', async ({ page, context }) => {
    const api = await open(page, context);
    api.details[601].reviewStatus = 'approved';
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'request has already been approved' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Approve|Reject) / })).toHaveCount(0);
    await expect(button(page, 'Download', 'clean-pending.pdf')).toBeVisible();
  });

  test('the document disappeared (404): explained, and the page is refreshed', async ({ page, context }) => {
    const api = await open(page, context, { reviewResponses: { 1: { status: 404, body: { error: 'Document not found' } } } });
    const before = detailCalls(api).length;
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Document not found' })).toBeVisible();
    await expect.poll(() => detailCalls(api).length).toBeGreaterThan(before);
  });

  test('a failed save (500) keeps the dialog open so the Admin can retry, and never reports success', async ({ page, context }) => {
    const api = await open(page, context, { reviewResponses: { 1: { status: 500, body: { error: 'Something went wrong. Please try again.' } } } });
    await button(page, 'Approve', 'clean-pending.pdf').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Something went wrong');
    await expect(page.getByText('was approved.')).toHaveCount(0);
    delete api.reviewResponses[1];
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'was approved.' })).toBeVisible();
  });
});

test.describe('session handling', () => {
  test('a 401 while reviewing returns to login through the existing session handling', async ({ page, context }) => {
    const api = await open(page, context, { reviewResponses: { 1: { status: 401, body: { error: 'Token expired' } } } });
    await button(page, 'Approve', 'clean-pending.pdf').click();
    api.authed = false;
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a 401 while downloading returns to login', async ({ page, context }) => {
    const api = await open(page, context, { fileResponses: { 1: { status: 401, body: { error: 'Token expired' } } } });
    api.authed = false;
    await button(page, 'Download', 'clean-pending.pdf').click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 375, 320]) {
    test(`${width}px: cards with actions and the reject dialog do not overflow`, async ({ page, context }) => {
      await installMockApi(context, { authed: true, details });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/requests/601');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await button(page, 'Reject', 'clean-pending.pdf').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await page.getByRole('dialog').boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    });
  }
});
