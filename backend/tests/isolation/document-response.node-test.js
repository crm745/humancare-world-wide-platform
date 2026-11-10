// The safe Case-document shape, as a plain node:test file (like upload-dir-and-lock.node-test.js): no database, no Jest, no
// global setup, so it can run anywhere.
//
//   node --test tests/isolation/document-response.node-test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SAFE_DOCUMENT_SELECT, toSafeDocument } = require('../../src/modules/documents/document-response');

const row = {
  id: 7, caseId: 3, type: 'Medical Report', name: 'report.pdf', fileUrl: '/uploads/1699-secret-key.pdf', fileSizeBytes: 2048, uploadedAt: new Date('2026-11-02T09:00:00Z'),
  storageKey: 'secret-key', sha256: 'f'.repeat(64),
};

test('toSafeDocument keeps only the safe fields', () => {
  const safe = toSafeDocument(row);
  assert.deepEqual(Object.keys(safe).sort(), ['caseId', 'fileSizeBytes', 'id', 'name', 'type', 'uploadedAt']);
  assert.equal(safe.name, 'report.pdf');
  assert.equal(safe.fileSizeBytes, 2048);
  const text = JSON.stringify(safe);
  for (const secret of ['fileUrl', '/uploads/', 'secret-key', 'storageKey', 'sha256', 'ffffffff']) assert.ok(!text.includes(secret), secret);
});

test('toSafeDocument does not modify the row, so the internal fileUrl is still there for Bitrix24 and downloads', () => {
  toSafeDocument(row);
  assert.equal(row.fileUrl, '/uploads/1699-secret-key.pdf');
});

test('toSafeDocument passes a missing document through', () => {
  assert.equal(toSafeDocument(null), null);
  assert.equal(toSafeDocument(undefined), undefined);
});

test('the Prisma selection names the same safe fields and never the stored path', () => {
  assert.deepEqual(Object.keys(SAFE_DOCUMENT_SELECT).sort(), ['caseId', 'fileSizeBytes', 'id', 'name', 'type', 'uploadedAt']);
  assert.ok(Object.values(SAFE_DOCUMENT_SELECT).every((v) => v === true));
  assert.ok(!('fileUrl' in SAFE_DOCUMENT_SELECT));
});

// A guard on the code paths that build the responses: none of them may ask Prisma for whole `documents` rows again.
test('the Case and patient-request queries select safe document fields only', () => {
  const src = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', file), 'utf8');
  assert.match(src('cases/cases.service.js'), /documents: \{ select: SAFE_DOCUMENT_SELECT \}/);
  assert.doesNotMatch(src('cases/cases.service.js'), /documents: true\s*[,}]/);
  assert.match(src('requests/requests.service.js'), /documents: \{ select: SAFE_DOCUMENT_SELECT \}/);
  assert.doesNotMatch(src('requests/requests.service.js'), /documents: true\s*[,}]/);
  assert.match(src('requests/requests.service.js'), /select: \{ \.\.\.SAFE_DOCUMENT_SELECT/);
});

test('the download code still reads fileUrl internally', () => {
  const src = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', file), 'utf8');
  assert.match(src('documents/documents.controller.js'), /path\.basename\(document\.fileUrl\)/);
  assert.match(src('documents/documents.controller.js'), /findWorkflowSource\(document\.fileUrl\)/);
  assert.match(src('bitrix/bitrix.service.js'), /document\.fileUrl/);
});
