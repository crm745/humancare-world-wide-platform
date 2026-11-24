/* global describe, test, expect, jest, beforeEach */
// scripts/synthetic-approve.js is now only a guarded recovery / diagnostic wrapper around the engine. These tests use a fake engine.
const fs = require('fs');
const path = require('path');
const { run, parseArgs, describe: describeResult } = require('../../scripts/synthetic-approve');

const ENV = { ALLOW_SYNTHETIC_APPROVAL: 'true', DATABASE_URL: 'mysql://user:pw@localhost:3306/humancare_dev' };
let engine;
beforeEach(() => {
  engine = {
    processRequest: jest.fn(async () => ({ entered: true, outcome: 'approved' })),
    diagnose: jest.fn(async () => ({ outcome: 'active', failures: 1, claimLive: false, requestStatus: 'in_review', expectedDocuments: 2, ready: false, code: 'unscanned' })),
  };
});
const go = (argv = ['61'], env = ENV) => run({ argv, env, engine });

describe('recovery run', () => {
  test('runs ONE pass of the engine in recovery mode and reports only the outcome', async () => {
    const result = await go();
    expect(engine.processRequest).toHaveBeenCalledWith(61, { mode: 'recovery' });
    expect(describeResult(result, 61)).toBe('synthetic request 61: approved');
  });
  test('an engine refusal (no marker, invalid, expired, revoked, consumed, wrong owner...) is reported by code, exit code 2 when it never entered', async () => {
    for (const outcome of ['not_synthetic', 'marker_invalid', 'disabled', 'database_not_identified']) {
      engine.processRequest.mockResolvedValueOnce({ entered: false, outcome });
      expect(await go()).toMatchObject({ ok: false, exitCode: 2, code: outcome });
    }
    for (const outcome of ['expired', 'revoked', 'refused', 'waiting', 'claimed_elsewhere', 'retry_later']) {
      engine.processRequest.mockResolvedValueOnce({ entered: true, outcome, code: 'x' });
      expect(await go()).toMatchObject({ ok: false, code: outcome });
    }
    engine.processRequest.mockResolvedValueOnce({ entered: true, outcome: 'consumed' });
    expect(await go()).toMatchObject({ ok: true });
  });
  test('--dry-run is read-only: it only diagnoses and prints counts and codes', async () => {
    const result = await go(['61', '--dry-run']);
    expect(engine.processRequest).not.toHaveBeenCalled();
    expect(engine.diagnose).toHaveBeenCalledWith(61, { mode: 'recovery' });
    expect(describeResult(result, 61)).toBe('synthetic request 61: marker active, status in_review, failures 1, claim none, documents expected 2, not ready (unscanned)');
    engine.diagnose.mockResolvedValueOnce({ outcome: 'not_synthetic' });
    expect(await go(['61', '--dry-run'])).toMatchObject({ ok: false, exitCode: 2, code: 'not_synthetic' });
  });
});

describe('guards', () => {
  test.each([
    ['no opt-in', () => go(['61'], { ...ENV, ALLOW_SYNTHETIC_APPROVAL: undefined }), 'opt_in_missing'],
    ['opt-in not exactly true', () => go(['61'], { ...ENV, ALLOW_SYNTHETIC_APPROVAL: '1' }), 'opt_in_missing'],
    ['production', () => go(['61'], { ...ENV, NODE_ENV: 'production' }), 'production_refused'],
    ['no request id', () => go([]), 'request_id_required'],
    ['non-numeric request id', () => go(['abc']), 'request_id_required'],
    ['two request ids (never a list)', () => go(['61', '62']), 'request_id_required'],
    ['an unknown option', () => go(['61', '--all']), 'unknown_option'],
    ['humancare_test URL', () => go(['61'], { ...ENV, DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }), 'database_not_identified'],
    ['a remote URL', () => go(['61'], { ...ENV, DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }), 'database_not_identified'],
    ['a missing URL', () => go(['61'], { ...ENV, DATABASE_URL: undefined }), 'database_not_identified'],
  ])('%s: the engine is never called', async (_name, call, code) => {
    expect(await call()).toMatchObject({ ok: false, exitCode: 2, code });
    expect(engine.processRequest).not.toHaveBeenCalled();
    expect(engine.diagnose).not.toHaveBeenCalled();
  });
  test('argument parsing', () => {
    expect(parseArgs(['61'])).toEqual({ requestId: 61, dryRun: false });
    expect(parseArgs(['--dry-run', '61'])).toEqual({ requestId: 61, dryRun: true });
  });
  test('the script contains no approval logic: it imports neither the review services nor Bitrix, payment or notification code', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/synthetic-approve.js'), 'utf8');
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).toMatch(/synthetic-approval'\)\.createEngine\(\)/);
    expect(code).not.toMatch(/approveRequest|reviewDocument|request-review\.service|bitrix|razorpay|payment|notification|\.env\.test/i);
  });
  test('the output never carries patient data, file names or secrets', async () => {
    const text = describeResult(await go(), 61);
    expect(text).not.toMatch(/pw|mysql|@|\.pdf/);
  });
});
