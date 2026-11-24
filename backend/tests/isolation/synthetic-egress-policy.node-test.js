// Pure policy tests (node:test): which destinations are blocked. No network, no processes.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const dir = path.resolve(__dirname, '..', '..', 'scripts', 'synthetic-e2e-orchestrator');
const policyLib = require(path.join(dir, 'egressPolicy'));
const { createPolicy, canonicalIp, normalizeHost, CANARY_HOST, CANARY_IP } = policyLib;

const portal = createPolicy({ blockedHosts: ['Acme-Portal.bitrix24.in'], blockedIps: ['198.51.100.7', '2001:db8::7'] });

test('the configured portal host is blocked, case-insensitively and with a trailing dot', () => {
  for (const h of ['acme-portal.bitrix24.in', 'ACME-PORTAL.BITRIX24.IN', 'acme-portal.bitrix24.in.']) assert.strictEqual(portal.checkName(h).blocked, true, h);
});

test('ANY Bitrix24-looking portal name is blocked, not only the configured one', () => {
  for (const h of ['other.bitrix24.in', 'x.y.bitrix24.com', 'portal.bitrix24.eu', 'bitrix24.net', 'www.bitrix.info', 'a.bitrix24.invalid']) assert.strictEqual(portal.checkName(h).blocked, true, h);
});

test('labels are matched, not substrings: unrelated names that merely contain the text stay reachable', () => {
  for (const h of ['notbitrix24.example', 'bitrix24-fan.example.org', 'identitytoolkit.googleapis.com', 'www.google.com', 'localhost', 'smtp.gmail.com', 'exp.host']) assert.strictEqual(portal.checkName(h).blocked, false, h);
});

test('the pinned portal addresses are blocked; neighbouring and unrelated addresses are not (no machine-wide range)', () => {
  assert.strictEqual(portal.checkIp('198.51.100.7').blocked, true);
  assert.strictEqual(portal.checkIp('2001:db8::7').blocked, true);
  for (const ip of ['198.51.100.8', '198.51.100.6', '127.0.0.1', '::1', '52.66.109.149']) assert.strictEqual(portal.checkIp(ip).blocked, false, ip);
});

test('every spelling of a blocked IPv4 address is recognised (hex, octal, decimal, short, mapped IPv6)', () => {
  const p = createPolicy({ blockedIps: ['52.66.109.148'] });
  for (const spelling of ['52.66.109.148', '0x34.0x42.0x6d.0x94', '0x34426d94', '876768660', '064.0102.0155.0224', '::ffff:52.66.109.148', '::ffff:3442:6d94', '[::ffff:52.66.109.148]']) {
    assert.strictEqual(p.check(spelling).blocked, true, spelling);
  }
  assert.strictEqual(p.check('52.66.109.149').blocked, false);
  assert.strictEqual(canonicalIp('127.1'), '127.0.0.1');
  assert.strictEqual(canonicalIp('example.com'), null);
  assert.strictEqual(canonicalIp('1.2.3.4.5'), null);
});

test('check() routes an address to the IP rules and a name to the name rules', () => {
  assert.deepStrictEqual({ kind: portal.check('198.51.100.7').kind, blocked: portal.check('198.51.100.7').blocked }, { kind: 'ip', blocked: true });
  assert.deepStrictEqual({ kind: portal.check('acme-portal.bitrix24.in').kind, blocked: portal.check('acme-portal.bitrix24.in').blocked }, { kind: 'name', blocked: true });
  assert.strictEqual(portal.isBlocked('127.0.0.1'), false);
});

test('the canary name and the canary address are ALWAYS blocked, whatever else is configured', () => {
  const empty = createPolicy({});
  assert.strictEqual(empty.checkName(CANARY_HOST).blocked, true);
  assert.strictEqual(empty.checkIp(CANARY_IP).blocked, true);
});

test('the policy travels to child processes through the environment and round-trips exactly', () => {
  const env = policyLib.policyToEnv(portal);
  const again = policyLib.policyFromEnv(env);
  assert.deepStrictEqual(again.snapshot().blockedHosts.sort(), portal.snapshot().blockedHosts.sort());
  assert.deepStrictEqual(again.snapshot().blockedIps.sort(), portal.snapshot().blockedIps.sort());
  assert.strictEqual(again.checkName('acme-portal.bitrix24.in').blocked, true);
});

test('an unreadable policy in the environment is an error (a guard must never start with no policy)', () => {
  assert.throws(() => policyLib.policyFromEnv({ [policyLib.ENV_HOSTS]: '{oops', [policyLib.ENV_IPS]: '[]' }), /unreadable/);
});

test('normalizeHost tidies brackets, zones and trailing dots only', () => {
  assert.strictEqual(normalizeHost('[::1]'), '::1');
  assert.strictEqual(normalizeHost('FE80::1%eth0'), 'fe80::1');
  assert.strictEqual(normalizeHost('Host.Example.'), 'host.example');
  assert.strictEqual(normalizeHost(undefined), '');
});
