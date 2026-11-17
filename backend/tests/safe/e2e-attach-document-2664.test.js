/* global describe, test, expect, jest */
// scripts/e2e-attach-document-2664.js: the guards of the one-shot attachment of the JPEG (document 2664, share 6, event 423) to Deal 21760.
// Pure functions with a FAKE fetch, a FAKE Bitrix client and a FAKE store: no database, no network, no real Bitrix24 call.
const crypto = require('crypto');
const { parseArgs, makeFetchGuard, makeGuardedApi, makeScopedStore, documentProblems, attachProblems, TARGET } = require('../../scripts/e2e-attach-document-2664');

const BASE = `https://${TARGET.portalHost}/rest/1/secret/`;
const send = (guard, method, body, url = `${BASE}${method}.json`) => guard.guardedFetch(url, { method: 'POST', body: JSON.stringify(body) });
const okFetch = () => jest.fn(async () => ({ ok: true }));
const GET = { entityTypeId: 2, id: 21760, useOriginalUfNames: 'Y' };
const UPDATE = (list) => ({ entityTypeId: 2, id: 21760, useOriginalUfNames: 'N', fields: { ufCrm_1794832401: list } });
const PAIR = ['HC-D2664G1-6beaf795__WhatsApp Image 2026-10-29 at 12.03.51 AM.jpg', 'JVBERi0='];
const GOOD = [{ id: 65616 }, { id: 65618 }, PAIR];

describe('fixed target', () => {
  test('is document 2664 / share 6 / event 423 on Deal 21760, keeping 65616 and 65618', () => {
    expect(TARGET).toMatchObject({ documentId: 2664, shareId: 6, generation: 1, eventId: 423, dealId: '21760', preservedFileIds: ['65616', '65618'], portalHost: 'b24-4orefh.bitrix24.in', detectedType: 'jpeg' });
  });
});

describe('command line', () => {
  test('dry run by default; --execute needs --confirm CASE-3206; verify is read-only', () => {
    expect(() => parseArgs([])).toThrow(/--phase must be one of/);
    expect(parseArgs(['--phase', 'attach'])).toEqual({ phase: 'attach', execute: false, confirmed: false });
    expect(parseArgs(['--phase', 'attach', '--execute', '--confirm', 'CASE-3206'])).toEqual({ phase: 'attach', execute: true, confirmed: true });
    expect(() => parseArgs(['--phase', 'attach', '--execute'])).toThrow(/--confirm/);
    expect(() => parseArgs(['--phase', 'attach', '--confirm', 'CASE-3206'])).toThrow(/only applies/);
    expect(() => parseArgs(['--phase', 'attach', '--execute', '--confirm', 'CASE-3205'])).toThrow(/CASE-3206/);
    expect(() => parseArgs(['--phase', 'verify', '--execute', '--confirm', 'CASE-3206'])).toThrow(/read-only/);
    expect(() => parseArgs(['--phase', 'revoke'])).toThrow(/--phase must be one of/);
    expect(() => parseArgs(['--phase', 'attach', '--live'])).toThrow(/unknown argument/);
  });
});

describe('HTTP guard', () => {
  test('dry run: reads only, never an update', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: false });
    await send(guard, 'crm.item.get', GET);
    await expect(send(guard, 'crm.item.update', UPDATE(GOOD))).rejects.toThrow(/not allowed in this phase/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('execution: at most 3 reads and EXACTLY ONE update with both PDFs kept as numeric ids, then one pair', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await send(guard, 'crm.item.get', GET);
    await send(guard, 'crm.item.update', UPDATE(GOOD));
    await expect(send(guard, 'crm.item.update', UPDATE(GOOD))).rejects.toThrow(/only one crm.item.update/);
    await send(guard, 'crm.item.get', GET);
    await send(guard, 'crm.item.get', GET);
    await expect(send(guard, 'crm.item.get', GET)).rejects.toThrow(/too many/);
    expect(guard.state).toMatchObject({ reads: 3, updates: 1 });
  });

  test.each([
    ['either PDF dropped', [{ id: 65616 }, PAIR]],
    ['the other PDF dropped', [{ id: 65618 }, PAIR]],
    ['the PDFs in another order', [{ id: 65618 }, { id: 65616 }, PAIR]],
    ['a string id', [{ id: '65616' }, { id: 65618 }, PAIR]],
    ['the stale id 65608 instead', [{ id: 65616 }, { id: 65608 }, PAIR]],
    ['an extra retained id', [{ id: 65616 }, { id: 65618 }, { id: 70000 }, PAIR]],
    ['the file as { fileData }', [{ id: 65616 }, { id: 65618 }, { fileData: PAIR }]],
    ['two new files', [{ id: 65616 }, { id: 65618 }, PAIR, PAIR]],
    ['a pair with an empty part', [{ id: 65616 }, { id: 65618 }, ['a.jpg', '']]],
    ['an empty list', []],
  ])('refuses an update with %s before anything is sent', async (_name, list) => {
    const fetch = okFetch();
    await expect(send(makeFetchGuard(fetch, { allowUpdate: true }), 'crm.item.update', UPDATE(list))).rejects.toThrow(/must keep/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('another host, entity type, Deal, field, method or verb is refused', async () => {
    const fetch = okFetch();
    const guard = makeFetchGuard(fetch, { allowUpdate: true });
    await expect(send(guard, 'crm.item.get', GET, 'https://other.bitrix24.in/rest/1/x/crm.item.get.json')).rejects.toThrow(/host/);
    await expect(send(guard, 'crm.item.get', { ...GET, entityTypeId: 3 })).rejects.toThrow(/entityTypeId 2/);
    await expect(send(guard, 'crm.item.get', { ...GET, id: 21761 })).rejects.toThrow(/21760/);
    await expect(send(guard, 'crm.item.get', { ...GET, id: '21760' })).rejects.toThrow(/numeric/);
    await expect(send(guard, 'crm.item.update', { ...UPDATE(GOOD), fields: { TITLE: 'x' } })).rejects.toThrow(/Documents field/);
    for (const method of ['crm.deal.update', 'crm.deal.get', 'crm.item.add', 'crm.item.delete', 'crm.deal.add']) await expect(send(guard, method, GET)).rejects.toThrow(/only crm.item.get and crm.item.update/);
    await expect(guard.guardedFetch(`${BASE}crm.item.get.json`, { method: 'GET', body: '{}' })).rejects.toThrow(/POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the Bitrix surface the worker sees', () => {
  const bytes = Buffer.from('jpeg bytes');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const NAME = PAIR[0];
  const realApi = (...reads) => {
    const getDealFiles = jest.fn();
    for (const r of reads) getDealFiles.mockResolvedValueOnce(r);
    return { BitrixDealCallError: Error, getDealFiles, updateDealFiles: jest.fn(async () => ({ ok: true })) };
  };
  const make = (real, over = {}) => makeGuardedApi(real, {}, makeFetchGuard(okFetch(), { allowUpdate: true }), { allowUpdate: true, expectedName: NAME, expectedSha256: sha, ...over });
  const entries = [{ id: '65616' }, { id: '65618' }, { fileData: [NAME, bytes.toString('base64')] }];

  test('the FIRST read must be exactly [65616, 65618]; later reads are returned as they are, for the worker to judge', async () => {
    for (const bad of [{ status: 'ok', ids: [] }, { status: 'ok', ids: ['65616'] }, { status: 'ok', ids: ['65618', '65616'] }, { status: 'ok', ids: ['65616', '65618', '1'] }, { status: 'uncertain', reason: 'x' }]) {
      await expect(make(realApi(bad)).getDealFiles('21760')).rejects.toThrow(/not exactly \[65616, 65618\]/);
    }
    const api = make(realApi({ status: 'ok', ids: ['65616', '65618'] }, { status: 'ok', ids: ['65616', '65618', '70001'] }, { status: 'ok', ids: ['70001'] }));
    await api.getDealFiles('21760');
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['65616', '65618', '70001'] });
    await expect(api.getDealFiles('21760')).resolves.toEqual({ status: 'ok', ids: ['70001'] }); // a vanished file is judged by the worker (manual review)
  });

  test('the update keeps BOTH PDFs in order and adds exactly one file with this share\'s name and the document\'s bytes', async () => {
    const real = realApi();
    await make(real).updateDealFiles('21760', entries);
    expect(real.updateDealFiles.mock.calls[0][1]).toEqual(entries);
    const refused = async (list, re) => { await expect(make(realApi()).updateDealFiles('21760', list)).rejects.toThrow(re); };
    await refused([entries[0], entries[2]], /keep files 65616 and 65618/);
    await refused([entries[1], entries[0], entries[2]], /keep files 65616 and 65618/);
    await refused([entries[0], entries[1]], /keep files 65616 and 65618/);
    await refused([entries[0], { id: '65608' }, entries[2]], /keep files 65616 and 65618/);
    await refused([entries[0], entries[1], { fileData: ['other.jpg', bytes.toString('base64')] }], /file name/);
    await refused([entries[0], entries[1], { fileData: [NAME, Buffer.from('tampered').toString('base64')] }], /checksum/);
  });

  test('no update when not allowed, never an empty list, only Deal 21760, no other Bitrix method', async () => {
    const real = realApi();
    await expect(make(real, { allowUpdate: false }).updateDealFiles('21760', entries)).rejects.toThrow(/No Bitrix update is allowed/);
    await expect(make(real).updateDealFiles('21760', [], { allowEmpty: true })).rejects.toThrow(/Only a non-empty list/);
    await expect(make(real).updateDealFiles('21761', entries)).rejects.toThrow(/Only a non-empty list for Deal 21760/);
    await expect(make(real).getDealFiles('21761')).rejects.toThrow(/21760/);
    const api = make(real);
    for (const method of ['createDeal', 'findDealsByReference', 'getDeal']) await expect(api[method]()).rejects.toThrow(/disabled/);
    expect(real.updateDealFiles).not.toHaveBeenCalled();
  });
});

describe('scoped store', () => {
  const real = { findCandidateIds: jest.fn(), claim: jest.fn(async () => ({ id: 423 })) };
  test('only event 423 can be offered or claimed', async () => {
    const store = makeScopedStore(real, 423);
    real.findCandidateIds.mockResolvedValueOnce([423]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).resolves.toEqual([423]);
    real.findCandidateIds.mockResolvedValueOnce([423, 424]);
    await expect(store.findCandidateIds({}, 'pending', 5, {})).rejects.toThrow(/not only event 423/);
    await expect(store.claim({}, { id: 422 })).rejects.toThrow(/Refusing to claim event 422/);
    await expect(store.claim({}, { id: 423 })).resolves.toEqual({ id: 423 });
  });
});

describe('state the attach needs (pure)', () => {
  const doc = (over = {}) => ({ serviceRequestId: 3845, originalName: TARGET.documentName, documentRequestId: 2, caseDocumentId: 708, scanStatus: 'clean', reviewStatus: 'approved', supersededAt: null, sha256: 'abc', ...over });
  const share = (over = {}) => ({ id: 6, dealLinkId: 363, requestDocumentId: 2664, generation: 1, status: 'authorized', shareToken: 'HC-D2664G1-6beaf795', detectedType: 'jpeg', tryCount: 1, attempts: 0, bitrixFileId: null, fileIdsBefore: null, sha256: 'abc', ...over });
  const attached = (id, documentId, fileId) => ({ id, dealLinkId: 363, requestDocumentId: documentId, generation: 1, status: 'attached', bitrixFileId: fileId });
  const ready = (over = {}) => ({
    c: { id: 2206, reference_number: 'CASE-3206', service_request_id: 3845, service_key: 'privatecharter', review_status: 'approved', bitrix_deal_id: '21760', link_id: 363, file_locked_until: null },
    doc: doc(),
    shares: [{ id: 3, requestDocumentId: 2663, status: 'revoked' }, attached(4, 2662, '65616'), attached(5, 2663, '65618'), share()],
    events: [{ id: 422, status: 'completed' }, { id: 423, event_type: 'bitrix.deal.document.attach', entity_id: '6:attach:1', status: 'pending', attempts: 0, external_call_started_at: null, locked_until: null, last_error: null }],
    ...over,
  });

  test('the current state is valid', () => expect(attachProblems(ready())).toEqual([]));

  test('a changed document, share, earlier attachment, event or lease each stop the run', () => {
    const problems = (over) => attachProblems(ready(over)).join(' | ');
    expect(problems({ doc: doc({ scanStatus: 'pending' }) })).toMatch(/not clean/);
    expect(problems({ doc: doc({ reviewStatus: 'rejected' }) })).toMatch(/not approved/);
    expect(problems({ doc: doc({ supersededAt: new Date() }) })).toMatch(/replaced/);
    expect(problems({ doc: doc({ sha256: 'zzz' }) })).toMatch(/checksum differs/);
    expect(problems({ shares: [{ id: 3, status: 'revoked' }, attached(4, 2662, '65616'), attached(5, 2663, '65618'), share({ status: 'attached' })] })).toMatch(/not a fresh/);
    expect(problems({ shares: [{ id: 3, status: 'revoked' }, attached(4, 2662, '65616'), attached(5, 2663, '65618'), share({ generation: 2 })] })).toMatch(/not generation 1/);
    expect(problems({ shares: [{ id: 3, status: 'revoked' }, attached(4, 2662, '65616'), share()] })).toMatch(/share 5 is not attached as file 65618/);
    expect(problems({ shares: [{ id: 3, status: 'revoked' }, attached(4, 2662, '1'), attached(5, 2663, '65618'), share()] })).toMatch(/share 4 is not attached as file 65616/);
    expect(problems({ shares: [{ id: 3, status: 'attached' }, attached(4, 2662, '65616'), attached(5, 2663, '65618'), share()] })).toMatch(/share 3 is not revoked/);
    expect(problems({ events: [{ id: 423, event_type: 'bitrix.deal.document.attach', entity_id: '6:attach:1', status: 'ambiguous', attempts: 1, external_call_started_at: new Date(), locked_until: null }] })).toMatch(/not a clean pending event/);
    expect(problems({ events: [{ id: 423, event_type: 'bitrix.deal.document.attach', entity_id: '6:attach:1', status: 'pending', attempts: 0, external_call_started_at: null, locked_until: null }, { id: 424, status: 'pending' }] })).toMatch(/open events/);
    expect(problems({ events: [{ id: 423, event_type: 'bitrix.deal.document.remove', entity_id: '6:attach:1', status: 'pending', attempts: 0 }] })).toMatch(/not the attach event of share 6/);
    expect(problems({ c: { ...ready().c, bitrix_deal_id: '999' } })).toMatch(/Deal id is not 21760/);
    expect(problems({ c: { ...ready().c, file_locked_until: new Date(Date.now() + 60000) } })).toMatch(/lease is held/);
  });

  test('document checks name the right file, request and checksum', () => {
    expect(documentProblems(doc(), 'abc')).toEqual([]);
    expect(documentProblems(doc({ originalName: 'other.jpeg' })).join()).toMatch(/is not "WhatsApp Image/);
    expect(documentProblems(doc({ caseDocumentId: 1 })).join()).toMatch(/link changed/);
    expect(documentProblems(null)).toEqual(['document 2664 not found']);
  });
});
