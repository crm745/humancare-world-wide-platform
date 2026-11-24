// ONE-TIME runner for the quotation AUTO-PUBLISH stage: runs the existing sweepQuotationAutoPublish() (the function the "quotation-auto-publish" job schedules)
// ONCE, for the Cases named with --case-id, then exits. It is not src/worker.js and never requires src/jobs/index.js or any job file. Every rule (the designated
// Admin, the clean scan, the 120-second settle, the Bitrix stage "Quoted", accepted quotations and invoices, the existing confirm and publish) lives in
// modules/quotations/quotation-auto-publish.service.js, unchanged. No invoice or payment can result.
//
//   node src/quotation-auto-publish-worker.js                              readiness only (default)
//   node src/quotation-auto-publish-worker.js --readiness-only --case-id 206
//   node src/quotation-auto-publish-worker.js --once --case-id 206         ONE pass, limited to these Cases
// WRITES (when run with --once): the quotation's confirmation and publication, their audit rows and the patient's notification in humancare_dev, plus the Expo
// push. Bitrix24 is only READ (one crm.deal.get per candidate).
const { main } = require('./common/safety/single-stage-runner');

function loadStage() {
  const config = require('./modules/quotations/quotation-auto-publish.config');
  const service = require('./modules/quotations/quotation-auto-publish.service');
  return {
    label: 'quotation-auto-publish',
    configProblems(env) { const { problem } = config.readSettings(env); return problem ? [problem] : []; },
    async liveProblems(prisma, env) {
      const { settings } = config.readSettings(env);
      const problem = await service.adminProblem({ prisma, now: () => new Date() }, settings.adminId);
      return problem ? [problem] : [];
    },
    async describe(prisma, env, caseIds) {
      const { settings } = config.readSettings(env);
      const cleanWorkingVersions = await prisma.caseQuotation.count({ where: { caseId: { in: caseIds }, status: { in: ['draft', 'confirmed'] }, scanStatus: 'clean' } });
      return { caseIds, adminId: settings.adminId, settleSeconds: settings.settleSeconds, stage: config.REQUIRED_STAGE_ID, cleanWorkingVersions };
    },
    execute: (caseIds) => service.sweepQuotationAutoPublish({ caseIds }),
  };
}

module.exports = { loadStage };
if (require.main === module) main(loadStage).then((code) => { process.exitCode = code; });
