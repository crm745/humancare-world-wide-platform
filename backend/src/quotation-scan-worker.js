// ONE-TIME runner for the quotation SCAN stage: runs the existing sweepPendingQuotationScans() (the function the "scan-case-quotations" job schedules) ONCE,
// for the Cases named with --case-id, then exits. It is not src/worker.js and never requires src/jobs/index.js or any job file. All scan rules (ClamAV,
// checksum binding, retries with backoff, quarantine, audit) live in modules/bitrix/quotation-scan.service.js, unchanged.
//
//   node src/quotation-scan-worker.js                              readiness only (default)
//   node src/quotation-scan-worker.js --readiness-only --case-id 206
//   node src/quotation-scan-worker.js --once --case-id 206         ONE pass, limited to these Cases
// WRITES (when run with --once): scan results and audit rows in humancare_dev; an INFECTED file is moved to quarantine. ClamAV must be running: readiness says so.
const { main } = require('./common/safety/single-stage-runner');

function loadStage() {
  const bitrixConfig = require('./modules/bitrix/bitrix-config');
  const { resolveProfile } = require('./modules/bitrix/bitrix-profiles');
  const { sweepPendingQuotationScans } = require('./modules/bitrix/quotation-scan.service');
  const clamav = require('./integrations/clamav/clamav');
  return {
    label: 'quotation-scan',
    configProblems(env) {
      try { bitrixConfig.assertBitrixConfiguration(env); } catch { return ['bitrix_configuration_invalid']; }
      if (!bitrixConfig.isQuotationSyncActive(env)) return ['quotation_sync_inactive'];
      return resolveProfile(env) ? [] : ['profile_not_configured'];
    },
    async liveProblems() { return (await clamav.isReady()) ? [] : ['clamav_unavailable']; },
    async describe(prisma, env, caseIds) {
      const awaitingScan = await prisma.caseQuotation.count({ where: { caseId: { in: caseIds }, scanStatus: { in: ['pending', 'error'] } } });
      return { caseIds, awaitingScan, clamav: 'ready' };
    },
    execute: (caseIds) => sweepPendingQuotationScans({ caseIds }),
  };
}

module.exports = { loadStage };
if (require.main === module) main(loadStage).then((code) => { process.exitCode = code; });
