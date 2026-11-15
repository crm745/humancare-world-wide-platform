/* global describe, test, expect, beforeEach, afterEach, jest */
// Corporate Case creation and its Lead, with the Private Charter Deal switch on and off. No database, no network.
jest.mock('../../src/db/prisma', () => ({
  prisma: { case: { create: jest.fn(), update: jest.fn() }, caseStageEvent: { create: jest.fn() } },
}));
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn() }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const { prisma } = require('../../src/db/prisma');
const { createLead } = require('../../src/modules/bitrix/bitrix.service');
const { createCaseByCorporate } = require('../../src/modules/cases/cases.service');

const DATA = { patientName: 'Corporate Patient', serviceType: 'Ground Ambulance (GA)', origin: 'Pune', destination: 'Mumbai', urgency: 'urgent', description: 'x' };
const setEnv = (values) => { for (const key of ['BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED', 'PRIVATE_CHARTER_REVIEW_WORKFLOW']) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } };

beforeEach(() => {
  prisma.case.create.mockResolvedValue({ id: 31 });
  prisma.case.update.mockImplementation(async ({ data }) => ({ id: 31, corporateId: 9, serviceRequestId: null, patientName: 'Corporate Patient', serviceType: 'Ground Ambulance (GA)', origin: 'Pune', destination: 'Mumbai', urgency: 'urgent', description: 'x', ...data }));
  prisma.caseStageEvent.create.mockResolvedValue({});
  createLead.mockResolvedValue(4242);
});

afterEach(() => {
  jest.clearAllMocks();
  setEnv({});
});

describe.each([
  ['Deal switch off', { BITRIX_SYNC_ENABLED: 'true' }],
  ['Deal switch on', { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }],
])('a Corporate Case (%s)', (_label, env) => {
  test('is created and gets its Lead exactly as before', async () => {
    setEnv(env);
    await createCaseByCorporate(9, DATA);
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(prisma.case.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { bitrixLeadId: 4242 } }));
  });

  test('carries no Private Charter fields and no service request', async () => {
    setEnv(env);
    await createCaseByCorporate(9, DATA);
    const data = prisma.case.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ corporateId: 9, status: 'submitted' });
    expect(data).not.toHaveProperty('serviceRequestId');
    expect(data).not.toHaveProperty('charterStage');
    expect(data).not.toHaveProperty('stageVersion');
  });

  test('a failed Lead is recorded for the retry sweep, as before (no Bitrix error reaches the caller)', async () => {
    setEnv(env);
    createLead.mockRejectedValue(new Error('Bitrix24 is down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createCaseByCorporate(9, DATA)).resolves.toMatchObject({ id: 31 });
    quiet.mockRestore();
    const last = prisma.case.update.mock.calls.at(-1)[0];
    expect(last.data).toMatchObject({ bitrixSyncAttempts: 1, bitrixLastError: 'Bitrix24 is down' });
    expect(last.data.bitrixSyncFailedAt).toBeInstanceOf(Date);
  });
});

test('with the master switch off, a Corporate Case is created and nothing is sent', async () => {
  setEnv({});
  await createCaseByCorporate(9, DATA);
  expect(createLead).not.toHaveBeenCalled();
});
