import test from 'node:test';
import assert from 'node:assert/strict';
import { caseSource, caseStatusLabel, documentView, filterCases, linkedRequest, pageOf, sortStageEvents, sourceDocumentFor, validCaseId } from './caseView.mjs';

const c = (over = {}) => ({ id: 1, referenceNumber: 'CASE-1001', patientName: 'Maria Fernandez', serviceType: 'Private Charter', origin: 'Mumbai', destination: 'Dubai', country: 'AE', corporateId: null, ...over });

test('status labels fall back to a readable form', () => {
  assert.equal(caseStatusLabel('in_progress'), 'In progress');
  assert.equal(caseStatusLabel('on_hold'), 'on hold');
  assert.equal(caseStatusLabel(null), 'Unknown');
});

test('source: corporate name, corporate id, or patient request', () => {
  assert.equal(caseSource(c({ corporateId: 4, corporate: { id: 4, companyName: 'Acme' } })), 'Acme');
  assert.equal(caseSource(c({ corporateId: 4 })), 'Corporate #4');
  assert.equal(caseSource(c()), 'Patient request');
});

test('search matches reference, patient, service, route and source; empty keeps all', () => {
  const list = [c(), c({ id: 2, referenceNumber: 'CASE-1002', patientName: 'John Doe', origin: 'Delhi', corporateId: 4, corporate: { id: 4, companyName: 'Acme' } })];
  assert.equal(filterCases(list, '').length, 2);
  assert.deepEqual(filterCases(list, 'case-1002').map((x) => x.id), [2]);
  assert.deepEqual(filterCases(list, ' maria ').map((x) => x.id), [1]);
  assert.deepEqual(filterCases(list, 'acme').map((x) => x.id), [2]);
  assert.deepEqual(filterCases(list, 'delhi').map((x) => x.id), [2]);
  assert.equal(filterCases(list, 'zzz').length, 0);
});

test('paging slices the list', () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(pageOf(items, 0).length, 25);
  assert.equal(pageOf(items, 25).length, 5);
});

test('only a numeric id or a CASE- reference is a valid case id', () => {
  assert.equal(validCaseId('12'), '12');
  assert.equal(validCaseId('CASE-1042'), 'CASE-1042');
  assert.equal(validCaseId('../x'), null);
  assert.equal(validCaseId('12abc'), null);
  assert.equal(validCaseId(undefined), null);
});

test('linked request exists only for patient-request Cases', () => {
  assert.deepEqual(linkedRequest({ serviceRequest: { id: 7, referenceNumber: 'REQ-1007', userId: 9 } }), { id: 7, referenceNumber: 'REQ-1007' });
  assert.equal(linkedRequest({ serviceRequest: null }), null);
  assert.equal(linkedRequest({}), null);
});

test('stage events are oldest first', () => {
  const out = sortStageEvents([{ id: 2, occurredAt: '2026-11-02T00:00:00Z' }, { id: 1, occurredAt: '2026-11-03T00:00:00Z' }, { id: 3, occurredAt: '2026-11-02T00:00:00Z' }]);
  assert.deepEqual(out.map((e) => e.id), [2, 3, 1]);
});

test('a document view never carries the stored path', () => {
  const v = documentView({ id: 5, name: 'report.pdf', type: 'Medical Report', fileUrl: '/uploads/secret-key.pdf', fileSizeBytes: 2048, uploadedAt: 'x', storageKey: 'k', checksum: 'abc' });
  assert.deepEqual(Object.keys(v).sort(), ['id', 'name', 'sizeBytes', 'type', 'uploadedAt']);
  assert.ok(!JSON.stringify(v).includes('secret-key'));
});

test('a Case document is matched to its source request document by caseDocumentId', () => {
  const rds = [{ id: 1, caseDocumentId: null }, { id: 2, caseDocumentId: 5 }];
  assert.equal(sourceDocumentFor({ id: 5 }, rds).id, 2);
  assert.equal(sourceDocumentFor({ id: 6 }, rds), null);
});
