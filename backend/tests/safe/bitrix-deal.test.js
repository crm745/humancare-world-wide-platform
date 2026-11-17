/* global describe, test, expect, jest, afterEach */
// Deal payload mapping and the Deal API client. No database, no network: the Bitrix transport is a mocked
// fetch passed in as `fetchImpl`, and every webhook value is a fake.
const {
  buildDealFields, DealMappingError, FIELD, DOCUMENTS_FIELD, CARE_LEVEL_OPTION, MOBILITY_OPTION, EQUIPMENT_OPTION, URGENCY_OPTION, GENDER_OPTION,
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
  equipOxygen: false, equipCardiacMonitor: true, equipVentilator: false, urgency: 'critical_6h',
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
      UF_CRM_1794548015097: [5880], // Care Level (multiple)
      UF_CRM_1794830631: [6012], // Patient Mobility (multiple)
      UF_CRM_1794830302: [6008], // Required on Board (multiple): Cardiac Monitor
      UF_CRM_1794831027: 6018, // Treatment Urgency - Private Charter: Critical
      UF_CRM_1768195253912: 61, // Patient Age
      UF_CRM_1779270456180: 'Dubai', // Origin Location
      UF_CRM_69EB460B79B1D: 'Mumbai', // Destination Location
    });
  });

  test('the confirmed field codes', () => {
    expect(FIELD).toMatchObject({
      CARE_LEVEL: 'UF_CRM_1794548015097', MOBILITY: 'UF_CRM_1794830631', REQUIRED_ON_BOARD: 'UF_CRM_1794830302', URGENCY: 'UF_CRM_1794831027',
      PATIENT_AGE: 'UF_CRM_1768195253912', ORIGIN: 'UF_CRM_1779270456180', DESTINATION: 'UF_CRM_69EB460B79B1D',
      REQUIRED_SERVICE: 'UF_CRM_6A2FB92FE1881', PATIENT_MOBILE: 'UF_CRM_PHONE_MOBILE', REFERENCE: 'UF_CRM_1794548440549',
    });
    expect(DOCUMENTS_FIELD).toBe('UF_CRM_1794832401');
  });

  test('the old single-value Mobility, Cardiac Monitor boolean and Transfer Urgency codes are no longer sent', () => {
    const fields = buildDealFields(caseRecord, request);
    for (const old of ['UF_CRM_1794548098759', 'UF_CRM_1794548136025', 'UF_CRM_1775637825406']) expect(fields).not.toHaveProperty(old);
  });

  test('never writes the Documents file field, whatever the request holds', () => {
    for (const extra of [{}, { documents: [{ name: 'a.pdf' }], files: ['x'], medicalReports: ['y'] }]) {
      expect(buildDealFields(caseRecord, { ...request, ...extra })).not.toHaveProperty(DOCUMENTS_FIELD);
    }
    expect(JSON.stringify(buildDealFields(caseRecord, request))).not.toContain('1794832401');
  });

  test('uses the old Lead service id nowhere, and no Lead-only field code, Contact, email or medical text', () => {
    const fields = buildDealFields(caseRecord, request);
    const sent = JSON.stringify(fields);
    expect(sent).not.toContain('2820');
    for (const code of leadCodes()) {
      // Patient Age is the one code the Lead and the Deal share (the same field code in both objects by the supplied specification).
      if (code !== FIELD.PATIENT_AGE) expect(Object.keys(fields)).not.toContain(code);
    }
    for (const key of ['CONTACT_ID', 'CONTACT_IDS', 'NAME', 'PHONE', 'EMAIL', 'COMMENTS', 'STATUS_ID']) expect(fields).not.toHaveProperty(key);
    for (const secret of ['asha@example.test', 'Chest pain', 'oxygen']) expect(sent).not.toContain(secret);
    expect(fields[FIELD.REFERENCE]).toBe(fields.TITLE);
  });

  test('the medical description is still never sent, in any field', () => {
    const fields = buildDealFields(caseRecord, { ...request, description: 'UNIQUE-DESCRIPTION-TEXT' });
    expect(JSON.stringify(fields)).not.toContain('UNIQUE-DESCRIPTION-TEXT');
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

  test.each(Object.entries(CARE_LEVEL_OPTION))('Care Level %s -> [%i], one value is an array of one', (key, option) => {
    expect(buildDealFields(caseRecord, { ...request, careLevel: key })[FIELD.CARE_LEVEL]).toEqual([option]);
  });
  test('Care Level options are ICU 5880, Stable 5882, Ambulatory 5884, Not Applicable 5886', () => {
    expect(CARE_LEVEL_OPTION).toEqual({ care_icu: 5880, care_stable: 5882, care_ambulatory: 5884, care_na: 5886 });
  });
  test.each([
    ['care_icu,care_stable', [5880, 5882]],
    ['care_stable,care_ambulatory', [5882, 5884]],
    ['care_icu,care_stable,care_ambulatory', [5880, 5882, 5884]],
    ['care_ambulatory,care_icu', [5880, 5884]], // always in the table's order
    ['care_icu, care_stable', [5880, 5882]],
  ])('several Care Levels %p -> %j, as an array of option ids (never text)', (stored, options) => {
    const value = buildDealFields(caseRecord, { ...request, careLevel: stored })[FIELD.CARE_LEVEL];
    expect(value).toEqual(options);
    expect(Array.isArray(value)).toBe(true);
  });
  test.each([['care_icu,care_na'], ['care_na,care_stable'], ['care_na, care_ambulatory,care_icu']])('Not Applicable is exclusive: %p is refused before any call', (stored) => {
    expect(() => buildDealFields(caseRecord, { ...request, careLevel: stored })).toThrow(expect.objectContaining({ code: 'care_level_na_combined' }));
  });
  test.each([['care_vip', 'care_level_unknown'], ['ICU / Critical', 'care_level_unknown'], ['care_icu,', 'care_level_unknown'], ['care_icu,care_icu', 'care_level_duplicate'], ['constructor', 'care_level_unknown']])('Care Level %p is refused (%s)', (stored, code) => {
    expect(() => buildDealFields(caseRecord, { ...request, careLevel: stored })).toThrow(expect.objectContaining({ name: 'DealMappingError', code }));
  });
  test.each([[null], [undefined], ['']])('a missing Care Level (%p) is left out', (careLevel) => {
    expect(buildDealFields(caseRecord, { ...request, careLevel })).not.toHaveProperty(FIELD.CARE_LEVEL);
  });

  test('Mobility options are Bedridden 6012, Wheelchair 6014, Walking 6016', () => {
    expect(MOBILITY_OPTION).toEqual({ bedridden: 6012, wheelchair: 6014, walking: 6016 });
  });
  test.each(Object.entries(MOBILITY_OPTION))('Mobility %s -> [%i], one value is an array of one', (key, option) => {
    expect(buildDealFields(caseRecord, { ...request, mobility: key })[FIELD.MOBILITY]).toEqual([option]);
  });
  test.each([
    ['bedridden,wheelchair', [6012, 6014]],
    ['wheelchair,walking', [6014, 6016]],
    ['bedridden,wheelchair,walking', [6012, 6014, 6016]],
    ['walking,bedridden', [6012, 6016]], // table order
  ])('several Mobility values %p -> %j, an array of option ids (never comma-separated text)', (stored, options) => {
    const value = buildDealFields(caseRecord, { ...request, mobility: stored })[FIELD.MOBILITY];
    expect(value).toEqual(options);
    expect(typeof value).not.toBe('string');
  });
  test.each([['flying', 'mobility_unknown'], ['Walking', 'mobility_unknown'], ['walking,', 'mobility_unknown'], ['walking,walking', 'mobility_duplicate'], ['__proto__', 'mobility_unknown']])('Mobility %p is refused (%s), not guessed', (stored, code) => {
    expect(() => buildDealFields(caseRecord, { ...request, mobility: stored })).toThrow(expect.objectContaining({ name: 'DealMappingError', code }));
  });
  test.each([[null], [undefined], ['']])('a missing Mobility (%p, an older request) is left out', (mobility) => {
    expect(buildDealFields(caseRecord, { ...request, mobility })).not.toHaveProperty(FIELD.MOBILITY);
  });

  test('Required on Board options are Oxygen 6006, Cardiac Monitor 6008, Ventilator 6010', () => {
    expect(EQUIPMENT_OPTION).toEqual({ equipOxygen: 6006, equipCardiacMonitor: 6008, equipVentilator: 6010 });
  });
  test.each([
    [{ equipOxygen: true }, [6006]],
    [{ equipCardiacMonitor: true }, [6008]],
    [{ equipVentilator: true }, [6010]],
    [{ equipOxygen: true, equipVentilator: true }, [6006, 6010]],
    [{ equipOxygen: true, equipCardiacMonitor: true, equipVentilator: true }, [6006, 6008, 6010]],
  ])('equipment %j -> %j in one multi-value field', (flags, options) => {
    const fields = buildDealFields(caseRecord, { ...request, equipOxygen: false, equipCardiacMonitor: false, equipVentilator: false, ...flags });
    expect(fields[FIELD.REQUIRED_ON_BOARD]).toEqual(options);
  });
  test.each([
    [{ equipOxygen: false, equipCardiacMonitor: false, equipVentilator: false }],
    [{ equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null }],
    [{ equipOxygen: undefined, equipCardiacMonitor: undefined, equipVentilator: undefined }],
    [{ equipOxygen: 'yes', equipCardiacMonitor: 1, equipVentilator: 'true' }],
  ])('no equipment selected (%j): the field is left out, optional', (flags) => {
    expect(buildDealFields(caseRecord, { ...request, ...flags })).not.toHaveProperty(FIELD.REQUIRED_ON_BOARD);
  });

  test('Urgency options are separate: Critical 6018, Urgent 6020, Planned 6022', () => {
    expect(URGENCY_OPTION).toEqual({ critical_6h: 6018, urgent_24h: 6020, planned: 6022 });
    expect(new Set(Object.values(URGENCY_OPTION)).size).toBe(3);
  });
  test.each([['critical_6h', 6018], ['urgent_24h', 6020], ['planned', 6022]])('Urgency %s -> %i, exactly one value', (urgency, option) => {
    expect(buildDealFields(caseRecord, { ...request, urgency })[FIELD.URGENCY]).toBe(option);
  });
  test.each([['whenever'], ['critical'], ['urgent'], ['__proto__']])('an unknown urgency %p is refused, not guessed', (urgency) => {
    expect(() => buildDealFields(caseRecord, { ...request, urgency })).toThrow(expect.objectContaining({ code: 'urgency_unknown' }));
  });
  test.each([[null], [undefined], ['']])('a missing urgency (%p) is left out', (urgency) => {
    expect(buildDealFields(caseRecord, { ...request, urgency })).not.toHaveProperty(FIELD.URGENCY);
  });

  test('Patient Age is a number; Origin and Destination are the city labels as text', () => {
    const fields = buildDealFields(caseRecord, { ...request, patientAge: 87, origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates' });
    expect(fields[FIELD.PATIENT_AGE]).toBe(87);
    expect(typeof fields[FIELD.PATIENT_AGE]).toBe('number');
    expect(fields[FIELD.ORIGIN]).toBe('Mumbai, Maharashtra, India');
    expect(fields[FIELD.DESTINATION]).toBe('Dubai, United Arab Emirates');
  });
  test.each([[null], [undefined], ['']])('a missing age (%p) is left out; a missing origin or destination too', (value) => {
    const fields = buildDealFields(caseRecord, { ...request, patientAge: value, origin: value, destination: value });
    for (const code of [FIELD.PATIENT_AGE, FIELD.ORIGIN, FIELD.DESTINATION]) expect(fields).not.toHaveProperty(code);
  });
  test.each([[0], [121], [1.5], ['61'], [-3], [{}]])('an age of %p is refused before any call', (patientAge) => {
    expect(() => buildDealFields(caseRecord, { ...request, patientAge })).toThrow(expect.objectContaining({ code: 'age_invalid' }));
  });

  test('a request with a lot selected still gives one coherent payload (a full Private Charter example)', () => {
    const fields = buildDealFields(caseRecord, {
      ...request, careLevel: 'care_icu,care_stable', mobility: 'bedridden,wheelchair', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: true, urgency: 'urgent_24h',
    });
    expect(fields).toMatchObject({
      UF_CRM_1794548015097: [5880, 5882], UF_CRM_1794830631: [6012, 6014], UF_CRM_1794830302: [6006, 6008, 6010], UF_CRM_1794831027: 6020,
      UF_CRM_6A2FB92FE1881: [2844], UF_CRM_69EB460B879E4: 1726, CATEGORY_ID: 38,
    });
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
