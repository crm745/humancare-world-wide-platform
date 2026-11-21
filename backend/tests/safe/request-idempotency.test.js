/* global describe, test, expect, beforeEach, afterEach, jest */
// Phase 4: idempotent request submission. The REAL controller, service and review workflow run on a FAKE database that behaves like InnoDB where it matters here:
// a transaction's writes are invisible until it commits and vanish if it fails; a unique index is enforced across transactions; and an insert that meets a key held by
// another UNCOMMITTED transaction WAITS for it (then fails if it committed, or succeeds if it rolled back). Bitrix and the review workflow's neighbours are mocked.
// No database, no network: run with jest.safe.config.js (DATABASE_URL is a closed port and fetch is blocked).
const fs = require('fs');
const path = require('path');

jest.mock('../../src/db/prisma', () => {
  const state = { rows: [], cases: [], events: [], requestEvents: [], nextRow: 100, nextCase: 1, nextTx: 1, held: new Map(), failOn: null, delayMs: 0 };
  const uniqueError = (target) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: 'P2002', meta: { target } });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const keyOf = (row) => (row.clientRequestId ? `${row.userId}|${row.clientRequestId}` : null);
  const copy = (row) => (row ? { ...row } : null); // Prisma returns null for "not found"

  function makeTx() {
    const id = state.nextTx++;
    const staged = { rows: [], cases: [], events: [], requestEvents: [] };
    const myKeys = [];
    const failIf = (name) => { if (state.failOn === name) throw new Error(`injected failure in ${name}`); };
    const api = {
      serviceRequest: {
        async create({ data }) {
          await tick();
          const key = keyOf(data);
          if (key) {
            for (;;) {
              if (state.rows.some((r) => keyOf(r) === key)) throw uniqueError('uq_service_requests_user_client_request');
              const holder = state.held.get(key);
              if (!holder || holder.tx === id) break;
              await holder.done; // wait for the other transaction to commit or roll back, as InnoDB does
            }
            let release;
            const done = new Promise((resolve) => { release = resolve; });
            state.held.set(key, { tx: id, done, release });
            myKeys.push(key);
          }
          if (state.rows.concat(staged.rows).some((r) => r.referenceNumber === data.referenceNumber)) throw uniqueError('service_requests_reference_number_key');
          const row = { id: state.nextRow++, createdAt: new Date('2026-11-19T10:00:00Z'), updatedAt: new Date('2026-11-19T10:00:00Z'), ...data };
          staged.rows.push(row);
          return copy(row);
        },
        async update({ where, data }) {
          await tick();
          const row = staged.rows.find((r) => r.id === where.id) || state.rows.find((r) => r.id === where.id);
          Object.assign(row, data);
          return copy(row);
        },
        async findFirst({ where }) { return copy(state.rows.concat(staged.rows).find((r) => Object.entries(where).every(([k, v]) => r[k] === v))); },
      },
      case: {
        async create({ data }) {
          await tick();
          failIf('case.create');
          if (state.cases.concat(staged.cases).some((c) => c.serviceRequestId === data.serviceRequestId)) throw uniqueError('cases_service_request_id_key');
          const row = { id: state.nextCase++, ...data };
          staged.cases.push(row);
          return copy(row);
        },
        async update({ where, data }) { const row = staged.cases.find((c) => c.id === where.id); Object.assign(row, data); return copy(row); },
      },
      caseStageEvent: { async create({ data }) { await tick(); failIf('caseStageEvent.create'); staged.events.push(data); return {}; } },
      requestEvent: { async create({ data }) { staged.requestEvents.push(data); return {}; } },
    };
    const finish = (commit) => {
      if (commit) {
        state.rows.push(...staged.rows); state.cases.push(...staged.cases); state.events.push(...staged.events); state.requestEvents.push(...staged.requestEvents);
      }
      for (const key of myKeys) { const holder = state.held.get(key); state.held.delete(key); holder.release(); }
    };
    return { api, finish };
  }

  const prisma = {
    async $transaction(callback) {
      const { api, finish } = makeTx();
      try {
        const result = await callback(api);
        finish(true);
        return result;
      } catch (err) {
        finish(false);
        throw err;
      }
    },
    serviceRequest: {
      async findFirst({ where }) { return copy(state.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v))); },
      async update({ where, data }) { const row = state.rows.find((r) => r.id === where.id); Object.assign(row, data); return copy(row); },
    },
    user: { async findUnique({ where }) { return { id: where.id, email: 'p@example.test', name: 'P' }; } },
  };
  return { prisma, __state: state };
});
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(async () => 777), sendMedicalReportToBitrix: jest.fn() }));
jest.mock('../../src/modules/bitrix/deal-outbox', () => ({ enqueueDealCreation: jest.fn(async () => {}) }));
jest.mock('../../src/common/audit/business-audit', () => ({ appendAuditLog: jest.fn(async () => {}) }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: 'uploads-not-used-in-these-tests', upload: { single: () => (req, res, next) => next() } }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: async () => ({}), getVerifiedCity: async () => null }));

const { __state: db } = require('../../src/db/prisma');
const { createLead } = require('../../src/modules/bitrix/bitrix.service');
const { enqueueDealCreation } = require('../../src/modules/bitrix/deal-outbox');
const { appendAuditLog } = require('../../src/common/audit/business-audit');
const { createRequest, findRequestByClientRequestId } = require('../../src/modules/requests/requests.service');
const { submitRequest, getMyRequestByClientRequestId } = require('../../src/modules/requests/requests.controller');
const { parseClientRequestId, UUID_PATTERN } = require('../../src/modules/requests/client-request-id');
const { toPatientRequest } = require('../../src/modules/requests/request-response');

const KEY_A = '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c';
const KEY_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const groundBody = (extra = {}) => ({
  serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientAge: '61', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210',
  origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: inDays(3), careLevel: 'crit_icu', description: 'Needs transport.', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h', ...extra,
});
const OFFICE = 'Plot 14, Andheri East, Mumbai';
const corporateBody = (extra = {}) => ({
  serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female',
  programmes: ['nurse', 'doctor'], patientContact: '+91 98765 43210', preferredDate: inDays(3), utcOffsetMinutes: 0, officeAddress: OFFICE, officeCountry: 'IN', ...extra,
});
const dataOf = (extra = {}) => ({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', urgency: 'urgent_24h', ...extra });

async function post(body, userId = 7) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user: { id: userId } }, res, (err) => { out.err = err; });
  return out;
}
async function get(key, userId = 7) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await getMyRequestByClientRequestId({ params: { clientRequestId: key }, user: { id: userId } }, res, (err) => { out.err = err; });
  return out;
}

beforeEach(() => {
  db.rows.length = 0; db.cases.length = 0; db.events.length = 0; db.requestEvents.length = 0;
  db.nextRow = 100; db.nextCase = 1; db.nextTx = 1; db.held.clear(); db.failOn = null;
  jest.clearAllMocks();
  process.env.BITRIX_SYNC_ENABLED = 'true';
  delete process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW;
  jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.BITRIX_SYNC_ENABLED; delete process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW; });

describe('parseClientRequestId', () => {
  test.each([
    [undefined, { present: false }],
    [null, { present: false }],
    [KEY_A, { present: true, valid: true, id: KEY_A }],
    [KEY_A.toUpperCase(), { present: true, valid: true, id: KEY_A }], // the same UUID is always the same key
    ['', { present: true, valid: false }],
    ['not-a-uuid', { present: true, valid: false }],
    [`${KEY_A} `, { present: true, valid: false }],
    [KEY_A.slice(1), { present: true, valid: false }],
    ['3f2b8c1e6a4d4e0b9c7a1d2e3f4a5b6c', { present: true, valid: false }], // no dashes
    [12345, { present: true, valid: false }],
    [{ id: KEY_A }, { present: true, valid: false }],
    [[KEY_A], { present: true, valid: false }],
    [true, { present: true, valid: false }],
    ["3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c'; DROP TABLE service_requests;--", { present: true, valid: false }],
  ])('%j -> %j', (value, expected) => { expect(parseClientRequestId(value)).toEqual(expected); });
  test('fits the column (36 characters) and the pattern is a plain UUID', () => {
    expect(KEY_A).toHaveLength(36);
    expect(UUID_PATTERN.test(KEY_A)).toBe(true);
  });
});

describe('1. the first submission creates one request and one Case', () => {
  test('through the service: request, REQ- reference, Case with the same reference, stage event, and a Bitrix lead', async () => {
    const request = await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    expect(request.referenceNumber).toBe(`REQ-${1000 + request.id}`); // unchanged reference behaviour
    expect(db.cases[0]).toMatchObject({ serviceRequestId: request.id, referenceNumber: request.referenceNumber });
    expect(db.rows[0].clientRequestId).toBe(KEY_A);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('through the controller: 201 with the request, and the key is stored lower-cased', async () => {
    const r = await post({ ...groundBody(), clientRequestId: KEY_A.toUpperCase() });
    expect(r.err).toBeUndefined();
    expect(r.status).toBe(201);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].clientRequestId).toBe(KEY_A);
    expect(r.body.request.referenceNumber).toMatch(/^REQ-\d+$/);
  });
  test('the temporary reference carries a random suffix (two in the same millisecond never collide) and never survives', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const [a, b] = await Promise.all([createRequest(7, dataOf()), createRequest(8, dataOf())]);
    spy.mockRestore();
    expect(a.referenceNumber).toMatch(/^REQ-/);
    expect(b.referenceNumber).toMatch(/^REQ-/);
    expect(db.rows.map((r) => r.referenceNumber).some((ref) => ref.startsWith('TEMP-'))).toBe(false);
  });
});

describe('2. repeating the same key returns the original request', () => {
  test('through the service: same request, no second request, no second Case, no second lead', async () => {
    const first = await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    const second = await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    expect(second.id).toBe(first.id);
    expect(second.referenceNumber).toBe(first.referenceNumber);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('through the controller: 200 with the ORIGINAL request (same id and reference), nothing new saved', async () => {
    const first = await post({ ...groundBody(), clientRequestId: KEY_A });
    const again = await post({ ...groundBody(), clientRequestId: KEY_A });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.request.id).toBe(first.body.request.id);
    expect(again.body.request.referenceNumber).toBe(first.body.request.referenceNumber);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('a replay is not validated again: a rule that has since changed cannot turn a saved request into an error', async () => {
    await post({ ...groundBody(), clientRequestId: KEY_A });
    const lateRetry = await post({ ...groundBody({ preferredDate: '2020-01-01', urgency: 'not-a-real-urgency' }), clientRequestId: KEY_A });
    expect(lateRetry.status).toBe(200);
    expect(db.rows).toHaveLength(1);
  });
  test('the same key for a DIFFERENT service is refused (409), never treated as a replay', async () => {
    await post({ ...groundBody(), clientRequestId: KEY_A });
    const other = await post({ ...groundBody({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital' }), clientRequestId: KEY_A });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('client_request_id_reused');
    expect(db.rows).toHaveLength(1);
  });
  test('the key is removed from the body before any validator: a service that refuses unknown fields still accepts the request', async () => {
    const r = await post({ ...corporateBody(), clientRequestId: KEY_A });
    expect(r.err).toBeUndefined();
    expect(r.status).toBe(201);
    expect(db.rows[0].clientRequestId).toBe(KEY_A);
    // and without the key the same strict validator still refuses a stray field, as it always did
    const stray = await post({ ...corporateBody(), someStrayField: 'x' });
    expect(stray.status).toBe(400);
  });
});

describe('3. concurrent requests with the same key create one request and one Case', () => {
  test('five at once through the service: one request, one Case, one lead, and all five get the same request', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createRequest(7, dataOf(), { clientRequestId: KEY_A })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('five at once through the controller: one request; the winner is 201, the others get the same request back', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => post({ ...groundBody(), clientRequestId: KEY_A })));
    expect(results.every((r) => r.err === undefined && [200, 201].includes(r.status))).toBe(true);
    expect(new Set(results.map((r) => r.body.request.id)).size).toBe(1);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('the loser waits for the winner and then returns it; if the winner FAILS the loser is the one that saves', async () => {
    db.failOn = 'caseStageEvent.create';
    const first = createRequest(7, dataOf(), { clientRequestId: KEY_A });
    const second = createRequest(7, dataOf(), { clientRequestId: KEY_A });
    await expect(first).rejects.toThrow('injected failure');
    db.failOn = null; // the second begins its own work only after the first has rolled back
    await expect(second).resolves.toMatchObject({ referenceNumber: expect.stringMatching(/^REQ-/) });
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
  });
  test('the database uniqueness is the final guard: even if the controller\'s lookup saw nothing (it ran before the first commit), the insert is refused and the first request is returned', async () => {
    const first = await post({ ...groundBody(), clientRequestId: KEY_A });
    const { prisma } = require('../../src/db/prisma');
    jest.spyOn(prisma.serviceRequest, 'findFirst').mockResolvedValueOnce(null); // the controller's early lookup misses
    const second = await post({ ...groundBody(), clientRequestId: KEY_A });
    expect(second.status).toBe(201); // it went on to insert, and lost to the unique index
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('a unique violation that is NOT this submission\'s key is not swallowed', async () => {
    const { prisma } = require('../../src/db/prisma');
    jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await expect(createRequest(7, dataOf(), { clientRequestId: KEY_B })).rejects.toThrow('Unique constraint failed'); // nothing saved under that key: no "original" to return
    expect(db.rows).toHaveLength(0);
  });
});

describe('4 and 5. keys are per patient, and different keys are different requests', () => {
  test('two patients using the same key do not collide, and never see each other\'s request', async () => {
    const a = await createRequest(7, dataOf({ patientName: 'Patient Seven' }), { clientRequestId: KEY_A });
    const b = await createRequest(8, dataOf({ patientName: 'Patient Eight' }), { clientRequestId: KEY_A });
    expect(b.id).not.toBe(a.id);
    expect(db.rows).toHaveLength(2);
    expect(db.cases).toHaveLength(2);
    expect((await findRequestByClientRequestId(7, KEY_A)).patientName).toBe('Patient Seven');
    expect((await findRequestByClientRequestId(8, KEY_A)).patientName).toBe('Patient Eight');
    expect(await findRequestByClientRequestId(9, KEY_A)).toBeNull();
  });
  test('concurrently too', async () => {
    const [a, b] = await Promise.all([createRequest(7, dataOf(), { clientRequestId: KEY_A }), createRequest(8, dataOf(), { clientRequestId: KEY_A })]);
    expect(a.id).not.toBe(b.id);
    expect(db.rows).toHaveLength(2);
  });
  test('different keys from the same patient are different requests, each with its own Case', async () => {
    const a = await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    const b = await createRequest(7, dataOf(), { clientRequestId: KEY_B });
    expect(b.id).not.toBe(a.id);
    expect(b.referenceNumber).not.toBe(a.referenceNumber);
    expect(db.cases).toHaveLength(2);
    expect(createLead).toHaveBeenCalledTimes(2);
  });
});

describe('6. a lost response followed by a retry does not duplicate', () => {
  test('the first call is saved but its answer never arrives (the app times out), then the app retries with the same key', async () => {
    await createRequest(7, dataOf(), { clientRequestId: KEY_A }); // the answer is dropped on the way back: the app never sees it
    const retry = await post({ ...groundBody(), clientRequestId: KEY_A });
    expect(retry.status).toBe(200);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(retry.body.request.referenceNumber).toBe(`REQ-${1000 + db.rows[0].id}`);
  });
  test('"Check status": the owner finds the request by its key; another patient does not; a key never saved is a 404, not an error', async () => {
    await post({ ...groundBody(), clientRequestId: KEY_A });
    const found = await get(KEY_A, 7);
    expect(found.status).toBeUndefined(); // res.json() with the default 200
    expect(found.body.request.referenceNumber).toMatch(/^REQ-/);
    expect((await get(KEY_A, 8)).status).toBe(404);
    expect((await get(KEY_B, 7)).status).toBe(404);
    expect((await get('nope', 7)).status).toBe(400);
  });
  test('a retry after the first one FAILED (nothing saved) saves normally: a key is not burned by a failure', async () => {
    db.failOn = 'case.create';
    await expect(createRequest(7, dataOf(), { clientRequestId: KEY_A })).rejects.toThrow('injected failure');
    db.failOn = null;
    const retry = await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    expect(retry.referenceNumber).toMatch(/^REQ-/);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
  });
});

describe('7. older app versions (no key) work exactly as before', () => {
  test('through the service: no key is stored, and two submissions are two requests (the original behaviour)', async () => {
    const a = await createRequest(7, dataOf());
    const b = await createRequest(7, dataOf());
    expect(b.id).not.toBe(a.id);
    expect(db.rows).toHaveLength(2);
    expect(db.cases).toHaveLength(2);
    expect(db.rows.every((r) => !('clientRequestId' in r))).toBe(true); // the write is exactly what it was
  });
  test('through the controller: a body without the key is saved (201), and a null key counts as none', async () => {
    const a = await post(groundBody());
    const b = await post({ ...groundBody(), clientRequestId: null });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(db.rows).toHaveLength(2);
    expect(db.rows.every((r) => !r.clientRequestId)).toBe(true);
  });
  test('a key that is not a UUID is refused (400) before anything is saved', async () => {
    for (const bad of ['', 'abc', 12345, 'x'.repeat(200)]) {
      const r = await post({ ...groundBody(), clientRequestId: bad });
      expect(r.status).toBe(400);
      expect(r.body.fields).toEqual({ clientRequestId: 'clientRequestId must be a UUID.' });
    }
    expect(db.rows).toHaveLength(0);
  });
  test('the key is never sent back to a patient (the response allow-list does not carry it)', async () => {
    const r = await post({ ...groundBody(), clientRequestId: KEY_A });
    expect(r.body.request).not.toHaveProperty('clientRequestId');
    expect(JSON.stringify(toPatientRequest(db.rows[0]))).not.toContain(KEY_A);
  });
});

describe('8. a failed transaction leaves no orphan', () => {
  test.each(['case.create', 'caseStageEvent.create'])('a failure in %s rolls back the request too', async (point) => {
    db.failOn = point;
    await expect(createRequest(7, dataOf(), { clientRequestId: KEY_A })).rejects.toThrow('injected failure');
    expect(db.rows).toHaveLength(0);
    expect(db.cases).toHaveLength(0);
    expect(db.events).toHaveLength(0);
    expect(db.held.size).toBe(0); // the key is released
    expect(createLead).not.toHaveBeenCalled(); // and nothing was sent to the CRM for a request that does not exist
  });
  test('without a key too (older app builds): the request and Case are saved together or not at all', async () => {
    db.failOn = 'case.create';
    await expect(createRequest(7, dataOf())).rejects.toThrow('injected failure');
    expect(db.rows).toHaveLength(0);
    expect(db.cases).toHaveLength(0);
  });
});

describe('9. no duplicate submission side effects', () => {
  test('a Bitrix lead is created once for the original and never for a replay or a race loser', async () => {
    await Promise.all([createRequest(7, dataOf(), { clientRequestId: KEY_A }), createRequest(7, dataOf(), { clientRequestId: KEY_A })]);
    await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    await post({ ...groundBody(), clientRequestId: KEY_A });
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('the Bitrix call happens AFTER the transaction has committed, never inside it', async () => {
    createLead.mockImplementationOnce(async () => { expect(db.rows).toHaveLength(1); expect(db.cases).toHaveLength(1); return 777; });
    await createRequest(7, dataOf(), { clientRequestId: KEY_A });
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('Private Charter in the review workflow: one request, one Case, one set of events, one audit entry and one Deal record, however many times it arrives', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const charter = { serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'John Doe', origin: 'Pune', destination: 'Dubai', urgency: 'planned' };
    const results = await Promise.all([1, 2, 3].map(() => createRequest(7, charter, { clientRequestId: KEY_A })));
    await createRequest(7, charter, { clientRequestId: KEY_A });
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(db.rows).toHaveLength(1);
    expect(db.cases).toHaveLength(1);
    expect(db.events).toHaveLength(1);
    expect(db.requestEvents).toHaveLength(2); // request created + case created: once
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(enqueueDealCreation).toHaveBeenCalledTimes(1);
    expect(createLead).not.toHaveBeenCalled(); // the review workflow makes no Lead here
    expect(db.rows[0].clientRequestId).toBe(KEY_A);
    expect(db.rows[0].referenceNumber).toBe(`REQ-${1000 + db.rows[0].id}`);
  });
  test('the review workflow rolls back as one: a failure leaves no request, Case, event, audit entry... and the key can be used again', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const charter = { serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'John Doe', origin: 'Pune', destination: 'Dubai', urgency: 'planned' };
    db.failOn = 'caseStageEvent.create';
    await expect(createRequest(7, charter, { clientRequestId: KEY_A })).rejects.toThrow('injected failure');
    expect([db.rows.length, db.cases.length, db.requestEvents.length]).toEqual([0, 0, 0]);
    db.failOn = null;
    await expect(createRequest(7, charter, { clientRequestId: KEY_A })).resolves.toMatchObject({ referenceNumber: expect.stringMatching(/^REQ-/) });
    expect(db.rows).toHaveLength(1);
  });
});

describe('the migration and the schema', () => {
  const backend = path.join(__dirname, '..', '..');
  const read = (relative) => fs.readFileSync(path.join(backend, relative), 'utf8');
  const folder = 'prisma/migrations/20261119130000_service_request_client_request_id';
  test('the migration only ADDS a nullable column and a unique index on (user_id, client_request_id); it changes, drops and deletes nothing', () => {
    const sql = read(`${folder}/migration.sql`).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/ALTER TABLE `service_requests`/);
    expect(sql).toMatch(/ADD COLUMN `client_request_id` VARCHAR\(36\) NULL/);
    expect(sql).toMatch(/ADD UNIQUE INDEX `uq_service_requests_user_client_request` \(`user_id`, `client_request_id`\)/);
    expect(sql).not.toMatch(/DROP|DELETE|UPDATE|TRUNCATE|MODIFY|RENAME|NOT NULL|DEFAULT/i);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
  });
  test('the rollback removes exactly what was added', () => {
    const sql = read(`${folder}/down.sql`).split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/DROP INDEX `uq_service_requests_user_client_request`/);
    expect(sql).toMatch(/DROP COLUMN `client_request_id`/);
  });
  test('the Prisma schema matches the migration (same column, size and index name)', () => {
    const schema = read('prisma/schema.prisma').replace(/\r\n/g, '\n');
    expect(schema).toMatch(/clientRequestId\s+String\?\s+@map\("client_request_id"\) @db\.VarChar\(36\)/);
    expect(schema).toMatch(/@@unique\(\[userId, clientRequestId\], map: "uq_service_requests_user_client_request"\)/);
  });
  test('every service goes through the one key-aware create: no createRequest call in the controller is left without the key', () => {
    const controller = read('src/modules/requests/requests.controller.js');
    const calls = controller.match(/createRequest\(req\.user\.id, [a-zA-Z]+(, \{ clientRequestId \})?\)/g) || [];
    expect(calls).toHaveLength(8); // Private Charter, Teleconsultation, Mortal Remains, Home Healthcare, Medical Value Travel, Marine, Corporate, and the generic body (Air, Ground, ...)
    expect(calls.every((call) => call.includes('{ clientRequestId }'))).toBe(true);
  });
});
