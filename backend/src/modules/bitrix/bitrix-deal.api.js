// Bitrix24 Deal API client (crm.deal.add, crm.deal.list). A separate module from bitrix.service.js, whose Lead
// behaviour is untouched. It uses the same inbound webhook (BITRIX24_WEBHOOK_URL, read at call time) and the same
// 15 s timeout policy, but it classifies EVERY failure, because for a Deal the difference matters:
//
//   outcome "definitive"  Bitrix (or our own guard) refused the call, or it never left this server: no Deal was
//                         created. Safe to record as a failure.
//   outcome "ambiguous"   the request may have reached Bitrix and the Deal may exist: a timeout, a lost
//                         connection, a 5xx, an unreadable answer, or a success answer without a usable Deal ID.
//                         The caller must NEVER repeat crm.deal.add; it reconciles by reference instead.
//
// Nothing here logs or returns the webhook URL, a token, a phone number or patient data: errors carry a short
// code and, for Bitrix API errors, Bitrix's own error code and a sanitised, truncated description.
const { isPrivateCharterDealEnabled } = require('./bitrix-config');
const { DEAL, FIELD } = require('./bitrix-deal');

const REQUEST_TIMEOUT_MS = 15000; // same policy as bitrix.service.js
const MAX_DETAIL = 200;

class BitrixDealCallError extends Error {
  constructor(outcome, code, detail) {
    super(detail ? `Bitrix24 Deal call: ${code} (${detail})` : `Bitrix24 Deal call: ${code}`);
    this.name = 'BitrixDealCallError';
    this.outcome = outcome; // "definitive" | "ambiguous"
    this.code = code;
  }
}

// Bitrix's description is shown to operators in last_error, so strip anything URL-like and cap its length.
function safeDetail(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
}

// Connection failures that happen before any byte reaches Bitrix: the Deal cannot exist.
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

async function post(method, payload, { env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  if (!isPrivateCharterDealEnabled(env)) throw new BitrixDealCallError('definitive', 'switch_off', 'a Bitrix switch is off');
  const base = env.BITRIX24_WEBHOOK_URL;
  if (!base) throw new BitrixDealCallError('definitive', 'webhook_not_configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetchImpl(`${base}${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await res.text(); // inside the timer: a stalled body is also a timeout
  } catch (err) {
    if (err && err.name === 'AbortError') throw new BitrixDealCallError('ambiguous', 'timeout', `${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    const code = err && (err.code || (err.cause && err.cause.code));
    if (NOT_SENT_CODES.has(code)) throw new BitrixDealCallError('definitive', 'not_sent', code);
    throw new BitrixDealCallError('ambiguous', 'network_error', typeof code === 'string' ? code : '');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const status = res.status;

  if (status >= 500 || status === 408) throw new BitrixDealCallError('ambiguous', 'server_error', `HTTP ${status}`);
  if (data && typeof data === 'object' && data.error) {
    // Bitrix answered with an API error (bad field, no permission, rate limit...): it rejected the call.
    throw new BitrixDealCallError('definitive', 'bitrix_error', `HTTP ${status} ${safeDetail(String(data.error))}: ${safeDetail(data.error_description)}`);
  }
  if (!res.ok) throw new BitrixDealCallError('definitive', 'http_error', `HTTP ${status}`);
  if (data === null || typeof data !== 'object') throw new BitrixDealCallError('ambiguous', 'unreadable_response');
  if (data.result === undefined || data.result === null) throw new BitrixDealCallError('ambiguous', 'no_result');
  return data;
}

// The exact Deal ID as text. Accepts a positive whole number or a digit string; anything else (0, a float, an
// unsafe integer, an object, "007") is not a usable ID. It is never padded, trimmed or converted.
function exactDealId(result) {
  if (typeof result === 'number') return Number.isSafeInteger(result) && result > 0 ? String(result) : null;
  if (typeof result === 'string') return /^[1-9]\d*$/.test(result) ? result : null;
  return null;
}

// Creates ONE Deal from `fields` (build them with buildDealFields). Resolves { dealId } (string). Rejects with
// BitrixDealCallError (see outcome above). The caller owns idempotency: call it at most once per event.
async function createDeal(fields, options) {
  const data = await post('crm.deal.add', { fields }, options);
  const dealId = exactDealId(data.result);
  // Bitrix said OK but gave no usable ID: the Deal may well exist, so this is ambiguous, not a failure.
  if (dealId === null) throw new BitrixDealCallError('ambiguous', 'invalid_deal_id');
  return { dealId };
}

// Looks for Deals in Category 38 whose Primary Deal Reference is EXACTLY `reference`.
// Resolves { status, dealIds, stageId } (stageId only for a single match):
//   "single"     exactly one verified match
//   "multiple"   two or more distinct verified matches
//   "none"       a clean, complete, empty answer
//   "uncertain"  anything else: the lookup failed, the answer was truncated (a next page exists), or Bitrix
//                returned Deals that do not carry the reference (the filter may not be honoured). Never "none".
// Bitrix's filter is only a request; every returned Deal is re-checked here for category and exact reference.
async function findDealsByReference(reference, options) {
  if (typeof reference !== 'string' || reference === '' || reference !== reference.trim()) {
    return { status: 'uncertain', dealIds: [], reason: 'reference_invalid' };
  }
  let data;
  try {
    data = await post('crm.deal.list', {
      filter: { CATEGORY_ID: DEAL.CATEGORY_ID, [`=${FIELD.REFERENCE}`]: reference },
      select: ['ID', 'CATEGORY_ID', 'STAGE_ID', FIELD.REFERENCE],
      order: { ID: 'ASC' },
      start: 0,
    }, options);
  } catch (err) {
    return { status: 'uncertain', dealIds: [], reason: err.code || 'lookup_failed' };
  }
  if (!Array.isArray(data.result)) return { status: 'uncertain', dealIds: [], reason: 'unexpected_shape' };
  if (data.next !== undefined && data.next !== null) return { status: 'uncertain', dealIds: [], reason: 'truncated' };

  const verified = new Map(); // exact Deal ID -> its stage
  for (const deal of data.result) {
    const id = deal && exactDealId(deal.ID);
    if (id !== null && id !== undefined && String(deal.CATEGORY_ID) === String(DEAL.CATEGORY_ID) && deal[FIELD.REFERENCE] === reference) verified.set(id, typeof deal.STAGE_ID === 'string' ? deal.STAGE_ID : null);
  }
  if (data.result.length > 0 && verified.size === 0) return { status: 'uncertain', dealIds: [], reason: 'filter_not_honoured' };
  const dealIds = [...verified.keys()];
  if (dealIds.length === 0) return { status: 'none', dealIds };
  return { status: dealIds.length === 1 ? 'single' : 'multiple', dealIds, stageId: dealIds.length === 1 ? verified.get(dealIds[0]) : null };
}

// Reads ONE Deal's current state (crm.deal.get). Resolves { status, deal }:
//   "ok"         the Deal, exactly as Bitrix returned it
//   "not_found"  Bitrix says there is no such Deal
//   "uncertain"  anything else (switch off, timeout, error, unexpected shape): try again later
// The caller must verify category and reference itself; nothing here trusts the Deal.
async function getDeal(dealId, options) {
  if (!/^[1-9]\d*$/.test(String(dealId))) return { status: 'uncertain', reason: 'deal_id_invalid' };
  try {
    const data = await post('crm.deal.get', { id: String(dealId) }, options);
    if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) return { status: 'uncertain', reason: 'unexpected_shape' };
    return { status: 'ok', deal: data.result };
  } catch (err) {
    if (err instanceof BitrixDealCallError && err.outcome === 'definitive' && /NOT_FOUND/i.test(err.message)) return { status: 'not_found' };
    return { status: 'uncertain', reason: (err && err.code) || 'lookup_failed' };
  }
}

module.exports = { createDeal, findDealsByReference, getDeal, BitrixDealCallError, exactDealId, REQUEST_TIMEOUT_MS };
