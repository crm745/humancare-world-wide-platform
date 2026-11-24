// Establishes (and later releases) the whole isolation environment of one run, in this order, aborting - and releasing
// whatever was already started - at the first failure:
//   1. ports 4400 (isolated API) and 8481 (isolated web) are free (4000 and 4100 are refused outright);
//   2. the complete sanitized environments of the API and the worker are built from backend/.env (read-only, in memory)
//      and re-validated;
//   3. the isolated web bundle is exported (EXPO_PUBLIC_API_URL=http://localhost:4400 in that child only) and VERIFIED to
//      contain that URL - no `--clear`, nothing shared is modified;
//   4. the browser filtering proxy and the static web server start;
//   5. the dedicated worker and the isolated API start under the egress guard, and each must report its guard installed,
//      its self-test passed, and (API) its database identity confirmed before it listens;
//   6. the isolation gate (isolationSelfTest.js) passes.
// Nothing here creates a firewall rule, touches the normal dev API or Expo server, or opens a database connection of its
// own (the API and worker check their own).
const fs = require('fs');
const path = require('path');
const { LIMITS, databaseOfUrl } = require('../../src/common/safety/synthetic-e2e-marker');
const childEnv = require('./childEnv');
const processManager = require('./processManager');
const webBuild = require('./webBuild');
const { createEgressProxy } = require('./egressProxy');
const evidence = require('./egressEvidence');
const { assertGate, checkStillIsolated, IsolationError } = require('./isolationSelfTest');

// Options:
//   gateOnly       the dedicated worker is started in READINESS-ONLY mode (it confirms its database identity and stays idle; it
//                  schedules and runs no job). The API is started identically in both modes.
//   reuseWebBuild  a directory holding an already-exported, already-verified bundle: it is verified again and only read; no
//                  export is run and no cache is touched.
//   stopRegistry   an object whose stopAll is set at once, so the caller can release a half-started isolation on interruption.
//   deps           test seams (fake process starters / bundle preparer / probes); production code never passes them.
async function establishIsolation({
  runDir, envFileValues, policy, orchestratorGuard, log = console, apiPort = childEnv.API_PORT, webPort = childEnv.WEB_PORT,
  gateOnly = false, reuseWebBuild = null, deps = {}, stopRegistry = null,
}) {
  const d = {
    startApi: processManager.startApi, startWorker: processManager.startWorker, prepareBundle: webBuild.prepareBundle, probes: undefined, ...deps,
  };
  const stops = [];
  let released = false;
  const stopAll = async () => {
    if (released) return;
    released = true;
    for (const stop of stops.reverse()) { try { await stop(); } catch { /* keep releasing the rest */ } }
  };
  const say = (m) => log.log(`[isolation] ${m}`);
  // Published immediately, so an interrupt (Ctrl+C / SIGTERM) DURING start-up - before this function has returned a handle - can
  // still stop everything that has been started so far.
  if (stopRegistry) stopRegistry.stopAll = stopAll;

  try {
    say(`checking ports ${apiPort} and ${webPort}`);
    await processManager.assertPortsFree([apiPort, webPort]);

    const evidenceFile = path.join(runDir, 'egress-evidence.jsonl');
    fs.writeFileSync(evidenceFile, '');
    const mk = (role) => childEnv.buildChildEnv({ role, envFileValues, policy, evidenceFile, databaseOfUrl, requiredDatabase: LIMITS.DATABASE });
    const apiEnv = mk('api');
    const workerEnv = mk('worker');
    for (const [role, env] of [['api', apiEnv], ['worker', workerEnv]]) {
      const problems = childEnv.childEnvProblems(env, role);
      if (problems.length) throw new IsolationError(`the ${role} environment is not safe: ${problems.join(', ')}`);
    }

    say(reuseWebBuild
      ? 'reusing the existing web export (verify only: no export, no cache is touched)'
      : 'exporting the isolated web bundle (EXPO_PUBLIC_API_URL set for that child process only; no cache clearing)');
    const { outDir, bundle } = await d.prepareBundle({ runDir, reuseDir: reuseWebBuild, log });
    say(`web bundle verified: contains ${bundle.apiUrl} (${bundle.matchedFiles.length} file(s))${bundle.reused ? ' [reused]' : ''}`);

    const proxy = createEgressProxy({ policy, evidenceFile });
    const { port: proxyPort } = await proxy.listen();
    stops.push(() => proxy.close());
    const web = await webBuild.serveStatic(outDir, webPort);
    stops.push(() => web.close());

    const children = {};
    say(gateOnly
      ? 'starting the dedicated worker (READINESS-ONLY: no job is scheduled) and the isolated API under the egress guard'
      : 'starting the dedicated worker and the isolated API under the egress guard');
    children.worker = d.startWorker({ env: workerEnv, log, readinessOnly: gateOnly });
    stops.push(() => children.worker.stop());
    children.api = d.startApi({ env: apiEnv, log });
    stops.push(() => children.api.stop());
    processManager.writePidFile(runDir, { api: children.api.pid, worker: children.worker.pid });

    await processManager.waitFor(() => {
      for (const role of ['api', 'worker']) if (children[role].hasExited()) throw new IsolationError(`the isolated ${role} exited during start-up: ${children[role].tail().slice(-6).join(' | ')}`);
      return children.api.isReady() && children.worker.isReady();
    }, { timeoutMs: 90000, label: 'the isolated API and worker to report ready' });
    await processManager.waitFor(() => {
      const s = evidence.summarize(evidence.readAll(evidenceFile), ['api', 'worker']).byRole;
      return s.api.installed && s.api.selftest && s.api.identity === true && s.worker.installed && s.worker.selftest;
    }, { timeoutMs: 30000, label: 'the guards\' installation, self-test and database-identity evidence' });

    const orchestratorResult = orchestratorGuard ? await orchestratorGuard.selfTestPromise : { ok: false };
    const apiUrl = `http://localhost:${apiPort}`;
    const gate = await assertGate({
      evidenceFile, children, proxy, proxyPort, bundle, web: { url: `http://127.0.0.1:${webPort}` },
      orchestratorGuard: orchestratorResult,
      local: { databaseUrl: envFileValues.DATABASE_URL, clamav: { host: envFileValues.CLAMAV_HOST || '127.0.0.1', port: Number(envFileValues.CLAMAV_PORT || 3310) }, apiUrl: `${apiUrl}/health` },
      probes: d.probes,
    });
    say(`isolation gate passed (${gate.checks.length} checks)`);

    const isolationCheck = () => checkStillIsolated({ evidenceFile, children, proxy });
    return {
      evidenceFile,
      children,
      proxy,
      web: { url: `http://localhost:${webPort}` },
      egress: { proxyUrl: `http://127.0.0.1:${proxyPort}`, policy, proxy, blockedHosts: policy.snapshot().blockedHosts },
      isolationCheck,
      summary: () => ({
        mode: gateOnly ? 'gate-only' : 'full',
        workerMode: gateOnly ? 'readiness-only (no job scheduled or run)' : 'scan + synthetic approval job',
        apiPort, webPort, proxyPort,
        forbiddenPortsNeverUsed: childEnv.FORBIDDEN_PORTS,
        bundle,
        gate: gate.checks,
        guards: evidence.summarize(evidence.readAll(evidenceFile), ['api', 'worker']).byRole,
        violations: evidence.summarize(evidence.readAll(evidenceFile), ['api', 'worker']).violations,
        proxy: proxy.stats(),
        policy: policy.describe(),
        bitrixSyncForcedFalseInSpawnedProcesses: true,
        bitrixCredentialsBlankInSpawnedProcesses: true,
        smtpBlankInSpawnedProcesses: true,
        windowsFirewallRulesCreated: 0,
      }),
      stopAll,
    };
  } catch (err) {
    await stopAll();
    throw err;
  }
}

module.exports = { establishIsolation };
