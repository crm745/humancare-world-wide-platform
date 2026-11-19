// Safety net for missed Bitrix24 webhook deliveries (M6: "a periodic reconciliation sweep is REQUIRED"). Deliberately
// small and slow. It never changes a Case itself: when a linked Deal's current state differs from what HumanCare last
// applied, it stores ONE inbox event and the normal inbound processor (deal-inbox.service.js) does the rest, with all
// of its checks (exact Deal ID, Category 38, exact Case reference, approved stage, stale/duplicate/closed-Case rules,
// transaction, audit, notification). So reconciliation inherits quarantine, idempotency and the terminal Completed /
// Cancelled rule instead of repeating them.
//
// WHAT IT LOOKS AT: only BitrixDealLink rows that already have a Deal ID, whose Case is an open Private Charter Case in
// the review workflow without a Lead. Not other pipelines, not Corporate Cases, not completed or cancelled Cases, and
// nothing historical: a Deal that was never linked by HumanCare is never touched. It creates no Case, Deal or Lead.
//
// HOW MUCH: every INTERVAL (10 min, see the job) at most BATCH_SIZE (10) links, oldest check first, none checked in the
// last MIN_RECHECK_MINUTES (15), one crm.deal.get each, sequential, and the pass stops after MAX_CONSECUTIVE_FAILURES (3)
// failed reads in a row (Bitrix unreachable). So at most 10 reads per pass and no loop.
//
// NO DUPLICATE EVENTS: nothing is stored when the Deal still has the stage and modified time HumanCare last applied.
// A changed Deal produces one inbox row whose identity is (Deal, stage, Bitrix modified time), so repeated passes (and a
// webhook that arrives for the same change) collapse to one processed transition.
//
// The "last checked" marker is BitrixDealLink.last_attempt_at (no schema change), updated for every link looked at,
// so one failing Deal cannot starve the others.
//
// SCOPE (test tooling only; the scheduled job never passes it): `scope = { dealId, ignoreRecheck? }` narrows the pass to the ONE link with that
// Deal id (one read at most). Every other rule above still applies unchanged. `ignoreRecheck` skips only the 15-minute "recently checked" window,
// because an operator asked for exactly this Deal.
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { isPrivateCharterDealWorkerActive } = require('./bitrix-config');
const { assertDealEligible } = require('./deal-outbox');
const { DEAL, FIELD } = require('./bitrix-deal');
const bitrixDealApi = require('./bitrix-deal.api');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');

const BATCH_SIZE = 10;
const MIN_RECHECK_MINUTES = 15;
const MAX_CONSECUTIVE_FAILURES = 3;
const SOURCE = 'bitrix24';
const OPEN_ONLY = ['completed', 'cancelled'];

const identityOf = (dealId, stageId, modifiedIso) => crypto.createHash('sha256').update(`${SOURCE}|RECONCILE|${dealId}|${stageId}|${modifiedIso}`).digest('hex');

async function reconcileDeals(overrides = {}) {
  const ctx = { prisma: defaultPrisma, api: bitrixDealApi, env: process.env, log: console, now: () => Date.now(), ...overrides };
  if (!isPrivateCharterDealWorkerActive(ctx.env)) return { active: false, checked: 0, queued: 0 };

  const scope = ctx.scope || null;
  if (scope && !/^[1-9]\d{0,17}$/.test(String(scope.dealId))) return { active: true, checked: 0, queued: 0 }; // a malformed scope matches nothing
  const cutoff = new Date(ctx.now() - MIN_RECHECK_MINUTES * 60 * 1000);
  const links = await ctx.prisma.bitrixDealLink.findMany({
    where: {
      bitrixDealId: scope ? String(scope.dealId) : { not: null },
      ...(scope && scope.ignoreRecheck ? {} : { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: cutoff } }] }),
      case: { is: { status: { notIn: OPEN_ONLY }, serviceRequest: { is: { serviceKey: PRIVATE_CHARTER_KEY, reviewStatus: { not: null }, bitrixLeadId: null } } } },
    },
    include: { case: { include: { serviceRequest: true } } },
    orderBy: { lastAttemptAt: 'asc' },
    take: scope ? 1 : BATCH_SIZE,
  });

  let checked = 0; let queued = 0; let failures = 0;
  for (const link of links) {
    if (failures >= MAX_CONSECUTIVE_FAILURES) break;
    checked += 1;
    // Marked first: whatever happens below, this link is not looked at again for MIN_RECHECK_MINUTES.
    await ctx.prisma.bitrixDealLink.update({ where: { id: link.id }, data: { lastAttemptAt: new Date(ctx.now()) } });

    const caseRecord = link.case;
    try { assertDealEligible(caseRecord, caseRecord && caseRecord.serviceRequest); } catch { continue; }

    const read = await ctx.api.getDeal(link.bitrixDealId, { env: ctx.env });
    if (read.status !== 'ok') {
      failures += read.status === 'uncertain' ? 1 : 0;
      ctx.log.warn(`[deal-reconcile] deal ${link.bitrixDealId}: ${read.status}${read.reason ? ` (${read.reason})` : ''}`);
      continue;
    }
    failures = 0;
    const deal = read.deal;
    // Only a Deal that is verifiably THIS Case's Deal is considered; anything else is left alone here (the inbound
    // processor quarantines such a mismatch if a webhook ever reports it).
    const verified = String(deal.ID) === link.bitrixDealId && String(deal.CATEGORY_ID) === String(DEAL.CATEGORY_ID) && deal[FIELD.REFERENCE] === caseRecord.referenceNumber;
    const modified = new Date(deal.DATE_MODIFY);
    if (!verified || typeof deal.DATE_MODIFY !== 'string' || Number.isNaN(modified.getTime())) {
      ctx.log.warn(`[deal-reconcile] deal ${link.bitrixDealId}: not verifiable, skipped`);
      continue;
    }
    const unchanged = link.stageId === deal.STAGE_ID && link.externalModifiedAt && modified.getTime() <= new Date(link.externalModifiedAt).getTime();
    if (unchanged) continue;

    try {
      await ctx.prisma.integrationInbox.create({
        data: {
          source: SOURCE, externalEventId: identityOf(link.bitrixDealId, deal.STAGE_ID, modified.toISOString()), eventType: 'ONCRMDEALUPDATE',
          entityType: 'deal', entityId: link.bitrixDealId, externalOccurredAt: modified,
          payload: { event: 'RECONCILE', dealId: link.bitrixDealId, ts: modified.toISOString() },
          status: 'received', nextAttemptAt: new Date(0),
        },
      });
      queued += 1;
    } catch (err) {
      if (!(err && err.code === 'P2002')) throw err; // already queued or processed for this exact state
    }
  }
  return { active: true, checked, queued };
}

module.exports = { reconcileDeals, BATCH_SIZE, MIN_RECHECK_MINUTES, MAX_CONSECUTIVE_FAILURES, identityOf };
