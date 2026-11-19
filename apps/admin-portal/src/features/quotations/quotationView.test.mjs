import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionButtons, dialogCopy, errorNotice, formatAmount, formatSize, historyEntries, scanLabel, scanProminent, splitVersions, statusLabel, statusTone, successText,
  validateReason, validationMessage,
} from './quotationView.mjs';

const q = (over = {}) => ({
  id: 1, versionNumber: 1, status: 'draft', revision: 3, amount: '1000.000', currency: 'INR', validationError: null, scanStatus: 'clean', live: false,
  createdAt: '2026-11-19T10:03:19.000Z', scannedAt: '2026-11-19T10:24:56.000Z', confirmedAt: null, confirmedBy: null, publishedAt: null, publishedBy: null,
  withdrawnAt: null, withdrawnBy: null, withdrawReason: null, decidedAt: null, rejectionReason: null, supersededAt: null, validUntil: null,
  actions: { canConfirm: true, canPublish: false, canWithdraw: true, canCreateVersion: false, canViewFile: true, blockers: [] }, ...over,
});

test('every status and scan state has a label and tone; an unknown one is shown as unknown, never as something else', () => {
  for (const s of ['draft', 'confirmed', 'published', 'accepted', 'rejected', 'withdrawn', 'superseded']) assert.notEqual(statusLabel(s), 'Unknown');
  assert.equal(statusLabel('mystery'), 'Unknown');
  assert.equal(statusTone('published'), 'success');
  assert.equal(statusTone('rejected'), 'danger');
  assert.equal(statusTone('mystery'), 'neutral');
  assert.equal(scanLabel('clean'), 'Malware scan clean');
  assert.equal(scanLabel('whatever'), 'Scan state unknown');
  assert.equal(scanProminent('infected'), true);
  assert.equal(scanProminent('clean'), false);
});

test('money is shown with its currency and never calculated; an unknown currency falls back to the raw text', () => {
  assert.match(formatAmount('1000.000', 'INR'), /1,000\.00/);
  assert.match(formatAmount('1000.000', 'INR'), /₹|INR/);
  assert.equal(formatAmount(null, 'INR'), null);
  assert.equal(formatAmount('1000.000', null), null);
  assert.equal(formatAmount('abc', 'INR'), 'abc INR');
  assert.equal(formatAmount('5.000', 'NOT-A-CURRENCY'), '5.000 NOT-A-CURRENCY');
});

test('validation codes read as sentences; an unknown code still gets a safe sentence', () => {
  assert.match(validationMessage('amount_missing'), /Amount is empty/);
  assert.match(validationMessage('amount_precision'), /more decimals/);
  assert.match(validationMessage('something_new'), /not valid/);
  assert.equal(validationMessage(null), null);
  assert.equal(formatSize(366770), '358.2 KB');
  assert.equal(formatSize(12), '12 B');
  assert.equal(formatSize(NaN), '—');
});

test('the version to act on is the unpublished working one, then the live one, then the newest; the rest are listed newest first', () => {
  const v1 = q({ id: 1, versionNumber: 1, status: 'accepted', live: true });
  const v2 = q({ id: 2, versionNumber: 2, status: 'rejected' });
  const v3 = q({ id: 3, versionNumber: 3, status: 'draft' });
  assert.equal(splitVersions([v1, v2, v3]).primary.id, 3);
  assert.deepEqual(splitVersions([v1, v2, v3]).others.map((x) => x.id), [2, 1]);
  assert.equal(splitVersions([v1, v2]).primary.id, 1); // no working version: the live one
  assert.equal(splitVersions([v2, q({ id: 4, versionNumber: 4, status: 'withdrawn' })]).primary.id, 4); // nothing live: the newest
  assert.deepEqual(splitVersions([]), { primary: null, others: [] });
  assert.deepEqual(splitVersions(undefined), { primary: null, others: [] });
});

test('a clean valid draft offers Confirm (enabled) and Withdraw, and never Publish', () => {
  const buttons = actionButtons(q());
  assert.deepEqual(buttons.map((b) => [b.key, b.enabled]), [['confirm', true], ['withdraw', true]]);
});

test('a draft that cannot be confirmed shows Confirm DISABLED with the reasons the server gave', () => {
  const draft = q({ scanStatus: 'pending', amount: null, currency: null, validationError: 'amount_missing', actions: { canConfirm: false, canWithdraw: true, canViewFile: false, blockers: [
    { code: 'scan_not_clean', message: 'The file has not been scanned for malware yet.' }, { code: 'quotation_invalid', message: 'The final amount or currency is missing or invalid in Bitrix24.' },
  ] } });
  const [confirm] = actionButtons(draft);
  assert.equal(confirm.key, 'confirm');
  assert.equal(confirm.enabled, false);
  assert.match(confirm.why, /not been scanned/);
  assert.match(confirm.why, /missing or invalid/);
});

test('a confirmed version offers Publish (separate from Confirm); a published one only Withdraw', () => {
  assert.deepEqual(actionButtons(q({ status: 'confirmed', actions: { canPublish: true, canWithdraw: true, blockers: [] } })).map((b) => b.key), ['publish', 'withdraw']);
  assert.deepEqual(actionButtons(q({ status: 'published', actions: { canWithdraw: true, blockers: [] } })).map((b) => b.key), ['withdraw']);
});

test('accepted and rejected versions offer no state change except a NEW version when the server allows it', () => {
  assert.deepEqual(actionButtons(q({ status: 'accepted', actions: { canWithdraw: false, canCreateVersion: true, blockers: [] } })).map((b) => b.key), ['newVersion']);
  assert.deepEqual(actionButtons(q({ status: 'accepted', actions: { canWithdraw: false, canCreateVersion: false, blockers: [] } })), []);
  assert.deepEqual(actionButtons(q({ status: 'rejected', actions: { canWithdraw: false, canCreateVersion: false, blockers: [] } })), []);
  assert.deepEqual(actionButtons(q({ status: 'superseded', actions: {} })), []);
});

test('the Portal never invents an action: nothing the server did not allow is enabled', () => {
  assert.deepEqual(actionButtons(q({ actions: undefined })).map((b) => [b.key, b.enabled]), [['confirm', false]]);
  assert.equal(actionButtons(q({ status: 'confirmed', actions: { canPublish: false, blockers: [] } }))[0].enabled, false);
});

test('a withdrawal reason is mandatory: trimmed, 3 to 1000 characters', () => {
  assert.equal(validateReason('').ok, false);
  assert.equal(validateReason('  ab ').ok, false);
  assert.deepEqual(validateReason('  Wrong amount  '), { ok: true, value: 'Wrong amount' });
  assert.equal(validateReason('x'.repeat(1001)).ok, false);
  assert.equal(validateReason(undefined).ok, false);
  assert.equal(validateReason('x'.repeat(1000)).ok, true);
});

test('dialogs name the version, the amount and what happens next; publishing says the patient is notified', () => {
  const confirm = dialogCopy('confirm', q(), 'CASE-4037');
  assert.match(confirm.description, /CASE-4037 · Version 1/);
  assert.match(confirm.warning, /1,000\.00/);
  assert.match(confirm.warning, /does not see it yet/);
  assert.equal(dialogCopy('publish', q({ status: 'confirmed' }), 'CASE-4037').warning.includes('notified'), true);
  assert.equal(dialogCopy('withdraw', q({ status: 'confirmed' })).tone, 'danger');
  assert.match(dialogCopy('withdraw', q({ status: 'published' })).warning, /no longer see/);
  assert.match(dialogCopy('newVersion', q({ status: 'accepted' })).warning, /accept it again/);
  assert.equal(dialogCopy('mystery', q()).title, 'Are you sure?');
});

test('success messages distinguish "done" from "was already done"', () => {
  assert.match(successText('confirm', { alreadyConfirmed: false }, q()), /is confirmed/);
  assert.match(successText('confirm', { alreadyConfirmed: true }, q()), /already confirmed/);
  assert.match(successText('publish', { alreadyPublished: false }, q()), /patient has been notified/);
  assert.match(successText('publish', { alreadyPublished: true }, q()), /already published/);
  assert.match(successText('withdraw', {}, q()), /was withdrawn/);
  assert.match(successText('newVersion', {}, q({ versionNumber: 2 })), /from Version 2/);
});

test('the history lists what the server recorded, oldest first, with who did it; nothing is invented', () => {
  const entries = historyEntries(q({
    status: 'published', confirmedAt: '2026-11-19T11:00:00.000Z', confirmedBy: { id: 7, name: 'Asha Admin' },
    publishedAt: '2026-11-19T12:00:00.000Z', publishedBy: { id: 8, name: 'Ravi Super' }, validUntil: '2026-12-01T00:00:00.000Z',
  }));
  assert.deepEqual(entries.map((e) => e.key), ['received', 'scan', 'confirmed', 'published']);
  assert.equal(entries[2].by, 'Asha Admin');
  assert.equal(entries[3].by, 'Ravi Super');
  assert.match(entries[3].note, /Valid until/);
  assert.deepEqual(historyEntries(q({ scannedAt: null, createdAt: null })), []);
  const withdrawn = historyEntries(q({ status: 'withdrawn', withdrawnAt: '2026-11-20T09:00:00.000Z', withdrawnBy: { id: 7, name: null }, withdrawReason: 'Wrong amount' }));
  assert.equal(withdrawn.at(-1).label, 'Withdrawn');
  assert.equal(withdrawn.at(-1).by, 'Admin #7');
  assert.equal(withdrawn.at(-1).note, 'Wrong amount');
  const rejected = historyEntries(q({ status: 'rejected', decidedAt: '2026-11-20T10:00:00.000Z', rejectionReason: 'Too high' }));
  assert.equal(rejected.find((e) => e.key === 'decided').note, 'Too high');
});

test('failed calls: a changed version or a 404/409 refreshes the page; other errors stay on the dialog', () => {
  assert.deepEqual(errorNotice({ status: 409, code: 'quotation_changed', message: 'x' }).refresh, true);
  assert.match(errorNotice({ status: 409, code: 'quotation_changed', message: 'x' }).text, /reloaded/);
  const blocked = errorNotice({ status: 409, code: 'scan_not_clean', message: 'The file has not been scanned for malware yet.' });
  assert.equal(blocked.refresh, true);
  assert.equal(blocked.tone, 'warning');
  assert.match(blocked.text, /not been scanned/);
  assert.equal(errorNotice({ status: 404, message: 'Quotation not found' }).refresh, true);
  const server = errorNotice({ status: 500, message: 'Internal server error' }, 'The action');
  assert.equal(server.refresh, false);
  assert.equal(server.tone, 'error');
  assert.match(errorNotice(null, 'The PDF').text, /The PDF could not be completed/);
});
