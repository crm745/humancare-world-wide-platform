/* global describe, test, expect, jest */
// scripts/e2e-restore-document-2663.js: the guards of the phased restoration of `_Test (1).pdf` to Deal 21760. Pure functions with a FAKE
// fetch, a FAKE Bitrix client and a FAKE store: no database, no network, nothing is executed against a real service.
const crypto = require('crypto');
const {
  parseArgs, makeFetchGuard, makeGuardedApi, makeScopedStore, documentProblems, phaseProblems, TARGET,
} = require('../../scripts/e2e-restore-document-2663');

const BASE = `https://${TARGET.portalHost}/rest/1/secret/`;
const send = (guard, method, body, url = `${BASE}${method}.json`) => guard.guardedFetch(url, { method: 'POST', body: JSON.stringify(body) });
const okFetch = () => jest.fn(async () => ({ ok: true }));
const GET = { entityTypeId: 2, id: 21760, useOriginalUfNames: 'Y' };
const UPDATE = (list) => ({ entityTypeId: 2, id: 21760, useOriginalUfNames: 'N', fields: { ufCrm_1794832401: list } });
const GOOD_LIST = [{ id: 65616 }, ['HC-D2663G3-ac925426___Test _1_.pdf', 'JVBERi0=']];

describe('command line', () => {
  test('a phase is required; read-only phases refuse --execute; writing phases are dry runs unless --execute AND --confirm CASE-3206', () => {
    expect(() => parseArgs([])).toThrow(/--phase must be one of/);
    expect(() => parseArgs(['--phase', 'everything'])).toThrow(/--phase must be one of/);
    expect(parseArgs(['--phase', 'revalidate'])).toEqual({ phase: 'revalidate', execute: false, confirmed: false });
    expect(parseArgs(['--phase', 'attach'])).toEqual({ phase: 'attach', execute: false, confirmed: false });
    expect(parseArgs(['--phase', 'attach', '--execute', '--confirm', 'CASE-3206'])).toEqual({ phase: 'attach', execute: true, confirmed: true });
    expect(() => parseArgs(['--phase', 'attach', '--execute'])).toThrow(/--confirm/);
    expect(() => parseArgs(['--phase', 'attach', '--confirm', 'CASE-3206'])).toThrow(/only applies/);
    expect(() => parseArgs(['--phase', 'attach', '--execute', '--confirm', 'CASE-3205'])).toThrow(/CASE-3206/);
    expect(() => parseArgs(['--phase', 'verify', '--execute', '--confirm', 'CASE-3206'])).toThrow(/read-only/);
    expect(() => parseArgs(['--phase', 'revalidate', '--execute', '--confirm', 'CASE-3206'])).toThrow(/read-only/);
    expect(() => parseArgs(['--phase', 'attach', '--live'])).toThrow(/unknown argument/);
  });
});

describe('HTTP guard', () => {
  test('reads of Deal 21760 are allowed up to the limit; an update is refused outside the attach phase', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: false });
    for (let i = 0; i < 3; i += 1) await send(guard, 'crm.item.get', GET);
    await expect(send(guard, 'crm.item.get', GET)).rejects.toThrow(/too many/);
    await expect(send(guard, 'crm.item.update', UPDATE(GOOD_LIST))).rejects.toThrow(/not allowed in this phase/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('the attach phase allows EXACTLY ONE update: numeric 65616 kept, one [name, base64] pair, only the Documents field', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await send(guard, 'crm.item.get', GET);
    await send(guard, 'crm.item.update', UPDATE(GOOD_LIST));
    await expect(send(guard, 'crm.item.update', UPDATE(GOOD_LIST))).rejects.toThrow(/only one crm.item.update/);
    expect(guard.state).toMatchObject({ reads: 1, updates: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['a string id for the retained file', [{ id: '65616' }, ['n.pdf', 'JVBER']]],
    ['the retained file dropped', [['n.pdf', 'JVBER']]],
    ['another retained id', [{ id: 65608 }, ['n.pdf', 'JVBER']]],
    ['a third entry', [{ id: 65616 }, { id: 5 }, ['n.pdf', 'JVBER']]],
    ['the new file as { fileData }', [{ id: 65616 }, { fileData: ['n.pdf', 'JVBER'] }]],
    ['a pair with an empty part', [{ id: 65616 }, ['n.pdf', '']]],
    ['a retained entry with extra keys', [{ id: 65616, url: 'x' }, ['n.pdf', 'JVBER']]],
    ['an empty list', []],
  ])('refuses an update with %s before anything is sent', async (_name, list) => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await expect(send(guard, 'crm.item.update', UPDATE(list))).rejects.toThrow(/must keep/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('another host, entity type, Deal (or a string Deal id), field, method or verb is refused', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await expect(send(guard, 'crm.item.get', GET, 'https://other.bitrix24.in/rest/1/x/crm.item.get.json')).rejects.toThrow(/host/);
    await expect(send(guard, 'crm.item.get', { ...GET, entityTypeId: 3 })).rejects.toThrow(/entityTypeId 2/);
    await expect(send(guard, 'crm.item.get', { ...GET, id: 21761 })).rejects.toThrow(/21760/);
    await expect(send(guard, 'crm.item.get', { ...GET, id: '21760' })).rejects.toThrow(/numeric/);
    await expect(send(guard, 'crm.item.update', { ...UPDATE(GOOD_LIST), fields: { TITLE: 'x' } })).rejects.toThrow(/Documents field/);
    await expect(send(guard, 'crm.item.update', { ...UPDATE(GOOD_LIST), fields: { ufCrm_1794832401: GOOD_LIST, TITLE: 'x' } })).rejects.toThrow(/Documents field/);
    for (const method of ['crm.deal.update', 'crm.deal.get', 'crm.item.add', 'crm.item.delete', 'crm.deal.add']) await expect(send(guard, method, GET)).rejects.toThrow(/only crm.item.get and crm.item.update/);
    await expect(guard.guardedFetch(`${BASE}crm.item.get.json`, { method: 'GET', body: '{}' })).rejects.toThrow(/POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the Bitrix surface the worker sees', () => {
  const bytes = Buffer.from('original pdf bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const NAME = 'HC-D2663G3-ac925426___Test _1_.pdf';
  const realApi = (...reads) => {
    const getDealFiles = jest.fn();
    for (const r of reads) getDealFiles.mockResolvedValueOnce(r);
    return { BitrixDealCallError: Error, getDealFiles, updateDealFiles: jest.fn(async () => ({ ok: true })) };
  };
  const guard = () => makeFetchGuard(okFetch(), { allowUpdate: true });
  const make = (real, over = {}) => makeGuardedApi(real, {}, guard(), { firstReadMustBe: ['65616'], allowUpdate: true, expectedName: NAME, expectedSha256: sha, ...over });
  const entries = [{ id: '65616' }, { fileData: [NAME, bytes.toString('base64')] }];

  test('the FIRST read must be exactly [65616] (anything else stops before any update); later reads are returned for the worker to judge', async () => {
    for (const bad of [{ status: 'ok', ids: [] }, { status: 'ok', ids: ['65616', '1'] }, { status: 'ok', ids: ['65608'] }, { status: 'uncertain', reason: 'timeout' }]) {
      await expect(make(realApi(bad)).getDealFiles('21760')).rejects.toThrow(/not exactly \[65616\]/);
    }
    const api = make(realApi({ status: 'ok', ids: ['65616'] }, { status: 'ok', ids: ['65616', '70001'] }, { status: 'ok', ids: ['70001'] }));
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['65616'] });
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['65616', '70001'] });
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['70001'] }); // a vanished file is NOT thrown away: the worker sends it to manual review
  });

  test('only Deal 21760 can be read or updated', async () => {
    const api = make(realApi({ status: 'ok', ids: ['65616'] }));
    await expect(api.getDealFiles('21761')).rejects.toThrow(/21760/);
    await expect(api.updateDealFiles('21761', entries)).rejects.toThrow(/Only a non-empty list for Deal 21760/);
  });

  test('the update must keep 65616 and add exactly one file with this share\'s name and the document\'s bytes', async () => {
    const real = realApi();
    const api = make(real);
    await api.updateDealFiles('21760', entries);
    expect(real.updateDealFiles).toHaveBeenCalledTimes(1);
    expect(real.updateDealFiles.mock.calls[0][1]).toEqual(entries);
    const refused = async (list, re) => { await expect(make(realApi()).updateDealFiles('21760', list)).rejects.toThrow(re); };
    await refused([{ fileData: [NAME, bytes.toString('base64')] }], /keep file 65616/);
    await refused([{ id: '65616' }, { id: '5' }], /keep file 65616/);
    await refused([{ id: '65608' }, entries[1]], /keep file 65616/);
    await refused([entries[0], { fileData: ['other.pdf', bytes.toString('base64')] }], /file name/);
    await refused([entries[0], { fileData: [NAME, Buffer.from('tampered').toString('base64')] }], /checksum/);
    await refused([entries[0], entries[1], { fileData: ['x.pdf', 'JVBER'] }], /keep file 65616/);
  });

  test('no update at all when the phase does not allow it, and an empty list is never sent', async () => {
    const real = realApi();
    await expect(make(real, { allowUpdate: false }).updateDealFiles('21760', entries)).rejects.toThrow(/No Bitrix update is allowed/);
    await expect(make(real).updateDealFiles('21760', [], { allowEmpty: true })).rejects.toThrow(/Only a non-empty list/);
    expect(real.updateDealFiles).not.toHaveBeenCalled();
  });

  test('every other Bitrix method refuses', async () => {
    const api = make(realApi());
    for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) await expect(api[method]()).rejects.toThrow(/disabled/);
  });
});

describe('scoped store', () => {
  const real = { findCandidateIds: jest.fn(), claim: jest.fn(async () => ({ id: 77 })), markExternalCallStarted: jest.fn(async () => true) };
  test('only the named event can be offered or claimed', async () => {
    const store = makeScopedStore(real, 77, { allowCallEvidence: true });
    real.findCandidateIds.mockResolvedValueOnce([]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).resolves.toEqual([]);
    real.findCandidateIds.mockResolvedValueOnce([77]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).resolves.toEqual([77]);
    real.findCandidateIds.mockResolvedValueOnce([77, 78]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).rejects.toThrow(/not only event 77/);
    await expect(store.claim({}, { id: 416 })).rejects.toThrow(/Refusing to claim event 416/);
    await expect(store.claim({}, { id: 77 })).resolves.toEqual({ id: 77 });
  });
  test('the revoke pass can never start an external call; the attach pass can (the evidence is required)', async () => {
    await expect(makeScopedStore(real, 77, { allowCallEvidence: false }).markExternalCallStarted()).rejects.toThrow(/No external call/);
    await expect(makeScopedStore(real, 77, { allowCallEvidence: true }).markExternalCallStarted()).resolves.toBe(true);
  });
});

describe('state each phase needs (pure)', () => {
  const doc = (over = {}) => ({ serviceRequestId: 3845, originalName: '_Test (1).pdf', documentRequestId: 1, caseDocumentId: 707, scanStatus: 'clean', reviewStatus: 'approved', supersededAt: null, sha256: 'abc', ...over });
  const share = (over = {}) => ({ id: 3, dealLinkId: 363, requestDocumentId: 2663, generation: 2, status: 'attached', bitrixFileId: '65608', tryCount: 1, attempts: 0, fileIdsBefore: [], shareToken: 'HC-D2663G2-ac925426', sha256: 'abc', ...over });
  const s4 = (over = {}) => ({ id: 4, dealLinkId: 363, requestDocumentId: 2662, generation: 1, status: 'attached', bitrixFileId: '65616', ...over });
  const base = (over = {}) => ({
    c: { id: 2206, reference_number: 'CASE-3206', service_request_id: 3845, service_key: 'privatecharter', review_status: 'approved', bitrix_deal_id: '21760', file_locked_until: null },
    doc: doc(), admin: [{ id: 820 }], shares: [share({ id: 2, generation: 1, status: 'revoked', bitrixFileId: null }), share(), s4()], events: [{ id: 420, status: 'completed' }], ...over,
  });

  test('the starting state (share 3 attached as 65608, share 4 as 65616) is valid for revalidate and revoke, nothing else', () => {
    expect(phaseProblems('revalidate', base())).toEqual([]);
    expect(phaseProblems('revoke', base())).toEqual([]);
    expect(phaseProblems('authorize', base()).join()).toMatch(/not revoked yet/);
    expect(phaseProblems('attach', base()).join()).toMatch(/no generation 3 share/);
  });

  test('revalidate/revoke stop on a changed document, a different stale share, a missing preserved share, an open event or a newer generation', () => {
    expect(phaseProblems('revoke', base({ doc: doc({ scanStatus: 'pending' }) })).join()).toMatch(/not clean/);
    expect(phaseProblems('revoke', base({ doc: doc({ reviewStatus: 'rejected' }) })).join()).toMatch(/not approved/);
    expect(phaseProblems('revoke', base({ doc: doc({ supersededAt: new Date() }) })).join()).toMatch(/replaced/);
    expect(phaseProblems('revoke', base({ shares: [share({ bitrixFileId: '1' }), s4()] })).join()).toMatch(/stale file 65608/);
    expect(phaseProblems('revoke', base({ shares: [share(), s4({ status: 'revoked' })] })).join()).toMatch(/share 4 is not attached as file 65616/);
    expect(phaseProblems('revoke', base({ events: [{ id: 421, status: 'pending' }] })).join()).toMatch(/open events/);
    expect(phaseProblems('revoke', base({ shares: [share(), s4(), share({ id: 5, generation: 3, status: 'authorized' })] })).join()).toMatch(/newer generation/);
    expect(phaseProblems('revoke', base({ admin: [] })).join()).toMatch(/Admin 820 not found or not active/);
  });

  test('authorize needs share 3 revoked and no active or revoking share of the document', () => {
    const revoked = base({ shares: [share({ status: 'revoked' }), s4()] });
    expect(phaseProblems('authorize', revoked)).toEqual([]);
    expect(phaseProblems('authorize', base({ shares: [share({ status: 'revoking' }), s4()] })).join()).toMatch(/not revoked yet|still has an active or revoking/);
  });

  test('attach needs exactly the new generation-3 share (token, never sent) and its one clean pending attach event', () => {
    const fresh = (over = {}) => share({ id: 5, generation: 3, status: 'authorized', bitrixFileId: null, fileIdsBefore: null, shareToken: 'HC-D2663G3-ac925426', ...over });
    const ready = (over = {}) => base({
      shares: [share({ status: 'revoked' }), s4(), fresh()],
      events: [{ id: 420, status: 'completed' }, { id: 422, event_type: 'bitrix.deal.document.attach', entity_id: '5:attach:1', status: 'pending', attempts: 0, external_call_started_at: null, locked_until: null }], ...over,
    });
    expect(phaseProblems('attach', ready())).toEqual([]);
    expect(phaseProblems('attach', ready({ shares: [share({ status: 'revoked' }), s4(), fresh({ shareToken: 'HC-D2663G3-deadbeef' })] })).join()).toMatch(/no generation 3 share with token/);
    expect(phaseProblems('attach', ready({ shares: [share({ status: 'revoked' }), s4(), fresh({ tryCount: 2 })] })).join()).toMatch(/not a fresh/);
    expect(phaseProblems('attach', ready({ shares: [share({ status: 'revoked' }), s4(), fresh({ fileIdsBefore: ['65616'] })] })).join()).toMatch(/not a fresh/);
    expect(phaseProblems('attach', ready({ events: [{ id: 420, status: 'completed' }, { id: 422, event_type: 'bitrix.deal.document.attach', entity_id: '5:attach:1', status: 'ambiguous', attempts: 1, external_call_started_at: new Date(), locked_until: null }] })).join()).toMatch(/clean pending attach event/);
    expect(phaseProblems('attach', ready({ events: [{ id: 420, status: 'completed' }] })).join()).toMatch(/clean pending attach event|open events/);
    expect(phaseProblems('attach', ready({ shares: [share({ status: 'attached' }), s4(), fresh()] })).join()).toMatch(/share 3 is not revoked/);
  });

  test('document checks: clean, approved, current, the right file, the right checksum', () => {
    expect(documentProblems(doc(), 'abc')).toEqual([]);
    expect(documentProblems(doc(), 'zzz').join()).toMatch(/checksum differs/);
    expect(documentProblems(doc({ originalName: 'test-sample (1).pdf' })).join()).toMatch(/is not "_Test \(1\)\.pdf"/);
    expect(documentProblems(doc({ caseDocumentId: 706 })).join()).toMatch(/link changed/);
    expect(documentProblems(null)).toEqual(['document 2663 not found']);
  });
});
