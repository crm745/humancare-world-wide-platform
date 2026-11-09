import test from 'node:test';
import assert from 'node:assert/strict';
import { backLabel, backTarget, careLevelLabel, documentView, equipmentList, eventView, formatBytes, sortEvents } from './requestDetails.mjs';

const doc = (over = {}) => ({
  id: 1, originalName: 'report.pdf', sizeBytes: 2048, mimeType: 'application/pdf', uploadedAt: '2026-11-01T10:00:00Z', replacesId: null, supersededAt: null,
  scanStatus: 'clean', scanDetail: null, scannedAt: '2026-11-01T10:00:05Z', reviewStatus: 'pending', reviewedByAdminId: null, reviewedAt: null, rejectionReason: null, ...over,
});

test('care level keys become labels; anything else is shown as stored', () => {
  assert.equal(careLevelLabel('care_icu,care_stable'), 'ICU / Critical, Stable / Monitored');
  assert.equal(careLevelLabel('care_icu, care_ambulatory'), 'ICU / Critical, Ambulatory');
  assert.equal(careLevelLabel('Needs a nurse'), 'Needs a nurse');
  assert.equal(careLevelLabel(null), null);
  assert.equal(careLevelLabel(''), null);
});

test('equipment lists only what is true', () => {
  assert.deepEqual(equipmentList({ equipOxygen: true, equipCardiacMonitor: false, equipVentilator: null }), ['Oxygen']);
  assert.deepEqual(equipmentList({}), []);
});

test('file sizes', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(undefined), null);
});

test('document severity: infected > scan error > rejected > normal, and superseded keeps its own', () => {
  assert.equal(documentView(doc({ scanStatus: 'infected' }), []).severity, 'infected');
  assert.equal(documentView(doc({ scanStatus: 'infected' }), []).scan.prominent, true);
  assert.equal(documentView(doc({ scanStatus: 'error', scanDetail: 'the stored file is missing' }), []).severity, 'scan_error');
  assert.equal(documentView(doc({ reviewStatus: 'rejected', rejectionReason: 'Blurry' }), []).severity, 'rejected');
  assert.equal(documentView(doc({ reviewStatus: 'approved' }), []).severity, 'normal');
  const old = documentView(doc({ reviewStatus: 'rejected', supersededAt: '2026-11-02T00:00:00Z' }), []);
  assert.deepEqual([old.severity, old.superseded], ['rejected', true]);
});

test('replacement relationship is read in both directions', () => {
  const original = doc({ id: 1, originalName: 'old.pdf', supersededAt: '2026-11-02T00:00:00Z', reviewStatus: 'rejected' });
  const replacement = doc({ id: 2, originalName: 'new.pdf', replacesId: 1 });
  const all = [original, replacement];
  assert.deepEqual(documentView(replacement, all).replaces, { id: 1, name: 'old.pdf' });
  assert.deepEqual(documentView(original, all).replacedBy, { id: 2, name: 'new.pdf' });
  assert.equal(documentView(original, all).replaces, null);
  // A replaced document that is not in the list is still named by id, never invented.
  assert.deepEqual(documentView(doc({ id: 5, replacesId: 99 }), [doc({ id: 5, replacesId: 99 })]).replaces, { id: 99, name: null });
});

test('review state is not offered for a document that has not scanned clean', () => {
  assert.match(documentView(doc({ scanStatus: 'pending' }), []).review.label, /Not reviewable/);
  assert.equal(documentView(doc({ scanStatus: 'clean' }), []).review.label, 'Awaiting review');
  assert.equal(documentView(doc({ scanStatus: 'clean', reviewStatus: 'approved', reviewedByAdminId: 4 }), []).reviewedBy, 'Admin #4');
});

test('missing optional document fields stay missing', () => {
  const v = documentView({ id: 1, originalName: 'a.pdf', scanStatus: 'clean', reviewStatus: 'pending' }, []);
  assert.deepEqual([v.size, v.mimeType, v.rejectionReason, v.reviewedBy, v.scanDetail], [null, null, null, null, null]);
});

test('events are sorted oldest first, ties by id', () => {
  const sorted = sortEvents([
    { id: 3, occurredAt: '2026-11-01T10:00:00Z' }, { id: 1, occurredAt: '2026-11-01T09:00:00Z' }, { id: 2, occurredAt: '2026-11-01T10:00:00Z' },
  ]);
  assert.deepEqual(sorted.map((e) => e.id), [1, 2, 3]);
});

test('every known event reads as plain text, with facts only from its detail', () => {
  const documents = [doc({ id: 1, originalName: 'old.pdf' }), doc({ id: 2, originalName: 'new.pdf', replacesId: 1 })];
  const ctx = { documents, user: { id: 9, name: 'Maria Fernandez' } };
  const ev = (action, over = {}) => eventView({ id: 1, action, actorType: 'system', occurredAt: 'x', ...over }, ctx);

  assert.equal(ev('request_created', { actorType: 'patient', actorId: 9, detail: { referenceNumber: 'REQ-1001' } }).title, 'Request created');
  assert.deepEqual(ev('document_uploaded', { documentId: 1, detail: { name: 'old.pdf', sizeBytes: 2048 } }).lines, ['old.pdf', '2.0 KB']);
  assert.deepEqual(ev('document_replaced', { documentId: 2, detail: { name: 'new.pdf', replacesId: 1 } }).lines, ['new.pdf', 'Replaces "old.pdf"']);
  assert.equal(ev('scan_clean', { documentId: 1 }).tone, 'success');
  assert.equal(ev('scan_infected', { documentId: 1, detail: { detail: 'Eicar-Test' } }).tone, 'danger');
  assert.deepEqual(ev('scan_error', { documentId: 1, detail: { detail: 'scanner unavailable' } }).lines, ['old.pdf', 'scanner unavailable']);
  assert.equal(ev('document_approved', { documentId: 1, actorType: 'admin', actorId: 4 }).title, 'Document approved');
  assert.deepEqual(ev('document_rejected', { documentId: 1, detail: { reason: 'Blurry' } }).lines, ['old.pdf', 'Reason: Blurry']);
  assert.deepEqual(ev('documents_requested', { detail: { reason: 'Add the certificate' } }).lines, ['Reason: Add the certificate']);
  assert.deepEqual(ev('status_changed', { fromStatus: 'awaiting_documents', toStatus: 'in_review' }).lines, ['Draft → In review']);
  assert.deepEqual(ev('request_approved', { detail: { documents: 2 } }).lines, ['2 documents attached to the Case']);
  assert.deepEqual(ev('case_created', { detail: { caseId: 7, caseReference: 'CASE-1007' } }).lines, ['CASE-1007']);
  assert.equal(ev('something_new').title, 'Something new');
});

test('actors: Admin only by id, the patient by name only when the account matches, system as System', () => {
  const ctx = { documents: [], user: { id: 9, name: 'Maria Fernandez' } };
  const actor = (event) => eventView({ id: 1, action: 'x', occurredAt: 'x', ...event }, ctx).actor;
  assert.equal(actor({ actorType: 'admin', actorId: 7 }), 'Admin #7');
  assert.equal(actor({ actorType: 'patient', actorId: 9 }), 'Patient (Maria Fernandez)');
  assert.equal(actor({ actorType: 'patient', actorId: 10 }), 'Patient');
  assert.equal(actor({ actorType: 'system', actorId: null }), 'System');
});

test('events with no detail do not crash and add no lines', () => {
  const view = eventView({ id: 1, action: 'document_uploaded', actorType: 'patient', occurredAt: 'x', detail: null }, {});
  assert.deepEqual(view.lines, []);
});

test('back target: from the list it came from, otherwise by status', () => {
  assert.equal(backTarget({ reviewStatus: 'in_review' }, undefined), '/requests');
  assert.equal(backTarget({ reviewStatus: 'awaiting_documents' }, undefined), '/requests/drafts');
  assert.equal(backTarget({ reviewStatus: 'in_review' }, '/requests/drafts'), '/requests/drafts');
  assert.equal(backTarget({ reviewStatus: 'in_review' }, 'https://evil.example'), '/requests');
  assert.equal(backLabel('/requests/drafts'), 'Drafts');
  assert.equal(backLabel('/requests'), 'Incomplete Submissions');
});

test('a scan that failed for good is shown as its own state, not as a retried error', () => {
  const view = documentView(doc({ scanStatus: 'failed', scanDetail: 'the stored file is missing' }), []);
  assert.equal(view.severity, 'scan_failed');
  assert.deepEqual(view.scan, { label: 'Scan failed', tone: 'danger' });
  assert.equal(view.review.label, 'Not reviewable until scanned clean');
  // infected still outranks it, and a retryable error keeps its own look
  assert.equal(documentView(doc({ scanStatus: 'error' }), []).severity, 'scan_error');
  assert.equal(documentView(doc({ scanStatus: 'infected' }), []).severity, 'infected');
});

test('the timeline names the permanent scan failure and keeps its reason', () => {
  const event = eventView({ id: 1, action: 'scan_failed', documentId: 1, detail: { engine: 'clamav', detail: 'the stored file is missing' }, occurredAt: '2026-11-02T00:00:00Z', actorType: 'system' }, { documents: [doc()] });
  assert.equal(event.title, 'Virus scan failed for good');
  assert.equal(event.tone, 'danger');
  assert.deepEqual(event.lines, ['report.pdf', 'the stored file is missing']);
});
