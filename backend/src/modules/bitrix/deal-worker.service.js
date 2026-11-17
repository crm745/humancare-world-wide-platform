// The Bitrix24 Deal worker: delivers "bitrix.deal.create" events from IntegrationOutbox, one Deal per Case in
// Category 38. Follows the approved M6 design (see deal-outbox.store.js for the SQL, the lease and the fence).
//
// SWITCHES: it does nothing at all (no recovery, no claim, no call) unless BITRIX_SYNC_ENABLED,
// BITRIX_PRIVATE_CHARTER_DEAL_ENABLED and PRIVATE_CHARTER_REVIEW_WORKFLOW are all exactly "true".
//
// PER EVENT
//   pending event, no earlier call  -> build the payload (a mapping problem is a definitive failure, nothing
//                                      sent) -> set external_call_started_at (fenced) -> ONE crm.deal.add ->
//                                      record the result with a fenced write.
//   ambiguous event (outcome of an earlier call unknown) -> NEVER crm.deal.add again: search Category 38 for the
//                                      exact Primary Deal Reference.
//   Bitrix is never called inside a database transaction.
//
// RESULTS (each ONE fenced UPDATE; 0 rows = the lease was lost and nothing else is written):
//   Deal created / adopted     -> 'completed' + BitrixDealLink (exact Deal ID as text) + audit, in ONE transaction.
//   definitive refusal         -> 'failed' (terminal; needs a human decision), link marked 'error'.
//   timeout / lost response    -> 'ambiguous'; reconciled after RECONCILE_FIRST_DELAY_SECONDS.
//   reconciliation: one match  -> adopt it. Several matches -> manual review (never deleted). No match or an
//                                 uncertain lookup -> stay 'ambiguous' and look again every
//                                 RECONCILE_INTERVAL_SECONDS; past RECONCILIATION_WINDOW_SECONDS -> manual review.
//                                 HumanCare never creates a second Deal while the outcome is uncertain.
const os = require('os');
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { isPrivateCharterDealWorkerActive } = require('./bitrix-config');
const { assertDealEligible, assertDealCreationAllowed } = require('./deal-outbox');
const { buildDealFields, DealMappingError, DEAL } = require('./bitrix-deal');
const bitrixDealApi = require('./bitrix-deal.api');
const defaultStore = require('./deal-outbox.store');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { reportDealFailures } = require('./deal-failure-alerts');

const LEASE_SECONDS = 120; // well above the 15 s request timeout
const MIN_LEASE_LEFT_BEFORE_CALL_SECONDS = bitrixDealApi.REQUEST_TIMEOUT_MS / 1000 + 30;
const MAX_CLAIMS_BEFORE_ANY_CALL = 10;
const BATCH_SIZE = 5;
const RECONCILE_FIRST_DELAY_SECONDS = 60;
const RECONCILE_INTERVAL_SECONDS = 5 * 60;
// How long reconciliation keeps looking before it gives up and asks a person. The length is a business decision
// (M6 R3); 24 hours is a conservative PROVISIONAL value, not an approved one.
const RECONCILIATION_WINDOW_SECONDS = 24 * 60 * 60;

class LeaseLostError extends Error {
  constructor() { super('The event lease was lost; nothing was written.'); this.name = 'LeaseLostError'; }
}

const makeWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);

function buildContext(overrides = {}) {
  const ctx = {
    prisma: defaultPrisma, store: defaultStore, api: bitrixDealApi, env: process.env, log: console,
    reportFailures: reportDealFailures, workerId: makeWorkerId(), ...overrides,
  };
  // A scoped pass (scope: { caseIds }, used by scripts/e2e-worker.js) never writes failure alerts about events that are
  // not in its scope: the default alert writer looks at EVERY failed event, so it is replaced unless the caller gives one.
  if (ctx.scope && !('reportFailures' in overrides)) ctx.reportFailures = async () => 0;
  return ctx;
}

// ---- recording results ---------------------------------------------------------------------------------------------

// Event result + link update in one transaction. The fenced event write comes FIRST: if it writes 0 rows the
// transaction is abandoned before anything else is touched.
async function recordResult(ctx, claim, { status, lastError, delaySeconds = 0, link = null, deal = null, audit = null }) {
  await ctx.prisma.$transaction(async (tx) => {
    const written = await ctx.store.writeResult(tx, claim, { status, lastError, delaySeconds });
    if (written !== 1) throw new LeaseLostError();
    if (link) {
      await tx.bitrixDealLink.update({ where: { caseId: claim.caseId }, data: { ...link, lastAttemptAt: new Date() } });
    }
    if (audit) await appendAuditLog(tx, audit);
  });
}

async function safeRecord(ctx, claim, result) {
  try {
    await recordResult(ctx, claim, result);
    return true;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      ctx.log.warn(`[deal-worker] event ${claim.id}: lease lost, result not recorded (recovery will handle it).`);
      return false;
    }
    throw err;
  }
}

function completion(claim, caseRecord, dealId, stageId, adopted) {
  const now = new Date();
  return {
    status: 'completed',
    lastError: null,
    link: { bitrixDealId: dealId, categoryId: String(DEAL.CATEGORY_ID), stageId: stageId ?? null, syncStatus: 'synced', lastSyncedAt: now, lastError: null },
    audit: {
      caseId: claim.caseId, entityType: 'bitrix_deal_link', entityId: claim.caseId, action: 'bitrix.deal.linked',
      actorType: 'system', source: 'system', reasonCode: adopted ? 'deal_adopted_by_reference' : 'deal_created',
      afterData: { caseId: claim.caseId, caseReference: caseRecord.referenceNumber, bitrixDealId: dealId },
      correlationId: `outbox:${claim.id}`, idempotencyKey: `bitrix.deal.linked:case:${claim.caseId}`,
    },
  };
}

async function complete(ctx, claim, caseRecord, dealId, stageId, adopted) {
  try {
    return await safeRecord(ctx, claim, completion(claim, caseRecord, dealId, stageId, adopted));
  } catch (err) {
    // The Deal ID is already linked to another Case (unique), or another write failed: do not guess. The event is
    // left for a person; nothing is created and nothing is deleted.
    if (err && err.code === 'P2002') return manualReview(ctx, claim, 'deal_id_already_linked');
    throw err;
  }
}

async function failDefinitively(ctx, claim, reason) {
  ctx.log.error(`[deal-worker] event ${claim.id} (case ${claim.caseId}) failed: ${reason}`);
  return safeRecord(ctx, claim, { status: 'failed', lastError: reason, link: { syncStatus: 'error', lastError: reason } });
}

async function markAmbiguous(ctx, claim, reason, delaySeconds) {
  return safeRecord(ctx, claim, { status: 'ambiguous', lastError: reason, delaySeconds, link: { syncStatus: 'pending', lastError: reason } });
}

async function manualReview(ctx, claim, reason) {
  const text = `${ctx.store.MANUAL_REVIEW_PREFIX}:${reason}`;
  // The alert itself (AuditLog row + [ALERT] line, once) is written by reportDealFailures at the end of the pass.
  return safeRecord(ctx, claim, {
    status: 'ambiguous', lastError: text, delaySeconds: RECONCILE_INTERVAL_SECONDS, link: { syncStatus: 'error', lastError: text },
  });
}

// ---- the two flows -------------------------------------------------------------------------------------------------

async function createFlow(ctx, claim, caseRecord) {
  const request = caseRecord.serviceRequest;
  let fields;
  try {
    fields = buildDealFields(caseRecord, request);
  } catch (err) {
    if (err instanceof DealMappingError) return failDefinitively(ctx, claim, `mapping:${err.code}`);
    throw err;
  }

  // Evidence first, committed BEFORE the call. If the lease cannot cover the call, no call is made.
  const started = await ctx.store.markExternalCallStarted(ctx.prisma, claim, MIN_LEASE_LEFT_BEFORE_CALL_SECONDS);
  if (!started) {
    ctx.log.warn(`[deal-worker] event ${claim.id}: lease too short or lost before the call; no call made.`);
    return false;
  }

  let created;
  try {
    created = await ctx.api.createDeal(fields, { env: ctx.env });
  } catch (err) {
    if (err instanceof bitrixDealApi.BitrixDealCallError && err.outcome === 'definitive') return failDefinitively(ctx, claim, err.message);
    // Anything else (timeout, lost connection, 5xx, unusable answer, unexpected error): the Deal may exist.
    const code = err instanceof bitrixDealApi.BitrixDealCallError ? err.message : 'unexpected_error_during_call';
    return markAmbiguous(ctx, claim, code, RECONCILE_FIRST_DELAY_SECONDS);
  }
  return complete(ctx, claim, caseRecord, created.dealId, DEAL.STAGE_ID, false);
}

async function reconcileFlow(ctx, claim, caseRecord) {
  const found = await ctx.api.findDealsByReference(caseRecord.referenceNumber, { env: ctx.env });
  if (found.status === 'single') return complete(ctx, claim, caseRecord, found.dealIds[0], found.stageId, true);
  if (found.status === 'multiple') return manualReview(ctx, claim, 'multiple_matching_deals');

  const waited = claim.secondsSinceCall;
  const windowOver = waited == null || waited >= RECONCILIATION_WINDOW_SECONDS;
  const why = found.status === 'none' ? 'no_match' : `lookup_uncertain:${found.reason || 'unknown'}`;
  if (windowOver) return manualReview(ctx, claim, `${why}_after_waiting_period`);
  // One empty or uncertain answer proves nothing: look again later, and never create another Deal.
  return markAmbiguous(ctx, claim, `reconciling:${why}`, RECONCILE_INTERVAL_SECONDS);
}

async function processClaim(ctx, claim) {
  const caseRecord = await ctx.prisma.case.findUnique({
    where: { id: claim.caseId },
    include: { serviceRequest: true, bitrixDealLink: true },
  });
  // Defence in depth: the candidate query already excludes these, and the checks are repeated on the loaded rows.
  try {
    assertDealEligible(caseRecord, caseRecord && caseRecord.serviceRequest);
  } catch (err) {
    return failDefinitively(ctx, claim, `not_eligible: ${err.message}`);
  }
  const link = caseRecord.bitrixDealLink;
  if (!link) return failDefinitively(ctx, claim, 'deal_link_missing');
  if (link.bitrixDealId) {
    // The Case already has its Deal: never create another; just finish the event.
    return complete(ctx, claim, caseRecord, link.bitrixDealId, link.stageId, true);
  }
  // A call may already have been started for this event (evidence set): never send crm.deal.add again.
  if (claim.fromStatus === 'pending' && claim.externalCallStartedAt == null) {
    // Defence in depth (the candidate query already offers only approved requests): a Deal is never CREATED for a
    // request that is not approved. Nothing is sent and nothing is written; the event is left as it is (its lease
    // runs out and it returns to pending), so it can still be sent once the request is approved.
    try {
      assertDealCreationAllowed(caseRecord, caseRecord.serviceRequest);
    } catch (err) {
      ctx.log.warn(`[deal-worker] event ${claim.id}: the request is not approved; no Deal is created.`);
      return false;
    }
    return createFlow(ctx, claim, caseRecord);
  }
  return reconcileFlow(ctx, claim, caseRecord);
}

// ---- one pass ------------------------------------------------------------------------------------------------------

// One pass of the worker. Returns how many events it claimed. Safe to call repeatedly; the job runner never
// overlaps two passes.
async function runDealWorker(overrides = {}) {
  const ctx = buildContext(overrides);
  if (!isPrivateCharterDealWorkerActive(ctx.env)) return { active: false, claimed: 0 };

  await ctx.store.recoverExpiredLeases(ctx.prisma, { maxClaims: MAX_CLAIMS_BEFORE_ANY_CALL, ...(ctx.scope && { caseIds: ctx.scope.caseIds }) });
  let claimed = 0;
  for (const fromStatus of ['pending', 'ambiguous']) {
    const ids = await ctx.store.findCandidateIds(ctx.prisma, fromStatus, BATCH_SIZE, ctx.scope);
    for (const id of ids) {
      const claim = await ctx.store.claim(ctx.prisma, { id, fromStatus, workerId: ctx.workerId, leaseSeconds: LEASE_SECONDS });
      if (!claim) continue;
      claimed += 1;
      try {
        await processClaim(ctx, claim);
      } catch (err) {
        // Unknown failure: leave the event as it is. If a call had started, lease expiry makes it 'ambiguous';
        // if not, it returns to 'pending'. Log the error name only (messages could carry data).
        ctx.log.error(`[deal-worker] event ${claim.id}: unexpected ${err && err.name ? err.name : 'error'}; left for lease recovery.`);
      }
    }
  }
  // Alerts for failed / manual-review events (see deal-failure-alerts.js). A problem here never affects delivery.
  try {
    await ctx.reportFailures({ prisma: ctx.prisma, log: ctx.log });
  } catch (err) {
    ctx.log.error(`[deal-worker] could not write failure alerts: ${err && err.name ? err.name : 'error'}`);
  }
  return { active: true, claimed };
}

module.exports = {
  runDealWorker, processClaim, LeaseLostError,
  LEASE_SECONDS, MIN_LEASE_LEFT_BEFORE_CALL_SECONDS, MAX_CLAIMS_BEFORE_ANY_CALL, BATCH_SIZE,
  RECONCILE_FIRST_DELAY_SECONDS, RECONCILE_INTERVAL_SECONDS, RECONCILIATION_WINDOW_SECONDS,
};
