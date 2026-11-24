// Dispatches ONE named outbox event to Bitrix24 through the EXISTING Deal worker, without starting the general worker or any of its other jobs.
//
// Nothing here creates a Deal, claims an event, locks, retries or reconciles on its own. It only (1) proves the named event is exactly what the
// operator says it is, (2) runs the existing runDealWorker with a scope narrowed to that one event, and (3) waits for the existing machinery to
// finish (a refused or ambiguous call is retried / reconciled by the Deal worker itself, on its own schedule: this loop just runs another scoped pass
// when the event is due again). So the outbox, the lease and fence, the "call started" evidence written before the call, the single crm.deal.add per
// event, the reconciliation by reference after an ambiguous timeout, and the shared rate limiter and circuit breaker are all the unchanged
// implementation, not a second path.
//
// What guarantees that only the named event is touched:
//   * the scope is { caseIds: [its Case], eventIds: [its id] }: the candidate SQL and the lease recovery SQL both carry "o.id IN (...)", so no other
//     event can be offered, claimed or recovered, whatever else is in the table (the synthetic-identity exclusion stays in the same statement);
//   * before anything runs, the event must be exactly as named: type, entity, profile, the Case and request references, an idempotency key that
//     matches its Case, a pending event with no attempt, no lease and no call evidence, an approved Private Charter request without a Lead, a link
//     without a Deal ID, a name that is not the synthetic identity, and it must be the ONLY outbox event of its Case. Anything else refuses;
//   * an event that is already completed (or its link already holds a Deal ID) is reported as already dispatched and nothing is run;
//   * dispatch needs the process environment of a Deal worker (both Bitrix switches, profile actual, review workflow) and REFUSES while quotation
//     synchronization is on. The database must be humancare_dev on a loopback host, confirmed by the server itself.
// Without `execute` it is a read-only dry run: the same checks, no claim, no call.
const os = require('os');
const crypto = require('crypto');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const {
  isPrivateCharterDealEnabled, isQuotationSyncRequested, assertBitrixConfiguration, bitrixHostProblem,
} = require('./bitrix-config');
const { resolveProfile } = require('./bitrix-profiles');

const EVENT_TYPE = 'bitrix.deal.create';
const EXPECTED_DATABASE = 'humancare_dev';
const SYNTHETIC_IDENTITY_PREFIX = 'ZZ-SYNTHETIC'; // the same literal the candidate SQL uses (deal-outbox.store.js)
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_MINUTES = 30;
const DEFAULT_MINUTES = 6;
const MAX_PASSES = 20;
const MANUAL_REVIEW = 'manual_review_required';

// ---- arguments ---------------------------------------------------------------------------------------------------------------------------
// -> { eventId, caseReference, requestReference, execute, maxMinutes } | { error }. All three identifiers are mandatory: no default, no "latest".
function parseArgs(argv = []) {
  const args = argv.slice();
  const named = {};
  let execute = false;
  while (args.length) {
    const key = args.shift();
    if (key === '--execute') { execute = true; continue; }
    if (!['--event-id', '--case-reference', '--request-reference', '--max-minutes'].includes(key)) return { error: 'unknown_option' };
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) return { error: 'missing_value' };
    named[key] = value;
  }
  if (!/^[1-9]\d{0,9}$/.test(String(named['--event-id']))) return { error: 'event_id_required' };
  if (!/^CASE-\d{1,10}$/.test(String(named['--case-reference']))) return { error: 'case_reference_required' };
  if (!/^REQ-\d{1,10}$/.test(String(named['--request-reference']))) return { error: 'request_reference_required' };
  let maxMinutes = DEFAULT_MINUTES;
  if (named['--max-minutes'] !== undefined) {
    maxMinutes = Number(named['--max-minutes']);
    if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > MAX_MINUTES) return { error: 'max_minutes_invalid' };
  }
  return { eventId: Number(named['--event-id']), caseReference: named['--case-reference'], requestReference: named['--request-reference'], execute, maxMinutes };
}

// ---- the checks ----------------------------------------------------------------------------------------------------------------------------
const loopback = (databaseUrl) => {
  try { return LOOPBACK_HOSTS.has(new URL(String(databaseUrl)).hostname.toLowerCase()); } catch { return false; }
};
const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

// -> { ok, problems: [codes], alreadyDispatched, target }. Reads only (SELECT); never writes, claims or calls anything.
async function inspectTarget({ prisma, env = process.env, eventId, caseReference, requestReference }) {
  const problems = [];
  const database = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  if (!database || !database[0] || database[0].db !== EXPECTED_DATABASE) problems.push('database_not_humancare_dev');
  if (!loopback(env.DATABASE_URL)) problems.push('database_not_loopback');
  if (problems.length) return { ok: false, problems, alreadyDispatched: false, target: null };

  const rows = await prisma.$queryRaw`
    SELECT o.id, o.event_type, o.entity_type, o.entity_id, o.case_id, o.status, o.attempts, o.locked_by, o.external_call_started_at, o.idempotency_key,
           JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.profile')) AS profile,
           c.reference_number AS case_reference, c.service_request_id,
           sr.reference_number AS request_reference, sr.review_status, sr.service_key, sr.bitrix_lead_id, sr.patient_name,
           l.id AS link_id, l.profile AS link_profile, l.bitrix_deal_id
    FROM integration_outbox o
    LEFT JOIN cases c ON c.id = o.case_id
    LEFT JOIN service_requests sr ON sr.id = c.service_request_id
    LEFT JOIN bitrix_deal_links l ON l.case_id = c.id
    WHERE o.id = ${eventId}`;
  if (!rows || rows.length !== 1) return { ok: false, problems: ['event_not_found'], alreadyDispatched: false, target: null };
  const r = rows[0];
  const caseId = toNumber(r.case_id);
  const target = {
    eventId: toNumber(r.id), caseId, caseReference: r.case_reference, requestId: toNumber(r.service_request_id), requestReference: r.request_reference,
    profile: r.profile, status: r.status, attempts: toNumber(r.attempts),
  };

  const alreadyDispatched = r.status === 'completed' || r.bitrix_deal_id != null;
  if (alreadyDispatched) return { ok: false, problems: ['already_dispatched'], alreadyDispatched: true, target };

  if (r.event_type !== EVENT_TYPE) problems.push('event_type_mismatch');
  if (r.entity_type !== 'case' || String(r.entity_id) !== String(caseId)) problems.push('entity_mismatch');
  if (r.case_reference !== caseReference) problems.push('case_reference_mismatch');
  if (r.request_reference !== requestReference) problems.push('request_reference_mismatch');
  if (r.profile !== 'actual') problems.push('event_profile_not_actual');
  if (r.link_profile !== 'actual') problems.push('link_profile_not_actual');
  if (r.idempotency_key !== `${EVENT_TYPE}:case:${caseId}`) problems.push('idempotency_key_mismatch');
  if (r.status !== 'pending') problems.push('event_not_pending');
  if (toNumber(r.attempts) !== 0) problems.push('event_already_attempted');
  if (r.locked_by != null) problems.push('event_locked');
  if (r.external_call_started_at != null) problems.push('call_already_started');
  if (r.review_status !== 'approved') problems.push('request_not_approved');
  if (r.service_key !== PRIVATE_CHARTER_KEY) problems.push('not_private_charter');
  if (r.bitrix_lead_id != null) problems.push('request_has_lead');
  if (r.link_id == null) problems.push('deal_link_missing');
  if (String(r.patient_name || '').startsWith(SYNTHETIC_IDENTITY_PREFIX)) problems.push('synthetic_identity');

  const same = await prisma.$queryRaw`SELECT COUNT(*) AS c FROM integration_outbox WHERE case_id = ${caseId} OR idempotency_key = ${r.idempotency_key}`;
  if (toNumber(same[0].c) !== 1) problems.push('case_has_other_events');
  return { ok: problems.length === 0, problems, alreadyDispatched: false, target };
}

// The process environment a Deal worker needs; and the one thing that must be OFF. [] when fine.
function environmentProblems(env = process.env) {
  const problems = [];
  if (env.NODE_ENV === 'production') problems.push('production_refused');
  if (!isPrivateCharterDealEnabled(env)) problems.push('bitrix_switches_not_both_true');
  const profile = resolveProfile(env);
  if (!profile || profile.name !== 'actual') problems.push('bitrix_deal_profile_not_actual');
  if (env.PRIVATE_CHARTER_REVIEW_WORKFLOW !== 'true') problems.push('review_workflow_not_true');
  if (isQuotationSyncRequested(env)) problems.push('quotation_sync_must_be_off');
  if (!env.BITRIX24_WEBHOOK_URL) problems.push('webhook_not_configured');
  else if (bitrixHostProblem(env)) problems.push('portal_host_not_allowed');
  try { assertBitrixConfiguration(env); } catch { problems.push('bitrix_configuration_invalid'); }
  return problems;
}

// ---- state after a pass ----------------------------------------------------------------------------------------------------------------------
async function readState(prisma, eventId) {
  const rows = await prisma.$queryRaw`
    SELECT o.status, o.attempts, o.last_error, o.next_attempt_at, o.external_call_started_at, l.bitrix_deal_id, l.category_id, l.stage_id, l.profile AS link_profile, l.sync_status
    FROM integration_outbox o LEFT JOIN bitrix_deal_links l ON l.case_id = o.case_id WHERE o.id = ${eventId}`;
  const r = rows[0] || {};
  return {
    status: r.status, attempts: toNumber(r.attempts), lastError: r.last_error || null, nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : null,
    callStarted: r.external_call_started_at != null, dealId: r.bitrix_deal_id || null, categoryId: r.category_id || null, stageId: r.stage_id || null,
    linkProfile: r.link_profile || null, syncStatus: r.sync_status || null,
  };
}
async function othersTouched(prisma, eventId) {
  const rows = await prisma.$queryRaw`
    SELECT COUNT(*) AS c FROM integration_outbox
    WHERE id <> ${eventId} AND (status <> 'pending' OR attempts > 0 OR external_call_started_at IS NOT NULL OR locked_by IS NOT NULL)`;
  return toNumber(rows[0].c);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -> { outcome, ... }. outcome: refused | already_dispatched | dry_run | completed | failed | manual_review | incomplete
async function dispatchSingleEvent(options) {
  const {
    prisma, env = process.env, log = console, gateway, runWorker, execute = false, eventId, caseReference, requestReference, maxMinutes = DEFAULT_MINUTES,
    now = Date.now, sleep = defaultSleep,
  } = options;
  const inspected = await inspectTarget({ prisma, env, eventId, caseReference, requestReference });
  if (!inspected.ok) {
    return { outcome: inspected.alreadyDispatched ? 'already_dispatched' : 'refused', problems: inspected.problems, target: inspected.target };
  }
  const envProblems = environmentProblems(env);
  const baseline = await othersTouched(prisma, eventId);
  if (!execute) return { outcome: 'dry_run', ready: envProblems.length === 0, environmentProblems: envProblems, target: inspected.target, otherEventsTouchedBefore: baseline };
  if (envProblems.length) return { outcome: 'refused', problems: envProblems, target: inspected.target };
  if (!gateway || typeof runWorker !== 'function') return { outcome: 'refused', problems: ['gateway_or_worker_missing'], target: inspected.target };

  const { target } = inspected;
  const scope = { caseIds: [target.caseId], eventIds: [target.eventId] };
  const workerId = `single-event:${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
  const deadline = now() + maxMinutes * 60 * 1000;
  let passes = 0;
  for (;;) {
    passes += 1;
    // The existing Deal worker, one scoped pass: the shared gateway decides whether a call may go out, the scoped SQL decides which event may be claimed.
    const pass = await runWorker({ prisma, env, log, gateway, scope, workerId, reportFailures: async () => 0 });
    const state = await readState(prisma, target.eventId);
    const result = { passes, target, state, lastPass: pass, otherEventsTouchedBefore: baseline };
    if (state.status === 'completed') return { outcome: 'completed', ...result, otherEventsTouchedAfter: await othersTouched(prisma, target.eventId) };
    if (state.status === 'failed') return { outcome: 'failed', ...result, otherEventsTouchedAfter: await othersTouched(prisma, target.eventId) };
    if (state.status === 'ambiguous' && String(state.lastError || '').startsWith(MANUAL_REVIEW)) return { outcome: 'manual_review', ...result, otherEventsTouchedAfter: await othersTouched(prisma, target.eventId) };
    if (now() >= deadline || passes >= MAX_PASSES || state.status === 'processing') return { outcome: 'incomplete', ...result, otherEventsTouchedAfter: await othersTouched(prisma, target.eventId) };
    // pending (a refusal to retry later) or ambiguous (to be reconciled): wait until the Deal worker itself says it is due again, then run another scoped pass.
    const dueInMs = state.nextAttemptAt ? state.nextAttemptAt.getTime() - now() : 0;
    await sleep(Math.min(90 * 1000, Math.max(5 * 1000, dueInMs + 1000)));
  }
}

module.exports = {
  EVENT_TYPE, EXPECTED_DATABASE, MAX_MINUTES, DEFAULT_MINUTES, MAX_PASSES, parseArgs, inspectTarget, environmentProblems, readState, othersTouched, dispatchSingleEvent,
};
