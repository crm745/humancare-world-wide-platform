/* global describe, test, expect, afterEach, beforeEach */
// Scanner readiness: daemon answering, version known, signatures fresh. A tiny fake clamd answers PING / VERSION / VERSIONCOMMANDS.
const net = require('net');
const clamav = require('../../src/integrations/clamav/clamav');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const dateText = (daysAgo) => new Date(NOW - daysAgo * 86400000).toUTCString().replace(/^(\w{3}), (\d+) (\w{3}) (\d{4}) ([\d:]{8}) GMT$/, '$1 $3 $2 $5 $4'); // "Tue Nov 10 06:26:51 2026"
let server;
let behaviour;

function start(mode) {
  behaviour = { ...mode };
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      socket.on('error', () => {});
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString();
        if (!buf.includes('\0')) return;
        const command = buf.replace(/\0/g, '');
        buf = '';
        if (behaviour.silent) return;
        if (command === 'zPING') return socket.end('PONG\0');
        if (command === 'zVERSION') return socket.end(behaviour.version ? `${behaviour.version}\0` : 'COMMAND UNAVAILABLE\0');
        if (command === 'zVERSIONCOMMANDS') return socket.end(behaviour.versionCommands ? `${behaviour.versionCommands}| COMMANDS: SCAN PING\0` : 'COMMAND UNAVAILABLE\0');
        return socket.end('UNKNOWN COMMAND\0');
      });
    }).listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const opts = (port, extra = {}) => ({ host: '127.0.0.1', port, timeoutMs: 800, now: () => NOW, noCache: true, env: {}, ...extra });

beforeEach(() => clamav.resetReadyCache());
afterEach(() => new Promise((r) => { if (server) { server.closeAllConnections?.(); server.close(() => r()); } else r(); }));

describe('ready()', () => {
  test('fresh signatures: ok, with engine and signature information', async () => {
    const port = await start({ version: `ClamAV 1.5.4/28179/${dateText(2)}` });
    const result = await clamav.ready(opts(port));
    expect(result).toMatchObject({ ok: true, engine: '1.5.4', signatureVersion: '28179', signatureDate: '2026-11-18' });
    expect(result.summary).toBe('ClamAV 1.5.4/28179 signatures 2026-11-18');
    expect(await clamav.isReady(opts(port))).toBe(true);
  });
  test('a daemon that refuses VERSION from TCP but answers VERSIONCOMMANDS still verifies (the WSL case)', async () => {
    const port = await start({ versionCommands: `ClamAV 1.5.4/28179/${dateText(1)}` });
    expect(await clamav.ready(opts(port))).toMatchObject({ ok: true, signatureVersion: '28179' });
  });
  test('stale signatures (older than 7 days by default) are not ready, and the age is reported', async () => {
    const port = await start({ version: `ClamAV 1.5.4/28179/${dateText(10)}` });
    expect(await clamav.ready(opts(port))).toMatchObject({ ok: false, reason: 'signatures_stale', maxAgeDays: 7, signatureDate: '2026-11-10' });
    expect(await clamav.isReady(opts(port))).toBe(false);
  });
  test('the maximum age is configurable; bad values fall back to 7', async () => {
    const port = await start({ version: `ClamAV 1.5.4/28179/${dateText(10)}` });
    expect((await clamav.ready(opts(port, { env: { CLAMAV_MAX_SIGNATURE_AGE_DAYS: '14' } }))).ok).toBe(true);
    expect((await clamav.ready(opts(port, { env: { CLAMAV_MAX_SIGNATURE_AGE_DAYS: 'banana' } }))).reason).toBe('signatures_stale');
    expect((await clamav.ready(opts(port, { env: { CLAMAV_MAX_SIGNATURE_AGE_DAYS: '-3' } }))).reason).toBe('signatures_stale');
  });
  test('missing, unparsable or future signature information is not ready', async () => {
    let port = await start({});
    expect(await clamav.ready(opts(port))).toMatchObject({ ok: false, reason: expect.stringMatching(/^version_(unavailable|unparsable)$/) }); // both commands refused
    await new Promise((r) => server.close(r));
    port = await start({ version: 'ClamAV something odd' });
    expect(await clamav.ready(opts(port))).toMatchObject({ ok: false, reason: 'version_unparsable' });
    await new Promise((r) => server.close(r));
    port = await start({ version: 'ClamAV 1.5.4/28179/Tue Nov 10 99:99:99 2026' });
    expect((await clamav.ready(opts(port))).ok).toBe(false);
    await new Promise((r) => server.close(r));
    port = await start({ version: `ClamAV 1.5.4/28179/${dateText(-30)}` });
    expect(await clamav.ready(opts(port))).toMatchObject({ ok: false, reason: 'signature_date_in_future' });
  });
  test('unreachable and timed-out daemons are not ready', async () => {
    const port = await start({});
    await new Promise((r) => server.close(r));
    server = null;
    expect(await clamav.ready(opts(port))).toEqual({ ok: false, reason: 'unreachable' });
    const hanging = await start({ silent: true });
    expect(await clamav.ready(opts(hanging, { timeoutMs: 300 }))).toMatchObject({ ok: false });
  });
  test('only a success is cached (a failure is retried at once)', async () => {
    const port = await start({ version: `ClamAV 1.5.4/28179/${dateText(10)}` });
    const cached = { ...opts(port), noCache: false };
    expect((await clamav.ready(cached)).ok).toBe(false);
    behaviour.version = `ClamAV 1.5.4/28180/${dateText(0)}`;
    expect((await clamav.ready(cached)).ok).toBe(true); // the failure above was not cached
    behaviour.version = `ClamAV 1.5.4/28181/${dateText(30)}`;
    expect((await clamav.ready(cached)).ok).toBe(true); // within the cache window the earlier success stands
    expect((await clamav.ready({ ...cached, now: () => NOW + 60000 })).ok).toBe(false); // after it, the daemon is asked again
  });
  test('lastSummary() holds the engine / signature line of the last successful check, for scan_detail', async () => {
    expect(clamav.lastSummary()).toBeNull();
    const port = await start({ version: `ClamAV 1.5.4/28179/${dateText(1)}` });
    await clamav.ready(opts(port));
    expect(clamav.lastSummary()).toMatch(/^ClamAV 1\.5\.4\/28179 signatures 2026-11-19$/);
    expect(clamav.lastSummary().length).toBeLessThan(255);
  });
});
