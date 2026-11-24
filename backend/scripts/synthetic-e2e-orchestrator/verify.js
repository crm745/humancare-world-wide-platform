// Read-only, post-hoc, AUTHORITATIVE verification. Every check here queries rows the live backend
// process itself wrote — it never trusts this script's own configuration or assumptions. This module
// never writes to the database.
const { assertNotProtected } = require('./safety');

// { ok: boolean, checks: [{ name, ok, detail }] } — never throws; callers decide how to react.
async function verifyOutcome(prisma, { requestId, runId, isolationCheck }) {
  assertNotProtected(requestId);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const request = await prisma.serviceRequest.findUnique({ where: { id: Number(requestId) } });
  add('request_approved', !!request && request.reviewStatus === 'approved', request ? request.reviewStatus : 'not_found');

  const caseRow = request ? await prisma.case.findUnique({ where: { serviceRequestId: request.id } }) : null;
  add('case_created', !!caseRow, caseRow ? caseRow.referenceNumber : null);

  const events = await prisma.requestEvent.findMany({ where: { serviceRequestId: Number(requestId) }, orderBy: { id: 'asc' }, select: { action: true, occurredAt: true } });
  const actions = events.map((e) => e.action);
  add('document_approved_event', actions.includes('synthetic_e2e_document_approved'), null);
  add('case_created_event', actions.includes('case_created'), null);
  add('request_approved_event', actions.includes('request_approved'), null);
  add('marker_consumed_event', actions.includes('synthetic_e2e_consumed'), null);

  let dealLink = null;
  let outboxRows = [];
  if (caseRow) {
    dealLink = await prisma.bitrixDealLink.findUnique({ where: { caseId: caseRow.id } });
    outboxRows = await prisma.integrationOutbox.findMany({ where: { caseId: caseRow.id } });
  }
  // Authoritative Bitrix-profile check: the live API process must have been configured with
  // BITRIX_DEAL_PROFILE=actual at the moment it created this Deal link, per your explicit instruction
  // to treat anything else as a verification FAILURE (the orchestrator now sets it in the spawned processes' environment only).
  add('bitrix_profile_actual', !!dealLink && dealLink.profile === 'actual', dealLink ? dealLink.profile : null);

  // Outbox snapshot EVIDENCE (not a boundary): proves nothing ever attempted to claim/send it.
  const outboxUntouched = outboxRows.length > 0 && outboxRows.every((o) => o.status === 'pending' && o.attempts === 0 && o.externalCallStartedAt == null && o.lockedUntil == null);
  add('outbox_evidence_no_send_attempted', outboxUntouched, outboxRows.map((o) => ({ id: o.id, status: o.status, attempts: o.attempts })));

  // Final network-isolation re-verification, evaluated by the orchestrator right now (not merely "was fine at the gate"):
  // the egress guards recorded no violation, both isolated processes are still running, and the browser proxy was never
  // asked for a Bitrix destination.
  if (typeof isolationCheck === 'function') {
    const result = isolationCheck();
    add('egress_isolation_held', result.ok, result.problems);
  } else {
    add('egress_isolation_held', false, 'no isolation check was supplied to verification');
  }

  return { ok: checks.every((c) => c.ok), checks, runId, requestId: Number(requestId), caseId: caseRow ? caseRow.id : null, caseReference: caseRow ? caseRow.referenceNumber : null };
}

module.exports = { verifyOutcome };
