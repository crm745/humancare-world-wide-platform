// A ONE-SHOT, controlled LIVE Bitrix24 Deal creation for ONE fixed Case in the test database (humancare_test).
// NOT src/worker.js and NOT e2e-worker.js (that one refuses the live portal on purpose). It never starts a scheduled job, never
// runs the document, Lead, inbox, reconcile or scan jobs, and it never offers any event except the one named below.
//
//   node scripts/e2e-deal-create-live.js                                  DRY RUN (default): checks everything, prints the plan; no claim, no write, no Bitrix call
//   node scripts/e2e-deal-create-live.js --execute --confirm CASE-3206    ONE worker pass: ONE crm.deal.add call to the allowed portal
//
// Fixed target (change the constants on purpose, never by a flag):
//   database humancare_test | CASE-3206 (id 2206) | request 3845 (REQ-4845) | outbox event 416 (bitrix.deal.create)
//   portal host b24-4orefh.bitrix24.in (the live portal: that is why this needs --execute AND --confirm)
//
// Safeguards (each is checked before anything is sent):
//   * the database is verified (humancare_test, a humancare_test* user) at the start AND again right before the pass;
//   * the webhook in .env.test must name exactly the allowed host, and BITRIX_ALLOWED_PORTAL_HOST is set to it for the worker;
//   * the worker's own candidate query, for scope Case 2206, must return EXACTLY [416]. Document events 417 and 418 are another
//     type and are never offered; no other event of the Case may be open;
//   * the Deal field mapping is built offline first (a mapping error stops the run before a claim; no values are printed);
//   * the worker gets a guarded API: exactly ONE crm.deal.add, any other Bitrix method or a second call is refused, and the HTTP
//     request itself is checked (the webhook's host, the crm.deal.add method, a single request) before it leaves the machine;
//   * no retry, no reconciliation lookup, no document call, no notification, no failure-alert writer.
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 2206, caseReference: 'CASE-3206', requestId: 3845, requestReference: 'REQ-4845', eventId: 416,
  portalHost: 'b24-4orefh.bitrix24.in', method: 'crm.deal.add',
});

class RunError extends Error {
  constructor(message) { super(`Live Deal creation: ${message}`); this.name = 'RunError'; }
}
const refuse = (message) => new RunError(message);

function parseArgs(argv) {
  const out = { execute: false, confirmed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--confirm') {
      if (argv[i + 1] !== TARGET.caseReference) throw refuse(`--confirm must be followed by ${TARGET.caseReference}.`);
      out.confirmed = true;
      i += 1;
    } else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use: [--execute --confirm ${TARGET.caseReference}] (the target is fixed in the script).`);
  }
  if (out.execute && !out.confirmed) throw refuse(`--execute needs --confirm ${TARGET.caseReference}.`);
  if (out.confirmed && !out.execute) throw refuse('--confirm only applies together with --execute.');
  return out;
}

// The only Bitrix surface the worker sees: ONE crm.deal.add. Everything else refuses. The real client is used for that one call,
// with a fetch that checks the request itself (host, method, count) before it leaves the machine.
function makeGuardedApi(realApi, allowedHost) {
  const state = { createCalls: 0, requests: 0, refused: [] };
  const guardedFetch = async (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw new Error('Guarded fetch: unusable URL.'); }
    state.requests += 1;
    if (parsed.hostname.toLowerCase() !== allowedHost) throw new Error('Guarded fetch: host is not the allowed portal.');
    if (!parsed.pathname.endsWith(`/${TARGET.method}.json`)) throw new Error('Guarded fetch: only crm.deal.add is allowed.');
    if (!init || init.method !== 'POST') throw new Error('Guarded fetch: POST only.');
    if (state.requests > 1) throw new Error('Guarded fetch: only one request is allowed.');
    return fetch(url, init);
  };
  const api = {
    state,
    BitrixDealCallError: realApi.BitrixDealCallError,
    createDeal: async (fields, options = {}) => {
      state.createCalls += 1;
      if (state.createCalls > 1) { state.refused.push('createDeal(2nd)'); throw new Error('Only one crm.deal.add is allowed.'); }
      return realApi.createDeal(fields, { ...options, fetchImpl: guardedFetch });
    },
  };
  for (const method of ['findDealsByReference', 'getDeal', 'getDealFiles', 'updateDealFiles']) {
    api[method] = async () => { state.refused.push(method); throw new Error(`Bitrix24 method ${method} is disabled in this script.`); };
  }
  return api;
}

const rows = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);

// Read-only. Throws with every problem named (codes only, no patient data).
async function preflight(db, store, { prisma, buildDealFields }) {
  const problems = [];
  const [c] = await rows(db,
    `SELECT c.id, c.reference_number, c.service_request_id, sr.service_key, sr.review_status, sr.bitrix_lead_id, sr.reference_number AS request_reference,
            l.id AS link_id, l.bitrix_deal_id, l.sync_status
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId)
    .catch(() => rows(db,
      `SELECT c.id, c.reference_number, c.service_request_id, sr.service_key, sr.review_status, sr.bitrix_lead_id, NULL AS request_reference,
              l.id AS link_id, l.bitrix_deal_id, l.sync_status
       FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId));
  if (!c) throw refuse(`case ${TARGET.caseId} not found. Nothing was run.`);
  if (c.reference_number !== TARGET.caseReference) problems.push(`case ${TARGET.caseId} is not ${TARGET.caseReference}`);
  if (Number(c.service_request_id) !== TARGET.requestId) problems.push(`case is not linked to request ${TARGET.requestId}`);
  if (c.request_reference != null && c.request_reference !== TARGET.requestReference) problems.push(`the request is not ${TARGET.requestReference}`);
  if (c.service_key !== 'privatecharter') problems.push('not a Private Charter request');
  if (c.review_status !== 'approved') problems.push('the request is not approved');
  if (c.bitrix_lead_id != null) problems.push('the request has a Bitrix Lead');
  if (c.link_id == null) problems.push('no Deal link');
  if (c.bitrix_deal_id != null) problems.push('the Case already has a Deal id');

  const events = await rows(db,
    'SELECT id, event_type, status, attempts, external_call_started_at, locked_until, last_error FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  const target = events.find((e) => Number(e.id) === TARGET.eventId);
  if (!target || target.event_type !== 'bitrix.deal.create') problems.push(`event ${TARGET.eventId} is not the bitrix.deal.create event of this Case`);
  else if (target.status !== 'pending' || Number(target.attempts) !== 0 || target.external_call_started_at != null || target.locked_until != null || target.last_error != null) {
    problems.push(`event ${TARGET.eventId} is not a clean pending event (status ${target.status}, attempts ${target.attempts})`);
  }
  if (events.filter((e) => e.event_type === 'bitrix.deal.create').length !== 1) problems.push('the Case must have exactly one bitrix.deal.create event');

  // What the Deal worker's own (scoped) candidate query would offer. This is the query it really uses.
  const scope = { caseIds: [TARGET.caseId] };
  const offered = [...(await store.findCandidateIds(db, 'pending', 50, scope)), ...(await store.findCandidateIds(db, 'ambiguous', 50, scope))];
  if (JSON.stringify(offered) !== JSON.stringify([TARGET.eventId])) problems.push(`the worker would offer [${offered.join(', ')}], expected exactly [${TARGET.eventId}]`);

  // The Deal fields are built offline, exactly as the worker will. Only the outcome is reported, never a value.
  let fieldCount = null;
  try {
    const full = await prisma.case.findUnique({ where: { id: TARGET.caseId }, include: { serviceRequest: true } });
    fieldCount = Object.keys(buildDealFields(full, full.serviceRequest)).length;
  } catch (err) {
    problems.push(`the Deal fields cannot be built (${err && err.code ? err.code : 'mapping_error'})`);
  }

  if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
  const others = events.filter((e) => Number(e.id) !== TARGET.eventId);
  return { c, events, offered, fieldCount, others };
}

async function snapshot(db) {
  const events = await rows(db, 'SELECT id, event_type, status, attempts, last_error, external_call_started_at FROM integration_outbox WHERE case_id = ? ORDER BY id', TARGET.caseId);
  const [link] = await rows(db, 'SELECT bitrix_deal_id, sync_status, last_error FROM bitrix_deal_links WHERE case_id = ?', TARGET.caseId);
  return { events, link };
}

async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // validates the test environment before Prisma is loaded

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const { webhookHost, bitrixHostProblem, assertBitrixConfiguration } = require('../src/modules/bitrix/bitrix-config');
  const store = require('../src/modules/bitrix/deal-outbox.store');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const { buildDealFields } = require('../src/modules/bitrix/bitrix-deal');
  const { runDealWorker } = require('../src/modules/bitrix/deal-worker.service');
  const harness = require('../src/modules/bitrix/deal-worker-harness');

  try {
    const live = await verifyLiveDatabase(prisma);
    console.log(`Live Deal creation: database ${live.database}, account ${live.account}; ${options.execute ? 'EXECUTE' : 'DRY RUN'}.`);

    // Portal lock. The host only is printed; the webhook itself never is.
    if (webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the allowed portal. Nothing was run.');
    const workerEnvironment = harness.workerEnv({ ...env, BITRIX_ALLOWED_PORTAL_HOST: TARGET.portalHost }, { live: true });
    const hostProblem = bitrixHostProblem(workerEnvironment);
    if (hostProblem) throw refuse(`the portal lock failed (${hostProblem}). Nothing was run.`);
    assertBitrixConfiguration(workerEnvironment);
    console.log(`  portal lock: webhook host equals ${TARGET.portalHost}; allowlist set for this process only.`);

    const plan = await preflight(prisma, store, { prisma, buildDealFields });
    console.log(`  case ${TARGET.caseId} (${TARGET.caseReference}), request ${TARGET.requestId} (${TARGET.requestReference}), Deal id none; ${plan.fieldCount} Deal fields build cleanly.`);
    console.log(`  the worker would offer exactly: ${plan.offered.join(', ')} (bitrix.deal.create). Other events of the Case stay untouched: ${plan.others.map((e) => `${e.id} ${e.event_type} ${e.status}`).join('; ') || 'none'}.`);
    console.log(`  expected: ONE ${TARGET.method} call; the Deal id is stored on the Case's Deal link; event ${TARGET.eventId} completes.`);
    if (!options.execute) {
      console.log('Dry run: nothing was claimed, written or sent. Add --execute --confirm CASE-3206 for the live run.');
      return;
    }

    // Verify again immediately before the pass, and re-check the plan.
    await verifyLiveDatabase(prisma);
    await preflight(prisma, store, { prisma, buildDealFields });
    const before = await snapshot(prisma);

    const api = makeGuardedApi(realApi, TARGET.portalHost);
    const result = await runDealWorker({
      prisma, api, env: workerEnvironment, log: console, scope: { caseIds: [TARGET.caseId] }, reportFailures: async () => 0,
    });
    console.log(`Pass finished: ${JSON.stringify(result)}; ${TARGET.method} calls: ${api.state.createCalls}; HTTP requests: ${api.state.requests}; refused: ${api.state.refused.join(', ') || 'none'}.`);

    const after = await snapshot(prisma);
    for (const e of after.events) console.log(`  event ${e.id} ${e.event_type}: ${e.status}, attempts ${e.attempts}${e.last_error ? `, ${String(e.last_error).slice(0, 60)}` : ''}`);
    console.log(`  Deal link: Deal id ${after.link && after.link.bitrix_deal_id != null ? after.link.bitrix_deal_id : 'none'}, sync_status ${after.link ? after.link.sync_status : 'n/a'}.`);
    const untouched = before.events.filter((e) => Number(e.id) !== TARGET.eventId).every((b) => {
      const a = after.events.find((e) => Number(e.id) === Number(b.id));
      return a && a.status === b.status && Number(a.attempts) === Number(b.attempts);
    });
    if (!untouched) { console.error('WARNING: another event of the Case changed. Stop and investigate.'); process.exitCode = 2; }
    if (api.state.createCalls !== 1 || api.state.requests !== 1) { console.error('WARNING: the number of Bitrix calls is not exactly one. Stop and investigate; do not re-run.'); process.exitCode = 2; }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, preflight, makeGuardedApi, TARGET };
