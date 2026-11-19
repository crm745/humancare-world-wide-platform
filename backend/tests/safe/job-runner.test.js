/* global describe, test, expect, jest, beforeEach, afterEach */
// The scheduled-job runner (src/jobs/job-runner.js): what it logs when a job fails, and that its execution semantics are unchanged
// (retry on the next tick, no overlap, runOnStart, stop waiting for a running job). Fake timers, no database, no network.
const { createJobRunner, safeErrorCode } = require('../../src/jobs/job-runner');

const LEAK = 'LEAKY_QUERY select * from payments where amount = 1500.00 postgres://user:pa55@host/db rzp_test_SECRETKEY';
const logger = () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() });
const MIN = 60 * 1000;

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('safeErrorCode', () => {
  test('prefers a public code, then a code, then the class name; always an identifier, never text', () => {
    expect(safeErrorCode(Object.assign(new Error(LEAK), { publicCode: 'gateway_unavailable', code: 'P2002' }))).toBe('gateway_unavailable');
    expect(safeErrorCode(Object.assign(new Error(LEAK), { code: 'P2002' }))).toBe('P2002');
    expect(safeErrorCode(Object.assign(new Error(LEAK), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(safeErrorCode(Object.assign(new Error(LEAK), { name: 'PrismaClientKnownRequestError' }))).toBe('PrismaClientKnownRequestError');
    expect(safeErrorCode(new TypeError(LEAK))).toBe('TypeError');
    expect(safeErrorCode(new Error(LEAK))).toBe('Error');
  });
  test('a code or name that is not identifier-shaped is never used (no text can be smuggled in)', () => {
    for (const bad of [LEAK, 'has space', 'semi;colon', 'new\nline', 'x'.repeat(65), '', '../etc', 'a/b']) {
      expect(safeErrorCode(Object.assign(new Error('m'), { code: bad, name: bad }))).toBe('Error');
    }
  });
  test('anything that is not an error object is "Error"', () => {
    for (const thrown of [undefined, null, 'a string with a secret', 42, {}, { code: 5 }, { message: LEAK }]) expect(safeErrorCode(thrown)).toBe('Error');
  });
  test('the message of an error is never part of the result', () => {
    expect(safeErrorCode(new Error('p2002'))).not.toContain('p2002');
    expect(safeErrorCode(Object.assign(new Error(LEAK), { code: 'P2034' }))).not.toMatch(/LEAKY|pa55|rzp_/);
  });
});

describe('what a failing job logs', () => {
  const failingRunner = (error) => {
    const log = logger();
    const runner = createJobRunner([{ name: 'payment-order-recovery', intervalMs: MIN, runOnStart: false, run: async () => { throw error; } }], { logger: log });
    return { log, runner };
  };

  test('the job name and a short code only: never the exception message or query details', async () => {
    const { log, runner } = failingRunner(Object.assign(new Error(LEAK), { code: 'P2002' }));
    runner.start();
    await jest.advanceTimersByTimeAsync(MIN);
    await runner.stop();
    expect(log.error.mock.calls).toEqual([['[jobs] "payment-order-recovery" failed: P2002']]);
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/LEAKY|select \*|1500\.00|pa55|rzp_test_|postgres:/i);
  });

  test.each([
    ['a plain error', new Error(LEAK), 'Error'],
    ['a Prisma-style error', Object.assign(new Error(LEAK), { name: 'PrismaClientKnownRequestError', code: 'P2025' }), 'P2025'],
    ['an error with a public code', Object.assign(new Error(LEAK), { publicCode: 'db_unavailable' }), 'db_unavailable'],
    ['a thrown string', LEAK, 'Error'],
    ['a thrown null', null, 'Error'],
    ['an error whose code is free text', Object.assign(new Error('m'), { code: LEAK }), 'Error'],
  ])('%s', async (_label, thrown, expected) => {
    const { log, runner } = failingRunner(thrown);
    runner.start();
    await jest.advanceTimersByTimeAsync(MIN);
    await runner.stop();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toBe(`[jobs] "payment-order-recovery" failed: ${expected}`);
    expect(log.error.mock.calls[0]).toHaveLength(1); // no second argument carrying the error object
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/LEAKY|select \*|pa55|rzp_test_/i);
  });
});

describe('execution semantics are unchanged', () => {
  test('a failed run is retried on the NEXT tick, and the schedule keeps going', async () => {
    const log = logger();
    let calls = 0;
    const run = jest.fn(async () => { calls += 1; if (calls === 1) throw Object.assign(new Error(LEAK), { code: 'ECONNRESET' }); });
    const runner = createJobRunner([{ name: 'j', intervalMs: MIN, runOnStart: false, run }], { logger: log });
    runner.start();
    await jest.advanceTimersByTimeAsync(MIN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(MIN);
    await jest.advanceTimersByTimeAsync(MIN);
    await runner.stop();
    expect(run).toHaveBeenCalledTimes(3); // ran again, and again
    expect(log.error).toHaveBeenCalledTimes(1); // only the first run failed
  });

  test('one failing job never stops or delays another', async () => {
    const log = logger();
    const good = jest.fn(async () => {});
    const bad = jest.fn(async () => { throw new Error(LEAK); });
    const runner = createJobRunner([{ name: 'bad', intervalMs: MIN, runOnStart: false, run: bad }, { name: 'good', intervalMs: MIN, runOnStart: false, run: good }], { logger: log });
    runner.start();
    await jest.advanceTimersByTimeAsync(3 * MIN);
    await runner.stop();
    expect(good).toHaveBeenCalledTimes(3);
    expect(bad).toHaveBeenCalledTimes(3);
    expect(log.error.mock.calls.map((c) => c[0])).toEqual(Array(3).fill('[jobs] "bad" failed: Error'));
  });

  test('a job still running at the next tick is skipped (never run twice at once), with the unchanged warning', async () => {
    const log = logger();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const run = jest.fn(() => hold);
    const runner = createJobRunner([{ name: 'slow', intervalMs: MIN, runOnStart: false, run }], { logger: log });
    runner.start();
    await jest.advanceTimersByTimeAsync(MIN);
    await jest.advanceTimersByTimeAsync(MIN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('[jobs] "slow" is still running, skipping this run.');
    release();
    await jest.advanceTimersByTimeAsync(MIN);
    await runner.stop();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('runOnStart runs at once; start is idempotent; stop waits for a running job and later calls get the same promise', async () => {
    const log = logger();
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const run = jest.fn(() => hold);
    const runner = createJobRunner([{ name: 'now', intervalMs: MIN, runOnStart: true, run }], { logger: log });
    runner.start();
    runner.start(); // a second start registers nothing new
    expect(run).toHaveBeenCalledTimes(1);
    const first = runner.stop();
    expect(runner.stop()).toBe(first);
    let finished = false;
    first.then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(MIN * 3);
    expect(finished).toBe(false); // the running job has not finished yet
    release();
    await first;
    expect(finished).toBe(true);
    expect(run).toHaveBeenCalledTimes(1); // no new run after stop
    expect(() => runner.start()).toThrow(/stopped/);
  });

  test('a failure that happens while stopping is still logged safely and does not make stop() reject', async () => {
    const log = logger();
    let fail;
    const run = jest.fn(() => new Promise((_, reject) => { fail = reject; }));
    const runner = createJobRunner([{ name: 'j', intervalMs: MIN, runOnStart: true, run }], { logger: log });
    runner.start();
    const stopped = runner.stop();
    fail(Object.assign(new Error(LEAK), { code: 'P2034' }));
    await expect(stopped).resolves.toBeUndefined();
    expect(log.error.mock.calls).toEqual([['[jobs] "j" failed: P2034']]);
  });

  test('the job list is validated exactly as before', () => {
    expect(() => createJobRunner([])).toThrow(/at least one job/);
    expect(() => createJobRunner([{ name: 'a', intervalMs: MIN, run: () => {} }, { name: 'a', intervalMs: MIN, run: () => {} }])).toThrow(/Duplicate/);
    expect(() => createJobRunner([{ name: 'a', intervalMs: 0, run: () => {} }])).toThrow(/intervalMs/);
    expect(() => createJobRunner([{ name: 'a', intervalMs: MIN }])).toThrow(/run function/);
  });
});
