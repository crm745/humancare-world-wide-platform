// ONE-TIME runner for the quotation SYNC stage: runs the existing runQuotationSync() (the function the "bitrix-quotation" job schedules) ONCE, for the Cases
// named with --case-id, then exits. It is not src/worker.js and never requires src/jobs/index.js or any job file: nothing else can start in this process.
// All sync rules (read-only Bitrix, versioning, storage, retries, audit) live in modules/bitrix/quotation-sync.service.js, unchanged. See
// common/safety/single-stage-runner.js for the modes and the database rules.
//
//   node src/quotation-sync-worker.js                              readiness only (default)
//   node src/quotation-sync-worker.js --readiness-only --case-id 206
//   node src/quotation-sync-worker.js --once --case-id 206         ONE pass, limited to these Cases
// WRITES (when run with --once): case_quotations drafts, outbox results and audit rows in humancare_dev, and the downloaded PDF into the quotation storage.
// Bitrix24 is only READ.
const { main } = require('./common/safety/single-stage-runner');

function loadStage() {
  const bitrixConfig = require('./modules/bitrix/bitrix-config');
  const { resolveProfile } = require('./modules/bitrix/bitrix-profiles');
  const { quotationFieldsForProfile } = require('./modules/bitrix/quotation-outbox');
  const { runQuotationSync } = require('./modules/bitrix/quotation-sync.service');
  return {
    label: 'quotation-sync',
    configProblems(env) {
      try { bitrixConfig.assertBitrixConfiguration(env); } catch { return ['bitrix_configuration_invalid']; }
      if (!bitrixConfig.isQuotationSyncActive(env)) return ['quotation_sync_inactive'];
      const profile = resolveProfile(env);
      if (!profile) return ['profile_not_configured'];
      if (!quotationFieldsForProfile(profile)) return ['quotation_fields_not_configured'];
      const host = bitrixConfig.bitrixHostProblem(env);
      return host ? [host] : [];
    },
    async describe(prisma, env, caseIds) {
      const pendingEvents = await prisma.integrationOutbox.count({ where: { eventType: 'bitrix.quotation.sync', entityType: 'bitrix_deal_quotation', status: 'pending', caseId: { in: caseIds } } });
      return { profile: resolveProfile(env).name, caseIds, pendingEvents };
    },
    execute: (caseIds) => runQuotationSync({ scope: { caseIds } }),
  };
}

module.exports = { loadStage };
if (require.main === module) main(loadStage).then((code) => { process.exitCode = code; });
