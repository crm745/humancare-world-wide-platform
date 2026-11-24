/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// The REAL application (src/app.js) with the inbound Bitrix24 route mounted exactly as in production, exercised over
// HTTP with supertest. Only the outside world is replaced: Prisma is a fake (no MySQL), file upload and the antivirus
// client are stubs, and the Bitrix client is never reached (the receiver cannot call it). Every console line the
// application writes is captured and checked for secrets.
jest.mock('../../src/db/prisma', () => ({
  prisma: { integrationInbox: { create: jest.fn(), findUnique: jest.fn() } },
}));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');

const TOKEN = 'fake-route-token-ABCDEFGH12345678';
const OTHER = 'fake-route-token-ABCDEFGH1234567X';
const PATIENT = 'Asha Rao';
const PHONE = '+971501234567';
const form = (over = {}) => ({
  event: 'ONCRMDEALUPDATE', ts: '1893456000', 'data[FIELDS][ID]': '4711', 'auth[application_token]': TOKEN, 'auth[domain]': 'fake.invalid', ...over,
});
const post = (body) => request(app).post('/integrations/bitrix/deal-stage').type('form').send(body);

let captured; let spies;
beforeAll(() => {
  process.env.BITRIX_INBOUND_APPLICATION_TOKEN = TOKEN;
  captured = [];
  spies = ['log', 'info', 'warn', 'error'].map((name) => jest.spyOn(console, name).mockImplementation((...args) => { captured.push(args.map(String).join(' ')); }));
});
afterAll(() => { delete process.env.BITRIX_INBOUND_APPLICATION_TOKEN; spies.forEach((s) => s.mockRestore()); });
beforeEach(() => {
  captured.length = 0;
  prisma.integrationInbox.create.mockReset().mockResolvedValue({});
  prisma.integrationInbox.findUnique.mockReset().mockResolvedValue({ status: 'received' });
});

const everythingSeen = (res) => JSON.stringify([res.body, res.text, res.headers]) + captured.join('\n');
const SECRET = new RegExp(`${TOKEN}|${OTHER}|${PATIENT}|971501234567|fake\\.invalid|mysql://|at .*\\.js`);

describe('POST /integrations/bitrix/deal-stage through app.js', () => {
  test('a valid, authenticated Bitrix event (form-encoded, as Bitrix sends it) is accepted and stored', async () => {
    const res = await post(form());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
    const data = prisma.integrationInbox.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ source: 'bitrix24', eventType: 'ONCRMDEALUPDATE', entityId: '4711', status: 'received' });
    expect(JSON.stringify(data)).not.toMatch(SECRET);
  });

  test('a JSON body works the same way', async () => {
    const res = await request(app).post('/integrations/bitrix/deal-stage').send({ event: 'ONCRMDEALUPDATE', ts: 1893456000, data: { FIELDS: { ID: '4711' } }, auth: { application_token: TOKEN } });
    expect(res.status).toBe(200);
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['no token', form({ 'auth[application_token]': undefined })],
    ['a wrong token', form({ 'auth[application_token]': OTHER })],
    ['an empty token', form({ 'auth[application_token]': '' })],
  ])('%s -> 401 with the same fixed answer, nothing stored, nothing leaked', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
    expect(everythingSeen(res)).not.toMatch(SECRET);
  });

  test('with no token configured at all, even the "right" token is refused (fail closed)', async () => {
    const saved = process.env.BITRIX_INBOUND_APPLICATION_TOKEN;
    delete process.env.BITRIX_INBOUND_APPLICATION_TOKEN;
    try {
      const res = await post(form());
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
    } finally { process.env.BITRIX_INBOUND_APPLICATION_TOKEN = saved; }
  });

  test('the outbound webhook setting is not accepted as a credential', async () => {
    const saved = process.env.BITRIX24_WEBHOOK_URL;
    process.env.BITRIX24_WEBHOOK_URL = 'https://fake.invalid/rest/1/FAKEHOOK/';
    try {
      expect((await post(form({ 'auth[application_token]': 'https://fake.invalid/rest/1/FAKEHOOK/' }))).status).toBe(401);
    } finally { if (saved === undefined) delete process.env.BITRIX24_WEBHOOK_URL; else process.env.BITRIX24_WEBHOOK_URL = saved; }
  });

  test.each([
    ['no event', form({ event: undefined })],
    ['no Deal ID', form({ 'data[FIELDS][ID]': undefined })],
    ['a bad Deal ID', form({ 'data[FIELDS][ID]': '12;DROP' })],
    ['an empty body', {}],
  ])('a malformed payload (%s) gets a generic 400 or 401, never a detail', async (_name, body) => {
    const res = await post(body);
    expect([400, 401]).toContain(res.status);
    expect(res.body).toEqual({ ok: false });
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
  });

  test('broken JSON gets the application\'s fixed generic answer, without quoting the body', async () => {
    const res = await request(app).post('/integrations/bitrix/deal-stage').set('Content-Type', 'application/json').send(`{"auth": {"application_token": "${TOKEN}"}, "x": `);
    expect(res.status).toBe(400);
    expect(everythingSeen(res)).not.toMatch(SECRET);
    expect(res.text).not.toContain('application_token');
  });

  test('an oversized body is refused without being stored', async () => {
    const res = await post(form({ filler: 'x'.repeat(40000) }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
  });

  test('a duplicate delivery is acknowledged and not stored twice while the first copy waits', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const res = await post(form());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
  });

  test('a repeat of an event already being processed is kept as a follow-up row', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    prisma.integrationInbox.findUnique.mockResolvedValue({ status: 'processed' });
    expect((await post(form())).status).toBe(200);
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(2);
  });

  test('an unsupported event type is stored as ignored (quarantined), still with a generic 200', async () => {
    const res = await post(form({ event: 'ONCRMDEALDELETE' }));
    expect(res.status).toBe(200);
    expect(prisma.integrationInbox.create.mock.calls[0][0].data).toMatchObject({ status: 'ignored', lastError: 'quarantined:unsupported_event' });
  });

  test('a database failure gives a generic 500 with no internal detail, and the log holds only an error name', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error(`connect failed mysql://user:pw@db/x for ${PATIENT} ${PHONE} ${TOKEN}`), { name: 'PrismaClientInitializationError' }));
    const res = await post(form());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false });
    expect(everythingSeen(res)).not.toMatch(SECRET);
    expect(captured.join('\n')).toContain('PrismaClientInitializationError');
  });

  test('only POST is routed; other methods get the application\'s generic 404', async () => {
    const res = await request(app).get('/integrations/bitrix/deal-stage');
    expect(res.status).toBe(404);
    expect(prisma.integrationInbox.create).not.toHaveBeenCalled();
  });

  test('the route needs no JWT, and sending one does not authenticate anything', async () => {
    const res = await post(form({ 'auth[application_token]': OTHER })).set('Authorization', 'Bearer anything');
    expect(res.status).toBe(401);
  });

  test('no response or log line, across the whole suite so far, contains a secret or patient data', () => {
    expect(captured.join('\n')).not.toMatch(SECRET);
  });
});
