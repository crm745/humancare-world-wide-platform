// A ONE-CASE, guarded run of the Bitrix24 quotation synchronization for the test database (humancare_test). NOT src/worker.js (that one
// loads the development .env and runs every job).
//
//   node scripts/e2e-quotation-sync.js                                    DRY RUN (default): checks everything, prints the plan. No network, no write.
//   node scripts/e2e-quotation-sync.js --detect-only                      ONE read-only crm.deal.get: shows what would be queued. No database write.
//   node scripts/e2e-quotation-sync.js --execute --confirm CASE-4037      queue ONE event, run ONE scoped sync pass and ONE scoped scan pass
//   node scripts/e2e-quotation-sync.js --scan-only --confirm CASE-4037    ONLY the ClamAV scan of quotation 762 (Case 3037). ZERO Bitrix calls: no detection, no sync, no
//                                                                         event, no version. The Bitrix webhook is blanked and fetch is blocked for the whole run.
//
// Fixed target (change the constants on purpose, never by a flag):
//   database humancare_test | CASE-4037 (id 3037) | request REQ-5672 (4672) | Bitrix Deal 21802 | Category 38 | Quotation PDF UF_CRM_1794985313
//
// Safeguards (each is checked before anything is sent or written):
//   * ONLY backend/.env.test (scripts/e2e-env.js); the database and the database account are verified at the start AND before the pass;
//   * the Bitrix webhook host must equal the pinned portal AND the allowlist in .env.test; nothing is overridden;
//   * the Bitrix surface is a guard: crm.deal.get (twice at most), crm.item.get (once) and ONE download of the file link, on the pinned host only. Any other
//     method, any non-read call and any further call is refused before it leaves the machine. There is no Bitrix write method in this code path at all;
//   * the sync pass and the scan pass are SCOPED to Case 3037: no other Case, no other outbox event is claimed; before and after, every other
//     outbox row is compared and any change is reported as a failure;
//   * the result is a DRAFT: nothing is confirmed, published or accepted, no invoice, no payment and no notification is created.
const { applyIsolatedEnv } = require('./e2e-env');

const TARGET = Object.freeze({
  caseId: 3037, caseReference: 'CASE-4037', requestId: 4672, requestReference: 'REQ-5672', dealId: '21802', category: '38',
  dbUser: 'humancare_test_app', dbName: 'humancare_test', portalHost: 'b24-4orefh.bitrix24.in',
  // the one quotation --scan-only may touch, and exactly what it must look like before it is scanned
  quotationId: 762, quotationVersion: 1, quotationAmount: '1000', quotationCurrency: 'INR',
  quotationSha256: '279f139a63c1942fa8b945d87f44d942e8f4a72ca864af7102f22f9ffb64cd6c',
  quotationStorageKey: 'quotations/case-3037/ev466-279f139a63c1942fa8b945d87f44d942e8f4a72ca864af7102f22f9ffb64cd6c.pdf',
});
const LIMITS = Object.freeze({ dealGet: 2, itemGet: 1, download: 1 });

class RunError extends Error {
  constructor(message) { super(`Quotation sync run: ${message}`); this.name = 'RunError'; }
}
const refuse = (m) => new RunError(m);

function parseArgs(argv) {
  const out = { execute: false, confirmed: false, detectOnly: false, scanOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (arg === '--detect-only') out.detectOnly = true;
    else if (arg === '--scan-only') out.scanOnly = true;
    else if (arg === '--confirm') {
      if (argv[i + 1] !== TARGET.caseReference) throw refuse(`--confirm must be followed by ${TARGET.caseReference}.`);
      out.confirmed = true;
      i += 1;
    } else throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use: [--detect-only] | [--execute --confirm ${TARGET.caseReference}] | [--scan-only --confirm ${TARGET.caseReference}].`);
  }
  if (out.scanOnly) {
    if (out.execute || out.detectOnly) throw refuse('--scan-only cannot be combined with --execute or --detect-only.');
    if (!out.confirmed) throw refuse(`--scan-only needs --confirm ${TARGET.caseReference}.`);
    return out;
  }
  if (out.execute !== out.confirmed) throw refuse(`--execute and --confirm ${TARGET.caseReference} must be given together.`);
  if (out.execute && out.detectOnly) throw refuse('--detect-only cannot be combined with --execute.');
  return out;
}

// The ONLY network surface: every request is checked (host, method, count) before it leaves the machine.
function makeGuard(allowedHost, limits = LIMITS) {
  const state = { dealGet: 0, itemGet: 0, download: 0, refused: [] };
  const fetchImpl = async (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw new Error('Guard: unusable URL.'); }
    if (parsed.hostname.toLowerCase() !== allowedHost) { state.refused.push('host'); throw new Error('Guard: host is not the allowed portal.'); }
    const method = init && init.method;
    const rest = (parsed.pathname.match(/\/(crm\.[a-z.]+)\.json$/) || [])[1];
    if (method === 'POST' && rest === 'crm.deal.get') { if (++state.dealGet > limits.dealGet) throw new Error('Guard: crm.deal.get limit reached.'); }
    else if (method === 'POST' && rest === 'crm.item.get') { if (++state.itemGet > limits.itemGet) throw new Error('Guard: crm.item.get limit reached.'); }
    else if (method === 'GET' && !rest) { if (++state.download > limits.download) throw new Error('Guard: one download only.'); }
    else { state.refused.push(`${method} ${rest || 'other'}`); throw new Error('Guard: only crm.deal.get, crm.item.get and one file download are allowed.'); }
    return fetch(url, init);
  };
  return { state, fetchImpl };
}

// The Bitrix client the services see: the real read helpers, each bound to the guard. Every other method is absent or refused.
function makeGuardedApi(realApi, guard) {
  return {
    BitrixDealCallError: realApi.BitrixDealCallError,
    getDeal: (dealId, options = {}) => realApi.getDeal(dealId, { ...options, fetchImpl: guard.fetchImpl }),
    getDealFileField: (dealId, field, options = {}) => realApi.getDealFileField(dealId, field, { ...options, fetchImpl: guard.fetchImpl }),
    downloadBitrixFile: (file, options = {}) => realApi.downloadBitrixFile(file, { ...options, fetchImpl: guard.fetchImpl }),
    createDeal: async () => { guard.state.refused.push('createDeal'); throw new Error('Writes to Bitrix24 are disabled in this runner.'); },
    updateDealFiles: async () => { guard.state.refused.push('updateDealFiles'); throw new Error('Writes to Bitrix24 are disabled in this runner.'); },
    findDealsByReference: async () => { guard.state.refused.push('findDealsByReference'); throw new Error('Not used by this runner.'); },
    getDealFiles: async () => { guard.state.refused.push('getDealFiles'); throw new Error('Not used by this runner.'); },
  };
}

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const rows = async (db, sql, ...a) => (await db.$queryRawUnsafe(sql, ...a)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])));

async function preflight(db) {
  const problems = [];
  const [c] = await rows(db,
    `SELECT c.id, c.reference_number, c.status, c.service_request_id, sr.reference_number AS request_reference, sr.service_key, sr.review_status, sr.bitrix_lead_id,
            l.id AS link_id, l.bitrix_deal_id, l.category_id, l.sync_status
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.id = ?`, TARGET.caseId);
  if (!c) throw refuse(`case ${TARGET.caseId} not found. Nothing was run.`);
  if (c.reference_number !== TARGET.caseReference) problems.push('case id and reference do not match');
  if (c.service_request_id !== TARGET.requestId || c.request_reference !== TARGET.requestReference) problems.push('the case is not linked to REQ-5672');
  if (c.service_key !== 'privatecharter' || c.review_status !== 'approved' || c.bitrix_lead_id != null) problems.push('not an approved Private Charter request without a Lead');
  if (c.bitrix_deal_id !== TARGET.dealId || c.category_id !== TARGET.category || c.sync_status !== 'synced') problems.push('the Deal link is not Deal 21802 / category 38 / synced');
  if (['completed', 'cancelled'].includes(c.status)) problems.push('the case is closed');
  const quotations = await rows(db, 'SELECT id, version_number, status, scan_status FROM case_quotations WHERE case_id = ? ORDER BY version_number', TARGET.caseId);
  const [money] = await rows(db, 'SELECT (SELECT COUNT(*) FROM invoices WHERE case_id = ?) AS invoices, (SELECT COUNT(*) FROM payments WHERE case_id = ?) AS payments', TARGET.caseId, TARGET.caseId);
  const events = await rows(db, "SELECT id, event_type, status FROM integration_outbox WHERE case_id = ? ORDER BY id", TARGET.caseId);
  if (events.some((e) => e.event_type === 'bitrix.deal.create' && e.status !== 'completed')) problems.push('a Deal-create event of this Case is not completed');
  if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
  return { c, quotations, money, events };
}

const outboxSnapshot = (db) => rows(db, 'SELECT id, event_type, status, attempts FROM integration_outbox ORDER BY id');

// ---- --scan-only: ONLY the malware scan of quotation 762 --------------------------------------------------------------------------------------
// No Bitrix at all: the webhook is blanked in the environment the services see, global fetch is replaced by a function that counts and refuses, and
// neither the Bitrix client, detection nor the sync worker is used here. The scan itself talks to ClamAV over a local socket.
const quotationSnapshot = (db) => rows(db, 'SELECT id, case_id, version_number, status, scan_status, scan_attempts, revision, amount, currency, storage_key, sha256 FROM case_quotations ORDER BY id');

async function runScanOnly(env) {
  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const cfg = require('../src/modules/bitrix/bitrix-config');
  const harness = require('../src/modules/bitrix/deal-worker-harness');
  const { sweepPendingQuotationScans } = require('../src/modules/bitrix/quotation-scan.service');
  const { createLocalStorage, hashFile } = require('../src/modules/bitrix/quotation-storage');

  const net = { fetchCalls: 0 };
  const originalFetch = global.fetch;
  global.fetch = () => { net.fetchCalls += 1; return Promise.reject(new Error('Network access is disabled in the scan-only run.')); };
  try {
    const live = await verifyLiveDatabase(prisma);
    if (live.database !== TARGET.dbName || live.account.split('@')[0] !== TARGET.dbUser) throw refuse('unexpected database or account. Nothing was run.');
    console.log(`Quotation scan-only: database ${live.database}, account ${live.account.split('@')[0]}; Case ${TARGET.caseId}, quotation ${TARGET.quotationId}; ZERO Bitrix calls.`);

    // live: false blanks the webhook and the inbound token, so there is nothing to send to even by mistake.
    const workerEnv = { ...harness.workerEnv(env, { live: false }), BITRIX_QUOTATION_SYNC_ENABLED: 'true' };
    cfg.assertBitrixConfiguration(workerEnv);
    if (!cfg.isQuotationSyncActive(workerEnv)) throw refuse('the quotation scan would not be active.');
    if (workerEnv.BITRIX24_WEBHOOK_URL) throw refuse('the webhook is still visible to the scan. Nothing was run.');

    // ---- pre-flight (read only): the Case, and the quotation exactly as expected --------------------------------------------------------
    const storage = createLocalStorage();
    const plan = await preflight(prisma);
    const problems = [];
    const [q] = await rows(prisma, 'SELECT *, UTC_TIMESTAMP(3) AS db_now FROM case_quotations WHERE id = ?', TARGET.quotationId);
    if (!q) throw refuse(`quotation ${TARGET.quotationId} not found. Nothing was run.`);
    if (plan.quotations.length !== 1 || plan.quotations[0].id !== TARGET.quotationId) problems.push('Case 3037 must have exactly one quotation, 762');
    if (q.case_id !== TARGET.caseId || q.version_number !== TARGET.quotationVersion) problems.push('quotation 762 is not version 1 of Case 3037');
    if (q.status !== 'draft' || q.confirmed_at != null || q.published_at != null || q.working_slot !== 1) problems.push('the quotation is not an unconfirmed, unpublished draft');
    if (q.scan_status !== 'pending') problems.push(`scan_status is ${q.scan_status}, expected pending`);
    if (q.scan_next_attempt_at != null && new Date(q.scan_next_attempt_at) > new Date(q.db_now)) problems.push('a scan lease is still active');
    if (String(Number(q.amount)) !== TARGET.quotationAmount || q.currency !== TARGET.quotationCurrency || q.validation_error != null) problems.push('amount / currency are not 1000 INR with no validation error');
    if (q.sha256 !== TARGET.quotationSha256 || q.storage_key !== TARGET.quotationStorageKey || q.storage_provider !== 'local') problems.push('the stored file identity is not the expected one');
    let fileHash = null;
    try { fileHash = await hashFile(storage.pathOf(q.storage_key)); } catch { problems.push('the stored file cannot be read'); }
    if (fileHash && fileHash !== q.sha256) problems.push('the stored file does not match its SHA-256');
    if (problems.length) throw refuse(`pre-flight failed (${problems.join('; ')}). Nothing was run.`);
    console.log(`  pre-flight ok: case ${TARGET.caseId} (${TARGET.caseReference}); quotation ${q.id} v${q.version_number} draft, scan pending, attempts ${q.scan_attempts}, revision ${q.revision}, ${Number(q.amount)} ${q.currency}; file SHA-256 matches the database (${fileHash.slice(0, 12)}...).`);

    await verifyLiveDatabase(prisma);
    const quotesBefore = await quotationSnapshot(prisma);
    const outboxBefore = await outboxSnapshot(prisma);
    const auditBefore = (await rows(prisma, 'SELECT COUNT(*) AS n FROM audit_logs'))[0].n;

    const scan = await sweepPendingQuotationScans({ prisma, env: workerEnv, log: console, storage, caseIds: [TARGET.caseId], quotationIds: [TARGET.quotationId] });
    console.log(`  scan pass: ${JSON.stringify(scan)}`);

    // ---- verification -----------------------------------------------------------------------------------------------------------------
    const [after] = await rows(prisma, 'SELECT id, version_number, status, scan_status, scan_engine, scan_detail, scanned_at, scan_attempts, scan_next_attempt_at, revision, amount, currency, validation_error, working_slot, live_slot, confirmed_at, published_at, storage_key, sha256 FROM case_quotations WHERE id = ?', TARGET.quotationId);
    console.log(`  quotation 762 now: ${JSON.stringify(after)}`);
    const audits = await rows(prisma, "SELECT id, action, idempotency_key FROM audit_logs WHERE entity_type = 'case_quotation' AND entity_id = ? ORDER BY id", String(TARGET.quotationId));
    console.log(`  quotation 762 audit rows: ${JSON.stringify(audits)}`);
    const quotesAfter = await quotationSnapshot(prisma);
    const outboxAfter = await outboxSnapshot(prisma);
    const auditAfter = (await rows(prisma, 'SELECT COUNT(*) AS n FROM audit_logs'))[0].n;
    const others = (list) => JSON.stringify(list.filter((x) => x.id !== TARGET.quotationId));
    const othersUnchanged = others(quotesBefore) === others(quotesAfter) && quotesBefore.length === quotesAfter.length;
    const outboxUnchanged = JSON.stringify(outboxBefore) === JSON.stringify(outboxAfter);
    const fileAfter = await hashFile(storage.pathOf(TARGET.quotationStorageKey)).catch(() => null);
    const money = (await rows(prisma, 'SELECT (SELECT COUNT(*) FROM invoices WHERE case_id = ?) AS invoices, (SELECT COUNT(*) FROM payments WHERE case_id = ?) AS payments', TARGET.caseId, TARGET.caseId))[0];
    console.log(`  other quotations unchanged: ${othersUnchanged}; outbox rows unchanged (no new event): ${outboxUnchanged}; new audit rows: ${auditAfter - auditBefore}; invoices ${money.invoices}, payments ${money.payments}.`);
    console.log(`  file after: ${fileAfter ? `present, SHA-256 ${fileAfter === TARGET.quotationSha256 ? 'unchanged' : 'CHANGED'}` : 'not at the original path (quarantined if infected)'}; Bitrix/fetch calls: ${net.fetchCalls}.`);
    const stateOk = after.status === 'draft' && after.confirmed_at == null && after.published_at == null && after.version_number === 1 && Number(after.amount) === 1000 && after.currency === 'INR' && after.validation_error == null;
    if (!othersUnchanged || !outboxUnchanged || !stateOk || net.fetchCalls !== 0 || money.invoices !== plan.money.invoices || money.payments !== plan.money.payments) {
      console.error('WARNING: an unexpected change was detected. Stop and investigate; do not re-run.');
      process.exitCode = 2;
    }
  } finally {
    global.fetch = originalFetch;
    await prisma.$disconnect();
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const env = applyIsolatedEnv(); // ONLY backend/.env.test: validates the test environment before Prisma is loaded
  if (options.scanOnly) return runScanOnly(env);

  const { prisma } = require('../src/db/prisma');
  const { verifyLiveDatabase } = require('../src/common/safety/test-database-guard');
  const cfg = require('../src/modules/bitrix/bitrix-config');
  const realApi = require('../src/modules/bitrix/bitrix-deal.api');
  const harness = require('../src/modules/bitrix/deal-worker-harness');
  const { DEAL, FIELD } = require('../src/modules/bitrix/bitrix-deal');
  const { detectAndEnqueueQuotationSync, readQuotationSignature } = require('../src/modules/bitrix/quotation-outbox');
  const { runQuotationSync } = require('../src/modules/bitrix/quotation-sync.service');
  const { sweepPendingQuotationScans } = require('../src/modules/bitrix/quotation-scan.service');
  const { createLocalStorage } = require('../src/modules/bitrix/quotation-storage');

  try {
    const live = await verifyLiveDatabase(prisma);
    if (live.database !== TARGET.dbName || live.account.split('@')[0] !== TARGET.dbUser) throw refuse('unexpected database or account. Nothing was run.');
    console.log(`Quotation sync: database ${live.database}, account ${live.account.split('@')[0]}; ${options.execute ? 'EXECUTE' : options.detectOnly ? 'DETECT ONLY' : 'DRY RUN'}.`);

    // Portal lock. The host only is printed; the webhook itself never is.
    if (cfg.webhookHost(env.BITRIX24_WEBHOOK_URL) !== TARGET.portalHost) throw refuse('the webhook host in .env.test is not the pinned portal. Nothing was run.');
    if (String(env.BITRIX_ALLOWED_PORTAL_HOST || '').trim().toLowerCase() !== TARGET.portalHost) throw refuse('BITRIX_ALLOWED_PORTAL_HOST in .env.test does not name the pinned portal.');
    const workerEnv = { ...harness.workerEnv(env, { live: true }), BITRIX_QUOTATION_SYNC_ENABLED: 'true' }; // switches on for THIS process only
    if (cfg.bitrixHostProblem(workerEnv)) throw refuse('the portal allowlist check failed.');
    cfg.assertBitrixConfiguration(workerEnv);
    if (!cfg.isQuotationSyncActive(workerEnv)) throw refuse('the quotation sync would not be active.');
    console.log(`  portal lock: webhook host equals ${TARGET.portalHost} and the allowlist; the quotation switch is on for this process only.`);

    const plan = await preflight(prisma);
    console.log(`  case ${TARGET.caseId} (${TARGET.caseReference}) / ${TARGET.requestReference}: Deal ${TARGET.dealId}, category ${TARGET.category}, synced. Quotation versions now: ${plan.quotations.length}; invoices ${plan.money.invoices}, payments ${plan.money.payments}.`);
    if (!options.execute && !options.detectOnly) {
      console.log('  would: read the Deal once, queue ONE bitrix.quotation.sync event (entity type bitrix_deal_quotation), run ONE scoped sync pass (getDeal, crm.item.get, one download), then ONE scoped ClamAV scan pass.');
      console.log('Dry run: no network call, nothing claimed or written.');
      return;
    }

    const guard = makeGuard(TARGET.portalHost);
    const api = makeGuardedApi(realApi, guard);
    const read = await api.getDeal(TARGET.dealId, { env: workerEnv });
    if (read.status !== 'ok') throw refuse(`the Deal could not be read (${read.status}). Nothing was written.`);
    const deal = read.deal;
    if (String(deal.ID) !== TARGET.dealId || String(deal.CATEGORY_ID) !== String(DEAL.CATEGORY_ID) || deal[FIELD.REFERENCE] !== TARGET.caseReference) throw refuse('the Deal is not CASE-4037\'s Deal. Nothing was written.');
    const signature = readQuotationSignature(deal);
    console.log(`  Bitrix Deal read: stage ${deal.STAGE_ID}; quotation file id ${signature.fileId}; amount ${signature.amountRaw === null ? 'empty' : 'present'}; currency ${signature.currencyRaw === null ? 'empty' : 'present'}.`);
    if (options.detectOnly) { console.log('Detect only: nothing was written.'); return; }

    // ---- execute --------------------------------------------------------------------------------------------------------------------
    await verifyLiveDatabase(prisma);
    await preflight(prisma);
    const before = await outboxSnapshot(prisma);
    const queued = await detectAndEnqueueQuotationSync(prisma, { id: TARGET.caseId, referenceNumber: TARGET.caseReference }, deal);
    console.log(`  detection: ${queued.reason}.`);

    const storage = createLocalStorage();
    const sync = await runQuotationSync({ prisma, api, env: workerEnv, log: console, storage, scope: { caseIds: [TARGET.caseId] } });
    console.log(`  sync pass: ${JSON.stringify(sync)}`);
    const scan = await sweepPendingQuotationScans({ prisma, env: workerEnv, log: console, storage, caseIds: [TARGET.caseId] });
    console.log(`  scan pass: ${JSON.stringify(scan)}`);

    const after = await outboxSnapshot(prisma);
    const beforeById = new Map(before.map((e) => [e.id, e]));
    const changedOthers = after.filter((e) => beforeById.has(e.id) && (beforeById.get(e.id).status !== e.status || beforeById.get(e.id).attempts !== e.attempts));
    const newEvents = after.filter((e) => !beforeById.has(e.id));
    const quotes = await rows(prisma, 'SELECT id, version_number, status, scan_status, scan_detail, amount, currency, validation_error, bitrix_file_id, size_bytes, sha256, storage_provider, storage_key, working_slot, live_slot, published_at, confirmed_at FROM case_quotations WHERE case_id = ?', TARGET.caseId);
    const money = (await rows(prisma, 'SELECT (SELECT COUNT(*) FROM invoices WHERE case_id = ?) AS invoices, (SELECT COUNT(*) FROM payments WHERE case_id = ?) AS payments', TARGET.caseId, TARGET.caseId))[0];
    console.log(`  quotation rows: ${JSON.stringify(quotes)}`);
    console.log(`  new outbox events: ${JSON.stringify(newEvents)}; other events changed: ${changedOthers.length}; invoices ${money.invoices}, payments ${money.payments}.`);
    console.log(`  Bitrix calls: crm.deal.get ${guard.state.dealGet}, crm.item.get ${guard.state.itemGet}, downloads ${guard.state.download}; refused: ${guard.state.refused.join(', ') || 'none'}.`);
    if (changedOthers.length || newEvents.length > 1 || money.invoices !== plan.money.invoices || money.payments !== plan.money.payments || guard.state.refused.length) {
      console.error('WARNING: an unexpected change was detected. Stop and investigate; do not re-run.');
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof RunError ? err.message : `Quotation sync run: ${err && err.name}: ${String((err && err.message) || '').slice(0, 160)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, makeGuard, makeGuardedApi, preflight, runScanOnly, TARGET, LIMITS };
