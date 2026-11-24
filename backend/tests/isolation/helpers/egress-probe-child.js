// Child process for the egress guard tests. It is started as
//     node --require scripts/synthetic-e2e-orchestrator/egressGuard.preload.js tests/isolation/helpers/egress-probe-child.js <scenario>
// so the guard is installed exactly as it is for the isolated API / worker. Each scenario makes ONE kind of outbound attempt and
// prints a single line `RESULT:{json}` saying whether the guard refused it (code EGRESS_BLOCKED) or what happened instead.
//
// SAFETY: every destination used here is a loopback address, a *.test name or a *.invalid name. A *.invalid / *.test name can
// never resolve on the public internet, and 127.0.0.2 is this machine. If a hook were missing, the attempt would fail with
// ENOTFOUND or reach only the local mock listener - it can never reach a real Bitrix portal.
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const dgram = require('dgram');
const childProcess = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const blockedPort = Number(process.env.PROBE_BLOCKED_PORT || 9);
const allowedPort = Number(process.env.PROBE_ALLOWED_PORT || 9);
const redirectPort = Number(process.env.PROBE_REDIRECT_PORT || 9);
const tcpPort = Number(process.env.PROBE_TCP_PORT || 9);

const codeOf = (e) => {
  for (let x = e; x; x = x.cause) if (x.code === 'EGRESS_BLOCKED') return 'EGRESS_BLOCKED';
  return e && (e.code || e.name || String(e));
};
const attempt = async (fn) => {
  try {
    const result = await fn();
    return { blocked: false, result };
  } catch (e) {
    return { blocked: codeOf(e) === 'EGRESS_BLOCKED', code: codeOf(e), message: String(e && e.message).slice(0, 160) };
  }
};
const netConnect = (options) => new Promise((resolve, reject) => {
  const s = net.connect(options);
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', reject);
});
const stubLookup = (address) => (host, options, cb) => (options && options.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4));

const scenarios = {
  fetch_ip: () => fetch(`http://127.0.0.2:${blockedPort}/`).then((r) => r.status),
  fetch_name: () => fetch(`http://mock-bitrix.test:${blockedPort}/`).then((r) => r.status),
  fetch_portal_pattern: () => fetch('https://acme.bitrix24.invalid/rest/1/webhook/crm.deal.add.json', { method: 'POST', body: '{}' }).then((r) => r.status),
  fetch_redirect_ip: () => fetch(`http://127.0.0.1:${redirectPort}/to-ip`).then((r) => r.status),
  fetch_redirect_name: () => fetch(`http://127.0.0.1:${redirectPort}/to-name`).then((r) => r.status),
  fetch_redirect_https_pattern: () => fetch(`http://127.0.0.1:${redirectPort}/to-portal`).then((r) => r.status),
  fetch_redirect_allowed_control: () => fetch(`http://127.0.0.1:${redirectPort}/to-allowed`).then((r) => r.text()),
  http_request_ip: () => new Promise((resolve, reject) => { http.get({ host: '127.0.0.2', port: blockedPort }, (r) => resolve(r.statusCode)).on('error', reject); }),
  https_request_name: () => new Promise((resolve, reject) => { https.get({ host: 'acme.bitrix24.invalid', path: '/' }, (r) => resolve(r.statusCode)).on('error', reject); }),
  net_connect_ip: () => netConnect({ host: '127.0.0.2', port: blockedPort }),
  net_connect_name: () => netConnect({ host: 'mock-bitrix.test', port: blockedPort }),
  net_connect_trailing_dot: () => netConnect({ host: 'mock-bitrix.test.', port: blockedPort }),
  net_connect_uppercase: () => netConnect({ host: 'MOCK-Bitrix.TEST', port: blockedPort }),
  net_connect_hex_ip: () => netConnect({ host: '0x7f000002', port: blockedPort }),
  net_connect_decimal_ip: () => netConnect({ host: '2130706434', port: blockedPort }),
  net_connect_mapped_ipv6: () => netConnect({ host: '::ffff:127.0.0.2', port: blockedPort }),
  net_connect_port_host_form: () => new Promise((resolve, reject) => { const s = net.connect(blockedPort, '127.0.0.2'); s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', reject); }),
  net_rebind_via_lookup: () => netConnect({ host: 'allowed.test', port: blockedPort, lookup: stubLookup('127.0.0.2') }),
  tls_connect_name: async () => { tls.connect({ host: 'acme.bitrix24.invalid', port: 443 }); },
  tls_connect_ip: () => new Promise((resolve, reject) => { const s = tls.connect({ host: '127.0.0.2', port: blockedPort, rejectUnauthorized: false }); s.once('secureConnect', () => { s.destroy(); resolve('connected'); }); s.once('error', reject); }),
  dns_lookup_name: () => new Promise((resolve, reject) => dns.lookup('mock-bitrix.test', (e, a) => (e ? reject(e) : resolve(a)))),
  dns_promises_lookup_name: () => dns.promises.lookup('acme.bitrix24.invalid'),
  dns_resolve4_name: () => new Promise((resolve, reject) => dns.resolve4('acme.bitrix24.invalid', (e, a) => (e ? reject(e) : resolve(a)))),
  dns_promises_resolve4_name: () => dns.promises.resolve4('acme.bitrix24.invalid'),
  dns_resolver_name: () => new Promise((resolve, reject) => new dns.Resolver().resolve4('acme.bitrix24.invalid', (e, a) => (e ? reject(e) : resolve(a)))),
  dgram_name: async () => { const s = dgram.createSocket('udp4'); try { s.send(Buffer.from('x'), 9, 'mock-bitrix.test'); } finally { s.close(); } },
  dgram_ip: async () => { const s = dgram.createSocket('udp4'); try { s.send(Buffer.from('x'), 9, '127.0.0.2'); } finally { s.close(); } },
  http2_name: () => new Promise((resolve, reject) => { const s = http2.connect('https://acme.bitrix24.invalid'); s.once('connect', () => resolve('connected')); s.once('error', reject); }),
  child_process_spawn: async () => { childProcess.spawn('curl', ['http://127.0.0.2/']); },
  child_process_exec: async () => { childProcess.exec('curl http://127.0.0.2/'); },
  child_process_execFileSync: async () => { childProcess.execFileSync('curl', ['http://127.0.0.2/']); },
  worker_thread: async () => { new Worker('require("net").connect(9, "127.0.0.2")', { eval: true }); }, // eslint-disable-line no-new
  native_module: async () => { process.dlopen({ exports: {} }, path.join(BACKEND, 'unknown-addon.node')); },

  // ---- things that MUST keep working ----
  allowed_fetch_local: () => fetch(`http://127.0.0.1:${allowedPort}/`).then((r) => r.text()),
  allowed_http_local: () => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: allowedPort }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(b)); }).on('error', reject); }),
  allowed_tcp_local: () => new Promise((resolve, reject) => { const s = net.connect({ host: '127.0.0.1', port: tcpPort }); s.once('connect', () => s.write('PING')); s.once('data', (d) => { s.destroy(); resolve(d.toString()); }); s.once('error', reject); }),
  allowed_localhost_name: () => new Promise((resolve, reject) => { const s = net.connect({ host: 'localhost', port: tcpPort }); s.once('connect', () => s.write('PING')); s.once('data', (d) => { s.destroy(); resolve(d.toString()); }); s.once('error', (e) => { /* localhost may resolve to ::1 first */ net.connect({ host: '127.0.0.1', port: tcpPort }).once('connect', function onOk() { this.destroy(); resolve('PONG'); }).once('error', () => reject(e)); }); }),
  allowed_dns_localhost: () => dns.promises.lookup('localhost').then((r) => r.address),

  // ---- guard behaviour ----
  console_redaction: async () => {
    console.log('[DEV ONLY — no email provider configured] to someone@example.test | Your verification code\nYour one-time code is 482913');
    console.log('ordinary application log line');
    return 'printed';
  },
  sleep: () => new Promise((resolve) => setTimeout(() => resolve('slept'), Number(process.env.PROBE_SLEEP_MS || 3000))),
  load_worker_graph: async () => { require(path.join(BACKEND, 'src', 'synthetic-e2e-worker.js')); return 'loaded'; },
  load_api_graph: async () => { require(path.join(BACKEND, 'src', 'app.js')); return 'loaded'; },
  require_general_worker: async () => { require(path.join(BACKEND, 'src', 'worker.js')); return 'loaded'; },
  require_jobs_index: async () => { require(path.join(BACKEND, 'src', 'jobs', 'index.js')); return 'loaded'; },
  require_bitrix_job: async () => { require(path.join(BACKEND, 'src', 'jobs', 'bitrix-deal.job.js')); return 'loaded'; },
  require_scan_job: async () => { require(path.join(BACKEND, 'src', 'jobs', 'scan-request-documents.job.js')); return 'loaded'; },
  require_bitrix_deal_api: async () => { require(path.join(BACKEND, 'src', 'modules', 'bitrix', 'bitrix-deal.api.js')); return 'loaded'; },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.log(`RESULT:${JSON.stringify({ error: `unknown scenario ${name}` })}`);
  process.exit(3);
}
attempt(scenarios[name]).then((r) => {
  console.log(`RESULT:${JSON.stringify(r)}`);
  process.exit(0);
});
