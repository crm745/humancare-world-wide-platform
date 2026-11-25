/* global describe, test, expect, beforeEach, afterEach, jest */
// Private Charter and the legacy Bitrix Lead integration. No database and no network: Prisma and the Bitrix client
// are mocked. The retry tests give the sweep fixture rows and evaluate the `where` it sends with SQL semantics
// (NULL never matches `<>`), so they check WHICH records would be retried, not just the shape of the filter.
jest.mock('../../src/db/prisma', () => {
  const prisma = {
    serviceRequest: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    case: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    caseStageEvent: { create: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  // createRequest saves the request, its Case and its first stage event in one transaction: the mock runs the callback on itself (the recorder keeps what each call would have written).
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma };
});
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn(),
  sendMedicalReportToBitrix: jest.fn(),
}));
jest.mock('../../src/modules/request-review/request-review.service', () => ({ createReviewRequest: jest.fn() }));

const { prisma } = require('../../src/db/prisma');
const { createLead } = require('../../src/modules/bitrix/bitrix.service');
const { createReviewRequest } = require('../../src/modules/request-review/request-review.service');
const { createRequest } = require('../../src/modules/requests/requests.service');
const { retryFailedBitrixSyncs } = require('../../src/modules/bitrix/bitrix-retry.service');

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);
const ENV_KEYS = ['BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW'];
const setEnv = (values) => { for (const key of ENV_KEYS) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } };

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  setEnv({});
});

// ---- new submissions --------------------------------------------------------------------------------------------------
describe('createRequest (the original flow) and Private Charter', () => {
  const body = (serviceKey) => ({
    serviceType: serviceKey === 'privatecharter' ? 'Private Charter Air Ambulance Service' : 'Ground Ambulance (GA)', serviceKey,
    patientName: 'Test Patient', origin: 'Pune', destination: 'Mumbai',
  });

  beforeEach(() => {
    prisma.serviceRequest.create.mockResolvedValue({ id: 11 });
    prisma.serviceRequest.update.mockImplementation(async ({ data }) => ({ id: 11, serviceKey: null, ...data }));
    prisma.case.create.mockResolvedValue({ id: 21 });
    prisma.caseStageEvent.create.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ id: 5, name: 'Pat', email: 'p@example.test', mobile: '+910000000000' });
    createLead.mockResolvedValue(9001);
  });

  test('Deal switch OFF: Private Charter still gets its Lead, exactly as before', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true' });
    await createRequest(5, body('privatecharter'));
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(prisma.serviceRequest.update).toHaveBeenCalledWith(expect.objectContaining({ data: { bitrixLeadId: 9001 } }));
  });

  test('Deal switch ON: a Private Charter submission creates no Lead and records no failure', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' }); // review workflow off: the guard, not the start-up check
    await createRequest(5, body('privatecharter'));
    expect(createLead).not.toHaveBeenCalled();
    const updates = prisma.serviceRequest.update.mock.calls.map(([arg]) => Object.keys(arg.data));
    expect(updates).toEqual([['referenceNumber']]); // only the reference; no bitrixLeadId, no bitrixSyncAttempts
  });

  test('Deal switch ON with the review workflow: Private Charter goes to the review workflow, no Lead', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' });
    createReviewRequest.mockResolvedValue({ id: 99 });
    await expect(createRequest(5, body('privatecharter'))).resolves.toEqual({ id: 99 });
    expect(createReviewRequest).toHaveBeenCalledTimes(1);
    expect(createLead).not.toHaveBeenCalled();
    expect(prisma.serviceRequest.create).not.toHaveBeenCalled();
  });

  test('Deal switch ON: another service (ground) still gets its Lead', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' });
    await createRequest(5, body('ground'));
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createReviewRequest).not.toHaveBeenCalled();
  });

  test('Deal switch ON: a request with no service key still gets its Lead', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' });
    await createRequest(5, { ...body(undefined), serviceType: 'Air Ambulance' });
    expect(createLead).toHaveBeenCalledTimes(1);
  });
});

// ---- the two retry sweeps ---------------------------------------------------------------------------------------------
// Evaluates a Prisma `where` the way MySQL would for the operators the sweeps use. `not` is `<>`: NULL never matches it.
function cmp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === 'gt') return value != null && value > arg;
      if (op === 'lt') return value != null && value < arg;
      if (op === 'not') return value != null && value !== arg;
      throw new Error(`unsupported operator ${op}`);
    });
  }
  return cond === null ? value === null : value === cond;
}
function matches(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((w) => matches(row, w));
    if (key === 'AND') return cond.every((w) => matches(row, w));
    if (key === 'serviceRequest') {
      if (!cond.is) throw new Error('unsupported relation filter');
      const related = row.serviceRequest ?? null;
      return related !== null && matches(related, cond.is);
    }
    return cmp(row[key], cond);
  });
}

describe('the Lead retry sweeps', () => {
  const failed = { bitrixLeadId: null, bitrixSyncAttempts: 2, bitrixSyncFailedAt: new Date(T0 - 10 * MINUTE) };
  const requestRow = (ref, serviceKey) => ({
    ...failed, id: ref, referenceNumber: `REQ-${ref}`, serviceKey, patientName: 'Test', origin: 'Pune', destination: 'Mumbai',
    serviceType: 'x', user: { name: 'U' }, case: null,
  });
  const caseRow = (ref, serviceRequest) => ({
    ...failed, id: ref, referenceNumber: `CASE-${ref}`, serviceRequestId: serviceRequest ? ref : null, serviceRequest,
    patientName: 'Test', origin: 'Pune', destination: 'Mumbai', serviceType: 'x', urgency: 'routine', documents: [],
  });
  const requests = [requestRow(1, 'privatecharter'), requestRow(2, 'ground'), requestRow(3, null)];
  const cases = [
    caseRow(10, null), // Corporate Case: no service request
    caseRow(11, { serviceKey: 'privatecharter' }),
    caseRow(12, { serviceKey: 'ground' }),
    caseRow(13, { serviceKey: null }),
  ];

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    prisma.serviceRequest.findMany.mockImplementation(async ({ where }) => requests.filter((row) => matches(row, where)));
    prisma.case.findMany.mockImplementation(async ({ where }) => cases.filter((row) => matches(row, where)));
    prisma.serviceRequest.update.mockResolvedValue({});
    prisma.case.update.mockResolvedValue({});
    createLead.mockResolvedValue(777);
  });

  const retried = () => createLead.mock.calls.map(([input]) => input.referenceNumber).sort();

  test('Deal switch OFF: every failed record is retried, Private Charter included (unchanged)', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true' });
    await retryFailedBitrixSyncs();
    expect(retried()).toEqual(['CASE-10', 'CASE-11', 'CASE-12', 'CASE-13', 'REQ-1', 'REQ-2', 'REQ-3']);
  });

  test('Deal switch ON: Private Charter is skipped by both sweeps; Corporate, other services and NULL service keys stay', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' });
    await retryFailedBitrixSyncs();
    expect(retried()).toEqual(['CASE-10', 'CASE-12', 'CASE-13', 'REQ-2', 'REQ-3']);
  });

  test('Deal switch ON: no record of Private Charter is updated either (history is untouched)', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' });
    await retryFailedBitrixSyncs();
    const updatedRequestIds = prisma.serviceRequest.update.mock.calls.map(([arg]) => arg.where.id);
    const updatedCaseIds = prisma.case.update.mock.calls.map(([arg]) => arg.where.id);
    expect(updatedRequestIds.sort()).toEqual([2, 3]);
    expect(updatedCaseIds.sort()).toEqual([10, 12, 13]);
  });

  test('Deal switch OFF keeps the original filter object (nothing extra is added)', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true' });
    await retryFailedBitrixSyncs();
    expect(Object.keys(prisma.serviceRequest.findMany.mock.calls[0][0].where).sort()).toEqual(['bitrixLeadId', 'bitrixSyncAttempts', 'bitrixSyncFailedAt']);
    expect(Object.keys(prisma.case.findMany.mock.calls[0][0].where).sort()).toEqual(['bitrixLeadId', 'bitrixSyncAttempts', 'bitrixSyncFailedAt']);
  });

  test('Deal switch ON: the request filter names the service and handles NULL; the Case filter keeps Corporate Cases explicitly', async () => {
    setEnv({ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' });
    await retryFailedBitrixSyncs();
    const requestWhere = prisma.serviceRequest.findMany.mock.calls[0][0].where;
    const caseWhere = prisma.case.findMany.mock.calls[0][0].where;
    expect(requestWhere.OR).toEqual([{ serviceKey: null }, { serviceKey: { not: 'privatecharter' } }]);
    expect(caseWhere.OR[0]).toEqual({ serviceRequestId: null });
    expect(caseWhere.OR[1]).toEqual({ serviceRequest: { is: { OR: [{ serviceKey: null }, { serviceKey: { not: 'privatecharter' } }] } } });
  });

  test('the master switch OFF: nothing is queried or sent, whatever the Deal switch says', async () => {
    setEnv({ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' });
    await expect(retryFailedBitrixSyncs()).resolves.toBe(0);
    expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.case.findMany).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });
});
