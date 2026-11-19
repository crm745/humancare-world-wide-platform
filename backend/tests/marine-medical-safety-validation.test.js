// Marine Medical Safety (serviceKey "marine"), structured format: the validator, the description format and the structured-request detection.
// Pure: no database, no network, no app. (Run with a Jest configuration that skips the database setup; see the Phase 1 report.)
const {
  SCOPES, SERVICE_SCOPE_LABEL, CRITICAL_LEVELS, isMarineStructuredRequest, isNewMarineFormat, cityRefOf, validateMarineRequest, composeMarineDescription, parseMarineDescription,
} = require('../src/modules/requests/marine-medical-safety.validation');

const NOW = new Date('2026-11-17T12:00:00Z');
const city = (geonameId, countryCode, name = 'Somewhere') => ({ geonameId, name, label: `${name}, Region, ${countryCode}`, countryCode, timezone: 'Asia/Kolkata' });
const MUMBAI = city(1, 'IN', 'Mumbai');
const CHENNAI = city(2, 'IN', 'Chennai');
const DUBAI = city(3, 'AE', 'Dubai');
const BY_ID = { 1: MUMBAI, 2: CHENNAI, 3: DUBAI };
const body = (extra = {}) => ({
  serviceType: 'Marine Medical Safety',
  serviceKey: 'marine',
  serviceScope: 'international',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'IN',
  patientContact: '+91 98765 43210',
  originCity: { geonameId: 1 },
  destinationCity: { geonameId: 3 },
  ...extra,
});
// The server's lookups of the picked cities (what getVerifiedCity returns), worked out from the references in the body; `options.cities` overrides them one by one.
const run = (extra, options = {}) => {
  const b = body(extra);
  const found = {};
  for (const field of ['originCity', 'destinationCity']) {
    const ref = b[field];
    if (ref && typeof ref === 'object' && ref.geonameId && BY_ID[ref.geonameId]) found[field] = BY_ID[ref.geonameId];
  }
  return validateMarineRequest(b, { now: NOW, ...options, cities: { ...found, ...(options.cities || {}) } });
};
const without = (...keys) => { const b = body(); for (const k of keys) delete b[k]; return b; };
const typed = (origin = 'Port of Mumbai', destination = 'Port of Singapore') => ({ originCity: { text: origin }, destinationCity: { text: destination } });

describe('the service and its patient-facing scope label', () => {
  test('the label is exactly "Service Scope" and the two scopes are Domestic and International', () => {
    expect(SERVICE_SCOPE_LABEL).toBe('Service Scope');
    expect(SCOPES).toEqual({ domestic: 'Domestic', international: 'International' });
  });
  test('the service key and name are refused when they are not Marine\'s own', () => {
    expect(run({ serviceKey: 'medvalue' }).error).toMatch(/serviceKey must be "marine"/);
    expect(run({ serviceType: 'Marine Medical Safety Plus' }).error).toMatch(/serviceType must be "Marine Medical Safety"/);
    expect(validateMarineRequest(null).error).toBe('The request body must be a JSON object.');
    expect(validateMarineRequest([]).error).toBe('The request body must be a JSON object.');
  });
});

describe('a complete valid request', () => {
  test('maps to the existing columns: scope in transfer_scope, the country NAME, E.164, no urgency, no scope inside the description', () => {
    const { data, error } = run();
    expect(error).toBeUndefined();
    expect(data).toEqual({
      serviceType: 'Marine Medical Safety', serviceKey: 'marine', transferScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      country: 'India', patientContact: '+919876543210', origin: MUMBAI.label, patientLocation: MUMBAI.label, destination: DUBAI.label, preferredDate: null,
      careLevel: null, equipOxygen: null, equipOxygenLpm: null, description: 'Marine Medical Safety v1 (history 0)',
      originGeonameId: 1, originCityName: 'Mumbai', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata',
      destinationGeonameId: 3, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    });
    expect(data).not.toHaveProperty('urgency');
    expect(data).not.toHaveProperty('mobility');
    expect(data).not.toHaveProperty('equipCardiacMonitor');
    expect(data).not.toHaveProperty('equipVentilator');
    expect(data.description).not.toMatch(/international|domestic|scope/i);
  });
});

describe('required patient fields', () => {
  test.each([
    ['serviceScope', /serviceScope \(Service Scope\) must be one of/], ['patientName', /patientName is required/], ['patientAge', /patientAge must be/], ['patientGender', /patientGender must be/],
    ['country', /country must be/], ['patientContact', /patientContact must be/], ['originCity', /originCity must be a city/], ['destinationCity', /destinationCity must be a city/],
  ])('a request without %s is refused', (field, message) => {
    expect(validateMarineRequest(without(field), { now: NOW, cities: { originCity: MUMBAI, destinationCity: DUBAI } }).error).toMatch(message);
  });
  test('nothing else is required: no date, no Critical Level, no Oxygen answer, no Medical History, no report', () => {
    expect(run().error).toBeUndefined();
  });
});

describe('patient name: 2 to 191 characters with a letter', () => {
  test.each([['A'.repeat(2)], ['A'.repeat(191)], ['Jo'], ['  Asha Nair  '], ['Élodie Dürr'], ['अशोक']])('accepts %p', (value) => {
    expect(run({ patientName: value }).error).toBeUndefined();
  });
  test.each([[''], ['A'], [' A '], ['A'.repeat(192)], ['12345'], ['A\nB'], ['A\tB'], ['A\u0000B'], [7], [null]])('refuses %p', (value) => {
    expect(run({ patientName: value }).error).toMatch(/patientName/);
  });
  test('the name is stored trimmed', () => {
    expect(run({ patientName: '  Asha Nair  ' }).data.patientName).toBe('Asha Nair');
  });
});

describe('age: a whole number from 0 to 129', () => {
  test.each([[0], [1], [61], [129], ['0'], ['129'], [' 5 ']])('accepts %p', (value) => {
    expect(run({ patientAge: value }).data.patientAge).toBe(Number(String(value).trim()));
  });
  test.each([[-1], [130], [1000], [1.5], ['1.5'], ['abc'], [''], [null], ['007'], [true], [[3]]])('refuses %p', (value) => {
    expect(run({ patientAge: value }).error).toBe('patientAge must be a whole number from 0 to 129');
  });
});

describe('gender and country', () => {
  test.each([['Male', 'Male'], ['female', 'Female'], ['OTHER', 'Other'], [' Female ', 'Female']])('gender %p is stored as %p', (value, stored) => {
    expect(run({ patientGender: value }).data.patientGender).toBe(stored);
  });
  test.each([[''], ['x'], ['Prefer not to say'], [7], [null], [['Male']]])('refuses the gender %p', (value) => {
    expect(run({ patientGender: value }).error).toMatch(/patientGender must be Male, Female or Other/);
  });
  test('the country is an ISO code, normalised to its name for storage', () => {
    expect(run({ country: 'in' }).data.country).toBe('India');
    const ae = run({ country: 'AE', originCity: { text: 'Dubai Port' }, destinationCity: { text: 'Mumbai Port' } });
    expect(ae.data.country).toBe('United Arab Emirates');
  });
  test.each([['India'], ['XX'], ['I'], ['IND'], [''], [7], [null], ['1N']])('refuses the country %p', (value) => {
    expect(run({ country: value }).error).toMatch(/country must be a two-letter ISO 3166-1 country code/);
  });
});

describe('contact number: E.164', () => {
  test.each([['+91 98765 43210', '+919876543210'], ['+919876543210', '+919876543210'], ['+971 50 123 4567', '+971501234567'], ['  +44 7557 070702  ', '+447557070702']])('%p is stored as %p', (value, stored) => {
    expect(run({ patientContact: value }).data.patientContact).toBe(stored);
  });
  test.each([['9876543210'], ['0091 98765 43210'], ['+91 123'], [''], ['abc'], [null], [5], ['+0000'], ['+91 98765 4321O']])('refuses %p', (value) => {
    expect(run({ patientContact: value }).error).toMatch(/patientContact must be a valid phone number with its country code/);
  });
});

describe('Service Scope is required and is one of Domestic or International', () => {
  test.each([['Domestic'], ['INTERNATIONAL'], ['both'], [''], [7], [null], [['domestic']], [true]])('refuses %p', (value) => {
    expect(run({ serviceScope: value }).error).toMatch(/serviceScope \(Service Scope\) must be one of: domestic, international/);
  });
  test.each([['domestic', MUMBAI, CHENNAI], ['international', MUMBAI, DUBAI]])('accepts %p with fitting cities and stores it in transferScope', (scope, o, d) => {
    const { data, error } = run({ serviceScope: scope, originCity: { geonameId: o.geonameId }, destinationCity: { geonameId: d.geonameId } });
    expect(error).toBeUndefined();
    expect(data.transferScope).toBe(scope);
  });
});

describe('the scope rules for verified (picked) cities', () => {
  test.each([
    ['Domestic, both in the country', { serviceScope: 'domestic', destinationCity: { geonameId: 2 } }, null],
    ['International, destination in another country', {}, null],
    ['Domestic, destination abroad', { serviceScope: 'domestic' }, 'destinationCity must be in the selected country for a Domestic request'],
    ['International, destination in the same country', { destinationCity: { geonameId: 2 } }, 'destinationCity must be in a different country for an International request'],
    ['Origin outside the selected country (Domestic)', { serviceScope: 'domestic', country: 'AE', originCity: { geonameId: 1 }, destinationCity: { geonameId: 3 } }, 'originCity must be in the selected country'],
    ['Origin outside the selected country (International)', { country: 'AE' }, 'originCity must be in the selected country'],
  ])('%s', (_name, extra, message) => {
    const result = run(extra);
    if (message) expect(result.error).toBe(message);
    else expect(result.error).toBeUndefined();
  });
  test('the country comparison uses the verified record, never a name', () => {
    expect(run({ country: 'IN' }, { cities: { originCity: { ...MUMBAI, label: 'Mumbai, Maharashtra, United Arab Emirates' } } }).error).toBeUndefined();
  });
  test('a picked city the server could not verify is refused (unknown id, a different id back, nothing back)', () => {
    expect(run({ originCity: { geonameId: 999 } }).error).toMatch(/originCity is not a valid city/);
    expect(run({}, { cities: { destinationCity: null } }).error).toMatch(/destinationCity is not a valid city/);
    expect(run({}, { cities: { originCity: city(9, 'IN') } }).error).toMatch(/originCity is not a valid city/);
  });
  test('the verified record fills the readable text and every metadata column', () => {
    const { data } = run();
    expect(data).toMatchObject({
      origin: MUMBAI.label, patientLocation: MUMBAI.label, destination: DUBAI.label, originGeonameId: 1, originCityName: 'Mumbai', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata',
      destinationGeonameId: 3, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    });
  });
  test('a verified record without a timezone stores NULL for it', () => {
    expect(run({}, { cities: { originCity: { ...MUMBAI, timezone: undefined } } }).data.originTimezone).toBeNull();
  });
});

describe('manually entered cities and ports: kept exactly, no GeoNames metadata, no verification claimed', () => {
  const META = ['originGeonameId', 'originCityName', 'originCountryCode', 'originTimezone', 'destinationGeonameId', 'destinationCityName', 'destinationCountryCode'];
  test.each([
    ['plain names', 'Pune', 'Chennai'],
    ['leading, trailing and inner spaces', '  Port   of Mumbai (Ballard Pier) ', ' Jawaharlal  Nehru Port '],
    ['accents and non-Latin scripts', 'Zürich', '横浜港'],
    ['emoji and punctuation', 'Port ⚓ #7 / "Berth 4"', "Vizag's outer harbour"],
    ['exactly 191 characters', 'P'.repeat(191), 'D'.repeat(191)],
  ])('%s are preserved exactly', (_name, origin, destination) => {
    const { data, error } = run({ originCity: { text: origin }, destinationCity: { text: destination } }, { cities: {} });
    expect(error).toBeUndefined();
    expect(data.origin).toBe(origin);
    expect(data.patientLocation).toBe(origin);
    expect(data.destination).toBe(destination);
    for (const key of META) expect(data).not.toHaveProperty(key);
  });
  test('the scope rules are not claimed for them: either scope accepts a typed destination, even one that names a place in another country', () => {
    for (const serviceScope of ['domestic', 'international']) {
      expect(run({ serviceScope, ...typed('Port of Mumbai', 'Port of Dubai') }, { cities: {} }).error).toBeUndefined();
      expect(run({ serviceScope, ...typed('Dubai Creek', 'Mumbai Harbour') }, { cities: {} }).error).toBeUndefined();
    }
  });
  test('one picked and one typed: each is handled on its own', () => {
    const { data } = run({ destinationCity: { text: 'Port of Singapore' } });
    expect(data.originGeonameId).toBe(1);
    expect(data.originCountryCode).toBe('IN');
    expect(data.destination).toBe('Port of Singapore');
    for (const key of ['destinationGeonameId', 'destinationCityName', 'destinationCountryCode']) expect(data).not.toHaveProperty(key);
  });
  test('a typed city is refused when empty, whitespace only, over 191 characters, multi-line or not text', () => {
    expect(run({ originCity: { text: '' } }, { cities: {} }).error).toMatch(/originCity is required/);
    expect(run({ originCity: { text: '   ' } }, { cities: {} }).error).toMatch(/originCity is required/);
    expect(run({ originCity: { text: 'C'.repeat(192) } }, { cities: {} }).error).toMatch(/originCity can be at most 191 characters/);
    expect(run({ originCity: { text: 'A\nB' } }, { cities: {} }).error).toMatch(/originCity must be a single line/);
    expect(run({ originCity: { text: 'A\u2028B' } }, { cities: {} }).error).toMatch(/originCity must be a single line/);
    expect(run({ originCity: { text: 'A\u0000B' } }, { cities: {} }).error).toMatch(/originCity contains characters that cannot be saved/);
    expect(run({ originCity: { text: 5 } }, { cities: {} }).error).toMatch(/originCity is required/);
  });
  test.each([['a bare string', 'Pune'], ['an empty object', {}], ['two keys', { geonameId: 1, text: 'x' }], ['a name key', { name: 'Pune' }], ['a zero id', { geonameId: 0 }], ['a text id', { geonameId: '1' }], ['a float id', { geonameId: 1.5 }], ['a huge id', { geonameId: 2147483648 }], ['a list', [1]], ['null', null]])('a city given as %s is refused', (_n, value) => {
    expect(run({ originCity: value }, { cities: {} }).error).toMatch(/originCity/);
  });
  test('cityRefOf tells a picked city from a typed one', () => {
    expect(cityRefOf({ geonameId: 5 })).toEqual({ id: 5 });
    expect(cityRefOf({ text: 'Port' })).toEqual({ text: 'Port' });
    expect(cityRefOf('Port').problem).toBeDefined();
  });
});

describe('Date of Service: optional, today or later by the patient\'s own calendar', () => {
  test.each([['missing', undefined], ['null', null], ['an empty text', '']])('%s is fine and stores nothing', (_n, value) => {
    const extra = {}; if (value !== undefined) extra.preferredDate = value;
    expect(run(extra).data.preferredDate).toBeNull();
  });
  test('today and later days are accepted (UTC)', () => {
    expect(run({ preferredDate: '2026-11-17', utcOffsetMinutes: 0 }).data.preferredDate).toBe('2026-11-17');
    expect(run({ preferredDate: '2026-11-18', utcOffsetMinutes: 0 }).data.preferredDate).toBe('2026-11-18');
    expect(run({ preferredDate: '2030-02-28', utcOffsetMinutes: 0 }).data.preferredDate).toBe('2030-02-28');
  });
  test.each([['2026-11-16'], ['2000-01-01']])('the past day %s is refused', (value) => {
    expect(run({ preferredDate: value, utcOffsetMinutes: 0 }).error).toBe('preferredDate cannot be in the past');
  });
  test.each([['2026-02-30'], ['2026-13-01'], ['17/11/2026'], ['2026-1-5'], ['today'], [20261117], [true]])('the date %p is refused as not a valid date', (value) => {
    expect(run({ preferredDate: value, utcOffsetMinutes: 0 }).error).toBe('preferredDate must be a valid date (YYYY-MM-DD)');
  });
  test.each([
    ['UTC+14, 2026-11-18 is today while it is still the 17th in UTC', '2026-11-18', 840, '2026-11-17T22:00:00Z', null],
    ['UTC+14, 2026-11-17 is already past for the patient', '2026-11-17', 840, '2026-11-17T22:00:00Z', 'preferredDate cannot be in the past'],
    ['UTC, the same instant: the 17th is still today', '2026-11-17', 0, '2026-11-17T22:00:00Z', null],
    ['UTC-12, 2026-11-17 is today while it is already the 18th in UTC', '2026-11-17', -720, '2026-11-18T05:00:00Z', null],
    ['UTC-12, 2026-11-16 is past', '2026-11-16', -720, '2026-11-18T05:00:00Z', 'preferredDate cannot be in the past'],
    ['just after midnight UTC, the 17th is past in UTC', '2026-11-16', 0, '2026-11-17T00:00:01Z', 'preferredDate cannot be in the past'],
    ['the last second of the 17th UTC, the 17th is today', '2026-11-17', 0, '2026-11-17T23:59:59Z', null],
  ])('%s', (_name, preferredDate, utcOffsetMinutes, instant, message) => {
    const result = run({ preferredDate, utcOffsetMinutes }, { now: new Date(instant) });
    if (message) expect(result.error).toBe(message);
    else expect(result.error).toBeUndefined();
  });
  test('a date needs the device offset, and the offset must be sane', () => {
    expect(run({ preferredDate: '2026-12-01' }).error).toMatch(/utcOffsetMinutes is required with preferredDate/);
    for (const bad of [841, -721, 1.5, '0', NaN]) expect(run({ preferredDate: '2026-12-01', utcOffsetMinutes: bad }).error).toMatch(/utcOffsetMinutes must be a whole number/);
    expect(run({ utcOffsetMinutes: 330 }).error).toBeUndefined(); // an offset alone is harmless and is not stored
  });
});

describe('Critical Level: optional, one or more of the four keys', () => {
  test.each([['absent', undefined], ['null', null], ['an empty text', ''], ['a blank text', '   '], ['an empty list', []]])('%s is no selection (valid, stored NULL)', (_n, value) => {
    const extra = {}; if (value !== undefined) extra.careLevel = value;
    const { data, error } = run(extra);
    expect(error).toBeUndefined();
    expect(data.careLevel).toBeNull();
  });
  test('the four keys, in the order shown', () => {
    expect(CRITICAL_LEVELS).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
  });
  test.each(CRITICAL_LEVELS)('%s alone is accepted, as text and as a list', (key) => {
    expect(run({ careLevel: key }).data.careLevel).toBe(key);
    expect(run({ careLevel: [key] }).data.careLevel).toBe(key);
  });
  test.each([
    ['two, as text', 'crit_icu,crit_ecmo', 'crit_icu,crit_ecmo'],
    ['all four, as a list, in the order chosen', ['crit_tracheostomy', 'crit_icu', 'crit_ecmo', 'crit_ventilated'], 'crit_tracheostomy,crit_icu,crit_ecmo,crit_ventilated'],
    ['spaces around the pieces are dropped', ' crit_icu , crit_ventilated ', 'crit_icu,crit_ventilated'],
  ])('several: %s', (_n, value, stored) => {
    expect(run({ careLevel: value }).data.careLevel).toBe(stored);
  });
  test.each([
    ['an old care level key', 'care_icu'], ['an old label', 'ICU / Critical'], ['free text', 'critical'], ['the wrong case', 'Crit_Icu'], ['a good one and a bad one', 'crit_icu,care_na'],
    ['a repeated option', 'crit_icu,crit_icu'], ['an empty piece', 'crit_icu,'], ['a number', 7], ['an object', { crit_icu: true }], ['a list with a number', ['crit_icu', 3]],
    ['a list with a repeat', ['crit_icu', 'crit_icu']], ['a list with a bad key', ['crit_icu', 'ecmo']], ['a boolean', true],
  ])('refuses %s', (_n, value) => {
    expect(run({ careLevel: value }).error).toMatch(/^Invalid careLevel/);
  });
});

describe('Oxygen: not answered, Yes (flow rate required), No (flow rate cleared)', () => {
  test('not answered: stored NULL for the answer and for the flow rate', () => {
    for (const extra of [{}, { equipOxygen: null }]) {
      const { data, error } = run(extra);
      expect(error).toBeUndefined();
      expect(data.equipOxygen).toBeNull();
      expect(data.equipOxygenLpm).toBeNull();
    }
  });
  test('Yes requires the flow rate', () => {
    expect(run({ equipOxygen: true }).error).toBe('equipOxygenLpm is required when Oxygen is Yes');
    expect(run({ equipOxygen: true, equipOxygenLpm: null }).error).toBe('equipOxygenLpm is required when Oxygen is Yes');
  });
  test.each([[0.5], [1], [2.5], [4], [15], [0.1], [14.9]])('Yes with the flow rate %p is stored as a number', (lpm) => {
    const { data, error } = run({ equipOxygen: true, equipOxygenLpm: lpm });
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ equipOxygen: true, equipOxygenLpm: lpm });
  });
  test.each([[0], [-1], [15.1], [16], [2.55], [1e9], ['4'], [true], ['abc'], [[4]], [NaN], [Infinity]])('Yes with the flow rate %p is refused (the shared flow-rate rule)', (lpm) => {
    expect(run({ equipOxygen: true, equipOxygenLpm: lpm }).error).toMatch(/equipOxygenLpm/);
  });
  test('No stores NULL for the flow rate, and a flow rate sent with it is refused rather than kept', () => {
    const { data, error } = run({ equipOxygen: false });
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
    expect(run({ equipOxygen: false, equipOxygenLpm: 4 }).error).toBe('equipOxygenLpm is only accepted when Oxygen is Yes');
  });
  test('a flow rate with no Oxygen answer is refused too', () => {
    expect(run({ equipOxygenLpm: 4 }).error).toBe('equipOxygenLpm is only accepted when Oxygen is Yes');
    expect(run({ equipOxygen: null, equipOxygenLpm: 4 }).error).toBe('equipOxygenLpm is only accepted when Oxygen is Yes');
  });
  test.each([['"true"', 'true'], ['1', 1], ['0', 0], ['"yes"', 'yes'], ['an object', {}]])('the Oxygen answer %s must be true or false', (_n, value) => {
    expect(run({ equipOxygen: value }).error).toBe('equipOxygen must be true or false');
  });
  test('the flow rate is kept to one decimal', () => {
    expect(run({ equipOxygen: true, equipOxygenLpm: 2.5 }).data.equipOxygenLpm).toBe(2.5);
  });
});

describe('Medical History: optional, at most 2,000 characters, kept exactly', () => {
  const history = (value) => run({ medicalHistory: value });
  test('none is fine: the description is the header alone', () => {
    expect(run().data.description).toBe('Marine Medical Safety v1 (history 0)');
    expect(history(null).data.description).toBe('Marine Medical Safety v1 (history 0)');
    expect(history('').data.description).toBe('Marine Medical Safety v1 (history 0)');
  });
  test('whitespace alone counts as not entered (as in the other structured services)', () => {
    expect(history('   \n\t ').data.description).toBe('Marine Medical Safety v1 (history 0)');
  });
  test('the 2,000-character boundary counts characters, not code units', () => {
    expect(history('h'.repeat(2000)).error).toBeUndefined();
    expect(history('h'.repeat(2001)).error).toBe('medicalHistory can be at most 2000 characters');
    expect(history('\u{1F600}'.repeat(2000)).error).toBeUndefined(); // 2,000 characters, 4,000 code units
    expect(history('\u{1F600}'.repeat(2001)).error).toBe('medicalHistory can be at most 2000 characters');
    expect(parseMarineDescription(history('\u{1F600}'.repeat(2000)).data.description)).toMatchObject({ ok: true, history: '\u{1F600}'.repeat(2000) });
  });
  test.each([
    ['plain text', 'Crew member with chest pain since 04:00.'],
    ['leading and trailing spaces', '   padded   '],
    ['line breaks of every kind', 'one\ntwo\r\nthree\rfour'],
    ['tabs and double spaces', 'a\t\tb  c'],
    ['Unicode line and paragraph separators', 'a\u2028b\u2029c'],
    ['emoji and a ZWJ family', 'ok \u{1F600} \u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['combining marks (not normalised)', 'é and é'],
    ['zero-width and bidirectional marks', 'a​b‏c‮d'],
    ['Arabic, Devanagari and CJK', 'العربية हिन्दी 日本語'],
    ['text that looks like the format itself', 'Marine Medical Safety v1 (history 0)\nMedical History:\nfake'],
    ['text with the section label', '\nMedical History:\nnested\n'],
  ])('%s is stored exactly and read back exactly', (_n, text) => {
    const { data, error } = history(text);
    expect(error).toBeUndefined();
    expect(data.description).toBe(`Marine Medical Safety v1 (history ${text.length})\nMedical History:\n${text}`);
    expect(parseMarineDescription(data.description)).toEqual({ ok: true, history: text });
  });
  test.each([['a NUL', 'a\u0000b'], ['a bell', 'a\u0007b'], ['DEL', 'a\u007fb'], ['a C1 control', 'a\u0085b'], ['a lone high surrogate', 'a\ud83db'], ['a lone low surrogate', 'a\ude00b']])('refuses %s', (_n, text) => {
    expect(history(text).error).toBe('medicalHistory contains characters that cannot be saved');
  });
  test('refuses a Medical History that is not text', () => {
    for (const bad of [7, true, {}, ['x']]) expect(history(bad).error).toBe('medicalHistory must be text');
  });
});

describe('excluded fields are refused', () => {
  test.each([
    ['urgency', 'urgent_24h'], ['mobility', 'walking'], ['equipCardiacMonitor', true], ['equipCardiacMonitor', false], ['equipVentilator', true], ['equipVentilator', false],
    ['emergencyContact', 'Jo'], ['emergencyContactName', 'Jo'], ['emergencyContactNumber', '+919876543210'], ['vesselName', 'MV Aurora'], ['shipName', 'MV Aurora'],
    ['gpsCoordinates', '18.9,72.8'], ['latitude', 18.9], ['longitude', 72.8],
    ['description', 'x'], ['origin', 'Mumbai'], ['destination', 'Dubai'], ['patientLocation', 'Mumbai'], ['transferScope', 'domestic'], ['transportMode', 'ground_transportation'],
    ['careRequirement', '12_hours'], ['homeAddress', 'x'], ['specialty', 'Oncology'], ['treatmentScope', 'domestic'], ['placeOfDeath', 'x'],
  ])('%s is not accepted', (field, value) => {
    expect(run({ [field]: value }).error).toBe(`${field} is not accepted for Marine Medical Safety requests`);
  });
  test('the fields the request infrastructure needs from the client are accepted: serviceType and serviceKey (checked above), and utcOffsetMinutes for the date', () => {
    expect(run({ utcOffsetMinutes: 0, preferredDate: '2026-12-01' }).error).toBeUndefined();
  });
  test('an excluded field is refused before anything else is judged', () => {
    expect(run({ patientName: '', urgency: 'planned' }).error).toBe('urgency is not accepted for Marine Medical Safety requests');
  });
});

describe('the description format', () => {
  const cases = [
    ['no history', ''],
    ['a short history', 'Stable.'],
    ['a history that looks like the format itself', 'Marine Medical Safety v1 (history 0)\nMedical History:\nfake'],
    ['a history holding the section label and line breaks', '\nMedical History:\n x \r\n'],
    ['emoji, combining marks and scripts', '\u{1F600}\u{1F468}‍\u{1F469}‍\u{1F467} é 日本語 العربية'],
    ['Unicode line separators and surrounding whitespace', ' \u2028 x \u2029 '],
    ['exactly 2,000 characters', 'z'.repeat(2000)],
    ['4,000 code units', '\u{1F600}'.repeat(2000)],
  ];
  test.each(cases)('round-trips exactly: %s', (_n, history) => {
    const text = composeMarineDescription({ history });
    expect(parseMarineDescription(text)).toEqual({ ok: true, history });
  });
  test('has the documented shape: the header alone, or the header, the label and the text', () => {
    expect(composeMarineDescription({ history: '' })).toBe('Marine Medical Safety v1 (history 0)');
    expect(composeMarineDescription()).toBe('Marine Medical Safety v1 (history 0)');
    expect(composeMarineDescription({ history: 'Knee pain.' })).toBe('Marine Medical Safety v1 (history 10)\nMedical History:\nKnee pain.');
  });
  test('the length is in UTF-16 code units (an emoji counts 2), consistent with the other structured services', () => {
    expect(composeMarineDescription({ history: '\u{1F600}' })).toBe('Marine Medical Safety v1 (history 2)\nMedical History:\n\u{1F600}');
  });
  test('the header is always written and the text is never trimmed or changed', () => {
    const text = '  \n padded \t ';
    expect(composeMarineDescription({ history: text })).toBe(`Marine Medical Safety v1 (history ${text.length})\nMedical History:\n${text}`);
  });
  test.each([
    ['plain old free text', 'Crew member injured on deck.'],
    ['an empty text', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
    ['an object', { history: 'x' }],
    ['a header with no history count', 'Marine Medical Safety v1 ()'],
    ['an unknown version', 'Marine Medical Safety v2 (history 0)'],
    ['a lower-case header', 'marine medical safety v1 (history 0)'],
    ['the wrong service name', 'Medical Value Travel v1 (history 0)'],
    ['an MVT description', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology'],
    ['a header with the other count', 'Marine Medical Safety v1 (other 0, history 0)'],
    ['a leading zero in the count', 'Marine Medical Safety v1 (history 01)\nMedical History:\nx'],
    ['a zero-padded zero', 'Marine Medical Safety v1 (history 00)'],
    ['a negative count', 'Marine Medical Safety v1 (history -1)'],
    ['a fractional count', 'Marine Medical Safety v1 (history 1.5)'],
    ['a count past the frame limit', 'Marine Medical Safety v1 (history 4001)\nMedical History:\nx'],
    ['a huge count', 'Marine Medical Safety v1 (history 99999999999999999999)\nMedical History:\nx'],
    ['a zero count with text after the header', 'Marine Medical Safety v1 (history 0)\nextra'],
    ['a zero count with a trailing line break', 'Marine Medical Safety v1 (history 0)\n'],
    ['a zero count with an empty history section', 'Marine Medical Safety v1 (history 0)\nMedical History:\n'],
    ['a count with no history section', 'Marine Medical Safety v1 (history 3)'],
    ['a count with a header line break and nothing else', 'Marine Medical Safety v1 (history 3)\n'],
    ['a wrong section label', 'Marine Medical Safety v1 (history 3)\nHistory:\nabc'],
    ['a section label without its line break', 'Marine Medical Safety v1 (history 3)\nMedical History:abc'],
    ['a history shorter than its count', 'Marine Medical Safety v1 (history 9)\nMedical History:\nshort'],
    ['a history longer than its count', 'Marine Medical Safety v1 (history 2)\nMedical History:\nlonger'],
    ['trailing text after the history', 'Marine Medical Safety v1 (history 3)\nMedical History:\nabc\n'],
    ['a Windows line break after the header', 'Marine Medical Safety v1 (history 3)\r\nMedical History:\nabc'],
    ['a Windows line break in the label line', 'Marine Medical Safety v1 (history 3)\nMedical History:\r\nabc'],
    ['spaces around the header', ' Marine Medical Safety v1 (history 0)'],
    ['a trailing space on the header', 'Marine Medical Safety v1 (history 0) '],
    ['text before the header', 'x\nMarine Medical Safety v1 (history 0)'],
    ['a frame cutting an emoji in two', 'Marine Medical Safety v1 (history 1)\nMedical History:\n\u{1F600}'],
    ['a frame starting on half an emoji', 'Marine Medical Safety v1 (history 1)\nMedical History:\n\ude00'],
    ['a lone surrogate inside the history', 'Marine Medical Safety v1 (history 3)\nMedical History:\na\ud83d'],
  ])('is not valid (so it stays legacy): %s', (_n, text) => {
    expect(parseMarineDescription(text).ok).toBe(false);
  });
  test('the parser never throws, whatever it is given', () => {
    for (const odd of [undefined, null, 5, {}, [], Symbol.iterator, '\n\n\n', 'Marine Medical Safety v1 (history 3)\nMedical History:\n', `Marine Medical Safety v1 (history ${'9'.repeat(10000)})`]) {
      expect(() => parseMarineDescription(typeof odd === 'symbol' ? String(odd) : odd)).not.toThrow();
    }
  });
});

describe('a request BODY is structured Marine only with the key and a field only the new app sends', () => {
  test.each(['serviceScope', 'originCity', 'destinationCity', 'medicalHistory'])('the marker %s, with the key marine, makes it structured', (marker) => {
    expect(isMarineStructuredRequest({ serviceKey: 'marine', serviceType: 'Marine Medical Safety', [marker]: 'x' })).toBe(true);
  });
  test('a complete body is structured', () => {
    expect(isMarineStructuredRequest(body())).toBe(true);
  });
  test('the generic body an older app build sends is not (it keeps the generic path)', () => {
    expect(isMarineStructuredRequest({
      serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', patientAge: 40, patientGender: 'Male', patientLocation: 'Mumbai', patientContact: '+91 98765 43210',
      origin: 'Mumbai', destination: 'Dubai', country: 'India', preferredDate: '2026-12-01', description: 'Needs help.', urgency: 'planned',
    })).toBe(false);
  });
  test('careLevel and equipOxygen alone do not make a body structured', () => {
    expect(isMarineStructuredRequest({ serviceKey: 'marine', careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4 })).toBe(false);
  });
  test('the marker without the key is not: another service is never routed here', () => {
    for (const serviceKey of ['medvalue', 'hospital', 'ground', 'privatecharter', 'mortal', 'homecare', 'tele', 'commercialair_stretcher', undefined, 'MARINE', 'marine ']) {
      expect(isMarineStructuredRequest({ serviceKey, serviceScope: 'domestic', originCity: { text: 'x' }, medicalHistory: 'x' })).toBe(false);
    }
  });
  test.each([[null], [undefined], [[]], ['marine'], [5]])('%p is not a request body', (value) => {
    expect(isMarineStructuredRequest(value)).toBe(false);
  });
});

describe('a STORED request is structured Marine only with the key, a real scope AND a description that parses', () => {
  const GOOD = 'Marine Medical Safety v1 (history 0)';
  const WITH_HISTORY = 'Marine Medical Safety v1 (history 5)\nMedical History:\nHello';
  test.each([['domestic'], ['international']])('structured: key marine, scope %s, a parsing description', (transferScope) => {
    expect(isNewMarineFormat({ serviceKey: 'marine', transferScope, description: GOOD })).toBe(true);
    expect(isNewMarineFormat({ serviceKey: 'marine', transferScope, description: WITH_HISTORY })).toBe(true);
  });
  test.each([
    ['a legacy generic request: no scope, free text', { serviceKey: 'marine', transferScope: null, description: 'Crew member injured on deck.' }],
    ['a legacy request with no description at all', { serviceKey: 'marine', transferScope: null, description: null }],
    ['a legacy request with a scope-looking value but free text', { serviceKey: 'marine', transferScope: 'domestic', description: 'Crew member injured on deck.' }],
    ['text that looks like the new header on a row with no scope', { serviceKey: 'marine', transferScope: null, description: GOOD }],
    ['text that looks like the new header on a row with an empty scope', { serviceKey: 'marine', transferScope: '', description: GOOD }],
    ['the header with a scope the format does not have', { serviceKey: 'marine', transferScope: 'private_charter', description: GOOD }],
    ['the header with a scope in the wrong case', { serviceKey: 'marine', transferScope: 'Domestic', description: GOOD }],
    ['a scope that is a prototype key', { serviceKey: 'marine', transferScope: 'constructor', description: GOOD }],
    ['a scope that is not text', { serviceKey: 'marine', transferScope: 1, description: GOOD }],
    ['a real scope but a malformed description', { serviceKey: 'marine', transferScope: 'domestic', description: 'Marine Medical Safety v1 (history 9)\nMedical History:\nshort' }],
    ['a real scope but an unknown version', { serviceKey: 'marine', transferScope: 'domestic', description: 'Marine Medical Safety v2 (history 0)' }],
    ['the structured text on another service key (MVT)', { serviceKey: 'medvalue', transferScope: 'domestic', description: GOOD }],
    ['the structured text on Mortal Remains, which also uses the scope column', { serviceKey: 'mortal', transferScope: 'domestic', description: GOOD }],
    ['the structured text on a hospital request', { serviceKey: 'hospital', transferScope: 'domestic', description: GOOD }],
    ['no key', { transferScope: 'domestic', description: GOOD }],
    ['an upper-case key', { serviceKey: 'MARINE', transferScope: 'domestic', description: GOOD }],
    ['null', null],
    ['undefined', undefined],
  ])('is legacy: %s', (_n, request) => {
    expect(isNewMarineFormat(request)).toBe(false);
  });
  test('a request the validator produced is structured, and its history reads back exactly', () => {
    const { data } = run({ medicalHistory: '  Crew member, chest pain.\n' });
    expect(isNewMarineFormat(data)).toBe(true);
    expect(parseMarineDescription(data.description).history).toBe('  Crew member, chest pain.\n');
  });
  test('the other services\' own descriptions are never taken for Marine\'s', () => {
    for (const description of [
      'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology',
      'Home Healthcare v1 (address 5, history 0)\nComplete home address:\nHome1',
      'Transfer Scope: Domestic\nTransport Mode: Ground Transportation',
    ]) {
      expect(isNewMarineFormat({ serviceKey: 'marine', transferScope: 'domestic', description })).toBe(false);
    }
  });
});
