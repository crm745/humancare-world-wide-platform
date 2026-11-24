// The isolated web build of apps/mobile for the browser journey.
//
// EXPO_PUBLIC_API_URL is inlined by Metro/Babel when the bundle is BUILT; the browser never reads it at runtime. A running
// `expo start --web` (normally on 8081, built for the normal API on 4000) therefore cannot be pointed at the isolated API,
// and must never be used by this tool. Instead the orchestrator exports its own static build with
//     EXPO_PUBLIC_API_URL=http://localhost:4400
// set in that ONE child process's environment, verifies the bundle really contains that URL, and serves it on port 8481.
//
// What this module never does: edit apps/mobile/.env or any mobile source file, touch the running dev server, or pass
// `--clear` (Metro's transform cache is shared with the normal dev server; if the cache served a stale bundle, the
// verification below fails and the run STOPS so the operator can decide whether to clear it).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { SYSTEM_KEYS, API_PORT, WEB_PORT } = require('./childEnv');

const MOBILE_ROOT = path.resolve(__dirname, '..', '..', '..', 'apps', 'mobile');
const EXPO_CLI = path.join(MOBILE_ROOT, 'node_modules', 'expo', 'bin', 'cli');
const API_URL = `http://localhost:${API_PORT}`;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

class WebBuildError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'WebBuildError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// Only system variables plus the three settings below: no backend secret ever reaches the Expo process. Expo reads the
// public EXPO_PUBLIC_FIREBASE_* values from apps/mobile/.env itself (read-only), and a variable set here takes precedence.
function buildEnv(systemEnv = process.env, apiUrl = API_URL) {
  const env = {};
  for (const key of SYSTEM_KEYS) if (systemEnv[key] !== undefined) env[key] = systemEnv[key];
  Object.assign(env, { EXPO_PUBLIC_API_URL: apiUrl, EXPO_NO_TELEMETRY: '1', CI: '1' });
  return env;
}

function exportArgs(outDir) {
  return [EXPO_CLI, 'export', '--platform', 'web', '--output-dir', outDir];
}

function runExport({ outDir, log = console, timeoutMs = BUILD_TIMEOUT_MS, env = buildEnv() }) {
  if (!fs.existsSync(EXPO_CLI)) return Promise.reject(new WebBuildError('the Expo CLI is not installed in apps/mobile (npm install there first)', 'expo_missing'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, exportArgs(outDir), { cwd: MOBILE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const tail = [];
    const keep = (chunk) => { for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) { tail.push(l.slice(0, 300)); if (tail.length > 30) tail.shift(); } };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); reject(new WebBuildError(`expo export timed out after ${timeoutMs / 1000}s`, 'export_timeout', tail)); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(new WebBuildError(`could not start expo export: ${err.message}`, 'export_spawn_failed')); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) { log.log('[web-build] expo export finished'); resolve(); } else reject(new WebBuildError(`expo export failed (exit ${code})`, 'export_failed', tail));
    });
  });
}

function listFiles(dir, extension) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(extension)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// The bundle must CONTAIN the isolated API URL (the "|| 'http://localhost:4000'" fallback literal is always present in the
// source, so absence of :4000 proves nothing; presence of :4400 is the proof). It must also not name port 4100.
// Returns facts; throws WebBuildError with an explicit "ask before clearing the cache" message when the URL is missing.
function verifyBundle(outDir, apiUrl = API_URL) {
  if (!fs.existsSync(outDir)) throw new WebBuildError('the web export directory does not exist', 'bundle_missing');
  const files = listFiles(outDir, '.js');
  if (!files.length) throw new WebBuildError('the web export contains no JavaScript bundle', 'bundle_empty');
  const matched = [];
  let namesForbiddenPort = false;
  // EXACT URL: "http://localhost:4400" must not be followed by another digit (so ":44001" does not count).
  const exactUrl = new RegExp(`${apiUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (exactUrl.test(text)) matched.push(path.relative(outDir, file));
    if (/localhost:4100\b/.test(text)) namesForbiddenPort = true;
  }
  if (!matched.length) {
    throw new WebBuildError(
      `the exported web bundle does not contain ${apiUrl}. The Metro transform cache (shared with your normal dev server) may have served a bundle built for another API URL. `
      + 'Nothing was cleared and nothing was started. Ask the operator before clearing any shared cache (for example `expo export --clear`).',
      'bundle_api_url_missing',
    );
  }
  if (namesForbiddenPort) throw new WebBuildError('the exported web bundle references port 4100 (the payment E2E runner)', 'bundle_names_forbidden_port');
  // A servable export has its HTML shell next to the bundle; without it the browser would have nothing to open.
  if (!fs.existsSync(path.join(outDir, 'index.html'))) throw new WebBuildError('the web export has no index.html', 'bundle_files_missing');
  const builtAt = new Date(Math.max(...matched.map((m) => fs.statSync(path.join(outDir, m)).mtimeMs))).toISOString();
  return { apiUrl, filesScanned: files.length, matchedFiles: matched, builtAt };
}

// ---- reusing an already-exported bundle (--reuse-web-build <dir>) -------------------------------------------------------
// The directory is only READ (verified, then served). Nothing is rebuilt, no Metro cache is touched, no file in it or in the
// mobile app is modified. It must be an existing directory OUTSIDE the mobile app and the backend sources, and it must pass the
// same verifyBundle as a fresh export (exactly http://localhost:4400, a JS bundle, index.html, no port 4100).
// Disclosed: reuse proves the export targets the isolated API, not that it was built from the current mobile source; the
// report records when the entry bundle was built.
function assertReusableDirectory(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new WebBuildError('--reuse-web-build needs a directory', 'reuse_dir_missing');
  if (dir.includes('%')) throw new WebBuildError('the directory contains an unexpanded %VARIABLE% (use the full path, or $env:TEMP in PowerShell)', 'reuse_dir_unexpanded');
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new WebBuildError('the web export directory does not exist', 'bundle_missing');
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isDirectory()) throw new WebBuildError('the web export path is not a directory', 'reuse_dir_not_directory');
  const inside = (root) => { const r = path.relative(root, real); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const backendSrc = path.resolve(__dirname, '..', '..', 'src');
  if (inside(MOBILE_ROOT) || inside(backendSrc)) throw new WebBuildError('the web export directory must not be inside the mobile app or the backend sources', 'reuse_dir_in_source');
  return real;
}

// Produces the verified bundle directory for a run: reuses `reuseDir` when given (verify only), otherwise exports a fresh one.
async function prepareBundle({ runDir, reuseDir = null, log = console, exporter = runExport }) {
  if (reuseDir !== null && reuseDir !== undefined) { // an empty string is an ERROR (reuse_dir_missing), never a silent rebuild
    const outDir = assertReusableDirectory(reuseDir);
    return { outDir, bundle: { ...verifyBundle(outDir), reused: true, dir: outDir } };
  }
  const outDir = path.join(runDir, 'web-dist');
  await exporter({ outDir, log });
  return { outDir, bundle: { ...verifyBundle(outDir), reused: false } };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm' };

// Static file server with single-page-app fallback, bound to loopback only (IPv4 and, where available, IPv6, because the
// browser resolves "localhost" to either). Path traversal is refused. Returns { close }.
async function serveStatic(dir, port = WEB_PORT) {
  const root = path.resolve(dir);
  const handler = (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); res.end(); return; }
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const asIndex = path.join(file, 'index.html');
      file = fs.existsSync(asIndex) && fs.statSync(file).isDirectory() ? asIndex : path.join(root, 'index.html'); // SPA fallback
    }
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  };
  const servers = [];
  const listen = (host) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen({ port, host }, () => { servers.push(server); resolve(); });
  });
  await listen('127.0.0.1');
  try { await listen('::1'); } catch { /* IPv6 loopback unavailable: IPv4 alone is enough */ }
  return {
    url: `http://localhost:${port}`,
    close: () => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(() => resolve()); }))),
  };
}

module.exports = { WebBuildError, MOBILE_ROOT, EXPO_CLI, API_URL, buildEnv, exportArgs, runExport, verifyBundle, assertReusableDirectory, prepareBundle, serveStatic };
