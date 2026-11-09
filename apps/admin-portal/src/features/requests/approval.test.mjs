import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalEligibility, blockerMessages, caseDetailsPath } from './approval.mjs';

const clean = { current: 2, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 2, rejected: 0 };
const req = (over = {}, summary = {}) => ({ reviewStatus: 'in_review', documentsRequestReason: null, documentSummary: { ...clean, ...summary }, ...over });

test('allowed only when every current document is clean and approved', () => {
  assert.deepEqual(approvalEligibility(req()), { allowed: true, approved: false, blockers: [] });
});

test('each document problem blocks approval with its own reason', () => {
  const cases = [
    [{ awaitingReview: 1, approved: 1 }, /waiting for your review/],
    [{ awaitingScan: 1, approved: 1 }, /not been scanned/],
    [{ awaitingScan: 1, scanErrors: 1, approved: 1 }, /could not be scanned/],
    [{ infected: 1, approved: 1 }, /virus scan/],
    [{ rejected: 1, approved: 1 }, /rejected/],
    [{ current: 0, approved: 0 }, /no current document/],
  ];
  for (const [summary, pattern] of cases) {
    const r = approvalEligibility(req({}, summary));
    assert.equal(r.allowed, false);
    assert.match(r.blockers.join(' '), pattern);
  }
});

test('a scan error is not also reported as "not scanned yet"', () => {
  const r = approvalEligibility(req({}, { awaitingScan: 1, scanErrors: 1, approved: 1 }));
  assert.equal(r.blockers.length, 1);
});

test('drafts, requests awaiting the patient and unknown states are blocked', () => {
  assert.match(approvalEligibility(req({ reviewStatus: 'awaiting_documents' }, { current: 0, approved: 0 })).blockers.join(' '), /draft/);
  assert.match(approvalEligibility(req({ reviewStatus: 'changes_requested', documentsRequestReason: 'x' })).blockers.join(' '), /requested/);
  assert.match(approvalEligibility(req({ reviewStatus: 'changes_requested' })).blockers.join(' '), /rejected document/);
  assert.equal(approvalEligibility(req({ reviewStatus: 'weird' })).allowed, false);
  assert.equal(approvalEligibility({ reviewStatus: 'in_review' }).allowed, false); // no summary
});

test('an approved request is neither allowed nor blocked', () => {
  assert.deepEqual(approvalEligibility(req({ reviewStatus: 'approved' })), { allowed: false, approved: true, blockers: [] });
});

test('blockerMessages reads the 409 body', () => {
  assert.deepEqual(blockerMessages({ blockers: [{ code: 'a', message: 'One.' }, { code: 'b' }, null] }), ['One.']);
  assert.deepEqual(blockerMessages(undefined), []);
});

test('the Case page is linked by id once it exists (Phase G)', () => {
  assert.equal(caseDetailsPath({ id: 3 }), '/cases/3');
  assert.equal(caseDetailsPath(null), null);
});

test('a document that can never be scanned blocks approval, with a reason that asks for a replacement', () => {
  const r = approvalEligibility(req({}, { scanFailed: 1, approved: 1 }));
  assert.equal(r.allowed, false);
  assert.match(r.blockers.join(' '), /1 document can never be scanned.*upload a replacement/);
  assert.match(approvalEligibility(req({}, { current: 3, scanFailed: 2, approved: 1 })).blockers.join(' '), /2 documents can never be scanned.*upload replacements/);
  // not mistaken for a retryable error or an unscanned file
  assert.doesNotMatch(r.blockers.join(' '), /scan error|not been scanned/);
});
