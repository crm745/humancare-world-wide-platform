// RECOVERY / DIAGNOSTIC utility for the synthetic E2E approval. The normal journey does not use it: a marked request is approved
// automatically by the backend (src/modules/request-review/synthetic-approval.js) once its documents are clean.
//
//   ALLOW_SYNTHETIC_APPROVAL=true node scripts/synthetic-approve.js <requestId> --dry-run   read-only: prints the marker state, no writes
//   ALLOW_SYNTHETIC_APPROVAL=true node scripts/synthetic-approve.js <requestId>             runs ONE pass of the same engine, for example
//                                                                                          after the automatic path gave up
//
// It contains no approval logic of its own: it calls the engine, which requires a valid signed marker (made by synthetic-mark.js), the
// documents' clean scans, the claim / fence rules and the existing reviewDocument / approveRequest services. A request without a valid
// marker, a real patient request, an expired / revoked / consumed marker, or a missing SYNTHETIC_E2E_SECRET is refused. The engine also
// confirms humancare_dev (the URL and the server's DATABASE()) and refuses in production. Output: the request id and a short outcome code
// only; never patient details, file names or secrets.
const path = require('path');
const { databaseOfUrl, LIMITS } = require('../src/common/safety/synthetic-e2e-marker');

const OPT_IN = 'ALLOW_SYNTHETIC_APPROVAL';
const refuse = (code) => ({ ok: false, exitCode: 2, code });

function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg && arg.startsWith('--')) return { error: 'unknown_option' };
    else positional.push(arg);
  }
  if (positional.length !== 1 || !/^[1-9]\d{0,9}$/.test(String(positional[0]))) return { error: 'request_id_required' };
  return { requestId: Number(positional[0]), dryRun };
}

async function run({ argv, env, engine }) {
  if (env[OPT_IN] !== 'true') return refuse('opt_in_missing');
  if (env.NODE_ENV === 'production') return refuse('production_refused');
  const parsed = parseArgs(argv);
  if (parsed.error) return refuse(parsed.error);
  if (databaseOfUrl(env.DATABASE_URL) !== LIMITS.DATABASE) return refuse('database_not_identified');
  const { requestId, dryRun } = parsed;

  if (dryRun) {
    const info = await engine.diagnose(requestId, { mode: 'recovery' });
    const ok = info.outcome === 'active';
    return { ok, exitCode: ok ? 0 : 2, requestId, outcome: 'dry_run', code: info.outcome, detail: info };
  }
  const result = await engine.processRequest(requestId, { mode: 'recovery' });
  const done = result.outcome === 'approved' || result.outcome === 'already_approved' || result.outcome === 'consumed';
  if (done) return { ok: true, exitCode: 0, requestId, outcome: result.outcome };
  return { ok: false, exitCode: result.entered ? 1 : 2, code: result.outcome, ...(result.code && { stage: result.code }) };
}

function describe(result, requestId) {
  if (result.ok && result.outcome === 'dry_run') {
    const d = result.detail;
    return `synthetic request ${result.requestId}: marker active, status ${d.requestStatus}, failures ${d.failures}, claim ${d.claimLive ? 'live' : 'none'}, documents expected ${d.expectedDocuments}, ${d.ready ? 'ready' : `not ready (${d.code})`}`;
  }
  if (result.ok) return `synthetic request ${result.requestId}: ${result.outcome}`;
  return `synthetic approval not done${requestId ? ` for request ${requestId}` : ''}: ${result.code}${result.stage ? ` (${result.stage})` : ''}`;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const parsed = parseArgs(process.argv.slice(2));
  let prisma = null;
  let result;
  try {
    let engine = null;
    if (process.env[OPT_IN] === 'true' && !parsed.error && databaseOfUrl(process.env.DATABASE_URL) === LIMITS.DATABASE) {
      ({ prisma } = require('../src/db/prisma'));
      engine = require('../src/modules/request-review/synthetic-approval').createEngine();
    }
    result = await run({ argv: process.argv.slice(2), env: process.env, engine });
  } catch {
    result = { ok: false, exitCode: 1, code: 'unexpected_error' };
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => undefined);
  }
  console.log(describe(result, parsed.requestId));
  process.exit(result.exitCode);
}

if (require.main === module) main();

module.exports = { run, parseArgs, describe, OPT_IN };
