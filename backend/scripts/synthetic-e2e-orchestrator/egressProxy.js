// Local filtering proxy for the Playwright browser. Chromium is launched with --proxy-server pointing here, so every
// request the browser makes to a NON-loopback destination (the page, its scripts, Firebase, a redirect target, a
// WebSocket upgrade, anything a service worker or the page itself dreams up) arrives as an HTTP request or a CONNECT
// tunnel and is checked against the egress policy:
//   * by NAME (the Bitrix portal host and any Bitrix24-looking name), and
//   * by every ADDRESS the name resolves to, which is then the address connected to ("pinned"), so a name that resolves
//     to a blocked address - or a DNS answer that changes between the check and the connection - cannot slip past.
// A denied request gets 403 and is recorded; a denial of anything other than the self-test canary is a violation the
// orchestrator turns into a failed run. The proxy never follows redirects (the browser does, and every hop comes back
// through here), and it only listens on 127.0.0.1 on an ephemeral port.
const http = require('http');
const net = require('net');
const dns = require('dns');
const { CANARY_HOST, normalizeHost } = require('./egressPolicy');
const evidence = require('./egressEvidence');

const IDLE_MS = 60 * 1000;
const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

function createEgressProxy({ policy, evidenceFile = null, lookup = (host) => dns.promises.lookup(host, { all: true }) }) {
  const denied = [];
  const allowedHosts = new Set();
  let server = null;

  const record = (kind, host, reason) => evidence.record(evidenceFile, { role: 'browser-proxy', kind, destination: String(host).slice(0, 200), reason });

  function deny(host, reason) {
    const isCanary = normalizeHost(host) === CANARY_HOST;
    denied.push({ host: String(host).slice(0, 200), reason, canary: isCanary });
    record(isCanary ? 'proxy_selftest_denied' : 'proxy_denied', host, reason);
  }

  // Resolves and vets a destination. Returns { address } to connect to, or { denied: reason }.
  async function vet(host) {
    const byName = policy.check(host);
    if (byName.blocked) return { denied: byName.reason };
    if (net.isIP(normalizeHost(host))) return { address: normalizeHost(host) };
    let results;
    try {
      results = await lookup(host);
    } catch {
      return { denied: 'unresolvable' };
    }
    const addresses = (Array.isArray(results) ? results : [results]).map((r) => r.address);
    if (!addresses.length) return { denied: 'unresolvable' };
    const bad = addresses.find((a) => policy.checkIp(a).blocked);
    if (bad) return { denied: 'resolved_to_blocked_ip' };
    return { address: addresses[0] };
  }

  const forbidden = (res, host, reason) => {
    deny(host, reason);
    res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('Blocked by the HumanCare synthetic E2E egress policy');
  };

  function onRequest(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400); res.end(); return;
    }
    if (target.protocol !== 'http:') { res.writeHead(400); res.end(); return; }
    vet(target.hostname).then((verdict) => {
      if (verdict.denied) return forbidden(res, target.hostname, verdict.denied);
      allowedHosts.add(target.hostname);
      const headers = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      const upstream = http.request({
        host: verdict.address, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers,
      }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
      req.pipe(upstream);
      return undefined;
    }).catch(() => { try { res.writeHead(502); res.end(); } catch { /* socket gone */ } });
  }

  function onConnect(req, clientSocket, head) {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '');
    const reject = (code, text) => { try { clientSocket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ } };
    if (!match) return reject(400, 'Bad Request');
    const host = match[1];
    const port = Number(match[2]);
    clientSocket.on('error', () => {});
    vet(host).then((verdict) => {
      if (verdict.denied) { deny(host, verdict.denied); return reject(403, 'Forbidden'); }
      allowedHosts.add(normalizeHost(host));
      const upstream = net.connect({ host: verdict.address, port });
      upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      upstream.on('error', () => reject(502, 'Bad Gateway'));
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      clientSocket.on('close', () => upstream.destroy());
      return undefined;
    }).catch(() => reject(502, 'Bad Gateway'));
    return undefined;
  }

  return {
    listen: () => new Promise((resolve, reject) => {
      server = http.createServer(onRequest);
      server.on('connect', onConnect);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port }));
    }),
    close: () => new Promise((resolve) => {
      if (!server) return resolve();
      server.closeAllConnections();
      server.close(() => resolve());
      return undefined;
    }),
    // Denied destinations other than the self-test canary: a browser that asked for these tried to reach Bitrix.
    violations: () => denied.filter((d) => !d.canary),
    stats: () => ({ allowedHostCount: allowedHosts.size, allowedHosts: [...allowedHosts], denied: denied.map((d) => ({ host: d.host, reason: d.reason, canary: d.canary })) }),
  };
}

module.exports = { createEgressProxy };
