/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// DELETE /notifications/:id over HTTP (supertest) through the real notifications router, auth middleware and controller.
// Prisma is an in-memory fake; nothing touches a database or the network.
const mockStore = { rows: [], calls: [] };

jest.mock('../../src/db/prisma', () => ({
  prisma: {
    // requireAuth looks the patient up once (a retired account is refused at once); these tests have no such account row.
    user: { findUnique: jest.fn(async () => null) },
    notification: {
      findMany: jest.fn(async (args) => { mockStore.calls.push(['findMany', args]); return []; }),
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
      updateMany: jest.fn(async (args) => {
        mockStore.calls.push(['updateMany', args]);
        const w = args.where;
        const hit = mockStore.rows.filter((r) => r.id === w.id && r.recipientType === w.recipientType && r.recipientId === w.recipientId && (w.deletedAt === null ? r.deletedAt == null : true));
        hit.forEach((r) => Object.assign(r, args.data));
        return { count: hit.length };
      }),
      delete: jest.fn(async () => { throw new Error('hard delete must not be used'); }),
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
const PATIENT_1 = token({ sub: 1, role: 'patient' });
const PATIENT_2 = token({ sub: 2, role: 'patient' });
const CORPORATE = token({ sub: 1, role: 'corporate', corporateId: 1 });
const ADMIN = token({ sub: 1, role: 'admin' });

// The same error contract as src/app.js: err.statusCode and err.message.
const app = express();
app.use(express.json());
app.use('/notifications', notificationsRouter);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Internal server error' }));

let savedSecret;
beforeAll(() => { savedSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = SECRET; });
afterAll(() => { if (savedSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = savedSecret; });

const note = (over = {}) => ({ id: 1, recipientType: 'patient', recipientId: 1, deletedAt: null, idempotencyKey: 'k:patient:1:e1', ...over });
const del = (id, tok) => { const r = request(app).delete(`/notifications/${id}`); return tok ? r.set('Authorization', `Bearer ${tok}`) : r; };

beforeEach(() => { mockStore.rows = []; mockStore.calls = []; jest.clearAllMocks(); });

describe('DELETE /notifications/:id', () => {
  test('the authenticated patient soft-deletes their own notification: 204, empty body, row and key kept', async () => {
    mockStore.rows = [note()];
    const res = await del(1, PATIENT_1);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(mockStore.rows).toHaveLength(1);
    expect(mockStore.rows[0].deletedAt).toBeInstanceOf(Date);
    expect(mockStore.rows[0].idempotencyKey).toBe('k:patient:1:e1');
    expect(prisma.notification.delete).not.toHaveBeenCalled();
    expect(mockStore.calls[0][1].where).toEqual({ id: 1, recipientType: 'patient', recipientId: 1, deletedAt: null });
  });

  test('the patient id comes from the token, never from the URL or body', async () => {
    mockStore.rows = [note({ recipientId: 2 })];
    const res = await request(app).delete('/notifications/1?recipientId=2').set('Authorization', `Bearer ${PATIENT_1}`).send({ recipientId: 2 });
    expect(res.status).toBe(404);
    expect(mockStore.rows[0].deletedAt).toBeNull();
  });

  test('a foreign notification is 404 and untouched', async () => {
    mockStore.rows = [note({ recipientId: 2 })];
    const res = await del(1, PATIENT_1);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Notification not found' });
    expect(mockStore.rows[0].deletedAt).toBeNull();
  });

  test('an unknown or malformed id is 404', async () => {
    mockStore.rows = [note()];
    for (const id of [99, 'abc', 0, -1, '1.5']) {
      const res = await del(id, PATIENT_1);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Notification not found' });
    }
    expect(mockStore.rows[0].deletedAt).toBeNull();
  });

  test('deleting twice: 204 then 404, and the first deletedAt is kept', async () => {
    mockStore.rows = [note()];
    expect((await del(1, PATIENT_1)).status).toBe(204);
    const first = mockStore.rows[0].deletedAt;
    const again = await del(1, PATIENT_1);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: 'Notification not found' });
    expect(mockStore.rows[0].deletedAt).toBe(first);
  });

  test('another patient cannot delete it; the owner still can afterwards', async () => {
    mockStore.rows = [note()];
    expect((await del(1, PATIENT_2)).status).toBe(404);
    expect(mockStore.rows[0].deletedAt).toBeNull();
    expect((await del(1, PATIENT_1)).status).toBe(204);
  });

  test('authentication is required: missing token 401, corporate and admin tokens refused', async () => {
    mockStore.rows = [note(), note({ id: 2, recipientType: 'corporate_user' })];
    expect((await del(1)).status).toBe(401);
    expect((await del(1, 'not-a-token')).status).toBe(401);
    expect((await del(1, CORPORATE)).status).toBe(403); // patient-only: a corporate user's delete is /corporate/notifications/:id
    expect((await del(2, CORPORATE)).status).toBe(403);
    expect((await del(1, ADMIN)).status).toBe(401);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(mockStore.rows.every((r) => r.deletedAt === null)).toBe(true);
  });
});

describe('the other notification routes are unchanged', () => {
  test('GET / and the read routes still accept a corporate token (the shared mobile/portal contract)', async () => {
    const list = await request(app).get('/notifications').set('Authorization', `Bearer ${CORPORATE}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ notifications: [] });
    // a corporate user takes the original query: no deletedAt, no select
    expect(mockStore.calls[0][1].where).toEqual({ recipientType: 'corporate_user', recipientId: 1 });
    expect(mockStore.calls[0][1].select).toBeUndefined();
  });

  test('the route table has exactly the three original routes plus the patient DELETE and the two preference routes', () => {
    const routes = notificationsRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort();
    // The two device routes are the Phase 1.6 device registry (see notification-devices.test.js).
    expect(routes).toEqual(['DELETE /:id', 'DELETE /devices/:deviceId', 'GET /', 'GET /preferences', 'PATCH /preferences', 'POST /:id/read', 'POST /devices', 'POST /read-all']);
  });
});
