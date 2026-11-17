/* global describe, test, expect, jest */
// scripts/e2e-document-reconcile-sample.js: the guards of the one-shot reconciliation of share 4 / event 420. Pure functions with a FAKE
// fetch, a FAKE Bitrix client and a FAKE store: no database, no network, nothing is executed against a real service.
const {
  parseArgs, makeFetchGuard, readExpectedDealFiles, makeGuardedApi, makeScopedStore, eventProblems, shareProblems, documentProblems, TARGET, CONFIRMED_FILE_IDS,
} = require('../../scripts/e2e-document-reconcile-sample');

const URL_BASE = `https://${TARGET.portalHost}/rest/1/secret/`;
const post = (guard, method, body, url = `${URL_BASE}${method}.json`) => guard.guardedFetch(url, { method: 'POST', body: JSON.stringify(body) });
const okFetch = () => jest.fn(async () => ({ ok: true }));

describe('fixed target', () => {
  test('is event 420 / share 4 / document 2662 on Deal 21760, confirmed file 65616', () => {
    expect(TARGET).toMatchObject({
      caseId: 2206, requestId: 3845, documentId: 2662, shareId: 4, eventId: 420, dealId: '21760', portalHost: 'b24-4orefh.bitrix24.in',
      confirmedFileId: '65616', recordedFileIdsBefore: ['65608'], otherShareId: 3, otherEventId: 419, maxReads: 1,
    });
  });
});

describe('the confirmation of a person', () => {
  test('names exactly file 65616 for exactly share 4, and nothing else', () => {
    expect(CONFIRMED_FILE_IDS).toEqual({ 4: '65616' });
    expect(Object.isFrozen(CONFIRMED_FILE_IDS)).toBe(true);
  });
});

describe('command line', () => {
  test('dry run by default; execution needs both --execute and --confirm CASE-3206', () => {
    expect(parseArgs([])).toEqual({ execute: false, confirmed: false });
    expect(parseArgs(['--execute', '--confirm', 'CASE-3206'])).toEqual({ execute: true, confirmed: true });
    expect(() => parseArgs(['--execute'])).toThrow(/--confirm/);
    expect(() => parseArgs(['--confirm', 'CASE-3206'])).toThrow(/only applies/);
    expect(() => parseArgs(['--execute', '--confirm', 'CASE-3205'])).toThrow(/CASE-3206/);
    expect(() => parseArgs(['--live'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--case-ids', '1'])).toThrow(/unknown argument/);
  });
});

describe('HTTP guard: one crm.deal.get, nothing else', () => {
  test('exactly one read of Deal 21760 goes out', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch);
    await post(guard, 'crm.deal.get', { id: '21760' });
    await expect(post(guard, 'crm.deal.get', { id: '21760' })).rejects.toThrow(/only one crm.deal.get/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(guard.state.reads).toBe(1);
  });

  test('an update, an add, another Deal, another host or a GET is refused before anything is sent', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch);
    await expect(post(guard, 'crm.deal.update', { id: '21760', fields: { [TARGET.fileField]: [] } })).rejects.toThrow(/only crm.deal.get/);
    await expect(post(guard, 'crm.deal.add', { fields: {} })).rejects.toThrow(/only crm.deal.get/);
    await expect(post(guard, 'crm.deal.list', { id: '21760' })).rejects.toThrow(/only crm.deal.get/);
    await expect(post(guard, 'crm.deal.get', { id: '21761' })).rejects.toThrow(/21760/);
    await expect(post(guard, 'crm.deal.get', { id: '21760' }, 'https://other.bitrix24.in/rest/1/x/crm.deal.get.json')).rejects.toThrow(/host/);
    await expect(guard.guardedFetch(`${URL_BASE}crm.deal.get.json`, { method: 'GET', body: '{}' })).rejects.toThrow(/POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the verified read', () => {
  const deal = (files, over = {}) => ({ ID: '21760', CATEGORY_ID: '38', [TARGET.referenceField]: 'CASE-3206', [TARGET.fileField]: files, ...over });
  const realApi = (d, status = 'ok') => ({
    BitrixDealCallError: Error,
    getDeal: jest.fn(async () => (status === 'ok' ? { status, deal: d } : { status, reason: 'boom' })),
    fileIdsOf: jest.requireActual('../../src/modules/bitrix/bitrix-deal.api').fileIdsOf,
  });

  test('exactly [65616] on the right Deal passes', async () => {
    await expect(readExpectedDealFiles(realApi(deal([{ id: 65616, downloadUrl: 'x' }])), {}, () => {})).resolves.toEqual({ status: 'ok', ids: ['65616'] });
  });

  test('any other file list, a wrong Deal, category or reference, or an unreadable answer stops the run', async () => {
    for (const files of [[], false, [{ id: '65608' }], [{ id: '65616' }, { id: '65608' }], [{ id: '65616' }, { id: '65617' }], [{ id: '65617' }]]) {
      await expect(readExpectedDealFiles(realApi(deal(files)), {}, () => {})).rejects.toThrow(/expected exactly \[65616\]/);
    }
    await expect(readExpectedDealFiles(realApi(deal([{ id: '65616' }], { ID: '1' })), {}, () => {})).rejects.toThrow(/another Deal/);
    await expect(readExpectedDealFiles(realApi(deal([{ id: '65616' }], { CATEGORY_ID: '2' })), {}, () => {})).rejects.toThrow(/category/);
    await expect(readExpectedDealFiles(realApi(deal([{ id: '65616' }], { [TARGET.referenceField]: 'CASE-3205' })), {}, () => {})).rejects.toThrow(/Case reference/);
    await expect(readExpectedDealFiles(realApi(deal('oops')), {}, () => {})).rejects.toThrow(/unexpected shape/);
    await expect(readExpectedDealFiles(realApi(null, 'uncertain'), {}, () => {})).rejects.toThrow(/could not be read/);
  });
});

describe('guarded API for the worker', () => {
  const real = { BitrixDealCallError: Error };
  test('answers the worker\'s read from the verified read, with no further request', async () => {
    const api = makeGuardedApi(real, { status: 'ok', ids: ['65616'] });
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['65616'] });
    expect(api.state.reads).toBe(1);
    await expect(api.getDealFiles('21761')).rejects.toThrow(/21760/);
  });

  test('every update / upload / create / lookup method refuses', async () => {
    const api = makeGuardedApi(real, { status: 'ok', ids: ['65616'] });
    for (const method of ['updateDealFiles', 'createDeal', 'findDealsByReference', 'getDeal']) await expect(api[method]()).rejects.toThrow(/disabled/);
    expect(api.state.refused).toEqual(['updateDealFiles', 'createDeal', 'findDealsByReference', 'getDeal']);
  });
});

describe('scoped store', () => {
  const real = {
    ATTACH_EVENT: 'a', findCandidateIds: jest.fn(), claim: jest.fn(async () => ({ id: 420 })), markExternalCallStarted: jest.fn(), writeResult: jest.fn(),
  };
  test('the candidate query may return nothing or exactly [420]; anything else stops before a claim', async () => {
    const store = makeScopedStore(real);
    real.findCandidateIds.mockResolvedValueOnce([]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).resolves.toEqual([]);
    real.findCandidateIds.mockResolvedValueOnce([420]);
    await expect(store.findCandidateIds({}, 'ambiguous', 5, {})).resolves.toEqual([420]);
    real.findCandidateIds.mockResolvedValueOnce([419]);
    await expect(store.findCandidateIds({}, 'ambiguous', 5, {})).rejects.toThrow(/not only event 420/);
    real.findCandidateIds.mockResolvedValueOnce([420, 421]);
    await expect(store.findCandidateIds({}, 'ambiguous', 5, {})).rejects.toThrow(/not only event 420/);
  });

  test('only event 420 can be claimed, and no external call can be started', async () => {
    const store = makeScopedStore(real);
    await expect(store.claim({}, { id: 419 })).rejects.toThrow(/Refusing to claim event 419/);
    await expect(store.claim({}, { id: 416 })).rejects.toThrow(/Refusing/);
    await expect(store.claim({}, { id: 420 })).resolves.toEqual({ id: 420 });
    await expect(store.markExternalCallStarted()).rejects.toThrow(/No external call/);
    expect(real.markExternalCallStarted).not.toHaveBeenCalled();
  });

  test('the other store members are the real ones', () => {
    expect(makeScopedStore(real).writeResult).toBe(real.writeResult);
    expect(makeScopedStore(real).ATTACH_EVENT).toBe('a');
  });
});

describe('state pre-flight (pure)', () => {
  const event = (over = {}) => ({ id: 420, event_type: 'bitrix.deal.document.attach', entity_id: '4:attach:1', status: 'processing', attempts: 1, external_call_started_at: new Date(), ...over });
  const share4 = (over = {}) => ({ id: 4, status: 'attaching', bitrixFileId: null, fileIdsBefore: ['65608'], requestDocumentId: 2662, generation: 1, shareToken: 'HC-D2662G1-abce4555', tryCount: 1, ...over });
  const share3 = (over = {}) => ({ id: 3, status: 'attached', bitrixFileId: '65608', requestDocumentId: 2663, ...over });

  test('event 420: processing with an expired lease and the call started passes', () => {
    expect(eventProblems(event(), { leaseExpired: true })).toEqual([]);
  });
  test('a live lease, another status, no call evidence, other attempts or another event each fail', () => {
    expect(eventProblems(event(), { leaseExpired: false }).join()).toMatch(/not expired/);
    expect(eventProblems(event({ status: 'ambiguous' }), { leaseExpired: true }).join()).toMatch(/not "processing"/);
    expect(eventProblems(event({ status: 'pending' }), { leaseExpired: true }).join()).toMatch(/not "processing"/);
    expect(eventProblems(event({ external_call_started_at: null }), { leaseExpired: true }).join()).toMatch(/external_call_started_at/);
    expect(eventProblems(event({ attempts: 2 }), { leaseExpired: true }).join()).toMatch(/2 attempts/);
    expect(eventProblems(event({ entity_id: '3:attach:1' }), { leaseExpired: true }).join()).toMatch(/not the attach event of share 4/);
    expect(eventProblems(undefined, { leaseExpired: true }).join()).toMatch(/not the attach event/);
  });

  test('shares: share 4 attaching with file_ids_before exactly ["65608"], share 3 still on 65608', () => {
    expect(shareProblems(share4(), share3())).toEqual([]);
  });
  test('a recorded file id, another status or list, or a changed share 3 each fail', () => {
    expect(shareProblems(share4({ bitrixFileId: '65616' }), share3()).join()).toMatch(/already has a Bitrix file id/);
    expect(shareProblems(share4({ status: 'attached' }), share3()).join()).toMatch(/not "attaching"/);
    expect(shareProblems(share4({ fileIdsBefore: [] }), share3()).join()).toMatch(/file_ids_before/);
    expect(shareProblems(share4({ fileIdsBefore: null }), share3()).join()).toMatch(/file_ids_before/);
    expect(shareProblems(share4({ fileIdsBefore: ['65608', '1'] }), share3()).join()).toMatch(/file_ids_before/);
    expect(shareProblems(share4({ generation: 2 }), share3()).join()).toMatch(/not generation 1/);
    expect(shareProblems(share4(), share3({ bitrixFileId: null })).join()).toMatch(/share 3 no longer references/);
    expect(shareProblems(share4(), share3({ status: 'revoking' })).join()).toMatch(/share 3 is "revoking"/);
    expect(shareProblems(null, share3()).join()).toMatch(/share 4 not found/);
  });

  test('document: clean, approved, current, checksum equal to share 4', () => {
    const doc = (over = {}) => ({ serviceRequestId: 3845, originalName: 'test-sample (1).pdf', documentRequestId: null, caseDocumentId: 706, scanStatus: 'clean', reviewStatus: 'approved', supersededAt: null, sha256: 'abc', ...over });
    const share = { sha256: 'abc' };
    expect(documentProblems(doc(), share)).toEqual([]);
    expect(documentProblems(doc({ scanStatus: 'pending' }), share).join()).toMatch(/not clean/);
    expect(documentProblems(doc({ reviewStatus: 'rejected' }), share).join()).toMatch(/not approved/);
    expect(documentProblems(doc({ supersededAt: new Date() }), share).join()).toMatch(/replaced/);
    expect(documentProblems(doc({ sha256: 'zzz' }), share).join()).toMatch(/checksum differs/);
    expect(documentProblems(doc({ originalName: '_Test (1).pdf' }), share).join()).toMatch(/is not "test-sample/);
    expect(documentProblems(null, share)).toEqual(['document 2662 not found']);
  });
});
