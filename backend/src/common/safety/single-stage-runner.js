// The shared body of the three ONE-TIME quotation stage runners (src/quotation-sync-worker.js, src/quotation-scan-worker.js,
// src/quotation-auto-publish-worker.js). Each runner executes exactly ONE existing service function, ONCE, for the Cases named on the command line, and exits.
// It is not a scheduler: nothing here creates timers, requires src/jobs/index.js, src/worker.js or any other job, or contains a sync, scan or publication rule.
//
// Modes (an unknown argument is refused):
//   (no flag) / --readiness-only   validate the configuration and the live database, print what WOULD be processed (counts only), run nothing
//   --once --case-id <n> [...]     run the stage ONE time, limited to the given Case ids (at least one is REQUIRED; an unscoped run is never started)
//
// Refuses unless: NODE_ENV is neither production nor test; DATABASE_URL names humancare_dev on a loopback host AND the database SERVER answers
// SELECT DATABASE() = humancare_dev; the stage's own configuration is valid. Output is fixed codes, ids and counts: never a URL, key, secret or file name.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const REQUIRED_DATABASE = 'humancare_dev';
const ID = /^[1-9]\d{0,9}$/;
const MAX_SCOPE = 20;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

// A short code when the URL or NODE_ENV is not the local development database, or null. Never contains a value.
function developmentDatabaseProblem(env) {
  if (env.NODE_ENV === 'production') return 'refused_in_production';
  if (env.NODE_ENV === 'test') return 'node_env_test';
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { return 'database_url_invalid'; }
  if (url.protocol !== 'mysql:') return 'database_url_invalid';
  if (!LOOPBACK_HOSTS.has(url.hostname)) return 'database_host_not_local';
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== REQUIRED_DATABASE) return 'database_not_humancare_dev';
  return null;
}

// { mode: 'readiness' | 'once', caseIds: number[] } or throws { code }.
function parseArgs(argv) {
  const out = { mode: 'readiness', caseIds: [] };
  let sawMode = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--readiness-only' || arg === '--once') {
      if (sawMode) throw Object.assign(new Error('arguments'), { code: 'mode_repeated_or_conflicting' });
      sawMode = true;
      out.mode = arg === '--once' ? 'once' : 'readiness';
    } else if (arg === '--case-id') {
      const value = argv[i + 1];
      if (value === undefined || !ID.test(value)) throw Object.assign(new Error('arguments'), { code: 'case_id_invalid' });
      if (!out.caseIds.includes(Number(value))) out.caseIds.push(Number(value));
      if (out.caseIds.length > MAX_SCOPE) throw Object.assign(new Error('arguments'), { code: 'too_many_case_ids' });
      i += 1;
    } else {
      throw Object.assign(new Error('arguments'), { code: 'unknown_argument' });
    }
  }
  if (out.mode === 'once' && out.caseIds.length === 0) throw Object.assign(new Error('arguments'), { code: 'scope_required' });
  return out;
}

// What may be printed about a service result: numbers, booleans and identifier-shaped text at the top level, and for `results` only an allow-list of keys.
const RESULT_KEYS = ['id', 'eventId', 'quotationId', 'versionNumber', 'outcome', 'code'];
function summarize(result) {
  if (!result || typeof result !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'results' && Array.isArray(value)) {
      out.results = value.map((entry) => Object.fromEntries(RESULT_KEYS.filter((k) => entry && entry[k] != null && (typeof entry[k] === 'number' || (typeof entry[k] === 'string' && SAFE_TOKEN.test(entry[k])))).map((k) => [k, entry[k]])));
    } else if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && SAFE_TOKEN.test(value))) {
      out[key] = value;
    }
  }
  return out;
}

async function confirmDatabase(prisma) {
  try {
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
    return Boolean(rows && rows[0] && rows[0].db === REQUIRED_DATABASE);
  } catch { return false; }
}

/**
 * @param stage { label, configProblems(env) -> string[], liveProblems?(prisma, env, caseIds) -> Promise<string[]>, describe?(prisma, env, caseIds) -> Promise<object>,
 *                execute(caseIds, { env, prisma }) -> Promise<result> }
 * @param ctx   { argv, env, prisma, log }
 * Resolves the process exit code: 0 ok, 1 refused or not ready, 2 the stage itself failed.
 */
async function runStage(stage, { argv, env, prisma, log = console }) {
  let args;
  try { args = parseArgs(argv); } catch (err) { log.error(`[${stage.label}] refused: ${err.code || 'arguments_invalid'}.`); return 1; }

  const problems = [];
  const dbProblem = developmentDatabaseProblem(env);
  if (dbProblem) problems.push(dbProblem);
  if (!problems.length) problems.push(...stage.configProblems(env));
  if (!problems.length && !(await confirmDatabase(prisma))) problems.push('database_not_humancare_dev');
  if (!problems.length && stage.liveProblems) problems.push(...(await stage.liveProblems(prisma, env, args.caseIds)));
  if (problems.length) {
    log.error(`[${stage.label}] refused: ${problems.join(', ')}. Nothing was read or written.`);
    return 1;
  }

  if (args.mode === 'readiness') {
    const info = stage.describe ? await stage.describe(prisma, env, args.caseIds) : {};
    log.log(`[${stage.label}] READY (readiness only: nothing was run). Database ${REQUIRED_DATABASE} confirmed. ${JSON.stringify(summarize(info))}`);
    return 0;
  }

  log.log(`[${stage.label}] running ONE pass for case id(s) ${args.caseIds.join(', ')}.`);
  let result;
  try {
    result = await stage.execute(args.caseIds, { env, prisma });
  } catch (err) {
    log.error(`[${stage.label}] failed: ${(err && typeof err.code === 'string' && SAFE_TOKEN.test(err.code) && err.code) || (err && typeof err.name === 'string' && SAFE_TOKEN.test(err.name) && err.name) || 'Error'}.`);
    return 2;
  }
  log.log(`[${stage.label}] done. ${JSON.stringify(summarize(result))}`);
  return 0;
}

// The entry-file wrapper: loads backend/.env INSIDE main (never at import; values already in the process environment win), then runs the stage and closes
// the database. `loadStage` is called only after the environment is loaded, so a module that reads settings at import sees the final values.
async function main(loadStage, argv = process.argv.slice(2)) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env'), quiet: true });
  const { prisma } = require('../../db/prisma');
  let code = 1;
  try { code = await runStage(loadStage(), { argv, env: process.env, prisma }); } finally { await prisma.$disconnect().catch(() => undefined); }
  return code;
}

module.exports = { runStage, main, parseArgs, summarize, developmentDatabaseProblem, confirmDatabase, REQUIRED_DATABASE, MAX_SCOPE };
