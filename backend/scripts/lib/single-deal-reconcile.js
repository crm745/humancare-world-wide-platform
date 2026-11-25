// The logic of the TEST-ONLY, single-Deal Bitrix reconciliation (scripts/e2e-reconcile-single-deal.js). The script around it applies the environment and
// database guards BEFORE this runs; this file refuses on its own as well.
//
// It does NOT re-implement anything: the Deal is read with the existing Bitrix client, the stage is looked up with the existing mapping
// (bitrix-deal-stages.js), the change is queued by the existing reconcileDeals() (narrowed with its `scope`) and applied by the existing inbox
// processor (deal-inbox.service.js: Case lock, compare-and-swap, stage event, deal link, fixed-text notification, audit, idempotency).
//
// HARD LIMITS
//   * exactly ONE Deal: TARGET below. Any other Deal / Case / reference on the command line is refused.
//   * the Deal is read from Bitrix ONCE. That exact answer is then pinned: the reconcile pass and the inbox processor both get a client that returns
//     THAT snapshot and can call nothing else, so the stage that was verified (and, for --execute, confirmed with --expect-stage) is the stage that is
//     applied, even if someone moves the Deal meanwhile.
//   * the inbox worker is given a store that can only see the 'received' rows of THIS Deal, and cannot run lease recovery: every other pending row
//     (other Deals) is neither claimed, retried, failed nor recovered. Before and after snapshots of every other inbox row and deal link are compared.
//   * quotation synchronization is forced off in memory by the script; no Razorpay, no webhook, no job runner is involved.
// Dry run (the default) performs the read-only Bitrix lookup and database reads and writes NOTHING.
const crypto = require('crypto');
const { lookupStage } = require('../../src/modules/bitrix/bitrix-deal-stages');
const { DEAL, FIELD } = require('../../src/modules/bitrix/bitrix-deal');
const { PRIVATE_CHARTER_KEY } = require('../../src/common/constants/request.constants');
const { suppressedEnqueuePush } = require('../../src/modules/notifications/push-delivery-enqueue');

const TARGET = Object.freeze({ dealId: '21802', caseId: 3037, caseReference: 'CASE-4037', categoryId: '38' });
const STAGE_ID_PATTERN = /^C38:[A-Z0-9_]{1,40}$/;
const SOURCE = 'bitrix24';
const CLOSED = new Set(['completed', 'cancelled']);

class SingleDealRefused extends Error {
  constructor(code) { super(code); this.name = 'SingleDealRefused'; this.code = code; }
}
const refuse = (code) => new SingleDealRefused(code);

// [--deal-id 21802] [--case-id 3037] [--case-reference CASE-4037] [--expect-stage C38:XXXX] [--no-push] [--execute]
// The target options are optional and only accepted when they equal TARGET (they exist so the command line says what it touches).
function parseArgs(argv) {
  const out = { expectStage: null, push: true, execute: false };
  const list = [...argv];
  const take = (name) => {
    const value = list.shift();
    if (value === undefined || value.startsWith('--')) throw refuse(`missing_value_for_${name}`);
    return value;
  };
  while (list.length) {
    const arg = list.shift();
    if (arg === '--execute') out.execute = true;
    else if (arg === '--no-push') out.push = false;
    else if (arg === '--expect-stage') {
      out.expectStage = take(arg);
      if (!STAGE_ID_PATTERN.test(out.expectStage)) throw refuse('expect_stage_invalid');
    } else if (arg === '--deal-id') { if (take(arg) !== TARGET.dealId) throw refuse('target_not_allowed'); }
    else if (arg === '--case-id') { if (take(arg) !== String(TARGET.caseId)) throw refuse('target_not_allowed'); }
    else if (arg === '--case-reference') { if (take(arg) !== TARGET.caseReference) throw refuse('target_not_allowed'); }
    else throw refuse('unknown_argument');
  }
  if (out.execute && !out.expectStage) throw refuse('expect_stage_required'); // the exact stage id must be stated by a person, never inferred from a name
  return out;
}

// What a pinned client may do: return the one verified Deal for the one Deal id, nothing else.
function pinnedApi(deal) {
  const snapshot = Object.freeze(JSON.parse(JSON.stringify(deal))); // an immutable copy: nothing later can change what was verified
  return {
    getDeal: async (dealId) => (String(dealId) === TARGET.dealId ? { status: 'ok', deal: JSON.parse(JSON.stringify(snapshot)) } : { status: 'uncertain', reason: 'out_of_scope' }),
  };
}

// The inbox store restricted to this Deal. Nothing else is claimed and no lease of any other row is touched.
function scopedStore(baseStore) {
  return {
    ...baseStore,
    findDueIds: async (db, limit) => {
      const mine = new Set((await db.integrationInbox.findMany({ where: { source: SOURCE, entityId: TARGET.dealId, status: 'received' }, select: { id: true } })).map((r) => Number(r.id)));
      const due = await baseStore.findDueIds(db, 1000);
      return due.filter((id) => mine.has(id)).slice(0, limit);
    },
    recoverExpiredLeases: async () => ({ failed: 0, again: 0 }),
  };
}

// Everything that must NOT change: every inbox row that is not this Deal's, and every deal link that is not this Deal's.
async function snapshotOthers(prisma) {
  const inbox = await prisma.integrationInbox.findMany({
    where: { OR: [{ entityId: null }, { entityId: { not: TARGET.dealId } }] }, select: { id: true, status: true, attempts: true, lockedBy: true, lockedUntil: true, nextAttemptAt: true, lastError: true }, orderBy: { id: 'asc' },
  });
  const links = await prisma.bitrixDealLink.findMany({
    where: { OR: [{ bitrixDealId: null }, { bitrixDealId: { not: TARGET.dealId } }] }, select: { id: true, stageId: true, externalModifiedAt: true, lastAttemptAt: true, syncStatus: true }, orderBy: { id: 'asc' },
  });
  const text = JSON.stringify({ inbox, links });
  return { inbox: inbox.length, links: links.length, digest: crypto.createHash('sha256').update(text).digest('hex') };
}

// Read-only: the link, the Case and the live Deal, all verified. Returns the facts; throws SingleDealRefused on any mismatch.
async function inspect({ prisma, api, env }) {
  const link = await prisma.bitrixDealLink.findUnique({ where: { bitrixDealId: TARGET.dealId }, include: { case: { include: { serviceRequest: true } } } });
  if (!link) throw refuse('deal_not_linked');
  if (link.caseId !== TARGET.caseId) throw refuse('link_case_mismatch');
  const caseRecord = link.case;
  if (!caseRecord || caseRecord.referenceNumber !== TARGET.caseReference) throw refuse('case_reference_mismatch');
  if (String(link.categoryId) !== TARGET.categoryId) throw refuse('link_category_mismatch');
  if (!caseRecord.serviceRequest || caseRecord.serviceRequest.serviceKey !== PRIVATE_CHARTER_KEY) throw refuse('case_not_private_charter');
  if (CLOSED.has(caseRecord.status)) throw refuse('case_closed');

  const read = await api.getDeal(TARGET.dealId, { env });
  if (read.status === 'not_found') throw refuse('deal_not_found_in_bitrix');
  if (read.status !== 'ok') throw refuse(`bitrix_read_failed_${read.reason || read.status}`);
  const deal = read.deal;
  if (String(deal.ID) !== TARGET.dealId) throw refuse('deal_id_mismatch');
  if (String(deal.CATEGORY_ID) !== String(DEAL.CATEGORY_ID) || String(DEAL.CATEGORY_ID) !== TARGET.categoryId) throw refuse('deal_category_mismatch');
  if (deal[FIELD.REFERENCE] !== TARGET.caseReference) throw refuse('deal_reference_mismatch');
  const modified = new Date(deal.DATE_MODIFY);
  if (typeof deal.DATE_MODIFY !== 'string' || Number.isNaN(modified.getTime())) throw refuse('deal_modified_time_invalid');
  const stage = lookupStage(deal.STAGE_ID, deal);
  return { link, caseRecord, deal, modified, stage };
}

const describeFacts = ({ link, caseRecord, deal, modified, stage }) => ({
  case: { id: caseRecord.id, reference: caseRecord.referenceNumber, status: caseRecord.status, charterStage: caseRecord.charterStage ?? null, stageVersion: Number(caseRecord.stageVersion) },
  link: { stageId: link.stageId ?? null, externalModifiedAt: link.externalModifiedAt ? new Date(link.externalModifiedAt).toISOString() : null },
  deal: { id: String(deal.ID), categoryId: String(deal.CATEGORY_ID), stageId: deal.STAGE_ID, modifiedAt: modified.toISOString() },
  mapping: stage.ok
    ? { approved: true, charterStage: stage.entry.key, caseStatus: stage.entry.status, patientVisible: stage.entry.patientVisible === true }
    : { approved: false, quarantineCode: stage.code },
});

/**
 * Dry run unless options.execute. `deps`: { prisma, api, env, log, store, reconcile, runInbox } (the last three default to the real ones). Without --no-push the inbox queues push deliveries the normal way; with it, it gets suppressedEnqueuePush and queues none.
 * Resolves { executed, facts, ... }. Throws SingleDealRefused. Nothing is written unless it returns executed: true.
 */
async function runSingleDeal(options, deps) {
  const { prisma, api, env, log = console } = deps;
  const found = await inspect({ prisma, api, env });
  const facts = describeFacts(found);
  if (!options.execute) return { executed: false, facts };

  if (!found.stage.ok) throw refuse(`stage_not_approved_${found.stage.code}`);
  if (options.expectStage !== found.deal.STAGE_ID) throw refuse('expect_stage_mismatch'); // the live stage id is not the one the operator confirmed
  const unchanged = found.link.stageId === found.deal.STAGE_ID && found.link.externalModifiedAt && found.modified.getTime() <= new Date(found.link.externalModifiedAt).getTime();
  if (unchanged) return { executed: false, facts, nothingToApply: true };

  const reconcile = deps.reconcile || require('../../src/modules/bitrix/deal-reconcile.service').reconcileDeals;
  const runInbox = deps.runInbox || require('../../src/modules/bitrix/deal-inbox.service').runInboxWorker;
  const baseStore = deps.store || require('../../src/modules/bitrix/deal-inbox.store');
  const pinned = pinnedApi(found.deal);

  const before = await snapshotOthers(prisma);
  const reconciled = await reconcile({ prisma, api: pinned, env, log, scope: { dealId: TARGET.dealId, ignoreRecheck: true } });
  const processed = await runInbox({ prisma, api: pinned, env, log, store: scopedStore(baseStore), ...(options.push ? {} : { enqueuePush: suppressedEnqueuePush }) });
  const after = await snapshotOthers(prisma);
  const othersUnchanged = before.digest === after.digest && before.inbox === after.inbox && before.links === after.links;
  return { executed: true, facts, reconciled, processed, othersUnchanged, others: { inbox: after.inbox, links: after.links } };
}

module.exports = { TARGET, parseArgs, runSingleDeal, inspect, describeFacts, pinnedApi, scopedStore, snapshotOthers, SingleDealRefused, STAGE_ID_PATTERN };
