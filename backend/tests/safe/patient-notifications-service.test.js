/* global describe, test, expect, jest, beforeEach */
// Patient notification list / read / soft-delete safety. No database: prisma is an in-memory fake that records every call.
const mockStore = { rows: [], calls: [] };

function mockMatches(row, where) {
  return Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
}

// Like Prisma's `select`: only the selected columns come back; without one, the whole row.
function mockProject(row, select) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

jest.mock('../../src/db/prisma', () => ({
  prisma: {
    notification: {
      findMany: jest.fn(async (args) => { mockStore.calls.push(['findMany', args]); return mockStore.rows.filter((r) => mockMatches(r, args.where)).sort((a, b) => b.createdAt - a.createdAt).map((r) => mockProject(r, args.select)); }),
      findFirst: jest.fn(async (args) => { mockStore.calls.push(['findFirst', args]); return mockStore.rows.find((r) => mockMatches(r, args.where)) || null; }),
      update: jest.fn(async (args) => { mockStore.calls.push(['update', args]); const row = mockStore.rows.find((r) => r.id === args.where.id); Object.assign(row, args.data); return mockProject(row, args.select); }),
      updateMany: jest.fn(async (args) => { mockStore.calls.push(['updateMany', args]); const hit = mockStore.rows.filter((r) => mockMatches(r, args.where)); hit.forEach((r) => Object.assign(r, args.data)); return { count: hit.length }; }),
      delete: jest.fn(async () => { throw new Error('hard delete must not be used'); }),
    },
    notificationPreference: { findUnique: jest.fn(async () => null) }, // no preference row: the defaults (in-app ON)
  },
}));

const { prisma } = require('../../src/db/prisma');
const svc = require('../../src/modules/notifications/notifications.service');
const { listMine, markOneRead, markAllMineRead } = require('../../src/modules/notifications/notifications.controller');

let nextId;
const row = (over = {}) => ({
  id: nextId++, recipientType: 'patient', recipientId: 1, kind: 'system', title: 't', body: null, readAt: null,
  createdAt: new Date(2026, 0, nextId), deletedAt: null, idempotencyKey: 'secret-key', updatedAt: new Date(),
  isMandatory: false, data: null, caseId: null, serviceRequestId: null, quotationId: null, ...over,
});
const PUBLIC_KEYS = ['body', 'caseId', 'createdAt', 'data', 'id', 'isMandatory', 'kind', 'quotationId', 'readAt', 'serviceRequestId', 'title'];
const EXCLUDED_KEYS = ['idempotencyKey', 'deletedAt', 'updatedAt', 'recipientType', 'recipientId'];
const pub = (r) => Object.fromEntries(PUBLIC_KEYS.map((k) => [k, r[k]]));
const ids = (list) => list.map((n) => n.id);
const rejects404 = async (p) => { await expect(p).rejects.toMatchObject({ statusCode: 404, message: 'Notification not found' }); };

beforeEach(() => {
  nextId = 1;
  mockStore.rows = [];
  mockStore.calls = [];
  jest.clearAllMocks();
});

describe('listPatientNotifications', () => {
  test('returns only the patient\'s own, newest first, without soft-deleted rows', async () => {
    mockStore.rows = [row({ createdAt: new Date(2026, 0, 1) }), row({ createdAt: new Date(2026, 0, 3) }), row({ deletedAt: new Date() }), row({ recipientId: 2 }), row({ recipientType: 'corporate_user' })];
    const list = await svc.listPatientNotifications(1);
    expect(ids(list)).toEqual([2, 1]);
  });

  test('every list query carries deletedAt: null and the patient scope, ordered by createdAt desc', async () => {
    await svc.listPatientNotifications(1);
    await svc.listPatientNotifications(1, { unreadOnly: 'true' });
    for (const [, args] of mockStore.calls) {
      expect(args.where).toMatchObject({ recipientType: 'patient', recipientId: 1, deletedAt: null });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
    }
  });

  test('unreadOnly=true (string or boolean) keeps only unread rows; anything else lists all', async () => {
    mockStore.rows = [row({ readAt: new Date() }), row(), row({ deletedAt: new Date() })];
    expect(ids(await svc.listPatientNotifications(1, { unreadOnly: 'true' }))).toEqual([2]);
    expect(ids(await svc.listPatientNotifications(1, { unreadOnly: true }))).toEqual([2]);
    expect(ids(await svc.listPatientNotifications(1, { unreadOnly: 'false' })).sort()).toEqual([1, 2]);
    expect(ids(await svc.listPatientNotifications(1)).sort()).toEqual([1, 2]);
  });

  test('a read-then-deleted notification no longer counts as unread', async () => {
    mockStore.rows = [row({ deletedAt: new Date() })];
    expect(await svc.listPatientNotifications(1, { unreadOnly: 'true' })).toEqual([]);
  });
});

describe('explicit select: internal fields are never exposed to a patient', () => {
  test('the select is exactly the approved allow-list', () => {
    expect(Object.keys(svc.PATIENT_NOTIFICATION_SELECT).sort()).toEqual(PUBLIC_KEYS);
    expect(Object.values(svc.PATIENT_NOTIFICATION_SELECT).every((v) => v === true)).toBe(true);
    for (const k of EXCLUDED_KEYS) expect(svc.PATIENT_NOTIFICATION_SELECT).not.toHaveProperty(k);
    expect(Object.isFrozen(svc.PATIENT_NOTIFICATION_SELECT)).toBe(true);
  });

  test('the list query passes the select, and the rows carry no excluded field but keep the mobile-read ones', async () => {
    mockStore.rows = [row({ title: 'Hello', body: 'B', data: { screen: 'home' }, isMandatory: true })];
    const list = await svc.listPatientNotifications(1);
    expect(mockStore.calls[0][1].select).toBe(svc.PATIENT_NOTIFICATION_SELECT);
    expect(Object.keys(list[0]).sort()).toEqual(PUBLIC_KEYS);
    for (const k of EXCLUDED_KEYS) expect(list[0]).not.toHaveProperty(k);
    for (const k of ['id', 'kind', 'title', 'body', 'readAt', 'createdAt']) expect(list[0]).toHaveProperty(k); // read by the mobile app
    expect(list[0]).toMatchObject({ title: 'Hello', body: 'B', isMandatory: true, data: { screen: 'home' } });
  });

  test('mark-read and read-status responses use the same select', async () => {
    mockStore.rows = [row()];
    for (const out of [await svc.markPatientNotificationRead(1, 1), await svc.setPatientReadStatus(1, 1, true)]) {
      expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
      for (const k of EXCLUDED_KEYS) expect(out).not.toHaveProperty(k);
    }
    expect(mockStore.calls.filter(([n]) => n === 'update').every(([, a]) => a.select === svc.PATIENT_NOTIFICATION_SELECT)).toBe(true);
  });

  test('the corporate list still selects every column', async () => {
    mockStore.rows = [row({ recipientType: 'corporate_user' })];
    await svc.listNotificationsFor('corporate_user', 1);
    expect(mockStore.calls[0][1].select).toBeUndefined();
  });
});

describe('markPatientNotificationRead / setPatientReadStatus', () => {
  test('marks the patient\'s own notification read and returns the updated row', async () => {
    mockStore.rows = [row()];
    const out = await svc.markPatientNotificationRead(1, '1');
    expect(out.readAt).toBeInstanceOf(Date);
    expect(mockStore.rows[0].readAt).toBeInstanceOf(Date);
  });

  test('another patient\'s, a soft-deleted, a corporate and an unknown notification are all 404 and unchanged', async () => {
    mockStore.rows = [row({ recipientId: 2 }), row({ deletedAt: new Date() }), row({ recipientType: 'corporate_user', recipientId: 1 })];
    for (const id of [1, 2, 3, 99]) await rejects404(svc.markPatientNotificationRead(1, id));
    expect(mockStore.rows.every((r) => r.readAt === null)).toBe(true);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  test('an id that is not a positive integer is a 404, not a database error', async () => {
    for (const bad of ['abc', '', '0', '-1', '1.5', undefined, null, 'NaN']) await rejects404(svc.markPatientNotificationRead(1, bad));
    expect(prisma.notification.findFirst).not.toHaveBeenCalled();
  });

  test('setPatientReadStatus can read and un-read, with the same protections', async () => {
    mockStore.rows = [row(), row({ recipientId: 2 }), row({ deletedAt: new Date() })];
    expect((await svc.setPatientReadStatus(1, 1, true)).readAt).toBeInstanceOf(Date);
    expect((await svc.setPatientReadStatus(1, 1, false)).readAt).toBeNull();
    await rejects404(svc.setPatientReadStatus(1, 2, true));
    await rejects404(svc.setPatientReadStatus(1, 3, true));
    expect(mockStore.rows[1].readAt).toBeNull();
    expect(mockStore.rows[2].readAt).toBeNull();
  });
});

describe('markAllPatientNotificationsRead', () => {
  test('marks only the patient\'s own unread, non-deleted notifications', async () => {
    mockStore.rows = [row(), row({ deletedAt: new Date() }), row({ recipientId: 2 }), row({ recipientType: 'corporate_user', recipientId: 1 })];
    expect(await svc.markAllPatientNotificationsRead(1)).toEqual({ ok: true });
    expect(mockStore.rows[0].readAt).toBeInstanceOf(Date);
    expect(mockStore.rows[1].readAt).toBeNull(); // soft-deleted: untouched
    expect(mockStore.rows[2].readAt).toBeNull(); // another patient
    expect(mockStore.rows[3].readAt).toBeNull(); // corporate
  });

  test('the update is scoped in its WHERE clause', async () => {
    await svc.markAllPatientNotificationsRead(7);
    expect(mockStore.calls[0][1].where).toEqual({ recipientType: 'patient', recipientId: 7, readAt: null, deletedAt: null });
  });
});

describe('deletePatientNotification (soft delete)', () => {
  test('sets deletedAt, keeps the row and its idempotencyKey, and never hard-deletes', async () => {
    mockStore.rows = [row({ idempotencyKey: 'stage_update:patient:1:evt9' })];
    await expect(svc.deletePatientNotification(1, '1')).resolves.toBeUndefined();
    expect(mockStore.rows).toHaveLength(1);
    expect(mockStore.rows[0].deletedAt).toBeInstanceOf(Date);
    expect(mockStore.rows[0].idempotencyKey).toBe('stage_update:patient:1:evt9');
    expect(prisma.notification.delete).not.toHaveBeenCalled();
    // the update touches deletedAt only
    expect(Object.keys(mockStore.calls[0][1].data)).toEqual(['deletedAt']);
  });

  test('a deleted notification disappears from the list and the unread list', async () => {
    mockStore.rows = [row(), row()];
    await svc.deletePatientNotification(1, 1);
    expect(ids(await svc.listPatientNotifications(1))).toEqual([2]);
    expect(ids(await svc.listPatientNotifications(1, { unreadOnly: 'true' }))).toEqual([2]);
    await rejects404(svc.markPatientNotificationRead(1, 1));
  });

  test('repeated deletion is the existing 404 and does not move deletedAt', async () => {
    mockStore.rows = [row()];
    await svc.deletePatientNotification(1, 1);
    const first = mockStore.rows[0].deletedAt;
    await rejects404(svc.deletePatientNotification(1, 1));
    expect(mockStore.rows[0].deletedAt).toBe(first);
  });

  test('another patient\'s, a corporate and an unknown notification cannot be deleted', async () => {
    mockStore.rows = [row({ recipientId: 2 }), row({ recipientType: 'corporate_user', recipientId: 1 })];
    for (const id of [1, 2, 99, 'abc']) await rejects404(svc.deletePatientNotification(1, id));
    expect(mockStore.rows.every((r) => r.deletedAt === null)).toBe(true);
  });
});

describe('controller: patient path and unchanged corporate path', () => {
  const res = () => { const r = { json: jest.fn() }; return r; };
  const req = (role, over = {}) => ({ user: { id: 1, role }, query: {}, params: {}, ...over });

  test('a patient list goes through the soft-delete-aware query and keeps the { notifications } shape', async () => {
    mockStore.rows = [row(), row({ deletedAt: new Date() })];
    const r = res();
    await listMine(req('patient', { query: { unreadOnly: 'true' } }), r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ notifications: [pub(mockStore.rows[0])] });
  });

  test('a patient mark-read keeps the { notification } shape; a missing one reaches next() as a 404', async () => {
    mockStore.rows = [row()];
    const r = res();
    await markOneRead(req('patient', { params: { id: '1' } }), r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ notification: pub(mockStore.rows[0]) });
    const next = jest.fn();
    await markOneRead(req('patient', { params: { id: '5' } }), res(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404 });
  });

  test('a patient mark-all-read answers { ok: true }', async () => {
    mockStore.rows = [row()];
    const r = res();
    await markAllMineRead(req('patient'), r, jest.fn());
    expect(r.json).toHaveBeenCalledWith({ ok: true });
    expect(mockStore.rows[0].readAt).toBeInstanceOf(Date);
  });

  test('a corporate user still takes the original queries (no deletedAt filter, hard delete function untouched)', async () => {
    mockStore.rows = [row({ recipientType: 'corporate_user' })];
    await listMine(req('corporate'), res(), jest.fn());
    expect(mockStore.calls[0][1].where).toEqual({ recipientType: 'corporate_user', recipientId: 1 });
    await markAllMineRead(req('corporate'), res(), jest.fn());
    expect(mockStore.calls[1][1].where).toEqual({ recipientType: 'corporate_user', recipientId: 1, readAt: null });
    await svc.deleteNotification('corporate_user', 1, 1).catch((e) => e);
    expect(prisma.notification.delete).toHaveBeenCalled(); // the shared hard delete is intentionally unchanged
  });
});
