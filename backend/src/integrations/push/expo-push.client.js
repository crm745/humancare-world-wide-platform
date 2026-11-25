// The Expo push HTTP client used by the push delivery worker (modules/notifications/push-delivery.service.js). It is separate from the legacy
// expo-push.service.js (a best-effort fire-and-forget send that reads no answer), which is left exactly as it is.
//
// What it does: sends ONE message (always as a one-element array: Expo answers an array with an array of tickets and a single object with a single
// ticket) and reads the answer; looks up receipts. It never throws for an Expo answer: it returns a classified outcome the worker acts on.
//
// Send outcomes, and why they are safe to act on:
//   accepted              Expo returned an "ok" ticket with an id (the receipt id). NOT proof the phone received it.
//   device_not_registered the ticket error DeviceNotRegistered: stop sending to this token.
//   retry                 Expo refused or could not process the request BEFORE accepting it, so a retry cannot duplicate a push:
//                         HTTP 429, HTTP 5xx, a MessageRateExceeded ticket, or a connection that could not even be opened.
//   unauthorized          HTTP 401/403: Expo rejected the ACCESS TOKEN. This is a configuration problem of the whole worker, not of one delivery:
//                         the worker pauses sending (push-delivery.service.js) and no delivery's attempt is used up for it.
//   failed                Expo refused it for good (other 4xx, MessageTooBig, MismatchSenderId, InvalidCredentials, any other ticket error).
//   uncertain             The request may have reached Expo and the result cannot be known: our own timeout, a connection that dropped after it was
//                         opened, an answer that is not what the API documents. NEVER retried automatically.
// The Authorization header (the Expo access token) is attached to every request and is never part of any returned value or error.
// Nothing in a returned value can hold a push token: Expo's own messages quote tokens, so every message is scrubbed (scrub()).
//
// Test and synthetic runs: before ANY network call the environment is checked (suppressionReason). In such a run nothing is sent: the call throws.
const { suppressionReason } = require('../../modules/notifications/push-delivery.config');

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const PROBE_ID = '00000000-0000-0000-0000-000000000000'; // a receipt id that does not exist: used only to test the access token
const TICKET_ID_MAX = 191; // notification_deliveries.provider_message_id is VARCHAR(191)

// A connection that failed BEFORE any byte of the request could be sent (name resolution, refused or unreachable network, connect timeout).
const PRE_SEND_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

class PushNetworkSuppressedError extends Error {
  constructor(reason) {
    super(`Push network calls are suppressed (${reason}).`);
    this.name = 'PushNetworkSuppressedError';
    this.code = 'push_network_suppressed';
  }
}

// Expo's messages can quote the push token, and a message could in theory contain a URL: neither may reach the database or a log.
function scrub(text, max = 300) {
  if (text === undefined || text === null) return null;
  return String(text)
    .replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, '[token]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .slice(0, max);
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const safeCode = (value, fallback) => (typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function retryAfterSeconds(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) return null; // only the plain-seconds form; a date is ignored
  return Number(raw);
}

function createExpoPushClient({ accessToken, env = process.env, fetchImpl = (...args) => fetch(...args), timeoutMs = 15000 } = {}) {
  if (typeof accessToken !== 'string' || accessToken === '') throw new Error('The Expo push client needs an access token.');

  // One POST. Resolves { response } or { networkError: 'before_send' | 'unknown' | 'timeout' }; the Authorization header lives only here.
  async function post(url, payload) {
    const suppressed = suppressionReason(env);
    if (suppressed) throw new PushNetworkSuppressedError(suppressed);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let json = null;
      let parsed = false;
      try { json = await response.json(); parsed = true; } catch { /* the caller decides what an unreadable body means */ }
      return { response, json, parsed };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return { networkError: 'timeout' };
      const code = err && ((err.cause && err.cause.code) || err.code);
      return { networkError: PRE_SEND_ERROR_CODES.has(code) ? 'before_send' : 'unknown' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * message: { to, title, body, data?, channelId? }. Returns one of
   *   { outcome: 'accepted', ticketId }
   *   { outcome: 'device_not_registered', message }
   *   { outcome: 'retry', code, message?, retryAfterSeconds? }
   *   { outcome: 'unauthorized', status }
   *   { outcome: 'failed', code, message? }
   *   { outcome: 'uncertain', code }
   */
  async function sendMessage(message) {
    const sent = await post(SEND_URL, [{ ...message, sound: 'default' }]);
    if (sent.networkError === 'before_send') return { outcome: 'retry', code: 'network_unreachable' };
    if (sent.networkError === 'timeout') return { outcome: 'uncertain', code: 'timeout' };
    if (sent.networkError) return { outcome: 'uncertain', code: 'network_error' };

    const { response, json } = sent;
    const status = response.status;
    if (status === 429) return { outcome: 'retry', code: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response.headers) };
    if (status >= 500 && status <= 599) return { outcome: 'retry', code: 'expo_server_error', retryAfterSeconds: retryAfterSeconds(response.headers) };
    if (status === 401 || status === 403) return { outcome: 'unauthorized', status };
    if (status < 200 || status > 299) {
      const first = isPlainObject(json) && Array.isArray(json.errors) && isPlainObject(json.errors[0]) ? json.errors[0] : null;
      if (first && first.code === 'TOO_MANY_REQUESTS') return { outcome: 'retry', code: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response.headers) };
      return { outcome: 'failed', code: `expo_rejected_${status}`, message: first ? scrub(first.message) : null };
    }

    // HTTP 2xx: the API documents { data: [ticket] } for an array request. Anything else may still have been accepted: unknown outcome.
    if (!sent.parsed || !isPlainObject(json) || !Array.isArray(json.data) || json.data.length !== 1 || !isPlainObject(json.data[0])) {
      return { outcome: 'uncertain', code: 'malformed_response' };
    }
    const ticket = json.data[0];
    if (ticket.status === 'ok') {
      if (typeof ticket.id !== 'string' || ticket.id === '' || ticket.id.length > TICKET_ID_MAX) return { outcome: 'uncertain', code: 'ticket_id_invalid' };
      return { outcome: 'accepted', ticketId: ticket.id };
    }
    if (ticket.status === 'error') {
      const detail = isPlainObject(ticket.details) ? ticket.details.error : undefined;
      const message = scrub(ticket.message);
      if (detail === 'DeviceNotRegistered') return { outcome: 'device_not_registered', message };
      if (detail === 'MessageRateExceeded') return { outcome: 'retry', code: 'message_rate_exceeded', message };
      return { outcome: 'failed', code: safeCode(detail, 'ticket_error'), message };
    }
    return { outcome: 'uncertain', code: 'malformed_response' };
  }

  /**
   * ids: receipt ids (at most 1000). Returns
   *   { outcome: 'ok', receipts: Map<id, { status: 'ok' } | { status: 'error', code, message }> }   (ids Expo has no receipt for are absent)
   *   { outcome: 'unauthorized', status }                                                            (Expo rejected the access token)
   *   { outcome: 'unavailable', code }                                                               (look again later; nothing is concluded)
   */
  async function getReceipts(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) throw new Error('getReceipts needs 1 to 1000 receipt ids.');
    const got = await post(RECEIPTS_URL, { ids });
    if (got.networkError) return { outcome: 'unavailable', code: got.networkError === 'timeout' ? 'timeout' : 'network_error' };
    const { response, json } = got;
    if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized', status: response.status };
    if (response.status < 200 || response.status > 299) return { outcome: 'unavailable', code: `http_${response.status}` };
    if (!got.parsed || !isPlainObject(json) || !isPlainObject(json.data)) return { outcome: 'unavailable', code: 'malformed_response' };
    const receipts = new Map();
    for (const id of ids) {
      const receipt = json.data[id];
      if (receipt === undefined) continue;
      if (!isPlainObject(receipt)) continue; // an unreadable receipt is treated as not there yet
      if (receipt.status === 'ok') receipts.set(id, { status: 'ok' });
      else if (receipt.status === 'error') {
        const detail = isPlainObject(receipt.details) ? receipt.details.error : undefined;
        receipts.set(id, { status: 'error', code: safeCode(detail, 'receipt_error'), message: scrub(receipt.message) });
      }
    }
    return { outcome: 'ok', receipts };
  }

  /**
   * Asks Expo whether the access token is accepted, WITHOUT involving any delivery: one receipt lookup for an id that cannot exist. Expo answers
   * an empty receipt map to an authorised caller and 401/403 to a rejected one. Resolves
   *   { outcome: 'valid' }       Expo did not reject the token (it answered normally)
   *   { outcome: 'rejected', status }   HTTP 401/403
   *   { outcome: 'unknown', code }      the answer says nothing about the token (network failure, timeout, 5xx, 429): ask again later
   */
  async function verifyCredentials() {
    const got = await post(RECEIPTS_URL, { ids: [PROBE_ID] });
    if (got.networkError) return { outcome: 'unknown', code: got.networkError === 'timeout' ? 'timeout' : 'network_error' };
    const status = got.response.status;
    if (status === 401 || status === 403) return { outcome: 'rejected', status };
    if (status >= 200 && status < 300) return { outcome: 'valid' };
    return { outcome: 'unknown', code: `http_${status}` };
  }

  return { sendMessage, getReceipts, verifyCredentials };
}

module.exports = { createExpoPushClient, PushNetworkSuppressedError, scrub, SEND_URL, RECEIPTS_URL, PRE_SEND_ERROR_CODES };
