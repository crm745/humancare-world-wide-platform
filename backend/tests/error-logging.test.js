// The global error handler must not write patient data to the logs or send it back in a
// response when a body cannot be read, and must log every other error without the values the
// request submitted, while still leaving a useful diagnostic line. No database needed.
const util = require('util');
const request = require('supertest');
const { app } = require('../src/app');
const { logRequestError, isBodyParserError } = require('../src/common/logging/safe-error-log');

const SECRET_NAME = 'Zephyrina-Quillfeather';
const SECRET_DIAGNOSIS = 'Hodgkin-lymphoma-stage-IV';

let calls;
const logged = () => calls.map((args) => util.inspect(args, { depth: 8, maxStringLength: null })).join('\n');
const expectAbsent = (...sentinels) => sentinels.forEach((sentinel) => expect(logged()).not.toContain(sentinel));

beforeEach(() => {
  calls = [];
  for (const method of ['error', 'warn', 'info', 'log', 'debug']) {
    jest.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
  }
});
afterEach(() => jest.restoreAllMocks());

const brokenBody = `{"patientName":"${SECRET_NAME}","description":"${SECRET_DIAGNOSIS}","patientAge": }`;

describe('malformed JSON bodies: logging', () => {
  it.each(['/requests', '/auth/login', '/health'])('never logs the body or a piece of it (POST %s)', async (path) => {
    const res = await request(app).post(path).set('Content-Type', 'application/json').send(brokenBody);
    expect(res.status).toBe(400);
    expectAbsent(SECRET_NAME, SECRET_DIAGNOSIS, 'patientAge');
  });

  it('still logs a diagnostic line: what happened, where, and how big', async () => {
    await request(app).post('/requests').set('Content-Type', 'application/json').send(brokenBody);
    expect(calls).toHaveLength(1);
    const [message, details] = calls[0];
    expect(message).toMatch(/request body could not be read/);
    expect(details).toMatchObject({
      type: 'entity.parse.failed', status: 400, method: 'POST', path: '/requests', contentType: 'application/json', contentLength: Buffer.byteLength(brokenBody),
    });
  });

  it('keeps the query string out of the log', async () => {
    await request(app).post('/requests?token=SECRET-TOKEN-VALUE').set('Content-Type', 'application/json').send(brokenBody);
    expectAbsent('SECRET-TOKEN-VALUE');
  });

  it('logs nothing from a body that is valid JSON of the wrong kind', async () => {
    await request(app).post('/requests').set('Content-Type', 'application/json').send(`"${SECRET_NAME}"`);
    expectAbsent(SECRET_NAME);
  });

  it('does not log the body of a payload that is too large', async () => {
    const huge = JSON.stringify({ patientName: SECRET_NAME, description: 'x'.repeat(200 * 1024) });
    const res = await request(app).post('/requests').set('Content-Type', 'application/json').send(huge);
    expect(res.status).toBe(413);
    expectAbsent(SECRET_NAME);
    expect(calls[0][1]).toMatchObject({ type: 'entity.too.large', status: 413, path: '/requests' });
  });
});

describe('malformed JSON bodies: responses are generic', () => {
  it.each(['/requests', '/auth/login', '/health'])('POST %s answers 400 with one fixed message and no piece of the body', async (path) => {
    const res = await request(app).post(path).set('Content-Type', 'application/json').send(brokenBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON request body.' });
    for (const fragment of [SECRET_NAME, SECRET_DIAGNOSIS, 'patientAge', 'Unexpected token', 'is not valid JSON', 'JSON.parse', 'position']) {
      expect(res.text).not.toContain(fragment);
    }
  });

  it('does not echo a bare wrong-kind JSON value either', async () => {
    const res = await request(app).post('/requests').set('Content-Type', 'application/json').send(`"${SECRET_NAME}"`);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(SECRET_NAME);
  });

  it('answers a too-large body with 413 and a generic message', async () => {
    const huge = JSON.stringify({ patientName: SECRET_NAME, description: 'x'.repeat(200 * 1024) });
    const res = await request(app).post('/requests').set('Content-Type', 'application/json').send(huge);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body is too large.' });
    expect(res.text).not.toContain(SECRET_NAME);
  });

  it('keeps the messages of other 4xx errors as they were', async () => {
    const res = await request(app).get('/no/such/route');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No route for GET/);
  });
});

describe('logRequestError: any other error', () => {
  const req = {
    method: 'POST',
    path: '/requests',
    headers: { 'content-type': 'application/json' },
    body: { patientName: SECRET_NAME, patientContact: '+971501234567', description: SECRET_DIAGNOSIS, nested: { note: 'allergic to penicillin' } },
    query: { search: 'findme-sentinel' },
    params: { id: '123456789' },
  };

  it('never logs the error object itself', () => {
    const err = new Error('boom');
    logRequestError(req, err);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(err);
  });

  it('keeps useful diagnostics: classification, name, code, status, where, message and frames', () => {
    const err = Object.assign(new RangeError('connection pool exhausted'), { code: 'POOL_EXHAUSTED', statusCode: 503 });
    logRequestError(req, err);
    const [label, summary] = calls[0];
    expect(label).toBe('[request-error]');
    expect(summary).toMatchObject({
      classification: 'application', name: 'RangeError', code: 'POOL_EXHAUSTED', status: 503, method: 'POST', path: '/requests', message: 'connection pool exhausted',
    });
    expect(summary.frames.length).toBeGreaterThan(0);
    expect(summary.frames.every((frame) => frame.startsWith('at '))).toBe(true);
  });

  it('strikes every submitted value (body, nested, query, params) out of the message', () => {
    const err = new Error(`failed for ${SECRET_NAME} / +971501234567 / ${SECRET_DIAGNOSIS} / allergic to penicillin / findme-sentinel / 123456789`);
    logRequestError(req, err);
    expectAbsent(SECRET_NAME, '+971501234567', SECRET_DIAGNOSIS, 'penicillin', 'findme-sentinel', '123456789');
    expect(calls[0][1].message).toContain('[redacted]');
  });

  it('strikes a value that the message shows JSON-escaped', () => {
    const description = `pt said "no" and left\nthen "${SECRET_DIAGNOSIS}"`;
    logRequestError({ ...req, body: { description } }, new Error(`bad value ${JSON.stringify(description)}`));
    expectAbsent(SECRET_DIAGNOSIS);
  });

  it('ignores err.meta, err.cause, err.data and err.body, however they are filled', () => {
    const err = Object.assign(new Error('x'), {
      meta: { target: SECRET_NAME },
      data: { name: SECRET_NAME },
      body: SECRET_NAME,
      request: { body: SECRET_NAME },
      cause: Object.assign(new Error(SECRET_NAME), { code: 'E_CAUSE' }),
    });
    logRequestError({ ...req, body: {} }, err);
    expectAbsent(SECRET_NAME);
    expect(calls[0][1].cause).toEqual({ name: 'Error', code: 'E_CAUSE' });
  });

  it('drops a code that is not a plain token', () => {
    logRequestError(req, Object.assign(new Error('x'), { code: `bad code ${SECRET_NAME}` }));
    expectAbsent(SECRET_NAME);
    expect(calls[0][1].code).toBeUndefined();
  });

  it('takes frames from the stack, not from lines inside a multi-line message', () => {
    const err = new Error(`first line\n    at ${SECRET_NAME} (fake.js:1:1)\n    at second (fake.js:2:2)`);
    logRequestError({ ...req, body: {} }, err);
    // The message is kept (this sentinel was not submitted in the request); the frames must come
    // from the real stack only, never from the lines inside the message.
    const frames = calls[0][1].frames.join('\n');
    expect(frames).not.toContain(SECRET_NAME);
    expect(frames).not.toContain('fake.js');
    // The same lines ARE struck out when the request did submit them.
    calls.length = 0;
    logRequestError({ ...req, body: { note: SECRET_NAME } }, err);
    expectAbsent(SECRET_NAME);
  });

  it('cuts a long message at 300 characters', () => {
    logRequestError({ ...req, body: {} }, new Error('word '.repeat(500)));
    expect(calls[0][1].message.length).toBeLessThanOrEqual(300);
  });

  it('does not mistake an application error that happens to have a type field for a body error', () => {
    const err = Object.assign(new Error('boom'), { type: 'custom.failure' });
    logRequestError(req, err);
    expect(isBodyParserError(err)).toBe(false);
    expect(calls[0][1].classification).toBe('application');
  });

  it('logs only the type of a thrown value that is not an Error, and ignores an odd name', () => {
    expect(() => logRequestError(undefined, new Error('x'))).not.toThrow();
    expect(() => logRequestError(req, Object.assign(new Error('x'), { stack: 12, name: 7, code: {} }))).not.toThrow();
    for (const thrown of [undefined, null, `a string with ${SECRET_NAME}`, 42, { name: SECRET_NAME }]) logRequestError(req, thrown);
    expectAbsent(SECRET_NAME);
    expect(calls.at(-1)[1]).toMatchObject({ classification: 'non-error' });
    logRequestError(req, Object.assign(new Error('x'), { name: SECRET_NAME }));
    expect(calls.at(-1)[1].name).toBeUndefined();
  });

  it('classifies Prisma-shaped errors and logs no message at all for them', () => {
    const message = `Invalid \`prisma.serviceRequest.create()\` invocation:\n{ data: { patientName: "${SECRET_NAME}", description: "${SECRET_DIAGNOSIS}" } }`;
    const validation = Object.assign(new Error(message), { name: 'PrismaClientValidationError', clientVersion: '6.19.3' });
    const known = Object.assign(new Error(message), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { modelName: 'ServiceRequest', target: ['reference_number'], cause: SECRET_NAME, value: SECRET_DIAGNOSIS },
    });
    logRequestError({ ...req, body: {} }, validation);
    logRequestError({ ...req, body: {} }, known);
    expectAbsent(SECRET_NAME, SECRET_DIAGNOSIS, 'invocation');
    expect(calls[0][1]).toMatchObject({ classification: 'prisma-validation', name: 'PrismaClientValidationError', clientVersion: '6.19.3' });
    expect(calls[0][1].message).toBeUndefined();
    expect(calls[1][1]).toMatchObject({ classification: 'prisma-known-request', code: 'P2002', meta: { modelName: 'ServiceRequest', target: ['reference_number'] } });
  });
});

describe('logRequestError: body-reading errors', () => {
  const req = { method: 'POST', path: '/requests', headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '42' } };

  it('summarises the error and drops its body, message and stack', () => {
    const err = Object.assign(new SyntaxError(`Unexpected token in "${SECRET_NAME}"`), { type: 'entity.parse.failed', statusCode: 400, body: `{"name":"${SECRET_NAME}"` });
    logRequestError(req, err);
    expectAbsent(SECRET_NAME);
    expect(calls[0][1]).toEqual({ type: 'entity.parse.failed', status: 400, method: 'POST', path: '/requests', contentType: 'application/json', contentLength: 42 });
    expect(isBodyParserError(err)).toBe(true);
  });
});
