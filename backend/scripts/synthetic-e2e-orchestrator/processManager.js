// Starts, watches and stops the two processes the orchestrator OWNS for a run: the isolated API (port 4400) and the
// dedicated synthetic worker. Both are started as `node --require egressGuard.preload.js <entry>` with a complete,
// sanitized environment (childEnv.js). The orchestrator never attaches to, stops or modifies a process it did not start:
// its crash recovery only terminates a pid that its own pid file records AND whose command line still contains this
// run-owned preload and entry file.
//
// Child output is passed through a redactor: console-provider email lines, anything that looks like a token, and
// connection strings never reach the orchestrator's console or the report; only a short tail is kept for diagnostics.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { API_ENTRY, WORKER_ENTRY, PRELOAD, API_PORT, WEB_PORT, FORBIDDEN_PORTS } = require('./childEnv');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const TAIL_LINES = 40;
const READY = { api: /HumanCare backend listening on http:\/\/localhost:4400/, worker: /Started jobs/ };
// Readiness-only worker (gate-only mode): ready means "database identity confirmed, nothing scheduled" - never "Started jobs".
const READY_READINESS_ONLY_WORKER = /Readiness only: configuration and database identity \(humancare_dev\) confirmed/;
const READINESS_ONLY_FLAG = '--readiness-only';

// ---- output redaction ---------------------------------------------------------------------------------------------
function redactLine(line) {
  let out = String(line);
  if (/^\s*\[DEV ONLY/i.test(out)) return '[email console output suppressed]';
  out = out.replace(/\b(mysql|postgres|postgresql|mongodb):\/\/\S+/gi, '$1://[redacted]');
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[jwt redacted]');
  out = out.replace(/\b(password|secret|token|otp|code)(["']?\s*[:=]\s*["']?)[^\s"',;]{3,}/gi, '$1$2[redacted]');
  return out;
}

// ---- port availability ------------------------------------------------------------------------------------------------
// Free = nothing is listening on the port on any of the interfaces the services would bind. A port in FORBIDDEN_PORTS is
// refused outright, whatever its state (they belong to services this tool must never touch or imitate).
function checkPortFree(port) {
  if (FORBIDDEN_PORTS.includes(port)) return Promise.resolve({ port, free: false, reason: 'forbidden_port' });
  const tryBind = (host) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ ok: false, code: err.code }));
    server.listen({ port, host }, () => server.close(() => resolve({ ok: true })));
  });
  return (async () => {
    for (const host of ['::', '0.0.0.0', '127.0.0.1']) {
      const result = await tryBind(host);
      if (result.ok) {
        // Also confirm the loopback address on both families, which a service bound only to it would still hold.
        for (const loop of ['127.0.0.1', '::1']) {
          const r = await tryBind(loop);
          if (!r.ok && r.code === 'EADDRINUSE') return { port, free: false, reason: 'in_use' };
        }
        return { port, free: true };
      }
      if (result.code === 'EADDRINUSE' || result.code === 'EACCES') return { port, free: false, reason: result.code === 'EACCES' ? 'not_permitted' : 'in_use' };
      // EAFNOSUPPORT / EADDRNOTAVAIL: this family is unavailable on the machine; try the next one
    }
    return { port, free: false, reason: 'cannot_verify' };
  })();
}

async function assertPortsFree(ports = [API_PORT, WEB_PORT]) {
  const results = [];
  for (const port of ports) results.push(await checkPortFree(port));
  const taken = results.filter((r) => !r.free);
  if (taken.length) {
    const err = new Error(`required port(s) not available: ${taken.map((t) => `${t.port} (${t.reason})`).join(', ')}. Nothing was started and nothing was stopped.`);
    err.code = 'port_unavailable';
    err.results = results;
    throw err;
  }
  return results;
}

// ---- children ----------------------------------------------------------------------------------------------------------
// The exact argument list of a spawned process (pure, so it can be tested): the egress guard first, then the entry file.
function buildSpawnArgs({ entry, extraArgs = [] }) {
  return ['--require', PRELOAD, entry, ...extraArgs];
}

function startChild({ role, entry, env, log = console, extraArgs = [], readyPattern = READY[role] }) {
  const child = spawn(process.execPath, buildSpawnArgs({ entry, extraArgs }), {
    cwd: BACKEND_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let ready = false;
  const tail = [];
  const onLine = (stream) => (chunk) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line = redactLine(raw);
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      if (readyPattern.test(raw)) ready = true;
      (stream === 'err' ? log.error : log.log).call(log, `[${role}] ${line}`);
    }
  };
  child.stdout.on('data', onLine('out'));
  child.stderr.on('data', onLine('err'));
  return {
    role,
    child,
    pid: child.pid,
    isReady: () => ready,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    tail: () => [...tail],
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 8000);
      child.once('exit', () => { clearTimeout(force); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(force); resolve(); }
      return undefined;
    }),
  };
}

const startApi = ({ env, log }) => startChild({ role: 'api', entry: API_ENTRY, env, log });
// readinessOnly: the worker confirms its database identity and then stays idle; it never schedules or runs a job.
const startWorker = ({ env, log, readinessOnly = false }) => startChild({
  role: 'worker', entry: WORKER_ENTRY, env, log,
  extraArgs: readinessOnly ? [READINESS_ONLY_FLAG] : [],
  readyPattern: readinessOnly ? READY_READINESS_ONLY_WORKER : READY.worker,
});

async function waitFor(predicate, { timeoutMs, intervalMs = 500, label }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- pid file + orphan recovery ---------------------------------------------------------------------------------------
function writePidFile(runDir, pids) {
  fs.writeFileSync(path.join(runDir, 'pids.json'), JSON.stringify({ ...pids, preload: path.basename(PRELOAD), writtenAt: new Date().toISOString() }, null, 2));
}

// Terminates ONLY processes this tool started in an earlier (crashed/interrupted) run: pid recorded in that run's
// pids.json, still alive, and its command line still contains the run-owned preload and one of the two entry files.
// Anything else is reported and left alone. `listNodeProcesses` throws on an untrustworthy enumeration -> nothing is killed.
function recoverOrphans(runsDir, currentRunId, { listNodeProcesses, kill = (pid) => process.kill(pid) } = {}) {
  const terminated = [];
  const skipped = [];
  let runDirs = [];
  try {
    runDirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== currentRunId).map((d) => d.name);
  } catch {
    return { terminated, skipped };
  }
  let processes = null;
  for (const runId of runDirs) {
    const file = path.join(runsDir, runId, 'pids.json');
    if (!fs.existsSync(file)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { skipped.push({ runId, reason: 'unreadable pid file' }); continue; }
    if (data.recovered) continue;
    if (!processes) processes = listNodeProcesses();
    for (const role of ['api', 'worker']) {
      const pid = Number(data[role]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const match = processes.find((p) => p.pid === pid);
      if (!match) continue; // already gone
      const owned = match.commandLine.includes('egressGuard.preload.js') && /synthetic-e2e-(api|worker)\.js/.test(match.commandLine);
      if (!owned) { skipped.push({ runId, role, pid, reason: 'pid now belongs to a process this tool did not start' }); continue; }
      try { kill(pid); terminated.push({ runId, role, pid }); } catch (err) { skipped.push({ runId, role, pid, reason: err.message }); }
    }
    try { fs.writeFileSync(file, JSON.stringify({ ...data, recovered: true }, null, 2)); } catch { /* best effort */ }
  }
  return { terminated, skipped };
}

module.exports = {
  redactLine, checkPortFree, assertPortsFree, startApi, startWorker, startChild, buildSpawnArgs, waitFor, writePidFile, recoverOrphans, READY, READY_READINESS_ONLY_WORKER, READINESS_ONLY_FLAG,
};
