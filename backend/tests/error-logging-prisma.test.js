// A REAL Prisma validation error, produced by the real client and carrying the submitted data
// in its message, goes through the real request route and error handler. Prisma refuses the
// invalid call before anything is written, but this file still needs the test database to be
// reachable (humancare_test, as for the rest of the suite).
jest.mock('../src/modules/requests/requests.service', () => ({
  ...jest.requireActual('../src/modules/requests/requests.service'),
  createRequest: jest.fn(),
}));

const util = require('util');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createRequest } = require('../src/modules/requests/requests.service');

afterAll(async () => { await prisma.$disconnect(); });

const SECRET_NAME = 'Zephyrina-Quillfeather';
const SECRET_NOTE = 'Hodgkin-lymphoma-stage-IV';
const SECRET_PHONE = '+971509876543';
const token = jwt.sign({ sub: 4242, role: 'patient' }, process.env.JWT_ACCESS_SECRET);

// Invalid on purpose: patientAge must be a number. Prisma rejects the call and names the data.
const failingCreate = (data) => prisma.serviceRequest.create({
  data: {
    userId: 4242,
    serviceType: 'x',
    origin: 'o',
    destination: 'd',
    referenceNumber: 'TEMP-sentinel',
    patientName: data.patientName,
    patientContact: data.patientContact,
    description: data.description,
    patientAge: 'not-a-number',
  },
});

let calls;
beforeEach(() => {
  calls = [];
  for (const method of ['error', 'warn', 'info', 'log', 'debug']) {
    jest.spyOn(console, method).mockImplementation((...args) => { calls.push(args); });
  }
});
afterEach(() => jest.restoreAllMocks());
const logged = () => calls.map((args) => util.inspect(args, { depth: 10, maxStringLength: null })).join('\n');

describe('a real PrismaClientValidationError', () => {
  const body = {
    serviceType: 'Ground Ambulance (GA)',
    serviceKey: 'ground',
    origin: 'Mumbai',
    destination: 'Dubai',
    patientName: SECRET_NAME,
    patientContact: SECRET_PHONE,
    description: SECRET_NOTE,
  };

  it('does contain the submitted data in its own message (so these tests are meaningful)', async () => {
    let caught;
    try { await failingCreate(body); } catch (err) { caught = err; }
    expect(caught && caught.name).toBe('PrismaClientValidationError');
    expect(caught.message).toContain(SECRET_NAME);
    expect(caught.message).toContain(SECRET_NOTE);
    expect(util.inspect(caught)).toContain(SECRET_NAME);
  });

  it('is logged without any submitted value, with its classification and frames', async () => {
    createRequest.mockImplementation(async (_userId, data) => failingCreate(data));
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    const output = logged();
    for (const sentinel of [SECRET_NAME, SECRET_NOTE, SECRET_PHONE, 'not-a-number', 'TEMP-sentinel', 'prisma.serviceRequest.create']) {
      expect(output).not.toContain(sentinel);
    }
    const summary = calls.find((args) => args[0] === '[request-error]')[1];
    expect(summary).toMatchObject({ classification: 'prisma-validation', name: 'PrismaClientValidationError', method: 'POST', path: '/requests' });
    expect(typeof summary.clientVersion).toBe('string');
    expect(summary.message).toBeUndefined();
    expect(summary.frames.length).toBeGreaterThan(0);
  });

  it('is logged without the submitted values when a plain error repeats them', async () => {
    createRequest.mockRejectedValue(new Error(`could not save ${SECRET_NAME} (${SECRET_PHONE}): ${SECRET_NOTE}`));
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(500);
    for (const sentinel of [SECRET_NAME, SECRET_NOTE, SECRET_PHONE]) expect(logged()).not.toContain(sentinel);
    expect(calls.find((args) => args[0] === '[request-error]')[1]).toMatchObject({ classification: 'application', name: 'Error' });
  });
});
