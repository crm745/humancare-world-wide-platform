/* global describe, test, expect, jest */
// push-delivery.store.js is raw SQL, so these tests check the statements themselves (the clauses that make the claim, the fence, the recovery and
// the expiry safe) and what the functions do with the number of rows the database reports. They run NO SQL: a recording stub stands in for Prisma.
// Real behaviour of the statements against MySQL is for a later, separately authorised check on humancare_dev.
// Loading the job list loads the services, which import the shared Prisma client: it is replaced by an empty shell (nothing here reaches a database).
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const store = require('../../src/modules/notifications/push-delivery.store');
const { makeWorld } = require('./push-delivery-fake');

// A tagged-template recorder: statement text with ? for each value, and the values.
function recorder({ rows = 1 } = {}) {
  const calls = [];
  const text = (strings) => strings.join('?').replace(/\s+/g, ' ').trim();
  const db = {
    calls,
    $executeRaw: jest.fn(async (strings, ...values) => { calls.push({ kind: 'execute', sql: text(strings), values }); return typeof rows === 'function' ? rows(calls.length) : rows; }),
    $queryRaw: jest.fn(async (strings, ...values) => { calls.push({ kind: 'query', sql: text(strings), values }); return [{ id: 3 }, { id: '4' }]; }),
    $executeRawUnsafe: jest.fn(async (sql, ...values) => { calls.push({ kind: 'executeUnsafe', sql: sql.replace(/\s+/g, ' ').trim(), values }); return 1; }),
    notificationDelivery: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 2 })) },
    notificationDeliveryAttempt: { create: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })), findFirst: jest.fn(async () => null) },
    notificationDevice: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  db.$transaction = jest.fn(async (fn) => fn(db));
  return db;
}

describe('the fake store used by the worker tests', () => {
  test('exports exactly the functions of the real store (they cannot drift apart unnoticed)', () => {
    const fake = Object.keys(makeWorld().store).sort();
    const real = Object.keys(store).sort();
    expect(fake).toEqual(real);
  });
});

describe('claim', () => {
  test('is ONE compare-and-swap UPDATE on the database clock: pending, push, due, not leased', async () => {
    const db = recorder();
    expect(await store.claim(db, { id: 5, workerId: 'w1', leaseSeconds: 120 })).toEqual({ id: 5, workerId: 'w1' });
    expect(db.calls).toHaveLength(1);
    const { sql, values } = db.calls[0];
    expect(sql).toMatch(/^UPDATE notification_deliveries SET status = 'sending', locked_by = \?/);
    expect(sql).toContain('locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(sql).toContain("WHERE id = ? AND channel = 'push' AND status = 'pending'");
    expect(sql).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(sql).toContain('(locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))');
    expect(values).toEqual(['w1', 120, 5]);
  });

  test('a race that this worker loses (0 rows) returns null: it takes nothing', async () => {
    expect(await store.claim(recorder({ rows: 0 }), { id: 5, workerId: 'w2', leaseSeconds: 120 })).toBeNull();
  });

  test('the candidate query offers only due, unleased push deliveries and never a synthetic identity', async () => {
    const db = recorder();
    expect(await store.findDueIds(db, 20)).toEqual([3, 4]);
    const { sql, values } = db.calls[0];
    expect(sql).toContain("d.channel = 'push' AND d.status = 'pending'");
    expect(sql).toContain('d.next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(sql).toContain('(d.locked_until IS NULL OR d.locked_until <= UTC_TIMESTAMP(3))');
    expect(sql).toContain('sr.patient_name LIKE ?');
    expect(values).toEqual(['ZZ-SYNTHETIC%', 20]);
  });
});

describe('fenced writes: id + expected status + this worker + lease still in the future', () => {
  const FENCE_SEND = "WHERE id = ? AND status = 'sending' AND locked_by = ? AND locked_until > UTC_TIMESTAMP(3)";

  test('the result of a send', async () => {
    const db = recorder();
    expect(await store.writeSendOutcome(db, { id: 5, workerId: 'w1' }, { status: 'accepted', ticketId: 'T', receiptDelaySeconds: 900 })).toBe(1);
    const { sql, values } = db.calls[0];
    expect(sql).toContain(FENCE_SEND);
    expect(sql).toContain('locked_by = NULL, locked_until = NULL');
    expect(sql).toContain('UTC_TIMESTAMP(3)');
    expect(sql).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP|SYSDATE/i);
    expect(values.slice(-2)).toEqual([5, 'w1']);
    expect(JSON.stringify(values)).not.toMatch(/ExponentPushToken/);
  });

  test('a lost fence (0 rows) is reported as 0, so the caller writes nothing else', async () => {
    expect(await store.writeSendOutcome(recorder({ rows: 0 }), { id: 5, workerId: 'w1' }, { status: 'pending', delaySeconds: 60 })).toBe(0);
  });

  test('only the approved send statuses can be written', async () => {
    for (const bad of ['sending', 'delivered', 'bogus', undefined]) await expect(store.writeSendOutcome(recorder(), { id: 1, workerId: 'w' }, { status: bad })).rejects.toThrow();
  });

  test('the result of a receipt check', async () => {
    const db = recorder();
    await store.writeReceiptOutcome(db, { id: 5, workerId: 'w1' }, { status: 'delivered' });
    expect(db.calls[0].sql).toContain("WHERE id = ? AND status = 'accepted' AND locked_by = ? AND locked_until > UTC_TIMESTAMP(3)");
    await expect(store.writeReceiptOutcome(recorder(), { id: 1, workerId: 'w' }, { status: 'pending' })).rejects.toThrow();
  });

  test('an attempt starts only while the lease is held AND will outlive the request, and the count and the attempt row are written together', async () => {
    const db = recorder();
    expect(await store.beginAttempt(db, { id: 5, workerId: 'w1' }, { attemptCount: 0, minLeaseLeftSeconds: 30 })).toEqual({ attemptNumber: 1, attemptCount: 1 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const { sql, values } = db.calls[0];
    expect(sql).toContain('SET attempt_count = attempt_count + 1');
    expect(sql).toContain("status = 'sending' AND locked_by = ?");
    expect(sql).toContain('attempt_count = ?');
    expect(sql).toContain('locked_until > UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(values).toEqual([5, 'w1', 0, 30]);
    expect(db.notificationDeliveryAttempt.create).toHaveBeenCalledWith({ data: { deliveryId: 5, attemptNumber: 1, status: 'started', provider: 'expo' } });
  });

  test('the number of a new attempt row is the highest existing number + 1, whatever attempt_count says (voided attempts keep their rows)', async () => {
    const db = recorder();
    db.notificationDeliveryAttempt.findFirst = jest.fn(async () => ({ attemptNumber: 2 })); // two history rows, one of them voided
    expect(await store.beginAttempt(db, { id: 5, workerId: 'w1' }, { attemptCount: 1, minLeaseLeftSeconds: 30 })).toEqual({ attemptNumber: 3, attemptCount: 2 });
    expect(db.notificationDeliveryAttempt.findFirst).toHaveBeenCalledWith({ where: { deliveryId: 5 }, orderBy: { attemptNumber: 'desc' }, select: { attemptNumber: true } });
    expect(db.notificationDeliveryAttempt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ attemptNumber: 3 }) });
  });

  test('a voided attempt is given back: only a pending write with refundAttempt lowers attempt_count (never below 0)', async () => {
    const db = recorder();
    await store.writeSendOutcome(db, { id: 5, workerId: 'w1' }, { status: 'pending', code: 'expo_unauthorized', delaySeconds: 0, refundAttempt: true });
    expect(db.calls[0].sql).toContain('attempt_count = CASE WHEN ? = 1 THEN GREATEST(attempt_count - 1, 0) ELSE attempt_count END');
    expect(db.calls[0].values).toContain(1);
    const other = recorder();
    await store.writeSendOutcome(other, { id: 5, workerId: 'w1' }, { status: 'failed', code: 'x', refundAttempt: true }); // not a pending write: no refund
    await store.writeSendOutcome(other, { id: 5, workerId: 'w1' }, { status: 'pending', delaySeconds: 60 }); // no refund asked
    for (const call of other.calls) expect(call.values).toContain(0);
    for (const call of other.calls) expect(call.values).not.toContain(1);
  });

  test('without the lease no attempt row is written', async () => {
    const db = recorder({ rows: 0 });
    expect(await store.beginAttempt(db, { id: 5, workerId: 'w1' }, { attemptCount: 0, minLeaseLeftSeconds: 30 })).toBeNull();
    expect(db.notificationDeliveryAttempt.create).not.toHaveBeenCalled();
  });

  test('the attempt result is written together with the delivery result, and a finished attempt is never changed again', async () => {
    const db = recorder({ rows: 0 }); // the fence is lost: the delivery is untouched ...
    expect(await store.recordAttemptOutcome(db, { id: 5, workerId: 'w1' }, 2, { status: 'accepted', ticketId: 'T' })).toBe(0);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // ... but the attempt still records what Expo answered, and only a "started" row is ever updated
    expect(db.notificationDeliveryAttempt.updateMany).toHaveBeenCalledWith({
      where: { deliveryId: 5, attemptNumber: 2, status: 'started' },
      data: expect.objectContaining({ status: 'accepted', providerMessageId: 'T', finishedAt: expect.any(Date) }),
    });
  });

  test('stored error text never keeps a push token or a URL', async () => {
    expect(store.cleanText('x ExponentPushToken[abc] y https://exp.host/z')).toBe('x [token] y [url]');
    const db = recorder();
    await store.writeSendOutcome(db, { id: 1, workerId: 'w' }, { status: 'failed', code: 'c', message: 'bad ExpoPushToken[secret]' });
    expect(JSON.stringify(db.calls[0].values)).not.toContain('secret');
  });
});

describe('recovery and expiry (database clock)', () => {
  test('expired leases: an accepted attempt is adopted; a started or uncertain one means uncertain (never a re-send); none means pending', async () => {
    const db = recorder();
    await store.recoverExpiredLeases(db, { leaseSeconds: 120, receiptDelaySeconds: 900 });
    const sql = db.calls.map((c) => c.sql);
    expect(sql).toHaveLength(5);
    // (a) adopt the ticket of an attempt that Expo accepted
    expect(sql[0]).toContain("SET d.status = 'accepted', d.provider_message_id = a.provider_message_id");
    expect(sql[0]).toContain('a.attempt_number = (SELECT MAX(x.attempt_number) FROM notification_delivery_attempts x WHERE x.delivery_id = d.id)');
    expect(sql[0]).toContain("d.status = 'sending' AND d.locked_until <= UTC_TIMESTAMP(3)");
    expect(sql[0]).toContain("a.status = 'accepted' AND a.provider_message_id IS NOT NULL");
    expect(db.calls[0].values).toEqual([900]);
    // (b) a request may have left
    expect(sql[1]).toContain("SET d.status = 'uncertain'");
    expect(sql[1]).toContain("d.status = 'sending' AND d.locked_until <= UTC_TIMESTAMP(3)");
    expect(sql[1]).toContain("a.status = 'started'");
    expect(sql[1]).toContain("a.status = 'uncertain' AND a.attempt_number = (SELECT MAX(x.attempt_number) FROM notification_delivery_attempts x WHERE x.delivery_id = d.id)");
    // (c) nothing was sent
    expect(sql[2]).toContain("SET status = 'pending'");
    expect(sql[2]).toContain("status = 'sending' AND locked_until <= UTC_TIMESTAMP(3)");
    // (d) stale attempts, (e) receipt leases
    expect(sql[3]).toContain("SET status = 'uncertain', error_code = 'lease_expired'");
    expect(sql[3]).toContain("status = 'started' AND started_at <= UTC_TIMESTAMP(3) - INTERVAL ? SECOND");
    expect(db.calls[3].values).toEqual([180]);
    expect(sql[4]).toContain("status = 'accepted' AND locked_until IS NOT NULL AND locked_until <= UTC_TIMESTAMP(3)");
  });

  test('a failed delivery is never touched by recovery', async () => {
    const db = recorder();
    await store.recoverExpiredLeases(db, { leaseSeconds: 120 });
    for (const call of db.calls) expect(call.sql).not.toMatch(/status = 'failed' AND|WHERE .*status IN \(.*'failed'/);
  });

  test('expiry: pending after 24 h is cancelled (never tried) or failed (tried); receipt-less after 24 h is uncertain; live leases are left alone', async () => {
    const db = recorder();
    await store.expireStale(db, { expiryHours: 24, receiptMaxAgeHours: 24 });
    const sql = db.calls.map((c) => c.sql);
    expect(sql[0]).toContain("SET status = 'cancelled', last_error_code = 'expired'");
    expect(sql[0]).toContain("status = 'pending' AND attempt_count = 0 AND created_at <= UTC_TIMESTAMP(3) - INTERVAL ? HOUR");
    expect(sql[1]).toContain("SET status = 'failed', last_error_code = 'expired'");
    expect(sql[1]).toContain('attempt_count > 0');
    expect(sql[2]).toContain("SET status = 'uncertain', last_error_code = 'receipt_expired'");
    expect(sql[2]).toContain("status = 'accepted' AND accepted_at <= UTC_TIMESTAMP(3) - INTERVAL ? HOUR");
    for (const s of sql) expect(s).toContain('(locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))');
    expect(db.calls.map((c) => c.values)).toEqual([[24], [24], [24]]);
  });
});

describe('receipts', () => {
  test('only accepted, due, unleased deliveries with a ticket are offered', async () => {
    const db = recorder();
    await store.findReceiptDueIds(db, 100);
    const { sql, values } = db.calls[0];
    expect(sql).toContain("status = 'accepted' AND provider_message_id IS NOT NULL");
    expect(sql).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(values).toEqual([100]);
  });

  test('the receipt lease is a compare-and-swap that keeps the status; ids are validated and bound', async () => {
    const db = recorder();
    await store.claimReceipts(db, [3, 4], { workerId: 'w1', leaseSeconds: 120 });
    const { sql, values } = db.calls[0];
    expect(sql).toContain('id IN (?, ?)');
    expect(sql).toContain("status = 'accepted'");
    expect(sql).not.toContain('SET status');
    expect(values).toEqual(['w1', 120, 3, 4]);
    await expect(store.claimReceipts(recorder(), [1, '2; DROP TABLE x'], { workerId: 'w', leaseSeconds: 1 })).rejects.toThrow();
    expect(await store.claimReceipts(recorder(), [], { workerId: 'w', leaseSeconds: 1 })).toEqual([]);
  });
});

describe('devices', () => {
  test('a DeviceNotRegistered ticket deactivates the device only if it still holds that very token', async () => {
    const db = recorder();
    await store.deactivateDeviceForToken(db, 10, 'ExponentPushToken[x]');
    expect(db.notificationDevice.updateMany).toHaveBeenCalledWith({ where: { id: 10, status: 'active', expoPushToken: 'ExponentPushToken[x]' }, data: expect.objectContaining({ status: 'inactive' }) });
  });

  test('a DeviceNotRegistered receipt deactivates it only if it has not registered since the attempt started', async () => {
    const db = recorder();
    const since = new Date('2026-01-01');
    await store.deactivateDeviceUnchangedSince(db, 10, since);
    expect(db.notificationDevice.updateMany).toHaveBeenCalledWith({ where: { id: 10, status: 'active', lastRegisteredAt: { lte: since } }, data: expect.objectContaining({ status: 'inactive' }) });
  });
});

describe('registration with the worker process', () => {
  test('push-delivery runs every 15 seconds and never on start; the main worker list does NOT schedule it (the dedicated push worker does: push-delivery-worker.test.js)', () => {
    const { jobs } = require('../../src/jobs');
    expect(jobs.filter((j) => j.name === 'push-delivery')).toHaveLength(0);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length);
    expect(require('../../src/jobs/push-delivery.job')).toMatchObject({ name: 'push-delivery', intervalMs: 15000, runOnStart: false });
  });

  test('with the default environment the job does nothing', async () => {
    const saved = process.env.PUSH_DELIVERY_ENABLED;
    delete process.env.PUSH_DELIVERY_ENABLED;
    try {
      expect(await require('../../src/jobs/push-delivery.job').run()).toEqual({ active: false, problem: 'switch_off' });
    } finally { if (saved !== undefined) process.env.PUSH_DELIVERY_ENABLED = saved; }
  });

  test('nothing creates delivery rows or calls the worker yet: no sender, controller or route requires the worker, the store or the Expo client', () => {
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, '../../src');
    const offenders = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith('.js')) return undefined;
      const text = fs.readFileSync(p, 'utf8');
      if (/push-delivery\.(service|store)|expo-push\.client/.test(text) && !/push-delivery[.-](service|store|config|enqueue)\.js$|expo-push\.client\.js$|push-delivery\.job\.js$/.test(p)) offenders.push(path.relative(src, p)); // the enqueue helper has its own caller guard (push-delivery-enqueue.test.js)
      return undefined;
    });
    walk(src);
    expect(offenders).toEqual([]);
  });
});
