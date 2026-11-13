/* global describe, test, expect, __dirname */
const fs = require('fs');
const path = require('path');
const { formatSize, historyRows, documentsSummary } = require('../documentHistoryView');
const { formatDisplayDate } = require('../requestShape');

// Shaped like GET /requests/me/:id -> requestDocuments, plus fields the server must never send.
const doc = (over) => ({
  id: 1, originalName: 'report.pdf', sizeBytes: 2048, uploadedAt: '2026-11-01T12:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', reviewStatus: 'pending', rejectionReason: null,
  storageKey: 'abc123.pdf', sha256: 'f'.repeat(64), fileUrl: '/uploads/abc123.pdf', reviewedByAdminId: 7, ...over,
});

const PENDING = doc({ id: 1, scanStatus: 'pending' });
const REJECTED_OLD = doc({
  id: 2, originalName: 'blurry.jpg', sizeBytes: 3 * 1024 * 1024, uploadedAt: '2026-11-02T12:00:00.000Z',
  reviewStatus: 'rejected', rejectionReason: 'Please send a sharper copy.', supersededAt: '2026-11-03T12:00:00.000Z',
});
const REPLACEMENT = doc({ id: 3, originalName: 'sharp.jpg', uploadedAt: '2026-11-03T12:00:00.000Z', replacesId: 2 });
const INFECTED = doc({ id: 4, originalName: 'bad.pdf', uploadedAt: '2026-11-04T12:00:00.000Z', scanStatus: 'infected' });

const workflow = (requestDocuments, over) => ({ reviewStatus: 'in_review', requestDocuments, case: null, ...over });
const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

describe('formatSize', () => {
  test('KB below 1 MB, MB above, nothing for an unknown size', () => {
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(10)).toBe('1 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatSize(0)).toBe('');
    expect(formatSize(null)).toBe('');
    expect(formatSize(undefined)).toBe('');
  });
});

describe('historyRows', () => {
  const rows = historyRows([REPLACEMENT, PENDING, INFECTED, REJECTED_OLD]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  test('lists every version, current and superseded, oldest first', () => {
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.superseded)).toEqual([false, true, false, false]);
  });

  test('shows file name, size and upload date', () => {
    expect(byId[2].name).toBe('blurry.jpg');
    expect(byId[2].meta).toBe(`3.0 MB · ${formatDisplayDate(REJECTED_OLD.uploadedAt)}`);
    expect(byId[1].meta).toBe(`2 KB · ${formatDisplayDate(PENDING.uploadedAt)}`);
  });

  test('shows a patient-friendly status for scan and review', () => {
    expect(byId[1].statusLabel).toBe('Being checked');
    expect(byId[3].statusLabel).toBe('Waiting for review');
    expect(byId[4].statusLabel).toBe("Couldn't be accepted");
    expect(byId[4].statusLabel).not.toMatch(/virus|infect|malware|scan/i);
    expect(historyRows([doc({ reviewStatus: 'approved' })])[0].statusLabel).toBe('Approved');
  });

  test('a rejected current document asks for a replacement; a replaced one just reads Rejected', () => {
    const current = historyRows([doc({ id: 9, reviewStatus: 'rejected', rejectionReason: 'Wrong patient.' })])[0];
    expect(current.statusLabel).toBe('Needs to be replaced');
    expect(byId[2].statusLabel).toBe('Rejected');
  });

  test('shows the rejection reason when there is one, and only then', () => {
    expect(byId[2].reason).toBe('Please send a sharper copy.');
    expect(byId[1].reason).toBeNull();
    expect(byId[4].reason).toBeNull();
  });

  test('a document whose scan failed for good reads as an action for the patient', () => {
    const [row] = historyRows([doc({ id: 20, originalName: 'lost.pdf', scanStatus: 'failed' })]);
    expect(row).toMatchObject({ status: 'scan_failed', statusLabel: "Couldn't be checked", statusClass: 'text-danger', reason: null, superseded: false });
    expect(row.guidance).toBe("We couldn't check this file. Please upload a replacement.");
  });

  test('guidance is shown for a current file that needs replacing, and not for the earlier version', () => {
    const failedOld = doc({ id: 21, originalName: 'lost.pdf', uploadedAt: '2026-11-01T12:00:00Z', scanStatus: 'failed', supersededAt: '2026-11-02T12:00:00Z' });
    const replacement = doc({ id: 22, originalName: 'found.pdf', uploadedAt: '2026-11-02T12:00:00Z', replacesId: 21 });
    const [oldRow, newRow] = historyRows([failedOld, replacement]);
    expect(oldRow).toMatchObject({ guidance: null, superseded: true, statusLabel: "Couldn't be checked" });
    expect(oldRow.notes).toEqual(['Replaced by found.pdf']);
    expect(newRow).toMatchObject({ guidance: null, status: 'awaiting_review' });
    expect(byId[4].guidance).toBe("This file couldn't be accepted. Please upload a different file."); // infected
    expect(byId[1].guidance).toBeNull(); // still being checked
  });

  test('every other status keeps its own label and colour', () => {
    const rows = historyRows([
      doc({ id: 30, scanStatus: 'pending' }), doc({ id: 31, scanStatus: 'error' }), doc({ id: 32 }),
      doc({ id: 33, reviewStatus: 'approved' }), doc({ id: 34, scanStatus: 'infected' }),
    ]);
    expect(rows.map((r) => [r.status, r.statusLabel, r.statusClass])).toEqual([
      ['checking', 'Being checked', 'text-faint'],
      ['checking', 'Being checked', 'text-faint'],
      ['awaiting_review', 'Waiting for review', 'text-primary'],
      ['approved', 'Approved', 'text-success'],
      ['unsafe', "Couldn't be accepted", 'text-danger'],
    ]);
  });

  test('shows which version replaces which, in both directions', () => {
    expect(byId[3].notes).toEqual(['Replaces blurry.jpg']);
    expect(byId[2].notes).toEqual(['Replaced by sharp.jpg']);
    expect(byId[1].notes).toEqual([]);
  });

  test('a version in the middle of a chain names both neighbours', () => {
    const a = doc({ id: 10, originalName: 'v1.pdf', uploadedAt: '2026-11-01T12:00:00Z', supersededAt: '2026-11-02T12:00:00Z', reviewStatus: 'rejected' });
    const b = doc({ id: 11, originalName: 'v2.pdf', uploadedAt: '2026-11-02T12:00:00Z', supersededAt: '2026-11-03T12:00:00Z', reviewStatus: 'rejected', replacesId: 10 });
    const c = doc({ id: 12, originalName: 'v3.pdf', uploadedAt: '2026-11-03T12:00:00Z', replacesId: 11 });
    const [, middle] = historyRows([c, a, b]);
    expect(middle.notes).toEqual(['Replaces v1.pdf', 'Replaced by v3.pdf']);
  });

  test('has no row field that could carry storage information, and none of it leaks into the text', () => {
    const SAFE = ['id', 'name', 'meta', 'status', 'statusLabel', 'statusClass', 'reason', 'guidance', 'notes', 'superseded'];
    for (const row of rows) expect(Object.keys(row).sort()).toEqual([...SAFE].sort());
    const text = JSON.stringify(rows);
    for (const secret of ['storageKey', 'abc123.pdf', 'sha256', 'ffffffff', 'fileUrl', '/uploads/', 'reviewedByAdminId']) {
      expect(text).not.toContain(secret);
    }
  });

  test('copes with no documents or odd input', () => {
    expect(historyRows(undefined)).toEqual([]);
    expect(historyRows([{ id: 1 }])[0]).toMatchObject({ name: 'Document', meta: '' });
  });
});

describe('documentsSummary', () => {
  test('a workflow request lists requestDocuments, not the Case', () => {
    const request = workflow([PENDING, REJECTED_OLD, REPLACEMENT], { case: { documents: [{ name: 'case-file.pdf' }] } });
    // current versions only: report.pdf and sharp.jpg (blurry.jpg was replaced)
    expect(documentsSummary(request)).toMatch(/^report\.pdf \+1/);
    expect(documentsSummary(request)).not.toContain('case-file');
  });

  test('a workflow request with one current document names it; with none it says so', () => {
    expect(documentsSummary(workflow([PENDING], { case: { documents: [{ name: 'c.pdf' }] } }))).toBe('report.pdf >');
    expect(documentsSummary(workflow([PENDING]))).toBe('report.pdf >');
    expect(documentsSummary(workflow([]))).toBe('No documents yet');
    expect(documentsSummary(workflow(undefined))).toBe('No documents yet');
  });

  test('older requests and other services keep the Case documents behaviour exactly', () => {
    const legacy = { reviewStatus: null, case: { documents: [{ name: 'one.pdf' }, { name: 'two.pdf' }, { name: 'three.pdf' }] } };
    expect(documentsSummary(legacy)).toBe('one.pdf +2 >');
    expect(documentsSummary({ case: { documents: [{ name: 'one.pdf' }] } })).toBe('one.pdf >');
    expect(documentsSummary({ case: { documents: [] } })).toBe('No documents yet');
    expect(documentsSummary({ case: null })).toBe('No documents yet');
    expect(documentsSummary({})).toBe('No documents yet');
  });

  test('a legacy request ignores requestDocuments', () => {
    expect(documentsSummary({ reviewStatus: null, requestDocuments: [PENDING], case: null })).toBe('No documents yet');
  });
});

describe('wiring (source checks)', () => {
  const screen = read('../../app/request-details.js');
  const history = read('../../components/request/DocumentHistory.js');
  const banner = read('../../components/request/ReviewBanner.js');

  test('the screen shows the banner, the history and the upload card, and refreshes them all from one reload', () => {
    expect(screen).toMatch(/if \(s\.kind === 'review'\) return <ReviewBanner request=\{request\} \/>;/);
    expect(screen).toMatch(/<DocumentHistory request=\{request\} styled \/>/);
    expect(screen).toMatch(/<AdditionalDocuments request=\{request\} onUploaded=\{reload\} \/>/);
    expect(screen).toMatch(/const reload = \(\) => apiGet\(`\/requests\/me\/\$\{id\}`\)\s*\.then\(\(\{ request: r \}\) => setRequest\(r\)\)/);
  });

  test('the Documents section lists every file of the request (documentRows), and only a Case document opens', () => {
    expect(screen).toMatch(/const view = request \? detailsView\(request, t\) : null;/);
    expect(screen).toMatch(/const docs = view\.documents;/);
    expect(screen).toMatch(/downloadAndShare\(`\/documents\/\$\{doc\.id\}\/file`, doc\.name\)/);
    expect(screen).not.toMatch(/request\.case\?\.documents/);
  });

  test('document rows cannot be opened or downloaded', () => {
    expect(history).not.toMatch(/onPress|Pressable|downloadAndShare|Linking|router/);
  });

  test('the history and banner render nothing outside the workflow', () => {
    expect(history).toMatch(/if \(reviewState\(request\) === null\) return null;/);
    expect(banner).toMatch(/if \(!banner\) return null;/);
  });

  test('the upload card offers Replace from canReplace only', () => {
    const card = read('../../components/request/AdditionalDocuments.js');
    expect(card).toMatch(/documentHistory\(documents\)\.filter\(\(d\) => d\.canReplace\)/);
  });

  test('the guidance for a failed or unaccepted file is shown in the history and on the Replace card', () => {
    const card = read('../../components/request/AdditionalDocuments.js');
    expect(card).toMatch(/doc\.rejectionReason \|\| doc\.guidance \|\| doc\.statusLabel/);
    expect(read('../../components/request/DocumentHistory.js')).toMatch(/\{!!row\.guidance && /);
  });
});
