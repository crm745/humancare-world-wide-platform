// Node `--require` preload for the processes the synthetic E2E orchestrator spawns (the isolated API and the dedicated
// worker). Node executes it completely - synchronously - before it loads the entry file, so the egress guard is in place
// before any application code (and so before any Bitrix, Firebase, SMTP, S3 or HTTP client) is even required.
//
// Fail closed: if the policy cannot be read, the role is missing, or a hook does not take effect, the process exits
// immediately and the entry file is never loaded. The self-test runs right after installation; a failing self-test also
// terminates the process.
//
// Configuration arrives only through the (sanitized) environment built by childEnv.js:
//   HC_EGRESS_ROLE      "api" | "worker"
//   HC_EGRESS_EVIDENCE  the run's evidence file
//   HC_EGRESS_BLOCK_HOSTS / HC_EGRESS_BLOCK_IPS   the policy (see egressPolicy.js)
const { policyFromEnv } = require('./egressPolicy');
const { install } = require('./egressGuard');
const { ENV_EVIDENCE } = require('./egressEvidence');

const role = process.env.HC_EGRESS_ROLE;
try {
  if (role !== 'api' && role !== 'worker') throw new Error('HC_EGRESS_ROLE must be "api" or "worker"');
  const guard = install({ role, policy: policyFromEnv(process.env), evidenceFile: process.env[ENV_EVIDENCE] || null });
  guard.selfTestPromise.then((result) => {
    if (result && !result.ok) {
      console.error('[egressGuard] self-test failed; terminating this process.');
      process.exit(1);
    }
  });
} catch (err) {
  console.error(`[egressGuard] the egress guard could not be established (${err.message}); this process will not start.`);
  process.exit(1);
}
console.error(`[egressGuard] outbound egress policy active (role: ${role}).`);
