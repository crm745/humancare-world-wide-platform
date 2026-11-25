// The logic of the ONE-TIME, single-Deal Bitrix detection runner (src/bitrix-deal-detect-worker.js): it makes HumanCare notice what Operations did to ONE Deal in
// Bitrix24 (a quotation PDF, an amount, the stage "Quoted") WITHOUT the webhook, so that the quotation synchronization has an event to deliver.
//
// It does NOT re-implement detection. The change is queued by the existing reconcileDeals() (narrowed with its own `scope = { dealId, ignoreRecheck }`) and applied by the
// existing runInboxWorker() (deal-inbox.service.js: exact Deal / Category / Case-reference checks, the idempotent "bitrix.quotation.sync" event, Case lock, compare-and-swap,
// stage event, deal link, audit). This file only proves WHAT is being processed and narrows WHICH rows those two functions can reach.
//
// HARD LIMITS
//   * exactly ONE Deal, ONE Case id and ONE Case reference, all three required and all three must agree with the stored link, the Case and the live Deal.
//     Case id 206, CASE-1206 and Deal 21846 are refused outright.
//   * the actual pipeline only: profile "actual" (Category 0, its reference field, its stage table, its quotation fields). The link must be stamped "actual", the Deal's
//     Category must be 0, the Case must be an open, approved Private Charter Case the profile serves (never inferred from a name), and the stage is the one the operator
//     confirmed with --expect-stage (exactly UC_R55CKV "Quoted", UC_9E9NRI "Confirmed", UC_HS6O2F "Activate" or WON "Case Completed"), which must equal the live Deal's stage and also be a stage the actual mapping approves.
//   * the Deal is read from Bitrix ONCE. That exact answer is pinned: the reconcile pass and the inbox processor get a client that returns THAT snapshot for THAT Deal id
//     and can call nothing else (any other Deal id answers "out_of_scope"), so the stage that was verified is the stage that is applied.
//   * the inbox processor gets a store that offers only the 'received' rows of THIS Deal, will not claim any other row, and performs no lease recovery: every other
//     inbox row, outbox event and deal link is neither claimed, retried, failed nor recovered. Before and after digests of all of them must be identical.
//   * no push delivery is queued (the inbox gets suppressedEnqueuePush, an explicit no-op, whatever the environment says; the in-app notification is still written). Quotation synchronization must be ON (it is what queues the quotation event); nothing is sent to Bitrix24 (one crm.deal.get).
// Dry run (the default) performs the one read-only Bitrix lookup and database reads and writes NOTHING. Nothing here starts a job runner or a timer.
const crypto = require('crypto');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { isPrivateCharterDealWorkerActive, isQuotationSyncActive } = require('./bitrix-config');
const { resolveProfile, PROFILE_ACTUAL } = require('./bitrix-profiles');
const { quotationFieldsForProfile } = require('./quotation-outbox');
const { linkProfileProblem, dealProblem, lookupProfileStage } = require('./bitrix-profile-runtime');
const { assertDealEligible } = require('./deal-outbox');
const { developmentDatabaseProblem, confirmDatabase } = require('../../common/safety/single-stage-runner');
const { suppressedEnqueuePush } = require('../notifications/push-delivery-enqueue');

const SOURCE = 'bitrix24';
// The ONLY stages the operator may confirm with --expect-stage: "Quoted" (UC_R55CKV), "Confirmed" (UC_9E9NRI), "Activate" (UC_HS6O2F) and "Case Completed" (WON). Anything else is refused.
const ALLOWED_STAGES = Object.freeze(['UC_R55CKV', 'UC_9E9NRI', 'UC_HS6O2F', 'WON']);
const REQUIRED_CATEGORY = '0';
const CLOSED = new Set(['completed', 'cancelled']);
// The Case, reference and Deal of an earlier demonstration: never a target of this runner.
const DENIED = Object.freeze({ caseIds: Object.freeze([206]), caseReferences: Object.freeze(['CASE-1206']), dealIds: Object.freeze(['21846']) });

class Refusal extends Error {
  constructor(code) { super(code); this.name = 'Refusal'; this.code = code; }
}
const refuse = (code) => new Refusal(code);
const SAFE = /^[a-z][a-z0-9_]{0,60}$/;
const safeCode = (err) => (err && typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(err.code) ? err.code : err && typeof err.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(err.name) ? err.name : 'Error');

// ---- arguments ---------------------------------------------------------------------------------------------------------------------------------
/** -> { execute, dealId, caseId, caseReference, expectStage }. Throws Refusal. The default is the readiness check; only --once executes. */
function parseArgs(argv = []) {
  const named = {};
  let mode = null;
  const names = ['--deal-id', '--case-id', '--case-reference', '--expect-stage'];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once' || arg === '--readiness-only') {
      if (mode) throw refuse('mode_repeated_or_conflicting');
      mode = arg;
    } else if (names.includes(arg)) {
      if (named[arg] !== undefined) throw refuse('argument_repeated');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw refuse('argument_value_missing');
      named[arg] = value;
      i += 1;
    } else {
      throw refuse('unknown_argument');
    }
  }
  if (!/^[1-9]\d{0,17}$/.test(String(named['--deal-id']))) throw refuse('deal_id_required');
  if (!/^[1-9]\d{0,9}$/.test(String(named['--case-id']))) throw refuse('case_id_required');
  if (!/^CASE-\d{1,10}$/.test(String(named['--case-reference']))) throw refuse('case_reference_required');
  if (named['--expect-stage'] === undefined) throw refuse('expect_stage_required');
  if (!ALLOWED_STAGES.includes(named['--expect-stage'])) throw refuse('expect_stage_not_supported');
  const target = { dealId: named['--deal-id'], caseId: Number(named['--case-id']), caseReference: named['--case-reference'] };
  if (DENIED.dealIds.includes(target.dealId) || DENIED.caseIds.includes(target.caseId) || DENIED.caseReferences.includes(target.caseReference)) throw refuse('target_denied');
  return { execute: mode === '--once', ...target, expectStage: named['--expect-stage'] };
}

// ---- what the pinned client and the scoped store allow ---------------------------------------------------------------------------------
// The one verified Deal for the one Deal id, nothing else. It has NO other method: a call to anything else throws.
function pinnedApi(dealId, deal) {
  const snapshot = Object.freeze(JSON.parse(JSON.stringify(deal))); // an immutable copy: nothing later can change what was verified
  return Object.freeze({
    getDeal: async (id) => (String(id) === String(dealId) ? { status: 'ok', deal: JSON.parse(JSON.stringify(snapshot)) } : { status: 'uncertain', reason: 'out_of_scope' }),
  });
}

// The inbox store restricted to this Deal: only its 'received' rows are offered or claimable, and no lease of any row is recovered.
function scopedStore(baseStore, dealId) {
  const offered = new Set();
  return {
    ...baseStore,
    findDueIds: async (db, limit, profile) => {
      const mine = new Set((await db.integrationInbox.findMany({ where: { source: SOURCE, entityId: String(dealId), status: 'received' }, select: { id: true } })).map((r) => Number(r.id)));
      const due = await baseStore.findDueIds(db, 1000, profile);
      const ids = due.filter((id) => mine.has(id)).slice(0, limit);
      ids.forEach((id) => offered.add(id));
      return ids;
    },
    claim: async (db, args) => (offered.has(Number(args && args.id)) ? baseStore.claim(db, args) : null),
    recoverExpiredLeases: async () => ({ failed: 0, again: 0 }),
  };
}

// Everything that must NOT change: every inbox row, every outbox event and every deal link that is not this Deal's / this Case's.
async function snapshotOthers(prisma, { dealId, caseId }) {
  const inbox = await prisma.integrationInbox.findMany({
    where: { OR: [{ entityId: null }, { entityId: { not: String(dealId) } }] },
    select: { id: true, status: true, attempts: true, lockedBy: true, lockedUntil: true, nextAttemptAt: true, lastError: true }, orderBy: { id: 'asc' },
  });
  const outbox = await prisma.integrationOutbox.findMany({
    where: { OR: [{ caseId: null }, { caseId: { not: caseId } }] },
    select: { id: true, status: true, attempts: true, lockedBy: true, lockedUntil: true, nextAttemptAt: true, lastError: true }, orderBy: { id: 'asc' },
  });
  const links = await prisma.bitrixDealLink.findMany({
    where: { OR: [{ bitrixDealId: null }, { bitrixDealId: { not: String(dealId) } }] },
    select: { id: true, stageId: true, externalModifiedAt: true, lastAttemptAt: true, syncStatus: true }, orderBy: { id: 'asc' },
  });
  const digest = crypto.createHash('sha256').update(JSON.stringify({ inbox, outbox, links })).digest('hex');
  return { inbox: inbox.length, outbox: outbox.length, links: links.length, digest };
}

// ---- the read-only inspection ----------------------------------------------------------------------------------------------------------------
// Returns the verified facts; throws Refusal on the first mismatch. Reads: the link, the Case, and ONE crm.deal.get. Writes nothing.
async function inspect({ prisma, api, env, target, profile }) {
  const link = await prisma.bitrixDealLink.findUnique({ where: { bitrixDealId: target.dealId }, include: { case: { include: { serviceRequest: true } } } });
  if (!link) throw refuse('deal_not_linked');
  if (link.caseId !== target.caseId) throw refuse('link_case_mismatch');
  const caseRecord = link.case;
  if (!caseRecord || caseRecord.id !== target.caseId) throw refuse('case_not_found');
  if (caseRecord.referenceNumber !== target.caseReference) throw refuse('case_reference_mismatch');
  if (DENIED.caseIds.includes(caseRecord.id) || DENIED.caseReferences.includes(caseRecord.referenceNumber)) throw refuse('target_denied');
  if (link.profile !== PROFILE_ACTUAL || linkProfileProblem(link, profile)) throw refuse('link_profile_not_actual'); // an unstamped link reads as "test", never "actual"
  if (String(link.categoryId) !== REQUIRED_CATEGORY) throw refuse('link_category_mismatch');

  const request = caseRecord.serviceRequest;
  if (!request || request.serviceKey !== PRIVATE_CHARTER_KEY) throw refuse('case_not_private_charter');
  if (!Array.isArray(profile.services) || !profile.services.includes(request.serviceKey)) throw refuse('service_not_served_by_profile');
  try { assertDealEligible(caseRecord, request); } catch { throw refuse('case_not_eligible'); }
  if (request.reviewStatus !== 'approved') throw refuse('request_not_approved');
  if (CLOSED.has(caseRecord.status)) throw refuse('case_closed');

  const read = await api.getDeal(target.dealId, { env });
  if (read.status === 'not_found') throw refuse('deal_not_found_in_bitrix');
  if (read.status !== 'ok') throw refuse(`bitrix_read_failed_${SAFE.test(String(read.reason)) ? read.reason : read.status}`);
  const deal = read.deal;
  if (String(deal.ID) !== target.dealId) throw refuse('deal_id_mismatch');
  if (String(deal.CATEGORY_ID) !== REQUIRED_CATEGORY) throw refuse('deal_category_mismatch');
  const problem = dealProblem(profile, deal, target.dealId, caseRecord.referenceNumber);
  if (problem) throw refuse(`deal_${problem}`);
  const modified = new Date(deal.DATE_MODIFY);
  if (typeof deal.DATE_MODIFY !== 'string' || Number.isNaN(modified.getTime())) throw refuse('deal_modified_time_invalid');
  if (deal.STAGE_ID !== target.expectStage) throw refuse('expect_stage_mismatch'); // the live stage is not the one the operator confirmed
  const stage = lookupProfileStage(profile, deal.STAGE_ID, deal);
  if (!stage.ok) throw refuse(`stage_not_approved_${SAFE.test(String(stage.code)) ? stage.code : 'unknown'}`);
  return { link, caseRecord, deal, modified, stage };
}

const describeFacts = ({ link, caseRecord, deal, modified, stage }) => ({
  case: { id: caseRecord.id, reference: caseRecord.referenceNumber, status: caseRecord.status, charterStage: caseRecord.charterStage ?? null, stageVersion: Number(caseRecord.stageVersion) },
  link: { stageId: link.stageId ?? null, externalModifiedAt: link.externalModifiedAt ? new Date(link.externalModifiedAt).toISOString() : null },
  deal: { id: String(deal.ID), categoryId: String(deal.CATEGORY_ID), stageId: deal.STAGE_ID, modifiedAt: modified.toISOString() },
  mapping: { approved: true, charterStage: stage.entry.key, caseStatus: stage.entry.status, patientVisible: stage.entry.patientVisible === true },
});

/**
 * Dry run unless `options.execute`. `deps`: { prisma, api, env, log, reconcile?, runInbox?, store? } (the last three default to the real ones).
 * Resolves { executed, facts, ... } or { executed: false, nothingToApply }. Throws Refusal for a failed check. Nothing is written unless it returns executed: true.
 */
async function runSingleDealDetect(options, deps) {
  const { prisma, api, env, log = console } = deps;
  const target = { dealId: options.dealId, caseId: options.caseId, caseReference: options.caseReference, expectStage: options.expectStage };
  if (DENIED.dealIds.includes(target.dealId) || DENIED.caseIds.includes(target.caseId) || DENIED.caseReferences.includes(target.caseReference)) throw refuse('target_denied');
  if (env.NODE_ENV === 'production') throw refuse('refused_in_production');
  const profile = resolveProfile(env);
  if (!profile || profile.name !== PROFILE_ACTUAL || String(profile.categoryId) !== REQUIRED_CATEGORY) throw refuse('profile_not_actual');
  if (!isPrivateCharterDealWorkerActive(env)) throw refuse('bitrix_switches_not_active');
  if (!isQuotationSyncActive(env)) throw refuse('quotation_sync_inactive');
  if (!quotationFieldsForProfile(profile)) throw refuse('quotation_fields_not_configured');

  const found = await inspect({ prisma, api, env, target, profile });
  const facts = describeFacts(found);
  if (!options.execute) return { executed: false, facts };

  const unchanged = found.link.stageId === found.deal.STAGE_ID && found.link.externalModifiedAt && found.modified.getTime() <= new Date(found.link.externalModifiedAt).getTime();
  if (unchanged) return { executed: false, facts, nothingToApply: true };

  const reconcile = deps.reconcile || require('./deal-reconcile.service').reconcileDeals;
  const runInbox = deps.runInbox || require('./deal-inbox.service').runInboxWorker;
  const baseStore = deps.store || require('./deal-inbox.store');
  const pinned = pinnedApi(target.dealId, found.deal);

  const before = await snapshotOthers(prisma, target);
  const reconciled = await reconcile({ prisma, api: pinned, env, log, scope: { dealId: target.dealId, ignoreRecheck: true } });
  const processed = await runInbox({ prisma, api: pinned, env, log, store: scopedStore(baseStore, target.dealId), enqueuePush: suppressedEnqueuePush });
  const after = await snapshotOthers(prisma, target);
  const othersUnchanged = before.digest === after.digest && before.inbox === after.inbox && before.outbox === after.outbox && before.links === after.links;
  const quotationEvents = await prisma.integrationOutbox.count({ where: { caseId: target.caseId, eventType: 'bitrix.quotation.sync', status: 'pending' } });
  return { executed: true, facts, reconciled, processed, quotationEventsPending: quotationEvents, othersUnchanged, others: { inbox: after.inbox, outbox: after.outbox, links: after.links } };
}

const scalar = (v) => (typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, scalar(obj && obj[k])]).filter(([, v]) => v !== undefined));

/**
 * The whole command: arguments, environment and database checks, then the detection. Resolves the process exit code:
 * 0 ready / completed / nothing to apply, 1 refused, 2 failed or another row changed. Prints codes, ids and counts only.
 */
async function runCli({ argv, env, prisma, api, log = console, deps = {} }) {
  let options;
  try { options = parseArgs(argv); } catch (err) { log.error(`[deal-detect] refused: ${err.code || 'arguments_invalid'}.`); return 1; }

  const dbProblem = developmentDatabaseProblem(env);
  if (dbProblem) { log.error(`[deal-detect] refused: ${dbProblem}. Nothing was read or written.`); return 1; }
  if (!(await confirmDatabase(prisma))) { log.error('[deal-detect] refused: database_not_humancare_dev. Nothing was read or written.'); return 1; }

  let result;
  try {
    result = await runSingleDealDetect(options, { prisma, api, env, log, ...deps });
  } catch (err) {
    if (err instanceof Refusal) { log.error(`[deal-detect] refused: ${err.code}. Nothing was written.`); return 1; }
    log.error(`[deal-detect] failed: ${safeCode(err)}. The pass may be partly applied; every step is idempotent, run the readiness check again.`);
    return 2;
  }
  const summary = {
    mode: options.execute ? 'once' : 'readiness-only', facts: result.facts,
    ...(result.nothingToApply ? { nothingToApply: true, note: 'the stored link already holds this stage and modified time, so no event would be queued' } : {}),
    ...(result.executed ? {
      reconciled: pick(result.reconciled, ['checked', 'queued']), processed: pick(result.processed, ['claimed']), quotationEventsPending: result.quotationEventsPending,
      othersUnchanged: result.othersUnchanged, others: result.others,
    } : {}),
  };
  log.log(`[deal-detect] ${options.execute ? (result.executed ? 'done' : 'nothing applied') : 'READY (readiness only: nothing was written)'}. ${JSON.stringify(summary)}`);
  if (result.executed && result.othersUnchanged !== true) { log.error('[deal-detect] ALERT: another inbox row, outbox event or deal link changed.'); return 2; }
  return 0;
}

module.exports = { parseArgs, inspect, describeFacts, pinnedApi, scopedStore, snapshotOthers, runSingleDealDetect, runCli, Refusal, DENIED, ALLOWED_STAGES, REQUIRED_CATEGORY };
