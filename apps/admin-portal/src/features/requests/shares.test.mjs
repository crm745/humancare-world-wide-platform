import test from 'node:test';
import assert from 'node:assert/strict';
import { canAuthorize, canOpenDocumentRequest, documentRequestRows, latestShares, shareView, sharesNeedingAttention, sharingApplies } from './shares.mjs';

const approved = { reviewStatus: 'approved', case: { id: 3, referenceNumber: 'CASE-1003' } };
const doc = (over = {}) => ({ id: 10, scanStatus: 'clean', reviewStatus: 'approved', supersededAt: null, caseDocumentId: 55, ...over });
const share = (over = {}) => ({ id: 1, requestDocumentId: 10, generation: 1, status: 'attached', tryCount: 1, attempts: 0, lastError: null, ...over });

test('Authorize is offered only for a clean, approved, current Case document of an approved request with no active share', () => {
  assert.equal(canAuthorize(doc(), approved, null).allowed, true);
  assert.equal(canAuthorize(doc(), approved, share({ status: 'revoked' })).allowed, true); // a revoked share may be authorized again
  for (const status of ['authorized', 'attaching', 'attached', 'ambiguous', 'failed', 'revoking', 'revoke_failed']) {
    assert.equal(canAuthorize(doc(), approved, share({ status })).allowed, false, status);
  }
});

test('Authorize is never offered before the approval, without a Case, or for a replaced document', () => {
  assert.equal(canAuthorize(doc(), { reviewStatus: 'in_review', case: null }, null).allowed, false);
  assert.equal(canAuthorize(doc(), { reviewStatus: 'approved', case: null }, null).allowed, false);
  assert.equal(canAuthorize(doc({ supersededAt: '2026-11-02T00:00:00Z' }), approved, null).allowed, false);
});

test('a document that is not clean, not approved or not in the Case says why it cannot be shared', () => {
  assert.match(canAuthorize(doc({ scanStatus: 'pending' }), approved, null).reason, /virus scan/);
  assert.match(canAuthorize(doc({ reviewStatus: 'pending' }), approved, null).reason, /Approve this document first/);
  assert.match(canAuthorize(doc({ caseDocumentId: null }), approved, null).reason, /not part of the Case/);
});

test('reviewing is separate from sharing: an approved document with no share shows "not shared" state, not a status', () => {
  assert.equal(canAuthorize(doc(), approved, null).allowed, true);
  assert.equal(sharingApplies(approved), true);
  assert.equal(sharingApplies({ reviewStatus: 'in_review', case: null }), false);
});

test('shareView: status, retry status and failure indicator', () => {
  const failed = shareView(share({ status: 'failed', tryCount: 2, attempts: 1, lastError: 'bitrix_unavailable' }));
  assert.deepEqual([failed.label, failed.tone, failed.failed, failed.attention, failed.canRetry, failed.canRevoke], ['Attach failed', 'danger', true, true, true, true]);
  assert.equal(failed.tryText, 'Try 2 · 1 attempt so far');
  assert.equal(failed.error, 'bitrix_unavailable');

  const removal = shareView(share({ status: 'revoke_failed', tryCount: 3, attempts: 5 }));
  assert.deepEqual([removal.failed, removal.canRetry, removal.canRevoke], [true, true, false]); // removal failed: retry, not revoke again
  assert.equal(removal.tryText, 'Try 3 · 5 attempts so far');
});

test('shareView: attached is healthy, a first try that has not started shows no retry text, ambiguous needs a person but is not retryable', () => {
  const attached = shareView(share());
  assert.deepEqual([attached.label, attached.tone, attached.failed, attached.attention, attached.canRevoke, attached.canRetry, attached.tryText], ['Attached to the Deal', 'success', false, false, true, false, null]);
  const ambiguous = shareView(share({ status: 'ambiguous' }));
  assert.deepEqual([ambiguous.attention, ambiguous.canRetry, ambiguous.canRevoke], [true, false, true]);
  const revoked = shareView(share({ status: 'revoked', revokeReason: 'Wrong patient file' }));
  assert.deepEqual([revoked.canRevoke, revoked.canRetry, revoked.detail], [false, false, 'Revoked: Wrong patient file']);
  assert.equal(shareView(share({ status: 'revoking' })).canRevoke, false);
});

test('an unknown status is shown as it is, with no actions', () => {
  const view = shareView(share({ status: 'mystery' }));
  assert.deepEqual([view.label, view.canRevoke, view.canRetry], ['mystery', false, false]);
});

test('latestShares keeps the newest generation of each document and ignores malformed rows', () => {
  const latest = latestShares([share({ id: 1, generation: 1, status: 'revoked' }), share({ id: 2, generation: 2, status: 'attached' }), share({ id: 3, requestDocumentId: 11 }), null, { id: 9 }]);
  assert.equal(latest[10].id, 2);
  assert.equal(latest[11].id, 3);
  assert.equal(Object.keys(latest).length, 2);
  assert.deepEqual(latestShares(undefined), {});
});

test('sharesNeedingAttention counts failed, removal-failed and ambiguous shares by their newest state only', () => {
  const list = [share({ id: 1, generation: 1, status: 'failed' }), share({ id: 2, generation: 2, status: 'attached' }), share({ id: 3, requestDocumentId: 11, status: 'revoke_failed' }), share({ id: 4, requestDocumentId: 12, status: 'ambiguous' })];
  assert.deepEqual(sharesNeedingAttention(list).map((s) => s.id).sort(), [3, 4]);
});

test('documentRequestRows lists requests oldest first with the documents sent for each', () => {
  const request = {
    ...approved,
    case: { ...approved.case, documentRequests: [
      { id: 8, description: 'Passport copy', reason: 'For the airline', status: 'open', createdAt: '2026-11-03T00:00:00Z', resolvedAt: null },
      { id: 5, description: 'Latest ECG', reason: null, status: 'fulfilled', createdAt: '2026-11-01T00:00:00Z', resolvedAt: '2026-11-02T00:00:00Z' },
      { description: 'no id' }, null,
    ] },
    requestDocuments: [doc({ id: 1, documentRequestId: 5 }), doc({ id: 2, documentRequestId: 5 }), doc({ id: 3, documentRequestId: null }), doc({ id: 4, documentRequestId: 8 })],
  };
  const rows = documentRequestRows(request);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.tone, r.documents.map((d) => d.id)]), [
    [5, 'Fulfilled', 'success', [1, 2]],
    [8, 'Open, waiting for the patient', 'warning', [4]],
  ]);
  assert.equal(rows[1].reason, 'For the airline');
  assert.equal(rows[0].reason, null);
  assert.deepEqual(documentRequestRows({ reviewStatus: 'approved' }), []);
});

test('a document request can be opened only on an approved request with a Case', () => {
  assert.equal(canOpenDocumentRequest(approved).allowed, true);
  assert.equal(canOpenDocumentRequest({ reviewStatus: 'in_review', case: null }).allowed, false);
  assert.equal(canOpenDocumentRequest({ reviewStatus: 'approved', case: null }).allowed, false);
});
