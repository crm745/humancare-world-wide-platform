/* global describe, test, expect, jest, beforeEach, afterEach */
// The legacy Lead retry sweep and the shared Bitrix24 gateway: a call the gateway refused (circuit open / rate limit) was never sent, so it is not a
// failed attempt and never moves a lead toward its permanent failure. No database, no network.
jest.mock('../../src/db/prisma', () => ({
  prisma: { serviceRequest: { findMany: jest.fn(), update: jest.fn() }, case: { findMany: jest.fn(), update: jest.fn() } },
}));
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn() }));

const { prisma } = require('../../src/db/prisma');
const { createLead } = require('../../src/modules/bitrix/bitrix.service');
const { retryFailedBitrixSyncs } = require('../../src/modules/bitrix/bitrix-retry.service');

const candidate = { id: 1, referenceNumber: 'REQ-1001', bitrixSyncAttempts: 1, user: {}, case: null };

beforeEach(() => {
  process.env.BITRIX_SYNC_ENABLED = 'true';
  prisma.serviceRequest.findMany.mockResolvedValue([candidate]);
  prisma.case.findMany.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); delete process.env.BITRIX_SYNC_ENABLED; });

describe('Lead retry and the shared gateway', () => {
  test('a call the gateway refused is NOT counted as a failed attempt, and nothing is written', async () => {
    createLead.mockRejectedValue(Object.assign(new Error('Bitrix24 crm.lead.add deferred by the shared gateway (circuit_open); nothing was sent'), { deferred: true, code: 'gate_closed' }));
    await retryFailedBitrixSyncs();
    expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/deferred by the shared gateway/));
  });

  test('a genuine failure still counts: one more attempt is recorded, exactly as before', async () => {
    createLead.mockRejectedValue(new Error('Bitrix24 crm.lead.add failed (HTTP 400)'));
    await retryFailedBitrixSyncs();
    expect(prisma.serviceRequest.update).toHaveBeenCalledTimes(1);
    expect(prisma.serviceRequest.update.mock.calls[0][0].data).toMatchObject({ bitrixSyncAttempts: 2 });
  });
});
