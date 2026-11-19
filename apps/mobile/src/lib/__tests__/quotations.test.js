/* global describe, test, expect, jest, beforeEach */
// The patient's quotation calls: the exact paths and bodies, the exact version id, the reason check before anything is sent, one decision at a
// time, our messages for each failure, and that the PDF only ever goes through the authenticated download. api.js and download.js are mocked.
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockDownload = jest.fn();
jest.mock('../api', () => ({ apiGet: (...a) => mockApiGet(...a), apiPost: (...a) => mockApiPost(...a) }));
jest.mock('../download', () => ({
  downloadDocument: (...a) => mockDownload(...a),
  downloadErrorInfo: (err) => ({ key: err && err.code === 'share_unavailable' ? 'docs_err_share' : err && err.status === 404 ? 'docs_err_missing' : err && err.status === 409 ? 'docs_err_blocked' : 'docs_err_generic' }),
}));

const { fetchQuotation, acceptQuotation, rejectQuotation, downloadQuotation, performDecision, performDownload } = require('../quotations');
const { createDownloadGuard } = require('../documentsView');

const q = { id: 762, versionNumber: 1, status: 'published', amount: '1000.000', currency: 'INR' };
const apiError = (status, code) => Object.assign(new Error('server sentence'), { status, code });

beforeEach(() => { jest.clearAllMocks(); mockApiGet.mockReset(); mockApiPost.mockReset(); mockDownload.mockReset(); });

describe('the calls', () => {
  test('the quotation of a request is read from GET /requests/me/:id/quotation', async () => {
    mockApiGet.mockResolvedValue({ quotation: null, lastDecision: null });
    expect(await fetchQuotation(4672)).toEqual({ quotation: null, lastDecision: null });
    expect(mockApiGet).toHaveBeenCalledWith('/requests/me/4672/quotation');
  });

  test('Accept sends the EXACT version id of the quotation shown, with an empty body (no amount, no patient id)', async () => {
    mockApiPost.mockResolvedValue({ alreadyAccepted: false, quotation: { ...q, status: 'accepted' } });
    await acceptQuotation(762);
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/quotations/762/accept', {});
  });

  test('Reject sends the trimmed reason to that version id', async () => {
    mockApiPost.mockResolvedValue({ alreadyRejected: false, quotation: { ...q, status: 'rejected' } });
    await rejectQuotation(762, '  The amount is higher than agreed  ');
    expect(mockApiPost).toHaveBeenCalledWith('/quotations/762/reject', { reason: 'The amount is higher than agreed' });
  });

  test.each([undefined, null, '', '  ', 'no', 'x'.repeat(1001)])('a rejection reason of %p is refused BEFORE anything is sent', async (reason) => {
    await expect(rejectQuotation(762, reason)).rejects.toMatchObject({ code: 'reason_invalid' });
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  test('ids are encoded into the path, never concatenated raw', async () => {
    mockApiPost.mockResolvedValue({});
    await acceptQuotation('1/../2');
    expect(mockApiPost.mock.calls[0][0]).toBe('/quotations/1%2F..%2F2/accept');
  });

  test('the PDF goes through the authenticated download with a safe name; no URL is built and no browser link is opened', async () => {
    mockDownload.mockResolvedValue({ saved: true });
    await downloadQuotation(q, 'REQ-5672');
    expect(mockDownload).toHaveBeenCalledWith('/quotations/762/file', 'REQ-5672-quotation-v1.pdf', undefined);
    const source = require('fs').readFileSync(require.resolve('../quotations.js'), 'utf8');
    expect(source).not.toMatch(/http|Linking|openURL|WebBrowser|fetch\(/);
  });
});

describe('performDecision', () => {
  test('success: { ok, kind, already }', async () => {
    mockApiPost.mockResolvedValue({ alreadyAccepted: false });
    expect(await performDecision('accept', q)).toEqual({ ok: true, kind: 'accept', already: false });
    mockApiPost.mockResolvedValue({ alreadyRejected: true });
    expect(await performDecision('reject', q, 'Too high for us')).toEqual({ ok: true, kind: 'reject', already: true });
  });

  test.each([
    [409, 'quotation_expired', 'quotation_err_expired', true], [409, 'quotation_superseded', 'quotation_err_superseded', true],
    [409, 'quotation_already_decided', 'quotation_err_decided', true], [404, 'quotation_not_found', 'quotation_err_notfound', true],
    [undefined, 'network', 'quotation_err_network', false], [401, 'session_expired', 'quotation_err_session', false], [500, undefined, 'quotation_err_generic', false],
  ])('a %s %s answer becomes our message %s (stale: %s) and never throws', async (status, code, key, stale) => {
    mockApiPost.mockRejectedValue(apiError(status, code));
    expect(await performDecision('accept', q)).toEqual({ ok: false, key, stale });
  });

  test('a rejection with no valid reason never reaches the server and shows the reason message', async () => {
    expect(await performDecision('reject', q, 'no')).toEqual({ ok: false, key: 'quotation_reason_short', stale: false });
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  test('a decision uses the version it was given: after the app reloads onto a newer version, the old id is not reused', async () => {
    mockApiPost.mockResolvedValue({});
    await performDecision('accept', { ...q, id: 762 });
    await performDecision('accept', { ...q, id: 801, versionNumber: 2 });
    expect(mockApiPost.mock.calls.map((c) => c[0])).toEqual(['/quotations/762/accept', '/quotations/801/accept']);
  });
});

describe('performDownload', () => {
  test('success and our messages for each failure; 404/409 mean the screen must reload', async () => {
    mockDownload.mockResolvedValue({ saved: true });
    expect(await performDownload(q, 'REQ-5672')).toEqual({ ok: true });
    mockDownload.mockRejectedValue(apiError(409, 'quotation_not_available'));
    expect(await performDownload(q, 'REQ-5672')).toEqual({ ok: false, key: 'docs_err_blocked', stale: true });
    mockDownload.mockRejectedValue(apiError(404));
    expect(await performDownload(q, 'REQ-5672')).toEqual({ ok: false, key: 'docs_err_missing', stale: true });
    mockDownload.mockRejectedValue(Object.assign(new Error('x'), { code: 'share_unavailable' }));
    expect(await performDownload(q, 'REQ-5672')).toEqual({ ok: false, key: 'docs_err_share', stale: false });
    mockDownload.mockRejectedValue(apiError(500));
    expect(await performDownload(q, 'REQ-5672')).toEqual({ ok: false, key: 'docs_err_generic', stale: false });
  });
});

describe('duplicate tap prevention (the guard the hook wraps around a decision)', () => {
  test('two taps in the same moment send ONE request; Accept and Reject together send one; the next try after it finishes is allowed', async () => {
    const guard = createDownloadGuard();
    let release;
    mockApiPost.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ alreadyAccepted: false }); }));
    const run = (kind) => guard.run(`decide:${q.id}`, () => performDecision(kind, q, 'Too high for us'));
    const first = run('accept');
    const second = run('accept');
    const third = run('reject');
    expect(await second).toBe(false);
    expect(await third).toBe(false);
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
    mockApiPost.mockResolvedValue({ alreadyAccepted: true });
    expect(await run('accept')).toBe(true);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
  });

  test('a different quotation or the PDF is independent of a running decision', async () => {
    const guard = createDownloadGuard();
    let release;
    const slow = guard.run('decide:762', () => new Promise((resolve) => { release = resolve; }));
    expect(await guard.run('file:762', async () => 'x')).toBe(true);
    expect(await guard.run('decide:801', async () => 'x')).toBe(true);
    expect(await guard.run('decide:762', async () => 'x')).toBe(false);
    release();
    await slow;
  });
});
