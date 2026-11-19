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
const crypto = require('crypto');
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

// ---- a SINGLE-file field and its download (the Quotation PDF, UF_CRM_1794985313) -----------------------------------------------------
// Verified read-only against the Test Pipeline portal: the field is type "file", NOT multiple, and crm.item.get (useOriginalUfNames "Y")
// returns it as ONE object { id (number), url, urlMachine }, or null when empty. fileIdsOf() above is for LIST fields and is not used.
// The object has no file name and no size: those come from the download itself. `urlMachine` is the download link and it carries its
// own authorisation, so it is treated like a credential: it is never logged, stored, put in an error, or sent to a client.
const FILE_FIELD_NAME = /^UF_CRM_[A-Za-z0-9_]{1,60}$/;
const DOWNLOAD_TIMEOUT_MS = 30000; // the whole download, body included (a 10 MB file does not fit the 15 s API timeout)
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // the same cap as every other upload

// Reads ONE single-file field of a Deal (crm.item.get). Resolves { status, file }:
//   "ok"         file is null (the field is empty) or { id (exact text), urlMachine }. urlMachine is NOT enumerable, so logging,
//                JSON.stringify and spreading the object cannot leak it; downloadBitrixFile reads it directly.
//   "not_found"  Bitrix says there is no such Deal
//   "uncertain"  anything else (switch off, timeout, error, a different Deal, the field absent from the answer, an object that is not a
//                usable file): nothing is guessed, try again later
async function getDealFileField(dealId, fieldName, options) {
  if (!/^[1-9]\d*$/.test(String(dealId)) || !Number.isSafeInteger(Number(dealId))) return { status: 'uncertain', reason: 'deal_id_invalid' };
  if (typeof fieldName !== 'string' || !FILE_FIELD_NAME.test(fieldName)) return { status: 'uncertain', reason: 'field_name_invalid' };
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
  // Bitrix returns an empty field as an explicit null. A key that is not in the answer at all is not "empty": it may be a wrong
  // field name or a permission problem, so it is not read as "no file".
  if (!Object.prototype.hasOwnProperty.call(item, fieldName)) return { status: 'uncertain', reason: 'field_not_in_answer' };
  const value = item[fieldName];
  if (value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0)) return { status: 'ok', file: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { status: 'uncertain', reason: 'unexpected_file_shape' };
  const id = exactDealId(value.id);
  if (id === null || typeof value.urlMachine !== 'string' || value.urlMachine === '') return { status: 'uncertain', reason: 'unexpected_file_shape' };
  const file = { id };
  Object.defineProperty(file, 'urlMachine', { value: value.urlMachine, enumerable: false });
  return { status: 'ok', file };
}

// The download URL's problem as a short code, or null when it may be fetched. Nothing from the URL is put in the code.
//   https only; the host must EQUAL the configured portal's host (the webhook's, which must itself pass bitrixHostProblem);
//   no user name or password; no port other than the default 443; absolute URLs only.
function downloadUrlProblem(rawUrl, portalHost) {
  if (typeof rawUrl !== 'string' || rawUrl === '' || rawUrl !== rawUrl.trim()) return 'download_url_invalid';
  let url;
  try { url = new URL(rawUrl); } catch { return 'download_url_invalid'; }
  if (url.protocol !== 'https:') return 'download_not_https';
  if (url.username || url.password) return 'download_userinfo_rejected';
  if (url.port !== '') return 'download_port_rejected'; // the WHATWG parser drops an explicit :443, so any remaining port is not 443
  if (url.hostname.toLowerCase() !== portalHost) return 'download_host_not_allowed';
  return null;
}

// A structural check of PDF bytes, beyond the type the server claimed. It is NOT a full parser and it never renders or executes the file;
// the virus scan and the later review still apply. Checks: the header "%PDF-1.x" / "%PDF-2.x" at byte 0; "%%EOF" in the last KiB; a
// "startxref <offset>" in the tail whose offset lies inside the file and points at a classic table ("xref") or an object ("n g obj",
// which is how a cross-reference STREAM starts). Resolves { ok: true } or { ok: false, code }.
function validatePdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, code: 'empty_file' };
  if (!/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('latin1'))) return { ok: false, code: 'not_pdf_header' };
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  if (!tail.includes('%%EOF')) return { ok: false, code: 'missing_eof_marker' };
  const marks = [...tail.matchAll(/startxref\s+(\d{1,12})\s*(?:\r?\n|\r|\s)*%%EOF/g)];
  if (marks.length === 0) return { ok: false, code: 'missing_startxref' };
  const offset = Number(marks[marks.length - 1][1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.length) return { ok: false, code: 'startxref_out_of_range' };
  const at = bytes.subarray(offset, offset + 40).toString('latin1');
  if (!/^(?:xref|\d+\s+\d+\s+obj)/.test(at)) return { ok: false, code: 'startxref_target_invalid' };
  return { ok: true };
}

const redirectRejection = (err) => /redirect/i.test(String(err && err.message)) || /redirect/i.test(String(err && err.cause && err.cause.message));

// Downloads the file of a Deal's single-file field (the object getDealFileField returned) and resolves
// { bytes (Buffer), contentType, byteCount, sha256 }. The bytes are held in memory only; nothing is written anywhere. Rejects with a
// BitrixDealCallError whose code is short and never contains the URL or anything from the response body. "definitive": the file was
// refused and retrying cannot help (bad URL, host, port, redirect, too large, not a PDF, a 4xx answer); "ambiguous": a timeout, a lost
// connection or a 5xx, so a later retry may succeed. A download changes nothing in Bitrix, so repeating one is always safe.
// SAFETY: it uses urlMachine ONLY, sends no credentials of its own, rejects every redirect (a redirect target is never followed), and
// is bound to the same switches and portal allowlist as every other call in this file.
async function downloadBitrixFile(fileObject, { env = process.env, fetchImpl = (...args) => fetch(...args), timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  if (!isPrivateCharterDealEnabled(env)) throw new BitrixDealCallError('definitive', 'switch_off', 'a Bitrix switch is off');
  const base = env.BITRIX24_WEBHOOK_URL;
  if (!base) throw new BitrixDealCallError('definitive', 'webhook_not_configured');
  const hostProblem = bitrixHostProblem(env, base);
  if (hostProblem) throw new BitrixDealCallError('definitive', 'host_not_allowed', hostProblem);
  const portalHost = new URL(base).hostname.toLowerCase();

  if (!fileObject || typeof fileObject !== 'object' || Array.isArray(fileObject) || exactDealId(fileObject.id) === null) {
    throw new BitrixDealCallError('definitive', 'file_object_invalid');
  }
  const urlProblem = downloadUrlProblem(fileObject.urlMachine, portalHost);
  if (urlProblem) throw new BitrixDealCallError('definitive', urlProblem);

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { // rejects when the whole download has taken too long, a stalled body included
    timer = setTimeout(() => { controller.abort(); reject(new BitrixDealCallError('ambiguous', 'timeout', `download timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
  });
  deadline.catch(() => {}); // never an unhandled rejection when the download finishes first
  let reader = null;
  try {
    let res;
    try {
      res = await Promise.race([fetchImpl(fileObject.urlMachine, { method: 'GET', redirect: 'error', signal: controller.signal }), deadline]);
    } catch (err) {
      if (err instanceof BitrixDealCallError) throw err;
      if (err && err.name === 'AbortError') throw new BitrixDealCallError('ambiguous', 'timeout', `download timed out after ${timeoutMs / 1000}s`);
      if (redirectRejection(err)) throw new BitrixDealCallError('definitive', 'redirect_rejected');
      const code = err && (err.code || (err.cause && err.cause.code));
      throw new BitrixDealCallError('ambiguous', 'network_error', typeof code === 'string' ? code : ''); // never err.message: it could name the URL
    }

    if (!res || res.redirected === true || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new BitrixDealCallError('definitive', 'redirect_rejected');
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new BitrixDealCallError('ambiguous', 'server_error', `HTTP ${res.status}`);
    if (res.status !== 200) throw new BitrixDealCallError('definitive', 'http_error', `HTTP ${res.status}`);

    const declared = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    if (declared !== null && declared !== undefined && /^\d+$/.test(String(declared)) && Number(declared) > maxBytes) {
      throw new BitrixDealCallError('definitive', 'file_too_large', `declared length above ${maxBytes} bytes`);
    }

    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        total += value.length;
        if (total > maxBytes) throw new BitrixDealCallError('definitive', 'file_too_large', `body above ${maxBytes} bytes`); // stops reading at once
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } else if (res.body) {
      throw new BitrixDealCallError('ambiguous', 'unreadable_response'); // no stream to read: never buffer an unbounded body
    }

    const bytes = Buffer.concat(chunks, total);
    const verdict = validatePdf(bytes);
    if (!verdict.ok) throw new BitrixDealCallError('definitive', 'invalid_pdf', verdict.code);
    const type = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null;
    return {
      bytes,
      contentType: typeof type === 'string' ? safeDetail(type).slice(0, 100) : null, // recorded, never trusted: the bytes decided
      byteCount: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    clearTimeout(timer);
    if (reader) reader.cancel().catch(() => {}); // a no-op after a complete read; stops the transfer after an abort or an overrun
  }
}

module.exports = {
  createDeal, findDealsByReference, getDeal, getDealFiles, updateDealFiles, fileIdsOf, BitrixDealCallError, exactDealId, REQUEST_TIMEOUT_MS,
  DEAL_ENTITY_TYPE_ID, DOCUMENTS_ITEM_KEY,
  getDealFileField, downloadBitrixFile, validatePdf, downloadUrlProblem, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES,
};
