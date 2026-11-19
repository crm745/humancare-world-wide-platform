// @ts-check
// Step 5: per-document Bitrix sharing (Authorize / Revoke / Retry, with attachment, retry and failure status) and post-Case document
// requests, against the MOCKED API (tests/helpers/mockApi.js), whose share routes follow the real server's checks. Nothing here reaches
// Bitrix or a worker: the mock only records the Admin's action.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const doc = (id, requestId, name, over = {}) => ({
  id, serviceRequestId: requestId, originalName: name, sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z',
  reviewStatus: 'approved', reviewedByAdminId: 1, reviewedAt: '2026-11-01T11:00:00.000Z', rejectionReason: null, caseDocumentId: id + 500, documentRequestId: null, ...over,
});
const share = (id, requestDocumentId, over = {}) => ({
  id, requestDocumentId, caseDocumentId: requestDocumentId + 500, generation: 1, detectedType: 'pdf', status: 'attached', bitrixFileId: '77', tryCount: 1, attempts: 0, lastError: null,
  authorizedAt: '2026-11-02T10:00:00.000Z', attachedAt: '2026-11-02T10:01:00.000Z', revokedAt: null, revokeReason: null, updatedAt: '2026-11-02T10:01:00.000Z', ...over,
});
const summary = { current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 1, rejected: 0 };
const approvedRequest = (id, over = {}) => ({
  id, userId: 9, referenceNumber: `REQ-${1000 + id}`, serviceType: 'Private Charter Air Ambulance Service', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female',
  patientContact: '+971501234567', origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null,
  urgency: 'urgent_24h', createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'approved', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null,
  user: { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: '+971501234567' }, requestEvents: [], documentSummary: summary,
  case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted', documentRequests: [] }, documentShares: [], requestDocuments: [doc(id * 10, id, 'report.pdf')], ...over,
});

const details = {
  801: approvedRequest(801), // approved document, never shared
  802: approvedRequest(802, { documentShares: [share(1, 8020)], requestDocuments: [doc(8020, 802, 'attached.pdf')] }),
  803: approvedRequest(803, { documentShares: [share(2, 8030, { status: 'failed', tryCount: 2, attempts: 3, lastError: 'bitrix_unavailable', bitrixFileId: null })], requestDocuments: [doc(8030, 803, 'failed.pdf')] }),
  804: approvedRequest(804, { documentShares: [share(3, 8040, { status: 'revoke_failed', tryCount: 2, attempts: 1, lastError: 'bitrix_timeout' })], requestDocuments: [doc(8040, 804, 'stuck.pdf')] }),
  805: approvedRequest(805, { requestDocuments: [doc(8050, 805, 'pending-review.pdf', { reviewStatus: 'pending', reviewedAt: null, caseDocumentId: null })] }),
  806: approvedRequest(806, { // a post-Case request with its answer, and an open one
    case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted', documentRequests: [
      { id: 5, description: 'Latest ECG report', reason: 'The airline needs it', status: 'fulfilled', createdAt: '2026-11-03T09:00:00.000Z', resolvedAt: '2026-11-04T09:00:00.000Z' },
      { id: 6, description: 'Passport copy', reason: null, status: 'open', createdAt: '2026-11-05T09:00:00.000Z', resolvedAt: null },
    ] },
    requestDocuments: [doc(8060, 806, 'report.pdf'), doc(8061, 806, 'ecg.pdf', { documentRequestId: 5 })],
  }),
  807: approvedRequest(807, { reviewStatus: 'in_review', case: null, requestDocuments: [doc(8070, 807, 'report.pdf', { reviewStatus: 'pending', reviewedAt: null, caseDocumentId: null })] }), // not approved
  808: approvedRequest(808, { documentShares: [share(4, 8080, { status: 'ambiguous' })], requestDocuments: [doc(8080, 808, 'unsure.pdf')] }),
};

const open = async (page, context, id, initial = {}) => {
  const api = await installMockApi(context, { authed: true, details, ...initial });
  await page.goto(`/requests/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return api;
};
const sharing = (page, name) => page.getByLabel(`Bitrix sharing for ${name}`);
const calls = (api) => api.shareCalls;

test.describe('per-document Authorize', () => {
  test('an approved document that is not shared yet can be authorized, and the status then shows', async ({ page, context }) => {
    const api = await open(page, context, 801);
    await expect(sharing(page, 'report.pdf')).toContainText('Not shared');
    await page.getByRole('button', { name: 'Authorize sharing of report.pdf' }).click();
    await expect(page.getByText('"report.pdf" is authorized. It will be attached to the Deal shortly.')).toBeVisible();
    expect(calls(api)).toEqual([{ kind: 'authorize', requestId: 801, docId: 8010, shareId: undefined, body: {} }]);
    await expect(sharing(page, 'report.pdf')).toContainText('Authorized, waiting to attach');
    await expect(page.getByRole('button', { name: 'Authorize sharing of report.pdf' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revoke sharing of report.pdf' })).toBeVisible();
  });

  test('a document that is not approved explains why and offers no Authorize', async ({ page, context }) => {
    await open(page, context, 805);
    await expect(sharing(page, 'pending-review.pdf')).toContainText('Approve this document first');
    await expect(page.getByRole('button', { name: /Authorize sharing/ })).toHaveCount(0);
  });

  test('before the approval nothing about sharing is shown', async ({ page, context }) => {
    await open(page, context, 807);
    await expect(page.getByLabel(/Bitrix sharing for/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Authorize sharing|Revoke sharing|Retry sharing/ })).toHaveCount(0);
  });

  test('the server refusing (no Deal yet) shows its message and keeps the page usable', async ({ page, context }) => {
    const api = await open(page, context, 801, { shareResponses: { authorize: { status: 409, body: { error: 'The request has no Case and Deal record yet.', code: 'no_deal_link' } } } });
    await page.getByRole('button', { name: 'Authorize sharing of report.pdf' }).click();
    await expect(page.getByText(/could not be authorized\. The request has no Case and Deal record yet\./)).toBeVisible();
    expect(calls(api)).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Authorize sharing of report.pdf' })).toBeVisible();
  });
});

test.describe('attachment, retry and failure status', () => {
  test('an attached share reads "Attached to the Deal" and offers Revoke only', async ({ page, context }) => {
    await open(page, context, 802);
    await expect(sharing(page, 'attached.pdf')).toContainText('Attached to the Deal');
    await expect(page.getByRole('button', { name: 'Revoke sharing of attached.pdf' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Retry sharing|Authorize sharing/ })).toHaveCount(0);
  });

  test('a failed share shows the failure, the try and the last error code, a page alert, and a Retry', async ({ page, context }) => {
    await open(page, context, 803);
    const card = sharing(page, 'failed.pdf');
    await expect(card).toContainText('Attach failed');
    await expect(card).toContainText('Attaching this document to the Deal failed');
    await expect(card).toContainText('Try 2 · 3 attempts so far');
    await expect(card).toContainText('bitrix_unavailable');
    await expect(page.getByRole('main').locator('header')).toContainText('1 document needs attention in the Bitrix Deal.');
    await expect(page.getByRole('button', { name: 'Retry sharing of failed.pdf' })).toBeVisible();
  });

  test('manual retry of a failed share calls the retry endpoint once and shows the new status', async ({ page, context }) => {
    const api = await open(page, context, 803);
    await page.getByRole('button', { name: 'Retry sharing of failed.pdf' }).click();
    await expect(page.getByText('Sharing of "failed.pdf" will be tried again.')).toBeVisible();
    expect(calls(api)).toEqual([{ kind: 'retry', requestId: 803, docId: undefined, shareId: 2, body: {} }]);
    await expect(sharing(page, 'failed.pdf')).toContainText('Authorized, waiting to attach');
    await expect(sharing(page, 'failed.pdf')).toContainText('Try 3 · 0 attempts so far');
    await expect(page.getByRole('button', { name: /Retry sharing/ })).toHaveCount(0);
    await expect(page.getByRole('main').locator('header')).not.toContainText('need attention');
  });

  test('a failed removal can be retried but not revoked again', async ({ page, context }) => {
    const api = await open(page, context, 804);
    await expect(sharing(page, 'stuck.pdf')).toContainText('Removal failed');
    await expect(page.getByRole('button', { name: 'Revoke sharing of stuck.pdf' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry sharing of stuck.pdf' }).click();
    await expect(page.getByText('Removal of "stuck.pdf" from the Deal will be tried again.')).toBeVisible();
    expect(calls(api).map((c) => c.kind)).toEqual(['retry']);
    await expect(sharing(page, 'stuck.pdf')).toContainText('Removing from the Deal');
  });

  test('an ambiguous share is flagged for a person to check and cannot be retried', async ({ page, context }) => {
    await open(page, context, 808);
    await expect(sharing(page, 'unsure.pdf')).toContainText('Needs checking');
    await expect(sharing(page, 'unsure.pdf')).toContainText('Check the Deal in Bitrix24');
    await expect(page.getByRole('button', { name: /Retry sharing/ })).toHaveCount(0);
  });

  test('a stale retry (409) is explained and the page refreshes', async ({ page, context }) => {
    await open(page, context, 803, { shareResponses: { retry: { status: 409, body: { error: 'Only a failed share can be retried.', code: 'share_not_retryable' } } } });
    await page.getByRole('button', { name: 'Retry sharing of failed.pdf' }).click();
    await expect(page.getByText(/could not be retried\. Only a failed share can be retried\. The page has been refreshed/)).toBeVisible();
  });
});

test.describe('per-document Revoke', () => {
  test('Revoke asks for a reason, sends it, and shows the share as being removed', async ({ page, context }) => {
    const api = await open(page, context, 802);
    await page.getByRole('button', { name: 'Revoke sharing of attached.pdf' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('The original stays in HumanCare');
    await expect(dialog.getByRole('button', { name: 'Revoke sharing' })).toBeDisabled();
    await dialog.getByLabel('Reason (kept in the audit history)').fill('Wrong patient file');
    await dialog.getByRole('button', { name: 'Revoke sharing' }).click();
    await expect(page.getByText(/Sharing of "attached.pdf" is revoked/)).toBeVisible();
    expect(calls(api)).toEqual([{ kind: 'revoke', requestId: 802, docId: undefined, shareId: 1, body: { reason: 'Wrong patient file' } }]);
    await expect(sharing(page, 'attached.pdf')).toContainText('Removing from the Deal');
    await expect(page.getByRole('button', { name: /Revoke sharing of attached.pdf/ })).toHaveCount(0);
  });

  test('cancelling the dialog sends nothing', async ({ page, context }) => {
    const api = await open(page, context, 802);
    await page.getByRole('button', { name: 'Revoke sharing of attached.pdf' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(calls(api)).toEqual([]);
  });
});

test.describe('document review is unchanged and never shares', () => {
  test('approving a document does not call the share endpoint', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, details: { 807: structuredClone(details[807]) } });
    await page.goto('/requests/807');
    await page.getByRole('button', { name: 'Approve report.pdf' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve document' }).click();
    await expect(page.getByText('"report.pdf" was approved.')).toBeVisible();
    expect(calls(api)).toEqual([]);
  });
});

test.describe('post-Case document requests', () => {
  test('lists each request with its status and the documents the patient sent for it', async ({ page, context }) => {
    await open(page, context, 806);
    const list = page.getByRole('list', { name: 'Document requests' });
    await expect(list.getByRole('listitem').filter({ hasText: 'Latest ECG report' })).toContainText('Fulfilled');
    await expect(list.getByRole('listitem').filter({ hasText: 'Latest ECG report' })).toContainText('The airline needs it');
    await expect(page.getByRole('list', { name: 'Documents sent for request 5' })).toContainText('ecg.pdf');
    await expect(list.getByRole('listitem').filter({ hasText: 'Passport copy' })).toContainText('Open, waiting for the patient');
    await expect(list.getByRole('listitem').filter({ hasText: 'Passport copy' })).toContainText('Nothing uploaded for this request yet.');
  });

  test('the Admin can open a document request; it appears as open', async ({ page, context }) => {
    const api = await open(page, context, 801);
    await expect(page.getByText('No documents have been requested since the Case was opened.')).toBeVisible();
    await page.getByRole('button', { name: 'Request documents' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Send request' })).toBeDisabled();
    await dialog.getByLabel('Documents needed (visible to the patient)').fill('Passport copy of the patient');
    await dialog.getByLabel(/Why they are needed/).fill('Needed for the airline');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText(/The document request was sent/)).toBeVisible();
    expect(calls(api)).toEqual([{ kind: 'document_request', requestId: 801, docId: undefined, shareId: undefined, body: { description: 'Passport copy of the patient', reason: 'Needed for the airline' } }]);
    await expect(page.getByRole('list', { name: 'Document requests' })).toContainText('Passport copy of the patient');
    await expect(page.getByRole('list', { name: 'Document requests' })).toContainText('Open, waiting for the patient');
  });

  test('the optional reason is left out of the body when empty', async ({ page, context }) => {
    const api = await open(page, context, 801);
    await page.getByRole('button', { name: 'Request documents' }).click();
    await page.getByRole('dialog').getByLabel('Documents needed (visible to the patient)').fill('Latest blood report');
    await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByText(/The document request was sent/)).toBeVisible();
    expect(calls(api)[0].body).toEqual({ description: 'Latest blood report' });
  });

  test('not offered, and not shown, before the approval', async ({ page, context }) => {
    await open(page, context, 807);
    await expect(page.getByRole('button', { name: 'Request documents' })).toHaveCount(0);
    await expect(page.getByText('Documents requested after approval')).toHaveCount(0);
    // The pre-approval "Request additional documents" action is unchanged.
    await expect(page.getByRole('button', { name: 'Request additional documents' })).toBeVisible();
  });
});
