// POST /integrations/razorpay/webhook : the Razorpay webhook RECEIVER. Public (no JWT): the request authenticates itself with an HMAC signature.
//
// RECEIPT ONLY. It verifies the signature, parses and validates the event, stores an allow-listed record in integration_inbox and answers. It
// never reads or writes a Payment, an Invoice or a Case and never calls Razorpay; applying the event is the worker's job (a later step). A mobile
// payment callback is never involved.
//
// This router is mounted in app.js BEFORE the global express.json(), and reads the body with express.raw() on this route only, so the signature
// is checked against the EXACT bytes Razorpay sent. Order: size limit -> configuration -> signature (on the raw bytes) -> parse -> validate ->
// store. The signature is verified before the JSON is ever parsed.
//
// Answers are fixed ({ ok: true } or { ok: false, code }) and never carry the body, the signature, the secret or any internal detail:
//   200  stored, duplicate, or an unknown/unusable event stored as "ignored"
//   400  no usable body, not JSON, or not an event envelope
//   401  signature missing, malformed or wrong (one answer for all of them: no oracle)
//   413  body over 256 KB
//   503  webhook not configured (the receiver is not ready; the sender retries)
//   500  storage (or any unexpected) failure: Razorpay retries
//
// Logging: short codes only. Never the body, the headers, the signature or the secret.
const crypto = require('crypto');
const express = require('express');
const { prisma } = require('../../db/prisma');
const { verifyWebhookSignature } = require('./razorpay-webhook.signature');
const { classifyEvent } = require('./razorpay-webhook.events');
const { storeEvent, bodyAlreadyStored } = require('./razorpay-webhook.inbox.store');

const MAX_BODY = '256kb'; // 262144 bytes
// The event id header is NOT signed, so it is never authentication; it is only a deduplication key. It must look like an identifier, otherwise the
// deterministic fingerprint of the signed body is used instead.
const EVENT_ID_HEADER = /^[A-Za-z0-9_.:-]{8,128}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

const ANSWER = Object.freeze({
  ok: { status: 200, body: { ok: true } },
  invalidBody: { status: 400, body: { ok: false, code: 'invalid_body' } },
  invalidSignature: { status: 401, body: { ok: false, code: 'invalid_signature' } },
  tooLarge: { status: 413, body: { ok: false, code: 'body_too_large' } },
  notConfigured: { status: 503, body: { ok: false, code: 'webhook_not_configured' } },
  internal: { status: 500, body: { ok: false, code: 'internal_error' } },
});

const safeCode = (err) => {
  const pick = (value) => (typeof value === 'string' && SAFE_CODE.test(value) ? value : null);
  return (err && (pick(err.code) || pick(err.type) || pick(err.name))) || 'error';
};

function send(res, answer) {
  res.set('Cache-Control', 'no-store');
  return res.status(answer.status).json(answer.body);
}

// UTF-8 text of the verified bytes, or null when they are not valid UTF-8 (a replacement character would silently change the content).
function decodeUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

function makeHandler({ db = prisma, env = process.env, log = console } = {}) {
  return async function receiveWebhook(req, res) {
    const raw = req.body;
    // 1-2. Configuration and signature, on the EXACT raw bytes. (An absent body is not a Buffer: the verifier refuses it.)
    const verdict = verifyWebhookSignature(raw, req.headers['x-razorpay-signature'], { env });
    if (!verdict.ok) {
      if (verdict.kind === 'configuration') { log.error(`[razorpay-webhook] not configured: ${verdict.code}`); return send(res, ANSWER.notConfigured); }
      if (verdict.kind === 'body') { log.warn(`[razorpay-webhook] rejected: ${verdict.code}`); return send(res, ANSWER.invalidBody); }
      if (verdict.kind === 'signature') { log.warn(`[razorpay-webhook] rejected: ${verdict.code}`); return send(res, ANSWER.invalidSignature); }
      log.error(`[razorpay-webhook] verification failed: ${verdict.code}`);
      return send(res, ANSWER.internal);
    }

    // 3. Only now, parse. The signature has proved these are Razorpay's bytes.
    const text = decodeUtf8(raw);
    let envelope;
    try { envelope = text === null ? undefined : JSON.parse(text); } catch { envelope = undefined; }
    if (envelope === undefined) { log.warn('[razorpay-webhook] rejected: body_not_json'); return send(res, ANSWER.invalidBody); }

    // 4. Identity: the SHA-256 of the signed bytes (always kept, as a fingerprint) and the event id.
    const bodySha256 = crypto.createHash('sha256').update(raw).digest('hex');
    const header = req.headers['x-razorpay-event-id'];
    const fromHeader = typeof header === 'string' && EVENT_ID_HEADER.test(header);
    const externalEventId = fromHeader ? header : `sha256:${bodySha256}`;

    // 5. Validate and allow-list.
    const event = classifyEvent(envelope, { bodySha256, eventIdSource: fromHeader ? 'header' : 'body_hash' });
    if (event.malformed) { log.warn(`[razorpay-webhook] rejected: ${event.code}`); return send(res, ANSWER.invalidBody); }

    // 6. Store. A duplicate (same event id, or the same signed body under another id header) is acknowledged without a second row.
    try {
      if (event.status === 'received' && await bodyAlreadyStored(db, { entityType: event.entityType, entityId: event.entityId, bodySha256 })) return send(res, ANSWER.ok);
      await storeEvent(db, {
        externalEventId, eventType: event.eventType, entityType: event.entityType, entityId: event.entityId,
        occurredAt: event.occurredAt, payload: event.payload, status: event.status, lastError: event.lastError,
      });
    } catch (err) {
      log.error(`[razorpay-webhook] could not store an event: ${safeCode(err)}`);
      return send(res, ANSWER.internal); // Razorpay retries
    }
    return send(res, ANSWER.ok);
  };
}

// Errors from the body reader (too large, an unsupported content encoding, an aborted upload). Fixed answers; the error itself is never sent or logged.
// eslint-disable-next-line no-unused-vars
function bodyErrorHandler(err, req, res, next) {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return send(res, ANSWER.tooLarge);
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) return send(res, ANSWER.invalidBody);
  console.error(`[razorpay-webhook] body error: ${safeCode(err)}`);
  return send(res, ANSWER.internal);
}

const razorpayWebhookRouter = express.Router();
razorpayWebhookRouter.post(
  '/webhook',
  // Any content type, no decompression (a compressed body is not what Razorpay signed), at most 256 KB. req.body becomes the raw Buffer.
  express.raw({ type: () => true, limit: MAX_BODY, inflate: false }),
  makeHandler(),
);
razorpayWebhookRouter.use(bodyErrorHandler);

module.exports = { razorpayWebhookRouter, makeHandler, bodyErrorHandler, MAX_BODY };
