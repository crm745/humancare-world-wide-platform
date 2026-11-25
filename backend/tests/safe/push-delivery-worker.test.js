/* global describe, test, expect, jest, beforeEach, afterEach */
// The dedicated push worker (src/push-delivery-worker.js): what it starts, what it never loads, how it stops, and that the main worker no longer
// schedules the push job. Fakes only: a fake database client, fake or real (fake-timer) job runners, no database, no Expo client, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: new Proxy({}, { get() { throw new Error('the push worker touched the database'); } }) }));
// The Bitrix settings check is made to FAIL: the dedicated worker must start anyway, and must never call it.
jest.mock('../../src/modules/bitrix/bitrix-config', () => ({
  ...jest.requireActual('../../src/modules/bitrix/bitrix-config'),
  assertBitrixConfiguration: jest.fn(() => { throw new Error('Bitrix24 settings are not valid: simulated'); }),
}));

const fs = require('fs');
const path = require('path');
const pushWorker = require('../../src/push-delivery-worker');
const pushJob = require('../../src/jobs/push-delivery.job');
const reconcileJob = require('../../src/jobs/case-stage-notification-reconcile.job');
const bitrixConfig = require('../../src/modules/bitrix/bitrix-config');
const { createJobRunner } = require('../../src/jobs/job-runner');
const monitorModule = require('../../src/modules/notifications/push-delivery.monitor');

const SRC = path.join(__dirname, '../../src');
const ENV_KEYS = ['PUSH_DELIVERY_ENABLED', 'EXPO_PUSH_ACCESS_TOKEN', 'NODE_ENV', 'HUMANCARE_SCOPED_RUN', 'HUMANCARE_INTEGRATION_RUN', 'SYNTHETIC_E2E_AUTO_APPROVE', 'ALLOW_SYNTHETIC_APPROVAL'];
let savedEnv;

function harness(over = {}) {
  const runner = { start: jest.fn(), stop: jest.fn(async () => undefined) };
  const createRunner = jest.fn(() => runner);
  const log = { log: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const exit = jest.fn();
  const prisma = { $disconnect: jest.fn(async () => undefined) };
  const logStartup = jest.fn();
  return { runner, createRunner, log, exit, prisma, logStartup, deps: { skipDotenv: true, signals: false, prisma, createJobRunner: createRunner, logStartup, log, exit, ...over } };
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

beforeEach(() => {
  pushWorker.resetForTests();
  monitorModule.resetStartupForTests();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  bitrixConfig.assertBitrixConfiguration.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('what the dedicated worker starts', () => {
  test('exactly two jobs, the existing push-delivery job and the stage-notification recovery job (not copies), through ONE runner that is started once', () => {
    const h = harness();
    const instance = pushWorker.main(h.deps);
    expect(h.createRunner).toHaveBeenCalledTimes(1);
    const jobs = h.createRunner.mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toBe(pushJob); // the same objects the job files export: no logic is duplicated here
    expect(jobs[1]).toBe(reconcileJob);
    expect(jobs[0]).toMatchObject({ name: 'push-delivery', intervalMs: 15000, runOnStart: false });
    expect(jobs[1]).toMatchObject({ name: 'case-stage-notification-reconcile', intervalMs: 180000, runOnStart: false });
    expect(h.runner.start).toHaveBeenCalledTimes(1);
    expect(instance.jobNames).toEqual(['push-delivery', 'case-stage-notification-reconcile']);
    expect(h.log.log).toHaveBeenCalledWith('[push-worker] Started jobs: push-delivery, case-stage-notification-reconcile');
  });

  test('with the real job runner the recovery job is scheduled every 3 minutes, never on start, and the push job keeps its own 15 s schedule', async () => {
    jest.useFakeTimers();
    const push = jest.spyOn(pushJob, 'run').mockResolvedValue({ active: false });
    const reconcile = jest.spyOn(reconcileJob, 'run').mockResolvedValue({ active: true });
    const h = harness({ createJobRunner });
    pushWorker.main(h.deps);
    expect(reconcile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(179 * 1000);
    expect(reconcile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(12);
    await jest.advanceTimersByTimeAsync(180 * 1000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await pushWorker.main(h.deps).shutdown('SIGTERM');
  });

  test('with the real job runner only push-delivery is ever scheduled, and nothing runs at start', async () => {
    jest.useFakeTimers();
    const run = jest.spyOn(pushJob, 'run').mockResolvedValue({ active: false, problem: 'switch_off' });
    const h = harness({ createJobRunner });
    pushWorker.main(h.deps);
    expect(run).not.toHaveBeenCalled(); // runOnStart is false
    await jest.advanceTimersByTimeAsync(14 * 1000);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30 * 1000);
    expect(run).toHaveBeenCalledTimes(3);
    await pushWorker.main(h.deps).shutdown('SIGTERM');
  });

  test('it does not require, load or call the Bitrix configuration, the main worker or the main job list', async () => {
    const h = harness({ createJobRunner });
    jest.useFakeTimers();
    pushWorker.main(h.deps); // the (mocked) Bitrix check would throw if anything called it
    await jest.advanceTimersByTimeAsync(16 * 1000);
    expect(bitrixConfig.assertBitrixConfiguration).not.toHaveBeenCalled();
    expect(h.log.error).not.toHaveBeenCalled();
    expect(h.runner).toBeDefined();
    // The same, by reading the code (comments removed): no reference to any of them.
    const code = fs.readFileSync(path.join(SRC, 'push-delivery-worker.js'), 'utf8').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n');
    expect(code).not.toMatch(/bitrix/i);
    expect(code).not.toMatch(/require\('\.\/worker'\)|require\('\.\/jobs'\)|require\('\.\/jobs\/index'\)/);
    expect(code.match(/require\('[^']+'\)/g).sort()).toEqual([
      "require('./db/prisma')", "require('./jobs/case-stage-notification-reconcile.job')", "require('./jobs/job-runner')", "require('./jobs/push-delivery.job')", "require('./modules/notifications/push-delivery.monitor')", "require('dotenv')",
    ].sort());
    await pushWorker.main(h.deps).shutdown('SIGTERM');
  });

  test('a second start in the same process is refused: same instance, one runner, one start, one startup line', () => {
    const h = harness();
    const first = pushWorker.main(h.deps);
    const second = pushWorker.main(h.deps);
    expect(second).toBe(first);
    expect(h.createRunner).toHaveBeenCalledTimes(1);
    expect(h.runner.start).toHaveBeenCalledTimes(1);
    expect(h.logStartup).toHaveBeenCalledTimes(1);
  });

  test('the signal handlers are registered once (a refused second start adds none)', () => {
    const on = jest.spyOn(process, 'on').mockImplementation(() => process);
    const h = harness({ signals: undefined });
    pushWorker.main(h.deps);
    pushWorker.main(h.deps);
    expect(on.mock.calls.map((c) => c[0]).sort()).toEqual(['SIGINT', 'SIGTERM']);
  });
});

describe('startup configuration logging', () => {
  test('is invoked once, after the job has started, with the worker logger', () => {
    const h = harness();
    h.runner.start.mockImplementation(() => { expect(h.logStartup).not.toHaveBeenCalled(); });
    pushWorker.main(h.deps);
    expect(h.logStartup).toHaveBeenCalledTimes(1);
    expect(h.logStartup).toHaveBeenCalledWith({ log: h.log });
  });

  test('the real startup line reports the default (disabled) state and builds no client, reads no database, makes no network call', () => {
    delete process.env.PUSH_DELIVERY_ENABLED;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const h = harness();
    delete h.deps.logStartup; // use the real one
    pushWorker.main(h.deps);
    expect(h.log.info).toHaveBeenCalledTimes(1);
    expect(h.log.info.mock.calls[0][0]).toMatch(/^\[push-delivery\] startup: delivery=disabled, expoAccessTokenConfigured=(yes|no), environment=\w+, attemptingDelivery=no, reason=/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.prisma.$disconnect).not.toHaveBeenCalled();
  });

  test('a failing startup line never stops the worker', () => {
    const h = harness({ logStartup: jest.fn(() => { throw new Error('boom'); }) });
    expect(() => pushWorker.main(h.deps)).not.toThrow();
    expect(h.runner.start).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  test('a runner that cannot start is reported, the database is closed and the process exits with 1', async () => {
    const h = harness();
    h.runner.start.mockImplementation(() => { throw new Error('cannot start'); });
    pushWorker.main(h.deps);
    await flush();
    expect(h.log.error).toHaveBeenCalledWith('[push-worker] Could not start:', 'cannot start');
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.logStartup).not.toHaveBeenCalled();
  });
});

describe('the kill-switch and the suppression rules are unchanged (decided by the job, on every run)', () => {
  test('default environment: the scheduled run does nothing (no database, no Expo, no network) and the startup line says why', async () => {
    jest.useFakeTimers();
    delete process.env.PUSH_DELIVERY_ENABLED;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ createJobRunner });
    delete h.deps.logStartup;
    pushWorker.main(h.deps);
    const run = jest.spyOn(pushJob, 'run');
    await jest.advanceTimersByTimeAsync(16 * 1000); // the first scheduled run
    expect(run).toHaveBeenCalledTimes(1);
    await expect(run.mock.results[0].value).resolves.toEqual({ active: false, problem: 'switch_off' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled(); // the stub database throws on any access, which the runner would have logged
    expect(h.log.info.mock.calls[0][0]).toContain('reason=switch_off');
    await pushWorker.main(h.deps).shutdown('SIGTERM');
  });

  test.each([
    ['a test environment', { NODE_ENV: 'test' }, 'suppressed_test_environment'],
    ['a scoped run', { NODE_ENV: 'production', HUMANCARE_SCOPED_RUN: 'true' }, 'suppressed_scoped_test_run'],
    ['an integration run', { NODE_ENV: 'production', HUMANCARE_INTEGRATION_RUN: 'true' }, 'suppressed_integration_test_run'],
    ['a synthetic run', { NODE_ENV: 'production', SYNTHETIC_E2E_AUTO_APPROVE: 'true' }, 'suppressed_synthetic_run'],
  ])('%s stays suppressed even with the switch on and a valid token: nothing runs', async (_name, extra, problem) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    Object.assign(process.env, { PUSH_DELIVERY_ENABLED: 'true', EXPO_PUSH_ACCESS_TOKEN: 'a'.repeat(40), ...extra });
    expect(await pushJob.run()).toEqual({ active: false, problem }); // the stub database would throw if anything touched it
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('"TRUE", "1" and a missing token do not enable it either', async () => {
    for (const env of [{ PUSH_DELIVERY_ENABLED: 'TRUE' }, { PUSH_DELIVERY_ENABLED: '1' }]) {
      Object.assign(process.env, { NODE_ENV: 'production', EXPO_PUSH_ACCESS_TOKEN: 'a'.repeat(40), ...env });
      expect(await pushJob.run()).toEqual({ active: false, problem: 'switch_off' });
    }
    Object.assign(process.env, { NODE_ENV: 'production', PUSH_DELIVERY_ENABLED: 'true' });
    delete process.env.EXPO_PUSH_ACCESS_TOKEN;
    expect(await pushJob.run()).toEqual({ active: false, problem: 'access_token_missing' });
  });
});

describe('graceful shutdown', () => {
  test('stops the scheduler first, then closes the database, then exits with 0', async () => {
    const h = harness();
    const order = [];
    h.runner.stop.mockImplementation(async () => { order.push('stop'); });
    h.prisma.$disconnect.mockImplementation(async () => { order.push('disconnect'); });
    h.exit.mockImplementation((code) => order.push(`exit:${code}`));
    await pushWorker.main(h.deps).shutdown('SIGTERM');
    expect(order).toEqual(['stop', 'disconnect', 'exit:0']);
    expect(h.log.log).toHaveBeenCalledWith('[push-worker] Stopped.');
  });

  test('shutdown stops BOTH scheduled jobs: a recovery run in progress is waited for and neither job is scheduled again', async () => {
    jest.useFakeTimers();
    let finishReconcile;
    const reconcileRun = jest.fn(() => new Promise((resolve) => { finishReconcile = resolve; }));
    const pushRun = jest.fn(async () => ({ active: false }));
    const h = harness({ createJobRunner, job: { name: 'push-delivery', intervalMs: 15000, runOnStart: false, run: pushRun }, reconcileJob: { name: 'case-stage-notification-reconcile', intervalMs: 180000, runOnStart: true, run: reconcileRun } });
    const instance = pushWorker.main(h.deps);
    expect(reconcileRun).toHaveBeenCalledTimes(1); // in progress
    let stopped = false;
    const shutting = instance.shutdown('SIGTERM').then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    expect(h.exit).not.toHaveBeenCalled();
    finishReconcile({ active: true });
    await shutting;
    expect(h.exit).toHaveBeenCalledWith(0);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(reconcileRun).toHaveBeenCalledTimes(1);
    expect(pushRun).not.toHaveBeenCalled();
  });

  test('waits for a run in progress and schedules no new run afterwards', async () => {
    jest.useFakeTimers();
    let finish;
    const run = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const job = { name: 'push-delivery', intervalMs: 15000, runOnStart: true, run };
    const h = harness({ createJobRunner, job });
    const instance = pushWorker.main(h.deps);
    expect(run).toHaveBeenCalledTimes(1); // in progress
    let stopped = false;
    const shutting = instance.shutdown('SIGTERM').then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.prisma.$disconnect).not.toHaveBeenCalled();
    finish({ active: false });
    await shutting;
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect(run).toHaveBeenCalledTimes(1); // nothing was scheduled again
  });

  test('a failure while stopping or disconnecting still closes everything and exits with 1', async () => {
    const h = harness();
    h.runner.stop.mockRejectedValue(new Error('stop failed'));
    h.prisma.$disconnect.mockRejectedValue(new Error('disconnect failed'));
    await pushWorker.main(h.deps).shutdown('SIGINT');
    expect(h.runner.stop).toHaveBeenCalledTimes(1);
    expect(h.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  test('a second signal exits at once without stopping again', async () => {
    const h = harness();
    h.runner.stop.mockImplementation(() => new Promise(() => {})); // the first shutdown never finishes
    const instance = pushWorker.main(h.deps);
    instance.shutdown('SIGTERM');
    await flush();
    await instance.shutdown('SIGTERM');
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.runner.stop).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith('[push-worker] SIGTERM received again, exiting without waiting.');
  });

  test('SIGTERM and SIGINT are wired to the shutdown', async () => {
    const handlers = {};
    jest.spyOn(process, 'on').mockImplementation((signal, fn) => { handlers[signal] = fn; return process; });
    const h = harness({ signals: undefined });
    pushWorker.main(h.deps);
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM']);
    await handlers.SIGTERM();
    expect(h.runner.stop).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('the main worker no longer schedules push delivery', () => {
  const { jobs } = require('../../src/jobs');
  const jobFiles = fs.readdirSync(path.join(SRC, 'jobs')).filter((f) => f.endsWith('.job.js'));

  test('push-delivery is not in the main job list, and the list is unchanged otherwise: every other job file is still registered', () => {
    const names = jobs.map((j) => j.name);
    expect(names).not.toContain('push-delivery');
    expect(names).not.toContain('case-stage-notification-reconcile');
    const dedicated = ['push-delivery.job.js', 'case-stage-notification-reconcile.job.js']; // scheduled by the dedicated push worker only
    const others = jobFiles.filter((f) => !dedicated.includes(f)).map((f) => require(path.join(SRC, 'jobs', f)).name).sort();
    expect([...names].sort()).toEqual(others);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(names.length);
  });

  test('the push job and the recovery job are each scheduled by exactly one place: the dedicated worker', () => {
    const h = harness();
    pushWorker.main(h.deps);
    const scheduled = [...jobs, ...h.createRunner.mock.calls[0][0]].map((j) => j.name);
    expect(scheduled.filter((n) => n === 'push-delivery')).toHaveLength(1);
    expect(scheduled.filter((n) => n === 'case-stage-notification-reconcile')).toHaveLength(1);
  });

  test('src/worker.js has no push-delivery code (its Bitrix check and job runner are untouched)', () => {
    const text = fs.readFileSync(path.join(SRC, 'worker.js'), 'utf8');
    expect(text).not.toMatch(/push-delivery|logStartup|reconcil/);
    expect(text).toMatch(/assertBitrixConfiguration/);
    expect(text).toMatch(/const \{ jobs \} = require\('\.\/jobs'\)/);
  });

  test('the package script launches the dedicated worker and the other worker scripts are unchanged', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(scripts['start:worker:push']).toBe('node src/push-delivery-worker.js');
    expect(scripts['start:worker']).toBe('node src/worker.js');
    expect(scripts['start:worker:synthetic-e2e']).toBe('node src/synthetic-e2e-worker.js');
  });
});
