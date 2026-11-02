// Unit tests for the Bitrix24 retry sweep's candidate filter (INT-01). No database: Prisma
// and the Bitrix client are mocked, and the clock is controlled, so what is checked is the
// `where` the sweep sends for each model — in particular that the backoff cutoff is worked
// out from the time of each sweep, not from the time the module was first loaded.

jest.mock('../src/db/prisma', () => ({
  prisma: {
    serviceRequest: { findMany: jest.fn(), update: jest.fn() },
    case: { findMany: jest.fn(), update: jest.fn() },
  },
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn(),
  sendMedicalReportToBitrix: jest.fn(),
}));

const { prisma } = require('../src/db/prisma');
const { createLead } = require('../src/modules/bitrix/bitrix.service');
// Loaded once, up front: every test below reuses this one instance, which is exactly the
// situation of the long-running server.
const {
  retryFailedBitrixSyncs,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MINUTES,
} = require('../src/modules/bitrix/bitrix-retry.service');

const MINUTE_MS = 60 * 1000;
const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);

const requestWhere = () => prisma.serviceRequest.findMany.mock.calls.at(-1)[0].where;
const caseWhere = () => prisma.case.findMany.mock.calls.at(-1)[0].where;

function sweepAt(timestamp) {
  jest.spyOn(Date, 'now').mockReturnValue(timestamp);
  return retryFailedBitrixSyncs();
}

beforeEach(() => {
  process.env.BITRIX_SYNC_ENABLED = 'true';
  prisma.serviceRequest.findMany.mockResolvedValue([]);
  prisma.case.findMany.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  delete process.env.BITRIX_SYNC_ENABLED;
});

describe('Bitrix retry sweep: candidate filter', () => {
  it('works the first sweep\'s cutoff out from the time of that sweep', async () => {
    await sweepAt(T0);
    expect(requestWhere().bitrixSyncFailedAt.lt).toEqual(new Date(T0 - 6 * MINUTE_MS));
  });

  it('works a later sweep\'s cutoff out from the later time', async () => {
    await sweepAt(T0);
    await sweepAt(T0 + 5 * MINUTE_MS);
    expect(requestWhere().bitrixSyncFailedAt.lt).toEqual(new Date(T0 + 5 * MINUTE_MS - 6 * MINUTE_MS));
    expect(requestWhere().bitrixSyncFailedAt.lt).not.toEqual(new Date(T0 - 6 * MINUTE_MS));
  });

  it('sends the fresh cutoff in both the ServiceRequest and the Case query', async () => {
    await sweepAt(T0);
    await sweepAt(T0 + 30 * MINUTE_MS);
    const expected = new Date(T0 + 30 * MINUTE_MS - 6 * MINUTE_MS);
    expect(prisma.serviceRequest.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.case.findMany).toHaveBeenCalledTimes(2);
    expect(requestWhere().bitrixSyncFailedAt.lt).toEqual(expected);
    expect(caseWhere().bitrixSyncFailedAt.lt).toEqual(expected);
  });

  it('keeps the six-minute backoff', async () => {
    expect(RETRY_BACKOFF_MINUTES).toBe(6);
    await sweepAt(T0);
    expect(T0 - requestWhere().bitrixSyncFailedAt.lt.getTime()).toBe(6 * MINUTE_MS);
    expect(T0 - caseWhere().bitrixSyncFailedAt.lt.getTime()).toBe(6 * MINUTE_MS);
  });

  it('keeps the strict "earlier than" comparison on the failure time', async () => {
    await sweepAt(T0);
    for (const where of [requestWhere(), caseWhere()]) {
      expect(Object.keys(where.bitrixSyncFailedAt)).toEqual(['lt']);
      expect(where.bitrixSyncFailedAt.lt).toBeInstanceOf(Date);
    }
  });

  it('keeps the other retry criteria: no lead yet, and 1 to MAX_ATTEMPTS - 1 attempts so far', async () => {
    expect(MAX_ATTEMPTS).toBe(5);
    await sweepAt(T0);
    for (const where of [requestWhere(), caseWhere()]) {
      expect(where.bitrixLeadId).toBeNull();
      expect(where.bitrixSyncAttempts).toEqual({ gt: 0, lt: 5 });
    }
  });

  it('does not freeze the cutoff when the one loaded module is used for many sweeps', async () => {
    const cutoffs = [];
    for (const minutes of [0, 5, 10, 15]) {
      await sweepAt(T0 + minutes * MINUTE_MS);
      cutoffs.push(requestWhere().bitrixSyncFailedAt.lt.getTime());
    }
    expect(cutoffs).toEqual([0, 5, 10, 15].map((minutes) => T0 + (minutes - 6) * MINUTE_MS));
    expect(new Set(cutoffs).size).toBe(4);
  });

  it('builds a new filter object for every query', async () => {
    await sweepAt(T0);
    const first = requestWhere();
    await sweepAt(T0 + 5 * MINUTE_MS);
    expect(requestWhere()).not.toBe(first);
    expect(requestWhere().bitrixSyncFailedAt).not.toBe(first.bitrixSyncFailedAt);
  });

  it('treats a failure that happens after the module was loaded as due once the backoff has passed', async () => {
    const failedAt = new Date(T0 + 1 * MINUTE_MS);
    const request = { id: 1, referenceNumber: 'REQ-1001', bitrixSyncAttempts: 1, user: {}, case: null };
    // Stand-in for the database: returns the row only if the filter's cutoff is later than its failure time.
    prisma.serviceRequest.findMany.mockImplementation(async ({ where }) => (failedAt < where.bitrixSyncFailedAt.lt ? [request] : []));
    createLead.mockRejectedValue(new Error('stop here'));
    jest.spyOn(console, 'error').mockImplementation(() => {}); // the failed retry below logs, as it should

    await expect(sweepAt(T0 + 3 * MINUTE_MS)).resolves.toBe(0); // 2 minutes after the failure: still backing off
    await expect(sweepAt(T0 + 8 * MINUTE_MS)).resolves.toBe(1); // 7 minutes after: due
  });
});

describe('Bitrix retry sweep: kill switch', () => {
  it.each([undefined, 'false', 'TRUE', '1', ''])('runs no query while BITRIX_SYNC_ENABLED is %p', async (value) => {
    if (value === undefined) delete process.env.BITRIX_SYNC_ENABLED;
    else process.env.BITRIX_SYNC_ENABLED = value;
    await expect(sweepAt(T0)).resolves.toBe(0);
    expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.case.findMany).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });
});
