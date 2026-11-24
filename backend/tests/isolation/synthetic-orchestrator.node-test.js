// Standalone (node:test) checks for the synthetic E2E orchestrator's guards. No database, no jest globalSetup, no
// network, no firewall change, no Bitrix. Run: npm run test:synthetic-orchestrator
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.resolve(__dirname, '..', '..', 'scripts', 'synthetic-e2e-orchestrator');
const safety = require(path.join(dir, 'safety'));
const config = require(path.join(dir, 'config'));
const { splitPhone } = require(path.join(dir, 'browserJourney'));
const { parseArgs } = require(path.join(dir, 'run'));
const { generateRunId, buildIdentity } = require(path.join(dir, 'identity'));
const cleanup = require(path.join(dir, 'cleanup'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synth-orch-'));

test('requests 155, 156 and 157 are refused', () => {
  for (const id of [155, 156, 157, '155']) assert.throws(() => safety.assertNotProtected(id), { code: 'protected_request' });
  assert.strictEqual(safety.assertNotProtected(158), 158);
});

test('audit tables are on the never-delete list and cleanup never deletes them', () => {
  for (const t of ['request_events', 'security_events', 'cases', 'bitrix_deal_links', 'integration_outbox']) assert.ok(safety.NEVER_DELETE_TABLES.includes(t));
  const src = fs.readFileSync(path.join(dir, 'cleanup.js'), 'utf8');
  assert.ok(!/(requestEvent|securityEvent|case|bitrixDealLink|integrationOutbox)\.delete/.test(src));
});

test('run ids and identities carry the synthetic markers', () => {
  const id = generateRunId();
  assert.match(id, /^[A-Za-z0-9_-]{3,40}$/);
  const who = buildIdentity(id, '+917000000001');
  assert.ok(who.patientName.startsWith('ZZ-SYNTHETIC'));
});

test('phone lock: exclusive, re-entrant for owner, released only by owner', () => {
  const locks = tmp();
  const a = safety.tryAcquirePhoneLock(locks, '+917000000001', 'run-a');
  assert.ok(a);
  assert.strictEqual(safety.tryAcquirePhoneLock(locks, '+917000000001', 'run-a'), a);
  const live = { processState: () => ({ alive: true, isNode: true }) };
  assert.strictEqual(safety.tryAcquirePhoneLock(locks, '+917000000001', 'run-b', { guard: live }), null);
  assert.strictEqual(safety.releasePhoneLock(a, 'run-b').released, false);
  assert.strictEqual(safety.releasePhoneLock(a, 'run-a').released, true);
});

test('phone lock: fails closed when liveness cannot be verified', () => {
  const locks = tmp();
  safety.tryAcquirePhoneLock(locks, '+917000000002', 'run-a');
  const broken = { processState: () => { throw new Error('boom'); } };
  assert.throws(() => safety.tryAcquirePhoneLock(locks, '+917000000002', 'run-b', { guard: broken }), { code: 'ownership_unverifiable' });
});

test('the Bitrix client source has no proxy/dispatcher patterns', () => {
  const r = config.scanBitrixSourceForProxyPatterns(path.resolve(dir, '..', '..', 'src', 'modules', 'bitrix'));
  assert.deepStrictEqual(r.findings, []);
});

test('cleanup refuses a manifest without the synthetic marker', async () => {
  const runs = tmp();
  fs.mkdirSync(path.join(runs, 'r1'));
  fs.writeFileSync(path.join(runs, 'r1', 'manifest.json'), JSON.stringify({ runId: 'r1', identity: { patientName: 'Real Person', email: 'real@example.com' } }));
  await assert.rejects(cleanup.runCleanup({}, runs, 'r1'), { code: 'not_synthetic' });
});

test('argument parsing and phone splitting', () => {
  assert.strictEqual(parseArgs(['--headless']).headless, true);
  assert.throws(() => parseArgs(['--nope']));
  // The attach-to-existing-services options are gone: the orchestrator always runs its own isolated stack.
  for (const removed of ['--spawn-worker', '--web-url', '--api-url']) assert.throws(() => parseArgs([removed, 'x']), /was removed/);
  assert.strictEqual(splitPhone('+917000000001'), '7000000001');
  assert.throws(() => splitPhone('+447000000001'));
});

test('orchestrator sources never import Bitrix client code', () => {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\([^)]*(bitrix-deal\.api|bitrix-outbox|deal-outbox|bitrix\.service|bitrix-sync)/.test(text), `${f} imports Bitrix client code`);
  }
});
