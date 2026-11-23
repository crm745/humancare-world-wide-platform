/* global describe, test, expect, jest, beforeEach */
// H3: Ground Ambulance and Commercial Air (stretcher / wheelchair) are validated on the server: contact number, preferred date, origin, destination and name. The pure validator is tested directly
// with a fixed clock, and the REAL controller (submitRequest) is tested with a recorder in place of the service layer, so a refused request is shown to save nothing and a valid current mobile
// body is shown to be saved exactly as sent. No database, no network.
const mockSaved = [];
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: jest.fn(), getVerifiedCity: jest.fn() }));
jest.mock('../../src/modules/requests/requests.service', () => ({
  createRequest: jest.fn(async (userId, data) => { const row = { id: mockSaved.length + 1, userId, ...data }; mockSaved.push(row); return { ...row, referenceNumber: `REQ-${1000 + row.id}`, status: 'submitted', createdAt: new Date(), case: null }; }),
  findRequestByClientRequestId: jest.fn(async () => null),
  listRequestsForUser: jest.fn(), getRequestForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));

const { submitRequest } = require('../../src/modules/requests/requests.controller');
const { validateTransportRequest, isTransportRequestKey, earliestDay } = require('../../src/modules/requests/transport-request.validation');

async function post(body) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user: { id: 7 } }, res, (err) => { out.err = err; });
  return out;
}
const NOW = new Date('2026-11-18T12:00:00.000Z');
const day = (n, from = NOW) => new Date(from.getTime() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const inDays = (n) => day(n, new Date());

// What the mobile app sends today (apps/mobile/src/app/request/review.js, the generic body): patientContact is `${cc} ${phone}`, preferredDate "YYYY-MM-DD".
const ground = (extra = {}, when = inDays(5)) => ({
  serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientAge: '61', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 9876543210',
  origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: when, careLevel: 'crit_icu,crit_ecmo', description: 'Needs transport.', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h', ...extra,
});
const commercial = (key, extra = {}, when = inDays(5)) => ({
  serviceType: `Medical Escort (Commercial Airlines) — ${key.split('_')[1]}`, serviceKey: key, patientName: 'John Doe', patientAge: '61', patientGender: 'Female', patientLocation: 'Mumbai', patientContact: '+971 501112222',
  origin: 'Mumbai', destination: 'Dubai', country: 'United Arab Emirates', preferredDate: when, careLevel: 'crit_ventilated', equipOxygen: false, equipCardiacMonitor: true, urgency: 'planned', ...extra,
});
const KEYS = ['ground', 'commercialair_stretcher', 'commercialair_wheelchair'];
const valid = (key, extra = {}, when) => (key === 'ground' ? ground(extra, when) : commercial(key, extra, when));
const errorOf = (key, extra, when = day(5)) => { const out = validateTransportRequest(valid(key, extra, when), { now: NOW }); return out ? out.error : undefined; };

beforeEach(() => { mockSaved.length = 0; });

describe('which services it applies to', () => {
  test('Ground Ambulance and both Commercial Air keys only', () => {
    expect(KEYS.every(isTransportRequestKey)).toBe(true);
    for (const other of ['air', 'hospital', 'privatecharter', 'tele', 'homecare', 'mortal', 'marine', 'medvalue', 'corporate', 'commercialair', '', undefined, null, 5, {}]) expect(isTransportRequestKey(other)).toBe(false);
    expect(validateTransportRequest({ serviceKey: 'hospital', patientName: '', patientContact: 'x' }, { now: NOW })).toBeNull();
    expect(validateTransportRequest(null)).toBeNull();
  });
});

describe('a valid current mobile body is accepted', () => {
  test.each(KEYS)('%s', (key) => { expect(validateTransportRequest(valid(key), { now: NOW })).toBeNull(); });
  test.each([
    ['India', '+91 9876543210'], ['India, with the spacing of the old tests', '+91 98765 43210'], ['UAE', '+971 501112222'], ['UK', '+44 7911123456'], ['US', '+1 2025550143'], ['Oman', '+968 92123456'], ['no space', '+919876543210'],
  ])('contact number: %s (%s)', (_name, number) => {
    for (const key of KEYS) expect(errorOf(key, { patientContact: number })).toBeUndefined();
  });
  test('the date: today, tomorrow, next year, and yesterday (the time-zone allowance) are accepted; the age and gender stay optional', () => {
    for (const offset of [-1, 0, 1, 365]) expect(errorOf('ground', {}, day(offset))).toBeUndefined();
    expect(errorOf('ground', { patientAge: undefined, patientGender: undefined })).toBeUndefined();
  });
  test.each(KEYS)('%s: through the controller it is saved exactly as sent (nothing reformatted)', async (key) => {
    const body = valid(key);
    const r = await post(body);
    expect({ status: r.status, error: r.body && r.body.error }).toEqual({ status: 201, error: undefined });
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ serviceKey: key, patientName: 'John Doe', patientContact: body.patientContact, origin: body.origin, destination: body.destination });
    expect(mockSaved[0].preferredDate).toBe(body.preferredDate); // the day string goes on to createRequest untouched
  });
});

describe('contact number', () => {
  const BAD = [['missing', undefined], ['null', null], ['empty', ''], ['spaces', '   '], ['letters', 'not a phone'], ['no country code', '9876543210'], ['too short', '+91 12345'], ['too long', '+91 98765432101234'],
    ['wrong for its country (India, 9 digits)', '+91 987654321'], ['a number', 9876543210], ['an object', {}], ['an array', ['+919876543210']], ['plus only', '+'], ['a script', '+91<script>alert(1)</script>']];
  test.each(KEYS)('%s: every bad value is refused with the same message', (key) => {
    for (const [name, value] of BAD) {
      expect({ name, error: errorOf(key, { patientContact: value }) }).toEqual({ name, error: 'patientContact must be a valid phone number with its country code' });
    }
  });
});

describe('preferred date', () => {
  test.each(KEYS)('%s: missing, blank, malformed, impossible and past dates are refused', (key) => {
    expect(errorOf(key, { preferredDate: undefined })).toBe('preferredDate is required');
    expect(errorOf(key, { preferredDate: null })).toBe('preferredDate is required');
    expect(errorOf(key, { preferredDate: '   ' })).toBe('preferredDate is required');
    for (const bad of ['tomorrow', '2026/12/01', '01-12-2026', '2026-1-5', '2026-12-01T10:30:00.000Z', '2026-13-01', '2026-02-30', '0000-00-00', 20261201, {}, ['2026-12-01']]) {
      expect({ bad, error: errorOf(key, { preferredDate: bad }) }).toEqual({ bad, error: expect.stringMatching(/^preferredDate (is required|must be a valid date)/) });
    }
    for (const past of [day(-2), day(-30), '2001-01-01']) expect({ past, error: errorOf(key, { preferredDate: past }) }).toEqual({ past, error: 'preferredDate cannot be in the past' });
  });
  test('the boundary: the day before yesterday (UTC) is past for everyone, yesterday is not', () => {
    expect(earliestDay(NOW)).toBe('2026-11-17');
    expect(errorOf('ground', { preferredDate: '2026-11-16' })).toBe('preferredDate cannot be in the past');
    expect(errorOf('ground', { preferredDate: '2026-11-17' })).toBeUndefined();
    const lateNight = new Date('2026-11-18T23:59:59.000Z');
    expect(validateTransportRequest(ground({ preferredDate: '2026-11-17' }), { now: lateNight })).toBeNull();
    expect(validateTransportRequest(ground({ preferredDate: '2026-11-16' }), { now: lateNight }).error).toMatch(/past/);
  });
});

describe('origin, destination and name', () => {
  test.each(KEYS)('%s: required, not blank, no control characters', (key) => {
    for (const field of ['origin', 'destination', 'patientName']) {
      for (const value of [undefined, null, '', '   ', '\n\t ']) expect({ field, value, error: errorOf(key, { [field]: value }) }).toEqual({ field, value, error: `${field} is required` });
      for (const value of [5, {}, ['Pune']]) expect({ field, value, error: errorOf(key, { [field]: value }) }).toEqual({ field, value, error: `${field} is required` });
      expect(errorOf(key, { [field]: 'Pune\u0000' })).toBe(`${field} contains characters that are not allowed`);
      expect(errorOf(key, { [field]: 'Pu\u0007ne' })).toBe(`${field} contains characters that are not allowed`);
      expect(errorOf(key, { [field]: 'Pune\uD800' })).toBe(`${field} contains characters that are not allowed`);
    }
  });
  test('a name needs a letter; other scripts are fine', () => {
    expect(errorOf('ground', { patientName: '12345' })).toBe('patientName must include a letter');
    expect(errorOf('ground', { patientName: '!!!' })).toBe('patientName must include a letter');
    for (const name of ['आशा नायर', 'أحمد علي', 'అనిల్ కుమార్', 'મીરા શાહ', 'José Núñez']) expect(errorOf('ground', { patientName: name })).toBeUndefined();
  });
  test('Unicode places are fine (typed in any language)', () => {
    expect(errorOf('ground', { origin: 'पुणे, भारत', destination: 'دبي، الإمارات' })).toBeUndefined();
  });
});

describe('through the controller: refused means nothing is saved', () => {
  test.each(KEYS)('%s: each defect is a 400 with its message', async (key) => {
    const cases = [
      [{ patientContact: '123' }, /patientContact must be a valid phone number/],
      [{ patientContact: undefined }, /patientContact must be a valid phone number/],
      [{ preferredDate: '2001-01-01' }, /preferredDate cannot be in the past/],
      [{ preferredDate: undefined }, /preferredDate is required/],
      [{ preferredDate: 'next week' }, /preferredDate must be a valid date/],
      [{ origin: '   ' }, /origin is required/],
      [{ destination: '' }, /Missing required field\(s\): destination|destination is required/],
      [{ patientName: '   ' }, /patientName is required/],
    ];
    for (const [extra, pattern] of cases) {
      const r = await post(valid(key, extra));
      expect({ extra, status: r.status }).toEqual({ extra, status: 400 });
      expect(r.body.error).toMatch(pattern);
    }
    expect(mockSaved).toHaveLength(0);
  });
  test('the earlier rules keep their own messages first (Ground needs its Present Medical Issue; Commercial Air its travel type)', async () => {
    expect((await post(ground({ description: '' }))).body.error).toMatch(/Present Medical Issue/);
    expect((await post(commercial('commercialair_stretcher', { serviceKey: 'commercialair' }))).body.error).toMatch(/Travel type is required/);
    expect(mockSaved).toHaveLength(0);
  });
  test('a bad number together with a past date reports one problem, and a hostile body cannot get around it with extra keys', async () => {
    expect((await post(ground({ patientContact: 'x', preferredDate: '2001-01-01' }))).status).toBe(400);
    expect((await post(ground({ patientContact: 'x', originGeonameId: 1 }))).status).toBe(400);
    expect(mockSaved).toHaveLength(0);
  });
  test('other services are unaffected: Hospitalization and the older "air" key still go through with no phone and no date', async () => {
    expect((await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' })).status).toBe(201);
    expect((await post({ serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' })).status).toBe(201);
    expect(mockSaved).toHaveLength(2);
  });
});
