/* global describe, test, expect */
const {
  MAX_DOCUMENTS_PER_REQUEST, DOCUMENT_STATUS, reviewState, reviewBanner, reviewPill, documentStatus, documentHistory, uploadBlockReason, canUploadMore,
} = require('../requestDocuments');

// Shaped like GET /requests/me/:id -> requestDocuments (PATIENT_DOCUMENT_SELECT), plus the fields the
// server must never send, to prove none of them gets through.
const doc = (over) => ({
  id: 1, originalName: 'report.pdf', sizeBytes: 2048, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', reviewStatus: 'pending', rejectionReason: null,
  storageKey: 'abc123.pdf', sha256: 'f'.repeat(64), fileUrl: '/uploads/abc123.pdf', reviewedByAdminId: 7, scanDetail: 'stream: OK', ...over,
});

const PENDING = doc({ id: 1, scanStatus: 'pending' });
const CLEAN = doc({ id: 2, originalName: 'scan.png', uploadedAt: '2026-11-02T10:00:00.000Z' });
const REJECTED_OLD = doc({
  id: 3, originalName: 'blurry.jpg', uploadedAt: '2026-11-03T10:00:00.000Z',
  reviewStatus: 'rejected', rejectionReason: 'Please send a sharper copy.', supersededAt: '2026-11-04T10:00:00.000Z',
});
const REPLACEMENT = doc({ id: 4, originalName: 'sharp.jpg', uploadedAt: '2026-11-04T10:00:00.000Z', replacesId: 3 });

const request = (reviewStatus) => ({ reviewStatus });

describe('reviewState', () => {
  test.each([
    ['changes_requested', 'waiting_patient'],
    ['awaiting_documents', 'waiting_patient'],
    ['in_review', 'under_review'],
    ['approved', 'approved'],
  ])('%s -> %s', (status, expected) => {
    expect(reviewState(request(status))).toBe(expected);
  });

  test('a request outside the workflow has no state', () => {
    expect(reviewState({ reviewStatus: null })).toBeNull();
    expect(reviewState({})).toBeNull();
    expect(reviewState(null)).toBeNull();
    expect(reviewState(undefined)).toBeNull();
    expect(reviewState(request('something_new'))).toBeNull();
  });
});

describe('documentStatus', () => {
  test('pending scan and scan error read as being checked', () => {
    expect(documentStatus(doc({ scanStatus: 'pending' }))).toBe(DOCUMENT_STATUS.checking);
    expect(documentStatus(doc({ scanStatus: 'error' }))).toBe(DOCUMENT_STATUS.checking);
  });
  test('clean and not yet decided is waiting for review', () => {
    expect(documentStatus(doc())).toBe(DOCUMENT_STATUS.awaiting_review);
  });
  test('clean and approved is approved', () => {
    expect(documentStatus(doc({ reviewStatus: 'approved' }))).toBe(DOCUMENT_STATUS.approved);
  });
  test('rejected is rejected', () => {
    expect(documentStatus(doc({ reviewStatus: 'rejected' }))).toBe(DOCUMENT_STATUS.rejected);
  });
  test('an infected file is never shown as anything else, and its wording does not name a virus', () => {
    const status = documentStatus(doc({ scanStatus: 'infected', reviewStatus: 'approved' }));
    expect(status).toBe(DOCUMENT_STATUS.unsafe);
    expect(status.label).not.toMatch(/virus|infect|malware|scan/i);
  });
  test('every scan status has an explicit reading', () => {
    // pending and error (the server retries) = being checked; clean = waiting for review; infected = couldn't be accepted;
    // failed (the server gave up) = couldn't be checked.
    expect(documentStatus(doc({ scanStatus: 'pending' })).key).toBe('checking');
    expect(documentStatus(doc({ scanStatus: 'error' })).key).toBe('checking');
    expect(documentStatus(doc({ scanStatus: 'clean' })).key).toBe('awaiting_review');
    expect(documentStatus(doc({ scanStatus: 'infected' })).key).toBe('unsafe');
    expect(documentStatus(doc({ scanStatus: 'failed' })).key).toBe('scan_failed');
  });
  test('a scan that failed for good is not "being checked": nothing is on its way', () => {
    const status = documentStatus(doc({ scanStatus: 'failed' }));
    expect(status).toBe(DOCUMENT_STATUS.scan_failed);
    expect(status).not.toBe(DOCUMENT_STATUS.checking);
    expect(status.label).toBe("Couldn't be checked");
  });
  test('a failed scan is never shown as approved or waiting for review, whatever the review says', () => {
    for (const reviewStatus of ['pending', 'approved']) {
      expect(documentStatus(doc({ scanStatus: 'failed', reviewStatus }))).toBe(DOCUMENT_STATUS.scan_failed);
    }
  });
  test('the wording for a failed scan never names a virus, a scan result or a file location', () => {
    expect(DOCUMENT_STATUS.scan_failed.label).not.toMatch(/virus|infect|malware|scan|checksum|storage|missing|path/i);
  });
  test('approved without a clean scan is not shown as approved', () => {
    expect(documentStatus(doc({ scanStatus: 'pending', reviewStatus: 'approved' }))).toBe(DOCUMENT_STATUS.checking);
  });
  test('missing or unknown data falls back to being checked', () => {
    expect(documentStatus(undefined)).toBe(DOCUMENT_STATUS.checking);
    expect(documentStatus({ scanStatus: 'weird' })).toBe(DOCUMENT_STATUS.checking);
  });
});

describe('documentHistory', () => {
  test('keeps every version, current and superseded, oldest first', () => {
    const history = documentHistory([REPLACEMENT, CLEAN, REJECTED_OLD, PENDING]);
    expect(history.map((d) => d.id)).toEqual([1, 2, 3, 4]);
    expect(history.map((d) => d.isCurrent)).toEqual([true, true, false, true]);
  });

  test('keeps the replacement relationship in both directions', () => {
    const [, , replaced, replacement] = documentHistory([PENDING, CLEAN, REJECTED_OLD, REPLACEMENT]);
    expect(replaced.replacedById).toBe(4);
    expect(replaced.replacesId).toBeNull();
    expect(replacement.replacesId).toBe(3);
    expect(replacement.replacedById).toBeNull();
  });

  test('a chain of replacements links each version to the next', () => {
    const a = doc({ id: 10, uploadedAt: '2026-11-01T00:00:00Z', supersededAt: '2026-11-02T00:00:00Z', reviewStatus: 'rejected' });
    const b = doc({ id: 11, uploadedAt: '2026-11-02T00:00:00Z', supersededAt: '2026-11-03T00:00:00Z', reviewStatus: 'rejected', replacesId: 10 });
    const c = doc({ id: 12, uploadedAt: '2026-11-03T00:00:00Z', replacesId: 11 });
    const [h1, h2, h3] = documentHistory([c, a, b]);
    expect([h1.replacedById, h2.replacedById, h3.replacedById]).toEqual([11, 12, null]);
    expect([h1.isCurrent, h2.isCurrent, h3.isCurrent]).toEqual([false, false, true]);
  });

  test('a replaces id that points at no known document is dropped', () => {
    const [item] = documentHistory([doc({ id: 5, replacesId: 999 })]);
    expect(item.replacesId).toBeNull();
  });

  test('sorts by upload date, then by id, whatever order the server sent', () => {
    const same = '2026-11-05T10:00:00.000Z';
    const history = documentHistory([doc({ id: 9, uploadedAt: same }), doc({ id: 7, uploadedAt: same }), doc({ id: 8, uploadedAt: '2026-11-01T00:00:00Z' })]);
    expect(history.map((d) => d.id)).toEqual([8, 7, 9]);
  });

  test('does not change the list it is given', () => {
    const input = [CLEAN, PENDING];
    documentHistory(input);
    expect(input.map((d) => d.id)).toEqual([2, 1]);
  });

  test('shows the rejection reason only on a rejected document', () => {
    const history = documentHistory([
      REJECTED_OLD,
      doc({ id: 20, uploadedAt: '2026-12-01T00:00:00Z', rejectionReason: 'left over text' }),
    ]);
    expect(history[0].rejectionReason).toBe('Please send a sharper copy.');
    expect(history[1].rejectionReason).toBeNull();
  });

  test('only a rejected or infected, current document can be replaced', () => {
    const rejectedCurrent = doc({ id: 30, reviewStatus: 'rejected', rejectionReason: 'Wrong patient.' });
    const infectedCurrent = doc({ id: 31, scanStatus: 'infected' });
    const history = documentHistory([PENDING, CLEAN, REJECTED_OLD, rejectedCurrent, infectedCurrent]);
    expect(history.filter((d) => d.canReplace).map((d) => d.id)).toEqual([30, 31]);
  });

  test('a current document whose scan failed for good can be replaced, and is told how', () => {
    const failed = doc({ id: 70, scanStatus: 'failed' });
    const [item] = documentHistory([failed]);
    expect(item).toMatchObject({ status: 'scan_failed', statusLabel: "Couldn't be checked", canReplace: true, rejectionReason: null });
    expect(item.guidance).toBe("We couldn't check this file. Please upload a replacement.");
  });

  test('an infected document is told to send a different file, in words that do not name the virus', () => {
    const [item] = documentHistory([doc({ id: 71, scanStatus: 'infected' })]);
    expect(item).toMatchObject({ status: 'unsafe', canReplace: true });
    expect(item.guidance).toBe("This file couldn't be accepted. Please upload a different file.");
    expect(item.guidance).not.toMatch(/virus|infect|malware|signature|scan/i);
  });

  test('only documents that need a new file carry guidance', () => {
    const approved = doc({ id: 72, reviewStatus: 'approved' });
    const rejected = doc({ id: 73, reviewStatus: 'rejected', rejectionReason: 'Wrong patient.' });
    const history = documentHistory([PENDING, CLEAN, approved, rejected, doc({ id: 74, scanStatus: 'error' })]);
    expect(history.map((d) => d.guidance)).toEqual([null, null, null, null, null]);
  });

  test('a replaced failed version is history: no guidance and no Replace', () => {
    const old = doc({ id: 75, scanStatus: 'failed', supersededAt: '2026-11-05T00:00:00Z' });
    const newer = doc({ id: 76, uploadedAt: '2026-11-05T00:00:00.000Z', replacesId: 75 });
    const [first, second] = documentHistory([old, newer]);
    expect(first).toMatchObject({ status: 'scan_failed', canReplace: false, guidance: null, isCurrent: false, replacedById: 76 });
    expect(second).toMatchObject({ canReplace: false, replacesId: 75 });
  });

  test('a replaced version is never offered for replacement, rejected or infected', () => {
    const infectedOld = doc({ id: 40, scanStatus: 'infected', supersededAt: '2026-11-05T00:00:00Z' });
    const history = documentHistory([REJECTED_OLD, infectedOld]);
    expect(history.map((d) => d.canReplace)).toEqual([false, false]);
  });

  test('pending, being-checked, waiting and approved documents are not offered for replacement', () => {
    const approved = doc({ id: 50, reviewStatus: 'approved' });
    const errored = doc({ id: 51, scanStatus: 'error' });
    expect(documentHistory([PENDING, CLEAN, approved, errored]).some((d) => d.canReplace)).toBe(false);
  });

  test('an infected document shows no rejection reason of its own', () => {
    const [item] = documentHistory([doc({ id: 60, scanStatus: 'infected', rejectionReason: 'internal text' })]);
    expect(item.status).toBe('unsafe');
    expect(item.rejectionReason).toBeNull();
  });

  test('status and label come from documentStatus', () => {
    const history = documentHistory([PENDING, CLEAN]);
    expect(history[0]).toMatchObject({ status: 'checking', statusLabel: DOCUMENT_STATUS.checking.label });
    expect(history[1]).toMatchObject({ status: 'awaiting_review', statusLabel: DOCUMENT_STATUS.awaiting_review.label });
  });

  test('returns only the safe display fields', () => {
    const SAFE = ['id', 'name', 'sizeBytes', 'uploadedAt', 'isCurrent', 'replacesId', 'replacedById', 'status', 'statusLabel', 'rejectionReason', 'guidance', 'canReplace'];
    for (const item of documentHistory([PENDING, CLEAN, REJECTED_OLD, REPLACEMENT])) {
      expect(Object.keys(item).sort()).toEqual([...SAFE].sort());
    }
  });

  test('never exposes storage names, checksums, file urls, reviewer ids or scan details', () => {
    const text = JSON.stringify(documentHistory([PENDING, CLEAN, REJECTED_OLD, REPLACEMENT]));
    for (const secret of ['storageKey', 'abc123.pdf', 'sha256', 'ffffffff', 'fileUrl', '/uploads/', 'reviewedByAdminId', 'scanDetail', 'stream: OK']) {
      expect(text).not.toContain(secret);
    }
  });

  test('a failed document shows no scan detail, storage name or checksum either', () => {
    const text = JSON.stringify(documentHistory([doc({ id: 80, scanStatus: 'failed', scanDetail: 'the stored file is missing' })]));
    for (const secret of ['storageKey', 'abc123.pdf', 'sha256', 'ffffffff', 'fileUrl', '/uploads/', 'scanDetail', 'the stored file is missing']) {
      expect(text).not.toContain(secret);
    }
  });

  test('copes with missing or odd input', () => {
    expect(documentHistory(undefined)).toEqual([]);
    expect(documentHistory(null)).toEqual([]);
    expect(documentHistory([null, {}, { id: 'x' }])).toEqual([]);
    const [item] = documentHistory([{ id: 1 }]);
    expect(item).toMatchObject({ name: 'Document', sizeBytes: null, uploadedAt: null, isCurrent: true, canReplace: false });
  });
});

describe('reviewBanner', () => {
  test.each([
    ['awaiting_documents', 'Waiting for you to upload documents.', 'warning'],
    ['changes_requested', 'Waiting for you to respond to the Admin.', 'warning'],
    ['in_review', 'Under Admin review.', 'info'],
    ['approved', 'Approved.', 'success'],
  ])('%s -> "%s"', (status, title, tone) => {
    expect(reviewBanner(request(status))).toMatchObject({ key: status, title, tone });
  });

  test('shows the Admin reason only while changes are requested', () => {
    const reason = 'Please send the latest discharge summary.';
    expect(reviewBanner({ reviewStatus: 'changes_requested', documentsRequestReason: reason }).reason).toBe(reason);
    for (const status of ['awaiting_documents', 'in_review', 'approved']) {
      expect(reviewBanner({ reviewStatus: status, documentsRequestReason: reason }).reason).toBeNull();
    }
  });

  test('a missing, blank or odd reason shows nothing; a reason is trimmed', () => {
    expect(reviewBanner({ reviewStatus: 'changes_requested' }).reason).toBeNull();
    expect(reviewBanner({ reviewStatus: 'changes_requested', documentsRequestReason: '   ' }).reason).toBeNull();
    expect(reviewBanner({ reviewStatus: 'changes_requested', documentsRequestReason: 42 }).reason).toBeNull();
    expect(reviewBanner({ reviewStatus: 'changes_requested', documentsRequestReason: '  Send a scan.  ' }).reason).toBe('Send a scan.');
  });

  test('no banner outside the workflow or for an unknown status', () => {
    expect(reviewBanner({ reviewStatus: null })).toBeNull();
    expect(reviewBanner({})).toBeNull();
    expect(reviewBanner(null)).toBeNull();
    expect(reviewBanner(request('something_new'))).toBeNull();
    expect(reviewBanner(request('__proto__'))).toBeNull();
    expect(reviewBanner(request('toString'))).toBeNull();
  });

  test('exposes only the banner fields', () => {
    const banner = reviewBanner({ reviewStatus: 'changes_requested', documentsRequestReason: 'x', bitrixLastError: 'secret', patientName: 'A' });
    expect(Object.keys(banner).sort()).toEqual(['key', 'reason', 'title', 'tone']);
  });
});

describe('reviewPill', () => {
  const wf = (reviewStatus, status = 'submitted') => ({ reviewStatus, status });

  test('a request that is not approved yet shows the review chip', () => {
    expect(reviewPill(wf('awaiting_documents'))).toEqual({ key: 'awaiting_documents', label: 'Awaiting documents', tone: 'warning' });
    expect(reviewPill(wf('changes_requested'))).toEqual({ key: 'changes_requested', label: 'Action needed', tone: 'warning' });
    expect(reviewPill(wf('in_review'))).toEqual({ key: 'in_review', label: 'In review', tone: 'info' });
  });

  test('approved, with the Case not started, shows Approved', () => {
    expect(reviewPill(wf('approved', 'submitted'))).toEqual({ key: 'approved', label: 'Approved', tone: 'success' });
  });

  test('approved, with the Case under way or done, leaves the usual stage chip', () => {
    for (const status of ['in_progress', 'scheduled', 'completed']) expect(reviewPill(wf('approved', status))).toBeNull();
  });

  test('a cancelled request keeps the usual Cancelled chip, whatever its review status', () => {
    for (const reviewStatus of ['awaiting_documents', 'changes_requested', 'in_review', 'approved']) {
      expect(reviewPill(wf(reviewStatus, 'cancelled'))).toBeNull();
    }
  });

  test('older requests and other services have no review chip', () => {
    expect(reviewPill({ reviewStatus: null, status: 'submitted' })).toBeNull();
    expect(reviewPill({ status: 'in_progress' })).toBeNull();
    expect(reviewPill(null)).toBeNull();
    expect(reviewPill(wf('something_new'))).toBeNull();
    expect(reviewPill(wf('__proto__'))).toBeNull();
  });

  test('the chip and the banner never contradict each other, for every review status and request status', () => {
    const reviewStatuses = ['awaiting_documents', 'changes_requested', 'in_review', 'approved'];
    const statuses = ['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled'];
    for (const reviewStatus of reviewStatuses) {
      for (const status of statuses) {
        const request = { reviewStatus, status };
        const pill = reviewPill(request);
        const banner = reviewBanner(request);
        // A review chip always comes with the banner of the same state (same key and tone).
        if (pill) expect(banner).toMatchObject({ key: pill.key, tone: pill.tone });
        // A cancelled request shows no banner, so nothing can say "In review" next to "Cancelled".
        if (status === 'cancelled') expect(banner).toBeNull();
        // The only time the banner stands without a review chip is an approved request whose Case has moved on.
        if (!pill && banner) expect(banner.key).toBe('approved');
        if (!pill && banner) expect(['in_progress', 'scheduled', 'completed']).toContain(status);
        // Never "Approved" next to a request that is not approved, nor an unapproved chip next to approval.
        if (pill && pill.key !== 'approved') expect(reviewStatus).not.toBe('approved');
      }
    }
  });

  test('the banner is hidden for a cancelled request', () => {
    expect(reviewBanner({ reviewStatus: 'approved', status: 'cancelled' })).toBeNull();
    expect(reviewBanner({ reviewStatus: 'in_review', status: 'cancelled' })).toBeNull();
    expect(reviewBanner({ reviewStatus: 'approved', status: 'in_progress' })).toMatchObject({ key: 'approved' });
  });

  test('exposes only the chip fields', () => {
    expect(Object.keys(reviewPill({ reviewStatus: 'in_review', status: 'submitted', bitrixLastError: 'x' })).sort()).toEqual(['key', 'label', 'tone']);
  });
});

describe('canUploadMore / uploadBlockReason', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => doc({ id: i + 1 }));

  test.each(['awaiting_documents', 'in_review', 'changes_requested'])('allowed while %s', (status) => {
    expect(canUploadMore(request(status), many(2))).toBe(true);
    expect(uploadBlockReason(request(status), many(2))).toBeNull();
  });

  test('refused on an approved request', () => {
    expect(canUploadMore(request('approved'), many(1))).toBe(false);
    expect(uploadBlockReason(request('approved'), many(1))).toBe('approved');
  });

  test('refused outside the workflow', () => {
    expect(canUploadMore({ reviewStatus: null }, [])).toBe(false);
    expect(uploadBlockReason({ reviewStatus: null }, [])).toBe('not_workflow');
    expect(canUploadMore(null, [])).toBe(false);
  });

  test('the limit counts every version, replaced ones included', () => {
    expect(MAX_DOCUMENTS_PER_REQUEST).toBe(30);
    expect(canUploadMore(request('in_review'), many(29))).toBe(true);
    expect(canUploadMore(request('in_review'), many(30))).toBe(false);
    expect(uploadBlockReason(request('in_review'), many(31))).toBe('limit');
    const allReplaced = many(30).map((d) => ({ ...d, supersededAt: '2026-11-02T00:00:00Z' }));
    expect(canUploadMore(request('changes_requested'), allReplaced)).toBe(false);
  });

  test('an approved request reports approved before the limit', () => {
    expect(uploadBlockReason(request('approved'), many(30))).toBe('approved');
  });

  test('no document list counts as none', () => {
    expect(canUploadMore(request('awaiting_documents'), undefined)).toBe(true);
  });
});
