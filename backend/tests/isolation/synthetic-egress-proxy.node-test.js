// Browser-side isolation tests (node:test): the filtering proxy Chromium is launched through, and the pure launch/route
// helpers of browserJourney.js. Local mock endpoints only (127.0.0.1 allowed side, 127.0.0.2 as the "Bitrix" stand-in).
// No real browser is started here: the in-browser canary and the real browser run only in the live journey.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const dir = path.resolve(__dirname, '..', '..', 'scripts', 'synthetic-e2e-orchestrator');
const { createPolicy, CANARY_HOST } = require(path.join(dir, 'egressPolicy'));
const { createEgressProxy } = require(path.join(dir, 'egressProxy'));
const { proxyCanaryDenied } = require(path.join(dir, 'isolationSelfTest'));
const journey = require(path.join(dir, 'browserJourney'));

const listen = (server, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve(server.address().port)); });
const closeServer = (s) => new Promise((r) => s.close(() => r()));

let blockedHits = 0;
let blockedServer; let allowedServer; let echoServer; let proxy; let proxyPort; let blockedAvailable = true; let ports = {};
const policy = createPolicy({ blockedHosts: ['mock-bitrix.test'], blockedIps: ['127.0.0.2'] });
const FAKE_DNS = { 'allowed.test': '127.0.0.1', 'rebind.test': '127.0.0.2', 'mock-bitrix.test': '127.0.0.2' };

test.before(async () => {
  blockedServer = net.createServer((s) => { blockedHits += 1; s.destroy(); });
  try { ports.blocked = await listen(blockedServer, '127.0.0.2'); } catch { blockedAvailable = false; ports.blocked = 9; }
  allowedServer = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.2:${ports.blocked}/` }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`ok:${req.headers.host}`);
  });
  ports.allowed = await listen(allowedServer, '127.0.0.1');
  echoServer = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
  ports.echo = await listen(echoServer, '127.0.0.1');
  proxy = createEgressProxy({ policy, lookup: async (host) => { if (!FAKE_DNS[host]) throw new Error('ENOTFOUND'); return [{ address: FAKE_DNS[host], family: 4 }]; } });
  proxyPort = (await proxy.listen()).port;
});
test.after(async () => {
  await proxy.close();
  for (const s of [blockedServer, allowedServer, echoServer]) await closeServer(s);
});

// Sends raw bytes to the proxy and collects the answer until it ends, until `until` matches, or a short timeout.
function rawExchange(payload, { until, after } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let data = '';
    let sent = false;
    const done = () => { socket.destroy(); resolve(data); };
    socket.setTimeout(2500, done);
    socket.on('error', done);
    socket.on('close', done);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (after && !sent && /^HTTP\/1\.1 200/.test(data)) { sent = true; socket.write(after); }
      if ((until || /\r\n\r\n/).test(data)) done();
    });
  });
}

test('CONNECT to an allowed name is tunnelled (a normal https request through the proxy works)', async () => {
  const out = await rawExchange(`CONNECT allowed.test:${ports.echo} HTTP/1.1\r\nHost: allowed.test:${ports.echo}\r\n\r\n`, { until: /echo:hello/, after: 'hello' });
  assert.match(out, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(out, /echo:hello/);
});

test('plain HTTP to an allowed name is forwarded', async () => {
  const out = await rawExchange(`GET http://allowed.test:${ports.allowed}/ HTTP/1.1\r\nHost: allowed.test:${ports.allowed}\r\nConnection: close\r\n\r\n`, { until: /ok:/ });
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /ok:/);
});

test('1. browser requests to Bitrix are blocked: CONNECT to a blocked name, a Bitrix24 portal name and the canary all get 403', async () => {
  for (const host of ['mock-bitrix.test', 'acme.bitrix24.invalid', 'portal.bitrix24.in', CANARY_HOST]) {
    const out = await rawExchange(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 403/, host);
  }
  assert.strictEqual(blockedHits, 0);
});

test('plain HTTP to a Bitrix name is blocked as well (403, never forwarded)', async () => {
  const out = await rawExchange(`GET http://mock-bitrix.test:${ports.blocked}/ HTTP/1.1\r\nHost: mock-bitrix.test\r\nConnection: close\r\n\r\n`, { until: /403/ });
  assert.match(out, /^HTTP\/1\.1 403/);
  assert.strictEqual(blockedHits, 0);
});

test('a name that RESOLVES to a blocked address is blocked and the blocked address is never connected to (DNS rebinding)', async (t) => {
  if (!blockedAvailable) return t.skip('127.0.0.2 is not bindable on this machine');
  const out = await rawExchange(`CONNECT rebind.test:${ports.blocked} HTTP/1.1\r\nHost: rebind.test\r\n\r\n`);
  assert.match(out, /^HTTP\/1\.1 403/);
  assert.strictEqual(blockedHits, 0);
  return undefined;
});

test('a literal blocked address is blocked (CONNECT 127.0.0.2:port)', async (t) => {
  if (!blockedAvailable) return t.skip('127.0.0.2 is not bindable on this machine');
  const out = await rawExchange(`CONNECT 127.0.0.2:${ports.blocked} HTTP/1.1\r\nHost: 127.0.0.2\r\n\r\n`);
  assert.match(out, /^HTTP\/1\.1 403/);
  assert.strictEqual(blockedHits, 0);
  return undefined;
});

test('4. a redirect cannot bypass the proxy: the 3xx is handed back to the browser, never followed, and the next hop would be vetted again', async (t) => {
  if (!blockedAvailable) return t.skip('127.0.0.2 is not bindable on this machine');
  const out = await rawExchange(`GET http://allowed.test:${ports.allowed}/redirect HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`, { until: /Location/i });
  assert.match(out, /^HTTP\/1\.1 302/);
  assert.strictEqual(blockedHits, 0, 'the proxy followed the redirect');
  const hop = await rawExchange(`CONNECT 127.0.0.2:${ports.blocked} HTTP/1.1\r\nHost: 127.0.0.2\r\n\r\n`);
  assert.match(hop, /^HTTP\/1\.1 403/);
  return undefined;
});

test('a malformed CONNECT is rejected', async () => {
  const out = await rawExchange('CONNECT nonsense HTTP/1.1\r\n\r\n');
  assert.match(out, /^HTTP\/1\.1 400/);
});

test('every denial is recorded; the canary is a self-test event, anything else is a violation the run fails on', () => {
  const stats = proxy.stats();
  assert.ok(stats.denied.some((d) => d.host === CANARY_HOST && d.canary === true));
  const violations = proxy.violations();
  assert.ok(violations.length >= 4);
  assert.ok(violations.every((v) => v.host !== CANARY_HOST));
  assert.ok(violations.some((v) => v.host === 'mock-bitrix.test'));
  assert.ok(!stats.allowedHosts.includes(CANARY_HOST) && !stats.allowedHosts.includes('mock-bitrix.test'));
});

test('the gate\'s proxy canary probe passes against a working proxy and fails against something that is not a denying proxy', async () => {
  assert.strictEqual(await proxyCanaryDenied(proxyPort), true);
  const openSockets = new Set();
  const open = net.createServer((sock) => { openSockets.add(sock); sock.on('error', () => {}); sock.end('HTTP/1.1 200 Connection Established\r\n\r\n'); });
  const openPort = await listen(open, '127.0.0.1');
  assert.strictEqual(await proxyCanaryDenied(openPort), false);
  for (const sock of openSockets) sock.destroy();
  await closeServer(open);
  assert.strictEqual(await proxyCanaryDenied(1), false, 'nothing listening must fail the probe');
});

// ---- the pure browser helpers -------------------------------------------------------------------------------------------
test('Chromium launch options force every non-loopback request through the loopback proxy and close the side channels', () => {
  const o = journey.buildLaunchOptions({ proxyUrl: 'http://127.0.0.1:5555', blockedHosts: ['acme.bitrix24.in'] });
  assert.strictEqual(o.proxy.server, 'http://127.0.0.1:5555');
  assert.match(o.proxy.bypass, /localhost/);
  const joined = o.args.join(' ');
  assert.match(joined, /--host-resolver-rules=.*MAP acme\.bitrix24\.in ~NOTFOUND/);
  assert.match(joined, /MAP \*\.bitrix24\.in ~NOTFOUND/);
  assert.match(joined, /--disable-quic/);
  assert.match(joined, /disable_non_proxied_udp/);
});
test('the browser refuses to launch with a missing or non-loopback proxy', () => {
  for (const bad of [undefined, '', 'http://example.com:8080', 'http://10.0.0.5:8080']) assert.throws(() => journey.buildLaunchOptions({ proxyUrl: bad }), /proxy URL/);
});
test('the journey refuses to open a browser without egress isolation (fail closed, before anything is registered)', async () => {
  await assert.rejects(journey.runJourney({ webUrl: 'http://localhost:8481', identity: {}, phone: '+917000000001', testCode: '000000', pdfPath: 'x', runDir: 'x' }), /egress isolation was not supplied/);
});
test('the browser may never reach Bitrix, localhost:4000 (normal API) or localhost:4100 (payment E2E runner)', () => {
  const f = (u) => journey.forbiddenDestination(new URL(u), policy);
  assert.strictEqual(f('https://acme.bitrix24.in/rest/1/x/'), 'bitrix');
  assert.strictEqual(f(`http://mock-bitrix.test:${ports.blocked}/`), 'bitrix');
  assert.strictEqual(f('http://localhost:4000/auth/me'), 'forbidden_local_port');
  assert.strictEqual(f('http://127.0.0.1:4100/health'), 'forbidden_local_port');
  assert.strictEqual(f('http://[::1]:4000/'), 'forbidden_local_port');
  for (const ok of ['http://localhost:4400/auth/register', 'http://localhost:8481/', 'https://identitytoolkit.googleapis.com/v1/accounts', 'https://www.google.com/recaptcha/api.js']) assert.strictEqual(f(ok), null, ok);
});
