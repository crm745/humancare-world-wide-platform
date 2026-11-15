/* global describe, test, expect, jest, afterEach */
// Deal payload mapping and the Deal API client. No database, no network: the Bitrix transport is a mocked
// fetch passed in as `fetchImpl`, and every webhook value is a fake.
const {
  buildDealFields, DealMappingError, FIELD, CARE_LEVEL_OPTION, MOBILITY_OPTION, URGENCY_OPTION, GENDER_OPTION,
} = require('../../src/modules/bitrix/bitrix-deal');
const { createDeal, findDealsByReference, BitrixDealCallError, exactDealId } = require('../../src/modules/bitrix/bitrix-deal.api');
const lead = require('../../src/modules/bitrix/bitrix-lead');

const ENV_ON = {
  BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  BITRIX24_WEBHOOK_URL: 'https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/',
};
const REF = 'HC-PC-000123';

const caseRecord = { id: 7, referenceNumber: REF, patientName: 'Case Name', serviceRequestId: 3 };
const request = {
  id: 3, patientName: 'Asha Rao', patientGender: 'female', patientContact: '+971501234567', patientAge: 61,
  patientEmail: 'asha@example.test', origin: 'Dubai', destination: 'Mumbai', description: 'Chest pain, on oxygen',
  preferredDate: new Date('2030-03-05T00:00:00.000Z'), careLevel: 'care_icu', mobility: 'bedridden',
  equipCardiacMonitor: true, urgency: 'critical_6h',
};

afterEach(() => { jest.useRealTimers(); });

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const fetchReturning = (...replies) => {
  const fn = jest.fn();
  for (const r of replies) fn.mockImplementationOnce(async () => r);
  return fn;
};

describe('the Deal payload', () => {
  test('is exactly the approved fields, with the verified codes and options', () => {
    expect(buildDealFields(caseRecord, request)).toEqual({
      TITLE: REF,
      CATEGORY_ID: 38,
      STAGE_ID: 'C38:NEW',
      SOURCE_ID: 'UC_0AYN3R',
      UF_CRM_1794548440549: REF,
      UF_CRM_1775637288921: 'Asha Rao',
      UF_CRM_1775813710026: 1292,
      UF_CRM_1775813920874: '2030-03-05',
      UF_CRM_6A2FB92FE1881: [2844],
      UF_CRM_69EB460B879E4: 1726,
      UF_CRM_PHONE_MOBILE: '+971501234567',
      UF_CRM_1794548015097: [5880],
      UF_CRM_1794548098759: 5888,
      UF_CRM_1794548136025: true,
      UF_CRM_1775637825406: 2014,
    });
  });

  test('uses the old Lead service id nowhere, and no Lead field code, Contact, email, age, place or medical text', () => {
    const fields = buildDealFields(caseRecord, request);
    const sent = JSON.stringify(fields);
    expect(sent).not.toContain('2820');
    for (const code of leadCodes()) {
      // The Transfer Urgency code is the same string in both objects by the supplied specification.
      if (code !== FIELD.TRANSFER_URGENCY) expect(Object.keys(fields)).not.toContain(code);
    }
    for (const key of ['CONTACT_ID', 'CONTACT_IDS', 'NAME', 'PHONE', 'EMAIL', 'COMMENTS', 'STATUS_ID']) expect(fields).not.toHaveProperty(key);
    for (const secret of ['asha@example.test', 'Chest pain', 'Dubai', 'Mumbai']) expect(sent).not.toContain(secret);
    expect(Object.values(fields)).not.toContain(61); // age
    expect(fields[FIELD.REFERENCE]).toBe(fields.TITLE);
  });

  test('Patient Gender (UF_CRM_1775813710026) is sent as the approved option id', () => {
    expect(FIELD.PATIENT_GENDER).toBe('UF_CRM_1775813710026');
    expect(GENDER_OPTION).toEqual({ male: 1290, female: 1292, other: 1294 });
    expect(buildDealFields(caseRecord, request)[FIELD.PATIENT_GENDER]).toBe(1292);
  });
  test.each([['male', 1290], ['female', 1292], ['other', 1294], ['Male', 1290], [' FEMALE ', 1292]])('gender %p -> %i', (gender, option) => {
    expect(buildDealFields(caseRecord, { ...request, patientGender: gender })[FIELD.PATIENT_GENDER]).toBe(option);
  });
  test.each([[undefined], [null], ['']])('a missing gender (%p) is left out', (gender) => {
    expect(buildDealFields(caseRecord, { ...request, patientGender: gender })).not.toHaveProperty(FIELD.PATIENT_GENDER);
  });
  test.each([['M'], ['unknown'], ['non-binary'], ['constructor'], ['__proto__'], [1], [true], [{}]])('an unsupported gender %p is refused before any call', (gender) => {
    expect(() => buildDealFields(caseRecord, { ...request, patientGender: gender })).toThrow(DealMappingError);
  });

  test.each(Object.entries(CARE_LEVEL_OPTION))('Care Level %s -> %i, single value', (key, option) => {
    expect(buildDealFields(caseRecord, { ...request, careLevel: key })[FIELD.CARE_LEVEL]).toEqual([option]);
  });
  test('Care Level options are ICU 5880, Stable 5882, Ambulatory 5884, Not Applicable 5886', () => {
    expect(CARE_LEVEL_OPTION).toEqual({ care_icu: 5880, care_stable: 5882, care_ambulatory: 5884, care_na: 5886 });
  });
  test.each([['care_icu,care_stable'], ['care_icu, care_na'], ['care_vip'], ['ICU / Critical']])('Care Level %p is refused before any call', (stored) => {
    expect(() => buildDealFields(caseRecord, { ...request, careLevel: stored })).toThrow(DealMappingError);
  });

  test.each(Object.entries(MOBILITY_OPTION))('Mobility %s -> %i', (key, option) => {
    expect(buildDealFields(caseRecord, { ...request, mobility: key })[FIELD.MOBILITY]).toBe(option);
  });
  test('Mobility options are Bedridden 5888, Wheelchair 5890, Walking 5892', () => {
    expect(MOBILITY_OPTION).toEqual({ bedridden: 5888, wheelchair: 5890, walking: 5892 });
  });

  test.each([['critical_6h', 2014], ['urgent_24h', 2014], ['planned', 2016]])('Urgency %s -> %i', (urgency, option) => {
    expect(buildDealFields(caseRecord, { ...request, urgency })[FIELD.TRANSFER_URGENCY]).toBe(option);
    expect(URGENCY_OPTION[urgency]).toBe(option);
  });
  test('an unknown urgency or mobility is refused, not guessed', () => {
    expect(() => buildDealFields(caseRecord, { ...request, urgency: 'whenever' })).toThrow(DealMappingError);
    expect(() => buildDealFields(caseRecord, { ...request, mobility: 'flying' })).toThrow(DealMappingError);
  });

  test('Cardiac Monitor sends the boolean as it is: false stays, null is left out', () => {
    expect(buildDealFields(caseRecord, { ...request, equipCardiacMonitor: false })[FIELD.CARDIAC_MONITOR]).toBe(false);
    expect(buildDealFields(caseRecord, { ...request, equipCardiacMonitor: null })).not.toHaveProperty(FIELD.CARDIAC_MONITOR);
  });

  test('the date is a plain YYYY-MM-DD day, the reference is used exactly, a bad phone or reference is refused', () => {
    expect(buildDealFields(caseRecord, { ...request, preferredDate: '2031-12-31' })[FIELD.DATE_OF_SERVICE]).toBe('2031-12-31');
    expect(() => buildDealFields(caseRecord, { ...request, patientContact: '050 123 4567' })).toThrow(/E\.164/);
    expect(() => buildDealFields({ ...caseRecord, referenceNumber: ` ${REF}` }, request)).toThrow(DealMappingError);
    expect(() => buildDealFields({ ...caseRecord, referenceNumber: '' }, request)).toThrow(DealMappingError);
  });

  test('a mapping error never contains patient data', () => {
    try { buildDealFields(caseRecord, { ...request, patientContact: '+0bad', patientName: 'Secret Name' }); } catch (err) {
      expect(err.message).not.toMatch(/Secret Name|\+0bad/);
    }
  });
});

function leadCodes() {
  // Every UF code the Lead mapping can emit, read from a fully populated Lead.
  const fields = lead.buildLeadFields({
    origin: 'a', destination: 'b', contactName: 'n', mobile: '+1', email: 'e', referenceNumber: 'r', patientName: 'p', patientAge: 1,
    patientGender: 'male', dateOfService: '2030-01-01', urgency: 'urgent', industry: 1, specialRequirements: 's', deceasedName: 'd',
    relation: 'father', serviceKey: 'privatecharter', comments: 'c',
  });
  return Object.keys(fields).filter((key) => key.startsWith('UF_'));
}

describe('crm.deal.add', () => {
  const FIELDS = buildDealFields(caseRecord, request);

  test('posts the fields to crm.deal.add and returns the exact Deal ID as text', async () => {
    const fetchImpl = fetchReturning(reply(200, { result: 48213 }));
    await expect(createDeal(FIELDS, { env: ENV_ON, fetchImpl })).resolves.toEqual({ dealId: '48213' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENV_ON.BITRIX24_WEBHOOK_URL}crm.deal.add.json`);
    expect(JSON.parse(init.body)).toEqual({ fields: FIELDS });
    expect(JSON.parse(init.body).fields.CATEGORY_ID).toBe(38);
    expect(init.method).toBe('POST');
  });

  test('a digit-string Deal ID is kept untouched; anything else is not a usable ID', async () => {
    await expect(createDeal(FIELDS, { env: ENV_ON, fetchImpl: fetchReturning(reply(200, { result: '90210' })) })).resolves.toEqual({ dealId: '90210' });
    expect(exactDealId('007')).toBeNull();
    expect(exactDealId(0)).toBeNull();
    expect(exactDealId(1.5)).toBeNull();
    expect(exactDealId(2 ** 60)).toBeNull();
    expect(exactDealId({ id: 1 })).toBeNull();
    expect(exactDealId(true)).toBeNull();
  });

  test('does nothing while a switch is off or the webhook is not configured', async () => {
    const fetchImpl = jest.fn();
    for (const env of [{ ...ENV_ON, BITRIX_SYNC_ENABLED: undefined }, { ...ENV_ON, BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'false' }, { ...ENV_ON, BITRIX24_WEBHOOK_URL: '' }]) {
      await expect(createDeal(FIELDS, { env, fetchImpl })).rejects.toMatchObject({ outcome: 'definitive' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['a Bitrix API error', reply(400, { error: 'ERROR_CORE', error_description: 'Field is invalid' }), 'definitive'],
    ['an authorisation error', reply(401, { error: 'INVALID_CREDENTIALS', error_description: 'bad' }), 'definitive'],
    ['a rate limit', reply(429, { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many' }), 'definitive'],
    ['an error body on HTTP 200', reply(200, { error: 'ERROR_CORE', error_description: 'rejected' }), 'definitive'],
    ['a non-JSON 4xx', reply(403, '<html>forbidden</html>'), 'definitive'],
    ['a server error', reply(500, { error: 'INTERNAL' }), 'ambiguous'],
    ['a gateway error page', reply(502, '<html>bad gateway</html>'), 'ambiguous'],
    ['a request timeout status', reply(408, ''), 'ambiguous'],
    ['a success answer that is not JSON', reply(200, 'OK'), 'ambiguous'],
    ['a success answer without a result', reply(200, {}), 'ambiguous'],
    ['a null result', reply(200, { result: null }), 'ambiguous'],
    ['a zero Deal ID', reply(200, { result: 0 }), 'ambiguous'],
    ['an object as Deal ID', reply(200, { result: { ID: 5 } }), 'ambiguous'],
  ])('%s is %s', async (_name, response, outcome) => {
    const error = await createDeal(FIELDS, { env: ENV_ON, fetchImpl: fetchReturning(response) }).catch((e) => e);
    expect(error).toBeInstanceOf(BitrixDealCallError);
    expect(error.outcome).toBe(outcome);
  });

  test('a lost connection after sending is ambiguous; one that never connected is definitive', async () => {
    const lost = jest.fn().mockRejectedValue(Object.assign(new Error('socket hang up with https://fake-bitrix.invalid/rest/1/FAKE_TOKEN/'), { code: 'ECONNRESET' }));
    expect(await createDeal(FIELDS, { env: ENV_ON, fetchImpl: lost }).catch((e) => e)).toMatchObject({ outcome: 'ambiguous' });
    const never = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await createDeal(FIELDS, { env: ENV_ON, fetchImpl: never }).catch((e) => e)).toMatchObject({ outcome: 'definitive' });
  });

  test('times out after 15 seconds and the outcome is ambiguous', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = createDeal(FIELDS, { env: ENV_ON, fetchImpl }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(14999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(error).toMatchObject({ outcome: 'ambiguous', code: 'timeout' });
  });

  test('error messages never contain the webhook URL, a token, a phone number or a patient name', async () => {
    const responses = [
      [reply(400, { error: 'ERROR_CORE', error_description: `Bad ${ENV_ON.BITRIX24_WEBHOOK_URL}crm.deal.add` }), null],
      [null, Object.assign(new Error(`failed for ${ENV_ON.BITRIX24_WEBHOOK_URL}`), { code: 'ECONNRESET' })],
    ];
    for (const [response, failure] of responses) {
      const fetchImpl = failure ? jest.fn().mockRejectedValue(failure) : fetchReturning(response);
      const error = await createDeal(FIELDS, { env: ENV_ON, fetchImpl }).catch((e) => e);
      expect(error.message).not.toMatch(/FAKE_TOKEN|fake-bitrix|\+971501234567|Asha/);
    }
  });
});

describe('finding a Deal by its reference', () => {
  const deal = (id, over = {}) => ({ ID: String(id), CATEGORY_ID: '38', STAGE_ID: 'C38:NEW', [FIELD.REFERENCE]: REF, ...over });
  const find = (...replies) => findDealsByReference(REF, { env: ENV_ON, fetchImpl: fetchReturning(...replies) });

  test('asks Bitrix for Category 38 and the exact reference', async () => {
    const fetchImpl = fetchReturning(reply(200, { result: [] }));
    await findDealsByReference(REF, { env: ENV_ON, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ENV_ON.BITRIX24_WEBHOOK_URL}crm.deal.list.json`);
    expect(JSON.parse(init.body).filter).toEqual({ CATEGORY_ID: 38, [`=${FIELD.REFERENCE}`]: REF });
  });

  test('one verified match -> single, with the exact ID and stage', async () => {
    expect(await find(reply(200, { result: [deal(555, { STAGE_ID: 'C38:PREPARATION' })] }))).toEqual({ status: 'single', dealIds: ['555'], stageId: 'C38:PREPARATION' });
  });
  test('two matches -> multiple', async () => {
    expect(await find(reply(200, { result: [deal(555), deal(556)] }))).toMatchObject({ status: 'multiple', dealIds: ['555', '556'] });
  });
  test('the same Deal listed twice is one match', async () => {
    expect(await find(reply(200, { result: [deal(555), deal(555)] }))).toMatchObject({ status: 'single' });
  });
  test('a clean empty answer -> none', async () => {
    expect(await find(reply(200, { result: [] }))).toEqual({ status: 'none', dealIds: [] });
  });
  test.each([
    ['the lookup failed', () => reply(500, 'down')],
    ['Bitrix rejected the lookup', () => reply(400, { error: 'ERROR', error_description: 'x' })],
    ['the answer is not a list', () => reply(200, { result: { ID: 1 } })],
    ['the answer is paged (a next page exists)', () => reply(200, { result: [deal(1)], next: 50 })],
    ['Deals come back that do not carry the reference (filter not honoured)', () => reply(200, { result: [deal(1, { [FIELD.REFERENCE]: 'OTHER' }), deal(2, { [FIELD.REFERENCE]: undefined })] })],
  ])('%s -> uncertain, never "none"', async (_name, make) => {
    expect((await find(make())).status).toBe('uncertain');
  });
  test('a Deal in another category or with a different-case reference is not a match', async () => {
    expect((await find(reply(200, { result: [deal(1, { CATEGORY_ID: '12' })] }))).status).toBe('uncertain');
    expect((await find(reply(200, { result: [deal(1, { [FIELD.REFERENCE]: REF.toLowerCase() }), deal(2)] }))).dealIds).toEqual(['2']);
  });
  test('a lookup is not made for a missing or padded reference', async () => {
    const fetchImpl = jest.fn();
    expect((await findDealsByReference(' HC ', { env: ENV_ON, fetchImpl })).status).toBe('uncertain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
