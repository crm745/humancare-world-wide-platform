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
const { leadInputFromRequest, leadInputFromCase } = require('./bitrix-lead');
const { isBitrixSyncEnabled } = require('./bitrix-config');

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

// `label` is just for log lines; `model` is the Prisma delegate (prisma.serviceRequest
// or prisma.case) so the same retry/backoff/alert logic isn't duplicated per source.
// The newest uploaded medical report, if any: it was uploaded while the lead didn't exist
// yet, so it goes across once the lead is made.
const LATEST_REPORT = { where: { type: 'Medical Report' }, orderBy: { uploadedAt: 'desc' }, take: 1 };

async function retryModel(model, label, findCandidates, buildLeadInput, latestReport) {
  const candidates = await findCandidates();
  for (const record of candidates) {
    try {
      const leadId = await createLead(buildLeadInput(record));
      await model.update({
        where: { id: record.id },
        data: { bitrixLeadId: leadId, bitrixLastError: null, bitrixSyncFailedAt: null },
      });
      console.log(`Bitrix24 retry succeeded for ${label} ${record.referenceNumber} (attempt ${record.bitrixSyncAttempts + 1}).`);
      const report = latestReport(record);
      if (report) await sendMedicalReportToBitrix(leadId, report);
    } catch (err) {
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
    () => prisma.serviceRequest.findMany({ where: pendingWhere(), include: { user: true, case: { include: { documents: LATEST_REPORT } } } }),
    (request) => leadInputFromRequest(request, request.user),
    (request) => request.case?.documents[0],
  );

  const casesRetried = await retryModel(
    prisma.case,
    'case',
    () => prisma.case.findMany({ where: pendingWhere(), include: { documents: LATEST_REPORT } }),
    (caseRecord) => leadInputFromCase(caseRecord),
    (caseRecord) => caseRecord.documents[0],
  );

  return requestsRetried + casesRetried;
}

module.exports = { retryFailedBitrixSyncs, MAX_ATTEMPTS, RETRY_BACKOFF_MINUTES };
