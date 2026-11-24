// The logic behind scripts/e2e-worker.js, the GUARDED Deal worker for the test database. Pure functions and injected
// dependencies, so it is unit-tested without a database or a network. Nothing here runs by itself.
//
// What the harness guarantees (each point has a test):
//   * SCOPE: it works only on the Cases named with --case-ids. The worker's candidate query, its lease recovery and its
//     failure alerts are all limited to them (deal-outbox.store.js, deal-worker.service.js). The inbox, reconcile and Lead
//     jobs are never started. Every named Case must be an APPROVED Private Charter request with a pending (or ambiguous)
//     Deal event; a Case that holds a protected event (411) is refused outright.
//   * FAKE BY DEFAULT: the Bitrix24 API is an in-memory fake that returns fake Deal ids, no webhook is visible to the
//     worker, and global fetch is replaced by a function that refuses every call while the pass runs.
//   * LIVE ONLY ON PURPOSE: --live needs BITRIX_ALLOWED_PORTAL_HOST to equal the webhook's host, and refuses the host the
//     development .env targets (the live portal). The real client also checks the host before every request.
//   * DRY RUN BY DEFAULT: without --execute nothing is claimed or written; the plan is printed.
const dotenv = require('dotenv');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { PROTECTED_ROWS } = require('../../common/safety/scoped-test-run');
const { webhookHost, bitrixHostProblem } = require('./bitrix-config');

const MAX_CASES = 10;
const FIRST_FAKE_DEAL_ID = 9000000001;
const FIRST_FAKE_FILE_ID = 7000000001; // fake file ids, in a range no real file has

class HarnessError extends Error {
  constructor(message) {
    super(`Guarded Deal worker: ${message}`);
    this.name = 'HarnessError';
  }
}
const refuse = (message) => new HarnessError(message);

// ---- command line ------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { caseIds: null, live: false, execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') out.live = true;
    else if (arg === '--execute') out.execute = true;
    else if (arg === '--case-ids') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) throw refuse('--case-ids needs a comma-separated list of Case ids.');
      i += 1;
      const parts = value.split(',').map((part) => part.trim());
      if (parts.some((part) => !/^[1-9]\d{0,9}$/.test(part))) throw refuse('--case-ids must be positive whole Case ids.');
      out.caseIds = [...new Set(parts.map(Number))];
    } else {
      throw refuse(`unknown argument "${String(arg).slice(0, 30)}". Use --case-ids <ids> [--execute] [--live].`);
    }
  }
  if (!out.caseIds) throw refuse('--case-ids is required: the worker never runs without an explicit scope.');
  if (out.caseIds.length > MAX_CASES) throw refuse(`at most ${MAX_CASES} Cases can be named.`);
  return out;
}

// ---- the fake Bitrix24 API -----------------------------------------------------------------------------------------------
// Same shape as bitrix-deal.api.js. It never reads the webhook or the network; it records what it was asked.
function makeFakeBitrixApi({ firstDealId = FIRST_FAKE_DEAL_ID, firstFileId = FIRST_FAKE_FILE_ID } = {}) {
  const calls = [];
  const dealFiles = new Map(); // dealId -> the file ids on the fake Deal's Documents field, in order
  let next = firstDealId;
  let nextFile = firstFileId;
  return {
    isFake: true,
    calls,
    dealFiles,
    // The Documents field behaves like Bitrix's multiple file field: an update REPLACES the whole list; { id } keeps a file.
    getDealFiles: async (dealId) => {
      calls.push({ method: 'crm.item.get', dealId: String(dealId) });
      return { status: 'ok', ids: [...(dealFiles.get(String(dealId)) || [])] };
    },
    updateDealFiles: async (dealId, entries) => {
      calls.push({ method: 'crm.item.update', dealId: String(dealId), keeps: entries.filter((e) => e.id).length, adds: entries.filter((e) => e.fileData).length });
      const ids = entries.map((entry) => { if (entry.id) return String(entry.id); const id = String(nextFile); nextFile += 1; return id; });
      dealFiles.set(String(dealId), ids);
      return { ok: true };
    },
    createDeal: async (fields) => {
      calls.push({ method: 'crm.deal.add', reference: fields && fields.TITLE });
      const dealId = String(next);
      next += 1;
      return { dealId };
    },
    findDealsByReference: async (reference) => {
      calls.push({ method: 'crm.deal.list', reference });
      return { status: 'none', dealIds: [] };
    },
    getDeal: async (dealId) => {
      calls.push({ method: 'crm.deal.get', dealId });
      return { status: 'uncertain', reason: 'fake_api' };
    },
  };
}

// While a fake pass runs, any attempt to reach the network fails at once.
function blockNetwork(target = globalThis) {
  const original = target.fetch;
  target.fetch = () => Promise.reject(new Error('Network access is disabled in the guarded Deal worker (fake Bitrix24 API).'));
  return () => { target.fetch = original; };
}

// The environment the worker is given. In memory only; process.env is never changed. In fake mode the webhook is blanked,
// so there is nothing to send to even by mistake.
function workerEnv(env, { live }) {
  return {
    ...env,
    BITRIX_SYNC_ENABLED: 'true',
    BITRIX_DEAL_PROFILE: 'test',
    BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true',
    PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
    ...(live ? {} : { BITRIX24_WEBHOOK_URL: '', BITRIX_INBOUND_APPLICATION_TOKEN: '' }),
  };
}

// ---- live mode -----------------------------------------------------------------------------------------------------------
// The host the DEVELOPMENT .env targets: that is the live portal. Read from the file text only; never printed.
function developmentWebhookHost(envFile, readFile) {
  let text;
  try { text = readFile(envFile); } catch { return null; }
  return webhookHost(dotenv.parse(text).BITRIX24_WEBHOOK_URL);
}

/** Throws unless the real Bitrix24 client may be used: an allowlist naming the webhook's host, and that host is not the live one. */
function assertLiveAllowed(env, liveHost) {
  if (!String(env.BITRIX_ALLOWED_PORTAL_HOST || '').trim()) throw refuse('--live needs BITRIX_ALLOWED_PORTAL_HOST (the portal that may be contacted).');
  const problem = bitrixHostProblem(env);
  if (problem) throw refuse(`--live refused: the webhook host is not allowed (${problem}).`);
  const host = webhookHost(env.BITRIX24_WEBHOOK_URL);
  if (liveHost && host === liveHost) throw refuse('--live refused: that is the live portal (the host the development .env targets). Use a sandbox portal.');
  return true;
}

// ---- which Cases may be processed ----------------------------------------------------------------------------------------
const ELIGIBLE_EVENT_STATUSES = new Set(['pending', 'ambiguous']);

/**
 * Read-only. Every named Case must exist, belong to an APPROVED Private Charter request without a Lead, have a Deal link
 * without a Deal yet, and have a pending or ambiguous Deal event; none of its events may be a protected one. Throws with
 * the Case id and a short code per problem (no patient data). Returns [{ caseId, requestId, eventId, eventStatus }].
 */
async function assertScopeEligible(db, caseIds, { protectedEventIds = PROTECTED_ROWS.integration_outbox } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT c.id AS case_id, c.service_request_id AS request_id, sr.service_key AS service_key, sr.review_status AS review_status,
            sr.bitrix_lead_id AS lead_id, l.id AS link_id, l.bitrix_deal_id AS deal_id, o.id AS event_id, o.status AS event_status
     FROM cases c
     LEFT JOIN service_requests sr ON sr.id = c.service_request_id
     LEFT JOIN bitrix_deal_links l ON l.case_id = c.id
     LEFT JOIN integration_outbox o ON o.case_id = c.id AND o.event_type = 'bitrix.deal.create'
     WHERE c.id IN (${caseIds.map(() => '?').join(', ')})
     ORDER BY c.id, o.id`,
    ...caseIds,
  );
  const problems = [];
  const summary = [];
  for (const caseId of caseIds) {
    const mine = rows.filter((row) => Number(row.case_id) === caseId);
    if (!mine.length) { problems.push(`case ${caseId}: not found`); continue; }
    const first = mine[0];
    if (first.request_id == null || first.service_key !== PRIVATE_CHARTER_KEY) problems.push(`case ${caseId}: not a Private Charter request Case`);
    else if (first.review_status !== 'approved') problems.push(`case ${caseId}: its request is not approved`);
    if (first.lead_id != null) problems.push(`case ${caseId}: its request has a Bitrix Lead`);
    if (first.link_id == null) problems.push(`case ${caseId}: no Deal link`);
    else if (first.deal_id != null) problems.push(`case ${caseId}: its Deal already exists`);
    const events = mine.filter((row) => row.event_id != null);
    if (events.some((row) => protectedEventIds.includes(Number(row.event_id)))) problems.push(`case ${caseId}: holds a protected event`);
    const usable = events.filter((row) => ELIGIBLE_EVENT_STATUSES.has(row.event_status));
    if (!usable.length) problems.push(`case ${caseId}: no pending or ambiguous Deal event`);
    else summary.push({ caseId, requestId: Number(first.request_id), eventId: Number(usable[0].event_id), eventStatus: usable[0].event_status });
  }
  if (problems.length) throw refuse(`the scope is not eligible (${problems.join('; ')}). Nothing was run.`);
  return summary;
}

module.exports = {
  HarnessError, MAX_CASES, FIRST_FAKE_DEAL_ID,
  parseArgs, makeFakeBitrixApi, blockNetwork, workerEnv, developmentWebhookHost, assertLiveAllowed, assertScopeEligible,
};
