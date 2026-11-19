/* global describe, test, expect, jest, beforeEach, afterEach */
// Registration and scheduling of the Razorpay webhook inbox worker: the job is registered once at 10 s, the gates keep it silent when payments are not
// configured, a pass calls the processor, passes never overlap, exceptions reach the job runner as a safe code only, nothing sensitive is logged, and the
// Bitrix jobs and the Bitrix inbox are untouched. No database and no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} })); // the jobs index imports modules that load Prisma; nothing here may reach a database
const fs = require('fs');
const path = require('path');
const worker = require('../../src/modules/payments/razorpay-webhook.worker');
const processor = require('../../src/modules/payments/razorpay-webhook.processor');
const inboxStore = require('../../src/modules/payments/razorpay-webhook.inbox.store');
const job = require('../../src/jobs/razorpay-webhook-inbox.job');
const { jobs } = require('../../src/jobs');
const { createJobRunner } = require('../../src/jobs/job-runner');

const WEBHOOK_SECRET = 'FAKE_WEBHOOK_SECRET_VALUE_12345';
const KEY_SECRET = 'FAKE_API_KEY_SECRET_VALUE_67890';
const GOOD = Object.freeze({ PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_KEY_SECRET: KEY_SECRET });
const logger = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() });
const lines = (l) => [...l.log.mock.calls, ...l.warn.mock.calls, ...l.error.mock.calls, ...l.info.mock.calls].map((c) => c.join(' '));
const fakeDb = () => ({ marker: 'db' });

let batch;
beforeEach(() => {
  worker.resetForTests();
  batch = jest.spyOn(processor, 'processBatch').mockResolvedValue({ claimed: 0, skipped: 0, recovered: { failed: 0, again: 0 } });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('job registration', () => {
  test('is registered exactly once in the existing jobs list, with a unique name, a 10 second interval, no run-on-start and a run function', () => {
    expect(jobs.filter((j) => j === job)).toHaveLength(1);
    expect(jobs.filter((j) => j.name === 'razorpay-webhook-inbox')).toHaveLength(1);
    expect(job).toMatchObject({ name: 'razorpay-webhook-inbox', intervalMs: 10000, runOnStart: false });
    expect(typeof job.run).toBe('function');
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
  });
  test('the existing job runner accepts the whole list (startup compatibility) and schedules this job on its own 10 s timer', () => {
    expect(() => createJobRunner(jobs, { logger: logger() })).not.toThrow();
    jest.useFakeTimers();
    try {
      const spy = jest.spyOn(global, 'setInterval');
      const runner = createJobRunner([job], { logger: logger() });
      runner.start();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 10000);
      return runner.stop();
    } finally { jest.useRealTimers(); }
  });
  test('the job file is a thin scheduler like the Bitrix ones: it imports only the worker module', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/jobs/razorpay-webhook-inbox.job.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect([...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['../modules/payments/razorpay-webhook.worker']);
  });
});

describe('Bitrix isolation', () => {
  test('every Bitrix job is still registered with its own interval, in its original order, ahead of the Razorpay job', () => {
    const names = jobs.map((j) => `${j.name}:${j.intervalMs}`);
    expect(names).toEqual([
      'bitrix-retry:300000', 'bitrix-deal:30000', 'bitrix-deal-inbox:30000', 'bitrix-deal-reconcile:600000', 'bitrix-deal-document:30000', 'bitrix-quotation:30000', 'scan-case-quotations:60000', 'invoice-from-quotation:60000',
      'security-log-purge:86400000', 'scan-request-documents:60000', 'admin-audit-purge:86400000', 'payment-order-recovery:60000', 'razorpay-webhook-inbox:10000',
    ]);
  });
  test('neither new file imports or mentions Bitrix', () => {
    for (const file of ['src/jobs/razorpay-webhook-inbox.job.js', 'src/modules/payments/razorpay-webhook.worker.js']) {
      expect(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8').replace(/\/\/.*$/gm, '')).not.toMatch(/bitrix|deal-inbox/i);
    }
  });
  test('a real pass reads and writes ONLY source = razorpay: every statement is bound to "razorpay" and none to "bitrix24"', async () => {
    batch.mockRestore();
    const seen = [];
    const record = (strings, values) => seen.push({ sql: strings.join('?').replace(/\s+/g, ' '), values });
    const db = { $queryRaw: jest.fn(async (s, ...v) => { record(s, v); return []; }), $executeRaw: jest.fn(async (s, ...v) => { record(s, v); return 0; }) };
    expect(await worker.runRazorpayWebhookWorker({ env: GOOD, db, logger: logger() })).toMatchObject({ active: true, claimed: 0 });
    expect(seen.length).toBeGreaterThanOrEqual(3); // recovery x2 and the due-list query
    for (const s of seen) {
      expect(s.sql).toMatch(/integration_inbox/);
      expect(s.sql).toMatch(/source = \?/);
      expect(s.values).toContain('razorpay');
      expect(s.values).not.toContain('bitrix24');
    }
  });
});

describe('configuration gates: nothing is processed and the database is not touched', () => {
  const closed = [
    ['PAYMENTS_ENABLED missing', { ...GOOD, PAYMENTS_ENABLED: undefined }, 'payments_disabled'],
    ['PAYMENTS_ENABLED "false"', { ...GOOD, PAYMENTS_ENABLED: 'false' }, 'payments_disabled'],
    ['PAYMENTS_ENABLED "TRUE" (not exact)', { ...GOOD, PAYMENTS_ENABLED: 'TRUE' }, 'payments_disabled'],
    ['PAYMENTS_ENABLED "1"', { ...GOOD, PAYMENTS_ENABLED: '1' }, 'payments_disabled'],
    ['PAYMENTS_ENABLED "true " (padded)', { ...GOOD, PAYMENTS_ENABLED: 'true ' }, 'payments_disabled'],
    ['environment id missing', { ...GOOD, PAYMENTS_ENVIRONMENT_ID: undefined }, 'environment_id_missing'],
    ['environment id invalid', { ...GOOD, PAYMENTS_ENVIRONMENT_ID: 'Bad Value!' }, 'environment_id_invalid'],
    ['webhook secret missing', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: undefined }, 'webhook_secret_missing'],
    ['webhook secret empty', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: '' }, 'webhook_secret_missing'],
    ['webhook secret too short', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: 'short' }, 'webhook_secret_short'],
    ['webhook secret padded', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: ` ${WEBHOOK_SECRET}` }, 'webhook_secret_invalid'],
    ['webhook secret the same as the API key secret', { ...GOOD, RAZORPAY_WEBHOOK_SECRET: KEY_SECRET }, 'webhook_secret_reused'],
  ];
  test.each(closed)('%s -> %s', async (_label, env, code) => {
    const l = logger();
    const db = fakeDb();
    expect(await worker.runRazorpayWebhookWorker({ env, db, logger: l })).toEqual({ active: false, code });
    expect(batch).not.toHaveBeenCalled();
    expect(worker.workerStatus(env)).toEqual({ active: false, code });
    expect(l.warn).toHaveBeenCalledWith(`[razorpay-webhook] not processing events: ${code}.`);
    expect(lines(l).join('\n')).not.toContain(WEBHOOK_SECRET);
    expect(lines(l).join('\n')).not.toContain(KEY_SECRET);
  });
  test('the status never contains a secret, even when the secrets are the problem', () => {
    for (const [, env] of closed) expect(JSON.stringify(worker.workerStatus(env))).not.toMatch(/FAKE_/);
  });
  test('the API credentials are NOT required (the worker never calls Razorpay): only the three gates matter', async () => {
    const env = { PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET }; // no RAZORPAY_KEY_ID / KEY_SECRET
    expect(worker.workerStatus(env)).toEqual({ active: true, code: null });
    expect(await worker.runRazorpayWebhookWorker({ env, db: fakeDb(), logger: logger() })).toMatchObject({ active: true });
    expect(batch).toHaveBeenCalledTimes(1);
  });
  test('a closed gate is logged when it CHANGES, not every ten seconds; reopening is logged once', async () => {
    const l = logger();
    const bad = { ...GOOD, PAYMENTS_ENABLED: 'false' };
    for (let i = 0; i < 5; i += 1) await worker.runRazorpayWebhookWorker({ env: bad, db: fakeDb(), logger: l });
    expect(l.warn).toHaveBeenCalledTimes(1);
    await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l });
    await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l });
    expect(l.log.mock.calls.filter((c) => /worker active/.test(c[0]))).toHaveLength(1);
  });
  test('the real job with the real (unconfigured) test environment returns inactive and never touches the database', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENTS_ENABLED;
    try { expect(await job.run()).toEqual({ active: false, code: 'payments_disabled' }); } finally { if (saved !== undefined) process.env.PAYMENTS_ENABLED = saved; }
    expect(warn).toHaveBeenCalledWith('[razorpay-webhook] not processing events: payments_disabled.');
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('a pass', () => {
  test('calls the existing processor with the client, a process-unique valid worker id and the environment; the result carries counts only', async () => {
    batch.mockResolvedValue({ claimed: 2, skipped: 1, processed: 1, received: 1, recovered: { failed: 0, again: 0 } });
    const db = fakeDb();
    const l = logger();
    expect(await worker.runRazorpayWebhookWorker({ env: GOOD, db, logger: l })).toMatchObject({ active: true, claimed: 2, processed: 1, received: 1 });
    expect(batch).toHaveBeenCalledWith(db, expect.objectContaining({ env: GOOD, workerId: worker.workerId() }));
    expect(worker.workerId()).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    expect(worker.workerId()).toBe(worker.workerId());
    expect(l.log).toHaveBeenCalledWith('[razorpay-webhook] pass: claimed=2 processed=1 ignored=0 received=1 failed=0 lease_lost=0 unrecorded=0');
  });
  test('an empty pass logs nothing; the real processor and inbox store are the ones used (no second implementation)', async () => {
    const l = logger();
    await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l });
    expect(lines(l).filter((x) => /pass:/.test(x))).toEqual([]);
    expect(processor.processBatch).toBe(batch);
    expect(Object.keys(inboxStore)).toEqual(expect.arrayContaining(['claim', 'holdLease', 'writeResult', 'retryOrFail', 'recoverExpiredLeases', 'findDueIds']));
  });
  test('the pass never touches the network: no fetch is made', async () => {
    const f = jest.fn();
    const saved = global.fetch;
    global.fetch = f;
    try { await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() }); } finally { global.fetch = saved; }
    expect(f).not.toHaveBeenCalled();
  });
});

describe('no overlapping execution', () => {
  test('a second call while a pass is running does nothing; once it ends a new pass may start', async () => {
    let release;
    batch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ claimed: 0 }); }));
    const first = worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() });
    await Promise.resolve();
    expect(await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() })).toEqual({ active: true, skipped: 'already_running' });
    expect(batch).toHaveBeenCalledTimes(1);
    release();
    await first;
    await worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() });
    expect(batch).toHaveBeenCalledTimes(2);
  });
  test('a pass that throws releases the guard, so the next tick can run', async () => {
    batch.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P1001' }));
    await expect(worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() })).rejects.toThrow('boom');
    await expect(worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: logger() })).resolves.toMatchObject({ active: true });
  });
  test('through the real job runner a tick that arrives during a slow pass is skipped, never run twice', async () => {
    jest.useFakeTimers();
    try {
      let release;
      batch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ claimed: 0 }); }));
      const l = logger();
      const runner = createJobRunner([{ ...job, run: () => worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l }) }], { logger: l });
      runner.start();
      await jest.advanceTimersByTimeAsync(10000);
      await jest.advanceTimersByTimeAsync(10000); // the next tick while the first pass is still running
      expect(batch).toHaveBeenCalledTimes(1);
      expect(l.warn).toHaveBeenCalledWith('[jobs] "razorpay-webhook-inbox" is still running, skipping this run.');
      release();
      await jest.advanceTimersByTimeAsync(0);
      await runner.stop();
    } finally { jest.useRealTimers(); }
  });
});

describe('exceptions and safe logging', () => {
  const SENSITIVE = 'ER_DUP_ENTRY razorpay_payment pay_SECRET123 4111111111111111 user@example.com rzp_secret';
  test('an exception from the pass reaches the job runner, which logs the job name and a safe CODE only: never the message', async () => {
    jest.useFakeTimers();
    try {
      batch.mockRejectedValue(Object.assign(new Error(SENSITIVE), { code: 'P2034' }));
      const l = logger();
      const runner = createJobRunner([{ ...job, run: () => worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l }) }], { logger: l });
      runner.start();
      await jest.advanceTimersByTimeAsync(10000);
      await runner.stop();
      expect(l.error).toHaveBeenCalledWith('[jobs] "razorpay-webhook-inbox" failed: P2034');
      expect(lines(l).join('\n')).not.toMatch(/SECRET|4111|example\.com|rzp_|ER_DUP/);
    } finally { jest.useRealTimers(); }
  });
  test('an exception whose code is not identifier-shaped falls back to the error class name', async () => {
    jest.useFakeTimers();
    try {
      batch.mockRejectedValue(Object.assign(new TypeError(SENSITIVE), { code: SENSITIVE }));
      const l = logger();
      const runner = createJobRunner([{ ...job, run: () => worker.runRazorpayWebhookWorker({ env: GOOD, db: fakeDb(), logger: l }) }], { logger: l });
      runner.start();
      await jest.advanceTimersByTimeAsync(10000);
      await runner.stop();
      expect(l.error).toHaveBeenCalledWith('[jobs] "razorpay-webhook-inbox" failed: TypeError');
    } finally { jest.useRealTimers(); }
  });
  test('the worker module itself never logs an exception, a message, a payload or a secret: its log lines are fixed texts and counts', async () => {
    const l = logger();
    batch.mockResolvedValue({ claimed: 1, processed: 1 });
    await worker.runRazorpayWebhookWorker({ env: { ...GOOD }, db: fakeDb(), logger: l });
    await worker.runRazorpayWebhookWorker({ env: { ...GOOD, PAYMENTS_ENABLED: 'no' }, db: fakeDb(), logger: l });
    for (const line of lines(l)) expect(line).toMatch(/^\[razorpay-webhook\] (worker active\.|not processing events: [a-z_]+\.|pass: (\w+=\d+ ?)+)$/);
  });
  test('static: the worker source has no console call of its own (only the injected logger), no .message, no network and no Razorpay API', () => {
    const code = fs.readFileSync(path.join(__dirname, '../../src/modules/payments/razorpay-webhook.worker.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/console\.|\.message|\.stack|JSON\.stringify|fetch\(|require\('https?'\)|razorpay\.api|payment-orders/);
    expect(code).not.toMatch(/\bcatch\b/); // exceptions go to the job runner untouched; nothing here can swallow or print them
  });
});
