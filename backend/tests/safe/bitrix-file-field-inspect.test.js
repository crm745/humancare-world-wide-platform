/* global describe, test, expect, jest */
// scripts/bitrix-file-field-inspect.js: the read-only inspection of Deal 21760's Documents field. Pure functions with a FAKE fetch:
// no database, no network, no real Bitrix24 call.
const { parseArgs, makeGuard, analyzeFields, analyzeItem, evaluate, describePlan, REQUESTS, TARGET } = require('../../scripts/bitrix-file-field-inspect');

const BASE = `https://${TARGET.portalHost}/rest/1/secret/`;
const send = (guard, method, body, url = `${BASE}${method}.json`) => guard.guardedFetch(url, { method: 'POST', body: JSON.stringify(body) });
const okFetch = () => jest.fn(async () => ({ ok: true }));

describe('requests', () => {
  test('exactly two reads: crm.item.fields and crm.item.get, both for entityTypeId 2, the get for Deal 21760', () => {
    expect(Object.values(REQUESTS).map((r) => r.method)).toEqual(['crm.item.fields', 'crm.item.get']);
    expect(REQUESTS.fields.payload).toEqual({ entityTypeId: 2, useOriginalUfNames: 'N' });
    expect(REQUESTS.item.payload).toEqual({ entityTypeId: 2, id: 21760, useOriginalUfNames: 'Y' });
    expect(describePlan().join('\n')).toMatch(/crm\.item\.fields[\s\S]*crm\.item\.get/);
  });
  test('--plan is the only option; anything else is refused', () => {
    expect(parseArgs([])).toEqual({ plan: false });
    expect(parseArgs(['--plan'])).toEqual({ plan: true });
    expect(() => parseArgs(['--execute'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--update'])).toThrow(/unknown argument/);
  });
});

describe('HTTP guard', () => {
  test('one crm.item.fields and one crm.item.get go out, with redirects disabled', async () => {
    const fetch = okFetch();
    const guard = makeGuard(fetch);
    await send(guard, 'crm.item.fields', REQUESTS.fields.payload);
    await send(guard, 'crm.item.get', REQUESTS.item.payload);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every((c) => c[1].redirect === 'error')).toBe(true);
    expect(guard.state.sent).toEqual({ 'crm.item.fields': 1, 'crm.item.get': 1 });
  });

  test('a second request of either kind is refused', async () => {
    const fetch = okFetch();
    const guard = makeGuard(fetch);
    await send(guard, 'crm.item.get', REQUESTS.item.payload);
    await expect(send(guard, 'crm.item.get', REQUESTS.item.payload)).rejects.toThrow(/only one crm\.item\.get/);
    await send(guard, 'crm.item.fields', REQUESTS.fields.payload);
    await expect(send(guard, 'crm.item.fields', REQUESTS.fields.payload)).rejects.toThrow(/only one crm\.item\.fields/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('every update, upload, add, list or file method is refused, as is another host, entity type, Deal, verb or id on fields', async () => {
    const fetch = okFetch();
    const guard = makeGuard(fetch);
    for (const method of ['crm.item.update', 'crm.deal.update', 'crm.item.add', 'crm.deal.get', 'crm.item.list', 'crm.item.delete', 'disk.file.get', 'crm.deal.add']) {
      await expect(send(guard, method, { entityTypeId: 2, id: 21760, fields: {} })).rejects.toThrow(/only crm\.item\.fields and crm\.item\.get/);
    }
    await expect(send(guard, 'crm.item.get', REQUESTS.item.payload, 'https://other.bitrix24.in/rest/1/x/crm.item.get.json')).rejects.toThrow(/host/);
    await expect(send(guard, 'crm.item.get', { entityTypeId: 3, id: 21760 })).rejects.toThrow(/entityTypeId 2/);
    await expect(send(guard, 'crm.item.get', { entityTypeId: 2, id: 21761 })).rejects.toThrow(/21760/);
    await expect(send(guard, 'crm.item.fields', { entityTypeId: 2, id: 21760 })).rejects.toThrow(/no id/);
    await expect(guard.guardedFetch(`${BASE}crm.item.get.json`, { method: 'GET', body: '{}' })).rejects.toThrow(/POST only/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('field definition', () => {
  const answer = (def) => ({ fields: { id: { type: 'integer' }, ufCrm_1794832401: def } });
  test('is found by its upperName and reports type and multiple', () => {
    expect(analyzeFields(answer({ upperName: 'UF_CRM_1794832401', type: 'file', isMultiple: true, title: 'Documents' })))
      .toMatchObject({ found: true, camelKey: 'ufCrm_1794832401', upperName: 'UF_CRM_1794832401', type: 'file', isMultiple: true, title: 'Documents' });
  });
  test('is found by its key alone, with "N" / "Y" style multiple values understood', () => {
    expect(analyzeFields(answer({ type: 'file', isMultiple: 'Y' }))).toMatchObject({ found: true, isMultiple: true });
    expect(analyzeFields(answer({ type: 'file', isMultiple: false }))).toMatchObject({ found: true, isMultiple: false });
  });
  test('a missing field is reported, not guessed', () => {
    expect(analyzeFields({ fields: { id: { type: 'integer' } } })).toEqual({ found: false });
    expect(analyzeFields(null)).toEqual({ found: false });
  });
});

describe('the Deal and the field value', () => {
  const item = (files, over = {}) => ({ item: { id: 21760, categoryId: 38, stageId: 'C38:NEW', title: 'CASE-3206', UF_CRM_1794548440549: 'CASE-3206', UF_CRM_1794832401: files, ...over } });
  test('reports identity and the shape of each file entry, without reading any URL', () => {
    const deal = analyzeItem(item([{ id: 65616, url: 'https://secret/a', urlMachine: 'https://secret/b' }]));
    expect(deal).toMatchObject({ id: '21760', categoryId: '38', stageId: 'C38:NEW', title: 'CASE-3206', reference: 'CASE-3206', fieldKeyReturned: 'UF_CRM_1794832401', valueIsArray: true });
    expect(deal.files).toEqual([{ id: '65616', idType: 'number', keys: ['id', 'url', 'urlMachine'] }]);
    expect(JSON.stringify(deal)).not.toMatch(/secret/);
  });
  test('plain ids, an empty field and an unexpected shape are told apart', () => {
    expect(analyzeItem(item([65616])).files).toEqual([{ id: '65616', idType: 'number', keys: [] }]);
    expect(analyzeItem(item([])).files).toEqual([]);
    expect(analyzeItem(item(false)).files).toEqual([]);
    expect(analyzeItem(item('oops')).files).toBeNull();
    expect(analyzeItem({ item: { id: 21760 } }).fieldKeyReturned).toBeNull();
  });
});

describe('findings', () => {
  const def = { found: true, type: 'file', isMultiple: true };
  const deal = (over = {}) => ({ id: '21760', categoryId: '38', reference: 'CASE-3206', title: 'CASE-3206', fieldKeyReturned: 'UF_CRM_1794832401', files: [{ id: '65616' }], ...over });
  test('everything as expected passes', () => expect(evaluate(def, deal()).every((c) => c.ok)).toBe(true));
  test('a single-value field, another type, another Deal, category or file list each fail', () => {
    const failed = (d, a) => evaluate(d, a).filter((c) => !c.ok).map((c) => c.text).join(' | ');
    expect(failed({ ...def, isMultiple: false }, deal())).toMatch(/multiple/);
    expect(failed({ ...def, type: 'string' }, deal())).toMatch(/type is "file"/);
    expect(failed({ found: false }, deal())).toMatch(/is in the crm\.item\.fields answer/);
    expect(failed(def, deal({ id: '5' }))).toMatch(/is Deal 21760/);
    expect(failed(def, deal({ categoryId: '2' }))).toMatch(/category/);
    expect(failed(def, deal({ files: [{ id: '65616' }, { id: '1' }] }))).toMatch(/exactly \[65616\]/);
    expect(failed(def, deal({ files: null }))).toMatch(/is a list/);
    expect(failed(def, deal({ fieldKeyReturned: null }))).toMatch(/original name/);
  });
});
