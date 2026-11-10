import test from 'node:test';
import assert from 'node:assert/strict';
import { documentBadges, isReadyForApproval, OPEN_STATUSES } from './requestStatus.mjs';

const docs = (over = {}) => ({ current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 0, ...over });
const req = (reviewStatus, documents, extra = {}) => ({ reviewStatus, documents, ...extra });
const keys = (r) => documentBadges(r).map((b) => b.key);

test('open statuses are in_review and changes_requested only', () => {
  assert.equal(OPEN_STATUSES, 'in_review,changes_requested');
});

test('an infected document is the first and only prominent badge', () => {
  const badges = documentBadges(req('in_review', docs({ infected: 1 })));
  assert.equal(badges[0].key, 'infected');
  assert.equal(badges[0].prominent, true);
  assert.equal(badges.filter((b) => b.prominent).length, 1);
});

test('awaiting scan, awaiting review and rejected each show', () => {
  assert.deepEqual(keys(req('in_review', docs({ awaitingScan: 1 }))), ['scan']);
  assert.deepEqual(keys(req('in_review', docs({ awaitingReview: 1 }))), ['review']);
  assert.deepEqual(keys(req('changes_requested', docs({ current: 2, rejected: 1, approved: 1 }))), ['rejected']);
});

test('a failed scan shows as "Scan error", not "Awaiting scan"; both show when documents are in both states', () => {
  assert.deepEqual(keys(req('in_review', docs({ awaitingScan: 1, scanErrors: 1 }))), ['scanError']);
  assert.deepEqual(keys(req('in_review', docs({ current: 2, awaitingScan: 2, scanErrors: 1 }))), ['scanError', 'scan']);
  const badge = documentBadges(req('in_review', docs({ awaitingScan: 1, scanErrors: 1 })))[0];
  assert.equal(badge.label, 'Scan error');
  assert.equal(badge.prominent, undefined); // only an infected document is solid red
});

test('an API that does not send scanErrors still shows Awaiting scan, and a failed scan blocks readiness', () => {
  const old = { current: 1, awaitingScan: 1, infected: 0, awaitingReview: 0, approved: 0, rejected: 0 };
  assert.deepEqual(keys(req('in_review', old)), ['scan']);
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 1, awaitingScan: 1, scanErrors: 1, approved: 1 }))), false);
});

test('several problems are listed together, most urgent first', () => {
  assert.deepEqual(keys(req('in_review', docs({ current: 4, infected: 1, awaitingScan: 2, scanErrors: 1, awaitingReview: 1 }))), ['infected', 'scanError', 'scan', 'review']);
});

test('changes requested by an Admin shows the reason as a hint', () => {
  const badges = documentBadges(req('changes_requested', docs({ approved: 1 }), { documentsRequestReason: 'Add the fitness certificate' }));
  const requested = badges.find((b) => b.key === 'requested');
  assert.equal(requested.title, 'Add the fitness certificate');
});

test('ready for approval needs every current document clean and approved, and in_review', () => {
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 2, approved: 2 }))), true);
  assert.deepEqual(keys(req('in_review', docs({ current: 2, approved: 2 }))), ['ready']);
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 2, approved: 1, awaitingReview: 1 }))), false);
  assert.equal(isReadyForApproval(req('changes_requested', docs({ current: 1, approved: 1 }))), false);
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 0 }))), false);
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 1, approved: 1, infected: 1 }))), false);
});

test('a request with no current document says so instead of showing nothing', () => {
  assert.deepEqual(keys(req('changes_requested', docs({ current: 0 }))), ['none']);
});

test('a missing documents summary does not crash', () => {
  assert.deepEqual(keys({ reviewStatus: 'in_review' }), ['none']);
});

test('a scan that can never succeed gets its own badge, and the request is not ready for approval', () => {
  const failed = req('in_review', docs({ current: 2, approved: 1, scanFailed: 1 }));
  assert.ok(keys(failed).includes('scanFailed'));
  assert.equal(documentBadges(failed).find((b) => b.key === 'scanFailed').tone, 'danger');
  assert.equal(documentBadges(req('in_review', docs({ current: 3, scanFailed: 2 }))).find((b) => b.key === 'scanFailed').label, '2 scans failed, need replacements');
  assert.equal(isReadyForApproval(failed), false);
  assert.ok(!keys(failed).includes('ready'));
  // an API that does not send scanFailed counts as none
  assert.equal(isReadyForApproval(req('in_review', docs({ current: 1, approved: 1 }))), true);
});
