// The PATIENT PUSH DELIVERY worker (Notification System, Phase 1: delivery infrastructure). It processes notification_deliveries rows only; it never
// creates a notification and nothing creates delivery rows yet (no sender is migrated to it in this phase), so with an empty table a pass is a no-op.
//
// One pass (runPushDelivery, scheduled by jobs/push-delivery.job.js every 15 seconds):
//   0. Configuration (push-delivery.config.js). Off unless PUSH_DELIVERY_ENABLED=true AND the Expo access token is valid AND this is not a test or
//      synthetic run. When off the pass returns at once: no database access, no Expo call.
//   1. Recover expired leases, close stale deliveries (24 h) and receipt-less ones (24 h after acceptance).
//   2. Send: claim due deliveries one by one (single compare-and-swap UPDATE, database UTC clock), re-check EVERYTHING right before sending,
//      then call Expo once per delivery and record the outcome with a fenced write.
//   3. Receipts: look up the tickets of accepted deliveries (not before 15 minutes after acceptance) and settle them.
//
// The re-check (preflight) happens after the claim and immediately before the attempt: a device that was active when the delivery was created, or
// when it was claimed, is not enough. Any failed check CANCELS the delivery without sending.
//
// Statuses written here: pending (retry), sending (claimed), accepted (Expo ticket ok), delivered (Expo receipt ok = handed to FCM/APNs; NOT proof
// that the phone showed anything), failed, cancelled, uncertain (a request may have reached Expo; never retried automatically).
// Retry policy: 3 attempts in total; retry after 1 minute, then after 5 minutes; only for failures known to have happened before Expo accepted
// anything (HTTP 429 / 5xx / 401 / 403, a rate-limit ticket, a connection that could not open). A timeout or an unreadable answer is "uncertain".
// A Retry-After from Expo can only make a retry LATER (capped at 1 hour), never earlier and never add an attempt.
//
// GLOBAL PAUSE (Expo HTTP 401/403). A rejected ACCESS TOKEN is a configuration problem of the whole worker, not of one delivery. The worker keeps an
// in-memory credential state keyed by a SHA-256 fingerprint of the configured token (the token itself is never kept in it, logged or returned):
//   unverified  (process start, or a different token): before any delivery is touched, the token is tested with a receipt lookup for an id that
//               cannot exist (client.verifyCredentials). Accepted -> valid. Rejected -> rejected. Inconclusive (network, 5xx, 429) -> nothing is sent
//               this pass and it is asked again on the next one.
//   valid       sending and receipts run normally.
//   rejected    NOTHING is sent and no receipt is looked up; pending deliveries are left exactly as they are. The error is logged once. The SAME token
//               is tested again only after CREDENTIAL_RECHECK_SECONDS (15 minutes), by the same probe and still without touching a delivery: it
//               resumes only when Expo no longer rejects it. A different token (a corrected configuration, which needs a restart) is simply "unverified".
//   If Expo rejects the token in the middle of a send, that one delivery's attempt is VOIDED (history kept, attempt given back), it returns to
//   pending untouched, and the pass stops. No delivery is failed or loses an attempt because of a credential problem.
// LIMITATION: the state lives in this process. It is not shared between worker processes and does not survive a restart (the schema has no place
// for it and no table may be added without a migration). After a restart with the same bad token the first pass probes again, is rejected again,
// and pauses again, without touching any delivery. Expiry (24 h) and lease recovery are database-only and continue during a pause.
//
// EXPO TTL. Every message carries `ttl` (seconds) = what is left of the delivery's 24 h window (POLICY.EXPIRY_HOURS counted from the delivery row's
// created_at, read together with the rest at send time): a phone that is switched off cannot be handed the push after the delivery would have been closed,
// and a retry gets a shorter TTL than the first attempt. A delivery with less than POLICY.MIN_TTL_SECONDS left (or an unreadable created_at) is NOT sent:
// it is put back as pending without using an attempt, and the existing expiry (expireStale, every pass) closes it. The TTL is never extended.
//
// MONITORING (push-delivery.monitor.js): a startup line, a summary at most every 10 minutes and [ALERT] lines with a cooldown, counts only; see that file.
//
// The Expo token is read from the device row at send time only, goes straight into the request and is never stored, logged or returned. Log lines
// carry the delivery id and a short code, nothing else.
const os = require('os');
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const defaultStore = require('./push-delivery.store');
const { createExpoPushClient } = require('../../integrations/push/expo-push.client');
const { EXPO_TOKEN_RE } = require('./notification-devices.service');
const { pushDataFromNotification } = require('./notification-catalogue');
const { readConfig, POLICY } = require('./push-delivery.config');
const { defaultMonitorState, observe } = require('./push-delivery.monitor');

// ---- the credential state (see GLOBAL PAUSE above) ---------------------------------------------------------------------------------------------
const credentialState = { fingerprint: null, status: 'unverified', checkedAtMs: 0 };
const fingerprintOf = (accessToken) => crypto.createHash('sha256').update(accessToken).digest('hex');
const resetCredentialStateForTests = () => Object.assign(credentialState, { fingerprint: null, status: 'unverified', checkedAtMs: 0 });

const makeWorkerId = () => `push:${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);

function buildContext(overrides = {}) {
  return {
    prisma: defaultPrisma, store: defaultStore, env: process.env, log: console, workerId: makeWorkerId(), createClient: createExpoPushClient,
    nowMs: () => Date.now(), credentials: credentialState, monitor: defaultMonitorState,
    ...overrides,
  };
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const describe = (err) => (err && typeof err.code === 'string' && SAFE_CODE.test(err.code) ? err.code : (err && SAFE_CODE.test(err.name || '') ? err.name : 'error'));

function markCredentialsRejected(ctx, where) {
  const state = ctx.credentials;
  if (!state) return;
  const first = state.status !== 'rejected';
  state.status = 'rejected';
  state.checkedAtMs = ctx.nowMs();
  if (first) ctx.log.error(`[push-delivery] Expo rejected the access token (${where}): sending is paused and pending deliveries are kept. Correct EXPO_PUSH_ACCESS_TOKEN.`);
}

// { ok: true } when sending may go on, otherwise { ok: false, reason }. Touches no delivery.
async function credentialGate(ctx, client) {
  const state = ctx.credentials;
  if (state.status === 'valid') return { ok: true };
  if (state.status === 'rejected' && ctx.nowMs() - state.checkedAtMs < POLICY.CREDENTIAL_RECHECK_SECONDS * 1000) return { ok: false, reason: 'credentials_rejected' };
  let probe;
  try {
    probe = await client.verifyCredentials();
  } catch (err) {
    ctx.log.error(`[push-delivery] credential check failed (${describe(err)}).`);
    return { ok: false, reason: 'credentials_unverified' };
  }
  if (probe.outcome === 'valid') {
    if (state.status === 'rejected') ctx.log.warn('[push-delivery] Expo accepts the access token again: sending resumed.');
    state.status = 'valid';
    state.checkedAtMs = ctx.nowMs();
    return { ok: true };
  }
  if (probe.outcome === 'rejected') {
    markCredentialsRejected(ctx, 'credential check');
    state.checkedAtMs = ctx.nowMs(); // a failed re-check starts a new waiting period
    return { ok: false, reason: 'credentials_rejected' };
  }
  return { ok: false, reason: 'credentials_unverified' }; // inconclusive: asked again on the next pass
}

// ---- the re-check right before sending ---------------------------------------------------------------------------------------------------------
// Returns null when the delivery may be sent, otherwise the short code to cancel it with.
async function preflightProblem(ctx, data) {
  const { notification, device } = data;
  if (data.channel !== 'push') return 'channel_not_push';
  if (!notification) return 'notification_missing';
  if (notification.deletedAt) return 'notification_deleted';
  // Patients only: a corporate recipient is not served by this worker.
  if (notification.recipientType !== 'patient' || data.recipientType !== 'patient') return 'recipient_not_patient';
  if (data.recipientType !== notification.recipientType || data.recipientId !== notification.recipientId) return 'recipient_mismatch';
  if (notification.serviceRequest && typeof notification.serviceRequest.patientName === 'string'
    && notification.serviceRequest.patientName.startsWith(ctx.store.SYNTHETIC_IDENTITY_PREFIX)) return 'synthetic_identity';
  if (!device) return 'device_missing';
  if (data.destinationKey !== `device:${device.id}`) return 'destination_mismatch';
  if (device.status !== 'active') return 'device_inactive';
  if (device.ownerType !== 'patient' || device.ownerId !== data.recipientId) return 'device_owner_changed';
  if (typeof device.expoPushToken !== 'string' || !EXPO_TOKEN_RE.test(device.expoPushToken)) return 'device_token_invalid';
  // Preference: OFF stops a non-mandatory notification. The mandatory flag is the snapshot the catalogue set at creation, never a client value.
  if (!notification.isMandatory && !(await ctx.store.loadPatientPushPreference(ctx.prisma, data.recipientId))) return 'push_disabled';
  return null;
}

function retryDelaySeconds(attemptNumber, retryAfter) {
  const base = POLICY.RETRY_DELAYS_SECONDS[attemptNumber - 1]; // undefined after the last allowed attempt
  if (base === undefined) return null;
  const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, POLICY.MAX_RETRY_AFTER_SECONDS) : 0;
  return Math.max(base, asked);
}

// What is left of the delivery's 24 h window, in whole seconds (never more than the whole window, which also covers a created_at slightly in the
// future), or null when created_at cannot be read. `createdAt` is the delivery row's own persisted creation time (a Date; a number or an ISO string
// are read too), `nowMs` the worker's clock: both are UTC (verified against MySQL), so their difference is the delivery's age.
function remainingLifetimeSeconds(createdAt, nowMs) {
  const created = createdAt instanceof Date ? createdAt.getTime() : (typeof createdAt === 'number' ? createdAt : (typeof createdAt === 'string' ? Date.parse(createdAt) : NaN));
  if (!Number.isFinite(created) || !Number.isFinite(nowMs)) return null;
  const window = POLICY.EXPIRY_HOURS * 3600;
  return Math.floor(Math.min(window, window - (nowMs - created) / 1000));
}

// ---- one delivery ------------------------------------------------------------------------------------------------------------------------------
async function processDelivery(ctx, client, claimed) {
  const { store, prisma, log } = ctx;
  const data = await store.loadForSend(prisma, claimed.id);
  if (!data || data.status !== 'sending' || data.lockedBy !== claimed.workerId) return 'lost'; // cancelled or reclaimed since the claim

  const problem = await preflightProblem(ctx, data);
  if (problem) {
    await store.writeSendOutcome(prisma, claimed, { status: 'cancelled', code: problem });
    log.warn(`[push-delivery] delivery ${claimed.id}: cancelled (${problem}).`);
    return 'cancelled';
  }
  if (data.attemptCount >= POLICY.MAX_ATTEMPTS) { // defensive: a retry is only ever scheduled below the limit
    await store.writeSendOutcome(prisma, claimed, { status: 'failed', code: 'attempts_exhausted' });
    return 'failed';
  }

  // The TTL: what is left of the 24 h window. Too little (or an unreadable start) means this delivery is not sent; it is handed back untouched and expiry decides.
  const remaining = remainingLifetimeSeconds(data.createdAt, ctx.nowMs());
  if (remaining === null) {
    await store.writeSendOutcome(prisma, claimed, { status: 'cancelled', code: 'created_at_unreadable' });
    log.warn(`[push-delivery] delivery ${claimed.id}: cancelled (created_at_unreadable).`);
    return 'cancelled';
  }
  if (remaining < POLICY.MIN_TTL_SECONDS) {
    await store.writeSendOutcome(prisma, claimed, { status: 'pending', code: 'expiry_window_closing', delaySeconds: Math.max(1, remaining + 1) });
    return 'expiring';
  }
  const ttl = remaining;

  const begun = await store.beginAttempt(prisma, claimed, { attemptCount: data.attemptCount, minLeaseLeftSeconds: POLICY.MIN_LEASE_LEFT_SECONDS });
  if (!begun) return 'lost';
  const { attemptNumber, attemptCount } = begun; // attemptNumber: the history row; attemptCount: 1 to 3, the attempts that count
  const record = (outcome) => store.recordAttemptOutcome(prisma, claimed, attemptNumber, outcome);

  const { notification, device } = data;
  const message = { to: device.expoPushToken, title: notification.title, body: notification.body || '', channelId: 'default', ttl };
  const pushData = pushDataFromNotification(notification);
  if (pushData) message.data = pushData; // only { screen, serviceRequestId }: see notification-catalogue.js

  let result;
  try {
    result = await client.sendMessage(message);
  } catch (err) {
    // Unknown whether anything left the process: never retried.
    await record({ status: 'uncertain', code: 'client_error' });
    log.error(`[push-delivery] delivery ${claimed.id}: uncertain (${describe(err)}).`);
    return 'uncertain';
  }

  switch (result.outcome) {
    case 'accepted': {
      await record({ status: 'accepted', ticketId: result.ticketId, receiptDelaySeconds: POLICY.RECEIPT_FIRST_CHECK_SECONDS });
      return 'accepted';
    }
    case 'device_not_registered': {
      const written = await record({ status: 'failed', code: 'DeviceNotRegistered', message: result.message });
      await store.deactivateDeviceForToken(prisma, device.id, device.expoPushToken);
      await store.cancelOpenDeliveriesForDevice(prisma, device.id, 'device_not_registered', claimed.id);
      log.warn(`[push-delivery] delivery ${claimed.id}: device not registered; device deactivated.`);
      return written ? 'failed' : 'lost';
    }
    case 'unauthorized': {
      // The ACCESS TOKEN was rejected: nothing is wrong with this delivery. The attempt is voided (kept as history, given back), the delivery
      // returns to pending untouched, and the whole worker pauses.
      await record({ status: 'pending', code: 'expo_unauthorized', delaySeconds: 0, refundAttempt: true });
      markCredentialsRejected(ctx, `HTTP ${result.status}`);
      return 'paused';
    }
    case 'retry': {
      const delay = retryDelaySeconds(attemptCount, result.retryAfterSeconds);
      if (delay === null) {
        await record({ status: 'failed', code: 'attempts_exhausted', message: result.code });
        log.warn(`[push-delivery] delivery ${claimed.id}: failed after ${attemptCount} attempts (${result.code}).`);
        return 'failed';
      }
      await record({ status: 'pending', code: result.code, message: result.message, delaySeconds: delay });
      log.warn(`[push-delivery] delivery ${claimed.id}: attempt ${attemptCount} failed (${result.code}); retry in ${delay}s.`);
      return 'retry';
    }
    case 'failed': {
      await record({ status: 'failed', code: result.code, message: result.message });
      log.warn(`[push-delivery] delivery ${claimed.id}: failed (${result.code}).`);
      return 'failed';
    }
    default: {
      // 'uncertain', and anything this worker does not know: never retried.
      await record({ status: 'uncertain', code: result.code || 'unknown_outcome' });
      log.warn(`[push-delivery] delivery ${claimed.id}: uncertain (${result.code || 'unknown_outcome'}).`);
      return 'uncertain';
    }
  }
}

async function sendPass(ctx, client) {
  const counts = { claimed: 0, accepted: 0, retried: 0, failed: 0, cancelled: 0, uncertain: 0, lost: 0, expiring: 0, paused: false };
  for (const id of await ctx.store.findDueIds(ctx.prisma, POLICY.SEND_BATCH)) {
    const claimed = await ctx.store.claim(ctx.prisma, { id, workerId: ctx.workerId, leaseSeconds: POLICY.LEASE_SECONDS });
    if (!claimed) continue;
    counts.claimed += 1;
    try {
      const result = await processDelivery(ctx, client, claimed);
      if (result === 'paused') { counts.paused = true; break; } // the token was rejected: no further delivery is claimed or sent
      const key = { accepted: 'accepted', retry: 'retried', failed: 'failed', cancelled: 'cancelled', uncertain: 'uncertain', lost: 'lost', expiring: 'expiring' }[result];
      if (key) counts[key] += 1;
    } catch (err) {
      // Rolled back or unknown: the lease expires and recovery decides (a started attempt becomes "uncertain", otherwise it is retried).
      ctx.log.error(`[push-delivery] delivery ${id}: ${describe(err)}; left for lease recovery.`);
    }
  }
  return counts;
}

// ---- receipts ----------------------------------------------------------------------------------------------------------------------------------
async function receiptPass(ctx, client) {
  const counts = { checked: 0, delivered: 0, failed: 0, waiting: 0, lost: 0, paused: false };
  const ids = await ctx.store.findReceiptDueIds(ctx.prisma, POLICY.RECEIPT_BATCH);
  if (ids.length === 0) return counts;
  const rows = await ctx.store.claimReceipts(ctx.prisma, ids, { workerId: ctx.workerId, leaseSeconds: POLICY.LEASE_SECONDS });
  if (rows.length === 0) return counts;
  counts.checked = rows.length;

  const answer = await client.getReceipts(rows.map((row) => row.providerMessageId));
  if (answer.outcome === 'unauthorized') {
    // The token was rejected: nothing is concluded about any delivery. The leases are released and the rows stay 'accepted', due again at once.
    markCredentialsRejected(ctx, `HTTP ${answer.status}`);
    for (const row of rows) await ctx.store.writeReceiptOutcome(ctx.prisma, { id: row.id, workerId: ctx.workerId }, { status: 'accepted', code: 'expo_unauthorized', delaySeconds: 0 });
    counts.paused = true;
    return counts;
  }
  for (const row of rows) {
    const claimed = { id: row.id, workerId: ctx.workerId };
    const receipt = answer.outcome === 'ok' ? answer.receipts.get(row.providerMessageId) : undefined;
    let written;
    if (!receipt) {
      // Expo unreachable, or no receipt yet: nothing is concluded; look again later (expireStale closes it after 24 h).
      written = await ctx.store.writeReceiptOutcome(ctx.prisma, claimed, {
        status: 'accepted', code: answer.outcome === 'ok' ? 'receipt_pending' : `receipt_unavailable_${answer.code}`.slice(0, 64), delaySeconds: POLICY.RECEIPT_RECHECK_SECONDS,
      });
      counts[written ? 'waiting' : 'lost'] += 1;
    } else if (receipt.status === 'ok') {
      // Expo's FCM/APNs hand-off succeeded. This is all it says.
      written = await ctx.store.writeReceiptOutcome(ctx.prisma, claimed, { status: 'delivered' });
      counts[written ? 'delivered' : 'lost'] += 1;
    } else {
      written = await ctx.store.writeReceiptOutcome(ctx.prisma, claimed, { status: 'failed', code: receipt.code, message: receipt.message });
      counts[written ? 'failed' : 'lost'] += 1;
      if (written && receipt.code === 'DeviceNotRegistered' && row.deviceId) {
        const startedAt = await ctx.store.latestAttemptStart(ctx.prisma, row.id);
        if (startedAt) await ctx.store.deactivateDeviceUnchangedSince(ctx.prisma, row.deviceId, startedAt);
        await ctx.store.cancelOpenDeliveriesForDevice(ctx.prisma, row.deviceId, 'device_not_registered', row.id);
        ctx.log.warn(`[push-delivery] delivery ${row.id}: receipt says device not registered.`);
      }
    }
  }
  return counts;
}

// ---- one pass ----------------------------------------------------------------------------------------------------------------------------------
let warnedProblem = null; // a configuration problem is logged once per process (and again if it changes), not on every tick

async function runPushDelivery(overrides = {}) {
  const ctx = buildContext(overrides);
  const config = readConfig(ctx.env);
  const result = await runPass(ctx, config);
  await observe(ctx, config); // after the pass; never throws and never changes the result (push-delivery.monitor.js)
  return result;
}

async function runPass(ctx, config) {
  if (!config.enabled) {
    if (config.problem !== 'switch_off' && warnedProblem !== config.problem) {
      warnedProblem = config.problem;
      ctx.log.warn(`[push-delivery] not running (${config.problem}).`);
    }
    return { active: false, problem: config.problem };
  }
  warnedProblem = null;

  const client = ctx.client || ctx.createClient({ accessToken: config.accessToken, env: ctx.env, timeoutMs: POLICY.REQUEST_TIMEOUT_MS });
  // A different token than the one the state was built for (or none yet) starts from "unverified".
  const fingerprint = fingerprintOf(config.accessToken);
  if (ctx.credentials.fingerprint !== fingerprint) Object.assign(ctx.credentials, { fingerprint, status: 'unverified', checkedAtMs: 0 });
  const recovered = await ctx.store.recoverExpiredLeases(ctx.prisma, { leaseSeconds: POLICY.LEASE_SECONDS, receiptDelaySeconds: POLICY.RECEIPT_FIRST_CHECK_SECONDS });
  const expired = await ctx.store.expireStale(ctx.prisma, { expiryHours: POLICY.EXPIRY_HOURS, receiptMaxAgeHours: POLICY.RECEIPT_MAX_AGE_HOURS });
  // Database-only upkeep above continues during a pause. Below needs Expo: first the token is checked (no delivery is touched by that).
  const gate = await credentialGate(ctx, client);
  if (!gate.ok) return { active: true, paused: gate.reason, recovered, expired };
  const sent = await sendPass(ctx, client);
  if (sent.paused) return { active: true, paused: 'credentials_rejected', recovered, expired, sent };
  const receipts = await receiptPass(ctx, client);
  if (receipts.paused) return { active: true, paused: 'credentials_rejected', recovered, expired, sent, receipts };
  return { active: true, recovered, expired, sent, receipts };
}

module.exports = { runPushDelivery, processDelivery, preflightProblem, retryDelaySeconds, remainingLifetimeSeconds, buildContext, resetCredentialStateForTests };
