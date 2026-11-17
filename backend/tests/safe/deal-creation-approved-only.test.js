/* global describe, test, expect, jest */
// assertDealCreationAllowed and ensureDealCreation (deal-outbox.js): a Deal is created only for an APPROVED Private
// Charter request, and the link and event are written only when missing. No database, no network.
const { assertDealCreationAllowed, assertDealEligible, ensureDealCreation } = require('../../src/modules/bitrix/deal-outbox');

const caseRecord = { id: 71, serviceRequestId: 61 };
const request = (over = {}) => ({ id: 61, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null, ...over });

describe('assertDealCreationAllowed', () => {
  test('accepts an approved Private Charter request', () => {
    expect(() => assertDealCreationAllowed(caseRecord, request())).not.toThrow();
  });

  test.each(['awaiting_documents', 'in_review', 'changes_requested'])('refuses a %s request, even though it is "eligible" for an existing Deal', (reviewStatus) => {
    expect(() => assertDealCreationAllowed(caseRecord, request({ reviewStatus }))).toThrow(/only approved requests get a Deal/);
    expect(() => assertDealEligible(caseRecord, request({ reviewStatus }))).not.toThrow(); // inbound sync of a linked Deal is unaffected
  });

  test('keeps every existing eligibility rule', () => {
    expect(() => assertDealCreationAllowed(caseRecord, request({ reviewStatus: null }))).toThrow(/before the review workflow/);
    expect(() => assertDealCreationAllowed(caseRecord, request({ serviceKey: 'ground' }))).toThrow(/only Private Charter/);
    expect(() => assertDealCreationAllowed(caseRecord, request({ bitrixLeadId: 5 }))).toThrow(/already has a Bitrix Lead/);
    expect(() => assertDealCreationAllowed({ id: 71, serviceRequestId: null }, request())).toThrow(/Corporate Cases/);
    expect(() => assertDealCreationAllowed(null, request())).toThrow();
  });
});

describe('ensureDealCreation', () => {
  function fakeTx({ link = null, event = null } = {}) {
    return {
      bitrixDealLink: { findUnique: jest.fn(async () => link), create: jest.fn(async ({ data }) => ({ id: 5, bitrixDealId: null, ...data })) },
      integrationOutbox: { findUnique: jest.fn(async () => event), create: jest.fn(async ({ data }) => ({ id: 9, ...data })) },
    };
  }

  test('writes the link and the event when both are missing', async () => {
    const tx = fakeTx();
    const result = await ensureDealCreation(tx, caseRecord, request());
    expect(result).toMatchObject({ linkCreated: true, eventCreated: true });
    expect(tx.bitrixDealLink.create).toHaveBeenCalledWith({ data: { caseId: 71, syncStatus: 'pending' } });
    expect(tx.integrationOutbox.create.mock.calls[0][0].data).toMatchObject({ idempotencyKey: 'bitrix.deal.create:case:71', status: 'pending', caseId: 71 });
  });

  test('writes nothing when both already exist (a repeated call)', async () => {
    const tx = fakeTx({ link: { id: 5, bitrixDealId: null }, event: { id: 9, status: 'pending' } });
    const result = await ensureDealCreation(tx, caseRecord, request());
    expect(result).toMatchObject({ linkCreated: false, eventCreated: false });
    expect(tx.bitrixDealLink.create).not.toHaveBeenCalled();
    expect(tx.integrationOutbox.create).not.toHaveBeenCalled();
  });

  test('never creates an event for a Case whose link already holds a Deal ID', async () => {
    const tx = fakeTx({ link: { id: 5, bitrixDealId: '4340' } });
    const result = await ensureDealCreation(tx, caseRecord, request());
    expect(result.eventCreated).toBe(false);
    expect(tx.integrationOutbox.create).not.toHaveBeenCalled();
  });

  test('never touches an existing event of any status', async () => {
    for (const status of ['failed', 'ambiguous', 'processing', 'completed']) {
      const tx = fakeTx({ link: { id: 5, bitrixDealId: null }, event: { id: 9, status } });
      await ensureDealCreation(tx, caseRecord, request());
      expect(tx.integrationOutbox.create).not.toHaveBeenCalled();
    }
  });

  test('refuses an unapproved request before writing anything', async () => {
    const tx = fakeTx();
    await expect(ensureDealCreation(tx, caseRecord, request({ reviewStatus: 'in_review' }))).rejects.toThrow(/only approved requests/);
    expect(tx.bitrixDealLink.create).not.toHaveBeenCalled();
    expect(tx.integrationOutbox.create).not.toHaveBeenCalled();
  });
});
