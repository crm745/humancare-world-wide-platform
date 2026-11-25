/* global describe, test, expect, jest, beforeEach */
// A patient deletes their account: what happens to their notifications and push devices (notification-devices.service.js retirePatientNotifications, called by the account deletion in
// auth.controller.js confirmAccountDeletion, inside its one transaction).
//   * the push devices become inactive and every open delivery is cancelled, so a retired account's phone is never sent anything;
//   * the in-app history is SOFT-deleted (deletedAt), exactly like the patient's own delete: no notification, delivery or idempotency key is destroyed, so a late event can never create the
//     same notification again, and what was sent stays on record;
//   * only that patient: another patient, and a corporate user with the same numeric id, are untouched (corporate notifications are not changed by any of this).
// A fake transaction that matches the where clauses the service writes; a delete is not implemented on purpose (it would throw). No database, no network.
const fs = require('fs');
const path = require('path');

jest.mock('../../src/db/prisma', () => ({ prisma: {} })); // the functions under test take the transaction as an argument

const { retirePatientNotifications, revokePatientDevices } = require('../../src/modules/notifications/notification-devices.service');

const NOW = new Date('2026-11-25T12:00:00.000Z');
const EARLIER = new Date('2026-11-20T08:00:00.000Z');

function matches(row, where = {}) {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === 'object' && !(want instanceof Date) && Array.isArray(want.in)) return want.in.includes(row[key]);
    if (want === null) return row[key] === null || row[key] === undefined;
    return row[key] === want;
  });
}

function makeDb() {
  const db = {
    devices: [], deliveries: [], notifications: [],
    calls: [],
  };
  const table = (name, rows) => ({
    findMany: async ({ where, select }) => rows().filter((r) => matches(r, where)).map((r) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r })),
    updateMany: async ({ where, data }) => { db.calls.push(`${name}.updateMany`); const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }; },
    // no delete / deleteMany: a hard delete would be a TypeError
  });
  db.tx = {
    notificationDevice: table('notificationDevice', () => db.devices),
    notificationDelivery: table('notificationDelivery', () => db.deliveries),
    notification: table('notification', () => db.notifications),
  };
  return db;
}

let db;
const device = (over) => ({ id: 1, ownerType: 'patient', ownerId: 7, status: 'active', disabledAt: null, ...over });
const delivery = (over) => ({ id: 1, recipientType: 'patient', recipientId: 7, deviceId: 1, status: 'pending', closedAt: null, lockedBy: 'worker-1', lockedUntil: EARLIER, lastErrorCode: null, ...over });
const notification = (over) => ({ id: 1, recipientType: 'patient', recipientId: 7, deletedAt: null, idempotencyKey: 'stage:1', title: 't', body: 'b', ...over });

beforeEach(() => {
  db = makeDb();
  db.devices.push(device({ id: 1 }), device({ id: 2, status: 'inactive', disabledAt: EARLIER }), device({ id: 3, ownerId: 8 }), device({ id: 4, ownerType: 'corporate_user', ownerId: 7 }));
  db.deliveries.push(
    delivery({ id: 10, status: 'pending' }),
    delivery({ id: 11, status: 'sending' }),
    delivery({ id: 12, status: 'accepted' }),
    delivery({ id: 13, status: 'delivered' }),
    delivery({ id: 14, status: 'failed' }),
    delivery({ id: 15, status: 'pending', deviceId: null }), // an open delivery no device row covers: still cancelled
    delivery({ id: 20, recipientId: 8, deviceId: 3, status: 'pending' }), // another patient
    delivery({ id: 21, recipientType: 'corporate_user', recipientId: 7, deviceId: 4, status: 'pending' }), // a corporate user with the same id
  );
  db.notifications.push(
    notification({ id: 1, idempotencyKey: 'stage:1' }),
    notification({ id: 2, idempotencyKey: 'quotation:5' }),
    notification({ id: 3, idempotencyKey: 'payment:9', deletedAt: EARLIER }), // the patient had already deleted this one
    notification({ id: 4, recipientId: 8, idempotencyKey: 'stage:2' }), // another patient
    notification({ id: 5, recipientType: 'corporate_user', recipientId: 7, idempotencyKey: 'corp:1' }), // a corporate user with the same id
  );
});

describe('retirePatientNotifications', () => {
  test('the patient\'s devices become inactive; another patient\'s and a corporate user\'s are untouched', async () => {
    const result = await retirePatientNotifications(db.tx, 7, { now: NOW });
    expect(db.devices.find((d) => d.id === 1)).toMatchObject({ status: 'inactive', disabledAt: NOW });
    expect(db.devices.find((d) => d.id === 2)).toMatchObject({ status: 'inactive', disabledAt: EARLIER }); // already inactive: its original time is kept
    expect(db.devices.find((d) => d.id === 3)).toMatchObject({ status: 'active', disabledAt: null });
    expect(db.devices.find((d) => d.id === 4)).toMatchObject({ status: 'active', disabledAt: null });
    expect(result.devices).toBe(1);
  });

  test('every open delivery of the patient is cancelled with the reason and its lease cleared (a worker that still holds it is fenced out); closed ones are left exactly as they were', async () => {
    const result = await retirePatientNotifications(db.tx, 7, { reason: 'account_deleted', now: NOW });
    for (const id of [10, 11, 15]) expect(db.deliveries.find((d) => d.id === id)).toMatchObject({ status: 'cancelled', closedAt: NOW, lockedBy: null, lockedUntil: null, lastErrorCode: 'account_deleted' });
    for (const [id, status] of [[12, 'accepted'], [13, 'delivered'], [14, 'failed']]) expect(db.deliveries.find((d) => d.id === id)).toMatchObject({ status, closedAt: null, lastErrorCode: null });
    expect(db.deliveries.find((d) => d.id === 20)).toMatchObject({ status: 'pending', lockedBy: 'worker-1' }); // another patient
    expect(db.deliveries.find((d) => d.id === 21)).toMatchObject({ status: 'pending', lockedBy: 'worker-1' }); // corporate
    expect(result.deliveries).toBe(3);
  });

  test('the in-app history is soft-deleted, never destroyed: every row, its idempotency key and its text are still there', async () => {
    const before = db.notifications.map((n) => ({ id: n.id, key: n.idempotencyKey, title: n.title, body: n.body }));
    const result = await retirePatientNotifications(db.tx, 7, { now: NOW });
    expect(db.notifications).toHaveLength(5); // nothing was deleted
    expect(db.notifications.map((n) => ({ id: n.id, key: n.idempotencyKey, title: n.title, body: n.body }))).toEqual(before);
    expect(db.notifications.find((n) => n.id === 1).deletedAt).toBe(NOW);
    expect(db.notifications.find((n) => n.id === 2).deletedAt).toBe(NOW);
    expect(db.notifications.find((n) => n.id === 3).deletedAt).toBe(EARLIER); // an earlier delete by the patient keeps its own time
    expect(result.notifications).toBe(2);
  });

  test('another patient\'s and a corporate user\'s notifications are not changed (corporate notification behaviour is untouched)', async () => {
    await retirePatientNotifications(db.tx, 7, { now: NOW });
    expect(db.notifications.find((n) => n.id === 4).deletedAt).toBeNull();
    expect(db.notifications.find((n) => n.id === 5).deletedAt).toBeNull();
  });

  test('a late event for the same thing cannot create the notification again: the idempotency key of a retired account\'s notification is still taken', async () => {
    await retirePatientNotifications(db.tx, 7, { now: NOW });
    const taken = new Set(db.notifications.map((n) => n.idempotencyKey));
    for (const key of ['stage:1', 'quotation:5', 'payment:9']) expect(taken.has(key)).toBe(true);
  });

  test('it is repeatable: a second run changes nothing', async () => {
    await retirePatientNotifications(db.tx, 7, { now: NOW });
    const snapshot = JSON.stringify(db);
    const again = await retirePatientNotifications(db.tx, 7, { now: new Date('2026-11-26T00:00:00.000Z') });
    expect(again).toEqual({ devices: 0, deliveries: 0, notifications: 0 });
    expect(JSON.stringify(db.devices)).toBe(JSON.stringify(JSON.parse(snapshot).devices));
    expect(JSON.stringify(db.deliveries)).toBe(JSON.stringify(JSON.parse(snapshot).deliveries));
    expect(JSON.stringify(db.notifications)).toBe(JSON.stringify(JSON.parse(snapshot).notifications));
  });

  test('a patient with no devices and no notifications is simply retired; a bad id is refused before anything is written', async () => {
    expect(await retirePatientNotifications(db.tx, 999, { now: NOW })).toEqual({ devices: 0, deliveries: 0, notifications: 0 });
    for (const bad of [0, -1, 1.5, '7', null, undefined, NaN]) await expect(retirePatientNotifications(db.tx, bad)).rejects.toThrow(/needs a patient id/);
  });

  test('it never uses a delete: only updates (the fake transaction has no delete at all)', async () => {
    await retirePatientNotifications(db.tx, 7, { now: NOW });
    expect(db.calls.every((c) => c.endsWith('.updateMany') || c === 'notificationDevice.findMany')).toBe(true);
  });

  test('it runs the same device revocation as a password reset (one shared code), then covers what that one does not', async () => {
    const reset = makeDb();
    reset.devices.push(device({ id: 1 }));
    reset.deliveries.push(delivery({ id: 10 }));
    await revokePatientDevices(reset.tx, 7, { reason: 'session_revoked', now: NOW });
    expect(reset.devices[0].status).toBe('inactive');
    expect(reset.deliveries[0].status).toBe('cancelled');
    expect(reset.deliveries[0].lastErrorCode).toBe('session_revoked');
  });
});

describe('the account deletion in the auth controller', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/modules/auth/auth.controller.js'), 'utf8');
  const deletion = source.slice(source.indexOf('async function confirmAccountDeletion'), source.indexOf('module.exports'));

  test('the retirement is ONE transaction that clears the identity, kills the tokens and retires the notifications together', () => {
    expect(deletion).toMatch(/await prisma\.\$transaction\(async \(tx\) => \{/);
    const tx = deletion.slice(deletion.indexOf('await prisma.$transaction'));
    expect(tx.indexOf('tx.user.update')).toBeGreaterThan(-1);
    expect(tx.indexOf('tx.user.update')).toBeLessThan(tx.indexOf('retirePatientNotifications(tx, user.id'));
    expect(tx).toContain('tokenVersion: { increment: 1 }');
  });

  test('no notification, delivery or device row is hard-deleted by the account deletion', () => {
    expect(deletion).not.toMatch(/notification\.deleteMany|notification\.delete\(|notificationDelivery\.delete|notificationDevice\.delete/);
    expect(deletion).not.toMatch(/\.delete(Many)?\(\{[^}]*recipientType/);
    expect(deletion).toContain('retirePatientNotifications(tx, user.id');
  });

  test('the service stays patient-only: its queries are all scoped to recipientType/ownerType "patient"', () => {
    const service = fs.readFileSync(path.join(__dirname, '../../src/modules/notifications/notification-devices.service.js'), 'utf8');
    const fn = service.slice(service.indexOf('async function retirePatientNotifications'), service.indexOf('module.exports'));
    expect(fn).not.toMatch(/corporate/i);
    expect(fn.match(/recipientType: OWNER_TYPE/g)).toHaveLength(2);
    expect(fn).not.toMatch(/\.delete(Many)?\(/);
  });
});
