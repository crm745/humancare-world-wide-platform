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
const { isPrivateCharterDealEnabled, bitrixHostProblem } = require('./bitrix-config');
const { DEAL, FIELD, DOCUMENTS_FIELD } = require('./bitrix-deal');

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
  // Before ANY request leaves this server: the webhook's host must be the allowed portal (see bitrix-config.js).
  const hostProblem = bitrixHostProblem(env, base);
  if (hostProblem) throw new BitrixDealCallError('definitive', 'host_not_allowed', hostProblem);

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

// ---- the Deal's Documents file field (UF_CRM_1794832401, multiple) ------------------------------------------------------------
// The field value as exact file ids. A multiple file field is a list of file objects ({ id, ... }); with no files it may be missing,
// empty, false or null. Any other shape is NOT guessed at (null = unreadable), so an update is never built on a misread list.
function fileIdsOf(value) {
  if (value === undefined || value === null || value === false || value === '') return [];
  if (!Array.isArray(value)) return null;
  const ids = [];
  for (const entry of value) {
    const id = exactDealId(entry && typeof entry === 'object' ? entry.id : entry);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

// The Documents field is read and written through the UNIVERSAL CRM methods (crm.item.get / crm.item.update, entityTypeId 2 = Deal), not
// the legacy crm.deal.update: the legacy method is deprecated, Bitrix does not recommend it for file fields, and a legacy update that
// listed the existing file as { id: "65608" } replaced the whole field with only the new file (verified against the live portal).
// What was verified against the portal (read-only): the field is type "file", multiple, its original name is UF_CRM_1794832401 and its
// camelCase key is ufCrm_1794832401; crm.item.get returns the existing files as objects with a NUMERIC id.
//   * READ  uses useOriginalUfNames "Y": the Deal comes back with the original UF_CRM_ names (the spelling used everywhere else here).
//   * WRITE uses useOriginalUfNames "N" and the verified camelCase key. A retained file is { id: <number> }, a new file is the documented
//     pair [name, base64]; a file whose id is left out of the list is deleted by Bitrix without warning, so every file to keep is listed.
const DEAL_ENTITY_TYPE_ID = 2;
const DOCUMENTS_ITEM_KEY = 'ufCrm_1794832401'; // DOCUMENTS_FIELD in camelCase, as crm.item.fields reports it

// Reads the ids of the files on a Deal's Documents field (crm.item.get). Resolves { status, ids } ("ok" with the exact ids, in Bitrix's
// order), "not_found", or "uncertain" (switch off, timeout, error, a different Deal, an unreadable shape): try again later.
async function getDealFiles(dealId, options) {
  if (!/^[1-9]\d*$/.test(String(dealId)) || !Number.isSafeInteger(Number(dealId))) return { status: 'uncertain', reason: 'deal_id_invalid' };
  let data;
  try {
    data = await post('crm.item.get', { entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(dealId), useOriginalUfNames: 'Y' }, options);
  } catch (err) {
    if (err instanceof BitrixDealCallError && err.outcome === 'definitive' && /NOT_FOUND/i.test(err.message)) return { status: 'not_found' };
    return { status: 'uncertain', reason: (err && err.code) || 'lookup_failed' };
  }
  const item = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result.item : null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { status: 'uncertain', reason: 'unexpected_shape' };
  if (String(item.id) !== String(dealId)) return { status: 'uncertain', reason: 'wrong_deal' };
  const ids = fileIdsOf(item[DOCUMENTS_FIELD]);
  if (ids === null) return { status: 'uncertain', reason: 'unexpected_files_shape' };
  return { status: 'ok', ids };
}

// Sets the Deal's Documents field to `entries` (crm.item.update): { id } to KEEP a file that is already there (sent as { id: <number> }),
// { fileData: [name, base64] } to add one (sent as the pair [name, base64]). Bitrix sets the whole list, so the caller must always send
// every file it wants to keep. Resolves { ok: true }; rejects with BitrixDealCallError (definitive: Bitrix refused, nothing changed;
// ambiguous: the update may have been applied, including an answer that does not look like the documented one).
// An empty list is sent only with allowEmpty (the caller has proved the field held nothing else).
async function updateDealFiles(dealId, entries, options = {}) {
  if (!/^[1-9]\d*$/.test(String(dealId)) || !Number.isSafeInteger(Number(dealId))) throw new BitrixDealCallError('definitive', 'deal_id_invalid');
  if (!Array.isArray(entries) || (entries.length === 0 && !options.allowEmpty)) throw new BitrixDealCallError('definitive', 'file_list_invalid');
  const kept = new Set();
  const list = entries.map((entry) => {
    const keepId = entry && typeof entry === 'object' && entry.fileData === undefined ? exactDealId(entry.id) : null;
    if (keepId !== null && Number.isSafeInteger(Number(keepId))) {
      if (kept.has(keepId)) throw new BitrixDealCallError('definitive', 'file_entry_duplicate');
      kept.add(keepId);
      return { id: Number(keepId) };
    }
    const add = entry && typeof entry === 'object' && entry.id === undefined && Array.isArray(entry.fileData) && entry.fileData.length === 2
      && typeof entry.fileData[0] === 'string' && entry.fileData[0] !== '' && typeof entry.fileData[1] === 'string' && entry.fileData[1] !== '';
    if (!add) throw new BitrixDealCallError('definitive', 'file_entry_invalid');
    return [entry.fileData[0], entry.fileData[1]];
  });
  const { allowEmpty, ...callOptions } = options; // eslint-disable-line no-unused-vars
  const data = await post('crm.item.update', {
    entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(dealId), useOriginalUfNames: 'N', fields: { [DOCUMENTS_ITEM_KEY]: list },
  }, callOptions);
  // The documented answer is { result: { item: {...} } } for this Deal. Anything else may still have been applied: never a failure.
  const item = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result.item : null;
  if (!item || typeof item !== 'object' || String(item.id) !== String(dealId)) throw new BitrixDealCallError('ambiguous', 'unexpected_result');
  return { ok: true };
}

module.exports = {
  createDeal, findDealsByReference, getDeal, getDealFiles, updateDealFiles, fileIdsOf, BitrixDealCallError, exactDealId, REQUEST_TIMEOUT_MS,
  DEAL_ENTITY_TYPE_ID, DOCUMENTS_ITEM_KEY,
};
