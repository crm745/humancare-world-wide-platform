/* global describe, test, expect, jest, beforeEach, afterEach */
// M4: a slow or unavailable CRM (Bitrix24) must not hold up a patient's submission. The REAL controller and createRequest run on a small fake database; the Bitrix call is a controllable stand-in.
// What is shown: the patient gets its answer within BITRIX_SUBMIT_WAIT_MS however slow the CRM is; the one lead call carries on in the background (never abandoned, never started twice, so no second
// lead); its outcome is stored when it ends; a failure is recorded for the retry sweep exactly as before; a retry of the submission and "check status" (the idempotency key) work throughout; reports
// uploaded while the lead was being made are forwarded once it exists. No database, no network.
const mockDb = { rows: [], cases: [], docs: [], nextRow: 100, nextCase: 1, failRecording: false };
const mockMatch = (row, where) => require('./fake-auth-prisma').matches(row, where);

jest.mock('../../src/db/prisma', () => {
  const uniqueError = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const copy = (row) => (row ? { ...row } : null);
  const serviceRequest = {
    async create({ data }) {
      if (data.clientRequestId && mockDb.rows.some((r) => r.userId === data.userId && r.clientRequestId === data.clientRequestId)) throw uniqueError();
      const row = { id: mockDb.nextRow++, createdAt: new Date(), updatedAt: new Date(), bitrixLeadId: null, bitrixSyncAttempts: 0, bitrixLastError: null, bitrixSyncFailedAt: null, ...data };
      mockDb.rows.push(row);
      return copy(row);
    },
    async update({ where, data }) {
      if (mockDb.failRecording && data.bitrixSyncAttempts !== undefined) throw new Error('database is down while recording the failure');
      const row = mockDb.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return copy(row);
    },
    async findFirst({ where }) { return copy(mockDb.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v))); },
    async findMany({ where }) { return mockDb.rows.filter((r) => mockMatch(r, where)).map((r) => ({ ...r, user: { id: r.userId, email: 'p@example.test', name: 'P' }, case: { documents: [] } })); },
  };
  const tx = {
    serviceRequest,
    case: { async create({ data }) { const row = { id: mockDb.nextCase++, ...data }; mockDb.cases.push(row); return copy(row); }, async update() { return {}; } },
    caseStageEvent: { async create() { return {}; } },
    requestEvent: { async create() { return {}; } },
  };
  return {
    prisma: {
      $transaction: async (callback) => callback(tx),
      serviceRequest,
      case: { findMany: async () => [], update: async () => ({}) },
      user: { findUnique: async ({ where }) => ({ id: where.id, email: 'p@example.test', name: 'P' }) },
      document: { findMany: async ({ where }) => mockDb.docs.filter((d) => d.type === where.type && d.requestId === where.case.serviceRequestId) },
    },
  };
});
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn(async () => true) }));
jest.mock('../../src/modules/bitrix/deal-outbox', () => ({ enqueueDealCreation: jest.fn(async () => {}) }));
jest.mock('../../src/common/audit/business-audit', () => ({ appendAuditLog: jest.fn(async () => {}) }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: 'not-used', upload: { single: () => (req, res, next) => next() } }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: async () => ({}), getVerifiedCity: async () => null }));

const { createLead, sendMedicalReportToBitrix } = require('../../src/modules/bitrix/bitrix.service');
const { createRequest, bitrixSubmitWaitMs } = require('../../src/modules/requests/requests.service');
const { submitRequest, getMyRequestByClientRequestId } = require('../../src/modules/requests/requests.controller');
const { retryFailedBitrixSyncs } = require('../../src/modules/bitrix/bitrix-retry.service');

const KEY = '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c';
const day = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const body = (extra = {}) => ({
  serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Mumbai', preferredDate: day(3), description: 'Needs transport.', ...extra,
});
async function post(payload, userId = 7) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(data) { out.body = data; return this; } };
  await submitRequest({ body: payload, user: { id: userId } }, res, (err) => { out.err = err; });
  return out;
}
async function check(key, userId = 7) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(data) { out.body = data; return this; } };
  await getMyRequestByClientRequestId({ params: { clientRequestId: key }, user: { id: userId } }, res, (err) => { out.err = err; });
  return out;
}
// A Bitrix call the test finishes by hand.
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const rowOf = (id) => mockDb.rows.find((r) => r.id === id);
const elapsed = async (work) => { const start = Date.now(); const result = await work(); return { result, ms: Date.now() - start }; };

beforeEach(() => {
  mockDb.rows.length = 0; mockDb.cases.length = 0; mockDb.docs.length = 0; mockDb.nextRow = 100; mockDb.nextCase = 1; mockDb.failRecording = false;
  jest.clearAllMocks();
  createLead.mockReset();
  createLead.mockImplementation(async () => 777);
  process.env.BITRIX_SYNC_ENABLED = 'true';
  process.env.BITRIX_SUBMIT_WAIT_MS = '60';
  delete process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED;
  delete process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.BITRIX_SYNC_ENABLED; delete process.env.BITRIX_SUBMIT_WAIT_MS; delete process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED; });

describe('the wait budget', () => {
  test.each([
    [undefined, 2500], [null, 2500], ['', 2500], ['   ', 2500], ['0', 0], ['100', 100], [' 100 ', 100], ['15000', 15000], ['15001', 2500], ['999999', 2500],
    ['abc', 2500], ['-5', 2500], ['1.5', 2500], ['1e3', 2500], ['0x10', 2500], ['100ms', 2500],
  ])('BITRIX_SUBMIT_WAIT_MS=%j gives %i', (value, expected) => {
    expect(bitrixSubmitWaitMs({ BITRIX_SUBMIT_WAIT_MS: value })).toBe(expected);
  });
  test('the default is short enough to sit well inside the app\'s 30 s write timeout', () => { expect(bitrixSubmitWaitMs({})).toBeLessThanOrEqual(5000); });
});

describe('a healthy CRM behaves exactly as before', () => {
  test('the lead is made and stored before the answer; one call; no warning', async () => {
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(out.body.request.referenceNumber).toBe('REQ-1100');
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(rowOf(100)).toMatchObject({ bitrixLeadId: 777, bitrixSyncAttempts: 0 });
    expect(console.warn).not.toHaveBeenCalled();
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
  });
  test('the sync switch off: nothing is sent and nothing is waited for', async () => {
    process.env.BITRIX_SYNC_ENABLED = 'false';
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(createLead).not.toHaveBeenCalled();
    expect(rowOf(100).bitrixSyncAttempts).toBe(0);
  });
  test('Private Charter with the Deal integration on still never makes a lead', async () => {
    process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'true';
    await createRequest(7, { serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'John Doe', origin: 'Pune', destination: 'Dubai' });
    expect(createLead).not.toHaveBeenCalled();
  });
});

describe('a slow CRM does not hold the patient', () => {
  test('the answer comes back within the budget although the CRM never answers; the one call keeps going', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    const { result, ms } = await elapsed(() => post(body()));
    expect(result.status).toBe(201);
    expect(result.body.request.referenceNumber).toBe('REQ-1100');
    expect(ms).toBeLessThan(1500); // the budget is 60 ms here; the CRM would have held it for ever
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(rowOf(100).bitrixLeadId).toBeNull();
    expect(rowOf(100).bitrixSyncAttempts).toBe(0); // in flight is not "failed": nothing is recorded yet
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Bitrix24 is slow'));
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain('John Doe'); // no patient data in the log
    lead.resolve(888);
    await flush();
    expect(rowOf(100)).toMatchObject({ bitrixLeadId: 888, bitrixSyncAttempts: 0, bitrixLastError: null });
    expect(createLead).toHaveBeenCalledTimes(1); // still one: no second lead
  });
  test('a budget of 0 answers at once and the call still happens once', async () => {
    process.env.BITRIX_SUBMIT_WAIT_MS = '0';
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(createLead).toHaveBeenCalledTimes(1);
    lead.resolve(5);
    await flush();
    expect(rowOf(100).bitrixLeadId).toBe(5);
  });
  test('a CRM that answers just inside the budget is waited for (lead stored before the answer)', async () => {
    createLead.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(321), 15)));
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(rowOf(100).bitrixLeadId).toBe(321);
    expect(console.warn).not.toHaveBeenCalled();
  });
  test('slow and then failing: the failure is recorded for the retry sweep, exactly as before', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    const out = await post(body());
    expect(out.status).toBe(201);
    lead.reject(new Error('Bitrix24 crm.lead.add timed out after 15s'));
    await flush();
    const row = rowOf(100);
    expect(row.bitrixLeadId).toBeNull();
    expect(row).toMatchObject({ bitrixSyncAttempts: 1, bitrixLastError: 'Bitrix24 crm.lead.add timed out after 15s' });
    expect(row.bitrixSyncFailedAt).toBeInstanceOf(Date);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
});

describe('an unavailable CRM never fails or delays the saved request', () => {
  test('an immediate failure: 201, recorded for the sweep (attempts 1, the error, the time)', async () => {
    createLead.mockRejectedValue(new Error('Bitrix24 crm.lead.add failed (HTTP 503): no error details in response'));
    const out = await post(body());
    expect(out.status).toBe(201);
    expect(out.err).toBeUndefined();
    expect(rowOf(100)).toMatchObject({ bitrixSyncAttempts: 1, bitrixLastError: 'Bitrix24 crm.lead.add failed (HTTP 503): no error details in response' });
    expect(rowOf(100).bitrixSyncFailedAt).toBeInstanceOf(Date);
  });
  test('the answer to the patient never carries the CRM fields or the error', async () => {
    createLead.mockRejectedValue(new Error('secret webhook details'));
    const out = await post(body());
    const text = JSON.stringify(out.body);
    expect(text).not.toContain('secret webhook details');
    expect(text).not.toMatch(/bitrix/i);
  });
  test('even when the failure cannot be recorded (the database is down) the saved request is still answered 201 and nothing is left unhandled', async () => {
    mockDb.failRecording = true;
    createLead.mockRejectedValue(new Error('crm down'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const out = await post(body());
      await flush();
      expect(out.status).toBe(201);
      expect(out.err).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be recorded'));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });
  test('the same when the user lookup itself fails', async () => {
    const { prisma } = require('../../src/db/prisma');
    const original = prisma.user.findUnique;
    prisma.user.findUnique = async () => { throw new Error('lookup failed'); };
    try {
      const out = await post(body());
      expect(out.status).toBe(201);
      expect(rowOf(100).bitrixSyncAttempts).toBe(1);
      expect(createLead).not.toHaveBeenCalled();
    } finally { prisma.user.findUnique = original; }
  });
});

describe('idempotency and check-status recovery are untouched', () => {
  test('a retry of the same submission while its lead is still being made returns the original (200) and makes no second lead', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    const first = await post(body({ clientRequestId: KEY }));
    expect(first.status).toBe(201);
    const retry = await post(body({ clientRequestId: KEY }));
    expect(retry.status).toBe(200);
    expect(retry.body.request.id).toBe(first.body.request.id);
    expect(mockDb.rows).toHaveLength(1);
    expect(mockDb.cases).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
    lead.resolve(900);
    await flush();
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(rowOf(100).bitrixLeadId).toBe(900);
  });
  test('"check status" finds the request at any moment of the CRM call, and only for its owner', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    const first = await post(body({ clientRequestId: KEY }));
    const found = await check(KEY);
    expect(found.body.request.id).toBe(first.body.request.id);
    expect((await check(KEY, 8)).status).toBe(404); // another patient has nothing under that key
    lead.resolve(1);
    await flush();
    expect((await check(KEY)).body.request.id).toBe(first.body.request.id);
  });
  test('a lost answer: the app retries with the same key after a slow CRM and gets the original, once', async () => {
    createLead.mockImplementation(() => new Promise(() => {})); // never answers
    const first = await post(body({ clientRequestId: KEY }));
    expect(first.status).toBe(201);
    const second = await post(body({ clientRequestId: KEY }));
    const third = await post(body({ clientRequestId: KEY }));
    expect([second.status, third.status]).toEqual([200, 200]);
    expect(mockDb.rows).toHaveLength(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('a key reused for another service is still refused', async () => {
    await post(body({ clientRequestId: KEY }));
    const other = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'J', origin: 'Pune', destination: 'Pune', clientRequestId: KEY });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('client_request_id_reused');
  });
  test('two patients submitting at once each get their own request and their own single lead', async () => {
    const leads = [deferred(), deferred()];
    let n = 0;
    createLead.mockImplementation(() => leads[n++].promise);
    const [a, b] = await Promise.all([post(body(), 7), post(body(), 8)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(createLead).toHaveBeenCalledTimes(2);
    leads[0].resolve(1); leads[1].resolve(2);
    await flush();
    expect(mockDb.rows.map((r) => r.bitrixLeadId).sort()).toEqual([1, 2]);
  });
});

describe('the retry sweep and a lead that is still being made', () => {
  test('a lead in flight (nothing recorded yet) is never picked up by the sweep, so it cannot be made twice', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    await post(body());
    expect(await retryFailedBitrixSyncs()).toBe(0);
    expect(createLead).toHaveBeenCalledTimes(1);
    lead.resolve(10);
    await flush();
    expect(await retryFailedBitrixSyncs()).toBe(0); // done: nothing to retry
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  test('after a recorded failure and the backoff, the sweep makes the lead once (the recovery path)', async () => {
    createLead.mockRejectedValueOnce(new Error('crm down'));
    await post(body());
    expect(rowOf(100).bitrixSyncAttempts).toBe(1);
    expect(await retryFailedBitrixSyncs()).toBe(0); // inside the backoff window
    rowOf(100).bitrixSyncFailedAt = new Date(Date.now() - 10 * 60 * 1000);
    createLead.mockResolvedValueOnce(4242);
    expect(await retryFailedBitrixSyncs()).toBe(1);
    expect(createLead).toHaveBeenCalledTimes(2); // the failed one and the retry: never two successful ones
    expect(rowOf(100)).toMatchObject({ bitrixLeadId: 4242, bitrixLastError: null, bitrixSyncFailedAt: null });
    expect(await retryFailedBitrixSyncs()).toBe(0);
  });
});

describe('reports uploaded while the lead was being made', () => {
  const report = (extra = {}) => ({ id: 1, requestId: 100, type: 'Medical Report', name: 'discharge.pdf', scanStatus: 'clean', sha256: 'a'.repeat(64), scanEngine: 'clamav', scannedAt: new Date(), ...extra });
  test('are forwarded to the lead once it exists (clean ones only), with the comment that names them', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    await post(body());
    mockDb.docs.push(report({ id: 1, name: 'discharge.pdf' }), report({ id: 2, name: 'ct.pdf' }), report({ id: 3, name: 'virus.pdf', scanStatus: 'infected' }), report({ id: 4, name: 'old.pdf', scanStatus: null }));
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
    lead.resolve(555);
    await flush();
    expect(sendMedicalReportToBitrix).toHaveBeenCalledTimes(2);
    expect(sendMedicalReportToBitrix.mock.calls.map((c) => [c[0], c[1].name]).sort()).toEqual([[555, 'ct.pdf'], [555, 'discharge.pdf']]);
    const comments = sendMedicalReportToBitrix.mock.calls[0][2].comments;
    expect(comments).toContain('discharge.pdf');
    expect(comments).toContain('ct.pdf');
    expect(comments).not.toContain('virus.pdf');
    expect(comments).not.toContain('old.pdf');
  });
  test('nothing is forwarded when nothing was uploaded, and nothing when the lead failed (the sweep does that later)', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    await post(body());
    lead.resolve(556);
    await flush();
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
    createLead.mockReset();
    const failing = deferred();
    createLead.mockImplementation(() => failing.promise);
    await post(body(), 9);
    mockDb.docs.push(report({ requestId: 101 }));
    failing.reject(new Error('down'));
    await flush();
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
  });
  test('a failure while forwarding is logged and never becomes an unhandled error or touches the stored lead', async () => {
    const lead = deferred();
    createLead.mockImplementation(() => lead.promise);
    sendMedicalReportToBitrix.mockRejectedValueOnce(new Error('attach failed'));
    await post(body());
    mockDb.docs.push(report());
    lead.resolve(557);
    await flush();
    expect(rowOf(100).bitrixLeadId).toBe(557);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('late follow-up failed'));
  });
});
