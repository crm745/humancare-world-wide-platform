// Strict backend validation of Private Charter requests (serviceKey "privatecharter").
//
// These tests need no database: the route is reached with a signed patient token (requireAuth
// only verifies the JWT), the service layer is mocked, and so is the city lookup (it is tested
// against the real table in geo.service.test.js), so "no database write" is checked as
// "createRequest was never called". How the validated data is stored is covered by the
// database-backed tests in requests.test.js.
jest.mock('../src/modules/requests/requests.service', () => ({
  ...jest.requireActual('../src/modules/requests/requests.service'),
  createRequest: jest.fn(),
}));

// The city lookup answers from fixtures: a verified city for a known id, null for an unknown or
// historical one, and a 503 error where the city data is stale.
jest.mock('../src/modules/geo/geo.service', () => {
  const actual = jest.requireActual('../src/modules/geo/geo.service');
  const { IDS, ROWS } = require('./fixtures/geo-cities');
  const verified = (id) => {
    if (id === IDS.STALE_DATA) throw new actual.CityDataUnavailableError('city_data_stale', 'fixture');
    const found = ROWS.find((r) => r.geonameId === id);
    return found ? { geonameId: found.geonameId, name: found.name, label: actual.cityLabel(found), countryCode: found.countryCode, timezone: found.timezone } : null;
  };
  return {
    ...actual,
    resolveCityRefs: jest.fn(async (body) => {
      const idOf = (ref) => (ref && typeof ref === 'object' && Number.isInteger(ref.geonameId) ? ref.geonameId : null);
      return { origin: verified(idOf(body.origin)), destination: verified(idOf(body.destination)) };
    }),
  };
});

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src/app');
const { createRequest } = require('../src/modules/requests/requests.service');
const { validatePrivateCharterRequest } = require('../src/modules/requests/private-charter.validation');
const { resolveCityRefs, cityLabel } = require('../src/modules/geo/geo.service');
const { IDS, ROWS } = require('./fixtures/geo-cities');
const { CARE_LEVEL_LEGACY_LABELS } = require('../src/common/constants/request.constants');

const token = jwt.sign({ sub: 4242, role: 'patient' }, process.env.JWT_ACCESS_SECRET);
const post = (body) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);

// Three days ahead: later than "today" in any timezone on Earth, so the default request is valid.
const soon = () => new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString().slice(0, 10);

const verifiedCity = (id) => {
  const found = ROWS.find((r) => r.geonameId === id);
  return { geonameId: id, name: found.name, label: cityLabel(found), countryCode: found.countryCode, timezone: found.timezone };
};
// Calls the validator the way the controller does: with the verified cities for the two ids.
const validate = (body, options = {}) => {
  const idOf = (ref) => (ref && typeof ref === 'object' && Number.isInteger(ref.geonameId) && ROWS.some((r) => r.geonameId === ref.geonameId) ? ref.geonameId : null);
  const cities = {
    origin: idOf(body.origin) ? verifiedCity(idOf(body.origin)) : null,
    destination: idOf(body.destination) ? verifiedCity(idOf(body.destination)) : null,
  };
  return validatePrivateCharterRequest(body, { cities, ...options });
};

const valid = () => ({
  serviceKey: 'privatecharter',
  serviceType: 'Private Charter Air Ambulance Service',
  patientName: 'Maria Fernandez',
  patientAge: '47',
  patientGender: 'female',
  country: 'AE',
  origin: { geonameId: IDS.DUBAI },
  destination: { geonameId: IDS.MUMBAI },
  patientContact: '+971501234567',
  preferredDate: soon(),
  careLevel: ['care_icu'],
  description: 'Post-op, BP <90/60, on O2 2 L/min',
  mobility: 'bedridden',
  equipOxygen: true,
  equipCardiacMonitor: false,
  equipVentilator: false,
  urgency: 'critical_6h',
});

beforeEach(() => {
  createRequest.mockReset();
  createRequest.mockImplementation(async (userId, data) => ({ id: 1, referenceNumber: 'REQ-1001', ...data }));
  jest.spyOn(console, 'info').mockImplementation(() => {});
  // The global error handler logs every error it sees; broken-JSON cases would flood the output.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// A request that must be refused: 400, the shared shape, the named field, and nothing saved.
async function expectRefused(body, field) {
  const res = await post(body);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Please correct the highlighted fields.');
  expect(typeof res.body.fields[field]).toBe('string');
  expect(createRequest).not.toHaveBeenCalled();
  return res;
}

describe('Private Charter: accepted request', () => {
  it('passes the validated, normalised data to the service and answers 201', async () => {
    const res = await post(valid());
    expect(res.status).toBe(201);
    expect(createRequest).toHaveBeenCalledTimes(1);
    const [userId, data] = createRequest.mock.calls[0];
    expect(userId).toBe(4242);
    expect(data).toMatchObject({
      serviceKey: 'privatecharter',
      serviceType: 'Private Charter Air Ambulance Service',
      patientName: 'Maria Fernandez',
      patientAge: 47,
      patientGender: 'female',
      country: 'AE',
      patientContact: '+971501234567',
      careLevel: 'care_icu',
      mobility: 'bedridden',
      equipOxygen: true,
      urgency: 'critical_6h',
    });
  });

  it('accepts a request without optional fields and without serviceType (derived by the backend)', async () => {
    const body = valid();
    delete body.serviceType; delete body.description;
    delete body.equipOxygen; delete body.equipCardiacMonitor; delete body.equipVentilator;
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(createRequest.mock.calls[0][1].serviceType).toBe('Private Charter Air Ambulance Service');
  });

  it('accepts the date of today', () => {
    const { fields } = validate({ ...valid(), preferredDate: new Date().toISOString().slice(0, 10) });
    expect(fields.preferredDate).toBeUndefined();
  });
});

describe('Private Charter: every required field missing', () => {
  const required = ['patientName', 'patientAge', 'patientGender', 'country', 'origin', 'destination',
    'patientContact', 'preferredDate', 'careLevel', 'mobility', 'urgency'];

  it.each(required)('refuses a request without %s', async (field) => {
    const body = valid();
    delete body[field];
    await expectRefused(body, field);
  });

  it('reports all missing fields together', async () => {
    const res = await post({ serviceKey: 'privatecharter' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual([...required].sort());
  });

  it.each(required)('refuses an empty %s and a null %s', async (field) => {
    await expectRefused({ ...valid(), [field]: '' }, field);
    createRequest.mockClear();
    await expectRefused({ ...valid(), [field]: null }, field);
  });
});

describe('Private Charter: patient name', () => {
  it.each([
    ['one character', 'A'], ['only spaces', '    '], ['no letter', '12345'], ['symbols only', '--- ...'],
    ['101 characters', 'a'.repeat(101)], ['a number', 12345], ['an array', ['Maria']], ['an object', { a: 1 }], ['a boolean', true],
  ])('refuses %s', async (_label, value) => {
    await expectRefused({ ...valid(), patientName: value }, 'patientName');
  });

  it('accepts 2 and 100 characters, other scripts, and trims the ends', () => {
    expect(validate({ ...valid(), patientName: 'Li' }).fields.patientName).toBeUndefined();
    expect(validate({ ...valid(), patientName: 'a'.repeat(100) }).fields.patientName).toBeUndefined();
    const { data, fields } = validate({ ...valid(), patientName: '  أحمد بن علي  ' });
    expect(fields.patientName).toBeUndefined();
    expect(data.patientName).toBe('أحمد بن علي');
  });

  it('counts characters, not UTF-16 units', () => {
    const fiftyEmojiAndALetter = `a${'😀'.repeat(99)}`; // 100 characters, 199 UTF-16 units
    expect(validate({ ...valid(), patientName: fiftyEmojiAndALetter }).fields.patientName).toBeUndefined();
    expect(validate({ ...valid(), patientName: `${fiftyEmojiAndALetter}😀` }).fields.patientName).toBeDefined();
  });
});

describe('Private Charter: age', () => {
  it.each([
    ['0', 0], ['"0"', '0'], ['121', 121], ['"121"', '121'], ['negative', -5], ['"-5"', '-5'], ['decimal', 12.5], ['"12.5"', '12.5'],
    ['text', 'abc'], ['"1e2"', '1e2'], ['"0x10"', '0x10'], ['padded with spaces', ' 34 '], ['"+34"', '+34'], ['four digits', '0034'],
    ['true', true], ['false', false], ['an array', [34]], ['an empty array', []], ['an object', { n: 34 }], ['NaN-like', 'NaN'],
  ])('refuses %s', async (_label, value) => {
    await expectRefused({ ...valid(), patientAge: value }, 'patientAge');
  });

  it.each([[1, 1], ['1', 1], [120, 120], ['120', 120], [47, 47], ['047', 47]])('accepts %j as %j', (input, stored) => {
    const { data, fields } = validate({ ...valid(), patientAge: input });
    expect(fields.patientAge).toBeUndefined();
    expect(data.patientAge).toBe(stored);
  });
});

describe('Private Charter: gender', () => {
  it.each(['male', 'female', 'other'])('accepts %s', (gender) => {
    const { data, fields, legacy } = validate({ ...valid(), patientGender: gender });
    expect(fields.patientGender).toBeUndefined();
    expect(data.patientGender).toBe(gender);
    expect(legacy).not.toContain('patientGender');
  });

  it.each([['Male', 'male'], ['Female', 'female'], ['Other', 'other']])('accepts the legacy %s as %s and records it', (input, stored) => {
    const { data, fields, legacy } = validate({ ...valid(), patientGender: input });
    expect(fields.patientGender).toBeUndefined();
    expect(data.patientGender).toBe(stored);
    expect(legacy).toContain('patientGender');
  });

  it.each(['prefer_not_to_say', 'Prefer not to say', 'MALE', 'man', ' male', 'x', 1, true, ['male'], { g: 'male' }])('refuses %j', async (value) => {
    await expectRefused({ ...valid(), patientGender: value }, 'patientGender');
  });
});

describe('Private Charter: country', () => {
  it.each(['India', 'ae', 'AEE', 'A', 'ZZ', 'UAE', 1, ['AE'], {}])('refuses %j', async (value) => {
    await expectRefused({ ...valid(), country: value }, 'country');
  });
  it.each(['AE', 'IN', 'GB', 'US'])('accepts %s', (code) => {
    expect(validate({ ...valid(), country: code }).fields.country).toBeUndefined();
  });
});

describe('Private Charter: origin and destination cities', () => {
  const refused = (body, field) => expectRefused(body, field);

  it.each(['origin', 'destination'])('requires %s', async (field) => {
    const body = valid();
    delete body[field];
    await refused(body, field);
  });

  it.each(['origin', 'destination'])('refuses free text and other shapes for %s: only a picked city is accepted', async (field) => {
    for (const value of ['Mumbai', 'Mumbai, India', 123, true, ['Mumbai'], [{ geonameId: IDS.MUMBAI }], 'geonameId']) {
      const res = await refused({ ...valid(), [field]: value }, field);
      expect(res.body.fields[field]).toMatch(/Select a city/);
      createRequest.mockClear();
    }
  });

  it.each(['origin', 'destination'])('refuses anything next to geonameId in %s: names, countries and timezones are never taken from the client', async (field) => {
    for (const extra of [{ name: 'Mumbai' }, { countryCode: 'IN' }, { timezone: 'Asia/Kolkata' }, { label: 'Mumbai, India' }, { timeZoneId: 'UTC' }]) {
      const res = await refused({ ...valid(), [field]: { geonameId: IDS.MUMBAI, ...extra } }, field);
      expect(res.body.fields[field]).toMatch(/only/i);
      createRequest.mockClear();
    }
    await refused({ ...valid(), [field]: {} }, field);
  });

  it.each(['origin', 'destination'])('refuses a geonameId in %s that is not a positive whole number', async (field) => {
    for (const geonameId of ['1275339', '', 0, -5, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, true, null, [1275339], { id: 1 }]) {
      const res = await refused({ ...valid(), [field]: { geonameId } }, field);
      expect(res.body.fields[field]).toMatch(/geonameId|Send only|Select/);
      createRequest.mockClear();
    }
  });

  it.each(['origin', 'destination'])('refuses a city that does not exist or is historical, in %s', async (field) => {
    for (const geonameId of [IDS.NOT_IN_TABLE, IDS.HISTORICAL, 1]) {
      const res = await refused({ ...valid(), [field]: { geonameId } }, field);
      expect(res.body.fields[field]).toBe('Select a valid city from the list.');
      createRequest.mockClear();
    }
  });

  it('stores what the server verified, not what the client could say', async () => {
    const res = await post({ ...valid(), origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI } });
    expect(res.status).toBe(201);
    const data = createRequest.mock.calls[0][1];
    expect(data).toMatchObject({
      origin: 'Mumbai, Maharashtra, India',
      originGeonameId: IDS.MUMBAI,
      originCityName: 'Mumbai',
      originCountryCode: 'IN',
      originTimezone: 'Asia/Kolkata',
      destination: 'Dubai, United Arab Emirates',
      destinationGeonameId: IDS.DUBAI,
      destinationCityName: 'Dubai',
      destinationCountryCode: 'AE',
    });
    expect(data).not.toHaveProperty('destinationTimezone');
  });

  it('tells two cities of the same name apart by id', () => {
    const wellingtonNz = validate({ ...valid(), origin: { geonameId: IDS.WELLINGTON } }).data;
    const wellingtonUs = validate({ ...valid(), origin: { geonameId: 4177703 } }).data;
    expect(wellingtonNz).toMatchObject({ origin: 'Wellington, Wellington Region, New Zealand', originCountryCode: 'NZ', originTimezone: 'Pacific/Auckland' });
    expect(wellingtonUs).toMatchObject({ origin: 'Wellington, Florida, United States', originCountryCode: 'US', originTimezone: 'America/New_York' });
  });

  it('allows the same city for origin and destination', () => {
    const { fields } = validate({ ...valid(), origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.MUMBAI } });
    expect(fields.origin).toBeUndefined();
    expect(fields.destination).toBeUndefined();
  });

  it("does not require the patient's country to match the origin city's country", () => {
    for (const [country, origin] of [['AE', IDS.MUMBAI], ['IN', IDS.WELLINGTON], ['US', IDS.DUBAI]]) {
      const { fields } = validate({ ...valid(), country, origin: { geonameId: origin } });
      expect(fields.country).toBeUndefined();
      expect(fields.origin).toBeUndefined();
    }
  });

  it('refuses a looked-up city that is not the one the reference names', () => {
    const body = { ...valid(), origin: { geonameId: IDS.MUMBAI } };
    const { fields } = validatePrivateCharterRequest(body, { cities: { origin: verifiedCity(IDS.DUBAI), destination: verifiedCity(IDS.MUMBAI) } });
    expect(fields.origin).toBe('Select a valid city from the list.');
  });

  it('refuses an origin whose record has no usable timezone', () => {
    const body = { ...valid(), origin: { geonameId: IDS.DUBAI } };
    const unknownZone = validatePrivateCharterRequest(body, { cities: { origin: { ...verifiedCity(IDS.DUBAI), timezone: 'Mars/Olympus' }, destination: verifiedCity(IDS.MUMBAI) } });
    expect(unknownZone.fields.origin).toMatch(/timezone/);
    const blank = validatePrivateCharterRequest(body, { cities: { origin: { ...verifiedCity(IDS.DUBAI), timezone: '' }, destination: verifiedCity(IDS.MUMBAI) } });
    expect(blank.fields.origin).toMatch(/timezone/);
  });

  it('answers 503 with a code, and saves nothing, when the city data is stale or missing', async () => {
    const res = await post({ ...valid(), origin: { geonameId: IDS.STALE_DATA } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'City verification is temporarily unavailable. Please try again later.', code: 'city_data_stale' });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('looks the cities up before it judges the other fields', async () => {
    resolveCityRefs.mockClear();
    await post({ ...valid(), patientAge: 'x' });
    expect(resolveCityRefs).toHaveBeenCalledTimes(1);
  });

  it('never looks cities up for another service', async () => {
    resolveCityRefs.mockClear();
    await post({ serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'J', origin: 'a', destination: 'b' });
    expect(resolveCityRefs).not.toHaveBeenCalled();
  });
});

describe('Private Charter: contact number', () => {
  it.each([
    ['no country code', '501234567'], ['national format', '0501234567'], ['too short', '+97150'], ['letters', '+97150abc4567'],
    ['too long', '+9715012345678901234567890123456789'], ['a number', 971501234567], ['an array', ['+971501234567']], ['invalid number', '+910000000000'],
  ])('refuses %s', async (_label, value) => {
    await expectRefused({ ...valid(), patientContact: value }, 'patientContact');
  });

  it('stores E.164 and records the legacy spaced format', () => {
    const { data, fields, legacy } = validate({ ...valid(), patientContact: '+971 50 123 4567' });
    expect(fields.patientContact).toBeUndefined();
    expect(data.patientContact).toBe('+971501234567');
    expect(legacy).toContain('patientContact');
  });

  it('does not record a number that is already E.164', () => {
    expect(validate(valid()).legacy).not.toContain('patientContact');
  });
});

describe('Private Charter: preferred date', () => {
  const withOrigin = (origin, preferredDate) => ({ ...valid(), origin: { geonameId: origin }, preferredDate });
  const dateError = (origin, preferredDate, now) => validate(withOrigin(origin, preferredDate), { now }).fields.preferredDate;

  it.each([
    ['not a date', 'tomorrow'], ['wrong separator', '2030/01/01'], ['with a time', '2030-01-01T10:00:00Z'], ['impossible day', '2030-02-30'],
    ['impossible month', '2030-13-01'], ['day zero', '2030-01-00'], ['two-digit year', '30-01-01'], ['a number', 20300101], ['an array', ['2030-01-01']],
    ['padded', ' 2030-01-01'], ['29 February of a common year', '2031-02-29'],
  ])('refuses %s', async (_label, value) => {
    await expectRefused({ ...valid(), preferredDate: value }, 'preferredDate');
  });

  it('refuses a date in the past', async () => {
    const res = await expectRefused({ ...valid(), preferredDate: '2020-01-01' }, 'preferredDate');
    expect(res.body.fields.preferredDate).toMatch(/past/);
  });

  it('accepts a leap day and keeps the value as the plain date string', () => {
    const { data, fields } = validate({ ...valid(), preferredDate: '2032-02-29' });
    expect(fields.preferredDate).toBeUndefined();
    expect(data.preferredDate).toBe('2032-02-29');
  });

  it('accepts the date of today in the origin city', () => {
    const now = Date.UTC(2030, 5, 10, 12, 0, 0);
    expect(dateError(IDS.DUBAI, '2030-06-10', now)).toBeUndefined();
    expect(dateError(IDS.DUBAI, '2030-06-09', now)).toMatch(/past/);
  });

  describe("is judged in the origin city's own timezone: one instant, 10 June 2030 03:00 UTC", () => {
    const now = Date.UTC(2030, 5, 10, 3, 0, 0);
    it.each([
      // [origin, the date it is there at that instant]
      ['Auckland (UTC+12)', IDS.AUCKLAND, '2030-06-10'],
      ['Wellington NZ (UTC+12)', IDS.WELLINGTON, '2030-06-10'],
      ['Kiritimati (UTC+14)', IDS.KIRITIMATI, '2030-06-10'],
      ['Mumbai (UTC+5:30)', IDS.MUMBAI, '2030-06-10'],
      ['Los Angeles (UTC-7)', IDS.LOS_ANGELES, '2030-06-09'],
      ['New York (UTC-4)', IDS.NEW_YORK, '2030-06-09'],
      ['Pago Pago (UTC-11)', IDS.PAGO_PAGO, '2030-06-09'],
    ])('%s', (_label, origin, localToday) => {
      const yesterday = localToday === '2030-06-10' ? '2030-06-09' : '2030-06-08';
      expect(dateError(origin, localToday, now)).toBeUndefined();
      expect(dateError(origin, yesterday, now)).toMatch(/past/);
    });

    it('the same 9 June is fine from Los Angeles and already past from Auckland', () => {
      expect(dateError(IDS.LOS_ANGELES, '2030-06-09', now)).toBeUndefined();
      expect(dateError(IDS.AUCKLAND, '2030-06-09', now)).toMatch(/past/);
      expect(dateError(IDS.KIRITIMATI, '2030-06-09', now)).toMatch(/past/);
      expect(dateError(IDS.PAGO_PAGO, '2030-06-09', now)).toBeUndefined();
    });

    it("the destination's timezone plays no part", () => {
      const body = { ...valid(), origin: { geonameId: IDS.LOS_ANGELES }, destination: { geonameId: IDS.AUCKLAND }, preferredDate: '2030-06-09' };
      expect(validate(body, { now }).fields.preferredDate).toBeUndefined();
    });
  });

  it('flips exactly at local midnight (Los Angeles midnight is 07:00 UTC in June)', () => {
    const justBefore = Date.UTC(2030, 5, 10, 6, 59, 59, 999);
    const atMidnight = Date.UTC(2030, 5, 10, 7, 0, 0, 0);
    expect(dateError(IDS.LOS_ANGELES, '2030-06-09', justBefore)).toBeUndefined();
    expect(dateError(IDS.LOS_ANGELES, '2030-06-09', atMidnight)).toMatch(/past/);
    expect(dateError(IDS.LOS_ANGELES, '2030-06-10', atMidnight)).toBeUndefined();
  });

  it('follows daylight saving: Auckland midnight is 11:00 UTC on 6 April 2030 (NZDT), 12:00 UTC in winter', () => {
    expect(dateError(IDS.AUCKLAND, '2030-04-06', Date.UTC(2030, 3, 6, 10, 59, 59))).toBeUndefined();
    expect(dateError(IDS.AUCKLAND, '2030-04-06', Date.UTC(2030, 3, 6, 11, 0, 0))).toMatch(/past/);
    expect(dateError(IDS.AUCKLAND, '2030-07-06', Date.UTC(2030, 6, 6, 11, 0, 0))).toBeUndefined();
    expect(dateError(IDS.AUCKLAND, '2030-07-06', Date.UTC(2030, 6, 6, 12, 0, 0))).toMatch(/past/);
  });

  it('does not judge the day without a verified origin: the origin field carries the error', () => {
    const { fields } = validate({ ...valid(), origin: { geonameId: IDS.NOT_IN_TABLE }, preferredDate: '2020-01-01' });
    expect(fields.origin).toBeDefined();
    expect(fields.preferredDate).toBeUndefined();
    expect(validate({ ...valid(), origin: 'Mumbai', preferredDate: 'nonsense' }).fields.preferredDate).toMatch(/YYYY-MM-DD/);
  });

  it('hands the plain YYYY-MM-DD string on, untouched (the DATE column and the timezone round trip are tested in private-charter-dates.test.js)', () => {
    const { data } = validate({ ...valid(), preferredDate: '2031-12-31' });
    expect(data.preferredDate).toBe('2031-12-31');
  });
});

describe('Private Charter: care level', () => {
  it.each([
    ['unknown key', ['care_vip']], ['empty array', []], ['an empty string', ''], ['duplicate keys', ['care_icu', 'care_icu']],
    ['care_na with another', ['care_na', 'care_icu']], ['another with care_na', ['care_stable', 'care_na']],
    ['a number in the list', ['care_icu', 3]], ['an object', { care_icu: true }], ['a number', 1], ['a boolean', true],
    ['a key among the legacy labels', 'care_icu'], ['an unknown label', 'Intensive'], ['a label and an unknown label', 'ICU / Critical, Intensive'],
  ])('refuses %s', async (_label, value) => {
    await expectRefused({ ...valid(), careLevel: value }, 'careLevel');
  });

  it('accepts several keys and stores them joined', () => {
    const { data, fields } = validate({ ...valid(), careLevel: ['care_icu', 'care_stable'] });
    expect(fields.careLevel).toBeUndefined();
    expect(data.careLevel).toBe('care_icu,care_stable');
  });

  it('accepts care_na on its own', () => {
    expect(validate({ ...valid(), careLevel: ['care_na'] }).data.careLevel).toBe('care_na');
  });

  it('turns the legacy joined labels of every app language into keys and records it', () => {
    for (const [key, labels] of Object.entries(CARE_LEVEL_LEGACY_LABELS)) {
      for (const label of labels) {
        const { data, fields, legacy } = validate({ ...valid(), careLevel: label });
        expect(fields.careLevel).toBeUndefined();
        expect(data.careLevel).toBe(key);
        expect(legacy).toContain('careLevel');
      }
    }
    const { data } = validate({ ...valid(), careLevel: 'ICU / गंभीर, स्थिर / निगरानी में' });
    expect(data.careLevel).toBe('care_icu,care_stable');
  });

  it('still applies the duplicate and exclusivity rules to legacy labels', () => {
    expect(validate({ ...valid(), careLevel: 'Not Applicable, ICU / Critical' }).fields.careLevel).toBeDefined();
    expect(validate({ ...valid(), careLevel: 'ICU / Critical, ICU / गंभीर' }).fields.careLevel).toBeDefined();
  });

  it('covers every care_* label of every language in the mobile app', () => {
    const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'mobile', 'src', 'data', 'i18n.json'), 'utf8'));
    for (const strings of Object.values(i18n)) {
      for (const key of Object.keys(CARE_LEVEL_LEGACY_LABELS)) {
        expect(CARE_LEVEL_LEGACY_LABELS[key].map((l) => l.normalize('NFC'))).toContain(strings[key].normalize('NFC'));
      }
    }
  });
});

describe('Private Charter: medical description', () => {
  it('keeps clinical punctuation, symbols and Unicode exactly', () => {
    const text = 'BP <90/60 mmHg; SpO₂ ≥ 94% (O2 2 L/min) — pt "stable" & alert.\nHb 8.5 g/dL → transfuse 2 U\nالمريض يعاني من ألم 🙂 ñ ü 患者 <script>';
    const { data, fields } = validate({ ...valid(), description: text });
    expect(fields.description).toBeUndefined();
    expect(data.description).toBe(text);
  });

  it('trims only the surrounding whitespace', () => {
    expect(validate({ ...valid(), description: '  \n  BP <90 \t ' }).data.description).toBe('BP <90');
  });

  it('is optional: absent, null and blank are left empty', () => {
    for (const description of [undefined, null, '', '   ']) {
      const { data, fields } = validate({ ...valid(), description });
      expect(fields.description).toBeUndefined();
      expect(data.description).toBeUndefined();
    }
  });

  it('allows 2,000 characters and refuses 2,001, counting characters', () => {
    expect(validate({ ...valid(), description: 'a'.repeat(2000) }).fields.description).toBeUndefined();
    expect(validate({ ...valid(), description: 'a'.repeat(2001) }).fields.description).toBeDefined();
    expect(validate({ ...valid(), description: '😀'.repeat(2000) }).fields.description).toBeUndefined();
    expect(validate({ ...valid(), description: '😀'.repeat(2001) }).fields.description).toBeDefined();
  });

  it.each([['a NUL character', 'pt stable\u0000'], ['a number', 90], ['an array', ['BP <90']], ['an object', { text: 'x' }], ['a boolean', false]])(
    'refuses %s', async (_label, value) => { await expectRefused({ ...valid(), description: value }, 'description'); },
  );
});

describe('Private Charter: mobility, urgency and equipment', () => {
  it.each([['mobility', 'crawling'], ['mobility', 'Walking'], ['mobility', ['walking']], ['mobility', 1],
    ['urgency', 'urgent'], ['urgency', 'critical'], ['urgency', 'routine'], ['urgency', 'URGENT_24H'], ['urgency', ['planned']]])(
    'refuses %s = %j', async (field, value) => { await expectRefused({ ...valid(), [field]: value }, field); },
  );

  it.each(['bedridden', 'wheelchair', 'walking'])('accepts mobility %s', (mobility) => {
    expect(validate({ ...valid(), mobility }).data.mobility).toBe(mobility);
  });

  it.each(['critical_6h', 'urgent_24h', 'planned'])('keeps urgency %s as it is', (urgency) => {
    expect(validate({ ...valid(), urgency }).data.urgency).toBe(urgency);
  });

  it.each(['equipOxygen', 'equipCardiacMonitor', 'equipVentilator'])('requires %s to be a strict boolean', async (field) => {
    for (const value of ['true', 'false', 1, 0, 'yes', null, [], {}]) {
      await expectRefused({ ...valid(), [field]: value }, field);
      createRequest.mockClear();
    }
    expect(validate({ ...valid(), [field]: true }).data[field]).toBe(true);
    expect(validate({ ...valid(), [field]: false }).data[field]).toBe(false);
  });
});

describe('Private Charter: service key and type', () => {
  it('refuses a serviceType that is not the Private Charter name', async () => {
    await expectRefused({ ...valid(), serviceType: 'Air Ambulance' }, 'serviceType');
    createRequest.mockClear();
    await expectRefused({ ...valid(), serviceType: 'Ground Ambulance (GA)' }, 'serviceType');
  });

  it('refuses the Private Charter name under another key, including the legacy "air"', async () => {
    for (const serviceKey of ['air', 'ground', 'commercialair_stretcher', undefined]) {
      const body = valid();
      if (serviceKey === undefined) delete body.serviceKey; else body.serviceKey = serviceKey;
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.fields.serviceKey).toBeDefined();
      expect(createRequest).not.toHaveBeenCalled();
    }
  });

  it('does not treat "air" as Private Charter, and its own validation stays the old one', async () => {
    const res = await post({ serviceKey: 'air', serviceType: 'Air Ambulance', patientName: 'A', origin: 'x', destination: 'y' });
    expect(res.status).toBe(201);
    expect(createRequest.mock.calls[0][1]).toMatchObject({ serviceKey: 'air', patientName: 'A' });
  });

  it('refuses near-miss keys at the shared unknown-key check', async () => {
    for (const serviceKey of ['PrivateCharter', 'privatecharter ', 'privatecharter_x']) {
      const res = await post({ ...valid(), serviceKey });
      expect(res.status).toBe(400);
      expect(createRequest).not.toHaveBeenCalled();
    }
  });
});

describe('Private Charter: unknown and deceased fields', () => {
  it.each(['Dubai, UAE', '', null, 5, ['Dubai']])('refuses patientLocation = %j with a message that points to origin', async (value) => {
    const res = await expectRefused({ ...valid(), patientLocation: value }, 'patientLocation');
    expect(res.body.fields.patientLocation).toMatch(/origin/);
  });

  it('does not store patientLocation: it is not in the validated data', () => {
    const { data } = validate(valid());
    expect(data).not.toHaveProperty('patientLocation');
  });

  it('keeps accepting patientLocation for other services', async () => {
    const res = await post({ serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'J', origin: 'a', destination: 'b', patientLocation: 'a' });
    expect(res.status).toBe(201);
    expect(createRequest.mock.calls[0][1].patientLocation).toBe('a');
  });

  it.each(['deceasedRelation', 'placeOfDeath', 'dateOfDeath'])('refuses %s with its own message', async (field) => {
    const res = await expectRefused({ ...valid(), [field]: 'Brother' }, field);
    expect(res.body.fields[field]).toMatch(/Deceased/);
  });

  it.each([['status', 'completed'], ['userId', 1], ['referenceNumber', 'REQ-1'], ['bitrixLeadId', 5], ['extraInfo', 'x'], ['specialRequirements', 'x'], ['unknownThing', 1]])(
    'refuses the unknown field %s instead of dropping it', async (field, value) => {
      const res = await expectRefused({ ...valid(), [field]: value }, field);
      expect(res.body.fields[field]).toMatch(/not accepted/);
    },
  );

  it('reports an unknown field alongside other errors and echoes a long key only in part', async () => {
    const longKey = 'k'.repeat(500);
    const res = await post({ ...valid(), patientAge: 'x', [longKey]: 1 });
    expect(res.status).toBe(400);
    expect(res.body.fields.patientAge).toBeDefined();
    expect(Object.keys(res.body.fields).every((key) => key.length <= 64)).toBe(true);
  });

  it('handles a "__proto__" key in the JSON without crashing', async () => {
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json').send(`{"serviceKey":"privatecharter","__proto__":{"x":1}}`);
    expect(res.status).toBe(400);
    expect(Object.hasOwn(res.body.fields, '__proto__')).toBe(true);
    expect(res.body.fields.__proto__).toBe('This field is not accepted for Private Charter requests.');
  });
});

describe('Private Charter: bodies that are missing or malformed', () => {
  it.each([
    ['no body at all', null],
    ['a text body', 'serviceKey=privatecharter'],
  ])('answers 400, not 500, for %s', async (_label, body) => {
    let req = request(app).post('/requests').set('Authorization', `Bearer ${token}`);
    if (body !== null) req = req.set('Content-Type', 'text/plain').send(body);
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({});
    expect(createRequest).not.toHaveBeenCalled();
  });

  it.each([['an array', '[1,2]'], ['null', 'null'], ['a number', '5'], ['a string', '"x"']])('answers 400 for JSON that is %s', async (_label, json) => {
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send(json);
    expect(res.status).toBe(400);
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('answers 400 for broken JSON, with no database or stack details', async () => {
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send('{"serviceKey": ');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|at .*\.js/i);
    expect(createRequest).not.toHaveBeenCalled();
  });
});

describe('Private Charter: no write when validation fails', () => {
  it('never reaches the service for any refused request', async () => {
    const bad = [
      { ...valid(), patientAge: 0 }, { ...valid(), patientGender: 'x' }, { ...valid(), careLevel: ['care_na', 'care_icu'] },
      { ...valid(), preferredDate: '2020-01-01' }, { ...valid(), dateOfDeath: '2026-01-01' }, { ...valid(), urgency: 'urgent' },
    ];
    for (const body of bad) expect((await post(body)).status).toBe(400);
    expect(createRequest).not.toHaveBeenCalled();
  });
});

describe('Other services are untouched', () => {
  it('passes the request body to the service exactly as before', async () => {
    const body = { serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'J', patientAge: '40', patientGender: 'Male', origin: 'a', destination: 'b', mobility: 'walking', careLevel: 'ICU / Critical' };
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(createRequest).toHaveBeenCalledWith(4242, body);
  });

  it('keeps the old rules: required fields, unknown service key, mortal and medical checks', async () => {
    expect((await post({ serviceType: 'Air Ambulance' })).status).toBe(400);
    expect((await post({ serviceType: 'x', serviceKey: 'nope', patientName: 'a', origin: 'o', destination: 'd' })).body.error).toBe('Unknown serviceKey');
    expect((await post({ serviceType: 'x', serviceKey: 'mortal_domestic', patientName: 'a', origin: 'o', destination: 'd' })).status).toBe(400);
    expect((await post({ serviceType: 'x', serviceKey: 'tele', patientName: 'a', origin: 'o', destination: 'd', mobility: 'walking' })).status).toBe(400);
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('does not reject other services for fields Private Charter forbids', async () => {
    const res = await post({
      serviceType: 'Mortal Remains', serviceKey: 'mortal_domestic', patientName: 'Late S', origin: 'o', destination: 'd',
      deceasedRelation: 'Brother', placeOfDeath: 'Pune', dateOfDeath: '2026-10-20', someFutureField: 1,
    });
    expect(res.status).toBe(201);
  });
});
