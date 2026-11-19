/* global describe, test, expect */
// The patient's quotation card: which state it is in, how the money reads, the rejection reason rule and our messages for each failure.
const { quotationState, quotationAmount, quotationFilename, validateRejectionReason, decisionErrorInfo, REASON_MIN, REASON_MAX } = require('../quotationView');

const published = (over = {}) => ({ id: 762, versionNumber: 1, status: 'published', amount: '1000.000', currency: 'INR', validUntil: null, publishedAt: '2026-11-19T12:00:00.000Z', decidedAt: null, rejectionReason: null, expired: false, fileAvailable: true, sizeBytes: 366770, canDecide: true, ...over });

describe('quotationState', () => {
  test('nothing published yet is "none"', () => {
    expect(quotationState({ quotation: null, lastDecision: null }).kind).toBe('none');
    expect(quotationState(null).kind).toBe('none');
    expect(quotationState(undefined).kind).toBe('none');
    expect(quotationState({}).kind).toBe('none');
  });

  test('a published quotation the server says can be decided is "available" (Accept and Reject are offered)', () => {
    const s = quotationState({ quotation: published(), lastDecision: null });
    expect(s.kind).toBe('available');
    expect(s.quotation.id).toBe(762);
  });

  test('an expired quotation is "expired": the server flag decides, the app never recomputes the date', () => {
    expect(quotationState({ quotation: published({ expired: true, canDecide: false, validUntil: '2020-01-01T00:00:00.000Z' }) }).kind).toBe('expired');
    // a date in the past without the server flag is NOT treated as expired here
    expect(quotationState({ quotation: published({ validUntil: '2020-01-01T00:00:00.000Z' }) }).kind).toBe('available');
  });

  test('an accepted quotation is "accepted": the confirmed decision, nothing to change', () => {
    expect(quotationState({ quotation: published({ status: 'accepted', canDecide: false, decidedAt: '2026-11-20T09:00:00.000Z' }) }).kind).toBe('accepted');
  });

  test('a rejected newest version with nothing live is "rejected"', () => {
    const s = quotationState({ quotation: null, lastDecision: { versionNumber: 2, status: 'rejected', decidedAt: '2026-11-20T09:00:00.000Z', amount: '900.000', currency: 'INR' } });
    expect(s.kind).toBe('rejected');
    expect(s.lastDecision.versionNumber).toBe(2);
  });

  test('a published quotation that cannot be decided (the request is closed) is "unavailable", never "available"', () => {
    expect(quotationState({ quotation: published({ canDecide: false }) }).kind).toBe('unavailable');
  });

  test('a live quotation wins over an old decision', () => {
    expect(quotationState({ quotation: published(), lastDecision: { status: 'rejected', versionNumber: 1 } }).lastDecision).toBeNull();
  });
});

describe('display', () => {
  test('the amount shows its currency and is never calculated; an unusable amount is empty, not zero', () => {
    expect(quotationAmount(published())).toMatch(/1,000\.00/);
    expect(quotationAmount(published())).toMatch(/₹|INR/);
    expect(quotationAmount(published({ amount: null }))).toBe('');
    expect(quotationAmount(null)).toBe('');
    expect(quotationAmount({ amount: '900.000', currency: 'INR' })).toMatch(/900\.00/); // a lastDecision has the same shape
  });

  test('the saved file name names the Case and the version', () => {
    expect(quotationFilename(published({ versionNumber: 3 }), 'REQ-5672')).toBe('REQ-5672-quotation-v3.pdf');
    expect(quotationFilename(published(), undefined)).toBe('quotation-quotation-v1.pdf');
  });
});

describe('the rejection reason', () => {
  test('is mandatory: trimmed, 3 to 1000 characters', () => {
    expect(REASON_MIN).toBe(3);
    expect(REASON_MAX).toBe(1000);
    for (const bad of [undefined, null, '', '   ', 'no', ' a ', 42, {}]) expect(validateRejectionReason(bad)).toEqual({ ok: false, key: 'quotation_reason_short' });
    expect(validateRejectionReason('x'.repeat(1001))).toEqual({ ok: false, key: 'quotation_reason_long' });
    expect(validateRejectionReason('  Too high for us  ')).toEqual({ ok: true, value: 'Too high for us' });
    expect(validateRejectionReason('abc').ok).toBe(true);
    expect(validateRejectionReason('x'.repeat(1000)).ok).toBe(true);
  });
});

describe('decisionErrorInfo: every failure has a message of ours, and says whether the screen must reload', () => {
  const err = (status, code) => Object.assign(new Error('server english sentence'), { status, code });
  test.each([
    ['quotation_expired', 'quotation_err_expired'], ['quotation_superseded', 'quotation_err_superseded'], ['quotation_already_decided', 'quotation_err_decided'],
    ['quotation_changed', 'quotation_err_changed'], ['quotation_unavailable', 'quotation_err_unavailable'], ['quotation_not_available', 'quotation_err_unavailable'],
    ['case_closed', 'quotation_err_closed'], ['quotation_not_found', 'quotation_err_notfound'],
  ])('%s -> %s and the screen reloads', (code, key) => {
    expect(decisionErrorInfo(err(409, code))).toEqual({ key, stale: true });
  });
  test('a bad reason is shown on the form; nothing is stale', () => {
    expect(decisionErrorInfo(err(400, 'reason_invalid'))).toEqual({ key: 'quotation_reason_short', stale: false });
  });
  test('network, session, rate limit and anything else', () => {
    expect(decisionErrorInfo(err(undefined, 'network'))).toEqual({ key: 'quotation_err_network', stale: false });
    expect(decisionErrorInfo(Object.assign(new TypeError('Network request failed')))).toEqual({ key: 'quotation_err_network', stale: false });
    expect(decisionErrorInfo(err(401, 'session_expired'))).toEqual({ key: 'quotation_err_session', stale: false });
    expect(decisionErrorInfo(err(401))).toEqual({ key: 'quotation_err_session', stale: false });
    expect(decisionErrorInfo(err(429, 'rate_limited'))).toEqual({ key: 'quotation_err_busy', stale: false });
    expect(decisionErrorInfo(err(500))).toEqual({ key: 'quotation_err_generic', stale: false });
    expect(decisionErrorInfo(null)).toEqual({ key: 'quotation_err_generic', stale: false });
  });
  test('an unknown 404 or 409 still reloads the screen', () => {
    expect(decisionErrorInfo(err(409, 'something_new'))).toEqual({ key: 'quotation_err_changed', stale: true });
    expect(decisionErrorInfo(err(404))).toEqual({ key: 'quotation_err_changed', stale: true });
  });
  test('the server\'s English sentence is never what the patient sees', () => {
    expect(JSON.stringify(decisionErrorInfo(err(409, 'quotation_expired')))).not.toMatch(/english/);
  });
});
