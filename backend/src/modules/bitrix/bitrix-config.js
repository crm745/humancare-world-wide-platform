// Master switch for sending anything to the real Bitrix24 CRM. OFF unless .env says
// exactly BITRIX_SYNC_ENABLED=true — a missing or misspelled value keeps it off, so
// nothing reaches the CRM by accident.
//
// While off, new requests/cases are simply not synced (no failure is recorded and the
// retry job does nothing), so turning it on later sends only what's created from then
// on, never a backlog from the off period.
function isBitrixSyncEnabled(env = process.env) {
  return env.BITRIX_SYNC_ENABLED === 'true';
}

// Private Charter Deal integration (Category 38). A SECOND switch, OFF unless it says exactly
// BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true (same convention: missing or misspelled keeps it off).
//
//   isPrivateCharterDealRequested()  the switch itself. When it is on, Private Charter never creates or
//                                    retries a legacy Bitrix Lead (see requests.service.js and
//                                    bitrix-retry.service.js); Corporate and every other service keep theirs.
//   isPrivateCharterDealEnabled()    the switch AND the master switch. This is what the future Deal worker
//                                    must check before it claims or sends anything: while it is false the
//                                    worker stays idle. The Deal link and the "bitrix.deal.create" outbox
//                                    event written at submission stay in the database untouched, so nothing
//                                    is lost while the switch is off; they are sent once it is turned on.
//
// The Deal switch only means something together with the master switch and the request review workflow
// (the Case, link and event are written by that workflow). assertBitrixConfiguration refuses to start the
// API or the worker with an impossible combination.
function isPrivateCharterDealRequested(env = process.env) {
  return env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED === 'true';
}

function isPrivateCharterDealEnabled(env = process.env) {
  return isPrivateCharterDealRequested(env) && isBitrixSyncEnabled(env);
}

// What the Deal worker checks before it claims or sends anything: both Bitrix switches AND the review workflow
// (the Case, link and event only exist because of that workflow). While false the worker stays completely idle.
function isPrivateCharterDealWorkerActive(env = process.env) {
  return isPrivateCharterDealEnabled(env) && env.PRIVATE_CHARTER_REVIEW_WORKFLOW === 'true';
}

// Quotation synchronization (Phase 1). A THIRD switch, OFF unless it says exactly BITRIX_QUOTATION_SYNC_ENABLED=true.
// It only ever READS from Bitrix24 and stores the Deal's Quotation PDF as an unpublished draft; it needs everything the Deal
// worker needs. While it is off, nothing is detected, queued, fetched or scanned.
function isQuotationSyncRequested(env = process.env) {
  return env.BITRIX_QUOTATION_SYNC_ENABLED === 'true';
}

function isQuotationSyncActive(env = process.env) {
  return isQuotationSyncRequested(env) && isPrivateCharterDealWorkerActive(env);
}

// ---- which Bitrix24 portal may be contacted ----------------------------------------------------------------------------
// BITRIX_ALLOWED_PORTAL_HOST is a bare host name (no scheme, path or wildcard), for example "sandbox.example.bitrix24.in".
// The host of BITRIX24_WEBHOOK_URL must equal it EXACTLY, or nothing is sent. In a test environment (NODE_ENV=test) the
// allowlist is REQUIRED: .env.test may hold the live portal's webhook, so a test process can only reach Bitrix24 after
// someone has named the host on purpose. Outside tests it is optional (unset = no restriction, as before). Codes only,
// never the host value, so nothing sensitive reaches a log.
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function webhookHost(webhookUrl) {
  try {
    const url = new URL(String(webhookUrl));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// null when the webhook host may be used, otherwise a short reason code.
function bitrixHostProblem(env = process.env, webhookUrl = env.BITRIX24_WEBHOOK_URL) {
  const host = webhookHost(webhookUrl);
  if (!host) return 'webhook_host_invalid';
  const allowed = String(env.BITRIX_ALLOWED_PORTAL_HOST || '').trim().toLowerCase();
  if (!allowed) return env.NODE_ENV === 'test' ? 'allowlist_required_in_test' : null;
  if (!HOST_NAME.test(allowed)) return 'allowlist_invalid';
  return host === allowed ? null : 'host_not_allowed';
}

// The reasons the current settings cannot be used (empty when they can).
function bitrixConfigurationProblems(env = process.env) {
  const problems = [];
  // A configured webhook that is not on the allowlist is refused at start-up when any Bitrix switch is on.
  if ((isBitrixSyncEnabled(env) || isPrivateCharterDealRequested(env)) && env.BITRIX24_WEBHOOK_URL) {
    const hostProblem = bitrixHostProblem(env);
    if (hostProblem) problems.push(`The Bitrix24 webhook host is not allowed (${hostProblem}); set BITRIX_ALLOWED_PORTAL_HOST to the portal that may be contacted.`);
  }
  if (isPrivateCharterDealRequested(env)) {
    if (!isBitrixSyncEnabled(env)) {
      problems.push('BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true needs BITRIX_SYNC_ENABLED=true.');
    }
    if (env.PRIVATE_CHARTER_REVIEW_WORKFLOW !== 'true') {
      problems.push('BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true needs PRIVATE_CHARTER_REVIEW_WORKFLOW=true.');
    }
  }
  if (isQuotationSyncRequested(env) && !isPrivateCharterDealRequested(env)) {
    problems.push('BITRIX_QUOTATION_SYNC_ENABLED=true needs BITRIX_PRIVATE_CHARTER_DEAL_ENABLED=true (and so BITRIX_SYNC_ENABLED=true and PRIVATE_CHARTER_REVIEW_WORKFLOW=true).');
  }
  return problems;
}

// Called once when the API or the worker starts. Throws, with every problem named, instead of letting the
// process run with Private Charter neither creating Leads nor able to create Deals.
function assertBitrixConfiguration(env = process.env) {
  const problems = bitrixConfigurationProblems(env);
  if (problems.length) throw new Error(`Bitrix24 settings are not valid: ${problems.join(' ')}`);
}

module.exports = {
  isBitrixSyncEnabled,
  isPrivateCharterDealRequested,
  isPrivateCharterDealEnabled,
  isPrivateCharterDealWorkerActive,
  isQuotationSyncRequested,
  isQuotationSyncActive,
  bitrixConfigurationProblems,
  assertBitrixConfiguration,
  webhookHost,
  bitrixHostProblem,
};
