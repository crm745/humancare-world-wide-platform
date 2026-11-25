// A FAKE of push-delivery.store.js for the safe tests: the same functions, the same fences and the same status rules, over plain objects and a
// fake database clock. The real store is raw SQL (checked statement by statement in push-delivery-store.test.js); this fake lets the worker's
// whole behaviour (claim, re-checks, retries, receipts, recovery) be exercised without a database. push-delivery-store.test.js also asserts that
// the fake and the real store export exactly the same functions, so the two cannot drift apart unnoticed.
const SYNTHETIC_IDENTITY_PREFIX = 'ZZ-SYNTHETIC';
const SEC = 1000;
const HOUR = 3600 * SEC;

function makeWorld() {
  const world = {
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    deliveries: new Map(), attempts: [], devices: new Map(), notifications: new Map(), prefs: new Map(), nextId: 1000,
  };
  const at = () => new Date(world.now);
  const lockFree = (d) => d.lockedUntil == null || d.lockedUntil <= world.now;
  const isSynthetic = (d) => {
    const n = world.notifications.get(d.notificationId);
    return !!(n && n.serviceRequest && n.serviceRequest.patientName.startsWith(SYNTHETIC_IDENTITY_PREFIX));
  };

  // ---- fixtures
  world.addDevice = (over = {}) => { const d = { id: 10, ownerType: 'patient', ownerId: 1, status: 'active', expoPushToken: 'ExponentPushToken[abcdefghijklmnopqrstuv]', lastRegisteredAt: at(), disabledAt: null, ...over }; world.devices.set(d.id, d); return d; };
  world.addNotification = (over = {}) => { const n = { id: 500, recipientType: 'patient', recipientId: 1, title: 'Your case has been updated', body: 'Open the app', data: { screen: 'request' }, serviceRequestId: 7, isMandatory: false, deletedAt: null, serviceRequest: { patientName: 'Asha Rao' }, ...over }; world.notifications.set(n.id, n); return n; };
  world.addDelivery = (over = {}) => {
    const d = {
      id: world.nextId++, notificationId: 500, recipientType: 'patient', recipientId: 1, channel: 'push', status: 'pending', attemptCount: 0, nextAttemptAt: world.now,
      lockedBy: null, lockedUntil: null, providerMessageId: null, acceptedAt: null, deliveredAt: null, closedAt: null, lastErrorCode: null, lastError: null,
      createdAt: world.now, deviceId: 10, destinationKey: 'device:10', ...over,
    };
    world.deliveries.set(d.id, d);
    return d;
  };
  world.advance = (ms) => { world.now += ms; };
  world.setup = (over = {}) => ({ device: world.addDevice(over.device), notification: world.addNotification(over.notification), delivery: world.addDelivery(over.delivery) });

  // ---- the store
  const store = {
    SYNTHETIC_IDENTITY_PREFIX,
    cleanText: (t) => (t == null ? null : String(t).slice(0, 300)),

    async findDueIds(_db, limit) {
      return [...world.deliveries.values()]
        .filter((d) => d.channel === 'push' && d.status === 'pending' && d.nextAttemptAt <= world.now && lockFree(d) && !isSynthetic(d))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id).slice(0, limit).map((d) => d.id);
    },
    async claim(_db, { id, workerId, leaseSeconds }) {
      const d = world.deliveries.get(id);
      if (!d || d.channel !== 'push' || d.status !== 'pending' || d.nextAttemptAt > world.now || !lockFree(d)) return null;
      Object.assign(d, { status: 'sending', lockedBy: workerId, lockedUntil: world.now + leaseSeconds * SEC });
      return { id, workerId };
    },
    async loadForSend(_db, id) {
      const d = world.deliveries.get(id);
      if (!d) return null;
      const notification = world.notifications.get(d.notificationId) || null;
      const device = d.deviceId != null ? world.devices.get(d.deviceId) || null : null;
      return JSON.parse(JSON.stringify({ ...d, notification, device }), (k, v) => (k === 'deletedAt' && v ? new Date(v) : v));
    },
    async loadPatientPushPreference(_db, patientId) { return world.prefs.has(patientId) ? world.prefs.get(patientId) : true; },
    async beginAttempt(_db, claimed, { attemptCount, minLeaseLeftSeconds }) {
      const d = world.deliveries.get(claimed.id);
      if (!d || d.status !== 'sending' || d.lockedBy !== claimed.workerId || d.attemptCount !== attemptCount || !(d.lockedUntil > world.now + minLeaseLeftSeconds * SEC)) return null;
      d.attemptCount += 1;
      const highest = world.attempts.filter((a) => a.deliveryId === d.id).reduce((m, a) => Math.max(m, a.attemptNumber), 0); // history numbers: highest + 1
      world.attempts.push({ deliveryId: d.id, attemptNumber: highest + 1, status: 'started', startedAt: at(), finishedAt: null, errorCode: null, providerMessageId: null });
      return { attemptNumber: highest + 1, attemptCount: d.attemptCount };
    },
    async writeSendOutcome(_db, claimed, { status, code = null, message = null, ticketId = null, delaySeconds = 0, receiptDelaySeconds = 0, refundAttempt = false }) {
      if (!['accepted', 'pending', 'failed', 'uncertain', 'cancelled'].includes(status)) throw new Error(`Not a send outcome: ${status}`);
      const d = world.deliveries.get(claimed.id);
      if (!d || d.status !== 'sending' || d.lockedBy !== claimed.workerId || !(d.lockedUntil > world.now)) return 0; // the fence
      d.status = status; d.lastErrorCode = code; d.lastError = store.cleanText(message);
      if (ticketId) d.providerMessageId = ticketId;
      if (status === 'accepted') { d.acceptedAt = world.now; d.nextAttemptAt = world.now + receiptDelaySeconds * SEC; }
      if (status === 'pending') d.nextAttemptAt = world.now + delaySeconds * SEC;
      if (refundAttempt === true && status === 'pending') d.attemptCount = Math.max(d.attemptCount - 1, 0); // a voided attempt is given back
      if (['failed', 'cancelled', 'uncertain'].includes(status)) d.closedAt = world.now;
      d.lockedBy = null; d.lockedUntil = null;
      return 1;
    },
    async finishAttempt(_db, deliveryId, attemptNumber, { status, ticketId = null, code = null }) {
      const a = world.attempts.find((x) => x.deliveryId === deliveryId && x.attemptNumber === attemptNumber && x.status === 'started');
      if (a) Object.assign(a, { status, providerMessageId: ticketId, errorCode: code, finishedAt: at() });
    },
    async recordAttemptOutcome(db, claimed, attemptNumber, outcome) {
      const attemptStatus = outcome.status === 'accepted' ? 'accepted' : outcome.status === 'uncertain' ? 'uncertain' : 'failed';
      const written = await store.writeSendOutcome(db, claimed, outcome);
      await store.finishAttempt(db, claimed.id, attemptNumber, { status: attemptStatus, ticketId: outcome.ticketId || null, code: outcome.code || null });
      return written;
    },

    async recoverExpiredLeases(_db, { leaseSeconds, receiptDelaySeconds }) {
      const r = { adopted: 0, uncertain: 0, pending: 0, attempts: 0, receipts: 0 };
      for (const d of world.deliveries.values()) {
        if (d.channel !== 'push') continue;
        if (d.status === 'sending' && d.lockedUntil <= world.now) {
          const mine = world.attempts.filter((a) => a.deliveryId === d.id);
          const latest = mine.reduce((best, a) => (!best || a.attemptNumber > best.attemptNumber ? a : best), null); // the highest number
          if (latest && latest.status === 'accepted' && latest.providerMessageId) {
            Object.assign(d, { status: 'accepted', providerMessageId: latest.providerMessageId, acceptedAt: world.now, lastErrorCode: null, nextAttemptAt: world.now + receiptDelaySeconds * SEC, lockedBy: null, lockedUntil: null }); r.adopted += 1;
          } else if (mine.some((a) => a.status === 'started') || (latest && latest.status === 'uncertain')) {
            Object.assign(d, { status: 'uncertain', lastErrorCode: 'lease_expired_during_send', closedAt: world.now, lockedBy: null, lockedUntil: null }); r.uncertain += 1;
          } else { Object.assign(d, { status: 'pending', nextAttemptAt: world.now, lockedBy: null, lockedUntil: null }); r.pending += 1; }
        } else if (d.status === 'accepted' && d.lockedUntil != null && d.lockedUntil <= world.now) { Object.assign(d, { lockedBy: null, lockedUntil: null }); r.receipts += 1; }
      }
      for (const a of world.attempts) {
        if (a.status === 'started' && a.startedAt.getTime() <= world.now - (leaseSeconds + 60) * SEC) { Object.assign(a, { status: 'uncertain', errorCode: 'lease_expired', finishedAt: at() }); r.attempts += 1; }
      }
      return r;
    },
    async expireStale(_db, { expiryHours, receiptMaxAgeHours }) {
      const r = { cancelled: 0, failed: 0, receiptExpired: 0 };
      for (const d of world.deliveries.values()) {
        if (d.channel !== 'push' || !lockFree(d)) continue;
        if (d.status === 'pending' && d.createdAt <= world.now - expiryHours * HOUR) {
          if (d.attemptCount === 0) { Object.assign(d, { status: 'cancelled', lastErrorCode: 'expired', closedAt: world.now }); r.cancelled += 1; }
          else { Object.assign(d, { status: 'failed', lastErrorCode: 'expired', closedAt: world.now }); r.failed += 1; }
        } else if (d.status === 'accepted' && d.acceptedAt <= world.now - receiptMaxAgeHours * HOUR) {
          Object.assign(d, { status: 'uncertain', lastErrorCode: 'receipt_expired', closedAt: world.now }); r.receiptExpired += 1;
        }
      }
      return r;
    },

    async findReceiptDueIds(_db, limit) {
      return [...world.deliveries.values()]
        .filter((d) => d.channel === 'push' && d.status === 'accepted' && d.providerMessageId && d.nextAttemptAt <= world.now && lockFree(d))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id).slice(0, limit).map((d) => d.id);
    },
    async claimReceipts(_db, ids, { workerId, leaseSeconds }) {
      const rows = [];
      for (const id of ids) {
        const d = world.deliveries.get(id);
        if (d && d.status === 'accepted' && d.providerMessageId && d.nextAttemptAt <= world.now && lockFree(d)) {
          Object.assign(d, { lockedBy: workerId, lockedUntil: world.now + leaseSeconds * SEC });
          rows.push({ id: d.id, providerMessageId: d.providerMessageId, deviceId: d.deviceId, recipientId: d.recipientId });
        }
      }
      return rows;
    },
    async writeReceiptOutcome(_db, claimed, { status, code = null, message = null, delaySeconds = 0 }) {
      if (!['accepted', 'delivered', 'failed', 'uncertain'].includes(status)) throw new Error(`Not a receipt outcome: ${status}`);
      const d = world.deliveries.get(claimed.id);
      if (!d || d.status !== 'accepted' || d.lockedBy !== claimed.workerId || !(d.lockedUntil > world.now)) return 0;
      d.status = status; d.lastErrorCode = code; d.lastError = store.cleanText(message);
      if (status === 'delivered') d.deliveredAt = world.now;
      if (['delivered', 'failed', 'uncertain'].includes(status)) d.closedAt = world.now;
      if (status === 'accepted') d.nextAttemptAt = world.now + delaySeconds * SEC;
      d.lockedBy = null; d.lockedUntil = null;
      return 1;
    },
    async latestAttemptStart(_db, deliveryId) {
      const list = world.attempts.filter((a) => a.deliveryId === deliveryId).sort((a, b) => b.attemptNumber - a.attemptNumber);
      return list.length ? list[0].startedAt : null;
    },

    // The aggregate numbers of the real deliveryMetrics, computed from the fake rows (counts only).
    async deliveryMetrics(_db, { windowHours = 24 } = {}) {
      const since = world.now - windowHours * HOUR;
      const all = [...world.deliveries.values()].filter((d) => d.channel === 'push');
      const closedRecently = (d) => d.closedAt != null && d.closedAt > since;
      const pendings = all.filter((d) => d.status === 'pending');
      return {
        pending: pendings.length,
        sending: all.filter((d) => d.status === 'sending').length,
        accepted: all.filter((d) => d.status === 'accepted').length,
        failed: all.filter((d) => d.status === 'failed' && closedRecently(d) && d.lastErrorCode !== 'expired').length,
        uncertain: all.filter((d) => d.status === 'uncertain' && closedRecently(d)).length,
        expired: all.filter((d) => d.lastErrorCode === 'expired' && closedRecently(d)).length,
        oldestPendingSeconds: pendings.length ? Math.max(0, Math.floor((world.now - Math.min(...pendings.map((d) => d.createdAt))) / SEC)) : null,
      };
    },

    async deactivateDeviceForToken(_db, id, token) {
      const d = world.devices.get(id);
      if (!d || d.status !== 'active' || d.expoPushToken !== token) return 0;
      Object.assign(d, { status: 'inactive', disabledAt: at() });
      return 1;
    },
    async deactivateDeviceUnchangedSince(_db, id, since) {
      const d = world.devices.get(id);
      if (!d || d.status !== 'active' || !(d.lastRegisteredAt.getTime() <= since.getTime())) return 0;
      Object.assign(d, { status: 'inactive', disabledAt: at() });
      return 1;
    },
    async cancelOpenDeliveriesForDevice(_db, deviceRowId, code, exceptId) {
      let n = 0;
      for (const d of world.deliveries.values()) {
        if (d.deviceId === deviceRowId && ['pending', 'sending'].includes(d.status) && d.id !== exceptId) {
          Object.assign(d, { status: 'cancelled', closedAt: world.now, lockedBy: null, lockedUntil: null, lastErrorCode: code }); n += 1;
        }
      }
      return n;
    },
  };
  world.store = store;
  return world;
}

module.exports = { makeWorld, SEC, HOUR };
