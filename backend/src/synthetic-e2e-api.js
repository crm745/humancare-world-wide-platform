// Entry point for the ISOLATED API used by the synthetic E2E orchestrator (scripts/synthetic-e2e-orchestrator/).
//
// It is NOT the normal API entry (src/server.js is untouched and still what `npm start` / `npm run dev` run). It only
// ever starts under the orchestrator, which gives it a sanitized environment and `--require`s the egress guard first.
// Before anything listens it refuses to continue unless EVERY one of these holds (fail closed, any error = refuse):
//   * the egress guard is really installed in this process (checked on the live socket hook, not just an env flag);
//   * Bitrix is off and every Bitrix credential/webhook/token is empty; SMTP and payment credentials are empty;
//   * the port is the isolated one (4400), never 4000 (normal dev API) or 4100 (payment E2E runner);
//   * DATABASE_URL names humancare_dev on a loopback host, and the API's OWN Prisma connection answers
//     SELECT DATABASE() with exactly "humancare_dev". The check runs before `./server` is required, so before app.listen.
// Only then does it hand over to the unmodified src/server.js. It starts no job runner and never requires src/worker.js or
// src/jobs (the guard's module tripwire enforces that too).
//
//   node --require scripts/synthetic-e2e-orchestrator/egressGuard.preload.js src/synthetic-e2e-api.js   (orchestrator only)
const fs = require('fs');
const net = require('net');
const { LIMITS, databaseOfUrl } = require('./common/safety/synthetic-e2e-marker');

const ISOLATED_API_PORT = 4400;
const FORBIDDEN_PORTS = [4000, 4100];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const BLANK_REQUIRED = ['BITRIX24_WEBHOOK_URL', 'BITRIX_INBOUND_APPLICATION_TOKEN', 'BITRIX_ALLOWED_PORTAL_HOST', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

function egressGuardInstalled() {
  return net.Socket.prototype.connect.name === 'guardedConnect';
}

function databaseHost(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

// Every configuration problem that can be decided WITHOUT touching the database. Pure; codes only (never a value).
function apiConfigurationProblems(env = process.env) {
  const problems = [];
  if (!egressGuardInstalled()) problems.push('egress_guard_not_installed');
  if (env.HC_EGRESS_ROLE !== 'api') problems.push('egress_role_not_api');
  if (env.NODE_ENV === 'production') problems.push('production_refused');
  if (env.NODE_ENV === 'test') problems.push('test_environment_refused');
  const port = Number(env.PORT);
  if (port !== ISOLATED_API_PORT || FORBIDDEN_PORTS.includes(port)) problems.push('port_not_isolated_4400');
  if (env.BITRIX_SYNC_ENABLED !== 'false') problems.push('bitrix_sync_not_false');
  if (!['false', ''].includes(env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED || '')) problems.push('bitrix_deal_switch_not_off');
  if (!['false', ''].includes(env.BITRIX_QUOTATION_SYNC_ENABLED || '')) problems.push('bitrix_quotation_switch_not_off');
  for (const key of BLANK_REQUIRED) if (String(env[key] || '') !== '') problems.push(`${key.toLowerCase()}_not_blank`);
  if (env.PAYMENTS_ENABLED === 'true') problems.push('payments_enabled');
  if (String(env.SYNTHETIC_E2E_AUTO_APPROVE || '') === 'true') problems.push('auto_approve_enabled_in_api');
  // The synthetic approval secret belongs to the dedicated worker's approval engine only. The API must never hold it.
  if (String(env.SYNTHETIC_E2E_SECRET || '') !== '') problems.push('synthetic_secret_present_in_api');
  if (databaseOfUrl(env.DATABASE_URL) !== LIMITS.DATABASE) problems.push('database_not_identified');
  if (!LOOPBACK_HOSTS.includes(databaseHost(env.DATABASE_URL))) problems.push('database_host_not_loopback');
  return problems;
}

// The one check that needs the database: the API's own connection must answer exactly "humancare_dev".
async function confirmDatabase(prisma) {
  try {
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
    return Boolean(rows && rows[0] && rows[0].db === LIMITS.DATABASE);
  } catch {
    return false;
  }
}

// Fails closed: throws (naming every problem by code) unless every check holds.
async function assertApiSafeToRun(prisma, env = process.env) {
  const problems = apiConfigurationProblems(env);
  if (!problems.length && !(await confirmDatabase(prisma))) problems.push('database_not_identified');
  if (problems.length) throw Object.assign(new Error(`refused: ${problems.join(', ')}`), { problems });
}

function note(event) {
  const file = process.env.HC_EGRESS_EVIDENCE;
  if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, role: 'api', ...event })}\n`); } catch { /* reported by the orchestrator as a missing record */ }
}

async function main() {
  // dotenv never overrides a variable that is already set (even to ""), so the orchestrator's environment wins.
  require('dotenv').config();
  const { prisma } = require('./db/prisma');
  try {
    await assertApiSafeToRun(prisma);
    // A second look after Prisma has loaded: nothing may have changed the effective environment.
    const again = apiConfigurationProblems(process.env);
    if (again.length) throw Object.assign(new Error(`refused: ${again.join(', ')}`), { problems: again });
    note({ kind: 'database_identity_ok', database: LIMITS.DATABASE });
  } catch (err) {
    note({ kind: 'identity_failed', problems: err.problems || ['error'] });
    console.error(`[synthetic-e2e-api] Could not start: ${err.message}`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
    return;
  }
  require('./server'); // listens on PORT (4400) only now
}

if (require.main === module) {
  main().catch((err) => {
    note({ kind: 'identity_failed', problems: ['unexpected_error'] });
    console.error('[synthetic-e2e-api] Unexpected error:', err.message);
    process.exit(1);
  });
}

module.exports = { ISOLATED_API_PORT, apiConfigurationProblems, confirmDatabase, assertApiSafeToRun, egressGuardInstalled };
