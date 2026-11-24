// Synthetic E2E marker: a SIGNED, operator-created record (an append-only request_events row) that says "this exact request, owned by
// this exact account, in this exact database, is a synthetic test that may be approved automatically once its documents are clean".
//
// Only a signed `synthetic_e2e_marked` event can enable anything. The signature is an HMAC-SHA256 under SYNTHETIC_E2E_SECRET (a
// backend-only variable, at least 32 characters). Without the secret, or with a forged / tampered / copied row, nothing is enabled.
// Every OTHER event of this family (started, failed, expired, revoked, consumed, document approved) can only STOP or DELAY the process:
// forging one gives an attacker nothing, and a claim lease is measured from the event's own server timestamp, never from its payload.
//
// This file is pure (no database, no I/O) so the whole state machine can be tested. Nothing in the normal patient or admin flow imports it.
const crypto = require('crypto');

const ACTION = Object.freeze({
  MARKED: 'synthetic_e2e_marked',
  STARTED: 'synthetic_e2e_approval_started',
  DOC_APPROVED: 'synthetic_e2e_document_approved',
  FAILED: 'synthetic_e2e_approval_failed',
  CONSUMED: 'synthetic_e2e_consumed',
  REVOKED: 'synthetic_e2e_revoked',
  EXPIRED: 'synthetic_e2e_expired',
});
const ALL_ACTIONS = Object.freeze(Object.values(ACTION));
const TERMINAL = new Set([ACTION.CONSUMED, ACTION.REVOKED, ACTION.EXPIRED]);

const LIMITS = Object.freeze({
  DATABASE: 'humancare_dev',
  EXPIRY_MS: 24 * 60 * 60 * 1000,
  MAX_ACTIVE_MARKS: 3,
  MAX_REQUEST_AGE_MS: 6 * 60 * 60 * 1000,
  LEASE_MS: 5 * 60 * 1000,
  RETRY_SPACING_MS: 60 * 1000,
  MAX_FAILURES: 5,
  MIN_DOCUMENTS: 1,
  MAX_DOCUMENTS: 5,
  MIN_SECRET_LENGTH: 32,
  NAME_PREFIX: 'ZZ-SYNTHETIC',
  PRIVATE_CHARTER_KEY: 'privatecharter',
});
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// The database named by DATABASE_URL when it is a local URL, else null (fail closed).
function databaseOfUrl(url) {
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, ''))) return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

const secretOf = (env) => {
  const secret = env && env.SYNTHETIC_E2E_SECRET;
  return typeof secret === 'string' && secret.length >= LIMITS.MIN_SECRET_LENGTH ? secret : null;
};

// What is signed. Every field that matters is inside it, so a row copied to another request / owner / database, or edited, fails.
function signingText({ requestId, ownerUserId, adminId, expectedDocuments, runId, expiresAt }) {
  return `v1|${LIMITS.DATABASE}|request=${requestId}|owner=${ownerUserId}|admin=${adminId}|docs=${expectedDocuments}|run=${runId}|exp=${expiresAt}`;
}
const sign = (secret, fields) => crypto.createHmac('sha256', secret).update(signingText(fields)).digest('hex');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const isId = (v) => Number.isInteger(v) && v > 0;
const RUN_ID = /^[A-Za-z0-9_-]{3,40}$/;

// The payload to store in a new marked event.
function buildMark({ secret, requestId, ownerUserId, adminId, expectedDocuments, runId, now = Date.now() }) {
  const fields = { requestId, ownerUserId, adminId, expectedDocuments, runId, expiresAt: new Date(now + LIMITS.EXPIRY_MS).toISOString() };
  return { v: 1, runId, ownerUserId, adminId, expectedDocuments, expiresAt: fields.expiresAt, sig: sign(secret, fields) };
}

// A marked event's payload checked against the request it sits on. Returns the verified mark or null.
function verifyMark(event, { secret, requestId }) {
  if (!secret || !event || event.action !== ACTION.MARKED) return null;
  const d = event.detail;
  if (!d || d.v !== 1 || !isId(d.ownerUserId) || !isId(d.adminId) || !RUN_ID.test(String(d.runId))) return null;
  if (!Number.isInteger(d.expectedDocuments) || d.expectedDocuments < LIMITS.MIN_DOCUMENTS || d.expectedDocuments > LIMITS.MAX_DOCUMENTS) return null;
  const expires = Date.parse(d.expiresAt);
  if (!Number.isFinite(expires) || typeof d.expiresAt !== 'string') return null;
  if (!safeEqualHex(d.sig, sign(secret, { requestId, ownerUserId: d.ownerUserId, adminId: d.adminId, expectedDocuments: d.expectedDocuments, runId: d.runId, expiresAt: d.expiresAt }))) return null;
  return { runId: d.runId, ownerUserId: d.ownerUserId, adminId: d.adminId, expectedDocuments: d.expectedDocuments, expiresAt: d.expiresAt, expiresMs: expires, sig: d.sig, eventId: event.id };
}

/**
 * The state of one request's marker, derived from its events (ordered by id). Pure.
 *   { state: 'none' }                      no marked event at all
 *   { state: 'invalid' }                   marked events exist but none carries a valid signature (forged, tampered, wrong secret)
 *   { state: 'revoked' | 'consumed' | 'expired' }   terminal
 *   { state: 'active', mark, failures, lastFailureAt, claim }   claim = latest started event { token, at, live } or null
 * Only events that name THIS mark's signature (detail.markSig) count; the first valid mark is the mark ("one mark per request").
 */
function deriveState(events, { secret, requestId, now = Date.now() }) {
  const ordered = (events || []).filter((e) => e && ALL_ACTIONS.includes(e.action));
  const marked = ordered.filter((e) => e.action === ACTION.MARKED);
  if (marked.length === 0) return { state: 'none' };
  let mark = null;
  for (const event of marked) {
    mark = verifyMark(event, { secret, requestId });
    if (mark) break;
  }
  if (!mark) return { state: 'invalid' };

  const mine = ordered.filter((e) => e.action !== ACTION.MARKED && e.detail && e.detail.markSig === mark.sig && e.id > mark.eventId);
  const terminal = mine.find((e) => TERMINAL.has(e.action));
  if (terminal) return { state: terminal.action.replace('synthetic_e2e_', ''), mark };
  if (now > mark.expiresMs) return { state: 'expired', mark, recorded: false };

  const failures = mine.filter((e) => e.action === ACTION.FAILED);
  const started = mine.filter((e) => e.action === ACTION.STARTED);
  const last = started[started.length - 1];
  const occurred = (e) => new Date(e.occurredAt).getTime();
  // A failure RELEASES the claim it happened under (the run is over); the next attempt then only waits for the 60-second retry spacing.
  const released = last && failures.some((f) => f.id > last.id);
  const claim = last && !released && last.detail && typeof last.detail.token === 'string'
    ? { token: last.detail.token, at: occurred(last), live: now - occurred(last) < LIMITS.LEASE_MS && now >= occurred(last) - 1000, attempt: last.detail.attempt }
    : null;
  return {
    state: 'active', mark, claim,
    failures: failures.length,
    lastFailureAt: failures.length ? occurred(failures[failures.length - 1]) : null,
  };
}

// Is `token` the CURRENT holder of the claim? (Fencing: checked before every approval operation.)
const holdsClaim = (derived, token) => derived.state === 'active' && Boolean(derived.claim) && derived.claim.token === token && derived.claim.live;

// Number of marks (across requests) that are still active. `eventsByRequest`: Map(requestId -> events).
function countActiveMarks(eventsByRequest, { secret, now = Date.now() }) {
  let active = 0;
  for (const [requestId, events] of eventsByRequest) if (deriveState(events, { secret, requestId, now }).state === 'active') active += 1;
  return active;
}

module.exports = { ACTION, ALL_ACTIONS, TERMINAL, LIMITS, RUN_ID, databaseOfUrl, secretOf, sign, signingText, buildMark, verifyMark, deriveState, holdsClaim, countActiveMarks };
