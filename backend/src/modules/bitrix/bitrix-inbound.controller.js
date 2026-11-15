// POST /integrations/bitrix/deal-stage : the Bitrix24 event handler endpoint for Category 38 Deal changes.
//
// RECEIPT ONLY. This handler authenticates the call, validates its shape and stores a small record in
// integration_inbox; it never reads or writes a Case and never calls Bitrix. Processing is separate
// (deal-inbox.service.js) and always re-reads the Deal from Bitrix, so nothing in this payload (stage, category,
// reference) is trusted.
//
// AUTHENTICATION: Bitrix event handlers send `auth[application_token]`. It is compared, in constant time, with
// BITRIX_INBOUND_APPLICATION_TOKEN from the deployment secret store (never the outbound webhook URL). A missing,
// short or wrong token gets the same fixed 401, so nothing reveals whether the secret is configured.
//
// WHAT IS STORED: the event name, the Deal ID and Bitrix's timestamp only. The `auth` block, the rest of the
// payload and any field values are dropped, so no token, name or note is ever persisted or logged.
// Answers are fixed ({ ok: true | false }); no internal detail is returned.
const crypto = require('crypto');
const express = require('express');
const { prisma } = require('../../db/prisma');

const SOURCE = 'bitrix24';
const SUPPORTED_EVENTS = new Set(['ONCRMDEALUPDATE']);
const MIN_TOKEN_LENGTH = 16;
const DEAL_ID = /^[1-9]\d{0,17}$/;

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

// Constant-time comparison of equal-length digests; false when the secret is missing or weak (fail closed).
function tokenMatches(provided, env = process.env) {
  const expected = env.BITRIX_INBOUND_APPLICATION_TOKEN;
  if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false;
  if (typeof provided !== 'string' || provided === '') return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

// Bitrix does not promise a unique delivery id (M6), so the identity is built from what the event is:
// source, event name, Deal ID and Bitrix's own timestamp. A repeated delivery collapses to one row.
function eventIdentity(event, dealId, ts) {
  return crypto.createHash('sha256').update(`${SOURCE}|${event}|${dealId}|${ts ?? ''}`).digest('hex');
}

function parseTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function makeHandler({ db = prisma, env = process.env, log = console } = {}) {
  return async function receiveDealStage(req, res) {
    const body = isObject(req.body) ? req.body : {};
    const auth = isObject(body.auth) ? body.auth : {};
    if (!tokenMatches(auth.application_token, env)) return res.status(401).json({ ok: false });

    const event = typeof body.event === 'string' ? body.event.toUpperCase() : '';
    const fields = isObject(body.data) && isObject(body.data.FIELDS) ? body.data.FIELDS : {};
    const dealId = typeof fields.ID === 'string' || typeof fields.ID === 'number' ? String(fields.ID) : '';
    if (!event || !DEAL_ID.test(dealId)) return res.status(400).json({ ok: false });

    const occurredAt = parseTimestamp(body.ts);
    const status = SUPPORTED_EVENTS.has(event) ? 'received' : 'ignored';
    const data = (externalEventId) => ({
          source: SOURCE,
          externalEventId,
          eventType: event.slice(0, 64),
          entityType: 'deal',
          entityId: dealId,
          externalOccurredAt: occurredAt,
          payload: { event, dealId, ts: occurredAt ? occurredAt.toISOString() : null },
          status,
          lastError: status === 'ignored' ? 'quarantined:unsupported_event' : null,
          nextAttemptAt: new Date(0), // due at once: no application clock involved
          ...(status === 'ignored' ? { processedAt: new Date() } : {}),
    });
    const identity = eventIdentity(event, dealId, body.ts);
    try {
      try {
        await db.integrationInbox.create({ data: data(identity) });
      } catch (err) {
        if (!(err && err.code === 'P2002')) throw err;
        // The same event was delivered again. While the first copy is still waiting ('received') it will read the
        // Deal's current state anyway, so this one adds nothing. Once it is being or has been processed, its read
        // may predate this delivery's change (Bitrix timestamps have one-second precision), so a follow-up row is
        // stored: reading the current state again is harmless, and a change is never silently dropped.
        const existing = await db.integrationInbox.findUnique({ where: { source_externalEventId: { source: SOURCE, externalEventId: identity } }, select: { status: true } });
        if (!existing || existing.status === 'received' || status === 'ignored') return res.status(200).json({ ok: true });
        try {
          await db.integrationInbox.create({ data: data(eventIdentity(event, dealId, `${body.ts}|again|${Date.now()}`)) });
        } catch (again) {
          if (!(again && again.code === 'P2002')) throw again;
        }
      }
    } catch (err) {
      log.error(`[bitrix-inbound] could not store an event: ${err && err.name ? err.name : 'error'}`);
      return res.status(500).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  };
}

// Bitrix posts application/x-www-form-urlencoded (nested keys such as auth[application_token]); JSON works too.
const bitrixInboundRouter = express.Router();
bitrixInboundRouter.post('/deal-stage', express.urlencoded({ extended: true, limit: '16kb', parameterLimit: 200 }), makeHandler());

module.exports = { bitrixInboundRouter, makeHandler, tokenMatches, eventIdentity, SUPPORTED_EVENTS };
