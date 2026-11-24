// The logic of the guarded, ONE-CASE quotation E2E launcher (scripts/e2e-quotation-case-1206.js): Bitrix Deal 21846 (Category 0, profile "actual"),
// CASE-1206, REQ-1208, database humancare_dev on this machine, the development S3 bucket.
//
// It re-implements nothing. The Deal is read with the existing Bitrix client, the event is queued by the existing detectAndEnqueueQuotationSync(),
// delivered by the existing runQuotationSync() and the stored PDF is scanned by the existing sweepPendingQuotationScans(), each narrowed with the scope
// those services already offer ({ caseIds } and { caseIds, quotationIds }). Storage is the existing createQuotationStorage() (S3 putIfAbsent), and every
// Bitrix call passes the shared dispatcher (rate limiter + circuit breaker) as well as a guard that allows only crm.deal.get, crm.item.get and ONE file
// download on the pinned portal host.
//
// DRY RUN (default): reads the database only. No Bitrix call, no queued event, no S3 call, no download, no scan, no write.
// EXECUTE (--execute --confirm CASE-1206): ONE pass of each service, no loop. Whatever state it ends in is reported, never retried automatically.
//
// NEVER done here: any Bitrix write, a stage change, the inbox, reconcile or any other job, a notification or push, confirm / publish / accept / reject,
// an invoice, a payment, a Razorpay call, a write to .env or to process.env.
const TARGET = Object.freeze({
  dealId: '21846', caseReference: 'CASE-1206', requestReference: 'REQ-1208', categoryId: '0', profile: 'actual', database: 'humancare_dev',
  fields: Object.freeze({ FILE: 'UF_CRM_1795177914', AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' }),
  bucketPrefix: 'humancare-dev-',
});
const LIMITS = Object.freeze({ dealGet: 2, itemGet: 1, download: 1 }); // my one read + the sync's one read; one file lookup; one download
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CLOSED_CASE = new Set(['completed', 'cancelled']);
const SWITCHES = Object.freeze({
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true', BITRIX_DEAL_PROFILE: TARGET.profile,
});

class Refused extends Error {
  constructor(codes) { const list = [].concat(codes); super(`refused: ${list.join(', ')}`); this.name = 'Refused'; this.codes = list; }
}
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const rows = async (db, sql, ...args) => (await db.$queryRawUnsafe(sql, ...args)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])));

// [--execute --confirm CASE-1206]. Both or neither; nothing else is accepted (no target option exists).
function parseArgs(argv) {
  const out = { execute: false, confirmed: false };
  const list = [...argv];
  while (list.length) {
    const arg = list.shift();
    if (arg === '--execute') out.execute = true;
    else if (arg === '--confirm') {
      if (list.shift() !== TARGET.caseReference) throw new Refused('confirm_must_name_CASE-1206');
      out.confirmed = true;
    } else throw new Refused('unknown_argument');
  }
  if (out.execute !== out.confirmed) throw new Refused('execute_and_confirm_required_together');
  return { execute: out.execute };
}

// The environment the services see: a COPY of the process environment with the switches forced on. Nothing is written to process.env or to any file.
const buildWorkerEnv = (base) => ({ ...base, ...SWITCHES });

// ---- environment, storage -----------------------------------------------------------------------------------------------------------------
function environmentProblems(env) {
  const cfg = require('../../src/modules/bitrix/bitrix-config');
  const { resolveProfile } = require('../../src/modules/bitrix/bitrix-profiles');
  const { quotationFieldsForProfile } = require('../../src/modules/bitrix/quotation-outbox');
  const problems = [];
  if (env.NODE_ENV === 'production') problems.push('production_refused');
  let dbUrl = null;
  try { dbUrl = new URL(String(env.DATABASE_URL)); } catch { /* handled below */ }
  if (!dbUrl || !LOOPBACK_HOSTS.has(dbUrl.hostname.toLowerCase())) problems.push('database_not_loopback');
  if (!dbUrl || dbUrl.pathname.replace(/^\//, '') !== TARGET.database) problems.push('database_url_not_humancare_dev');
  try { cfg.assertBitrixConfiguration(env); } catch { problems.push('bitrix_configuration_invalid'); }
  if (!cfg.isQuotationSyncActive(env)) problems.push('quotation_sync_not_active'); // needs all four switches
  const profile = resolveProfile(env);
  if (!profile || profile.name !== TARGET.profile) problems.push('bitrix_profile_not_actual');
  else {
    if (String(profile.categoryId) !== TARGET.categoryId) problems.push('profile_category_not_0');
    const fields = quotationFieldsForProfile(profile);
    if (!fields || fields.FILE !== TARGET.fields.FILE || fields.AMOUNT !== TARGET.fields.AMOUNT || fields.CURRENCY !== TARGET.fields.CURRENCY) problems.push('quotation_fields_not_as_approved');
  }
  if (!env.BITRIX24_WEBHOOK_URL) problems.push('webhook_not_configured');
  else if (cfg.bitrixHostProblem(env)) problems.push('portal_host_not_allowed');
  else if (String(env.BITRIX_ALLOWED_PORTAL_HOST || '').trim().toLowerCase() !== cfg.webhookHost(env.BITRIX24_WEBHOOK_URL)) problems.push('portal_allowlist_not_the_webhook_host');
  return problems;
}

// -> { problems, warnings, info }. Reads the configuration only: no S3 call, no secret is returned.
function storageProblems(env) {
  const { readStorageConfig } = require('../../src/storage/config');
  const problems = []; const warnings = []; let info = null;
  try {
    const config = readStorageConfig(env);
    if (config.provider !== 's3') problems.push('storage_provider_not_s3');
    else {
      if (!config.bucket.startsWith(TARGET.bucketPrefix)) problems.push('bucket_not_a_development_bucket');
      info = { provider: 's3', bucket: config.bucket, region: config.region, credentials: config.accessKeyId ? 'environment keys' : 'AWS default credential chain', readFallback: Boolean(config.readFallback) };
      if (!config.accessKeyId && (env.AWS_ACCESS_KEY || env.AWS_SECRET)) warnings.push('AWS_ACCESS_KEY / AWS_SECRET are set but the storage layer reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, so they are ignored and the default credential chain is used');
    }
  } catch (err) { problems.push(`storage_${(err && err.code) || 'config_invalid'}`); }
  return { problems, warnings, info };
}

// ---- the database: identity, target, snapshots (SELECT only) -----------------------------------------------------------------------------------
async function verifyDatabase(prisma) {
  const [row] = await rows(prisma, 'SELECT DATABASE() AS db');
  if (!row || row.db !== TARGET.database) throw new Refused('database_not_humancare_dev');
}

async function inspectTarget(prisma) {
  const found = await rows(prisma,
    `SELECT c.id AS case_id, c.reference_number, c.status, sr.id AS request_id, sr.reference_number AS request_reference, sr.user_id, sr.service_key, sr.review_status, sr.bitrix_lead_id,
            l.id AS link_id, l.bitrix_deal_id, l.category_id, l.profile, l.sync_status
     FROM cases c JOIN service_requests sr ON sr.id = c.service_request_id LEFT JOIN bitrix_deal_links l ON l.case_id = c.id WHERE c.reference_number = ?`, TARGET.caseReference);
  if (found.length !== 1) return { ok: false, problems: ['case_not_found'], target: null };
  const r = found[0];
  const problems = [];
  if (r.request_reference !== TARGET.requestReference) problems.push('request_reference_mismatch');
  if (r.service_key !== 'privatecharter' || r.review_status !== 'approved' || r.bitrix_lead_id != null) problems.push('not_an_approved_private_charter_request_without_lead');
  if (CLOSED_CASE.has(r.status)) problems.push('case_closed');
  if (r.link_id == null) problems.push('deal_link_missing');
  else {
    if (r.bitrix_deal_id !== TARGET.dealId) problems.push('deal_id_mismatch');
    if (String(r.category_id) !== TARGET.categoryId) problems.push('link_category_not_0');
    if (r.profile !== TARGET.profile) problems.push('link_profile_not_actual');
    if (r.sync_status !== 'synced') problems.push('link_not_synced');
  }
  const target = { caseId: r.case_id, requestId: r.request_id, userId: r.user_id, caseReference: r.reference_number, requestReference: r.request_reference, status: r.status };
  if (!problems.length) {
    const open = await rows(prisma, "SELECT id FROM integration_outbox WHERE case_id = ? AND event_type = 'bitrix.quotation.sync' AND status IN ('pending', 'processing')", target.caseId);
    if (open.length) problems.push('open_quotation_event_exists'); // a scoped pass would also deliver it: refuse instead
    const quotes = await rows(prisma, 'SELECT id, status FROM case_quotations WHERE case_id = ?', target.caseId);
    if (quotes.some((q) => q.status !== 'draft')) problems.push('case_has_a_non_draft_quotation');
  }
  return { ok: problems.length === 0, problems, target };
}

// Everything that must not change except the quotation work of the target Case.
async function snapshot(prisma, target) {
  const id = target.caseId;
  const one = async (sql, ...a) => (await rows(prisma, sql, ...a))[0];
  return {
    caseRow: await one('SELECT status, charter_stage, stage_version FROM cases WHERE id = ?', id),
    link: await one('SELECT stage_id, external_modified_at, sync_status, last_attempt_at, last_synced_at FROM bitrix_deal_links WHERE case_id = ?', id),
    quotations: await rows(prisma, 'SELECT id, version_number, status, scan_status, scan_attempts, revision, storage_provider, storage_key, sha256, amount, currency, validation_error, confirmed_at, published_at FROM case_quotations WHERE case_id = ? ORDER BY id', id),
    events: await rows(prisma, 'SELECT id, event_type, status, attempts FROM integration_outbox WHERE case_id = ? ORDER BY id', id),
    money: await one('SELECT (SELECT COUNT(*) FROM invoices WHERE case_id = ?) AS invoices, (SELECT COUNT(*) FROM payments WHERE case_id = ?) AS payments, (SELECT COUNT(*) FROM case_stage_events WHERE case_id = ?) AS stage_events, (SELECT COUNT(*) FROM notifications WHERE recipient_type = \'patient\' AND recipient_id = ?) AS patient_notifications', id, id, id, target.userId),
    otherOutbox: await rows(prisma, 'SELECT id, event_type, status, attempts FROM integration_outbox WHERE case_id IS NULL OR case_id <> ? ORDER BY id', id),
    otherQuotations: await rows(prisma, 'SELECT id, status, scan_status, scan_attempts, revision FROM case_quotations WHERE case_id <> ? ORDER BY id', id),
    inbox: await rows(prisma, 'SELECT id, status, attempts FROM integration_inbox ORDER BY id'),
    otherLinks: await rows(prisma, 'SELECT id, stage_id, external_modified_at, last_attempt_at, sync_status FROM bitrix_deal_links WHERE case_id <> ? ORDER BY id', id),
  };
}

// -> [codes] of everything that changed and must not have. Allowed: ONE new quotation event of the Case, and the Case's own quotation rows.
function unexpectedChanges(before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  if (!same(before.caseRow, after.caseRow)) out.push('case_state_changed');
  if (!same(before.link, after.link)) out.push('deal_link_or_stage_changed');
  if (!same(before.money, after.money)) out.push('invoice_payment_notification_or_stage_event_changed');
  if (!same(before.otherOutbox, after.otherOutbox)) out.push('other_outbox_events_changed');
  if (!same(before.otherQuotations, after.otherQuotations)) out.push('other_quotations_changed');
  if (!same(before.inbox, after.inbox)) out.push('inbox_changed');
  if (!same(before.otherLinks, after.otherLinks)) out.push('other_deal_links_changed');
  const known = new Set(before.events.map((e) => e.id));
  const added = after.events.filter((e) => !known.has(e.id));
  if (added.length > 1 || added.some((e) => e.event_type !== 'bitrix.quotation.sync')) out.push('unexpected_new_events');
  if (before.events.some((e) => !same(e, after.events.find((x) => x.id === e.id)))) out.push('existing_case_events_changed');
  if (after.quotations.some((q) => q.confirmed_at != null || q.published_at != null || !['draft'].includes(q.status))) out.push('quotation_confirmed_or_published');
  return out;
}

// ---- the Bitrix surface -------------------------------------------------------------------------------------------------------------------
// The real read helpers, each bound to the guard (host, method, count) AND the shared dispatcher (rate limiter + circuit breaker). Every write
// method, and every method this run does not use, is refused and recorded.
function makeGuardedApi(realApi, guard, gateway) {
  const bound = (options = {}) => ({ ...options, fetchImpl: guard.fetchImpl, gateway });
  const refuse = (name) => async () => { guard.state.refused.push(name); throw new Error('Writes to Bitrix24 are disabled in this runner.'); };
  return {
    BitrixDealCallError: realApi.BitrixDealCallError,
    getDeal: (dealId, options) => realApi.getDeal(dealId, bound(options)),
    getDealFileField: (dealId, field, options) => realApi.getDealFileField(dealId, field, bound(options)),
    downloadBitrixFile: (file, options) => realApi.downloadBitrixFile(file, bound(options)),
    createDeal: refuse('createDeal'), updateDealFiles: refuse('updateDealFiles'), findDealsByReference: refuse('findDealsByReference'), getDealFiles: refuse('getDealFiles'),
  };
}

// ---- the run ------------------------------------------------------------------------------------------------------------------------------
/**
 * `deps`: { prisma, env (the process environment), log, realApi, gateway, makeGuard, createStorage, s3Probe(key), clamReady(), services: { detect, runSync, sweep } }.
 * Resolves a report. Throws Refused before anything is written. Dry run unless options.execute.
 */
async function run(options, deps) {
  const { prisma, log = console } = deps;
  const workerEnv = buildWorkerEnv(deps.env);
  await verifyDatabase(prisma);

  const problems = [...environmentProblems(workerEnv)];
  const storage = storageProblems(workerEnv);
  problems.push(...storage.problems);
  const clamOk = await deps.clamReady();
  if (!clamOk) problems.push('clamav_not_ready');
  const inspected = await inspectTarget(prisma);
  problems.push(...inspected.problems);

  const report = { mode: options.execute ? 'execute' : 'dry-run', target: { deal: TARGET.dealId, caseReference: TARGET.caseReference, requestReference: TARGET.requestReference, category: TARGET.categoryId, profile: TARGET.profile }, problems, warnings: storage.warnings, storage: storage.info, clamav: clamOk ? 'ready' : 'not ready' };
  if (inspected.target) report.ids = { caseId: inspected.target.caseId, requestId: inspected.target.requestId };
  if (!inspected.target) { report.ready = false; return report; }
  report.before = await snapshot(prisma, inspected.target);

  // What a scoped pass could ever offer: read with the services' own queries (SELECT only).
  const store = require('../../src/modules/bitrix/quotation-sync.store');
  report.inScope = { quotationEventCandidates: (await store.findCandidateIds(prisma, 5, { caseIds: [inspected.target.caseId] }, TARGET.profile)).length };
  report.scope = { caseIds: [inspected.target.caseId], quotationIds: 'the one version created by the sync', jobsRun: ['quotation sync (scoped)', 'quotation scan (scoped)'], jobsNotRun: ['inbox', 'reconcile', 'retry', 'invoice-from-quotation', 'all others'] };
  report.ready = problems.length === 0;
  if (!options.execute) return report;
  if (problems.length) throw new Refused(problems);

  // ---- execute: everything above is re-checked, then the storage and the Deal, BEFORE the first write -------------------------------------
  const { caseId } = inspected.target;
  const probeKey = `quotations/case-${caseId}/preflight-probe.pdf`;
  try { await deps.s3Probe(probeKey); } catch (err) { throw new Refused(`storage_unreachable_${(err && err.code) || 'error'}`); } // a HEAD of a key that does not exist: proves bucket and credentials

  const { resolveProfile } = require('../../src/modules/bitrix/bitrix-profiles');
  const { dealProblem, isClosedStage } = require('../../src/modules/bitrix/bitrix-profile-runtime');
  const { readQuotationSignature, NO_FILE } = require('../../src/modules/bitrix/quotation-outbox');
  const { parseQuotationMoney } = require('../../src/modules/bitrix/quotation-money');
  const profile = resolveProfile(workerEnv);
  const guard = deps.makeGuard(workerEnv.BITRIX_ALLOWED_PORTAL_HOST.trim().toLowerCase(), LIMITS);
  const api = makeGuardedApi(deps.realApi, guard, deps.gateway);

  const read = await api.getDeal(TARGET.dealId, { env: workerEnv });
  if (read.status !== 'ok') throw new Refused(`deal_read_${read.status}`);
  const deal = read.deal;
  const dealIssue = dealProblem(profile, deal, TARGET.dealId, TARGET.caseReference);
  if (dealIssue) throw new Refused(`deal_${dealIssue}`);
  if (isClosedStage(profile, deal.STAGE_ID)) throw new Refused('deal_closed');
  const signature = readQuotationSignature(deal, profile.quotationFields);
  if (signature.fileId === NO_FILE) throw new Refused('quotation_pdf_missing');
  if (signature.fileId === 'invalid') throw new Refused('quotation_pdf_field_unreadable');
  const money = parseQuotationMoney(signature.amountRaw, signature.currencyRaw);
  if (money.error) throw new Refused(`quotation_${money.error}`); // an invalid amount or currency would store a draft that can never be confirmed
  report.deal = { stageId: deal.STAGE_ID, quotationFileId: signature.fileId, amount: money.amount, currency: money.currency };

  // ---- writes start here -------------------------------------------------------------------------------------------------------------------
  const before = await snapshot(prisma, inspected.target);
  await verifyDatabase(prisma);
  const queued = await deps.services.detect(prisma, { id: caseId, referenceNumber: TARGET.caseReference }, deal, profile);
  report.detection = queued.reason;
  if (!queued.queued) throw new Refused(`detection_${queued.reason}`);

  const storageService = deps.createStorage();
  const sync = await deps.services.runSync({ prisma, api, env: workerEnv, log, storage: storageService, gateway: deps.gateway, scope: { caseIds: [caseId] } });
  report.sync = sync;
  const created = (sync.results || []).filter((r) => ['created', 'updated'].includes(r.outcome) && r.quotationId);
  if (created.length === 1) {
    const quotationId = created[0].quotationId;
    report.scan = await deps.services.sweep({ prisma, env: workerEnv, log, storage: storageService, caseIds: [caseId], quotationIds: [quotationId] });
    report.quotationId = quotationId;
  } else {
    report.scan = 'not run: the sync did not create exactly one quotation version';
  }

  const after = await snapshot(prisma, inspected.target);
  report.after = after;
  report.final = report.quotationId ? after.quotations.find((q) => q.id === report.quotationId) || null : null;
  report.bitrixCalls = { dealGet: guard.state.dealGet, itemGet: guard.state.itemGet, downloads: guard.state.download, refused: guard.state.refused };
  report.unexpected = unexpectedChanges(before, after);
  if (guard.state.refused.length) report.unexpected.push('bitrix_call_refused');
  report.succeeded = Boolean(report.final) && report.final.scan_status === 'clean' && report.unexpected.length === 0;
  return report;
}

module.exports = {
  TARGET, LIMITS, SWITCHES, Refused, parseArgs, buildWorkerEnv, environmentProblems, storageProblems, verifyDatabase, inspectTarget, snapshot, unexpectedChanges, makeGuardedApi, run,
};
