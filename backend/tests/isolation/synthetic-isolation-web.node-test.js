// Web build, bundle verification and process-output tests (node:test). The real `expo export` is NOT run here (it is slow and
// belongs to the live run); the pure pieces around it are: the child environment, the argument list (never --clear), the
// bundle verification (fail closed, ask before clearing a shared cache) and the static server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..', '..');
const dir = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator');
const webBuild = require(path.join(dir, 'webBuild'));
const { redactLine } = require(path.join(dir, 'processManager'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'synth-web-'));
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test('the web export runs with EXPO_PUBLIC_API_URL=http://localhost:4400 and only system variables besides (no backend secret reaches Expo)', () => {
  const env = webBuild.buildEnv({ PATH: 'C:/x', SystemRoot: 'C:/Windows', DATABASE_URL: 'mysql://secret', JWT_ACCESS_SECRET: 'secret', BITRIX24_WEBHOOK_URL: 'https://x', EXPO_PUBLIC_API_URL: 'http://localhost:4000' });
  assert.strictEqual(env.EXPO_PUBLIC_API_URL, 'http://localhost:4400');
  assert.strictEqual(env.PATH, 'C:/x');
  for (const key of ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'BITRIX24_WEBHOOK_URL']) assert.ok(!(key in env), key);
  assert.strictEqual(webBuild.API_URL, 'http://localhost:4400');
});

test('the export command never clears the shared Metro cache and never targets the running dev server', () => {
  const args = webBuild.exportArgs('C:/runs/x/web-dist');
  assert.ok(!args.includes('--clear') && !args.includes('-c'));
  assert.deepStrictEqual(args.slice(1, 4), ['export', '--platform', 'web']);
  const code = fs.readFileSync(path.join(dir, 'webBuild.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/['"]--clear['"]/.test(code), 'webBuild.js must not pass --clear');
  assert.ok(!/expo start|8081/.test(code), 'webBuild.js must not start or use the dev server');
});

test('bundle verification passes only when the exported JS contains http://localhost:4400', () => {
  const out = tmp();
  write(out, '_expo/static/js/web/entry-abc.js', 'var API="http://localhost:4400"||"http://localhost:4000";');
  write(out, 'index.html', '<html></html>');
  const facts = webBuild.verifyBundle(out);
  assert.deepStrictEqual({ apiUrl: facts.apiUrl, matched: facts.matchedFiles.length }, { apiUrl: 'http://localhost:4400', matched: 1 });
});

test('bundle verification FAILS (stale cache) when 4400 is absent - the message says to ask before clearing any shared cache, and nothing is cleared', () => {
  const out = tmp();
  write(out, '_expo/static/js/web/entry-abc.js', 'var API="http://localhost:4000";'); // a bundle built for the NORMAL api
  assert.throws(() => webBuild.verifyBundle(out), (err) => err.code === 'bundle_api_url_missing' && /Ask the operator before clearing any shared cache/.test(err.message) && /Nothing was cleared/.test(err.message));
});

test('bundle verification fails for a missing, empty or 4100-referencing bundle', () => {
  assert.throws(() => webBuild.verifyBundle(path.join(tmp(), 'nope')), { code: 'bundle_missing' });
  assert.throws(() => webBuild.verifyBundle(tmp()), { code: 'bundle_empty' });
  const out = tmp();
  write(out, 'a.js', 'x="http://localhost:4400"; y="http://localhost:4100/pay"');
  assert.throws(() => webBuild.verifyBundle(out), { code: 'bundle_names_forbidden_port' });
});

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
const get = (port, urlPath) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] })); });
  req.on('error', reject); req.end();
});

test('the static server serves the bundle, falls back to index.html for app routes, and refuses path traversal', async () => {
  const out = tmp();
  write(out, 'index.html', '<html>app</html>');
  write(out, '_expo/static/js/web/entry.js', 'console.log(1)');
  write(path.dirname(out), 'secret.txt', 'top secret');
  const port = await freePort();
  const server = await webBuild.serveStatic(out, port);
  try {
    assert.strictEqual(server.url, `http://localhost:${port}`);
    const root = await get(port, '/');
    assert.deepStrictEqual([root.status, root.body], [200, '<html>app</html>']);
    const js = await get(port, '/_expo/static/js/web/entry.js');
    assert.deepStrictEqual([js.status, js.body, /javascript/.test(js.type)], [200, 'console.log(1)', true]);
    const spa = await get(port, '/service/privatecharter');
    assert.deepStrictEqual([spa.status, spa.body], [200, '<html>app</html>']);
    for (const evil of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fWindows']) {
      const r = await get(port, evil);
      assert.ok(r.status === 403 || (r.status === 200 && r.body === '<html>app</html>'), `${evil} -> ${r.status}`);
      assert.ok(!r.body.includes('top secret'));
    }
  } finally {
    await server.close();
  }
});

test('the static server listens on loopback only', async () => {
  const out = tmp();
  write(out, 'index.html', 'x');
  const port = await freePort();
  const server = await webBuild.serveStatic(out, port);
  try {
    const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (external) {
      const reachable = await new Promise((resolve) => { const s = net.connect({ host: external.address, port }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
      assert.strictEqual(reachable, false, 'the web server must not be reachable on a non-loopback address');
    }
  } finally {
    await server.close();
  }
});

// ---- child output must never leak OTPs, tokens or connection strings -----------------------------------------------------------------
test('child output is redacted: console email bodies, tokens, JWTs and connection strings never reach the console or the report', () => {
  assert.strictEqual(redactLine('[DEV ONLY — no email provider configured] to a@b.test | code'), '[email console output suppressed]');
  assert.ok(!/ghp|secret123/.test(redactLine('Authorization: Bearer abcdefghijklmnop1234')));
  assert.match(redactLine('Authorization: Bearer abcdefghijklmnop1234'), /Bearer \[redacted\]/);
  assert.ok(!redactLine('url mysql://user:pw@localhost:3306/humancare_dev failed').includes('pw@'));
  assert.ok(!redactLine('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk').includes('eyJhbGci'));
  assert.ok(!redactLine('otp: 482913').includes('482913'));
  assert.strictEqual(redactLine('[scan] 1 checked: 1 scanned'), '[scan] 1 checked: 1 scanned');
});

test('the orchestrator never edits mobile source: apps/mobile/.env and src are only ever read by Expo, never opened for writing here', () => {
  const code = fs.readFileSync(path.join(dir, 'webBuild.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/writeFileSync|appendFileSync|copyFileSync|renameSync|unlinkSync|rmSync/.test(code.replace(/fs\.createReadStream/g, '')), 'webBuild.js must not modify any file (it only reads the export)');
});
