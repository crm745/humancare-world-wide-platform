/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// Patient notification preferences over HTTP (supertest) through the real router, auth middleware, controller and services,
// plus the in-app preference's effect on the patient list. No database, no network: Prisma is an in-memory fake.
const mockDb = { users: [], prefs: [], notifications: [], calls: [], raceOnce: false, upsertError: null };

function mockUniqueError() {
  const err = new Error('Unique constraint failed');
  err.code = 'P2002';
  err.meta = { target: 'notification_preferences_owner_key' };
  return err;
}

function mockOwnerOf(where) { return where.ownerType_ownerId; }
function mockMatches(row, where) {
  return Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
}
function mockPick(row, select) {
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

jest.mock('../../src/db/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async ({ where }) => { mockDb.calls.push('user.findUnique'); return mockDb.users.find((u) => u.id === where.id) || null; }),
    },
    notificationPreference: {
      findUnique: jest.fn(async ({ where, select }) => {
        mockDb.calls.push('pref.findUnique');
        const o = mockOwnerOf(where);
        const row = mockDb.prefs.find((r) => r.ownerType === o.ownerType && r.ownerId === o.ownerId);
        return row ? mockPick(row, select) : null;
      }),
      upsert: jest.fn(async ({ where, create, update, select }) => {
        mockDb.calls.push('pref.upsert');
        if (mockDb.upsertError) throw mockDb.upsertError;
        const o = mockOwnerOf(where);
        const find = () => mockDb.prefs.find((r) => r.ownerType === o.ownerType && r.ownerId === o.ownerId);
        if (mockDb.raceOnce) { // another request inserted the row between our (absent) read and our insert
          mockDb.raceOnce = false;
          mockDb.prefs.push({ id: 1, ownerType: o.ownerType, ownerId: o.ownerId, inAppEnabled: true, pushEnabled: true });
          throw mockUniqueError();
        }
        let row = find();
        if (row) Object.assign(row, update);
        else { row = { id: mockDb.prefs.length + 1, inAppEnabled: true, pushEnabled: true, ...create }; mockDb.prefs.push(row); } // column defaults are true
        return mockPick(row, select);
      }),
    },
    notification: {
      findMany: jest.fn(async (args) => { mockDb.calls.push(['notification.findMany', args]); return mockDb.notifications.filter((n) => mockMatches(n, args.where)).map((n) => mockPick(n, args.select || Object.fromEntries(Object.keys(n).map((k) => [k, true])))); }),
    },
  },
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/db/prisma');
const { notificationsRouter } = require('../../src/modules/notifications/notifications.routes');

const SECRET = 'fake-route-jwt-secret-0123456789';
const token = (payload) => jwt.sign(payload, SECRET, { expiresIn: '5m' });
const P1 = token({ sub: 1, role: 'patient' });
const P2 = token({ sub: 2, role: 'patient' });
const GHOST = token({ sub: 99, role: 'patient' }); // a valid token whose user no longer exists
const CORP = token({ sub: 1, role: 'corporate', corporateId: 1 });
const ADMIN = token({ sub: 1, role: 'admin' });

const app = express();
app.use(express.json());
app.use('/notifications', notificationsRouter);
// The same contract as src/app.js: status from err.statusCode, message, and the deliberate publicCode.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal server error', ...(err.statusCode && err.publicCode && { code: err.publicCode }) }));

let savedSecret;
beforeAll(() => { savedSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = SECRET; });
afterAll(() => { if (savedSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = savedSecret; });
beforeEach(() => {
  Object.assign(mockDb, { users: [{ id: 1 }, { id: 2 }], prefs: [], notifications: [], calls: [], raceOnce: false, upsertError: null });
  jest.clearAllMocks();
});

const get = (tok) => { const r = request(app).get('/notifications/preferences'); return tok ? r.set('Authorization', `Bearer ${tok}`) : r; };
const patch = (tok, body) => { const r = request(app).patch('/notifications/preferences'); if (tok) r.set('Authorization', `Bearer ${tok}`); return body === undefined ? r : r.send(body); };

describe('GET /notifications/preferences', () => {
  test('with no row returns both true and inserts nothing', async () => {
    const res = await get(P1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: true } });
    expect(mockDb.prefs).toHaveLength(0);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  test('returns only the two switches, never internal columns, of the caller\'s own row', async () => {
    mockDb.prefs = [{ id: 7, ownerType: 'patient', ownerId: 1, inAppEnabled: false, pushEnabled: true, categoryPreferences: { x: 1 } }, { id: 8, ownerType: 'patient', ownerId: 2, inAppEnabled: true, pushEnabled: false }];
    const res = await get(P1);
    expect(res.body).toEqual({ preferences: { inAppEnabled: false, pushEnabled: true } });
    expect(Object.keys(res.body.preferences)).toEqual(['inAppEnabled', 'pushEnabled']);
  });

  test('a corporate_user row with the same id is never read', async () => {
    mockDb.prefs = [{ id: 1, ownerType: 'corporate_user', ownerId: 1, inAppEnabled: false, pushEnabled: false }];
    expect((await get(P1)).body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: true } });
  });
});

describe('PATCH /notifications/preferences', () => {
  test('the first PATCH creates the row with only the supplied field; the omitted one keeps the database default', async () => {
    const res = await patch(P1, { pushEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: false } });
    expect(mockDb.prefs).toHaveLength(1);
    const args = prisma.notificationPreference.upsert.mock.calls[0][0];
    expect(args.create).toEqual({ ownerType: 'patient', ownerId: 1, pushEnabled: false }); // no inAppEnabled key
    expect(args.update).toEqual({ pushEnabled: false });
    expect(args.where).toEqual({ ownerType_ownerId: { ownerType: 'patient', ownerId: 1 } });
  });

  test('partial updates change only what is sent', async () => {
    await patch(P1, { pushEnabled: false });
    const res = await patch(P1, { inAppEnabled: false });
    expect(res.body).toEqual({ preferences: { inAppEnabled: false, pushEnabled: false } });
    expect((await patch(P1, { pushEnabled: true })).body).toEqual({ preferences: { inAppEnabled: false, pushEnabled: true } });
    expect((await patch(P1, { inAppEnabled: true, pushEnabled: true })).body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: true } });
    expect(mockDb.prefs).toHaveLength(1);
  });

  test('a PATCH is read back by GET', async () => {
    await patch(P1, { inAppEnabled: false });
    expect((await get(P1)).body).toEqual({ preferences: { inAppEnabled: false, pushEnabled: true } });
  });

  test.each([
    ['an empty object', {}],
    ['a string boolean', { inAppEnabled: 'true' }],
    ['a number', { pushEnabled: 1 }],
    ['null', { inAppEnabled: null }],
    ['an object value', { pushEnabled: {} }],
    ['an unknown field', { foo: true }],
    ['a valid field plus an unknown one', { inAppEnabled: true, extra: 1 }],
    ['categoryPreferences', { categoryPreferences: {} }],
    ['an owner id in the body', { inAppEnabled: true, ownerId: 2 }],
    ['an owner type in the body', { inAppEnabled: true, ownerType: 'corporate_user' }],
    ['a JSON array', [{ inAppEnabled: true }]],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const res = await patch(P1, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_preferences');
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    expect(mockDb.prefs).toHaveLength(0);
  });

  test('a request with no body is a 400', async () => {
    const res = await patch(P1);
    expect(res.status).toBe(400);
    expect(mockDb.prefs).toHaveLength(0);
  });
});

describe('ownership isolation', () => {
  test('the owner is the token\'s patient; query owner ids are ignored', async () => {
    const res = await request(app).patch('/notifications/preferences?ownerId=2&ownerType=corporate_user').set('Authorization', `Bearer ${P1}`).send({ inAppEnabled: false });
    expect(res.status).toBe(200);
    expect(mockDb.prefs).toHaveLength(1);
    expect(mockDb.prefs[0]).toMatchObject({ ownerType: 'patient', ownerId: 1, inAppEnabled: false });
    expect((await get(P2)).body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: true } }); // patient 2 untouched
  });

  test('two patients keep separate rows', async () => {
    await patch(P1, { inAppEnabled: false });
    await patch(P2, { pushEnabled: false });
    expect((await get(P1)).body.preferences).toEqual({ inAppEnabled: false, pushEnabled: true });
    expect((await get(P2)).body.preferences).toEqual({ inAppEnabled: true, pushEnabled: false });
    expect(mockDb.prefs).toHaveLength(2);
  });

  test('there is no route that takes an owner id', () => {
    const paths = notificationsRouter.stack.filter((l) => l.route && /preferences/.test(l.route.path)).map((l) => l.route.path);
    expect(paths).toEqual(['/preferences', '/preferences']);
  });
});

describe('User existence on PATCH', () => {
  test('a patient whose account no longer exists gets 404 and no row is created', async () => {
    const res = await patch(GHOST, { inAppEnabled: false });
    expect(res.status).toBe(404);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    expect(mockDb.prefs).toHaveLength(0);
  });

  test('validation runs first: a bad body is 400 even for such a patient, with no lookup', async () => {
    const res = await patch(GHOST, { nope: true });
    expect(res.status).toBe(400);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('role gating', () => {
  test.each([['GET', get], ['PATCH', (t) => patch(t, { inAppEnabled: false })]])('%s requires a patient token', async (_m, call) => {
    expect((await call()).status).toBe(401);
    expect((await call('not-a-token')).status).toBe(401);
    expect((await call(CORP)).status).toBe(403);
    expect((await call(ADMIN)).status).toBe(401);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
    expect(mockDb.prefs).toHaveLength(0);
  });
});

describe('first-insert race (P2002)', () => {
  test('the loser retries once and applies its own change to the row the winner created', async () => {
    mockDb.raceOnce = true;
    const res = await patch(P1, { pushEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferences: { inAppEnabled: true, pushEnabled: false } });
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(2);
    expect(mockDb.prefs).toHaveLength(1);
    expect(mockDb.prefs[0].pushEnabled).toBe(false);
  });

  test('a second consecutive P2002 is not retried again', async () => {
    mockDb.upsertError = mockUniqueError();
    const res = await patch(P1, { pushEnabled: false });
    expect(res.status).toBe(500);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(2);
  });

  test('unrelated Prisma errors are not swallowed or retried', async () => {
    mockDb.upsertError = Object.assign(new Error('FK failed'), { code: 'P2003' });
    expect((await patch(P1, { pushEnabled: false })).status).toBe(500);
    mockDb.upsertError = new Error('connection lost');
    expect((await patch(P1, { pushEnabled: false })).status).toBe(500);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(2); // once each, no retry
  });
});

describe('in-app preference and the patient list', () => {
  const rows = () => [
    { id: 1, recipientType: 'patient', recipientId: 1, kind: 'stage_update', title: 'a', isMandatory: false, readAt: null, deletedAt: null, createdAt: new Date(2026, 0, 1) },
    { id: 2, recipientType: 'patient', recipientId: 1, kind: 'security_new_login', title: 'b', isMandatory: true, readAt: null, deletedAt: null, createdAt: new Date(2026, 0, 2) },
    { id: 3, recipientType: 'patient', recipientId: 1, kind: 'payment_failed', title: 'c', isMandatory: true, readAt: new Date(), deletedAt: null, createdAt: new Date(2026, 0, 3) },
    { id: 4, recipientType: 'patient', recipientId: 1, kind: 'system', title: 'd', isMandatory: false, readAt: new Date(), deletedAt: null, createdAt: new Date(2026, 0, 4) },
    { id: 5, recipientType: 'patient', recipientId: 2, kind: 'system', title: 'e', isMandatory: false, readAt: null, deletedAt: null, createdAt: new Date(2026, 0, 5) },
  ];
  const list = async (tok, q = '') => (await request(app).get(`/notifications${q}`).set('Authorization', `Bearer ${tok}`)).body.notifications.map((n) => n.id).sort();
  const lastWhere = () => mockDb.calls.filter((c) => Array.isArray(c) && c[0] === 'notification.findMany').at(-1)[1].where;

  test('no preference row: existing behavior, the query has no isMandatory condition', async () => {
    mockDb.notifications = rows();
    expect(await list(P1)).toEqual([1, 2, 3, 4]);
    expect(lastWhere()).toEqual({ recipientType: 'patient', recipientId: 1, deletedAt: null });
  });

  test('in-app ON: the same existing behavior, nothing hidden', async () => {
    mockDb.notifications = rows();
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 1, inAppEnabled: true, pushEnabled: true }];
    expect(await list(P1)).toEqual([1, 2, 3, 4]);
    expect(lastWhere()).toEqual({ recipientType: 'patient', recipientId: 1, deletedAt: null });
    expect(await list(P1, '?unreadOnly=true')).toEqual([1, 2]);
  });

  test('in-app OFF: non-mandatory notifications are hidden, mandatory ones stay (read or unread)', async () => {
    mockDb.notifications = rows();
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 1, inAppEnabled: false, pushEnabled: true }];
    expect(await list(P1)).toEqual([2, 3]);
    expect(lastWhere()).toEqual({ recipientType: 'patient', recipientId: 1, deletedAt: null, isMandatory: true });
  });

  test('in-app OFF also applies to the unread-only list (the bell source)', async () => {
    mockDb.notifications = rows();
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 1, inAppEnabled: false, pushEnabled: true }];
    expect(await list(P1, '?unreadOnly=true')).toEqual([2]);
  });

  test('nothing is deleted or altered: records stay and reappear when in-app is switched back ON', async () => {
    mockDb.notifications = rows();
    await patch(P1, { inAppEnabled: false });
    expect(await list(P1)).toEqual([2, 3]);
    expect(mockDb.notifications).toHaveLength(5);
    expect(mockDb.notifications.every((n) => n.deletedAt === null)).toBe(true);
    await patch(P1, { inAppEnabled: true });
    expect(await list(P1)).toEqual([1, 2, 3, 4]);
  });

  test('push OFF alone does not change the list', async () => {
    mockDb.notifications = rows();
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 1, inAppEnabled: true, pushEnabled: false }];
    expect(await list(P1)).toEqual([1, 2, 3, 4]);
  });

  test('another patient\'s preference does not affect this patient\'s list', async () => {
    mockDb.notifications = rows();
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 2, inAppEnabled: false, pushEnabled: false }];
    expect(await list(P1)).toEqual([1, 2, 3, 4]);
    expect(await list(P2)).toEqual([]); // patient 2: in-app OFF and their one notification is non-mandatory
  });

  test('the list response keeps its wrapper, fields and select', async () => {
    mockDb.notifications = rows();
    const res = await request(app).get('/notifications').set('Authorization', `Bearer ${P1}`);
    expect(Object.keys(res.body)).toEqual(['notifications']);
    const call = mockDb.calls.find((c) => Array.isArray(c) && c[0] === 'notification.findMany')[1];
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(Object.keys(call.select).sort()).toEqual(['body', 'caseId', 'createdAt', 'data', 'id', 'isMandatory', 'kind', 'quotationId', 'readAt', 'serviceRequestId', 'title']);
  });

  test('corporate listing is unchanged: no preference lookup, no isMandatory condition, whatever a patient with the same id chose', async () => {
    mockDb.prefs = [{ ownerType: 'patient', ownerId: 1, inAppEnabled: false, pushEnabled: false }];
    mockDb.notifications = [{ id: 9, recipientType: 'corporate_user', recipientId: 1, kind: 'system', title: 'x', isMandatory: false, readAt: null, deletedAt: null, createdAt: new Date() }];
    const res = await request(app).get('/notifications').set('Authorization', `Bearer ${CORP}`);
    expect(res.body.notifications.map((n) => n.id)).toEqual([9]);
    expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
    expect(lastWhere()).toEqual({ recipientType: 'corporate_user', recipientId: 1 });
  });
});

describe('scope', () => {
  test('the preferences service does not touch the notification core, deliveries, devices or push', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/modules/notifications/notification-preferences.service.js'), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect([...src.matchAll(/require\(([^)]+)\)/g)].map((m) => m[1])).toEqual(["'../../db/prisma'"]);
    expect(src).not.toMatch(/notificationDelivery|notificationDevice|sendExpoPush|fetch\(|corporate/i);
  });
});
