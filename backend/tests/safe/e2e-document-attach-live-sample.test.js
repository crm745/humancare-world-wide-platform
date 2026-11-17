/* global describe, test, expect, jest */
// scripts/e2e-document-attach-live-sample.js: the guards of the one-shot live attachment of "test-sample (1).pdf". Pure functions with
// a FAKE fetch and a FAKE Bitrix client: no database, no network, nothing is executed against a real service.
const crypto = require('crypto');
const {
  parseArgs, makeFetchGuard, makeGuardedApi, readVerifiedDealFiles, documentProblems, otherAttachmentProblems, TARGET, main, } = require('../../scripts/e2e-document-attach-live-sample');

const URL_BASE = `https://${TARGET.portalHost}/rest/1/secret/`;
const post = (guard, method, body, url = `${URL_BASE}${method}.json`) => guard.guardedFetch(url, { method: 'POST', body: JSON.stringify(body) });
const okFetch = () => jest.fn(async () => ({ ok: true }));

describe('fixed target', () => {
  test('is document 2662 / share 4 / event 420 on Deal 21760, and keeps file 65608', () => {
    expect(TARGET).toMatchObject({
      caseId: 2206, requestId: 3845, documentId: 2662, shareId: 4, generation: 1, eventId: 420, dealId: '21760',
      fileField: 'UF_CRM_1794832401', portalHost: 'b24-4orefh.bitrix24.in', preservedFileId: '65608',
    });
    // Independent of the 2663 script: no shared ids.
    expect([TARGET.documentId, TARGET.shareId, TARGET.eventId]).not.toContain(2663);
    expect([TARGET.shareId, TARGET.eventId]).not.toContain(TARGET.otherShareId);
    expect(TARGET.eventId).not.toBe(TARGET.otherEventId);
  });
});

describe('command line', () => {
  test('dry run by default; execution needs both --execute and --confirm CASE-3206', () => {
    expect(parseArgs([])).toEqual({ execute: false, confirmed: false });
    expect(parseArgs(['--execute', '--confirm', 'CASE-3206'])).toEqual({ execute: true, confirmed: true });
    expect(() => parseArgs(['--execute'])).toThrow(/--confirm/);
    expect(() => parseArgs(['--confirm', 'CASE-3206'])).toThrow(/only applies/);
    expect(() => parseArgs(['--execute', '--confirm', 'CASE-3205'])).toThrow(/CASE-3206/);
    expect(() => parseArgs(['--case-ids', '1'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--live'])).toThrow(/unknown argument/);
  });
});

describe('HTTP guard', () => {
  test('the dry run allows ONE crm.deal.get and never a crm.deal.update', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: false, maxReads: 1 });
    await post(guard, 'crm.deal.get', { id: '21760' });
    await expect(post(guard, 'crm.deal.get', { id: '21760' })).rejects.toThrow(/too many/);
    await expect(post(guard, 'crm.deal.update', { id: '21760', fields: { [TARGET.fileField]: [] } })).rejects.toThrow(/not allowed in this mode/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('execution allows at most 3 reads and exactly one update, only on Deal 21760 and only the file field', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    const update = { id: '21760', fields: { [TARGET.fileField]: [{ id: '65608' }] } };
    await post(guard, 'crm.deal.get', { id: '21760' });
    await post(guard, 'crm.deal.update', update);
    await expect(post(guard, 'crm.deal.update', update)).rejects.toThrow(/only one crm.deal.update/);
    await post(guard, 'crm.deal.get', { id: '21760' });
    await post(guard, 'crm.deal.get', { id: '21760' });
    await expect(post(guard, 'crm.deal.get', { id: '21760' })).rejects.toThrow(/too many/);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(guard.state).toMatchObject({ reads: 3, updates: 1 });
  });

  test('another host, Deal, method, field or verb is refused before anything is sent', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await expect(post(guard, 'crm.deal.get', { id: '21760' }, 'https://other.bitrix24.in/rest/1/x/crm.deal.get.json')).rejects.toThrow(/host/);
    await expect(post(guard, 'crm.deal.get', { id: '21761' })).rejects.toThrow(/21760/);
    await expect(post(guard, 'crm.deal.add', { id: '21760' })).rejects.toThrow(/only crm.deal.get and crm.deal.update/);
    await expect(post(guard, 'crm.deal.update', { id: '21760', fields: { TITLE: 'x' } })).rejects.toThrow(/Documents field/);
    await expect(post(guard, 'crm.deal.update', { id: '21760', fields: { [TARGET.fileField]: [], TITLE: 'x' } })).rejects.toThrow(/Documents field/);
    await expect(guard.guardedFetch(`${URL_BASE}crm.deal.get.json`, { method: 'GET', body: '{}' })).rejects.toThrow(/POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('verified Deal read and guarded update', () => {
  const bytes = Buffer.from('sample pdf bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const goodDeal = (files) => ({ ID: '21760', CATEGORY_ID: '38', [TARGET.referenceField]: 'CASE-3206', [TARGET.fileField]: files });
  const realApi = (deal) => ({
    BitrixDealCallError: Error,
    getDeal: jest.fn(async () => ({ status: 'ok', deal })),
    fileIdsOf: jest.requireActual('../../src/modules/bitrix/bitrix-deal.api').fileIdsOf,
    updateDealFiles: jest.fn(async () => ({ ok: true })),
  });
  const guardFor = () => makeFetchGuard(okFetch(), { allowUpdate: true });
  const name = `${TARGET.shareToken}__test-sample.pdf`;
  const entry = { fileData: [name, bytes.toString('base64')] };

  test('a Deal with another id, category or Case reference is refused', async () => {
    for (const bad of [{ ID: '1' }, { CATEGORY_ID: '2' }, { [TARGET.referenceField]: 'CASE-3205' }]) {
      await expect(readVerifiedDealFiles(realApi({ ...goodDeal([{ id: '65608' }]), ...bad }), {}, () => {})).rejects.toThrow(/Deal check failed/);
    }
  });

  test('the Documents field must hold file 65608; the read returns the ids in order', async () => {
    await expect(readVerifiedDealFiles(realApi(goodDeal([])), {}, () => {})).rejects.toThrow(/does not hold file 65608/);
    await expect(readVerifiedDealFiles(realApi(goodDeal(false)), {}, () => {})).rejects.toThrow(/does not hold file 65608/);
    await expect(readVerifiedDealFiles(realApi(goodDeal([{ id: '7' }])), {}, () => {})).rejects.toThrow(/does not hold file 65608/);
    await expect(readVerifiedDealFiles(realApi(goodDeal([{ id: '7' }, { id: '65608' }])), {}, () => {})).resolves.toEqual({ status: 'ok', ids: ['7', '65608'] });
  });

  test('the update keeps 65608 and every other id, in order, plus exactly one new file with the right bytes', async () => {
    const real = realApi(goodDeal([{ id: '7' }, { id: '65608' }]));
    const api = makeGuardedApi(real, {}, guardFor(), sha);
    await expect(api.updateDealFiles('21760', [{ id: '7' }, { id: '65608' }, entry])).rejects.toThrow(/last read list/); // no read yet
    await api.getDealFiles('21760');
    await api.updateDealFiles('21760', [{ id: '7' }, { id: '65608' }, entry]);
    expect(real.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(real.updateDealFiles.mock.calls[0][1]).toEqual([{ id: '7' }, { id: '65608' }, entry]);
  });

  test('dropping or reordering a file (65608 included), a wrong name or bytes, an empty list or another Deal is refused', async () => {
    const real = realApi(goodDeal([{ id: '7' }, { id: '65608' }]));
    const api = makeGuardedApi(real, {}, guardFor(), sha);
    await api.getDealFiles('21760');
    await expect(api.updateDealFiles('21760', [{ id: '7' }, entry])).rejects.toThrow(/last read list/); // 65608 dropped
    await expect(api.updateDealFiles('21760', [{ id: '7' }, { id: '65609' }, entry])).rejects.toThrow(/kept, in order/);
    await expect(api.updateDealFiles('21760', [{ id: '65608' }, { id: '7' }, entry])).rejects.toThrow(/kept, in order/);
    await expect(api.updateDealFiles('21760', [{ id: '7' }, { id: '65608' }, { fileData: ['other.pdf', bytes.toString('base64')] }])).rejects.toThrow(/file name/);
    await expect(api.updateDealFiles('21760', [{ id: '7' }, { id: '65608' }, { fileData: [`${TARGET.shareToken}__x.png`, bytes.toString('base64')] }])).rejects.toThrow(/file name/);
    await expect(api.updateDealFiles('21760', [{ id: '7' }, { id: '65608' }, { fileData: [name, Buffer.from('tampered').toString('base64')] }])).rejects.toThrow(/checksum/);
    await expect(api.updateDealFiles('21760', [], { allowEmpty: true })).rejects.toThrow(/empty/);
    await expect(api.updateDealFiles('21761', [{ id: '7' }, { id: '65608' }, entry])).rejects.toThrow(/21760/);
    await expect(api.getDealFiles('21761')).rejects.toThrow(/21760/);
    expect(real.updateDealFiles).not.toHaveBeenCalled();
  });

  test('a read that does not show 65608 stops the worker before any update', async () => {
    const real = realApi(goodDeal([{ id: '7' }]));
    const api = makeGuardedApi(real, {}, guardFor(), sha);
    await expect(api.getDealFiles('21760')).rejects.toThrow(/65608/);
    await expect(api.updateDealFiles('21760', [{ id: '7' }, entry])).rejects.toThrow(/last read list/);
    expect(real.updateDealFiles).not.toHaveBeenCalled();
  });

  test('no other Bitrix method is available to the worker', async () => {
    const api = makeGuardedApi(realApi(goodDeal([{ id: '65608' }])), {}, guardFor(), sha);
    for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) await expect(api[method]()).rejects.toThrow(/disabled/);
    expect(api.state.refused).toEqual(['createDeal', 'findDealsByReference', 'getDeal']);
  });
});

describe('document re-verification', () => {
  const share = { sha256: 'abc' };
  const doc = (over = {}) => ({
    serviceRequestId: 3845, originalName: 'test-sample (1).pdf', documentRequestId: null, caseDocumentId: 706, scanStatus: 'clean', reviewStatus: 'approved',
    supersededAt: null, sha256: 'abc', ...over,
  });
  test('a clean, approved, current document with the authorized checksum passes', () => expect(documentProblems(doc(), share)).toEqual([]));
  test('not clean, not approved, replaced, no checksum or a changed checksum each fail', () => {
    expect(documentProblems(doc({ scanStatus: 'pending' }), share).join()).toMatch(/not clean/);
    expect(documentProblems(doc({ reviewStatus: 'rejected' }), share).join()).toMatch(/not approved/);
    expect(documentProblems(doc({ supersededAt: new Date() }), share).join()).toMatch(/replaced/);
    expect(documentProblems(doc({ sha256: null }), share).join()).toMatch(/no checksum/);
    expect(documentProblems(doc({ sha256: 'zzz' }), share).join()).toMatch(/checksum changed/);
    expect(documentProblems(doc({ originalName: '_Test (1).pdf' }), share).join()).toMatch(/is not "test-sample/);
    expect(documentProblems(doc({ caseDocumentId: 707 }), share).join()).toMatch(/link changed/);
    expect(documentProblems(null, share)).toEqual(['document 2662 not found']);
  });
});

describe('the earlier attachment (share 3 / event 419) must be as it is', () => {
  test('attached as file 65608 and completed passes; anything else fails', () => {
    const share3 = { status: 'attached', bitrixFileId: '65608', requestDocumentId: 2663 };
    expect(otherAttachmentProblems(share3, { status: 'completed' })).toEqual([]);
    expect(otherAttachmentProblems({ ...share3, status: 'revoking' }, { status: 'completed' }).join()).toMatch(/not attached/);
    expect(otherAttachmentProblems({ ...share3, bitrixFileId: '1' }, { status: 'completed' }).join()).toMatch(/not attached/);
    expect(otherAttachmentProblems(share3, { status: 'pending' }).join()).toMatch(/not completed/);
    expect(otherAttachmentProblems(null, null)).toHaveLength(2);
  });
});

describe('the script is disabled', () => {
  test('main() stops at once, before touching the environment, the database or Bitrix', async () => {
    await expect(main([])).rejects.toThrow(/DISABLED/);
    await expect(main(['--execute', '--confirm', 'CASE-3206'])).rejects.toThrow(/DISABLED/);
  });
});
