/* global describe, test, expect, jest */
// The Deal Documents file field in the Bitrix24 client (getDealFiles / updateDealFiles), through the universal CRM methods
// crm.item.get / crm.item.update (entityTypeId 2). No network: every transport is a mocked fetch and every webhook value is fake.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
const api = require('../../src/modules/bitrix/bitrix-deal.api');
const { DOCUMENTS_FIELD } = require('../../src/modules/bitrix/bitrix-deal');

const ENV_ON = {
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/',
};
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const fetchReturning = (...replies) => { const fn = jest.fn(); for (const r of replies) fn.mockImplementationOnce(async () => r); return fn; };
// crm.item.get answers { result: { item } } with the original UF_ names (useOriginalUfNames "Y"); the Deal id is a number.
const itemAnswer = (over = {}) => reply(200, { result: { item: { id: 4344, ...over } } });
const updated = (id = 4344) => reply(200, { result: { item: { id } } });

describe('the Documents field', () => {
  test('is UF_CRM_1794832401, and its camelCase key (verified against the portal) is ufCrm_1794832401', () => {
    expect(DOCUMENTS_FIELD).toBe('UF_CRM_1794832401');
    expect(api.DOCUMENTS_ITEM_KEY).toBe('ufCrm_1794832401');
    expect(api.DEAL_ENTITY_TYPE_ID).toBe(2);
  });
});

describe('fileIdsOf', () => {
  test.each([
    [[{ id: '11', showUrl: 'x' }, { id: 12 }], ['11', '12']],
    [['13', 14], ['13', '14']],
    [[], []],
    [undefined, []],
    [null, []],
    [false, []],
    [[{ id: 15 }], ['15']],
    [[{ id: 65616, showUrl: 'x', downloadUrl: 'y' }], ['65616']], // the shape the live portal returns: a NUMERIC id
  ])('%j -> %j', (value, ids) => {
    expect(api.fileIdsOf(value)).toEqual(ids);
  });

  test.each([['a plain object', { id: 1 }], ['a string', 'x'], ['a number', 7], ['an entry with no id', [{ name: 'a.pdf' }]], ['an entry with a zero id', [{ id: 0 }]], ['an entry with a padded id', [{ id: '007' }]], ['a null entry', [null]], ['true', true]])('does not guess at %s', (_name, value) => {
    expect(api.fileIdsOf(value)).toBeNull();
  });
});

describe('getDealFiles (crm.item.get)', () => {
  const get = (...replies) => api.getDealFiles('4344', { env: ENV_ON, fetchImpl: fetchReturning(...replies) });

  test('reads the Deal as an item (entityTypeId 2, numeric id, original field names) and returns the exact file ids', async () => {
    const fetchImpl = fetchReturning(itemAnswer({ [DOCUMENTS_FIELD]: [{ id: 501 }, { id: 502 }] }));
    expect(await api.getDealFiles('4344', { env: ENV_ON, fetchImpl })).toEqual({ status: 'ok', ids: ['501', '502'] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENV_ON.BITRIX24_WEBHOOK_URL}crm.item.get.json`);
    expect(JSON.parse(init.body)).toEqual({ entityTypeId: 2, id: 4344, useOriginalUfNames: 'Y' });
    expect(typeof JSON.parse(init.body).id).toBe('number');
  });

  test('a Deal with no files (field missing, empty, false or null) is an empty list', async () => {
    expect(await get(itemAnswer())).toEqual({ status: 'ok', ids: [] });
    expect(await get(itemAnswer({ [DOCUMENTS_FIELD]: [] }))).toEqual({ status: 'ok', ids: [] });
    expect(await get(itemAnswer({ [DOCUMENTS_FIELD]: false }))).toEqual({ status: 'ok', ids: [] });
  });

  test.each([
    ['an unreadable files shape', itemAnswer({ [DOCUMENTS_FIELD]: { weird: true } }), 'unexpected_files_shape'],
    ['a different Deal in the answer', reply(200, { result: { item: { id: 9999 } } }), 'wrong_deal'],
    ['a server error', reply(500, 'down'), 'server_error'],
    ['a non-object result', reply(200, { result: 'nope' }), 'unexpected_shape'],
    ['an answer with no item', reply(200, { result: {} }), 'unexpected_shape'],
    ['an item that is a list', reply(200, { result: { item: [] } }), 'unexpected_shape'],
    ['the legacy flat answer (no item wrapper)', reply(200, { result: { ID: '4344' } }), 'unexpected_shape'],
  ])('%s is "uncertain" with a reason, never an empty list', async (_name, response, reason) => {
    expect(await get(response)).toMatchObject({ status: 'uncertain', reason });
  });

  test('a Deal that does not exist is not_found; an invalid id is uncertain without a call', async () => {
    expect(await get(reply(400, { error: 'NOT_FOUND', error_description: 'Not found' }))).toEqual({ status: 'not_found' });
    const fetchImpl = jest.fn();
    expect(await api.getDealFiles('0', { env: ENV_ON, fetchImpl })).toMatchObject({ status: 'uncertain' });
    expect(await api.getDealFiles('abc', { env: ENV_ON, fetchImpl })).toMatchObject({ status: 'uncertain' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does nothing while a switch is off', async () => {
    const fetchImpl = jest.fn();
    expect(await api.getDealFiles('4344', { env: { ...ENV_ON, BITRIX_SYNC_ENABLED: 'false' }, fetchImpl })).toMatchObject({ status: 'uncertain' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('updateDealFiles (crm.item.update)', () => {
  // The worker's entries: { id } for a file to keep (a string or a number), { fileData: [name, base64] } for the new one.
  const entries = [{ id: '501' }, { id: 502 }, { fileData: ['HC-D1G1-abcd1234__report.pdf', 'JVBERi0='] }];
  const update = (list, opts, ...replies) => api.updateDealFiles('4344', list, { env: ENV_ON, fetchImpl: fetchReturning(...replies), ...opts });
  const sent = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body);

  test('posts crm.item.update for entityTypeId 2: kept files as NUMERIC { id }, the new file as the [name, base64] pair, camelCase key, "N" names', async () => {
    const fetchImpl = fetchReturning(updated());
    await expect(api.updateDealFiles('4344', entries, { env: ENV_ON, fetchImpl })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENV_ON.BITRIX24_WEBHOOK_URL}crm.item.update.json`);
    expect(init.method).toBe('POST');
    expect(sent(fetchImpl)).toEqual({
      entityTypeId: 2, id: 4344, useOriginalUfNames: 'N',
      fields: { ufCrm_1794832401: [{ id: 501 }, { id: 502 }, ['HC-D1G1-abcd1234__report.pdf', 'JVBERi0=']] },
    });
  });

  test('existing file ids are numbers, never strings, and the new file is never sent as { fileData }', async () => {
    const fetchImpl = fetchReturning(updated());
    await api.updateDealFiles('4344', [{ id: '65616' }, { fileData: ['n.pdf', 'JVBER'] }], { env: ENV_ON, fetchImpl });
    const list = sent(fetchImpl).fields.ufCrm_1794832401;
    expect(list[0]).toEqual({ id: 65616 });
    expect(typeof list[0].id).toBe('number');
    expect(list[1]).toEqual(['n.pdf', 'JVBER']);
    expect(JSON.stringify(list)).not.toMatch(/fileData/);
  });

  test('the order is kept (retained files first, in the order they were read) and every retained file is listed', async () => {
    const fetchImpl = fetchReturning(updated());
    await api.updateDealFiles('4344', [{ id: '7' }, { id: '65616' }, { id: '9' }, { fileData: ['n.pdf', 'JVBER'] }], { env: ENV_ON, fetchImpl });
    expect(sent(fetchImpl).fields.ufCrm_1794832401.map((e) => (Array.isArray(e) ? 'new' : e.id))).toEqual([7, 65616, 9, 'new']);
  });

  test('the field is the confirmed Documents field and nothing else is updated; the legacy method is never used', async () => {
    const fetchImpl = fetchReturning(updated());
    await api.updateDealFiles('4344', entries, { env: ENV_ON, fetchImpl });
    expect(Object.keys(sent(fetchImpl).fields)).toEqual([api.DOCUMENTS_ITEM_KEY]);
    expect(fetchImpl.mock.calls[0][0]).not.toMatch(/crm\.deal\.update/);
  });

  test.each([
    ['an empty list', []],
    ['a non-list', 'x'],
    ['an entry that is neither a kept id nor a file', [{ name: 'a.pdf' }]],
    ['a kept id that is not a file id', [{ id: '0' }]],
    ['a kept id that is not a safe integer', [{ id: '99999999999999999999' }]],
    ['a file with no name', [{ fileData: ['', 'abc'] }]],
    ['a file with no content', [{ fileData: ['a.pdf', ''] }]],
    ['a file with three parts', [{ fileData: ['a.pdf', 'abc', 'x'] }]],
    ['an entry with both an id and a file', [{ id: '5', fileData: ['a.pdf', 'abc'] }]],
    ['a string entry', ['501']],
    ['a bare [name, base64] pair', [['a.pdf', 'abc']]],
    ['the same kept id twice', [{ id: '501' }, { id: 501 }, { fileData: ['a.pdf', 'abc'] }]],
  ])('refuses %s before any call', async (_name, list) => {
    const fetchImpl = jest.fn();
    const error = await api.updateDealFiles('4344', list, { env: ENV_ON, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(api.BitrixDealCallError);
    expect(error.outcome).toBe('definitive');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('an empty list is sent only with allowEmpty (the caller proved nothing else is on the Deal)', async () => {
    const fetchImpl = fetchReturning(updated());
    await expect(api.updateDealFiles('4344', [], { env: ENV_ON, fetchImpl, allowEmpty: true })).resolves.toEqual({ ok: true });
    expect(sent(fetchImpl).fields.ufCrm_1794832401).toEqual([]);
  });

  test('an invalid Deal id is refused before any call', async () => {
    const fetchImpl = jest.fn();
    await expect(api.updateDealFiles('abc', entries, { env: ENV_ON, fetchImpl })).rejects.toMatchObject({ outcome: 'definitive' });
    await expect(api.updateDealFiles('0', entries, { env: ENV_ON, fetchImpl })).rejects.toMatchObject({ outcome: 'definitive' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['a Bitrix API error', reply(400, { error: 'ERROR_CORE', error_description: 'Field is invalid' }), 'definitive'],
    ['a rate limit', reply(429, { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many' }), 'definitive'],
    ['a server error', reply(500, { error: 'INTERNAL' }), 'ambiguous'],
    ['a gateway error page', reply(502, '<html>bad gateway</html>'), 'ambiguous'],
    ['a success answer without a result', reply(200, {}), 'ambiguous'],
    ['the legacy answer { result: true }', reply(200, { result: true }), 'ambiguous'],
    ['a result of false', reply(200, { result: false }), 'ambiguous'],
    ['a result that is a string', reply(200, { result: 'ok' }), 'ambiguous'],
    ['a result with no item', reply(200, { result: {} }), 'ambiguous'],
    ['an item that is not an object', reply(200, { result: { item: 'x' } }), 'ambiguous'],
    ['an item for a DIFFERENT Deal', reply(200, { result: { item: { id: 999 } } }), 'ambiguous'],
    ['an unreadable answer', reply(200, 'not json'), 'ambiguous'],
  ])('%s is %s (an answer that does not look like the documented one may still have been applied)', async (_name, response, outcome) => {
    const error = await update(entries, {}, response).catch((e) => e);
    expect(error).toBeInstanceOf(api.BitrixDealCallError);
    expect(error.outcome).toBe(outcome);
  });

  test('a lost connection after sending is ambiguous; one that never connected is definitive', async () => {
    const lost = jest.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(await api.updateDealFiles('4344', entries, { env: ENV_ON, fetchImpl: lost }).catch((e) => e)).toMatchObject({ outcome: 'ambiguous' });
    const never = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await api.updateDealFiles('4344', entries, { env: ENV_ON, fetchImpl: never }).catch((e) => e)).toMatchObject({ outcome: 'definitive' });
  });

  test('error messages never contain the webhook, a token or the file content', async () => {
    const error = await update(entries, {}, reply(400, { error: 'E', error_description: `bad ${ENV_ON.BITRIX24_WEBHOOK_URL}crm.item.update JVBERi0=` })).catch((e) => e);
    expect(error.message).not.toMatch(/FAKE_TOKEN|fake-bitrix/);
  });

  test('is refused while a switch is off, and for a host that is not allowed, before any request', async () => {
    const fetchImpl = jest.fn();
    await expect(api.updateDealFiles('4344', entries, { env: { ...ENV_ON, BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false' }, fetchImpl })).rejects.toMatchObject({ code: 'switch_off' });
    await expect(api.updateDealFiles('4344', entries, { env: { ...ENV_ON, NODE_ENV: 'test' }, fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(api.updateDealFiles('4344', entries, { env: { ...ENV_ON, BITRIX_ALLOWED_PORTAL_HOST: 'other.example' }, fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
