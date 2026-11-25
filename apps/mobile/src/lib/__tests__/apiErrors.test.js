/* global describe, test, expect, jest, afterEach */
// Phase 1 (network foundation): how a failed call is told apart and worded, and the per-attempt deadline. Pure; no network.
const {
  NETWORK_READ_MESSAGE, TIMEOUT_READ_MESSAGE, NETWORK_WRITE_MESSAGE, TIMEOUT_WRITE_MESSAGE, WRITE_TIMEOUT_MS,
  noAnswerError, failureOf, startDeadline, classifyApiError, isOutcomeUnknown, isAbort,
} = require('../apiErrors');

afterEach(() => jest.useRealTimers());

describe('noAnswerError: the error for a call that got no answer', () => {
  test('a read that lost the connection: user-safe, safe to run again, no HTTP status', () => {
    const err = noAnswerError({ method: 'GET' });
    expect(err.message).toBe(NETWORK_READ_MESSAGE);
    expect(err.message).not.toMatch(/Network request failed/);
    expect(err).toMatchObject({ code: 'network', failure: 'network', outcomeUnknown: false });
    expect(err.status).toBeUndefined();
  });
  test('a read that timed out', () => {
    const err = noAnswerError({ method: 'GET', timedOut: true });
    expect(err.message).toBe(TIMEOUT_READ_MESSAGE);
    expect(err).toMatchObject({ code: 'timeout', failure: 'timeout', outcomeUnknown: false });
  });
  test.each(['POST', 'PATCH', 'PUT', 'DELETE', 'post'])('a %s that lost the connection: the outcome is UNKNOWN, never "failed"', (method) => {
    const err = noAnswerError({ method });
    expect(err).toMatchObject({ code: 'network', outcomeUnknown: true });
    expect(err.message).toBe(NETWORK_WRITE_MESSAGE);
    expect(err.message).toMatch(/couldn't confirm/);
  });
  test('a write that timed out: the outcome is UNKNOWN', () => {
    const err = noAnswerError({ method: 'POST', timedOut: true });
    expect(err).toMatchObject({ code: 'timeout', outcomeUnknown: true });
    expect(err.message).toBe(TIMEOUT_WRITE_MESSAGE);
  });
  test('a missing method is a read', () => {
    expect(noAnswerError().outcomeUnknown).toBe(false);
  });
  test('the write messages tell the person to check before trying again; the read messages do not', () => {
    expect(NETWORK_WRITE_MESSAGE).toMatch(/check before trying again/);
    expect(TIMEOUT_WRITE_MESSAGE).toMatch(/check before trying again/);
    expect(NETWORK_READ_MESSAGE).not.toMatch(/confirm/);
  });
  test('the write deadline is a bounded, sensible number', () => {
    expect(WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(15000);
    expect(WRITE_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });
});

describe('startDeadline', () => {
  test('ms <= 0 means no deadline', () => {
    jest.useFakeTimers();
    const deadline = startDeadline(undefined, 0);
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired()).toBe(false);
  });
  test('aborts the signal and says it expired when the time is up', () => {
    jest.useFakeTimers();
    const deadline = startDeadline(undefined, 1000);
    jest.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(true);
  });
  test('clear() stops the timer: a finished call is never aborted later', () => {
    jest.useFakeTimers();
    const deadline = startDeadline(undefined, 1000);
    deadline.clear();
    jest.advanceTimersByTime(5000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.expired()).toBe(false);
  });
  test("the caller's own abort passes through and is NOT an expiry", () => {
    const caller = new AbortController();
    const deadline = startDeadline(caller.signal, 0);
    caller.abort();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.expired()).toBe(false);
  });
  test('a caller signal that is already aborted gives an aborted signal at once', () => {
    const caller = new AbortController();
    caller.abort();
    const deadline = startDeadline(caller.signal, 1000);
    expect(deadline.signal.aborted).toBe(true);
    deadline.clear();
  });
  test('clear() detaches from the caller signal', () => {
    const caller = new AbortController();
    const deadline = startDeadline(caller.signal, 0);
    deadline.clear();
    caller.abort();
    expect(deadline.signal.aborted).toBe(false);
  });
});

describe('failureOf: what a failed attempt becomes', () => {
  const live = { expired: () => false };
  const expired = { expired: () => true };
  test('a TypeError from fetch (a phone with no connection) is "no connection"', () => {
    const out = failureOf(new TypeError('Network request failed'), { method: 'GET', deadline: live });
    expect(out).toMatchObject({ code: 'network' });
    expect(out.message).not.toMatch(/Network request failed/);
  });
  test('an expired deadline is a timeout, whatever was thrown', () => {
    expect(failureOf(Object.assign(new Error('aborted'), { name: 'AbortError' }), { method: 'POST', deadline: expired })).toMatchObject({ code: 'timeout', outcomeUnknown: true });
  });
  test("the caller's own cancel stays a cancel (the session check depends on it)", () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(failureOf(abort, { method: 'GET', deadline: live })).toBe(abort);
  });
  test('an abort tagged code "aborted" is also a cancel', () => {
    const abort = Object.assign(new Error('x'), { code: 'aborted' });
    expect(isAbort(abort)).toBe(true);
    expect(failureOf(abort, { method: 'GET', deadline: live })).toBe(abort);
  });
  test('works without a deadline', () => {
    expect(failureOf(new Error('boom'), { method: 'POST' })).toMatchObject({ code: 'network', outcomeUnknown: true });
  });
});

describe('classifyApiError', () => {
  test.each([
    [null, 'unknown'],
    [undefined, 'unknown'],
    [{}, 'unknown'],
    [new Error('plain'), 'unknown'],
    [noAnswerError({ method: 'GET' }), 'network'],
    [noAnswerError({ method: 'POST' }), 'network'],
    [noAnswerError({ method: 'GET', timedOut: true }), 'timeout'],
    [noAnswerError({ method: 'POST', timedOut: true }), 'timeout'],
    [Object.assign(new Error('x'), { code: 'network' }), 'network'],
    [Object.assign(new Error('x'), { code: 'timeout' }), 'timeout'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'cancelled'],
    [Object.assign(new Error('x'), { code: 'session_expired', status: 401 }), 'auth'],
    [Object.assign(new Error('x'), { code: 'not_signed_in' }), 'auth'],
    [Object.assign(new Error('x'), { code: 'session_unverified' }), 'auth'],
    [Object.assign(new Error('x'), { status: 401 }), 'auth'],
    [Object.assign(new Error('x'), { status: 403 }), 'auth'],
    [Object.assign(new Error('x'), { status: 429 }), 'rate_limited'],
    [Object.assign(new Error('x'), { status: 400 }), 'validation'],
    [Object.assign(new Error('x'), { status: 409 }), 'validation'],
    [Object.assign(new Error('x'), { status: 422 }), 'validation'],
    [Object.assign(new Error('x'), { status: 500 }), 'server'],
    [Object.assign(new Error('x'), { status: 503 }), 'server'],
    [Object.assign(new Error('x'), { status: 502, failure: 'server' }), 'server'],
  ])('%#: %j -> %s', (err, expected) => {
    expect(classifyApiError(err)).toBe(expected);
  });
  test('never throws on odd input', () => {
    expect(() => classifyApiError(42)).not.toThrow();
    expect(() => classifyApiError('text')).not.toThrow();
    expect(() => classifyApiError({ status: 'abc' })).not.toThrow();
  });
});

describe('isOutcomeUnknown', () => {
  test('true only for a write that got no answer', () => {
    expect(isOutcomeUnknown(noAnswerError({ method: 'POST' }))).toBe(true);
    expect(isOutcomeUnknown(noAnswerError({ method: 'POST', timedOut: true }))).toBe(true);
    expect(isOutcomeUnknown(noAnswerError({ method: 'GET' }))).toBe(false);
    expect(isOutcomeUnknown(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isOutcomeUnknown(Object.assign(new Error('x'), { status: 503 }))).toBe(false); // the server ANSWERED: it said no
    expect(isOutcomeUnknown(null)).toBe(false);
  });
});
