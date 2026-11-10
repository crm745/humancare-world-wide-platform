import test from 'node:test';
import assert from 'node:assert/strict';
import { canRequestDocuments, documentActions, fileNameFromDisposition, safeFileName, validateReason } from './documentActions.mjs';

const doc = (over = {}) => ({ id: 1, scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null, ...over });
const open = { reviewStatus: 'in_review' };
const flags = (d, r = open) => {
  const a = documentActions(d, r);
  return [a.download, a.approve, a.reject];
};

test('a clean, current, pending document can be downloaded, approved and rejected', () => {
  assert.deepEqual(flags(doc()), [true, true, true]);
  assert.equal(documentActions(doc(), open).note, null);
});

test('infected, unscanned and scan-error documents offer nothing', () => {
  for (const scanStatus of ['infected', 'pending', 'error']) {
    assert.deepEqual(flags(doc({ scanStatus })), [false, false, false], scanStatus);
  }
  // The card already explains infected and error; only "not scanned yet" needs a note.
  assert.equal(documentActions(doc({ scanStatus: 'infected' }), open).note, null);
  assert.equal(documentActions(doc({ scanStatus: 'error' }), open).note, null);
  assert.match(documentActions(doc({ scanStatus: 'pending' }), open).note, /virus scan/);
});

test('a superseded document offers nothing, even when it is clean', () => {
  assert.deepEqual(flags(doc({ supersededAt: '2026-11-02T00:00:00Z' })), [false, false, false]);
  assert.deepEqual(flags(doc({ supersededAt: '2026-11-02T00:00:00Z', reviewStatus: 'approved' })), [false, false, false]);
  assert.match(documentActions(doc({ supersededAt: 'x' }), open).note, /Replaced/);
});

test('an approved document can only be rejected; a rejected one waits for the patient', () => {
  assert.deepEqual(flags(doc({ reviewStatus: 'approved' })), [true, false, true]);
  assert.deepEqual(flags(doc({ reviewStatus: 'rejected' })), [true, false, false]);
  assert.match(documentActions(doc({ reviewStatus: 'rejected' }), open).note, /replacement/);
});

test('once the request is approved nothing can be reviewed, but clean current files can still be opened', () => {
  assert.deepEqual(flags(doc(), { reviewStatus: 'approved' }), [true, false, false]);
  assert.deepEqual(flags(doc({ scanStatus: 'infected' }), { reviewStatus: 'approved' }), [false, false, false]);
  assert.match(documentActions(doc(), { reviewStatus: 'approved' }).note, /approved/);
});

test('changes requested does not stop review of the documents that are there', () => {
  assert.deepEqual(flags(doc(), { reviewStatus: 'changes_requested' }), [true, true, true]);
});

test('rejection reason: 3 to 1000 characters after trimming, same as the server', () => {
  assert.equal(validateReason('').ok, false);
  assert.equal(validateReason('   ').error, 'Enter the reason for rejecting this document.');
  assert.equal(validateReason('ab').ok, false);
  assert.equal(validateReason('  ab  ').ok, false); // spaces do not count
  assert.match(validateReason('ab').error, /at least 3/);
  assert.equal(validateReason('abc').ok, true);
  assert.equal(validateReason('  abc  ').value, 'abc');
  assert.equal(validateReason('x'.repeat(1000)).ok, true);
  assert.equal(validateReason('x'.repeat(1001)).ok, false);
  assert.match(validateReason('x'.repeat(1001)).error, /at most 1000/);
  assert.equal(validateReason(undefined).ok, false);
  assert.equal(validateReason(null).ok, false);
});

test('download names never carry path parts or control characters', () => {
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName('..\\..\\evil.pdf'), 'evil.pdf');
  assert.equal(safeFileName('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeFileName('a\u0000b\nc.pdf'), 'abc.pdf');
  assert.equal(safeFileName('   '), 'document');
  assert.equal(safeFileName(null), 'document');
  assert.equal(safeFileName('.hidden'), 'hidden');
  assert.equal(safeFileName('x'.repeat(500)).length, 191);
});

test('file name from Content-Disposition: quoted, plain, encoded, and absent', () => {
  assert.equal(fileNameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf');
  assert.equal(fileNameFromDisposition('attachment; filename=report.pdf'), 'report.pdf');
  assert.equal(fileNameFromDisposition('attachment; filename="a \\"quoted\\" name.pdf"'), 'a quoted name.pdf');
  assert.equal(fileNameFromDisposition("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'résumé.pdf');
  assert.equal(fileNameFromDisposition('attachment; filename="../../x.pdf"'), 'x.pdf');
  assert.equal(fileNameFromDisposition('attachment'), null);
  assert.equal(fileNameFromDisposition(undefined), null);
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A"), null);
});

test('validateReason: the empty-reason message can be completed for another purpose', () => {
  assert.equal(validateReason('').error, 'Enter the reason for rejecting this document.'); // unchanged default
  assert.equal(validateReason('  ', 'requesting additional documents').error, 'Enter the reason for requesting additional documents.');
  assert.equal(validateReason('ab', 'requesting additional documents').error, 'The reason must be at least 3 characters.');
  assert.equal(validateReason('abc', 'requesting additional documents').ok, true);
});

test('canRequestDocuments: offered only while the request is in review', () => {
  assert.deepEqual(canRequestDocuments({ reviewStatus: 'in_review' }), { allowed: true, reason: null });
  // A leftover reason does not matter: only the status decides.
  assert.equal(canRequestDocuments({ reviewStatus: 'in_review', documentsRequestReason: 'stale text' }).allowed, true);
});

test('canRequestDocuments: never for drafts, requests waiting for the patient, or approved requests', () => {
  const draft = canRequestDocuments({ reviewStatus: 'awaiting_documents' });
  assert.equal(draft.allowed, false);
  assert.match(draft.reason, /not been submitted/);

  // Waiting for the patient, whether because the Admin asked or because a document was rejected.
  for (const request of [
    { reviewStatus: 'changes_requested', documentsRequestReason: 'Add the fitness certificate' },
    { reviewStatus: 'changes_requested', documentsRequestReason: null },
    { reviewStatus: 'changes_requested' },
  ]) {
    const waiting = canRequestDocuments(request);
    assert.equal(waiting.allowed, false);
    assert.match(waiting.reason, /already been asked for changes/);
  }

  const approved = canRequestDocuments({ reviewStatus: 'approved' });
  assert.equal(approved.allowed, false);
  assert.match(approved.reason, /approved/);
});

test('canRequestDocuments: no "outstanding"/update variant exists any more', () => {
  for (const request of [{ reviewStatus: 'in_review' }, { reviewStatus: 'changes_requested', documentsRequestReason: 'x' }, { reviewStatus: 'approved' }]) {
    assert.deepEqual(Object.keys(canRequestDocuments(request)).sort(), ['allowed', 'reason']);
  }
});

test('canRequestDocuments: a missing or unknown request is not offered', () => {
  for (const request of [undefined, null, {}, { reviewStatus: null }, { reviewStatus: 'something_else' }]) {
    const result = canRequestDocuments(request);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /not in the document review workflow/);
  }
});

test('a document whose scan failed for good offers nothing: no download, review or note', () => {
  assert.deepEqual(flags(doc({ scanStatus: 'failed' })), [false, false, false]);
  assert.equal(documentActions(doc({ scanStatus: 'failed' }), open).note, null); // the card already explains
  assert.deepEqual(flags(doc({ scanStatus: 'failed', reviewStatus: 'approved' })), [false, false, false]);
});
