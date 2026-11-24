// Recovers leads that failed to sync to Bitrix24 on first submission — both the
// patient app's flow (requests.service.js#createRequest) and the corporate-portal's
// (cases.service.js#createCaseByCorporate) persist a failure the same way, so this
// sweeps both instead of just logging to a console nobody watches.
//
// No job queue (BullMQ/Redis) is set up in this project yet, so this runs as a
// plain interval inside the API process instead (see server.js) — good enough at
// this scale, and avoids adding infrastructure nobody asked for.
const { prisma } = require('../../db/prisma');
const { createLead, sendMedicalReportToBitrix } = require('./bitrix.service');
const { leadInputFromRequest, leadInputFromCase, commentWithReports } = require('./bitrix-lead');
const { isBitrixSyncEnabled, isPrivateCharterDealRequested } = require('./bitrix-config');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');

const MAX_ATTEMPTS = 5;
// ~5 attempts spaced this far apart covers roughly the "30 minutes" window the
// original audit recommended, without hammering Bitrix24 every tick.
const RETRY_BACKOFF_MINUTES = 6;

// Built on every sweep, never once at load: the backoff cutoff is "now minus the backoff"
// at the time of the sweep. A cutoff worked out when the server started would never move,
// so a lead that failed after startup would not be picked up until the next restart.
const pendingWhere = (now = Date.now()) => ({
  bitrixLeadId: null,
  bitrixSyncAttempts: { gt: 0, lt: MAX_ATTEMPTS },
  bitrixSyncFailedAt: { lt: new Date(now - RETRY_BACKOFF_MINUTES * 60 * 1000) },
});

// Once Private Charter Deal integration is switched on, Private Charter never gets a Lead from the sweeps. The filter
// names the service explicitly, and handles a NULL service key itself: Prisma's `not` becomes `<>`, which never
// matches NULL, so an older request without a service key would silently drop out of the sweep without the first branch.
const NOT_PRIVATE_CHARTER = { OR: [{ serviceKey: null }, { serviceKey: { not: PRIVATE_CHARTER_KEY } }] };

// Requests: skip Private Charter ones when the Deal switch is on; otherwise exactly the original filter.
const requestSweepWhere = (now) => {
  const where = pendingWhere(now);
  return isPrivateCharterDealRequested() ? { ...where, ...NOT_PRIVATE_CHARTER } : where;
};

// Cases: Corporate Cases (no service request) always stay in; a Case whose service request is Private Charter
// is skipped when the Deal switch is on; Cases of every other service stay in.
const caseSweepWhere = (now) => {
  const where = pendingWhere(now);
  if (!isPrivateCharterDealRequested()) return where;
  return { ...where, OR: [{ serviceRequestId: null }, { serviceRequest: { is: NOT_PRIVATE_CHARTER } }] };
};

// `label` is just for log lines; `model` is the Prisma delegate (prisma.serviceRequest
// or prisma.case) so the same retry/backoff/alert logic isn't duplicated per source.
// Every uploaded medical report, oldest first: they were uploaded while the lead didn't exist
// yet, so they go across once the lead is made. (A single-file Medical Report field in Bitrix
// keeps the last one; the lead comment lists them all.)
const ALL_REPORTS = { where: { type: 'Medical Report' }, orderBy: { uploadedAt: 'asc' } };

async function retryModel(model, label, findCandidates, buildLeadInput, reportsOf) {
  const candidates = await findCandidates();
  for (const record of candidates) {
    try {
      const input = buildLeadInput(record);
      const leadId = await createLead(input);
      await model.update({
        where: { id: record.id },
        data: { bitrixLeadId: leadId, bitrixLastError: null, bitrixSyncFailedAt: null },
      });
      console.log(`Bitrix24 retry succeeded for ${label} ${record.referenceNumber} (attempt ${record.bitrixSyncAttempts + 1}).`);
      const reports = reportsOf(record);
      const comments = commentWithReports(input.comments, reports.map((report) => report.name));
      for (const report of reports) await sendMedicalReportToBitrix(leadId, report, { comments });
    } catch (err) {
      // The shared Bitrix24 gateway (circuit open / rate limit) refused the call: nothing was sent, so this is not a failed attempt. Try again next run.
      if (err && err.deferred) { console.warn(`Bitrix24 retry for ${label} ${record.referenceNumber} deferred by the shared gateway.`); continue; }
      const attempts = record.bitrixSyncAttempts + 1;
      await model.update({
        where: { id: record.id },
        data: { bitrixSyncAttempts: attempts, bitrixLastError: err.message, bitrixSyncFailedAt: new Date() },
      });
      if (attempts >= MAX_ATTEMPTS) {
        // Stand-in for a Slack/email alert — no alerting channel is wired up yet,
        // so this is the one place ops would currently see a permanently-dropped lead.
        console.error(`[ALERT] Bitrix24 lead creation permanently failed for ${label} ${record.referenceNumber} after ${attempts} attempts: ${err.message}`);
      } else {
        console.error(`Bitrix24 retry ${attempts}/${MAX_ATTEMPTS} failed for ${label} ${record.referenceNumber}: ${err.message}`);
      }
    }
  }
  return candidates.length;
}

async function retryFailedBitrixSyncs() {
  if (!isBitrixSyncEnabled()) return 0;
  const requestsRetried = await retryModel(
    prisma.serviceRequest,
    'request',
    () => prisma.serviceRequest.findMany({ where: requestSweepWhere(), include: { user: true, case: { include: { documents: ALL_REPORTS } } } }),
    (request) => leadInputFromRequest(request, request.user),
    (request) => request.case?.documents ?? [],
  );

  const casesRetried = await retryModel(
    prisma.case,
    'case',
    () => prisma.case.findMany({ where: caseSweepWhere(), include: { documents: ALL_REPORTS } }),
    (caseRecord) => leadInputFromCase(caseRecord),
    (caseRecord) => caseRecord.documents,
  );

  return requestsRetried + casesRetried;
}

module.exports = { retryFailedBitrixSyncs, MAX_ATTEMPTS, RETRY_BACKOFF_MINUTES };
