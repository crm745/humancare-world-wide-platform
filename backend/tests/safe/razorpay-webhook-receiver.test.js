/* global describe, test, expect, jest, beforeAll, beforeEach, afterAll */
// The Razorpay webhook RECEIVER: POST /integrations/razorpay/webhook through the REAL application (src/app.js), over HTTP with supertest. Only the
// outside world is replaced: Prisma is a mock (no MySQL), uploads and the antivirus client are stubs, and nothing ever calls Razorpay or Bitrix.
// Every signature is computed locally with Node's crypto; every secret, id and person below is fake. Every console line is captured and checked.
jest.mock('../../src/db/prisma', () => ({
  prisma: { integrationInbox: { create: jest.fn(), findMany: jest.fn() } },
}));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const crypto = require('crypto');
const zlib = require('zlib');
const request = require('supertest');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');

const SECRET = 'whsec_FAKE_WEBHOOK_SECRET_0123';
const PATH = '/integrations/razorpay/webhook';
const EVENT_ID = 'evt_FAKE_00000001';
const CREATED_AT = 1766000000; // 2025-12-17T19:33:20Z
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');

// Fake personal and payment-method data that must NEVER be stored.
const PII = { email: 'asha.rao@example.com', contact: '+971501234567', vpa: 'asha@fakebank', card_id: 'card_FAKE123', error_description: 'ERRDESC_Your_card_ending_4242_was_declined', error_code: 'BAD_REQUEST_ERROR', bank: 'FAKEBANK', wallet: 'fakewallet' };
const NOTES = { customer: 'Asha Rao', phone: '+971501234567', hc_payment_id: '1', hc_invoice_id: '1', hc_environment: 'test' };
const SENTINELS = ['asha.rao@example.com', '971501234567', 'asha@fakebank', 'card_FAKE123', 'ERRDESC_', 'Asha Rao', 'FAKEBANK', 'fakewallet', 'BAD_REQUEST_ERROR', 'account_FAKE9', 'acq_FAKE'];

const paymentEntity = (over = {}) => ({ id: 'pay_FAKE1', entity: 'payment', amount: 150000, currency: 'INR', status: 'captured', order_id: 'order_FAKE1', method: 'upi', ...PII, notes: NOTES, acquirer_data: { rrn: 'acq_FAKE' }, ...over });
const envelope = (event, payload, over = {}) => ({ entity: 'event', account_id: 'account_FAKE9', event, contains: ['x'], payload, created_at: CREATED_AT, ...over });
const events = {
  'payment.captured': () => envelope('payment.captured', { payment: { entity: paymentEntity() } }),
  'payment.failed': () => envelope('payment.failed', { payment: { entity: paymentEntity({ status: 'failed' }) } }),
  'refund.processed': () => envelope('refund.processed', { refund: { entity: { id: 'rfnd_FAKE1', entity: 'refund', payment_id: 'pay_FAKE1', amount: 50000, currency: 'INR', status: 'processed', ...PII, notes: NOTES } }, payment: { entity: paymentEntity() } }),
  'refund.failed': () => envelope('refund.failed', { refund: { entity: { id: 'rfnd_FAKE1', entity: 'refund', payment_id: 'pay_FAKE1', amount: 50000, currency: 'INR', status: 'failed', ...PII } } }),
  'order.paid': () => envelope('order.paid', { order: { entity: { id: 'order_FAKE1', entity: 'order', amount: 150000, amount_paid: 150000, amount_due: 0, currency: 'INR', status: 'paid', receipt: 'HCP1', notes: NOTES } }, payment: { entity: paymentEntity() } }),
};
const bytesOf = (object, space) => Buffer.from(JSON.stringify(object, null, space));

// One webhook delivery. `body` is the exact raw Buffer; the signature is computed over it unless one is given.
const deliver = ({ body, signature, eventId = EVENT_ID, type = 'application/json', headers = {} } = {}) => {
  // The identity serializer matters: with a JSON content type superagent would otherwise JSON-stringify a Buffer, and the app would not receive the signed bytes.
  let req = request(app).post(PATH).serialize((data) => data);
  if (type !== null) req = req.set('Content-Type', type);
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) req = req.set('X-Razorpay-Signature', sig);
  if (eventId !== null) req = req.set('X-Razorpay-Event-Id', eventId);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

let captured; let spies; let savedEnv;
beforeAll(() => {
  savedEnv = { s: process.env.RAZORPAY_WEBHOOK_SECRET, e: process.env.PAYMENTS_ENVIRONMENT_ID };
  captured = [];
  spies = ['log', 'info', 'warn', 'error'].map((name) => jest.spyOn(console, name).mockImplementation((...args) => { captured.push(args.map(String).join(' ')); }));
});
afterAll(() => {
  for (const [key, value] of [['RAZORPAY_WEBHOOK_SECRET', savedEnv.s], ['PAYMENTS_ENVIRONMENT_ID', savedEnv.e]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  spies.forEach((s) => s.mockRestore());
});
beforeEach(() => {
  captured.length = 0;
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  process.env.PAYMENTS_ENVIRONMENT_ID = 'test';
  prisma.integrationInbox.create.mockReset().mockResolvedValue({});
  prisma.integrationInbox.findMany.mockReset().mockResolvedValue([]);
});

const stored = () => prisma.integrationInbox.create.mock.calls.map(([arg]) => arg.data);
const everythingSeen = (res) => JSON.stringify([res.body, res.text, res.headers]) + captured.join('\n');
const nothingStored = () => { expect(prisma.integrationInbox.create).not.toHaveBeenCalled(); };
const FIXED = {
  ok: { ok: true },
  invalidBody: { ok: false, code: 'invalid_body' },
  invalidSignature: { ok: false, code: 'invalid_signature' },
  tooLarge: { ok: false, code: 'body_too_large' },
  notConfigured: { ok: false, code: 'webhook_not_configured' },
  internal: { ok: false, code: 'internal_error' },
};

describe('exact raw-body signature verification through the real Express app', () => {
  test('a correctly signed event is accepted and stored', async () => {
    const res = await deliver({ body: bytesOf(events['payment.captured']()) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FIXED.ok);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(stored()).toHaveLength(1);
  });

  test('the signature is checked over the EXACT bytes: pretty-printed, CRLF, trailing newline, odd spacing and unicode escapes all verify as sent', async () => {
    const event = events['payment.captured']();
    for (const body of [
      bytesOf(event, 4), Buffer.from(`${JSON.stringify(event)}\n`), Buffer.from(JSON.stringify(event, null, 2).replace(/\n/g, '\r\n')),
      Buffer.from(JSON.stringify(event).replace(/:/g, ' : ').replace(/,/g, ' ,\t')), Buffer.from(JSON.stringify(event).replace('payment.captured', 'payment\\u002ecaptured')),
    ]) {
      prisma.integrationInbox.create.mockClear();
      const res = await deliver({ body, eventId: `evt_FAKE_${sha(body).slice(0, 12)}` });
      expect(res.status).toBe(200);
      expect(stored()).toHaveLength(1);
    }
  });

  test('re-serialized JSON is NOT what was signed: the same event with different bytes is refused with the original signature', async () => {
    const sent = Buffer.from(`${JSON.stringify(events['payment.captured'](), null, 3)}\n`);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(sent.toString())));
    const res = await deliver({ body: reserialized, signature: sign(sent) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(FIXED.invalidSignature);
    nothingStored();
  });

  test('any content type is accepted (the body is read raw), and a compressed body is refused (it is not what Razorpay signed)', async () => {
    const body = bytesOf(events['payment.captured']());
    for (const type of ['application/json', 'text/plain', 'application/octet-stream', 'application/x-www-form-urlencoded', null]) {
      prisma.integrationInbox.create.mockClear();
      expect((await deliver({ body, type, eventId: `evt_FAKE_${String(type).length}_${Math.random().toString(36).slice(2, 10)}` })).status).toBe(200);
    }
    prisma.integrationInbox.create.mockClear();
    const compressed = zlib.gzipSync(body);
    const res = await deliver({ body: compressed, signature: sign(compressed), headers: { 'Content-Encoding': 'gzip' } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(FIXED.invalidBody);
    nothingStored();
  });
});

describe('the webhook is mounted BEFORE the global express.json()', () => {
  test('a signed body that is not valid JSON is answered by the webhook\'s own fixed 400 (the global JSON parser never saw it)', async () => {
    const body = Buffer.from('{"event": "payment.captured", ');
    const res = await deliver({ body });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(FIXED.invalidBody); // the global handler would have answered with its own "error" message instead
    expect(res.body.error).toBeUndefined();
  });

  test('a signed body above the GLOBAL 100 KB limit is accepted by the webhook (its own limit is 256 KB)', async () => {
    const pad = 'a'.repeat(150 * 1024);
    const body = Buffer.from(JSON.stringify({ event: 'something.unsupported', pad }));
    expect(body.length).toBeGreaterThan(100 * 1024);
    const res = await deliver({ body });
    expect(res.status).toBe(200);
    expect(stored()[0]).toMatchObject({ status: 'ignored', lastError: 'unsupported_event' });
  });

  test('bytes the JSON parser would have normalized (duplicate keys) reach the signature check unchanged', async () => {
    const body = Buffer.from('{"event":"payment.captured","event":"payment.failed","payload":{"payment":{"entity":{"id":"pay_FAKE1","order_id":"order_FAKE1","amount":1,"currency":"INR","status":"failed"}}}}');
    const res = await deliver({ body });
    expect(res.status).toBe(200);
    expect(stored()[0].eventType).toBe('payment.failed'); // JSON.parse keeps the last duplicate; the signature was over these exact bytes
  });

  test('the router really sits before the JSON parser in the application stack', () => {
    const names = app.router.stack.map((layer) => layer.name);
    const jsonIndex = names.indexOf('jsonParser');
    const webhookIndex = app.router.stack.findIndex((layer) => layer.matchers && layer.matchers.some((m) => { const r = m('/integrations/razorpay/webhook'); return r && r.path; }) && layer.name === 'router');
    expect(jsonIndex).toBeGreaterThan(-1);
    expect(webhookIndex).toBeGreaterThan(-1);
    expect(webhookIndex).toBeLessThan(jsonIndex);
  });
});

describe('existing routes are unaffected', () => {
  test('the global JSON parser still runs for other routes: malformed JSON to an invoice route is refused by it (400, before authentication)', async () => {
    const res = await request(app).post('/invoices/1/payment-orders').set('Content-Type', 'application/json').send('{"mode": ');
    expect(res.status).toBe(400);
    expect(res.body).not.toEqual(FIXED.invalidBody);
  });

  test('valid JSON still reaches an invoice route, which asks for authentication', async () => {
    const res = await request(app).post('/invoices/1/payment-orders').send({ mode: 'full' });
    expect(res.status).toBe(401);
  });

  test('the Bitrix inbound route still answers as before: its own fixed 401 for a wrong token, and nothing is stored', async () => {
    const res = await request(app).post('/integrations/bitrix/deal-stage').type('form').send({ event: 'ONCRMDEALUPDATE', 'data[FIELDS][ID]': '4711', 'auth[application_token]': 'wrong-token-0000000000' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
    nothingStored();
  });

  test('other paths and methods are not the webhook: GET on the webhook path and a look-alike path are 404', async () => {
    expect((await request(app).get(PATH)).status).toBe(404);
    expect((await request(app).put(PATH).send('x')).status).toBe(404);
    expect((await request(app).post('/integrations/razorpayX/webhook').send({})).status).toBe(404);
    expect((await request(app).post('/integrations/razorpay/other').send({})).status).toBe(404);
  });

  test('the health route is unchanged', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });
});

describe('valid and invalid signatures', () => {
  const body = () => bytesOf(events['payment.captured']());

  test.each([
    ['a signature made with another secret', (b) => sign(b, 'whsec_ANOTHER_FAKE_SECRET_4567')],
    ['an arbitrary well-formed signature', () => 'a'.repeat(64)],
    ['a signature of another body', () => sign(Buffer.from('{"event":"payment.failed"}'))],
    ['a truncated signature', (b) => sign(b).slice(0, 63)],
    ['a too long signature', (b) => `${sign(b)}0`],
    ['non-hex characters', (b) => `${sign(b).slice(0, 63)}z`],
    ['an empty signature', () => ''],
    ['a plain SHA-256 of the body (no secret)', (b) => sha(b)],
  ])('%s: 401 with the fixed body, nothing stored, nothing looked up', async (_label, makeSignature) => {
    const b = body();
    const res = await deliver({ body: b, signature: makeSignature(b) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(FIXED.invalidSignature);
    nothingStored();
    expect(prisma.integrationInbox.findMany).not.toHaveBeenCalled();
  });

  test('a missing signature header: 401', async () => {
    const res = await deliver({ body: body(), signature: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(FIXED.invalidSignature);
    nothingStored();
  });

  test('every signature failure gives the SAME answer (no oracle for guessing)', async () => {
    const b = body();
    const answers = [];
    for (const signature of [null, '', 'bad', 'a'.repeat(64), sign(b).slice(1), sign(b, 'whsec_OTHER_FAKE_SECRET_99')]) answers.push(JSON.stringify((await deliver({ body: b, signature })).body));
    expect(new Set(answers).size).toBe(1);
  });

  test('the event id header is NOT authentication: a perfect event id with a bad signature is refused', async () => {
    const res = await deliver({ body: body(), signature: 'a'.repeat(64), eventId: 'evt_FAKE_PERFECT_ID_1' });
    expect(res.status).toBe(401);
    nothingStored();
  });

  test('the signature is verified BEFORE the JSON is parsed: an unsigned malformed body is a 401, not a 400', async () => {
    const res = await deliver({ body: Buffer.from('{not json'), signature: 'a'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('configuration problems fail closed with 503', () => {
  test.each([
    ['no webhook secret', () => { delete process.env.RAZORPAY_WEBHOOK_SECRET; }],
    ['an empty webhook secret', () => { process.env.RAZORPAY_WEBHOOK_SECRET = ''; }],
    ['a short webhook secret', () => { process.env.RAZORPAY_WEBHOOK_SECRET = 'short'; }],
    ['a padded webhook secret', () => { process.env.RAZORPAY_WEBHOOK_SECRET = ` ${SECRET}`; }],
    ['no environment id', () => { delete process.env.PAYMENTS_ENVIRONMENT_ID; }],
    ['an invalid environment id', () => { process.env.PAYMENTS_ENVIRONMENT_ID = 'Not Valid'; }],
  ])('%s: even a correctly signed event is refused with the fixed 503, and nothing is stored', async (_label, breakIt) => {
    const body = bytesOf(events['payment.captured']());
    const signature = sign(body);
    breakIt();
    const res = await deliver({ body, signature });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(FIXED.notConfigured);
    nothingStored();
    expect(prisma.integrationInbox.findMany).not.toHaveBeenCalled();
    expect(everythingSeen(res)).not.toContain(SECRET);
  });

  test('the configuration is read on every request: fixing it is picked up at once', async () => {
    const body = bytesOf(events['payment.captured']());
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect((await deliver({ body, signature: sign(body) })).status).toBe(503);
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    expect((await deliver({ body })).status).toBe(200);
  });
});

describe('invalid or missing bodies: 400', () => {
  const rejected = async (body, over = {}) => {
    const res = await deliver({ body, ...over });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(FIXED.invalidBody);
    nothingStored();
  };

  test('no body at all', async () => {
    const res = await deliver({ body: undefined, signature: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(FIXED.invalidBody);
    nothingStored();
  });
  test('an empty body, even with a "valid" signature of nothing', () => rejected(Buffer.alloc(0), { signature: sign(Buffer.alloc(0)) }));
  test.each([
    ['malformed JSON', '{"event":"payment.captured",'],
    ['plain text', 'hello world'],
    ['a truncated object', '{"event":"payment.captured","payload":{'],
    ['single quotes', "{'event':'payment.captured'}"],
    ['a trailing comma', '{"event":"payment.captured",}'],
  ])('signed %s', (_label, text) => rejected(Buffer.from(text)));
  test.each([['an array', '[]'], ['a string', '"payment.captured"'], ['a number', '42'], ['null', 'null'], ['true', 'true']])('signed JSON that is %s, not an event', (_label, text) => rejected(Buffer.from(text)));
  test('signed bytes that are not valid UTF-8 (a replacement character would silently change the content)', () => rejected(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
  test.each([
    ['no event name', { payload: {} }],
    ['an empty event name', { event: '' }],
    ['a numeric event name', { event: 123 }],
    ['an event name with upper case', { event: 'Payment.Captured' }],
    ['an event name with a space', { event: 'payment captured' }],
    ['an event name with punctuation', { event: 'a;drop table' }],
    ['an over-long event name', { event: `a${'b'.repeat(70)}` }],
    ['an object as the event name', { event: { name: 'x' } }],
  ])('signed envelope with %s', (_label, object) => rejected(Buffer.from(JSON.stringify(object))));
});

describe('the body size limit (256 KB)', () => {
  const sized = (length) => { const head = '{"event":"x.y","pad":"'; const tail = '"}'; return Buffer.from(head + 'a'.repeat(length - head.length - tail.length) + tail); };

  test('exactly 256 KB (262144 bytes) is accepted', async () => {
    const body = sized(262144);
    expect(body.length).toBe(262144);
    const res = await deliver({ body });
    expect(res.status).toBe(200);
  });
  test('one byte more is refused with 413 and the fixed body, even with a valid signature, and nothing is stored', async () => {
    const body = sized(262145);
    expect(body.length).toBe(262145);
    const res = await deliver({ body });
    expect(res.status).toBe(413);
    expect(res.body).toEqual(FIXED.tooLarge);
    nothingStored();
  });
  test('a much larger body is refused the same way, before any signature work', async () => {
    const body = Buffer.alloc(1024 * 1024, 'a');
    const res = await deliver({ body, signature: 'not-even-a-signature' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual(FIXED.tooLarge);
    nothingStored();
  });
});

describe('event identity and deduplication', () => {
  const event = () => bytesOf(events['payment.captured']());

  test('the X-Razorpay-Event-Id header is the external event id', async () => {
    await deliver({ body: event(), eventId: 'evt_FAKE_HEADER_ID_1' });
    expect(stored()[0]).toMatchObject({ source: 'razorpay', externalEventId: 'evt_FAKE_HEADER_ID_1' });
    expect(stored()[0].payload.eventIdSource).toBe('header');
  });

  test('without the header, a deterministic SHA-256 of the signed raw body is used', async () => {
    const body = event();
    const res = await deliver({ body, eventId: null });
    expect(res.status).toBe(200);
    expect(stored()[0].externalEventId).toBe(`sha256:${sha(body)}`);
    expect(stored()[0].payload.eventIdSource).toBe('body_hash');
    prisma.integrationInbox.create.mockClear();
    await deliver({ body, eventId: null });
    expect(stored()[0].externalEventId).toBe(`sha256:${sha(body)}`); // the same bytes, the same identity
  });

  test.each([
    ['too short', 'abc'], ['with a space', 'evt FAKE ID 12345'], ['with a slash', 'evt/FAKE/ID/12345'], ['over-long', 'e'.repeat(200)], ['with a quote', "evt'FAKE'ID'12345"], ['with a semicolon', 'evt;FAKE;ID;12345'],
  ])('a malformed event id header (%s) is not trusted: the body fingerprint is used instead', async (_label, header) => {
    const body = event();
    const res = await deliver({ body, eventId: header });
    expect(res.status).toBe(200);
    expect(stored()[0].externalEventId).toBe(`sha256:${sha(body)}`);
    expect(JSON.stringify(stored())).not.toContain(header.length > 20 ? header : 'zzzz-never');
  });

  test('the body fingerprint is stored with the event (a fingerprint, never the body)', async () => {
    const body = event();
    await deliver({ body });
    expect(stored()[0].payload.bodySha256).toBe(sha(body));
    expect(JSON.stringify(stored())).not.toContain(body.toString('utf8').slice(0, 60));
  });

  test('a duplicate delivery (the unique key, Prisma P2002) is 200 and inserts nothing more', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const res = await deliver({ body: event() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FIXED.ok);
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(1);
    expect(everythingSeen(res)).not.toMatch(/Unique constraint|P2002/);
  });

  test('the same event delivered twice: both are acknowledged, one row exists', async () => {
    const rows = new Set();
    prisma.integrationInbox.create.mockImplementation(async ({ data }) => { if (rows.has(data.externalEventId)) throw Object.assign(new Error('dup'), { code: 'P2002' }); rows.add(data.externalEventId); return {}; });
    const body = event();
    expect((await deliver({ body })).status).toBe(200);
    expect((await deliver({ body })).status).toBe(200);
    expect(rows.size).toBe(1);
  });

  test('a signed body replayed under a DIFFERENT event id header is recognised by its fingerprint and not stored again', async () => {
    const body = event();
    prisma.integrationInbox.findMany.mockResolvedValue([{ payload: { bodySha256: sha(body) } }]);
    const res = await deliver({ body, eventId: 'evt_FAKE_REPLAY_ID_999' });
    expect(res.status).toBe(200);
    nothingStored();
    expect(prisma.integrationInbox.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { source: 'razorpay', entityType: 'order', entityId: 'order_FAKE1' } }));
  });

  test('a different event for the same order is NOT a duplicate', async () => {
    prisma.integrationInbox.findMany.mockResolvedValue([{ payload: { bodySha256: sha(Buffer.from('some other body')) } }, { payload: null }, null]);
    const res = await deliver({ body: event(), eventId: 'evt_FAKE_ANOTHER_ID_1' });
    expect(res.status).toBe(200);
    expect(stored()).toHaveLength(1);
  });

  test('unknown events (no entity) are not looked up; they rely on the event id alone', async () => {
    await deliver({ body: Buffer.from(JSON.stringify({ event: 'subscription.charged' })) });
    expect(prisma.integrationInbox.findMany).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(1);
  });
});

describe('the five supported events are stored as "received" with an allow-listed payload', () => {
  const expectedPayload = {
    'payment.captured': { payment: { id: 'pay_FAKE1', orderId: 'order_FAKE1', amount: 150000, currency: 'INR', status: 'captured' } },
    'payment.failed': { payment: { id: 'pay_FAKE1', orderId: 'order_FAKE1', amount: 150000, currency: 'INR', status: 'failed' } },
    'refund.processed': { refund: { id: 'rfnd_FAKE1', paymentId: 'pay_FAKE1', amount: 50000, currency: 'INR', status: 'processed' } },
    'refund.failed': { refund: { id: 'rfnd_FAKE1', paymentId: 'pay_FAKE1', amount: 50000, currency: 'INR', status: 'failed' } },
    'order.paid': { order: { id: 'order_FAKE1', amountPaid: 150000 } },
  };
  const expectedEntity = { 'payment.captured': ['order', 'order_FAKE1'], 'payment.failed': ['order', 'order_FAKE1'], 'refund.processed': ['refund', 'rfnd_FAKE1'], 'refund.failed': ['refund', 'rfnd_FAKE1'], 'order.paid': ['order', 'order_FAKE1'] };

  test.each(Object.keys(events))('%s', async (name) => {
    const body = bytesOf(events[name]());
    const res = await deliver({ body });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FIXED.ok);
    expect(stored()).toHaveLength(1);
    const row = stored()[0];
    expect(row).toMatchObject({
      source: 'razorpay', externalEventId: EVENT_ID, eventType: name, entityType: expectedEntity[name][0], entityId: expectedEntity[name][1],
      status: 'received', lastError: null,
    });
    expect(row.externalOccurredAt).toEqual(new Date(CREATED_AT * 1000));
    expect(row.nextAttemptAt).toEqual(new Date(0)); // due at once
    expect(row.processedAt).toBeUndefined(); // a received event is not processed yet
    expect(row.payload).toEqual({ event: name, occurredAt: new Date(CREATED_AT * 1000).toISOString(), bodySha256: sha(body), eventIdSource: 'header', ...expectedPayload[name] });
  });

  test('the payment events keep only id, order id, amount, currency and status (no method)', async () => {
    await deliver({ body: bytesOf(events['payment.captured']()) });
    expect(Object.keys(stored()[0].payload.payment).sort()).toEqual(['amount', 'currency', 'id', 'orderId', 'status']);
  });

  test('the occurrence time is the event\'s own validated created_at, or null when it is missing or not credible', async () => {
    const cases = [[CREATED_AT, new Date(CREATED_AT * 1000)], [undefined, null], ['1766000000', null], [-5, null], [12.5, null], [99, null], [5_000_000_000, null], [null, null]];
    for (const [value, expected] of cases) {
      prisma.integrationInbox.create.mockClear();
      const event = events['payment.captured']();
      if (value === undefined) delete event.created_at; else event.created_at = value;
      await deliver({ body: bytesOf(event), eventId: `evt_FAKE_T_${String(value).length}_${Math.random().toString(36).slice(2, 8)}` });
      expect(stored()[0].externalOccurredAt).toEqual(expected);
      expect(stored()[0].payload.occurredAt).toBe(expected ? expected.toISOString() : null);
    }
  });
});

describe('unknown events are stored as "ignored" and acknowledged', () => {
  test.each(['payment.authorized', 'subscription.charged', 'payment.dispute.created', 'invoice.paid', 'settlement.processed', 'order.something_new'])('%s', async (name) => {
    const res = await deliver({ body: bytesOf(envelope(name, { payment: { entity: paymentEntity() } })) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FIXED.ok);
    const row = stored()[0];
    expect(row).toMatchObject({ source: 'razorpay', eventType: name, status: 'ignored', lastError: 'unsupported_event', entityType: null, entityId: null });
    expect(row.processedAt).toBeInstanceOf(Date); // final: nothing for the worker to do
    expect(Object.keys(row.payload).sort()).toEqual(['bodySha256', 'event', 'eventIdSource', 'occurredAt']); // the name and fingerprint only, none of the content
  });

  test('a supported event whose required fields are unusable is stored as "ignored: invalid_payload" (200, so it is not retried forever)', async () => {
    const bad = {
      'a payment without an entity': envelope('payment.captured', { payment: {} }),
      'no payload': envelope('payment.captured', undefined),
      'an order id with the wrong prefix': envelope('payment.captured', { payment: { entity: paymentEntity({ order_id: 'ord_FAKE1' }) } }),
      'no order id': envelope('payment.captured', { payment: { entity: paymentEntity({ order_id: null }) } }),
      'a payment id with the wrong prefix': envelope('payment.captured', { payment: { entity: paymentEntity({ id: 'order_FAKE1' }) } }),
      'a fractional amount': envelope('payment.captured', { payment: { entity: paymentEntity({ amount: 1500.5 }) } }),
      'a zero amount': envelope('payment.captured', { payment: { entity: paymentEntity({ amount: 0 }) } }),
      'a negative amount': envelope('payment.captured', { payment: { entity: paymentEntity({ amount: -5 }) } }),
      'a text amount': envelope('payment.captured', { payment: { entity: paymentEntity({ amount: '150000' }) } }),
      'an unsafe integer amount': envelope('payment.captured', { payment: { entity: paymentEntity({ amount: 2 ** 60 }) } }),
      'a lower-case currency': envelope('payment.captured', { payment: { entity: paymentEntity({ currency: 'inr' }) } }),
      'an upper-case status': envelope('payment.captured', { payment: { entity: paymentEntity({ status: 'CAPTURED' }) } }),
      'a refund with the wrong id prefix': envelope('refund.processed', { refund: { entity: { id: 'pay_FAKE1', payment_id: 'pay_FAKE1', amount: 1, currency: 'INR', status: 'processed' } } }),
      'a refund without its payment id': envelope('refund.processed', { refund: { entity: { id: 'rfnd_FAKE1', amount: 1, currency: 'INR', status: 'processed' } } }),
      'an order.paid with a negative amount paid': envelope('order.paid', { order: { entity: { id: 'order_FAKE1', amount_paid: -1 } } }),
      'an order.paid with a fractional amount paid': envelope('order.paid', { order: { entity: { id: 'order_FAKE1', amount_paid: 1.5 } } }),
      'an order.paid without an order': envelope('order.paid', { payment: { entity: paymentEntity() } }),
    };
    for (const [label, object] of Object.entries(bad)) {
      prisma.integrationInbox.create.mockClear();
      const res = await deliver({ body: bytesOf(object), eventId: `evt_FAKE_BAD_${label.length}_${Math.random().toString(36).slice(2, 8)}` });
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      expect({ label, stored: stored().length }).toEqual({ label, stored: 1 });
      expect({ label, status: stored()[0].status, error: stored()[0].lastError }).toEqual({ label, status: 'ignored', error: 'invalid_payload' });
      expect(stored()[0].entityType).toBeNull();
      expect(Object.keys(stored()[0].payload).sort()).toEqual(['bodySha256', 'event', 'eventIdSource', 'occurredAt']);
    }
  });
});

describe('database failure and retry', () => {
  const body = () => bytesOf(events['payment.captured']());

  test('a storage failure is a fixed 500 (so Razorpay retries) with a code-only log and no database text in the answer', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED mysql://user:pa55word@dbhost/humancare SENTINEL_DB_DETAIL'), { name: 'PrismaClientInitializationError' }));
    const res = await deliver({ body: body() });
    expect(res.status).toBe(500);
    expect(res.body).toEqual(FIXED.internal);
    expect(everythingSeen(res)).not.toMatch(/ECONNREFUSED|pa55word|dbhost|SENTINEL_DB_DETAIL|mysql:/);
    expect(captured.some((line) => /could not store an event: PrismaClientInitializationError/.test(line))).toBe(true);
  });

  test('after the failure the retry is stored: Razorpay\'s redelivery of the same event succeeds', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({});
    const b = body();
    expect((await deliver({ body: b })).status).toBe(500);
    expect((await deliver({ body: b })).status).toBe(200);
    expect(prisma.integrationInbox.create).toHaveBeenCalledTimes(2);
  });

  test('a failure while checking for a duplicate is a 500 as well, and nothing is stored', async () => {
    prisma.integrationInbox.findMany.mockRejectedValueOnce(new Error('lookup failed SENTINEL_DB_DETAIL'));
    const res = await deliver({ body: body() });
    expect(res.status).toBe(500);
    expect(res.body).toEqual(FIXED.internal);
    nothingStored();
    expect(everythingSeen(res)).not.toContain('SENTINEL_DB_DETAIL');
  });

  test('a failure storing an UNKNOWN event is a 500 too (it must not be silently lost)', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(new Error('transient'));
    expect((await deliver({ body: Buffer.from(JSON.stringify({ event: 'subscription.charged' })) })).status).toBe(500);
  });

  test('a unique-key violation is NOT a failure (200), unlike every other database error', async () => {
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'P2002' }));
    expect((await deliver({ body: body() })).status).toBe(200);
    prisma.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'P2003' }));
    expect((await deliver({ body: body(), eventId: 'evt_FAKE_OTHER_ID_77' })).status).toBe(500);
  });
});

describe('the payload allow-list and PII exclusion', () => {
  test.each(Object.keys(events))('%s: nothing personal, nothing about the payment method, no error text and no notes is stored', async (name) => {
    const body = bytesOf(events[name]());
    const signature = sign(body);
    await deliver({ body, signature });
    const everything = JSON.stringify(prisma.integrationInbox.create.mock.calls);
    for (const sentinel of SENTINELS) expect({ sentinel, found: everything.includes(sentinel) }).toEqual({ sentinel, found: false });
    expect(everything).not.toContain(signature); // the signature is never stored
    expect(everything).not.toContain(SECRET); // nor the secret
    expect(everything).not.toContain(body.toString('utf8').slice(0, 80)); // nor the raw body
    expect(everything).not.toMatch(/"(email|contact|vpa|card|card_id|error_description|error_code|notes|acquirer_data|method|wallet|bank|account_id|receipt)"/);
  });

  test('the stored row has exactly the expected columns and nothing else', async () => {
    await deliver({ body: bytesOf(events['payment.captured']()) });
    expect(Object.keys(stored()[0]).sort()).toEqual(['entityId', 'entityType', 'eventType', 'externalEventId', 'externalOccurredAt', 'lastError', 'nextAttemptAt', 'payload', 'source', 'status']);
  });

  test('personal data placed in an UNKNOWN event is not stored either', async () => {
    await deliver({ body: bytesOf(envelope('payment.dispute.created', { payment: { entity: paymentEntity() } }, { extra: PII })) });
    const everything = JSON.stringify(prisma.integrationInbox.create.mock.calls);
    for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
  });

  test('extra and nested fields of a valid event are never copied (a hostile or future field cannot be stored)', async () => {
    const event = events['payment.captured']();
    event.payload.payment.entity.surprise = { deep: { secret: 'SURPRISE_FIELD_VALUE' } };
    event.payload.extra = 'SURPRISE_EXTRA';
    event.surprise_top = 'SURPRISE_TOP';
    await deliver({ body: bytesOf(event) });
    expect(JSON.stringify(prisma.integrationInbox.create.mock.calls)).not.toMatch(/SURPRISE/);
  });
});

describe('secret, signature and raw-body redaction', () => {
  const body = () => bytesOf(events['payment.captured']());

  test('no answer, header or log line of ANY outcome contains the secret, the signature or the raw body', async () => {
    const b = body();
    const goodSignature = sign(b);
    const seen = [];
    const run = async (opts) => { const res = await deliver(opts); seen.push(everythingSeen(res)); return res; };

    await run({ body: b }); // 200
    await run({ body: b, signature: 'a'.repeat(64) }); // 401
    await run({ body: Buffer.from('{bad'), eventId: 'evt_FAKE_BADBODY_1' }); // 400
    await run({ body: Buffer.alloc(262145, 'a') }); // 413
    prisma.integrationInbox.create.mockRejectedValueOnce(new Error(`db down ${SECRET}`));
    await run({ body: b, eventId: 'evt_FAKE_DBDOWN_01' }); // 500
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await run({ body: b, signature: goodSignature }); // 503

    const text = seen.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(goodSignature);
    expect(text).not.toContain(b.toString('utf8').slice(0, 80));
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    expect(text).not.toMatch(/at .*\.js|mysql:\/\//);
  });

  test('every log line is a short code: "[razorpay-webhook] <what>: <code>"', async () => {
    const b = body();
    await deliver({ body: b, signature: 'a'.repeat(64) });
    await deliver({ body: Buffer.from('{bad') });
    prisma.integrationInbox.create.mockRejectedValueOnce(new Error('x'));
    await deliver({ body: b, eventId: 'evt_FAKE_LOGGED_01' });
    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) expect(line).toMatch(/^\[razorpay-webhook\] [a-z ]+: [A-Za-z0-9_.-]+$/);
  });

  test('every answer is one of the fixed bodies and is never cached', async () => {
    const b = body();
    const answers = [
      await deliver({ body: b }), await deliver({ body: b, signature: 'a'.repeat(64) }), await deliver({ body: Buffer.from('{bad') }),
      await deliver({ body: Buffer.alloc(262145, 'a') }),
    ];
    const allowed = Object.values(FIXED).map((v) => JSON.stringify(v));
    for (const res of answers) {
      expect(allowed).toContain(JSON.stringify(res.body));
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  test('no Razorpay or Bitrix request is ever made by the receiver (the network is blocked in the safe tests)', async () => {
    const saved = global.fetch;
    global.fetch = jest.fn(async () => { throw new Error('the network must not be used'); });
    try {
      for (const name of Object.keys(events)) await deliver({ body: bytesOf(events[name]()), eventId: `evt_FAKE_NET_${name.length}${name[0]}${name[name.length - 1]}` });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = saved;
    }
  });
});
