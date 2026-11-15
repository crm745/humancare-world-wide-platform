// Failure alerting for the Private Charter Deal worker. The notification system (notifications.service.js) only
// has "patient" and "corporate_user" recipients, so there is no operations/admin recipient to use; rather than
// invent one, an alert is (1) an append-only AuditLog row, which is unique per event and so is written exactly
// once, and (2) one "[ALERT]" log line written at that moment. Operations find them by action:
//   bitrix.deal.failed                  a permanently failed Deal event
//   bitrix.deal.manual_review_required  an AMBIGUOUS event reconciliation could not settle (a person must decide)
// An ordinary ambiguous event that is still being reconciled is NOT alerted: it is not a failure.
//
// What an alert holds: the event id, the Case id and Case reference, the status and a short reason code. Never
// patient details, phone numbers, documents, Bitrix responses, URLs or tokens. The original event row (status,
// last_error, external_call_started_at) is never touched.
const { appendAuditLog } = require('../../common/audit/business-audit');
const { MANUAL_REVIEW_PREFIX } = require('./deal-outbox.store');
const { DEAL_CREATE_EVENT } = require('./deal-outbox');

const ACTION_FAILED = 'bitrix.deal.failed';
const ACTION_REVIEW = 'bitrix.deal.manual_review_required';
const MAX_PER_PASS = 100;

const codePart = (text) => String(text).toLowerCase().replace(/[^a-z0-9_.:-]/g, '_');

// last_error -> { category, code }. The code is a short, lowercase reason code that fits the audit writer.
// Categories: mapping (the Case data could not be turned into a Deal; nothing was sent), eligibility,
// bitrix (Bitrix definitively refused the call), lease (recovery gave up before any call), review (reconciliation
// could not settle an ambiguous outcome), unknown.
function classifyFailure(lastError) {
  const text = typeof lastError === 'string' ? lastError : '';
  let category = 'unknown';
  let detail = 'unclassified';
  if (text.startsWith('mapping:')) { category = 'mapping'; detail = text.slice('mapping:'.length); }
  else if (text.startsWith('not_eligible')) { category = 'eligibility'; detail = 'not_eligible'; }
  else if (text === 'deal_link_missing') { category = 'eligibility'; detail = 'deal_link_missing'; }
  else if (text.startsWith('lease_expired')) { category = 'lease'; detail = text; }
  else if (text.startsWith('Bitrix24 Deal call:')) {
    category = 'bitrix';
    detail = (text.slice('Bitrix24 Deal call:'.length).trim().split(/[\s(]/)[0]) || 'refused';
  } else if (text.startsWith(`${MANUAL_REVIEW_PREFIX}:`)) { category = 'review'; detail = text.slice(MANUAL_REVIEW_PREFIX.length + 1); }
  return { category, code: codePart(`${category}:${detail}`).slice(0, 64) };
}

// Writes the alert for every failed / manual-review Deal event that has none yet. `prisma` is the client.
// Safe to call on every worker pass: the audit row's unique key makes a second write impossible, and a
// duplicate-key error (another pass won the race) is silently ignored, so an alert is never repeated.
async function reportDealFailures({ prisma, log = console }) {
  const events = await prisma.integrationOutbox.findMany({
    where: { eventType: DEAL_CREATE_EVENT, OR: [{ status: 'failed' }, { status: 'ambiguous', lastError: { startsWith: MANUAL_REVIEW_PREFIX } }] },
    select: { id: true, caseId: true, status: true, lastError: true },
    orderBy: { id: 'desc' },
    take: MAX_PER_PASS,
  });
  if (!events.length) return 0;

  const actionOf = (event) => (event.status === 'failed' ? ACTION_FAILED : ACTION_REVIEW);
  const existing = await prisma.auditLog.findMany({
    where: { entityType: 'integration_outbox', action: { in: [ACTION_FAILED, ACTION_REVIEW] }, entityId: { in: events.map((e) => String(e.id)) } },
    select: { entityId: true, action: true },
  });
  const done = new Set(existing.map((row) => `${row.action}:${row.entityId}`));
  const pending = events.filter((event) => event.caseId != null && !done.has(`${actionOf(event)}:${event.id}`));
  if (!pending.length) return 0;

  const cases = await prisma.case.findMany({ where: { id: { in: [...new Set(pending.map((e) => e.caseId))] } }, select: { id: true, referenceNumber: true } });
  const referenceOf = new Map(cases.map((c) => [c.id, c.referenceNumber]));

  let written = 0;
  for (const event of pending) {
    const action = actionOf(event);
    const { category, code } = classifyFailure(event.lastError);
    try {
      await appendAuditLog(prisma, {
        caseId: event.caseId, entityType: 'integration_outbox', entityId: event.id, action,
        actorType: 'system', source: 'system', reasonCode: code,
        afterData: { eventId: event.id, caseId: event.caseId, caseReference: referenceOf.get(event.caseId) ?? null, status: event.status },
        correlationId: `outbox:${event.id}`, idempotencyKey: `${action}:event:${event.id}`,
      });
    } catch (err) {
      if (err && err.code === 'P2002') continue; // already reported by another pass
      throw err;
    }
    written += 1;
    // The single "stand-in alert" line. Ids, reference and code only.
    log.error(`[ALERT] Bitrix24 Deal event ${event.id} for case ${event.caseId} (${referenceOf.get(event.caseId) ?? 'reference unknown'}): ${action} [${category}] ${code}`);
  }
  return written;
}

module.exports = { reportDealFailures, classifyFailure, ACTION_FAILED, ACTION_REVIEW };
