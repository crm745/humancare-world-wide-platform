// The orchestrator installs the same guard in ITS OWN process (role "orchestrator": child processes and threads allowed
// because it must launch the browser and the Expo export, everything else identical). This checks, in a throwaway child
// process, that installing it breaks none of the orchestrator's own dependencies (Prisma's native engine, Playwright, the
// child_process it needs) while Bitrix destinations stay blocked. No database connection is made (dummy loopback URL on a
// closed port, no query), no browser is launched, no network is used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const dir = path.join(BACKEND, 'scripts', 'synthetic-e2e-orchestrator');
const evidenceLib = require(path.join(dir, 'egressEvidence'));

test('orchestrator role: guard installs, self-test passes, Prisma + Playwright + child_process keep working, Bitrix stays blocked', async () => {
  const evidenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synth-orch-role-')), 'e.jsonl');
  const script = `
    const path = require('path');
    const { createPolicy } = require(${JSON.stringify(path.join(dir, 'egressPolicy'))});
    const guard = require(${JSON.stringify(path.join(dir, 'egressGuard'))}).install({
      role: 'orchestrator', policy: createPolicy({ blockedHosts: ['mock-bitrix.test'] }), evidenceFile: ${JSON.stringify(evidenceFile)},
      allowChildProcess: true, allowWorkerThreads: true,
    });
    (async () => {
      const out = {};
      out.selfTest = (await guard.selfTestPromise).ok;
      out.child = require('child_process').execFileSync(process.execPath, ['-e', 'process.stdout.write("child-ok")']).toString();
      out.playwright = typeof require('playwright').chromium.launch;
      const { prisma } = require(${JSON.stringify(path.join(BACKEND, 'src', 'db', 'prisma'))});
      await new Promise((r) => setTimeout(r, 800)); // let Prisma's library engine load
      out.prisma = typeof prisma.$queryRaw;
      try { await fetch('http://mock-bitrix.test/'); out.bitrix = 'reached'; } catch (e) { out.bitrix = (e.cause && e.cause.code) || e.code; }
      console.log('RESULT:' + JSON.stringify(out));
      process.exit(0);
    })().catch((e) => { console.log('RESULT:' + JSON.stringify({ error: String(e && e.stack).slice(0, 500) })); process.exit(1); });
  `;
  const env = { DATABASE_URL: 'mysql://nobody:nothing@127.0.0.1:1/humancare_dev' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const stdout = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; child.stdout.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.once('exit', () => { clearTimeout(timer); resolve(out); });
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `no result line: ${stdout.slice(0, 300)}`);
  const result = JSON.parse(line.slice(7));
  assert.deepStrictEqual(result, { selfTest: true, child: 'child-ok', playwright: 'function', prisma: 'function', bitrix: 'EGRESS_BLOCKED' });
  const s = evidenceLib.summarize(evidenceLib.readAll(evidenceFile), ['orchestrator']);
  assert.strictEqual(s.byRole.orchestrator.installed, true);
  assert.deepStrictEqual(s.violations.filter((v) => v.kind !== 'blocked_fetch'), [], 'only the deliberate Bitrix fetch may be recorded');
});
