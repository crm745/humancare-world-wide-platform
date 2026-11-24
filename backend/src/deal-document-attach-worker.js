// ONE-TIME runner for the document ATTACHMENT stage of ONE Case: it makes the automatic sharing catch up for that Case's request (the sweep of
// modules/bitrix/deal-document-auto-share.js, narrowed to the request) and then runs ONE scoped pass of the existing document worker (runDealDocumentWorker with
// scope { caseIds }), which attaches the authorized files to the Bitrix24 Deal and exits. It is not src/worker.js and never requires src/jobs/index.js or any job file.
// All sharing and attachment rules (clean scan, not rejected, locks, uniqueness, retries, read-back reconciliation, preservation of files already on the Deal) live in
// the existing services, unchanged. See common/safety/single-stage-runner.js for the modes and the database rules.
//
//   node src/deal-document-attach-worker.js                             readiness only (default)
//   node src/deal-document-attach-worker.js --readiness-only --case-id 208
//   node src/deal-document-attach-worker.js --once --case-id 208        ONE pass, limited to this Case
// Needs (process environment only): BITRIX_DEAL_PROFILE=actual, BITRIX_SYNC_ENABLED, BITRIX_PRIVATE_CHARTER_DEAL_ENABLED and PRIVATE_CHARTER_REVIEW_WORKFLOW "true",
// DOCUMENT_AUTO_SHARE=true and DOCUMENT_AUTO_SHARE_ADMIN_ID=<an active Admin of role "admin">. Refuses in production.
// WRITES (--once): the shares, their attach events, request events and audit rows in humancare_dev (system / document_auto_share), then the Deal's multiple-file field
// in Bitrix24 (the existing files are read first and kept; the field UF_CRM_1795447841). The old single-file field is never touched.
const { main } = require('./common/safety/single-stage-runner');

function loadStage() {
  const bitrixConfig = require('./modules/bitrix/bitrix-config');
  const { resolveProfile } = require('./modules/bitrix/bitrix-profiles');
  const autoShare = require('./modules/bitrix/deal-document-auto-share');
  const { runDealDocumentWorker } = require('./modules/bitrix/deal-document-worker.service');

  const requestIdsOf = async (prisma, caseIds) => (await prisma.case.findMany({ where: { id: { in: caseIds } }, select: { serviceRequestId: true } })).map((c) => c.serviceRequestId);
  return {
    label: 'deal-document-attach',
    configProblems(env) {
      try { bitrixConfig.assertBitrixConfiguration(env); } catch { return ['bitrix_configuration_invalid']; }
      if (!bitrixConfig.isPrivateCharterDealWorkerActive(env)) return ['bitrix_switches_not_active'];
      const profile = resolveProfile(env);
      if (!profile || profile.name !== 'actual') return ['profile_not_actual'];
      const { problem } = autoShare.readSettings(env);
      return problem ? [problem] : [];
    },
    async liveProblems(prisma, env) {
      const { settings } = autoShare.readSettings(env);
      const problem = await autoShare.adminProblem({ prisma, now: () => new Date() }, settings.adminId);
      return problem ? [problem] : [];
    },
    async describe(prisma, env, caseIds) {
      const requestIds = await requestIdsOf(prisma, caseIds);
      const eligibleWithoutShare = await prisma.requestDocument.count({
        where: { serviceRequestId: { in: requestIds }, scanStatus: 'clean', supersededAt: null, reviewStatus: { not: 'rejected' }, dealShares: { none: {} } },
      });
      const shares = await prisma.bitrixDealDocument.count({ where: { dealLink: { caseId: { in: caseIds } } } });
      const pendingAttach = await prisma.integrationOutbox.count({ where: { caseId: { in: caseIds }, eventType: 'bitrix.deal.document.attach', status: 'pending' } });
      return { caseIds, eligibleWithoutShare, shares, pendingAttach };
    },
    async execute(caseIds, { prisma }) {
      const swept = await autoShare.sweep({ prisma, requestIds: await requestIdsOf(prisma, caseIds) });
      const worker = await runDealDocumentWorker({ scope: { caseIds } });
      return { shared: (swept.results || []).filter((r) => r.outcome === 'shared').length, sweep: swept.outcome, claimed: worker.claimed, active: worker.active };
    },
  };
}

module.exports = { loadStage };
if (require.main === module) main(loadStage).then((code) => { process.exitCode = code; });
