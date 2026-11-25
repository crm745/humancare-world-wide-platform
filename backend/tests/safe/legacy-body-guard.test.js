/* global describe, test, expect, jest, beforeEach */
// H2: a request for Teleconsultation, Medical Value Travel, Marine Medical Safety or Corporate Medical Solutions can no longer skip that service's own validator by leaving out the structured
// fields (the generic body of an older app build) or by naming the service only in serviceType. The REAL controller (submitRequest), the real validators and the real guard run; the service layer
// is a recorder, so nothing is saved anywhere. No database, no network.
const mockSaved = [];
const mockExisting = new Map();
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: jest.fn(), getVerifiedCity: jest.fn() }));
jest.mock('../../src/modules/requests/requests.service', () => ({
  createRequest: jest.fn(async (userId, data) => { const row = { id: mockSaved.length + 1, userId, ...data }; mockSaved.push(row); return { ...row, referenceNumber: `REQ-${1000 + row.id}`, status: 'submitted', createdAt: new Date(), case: null }; }),
  findRequestByClientRequestId: jest.fn(async (userId, key) => mockExisting.get(`${userId}:${key}`) || null),
  listRequestsForUser: jest.fn(), getRequestForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));

const { submitRequest } = require('../../src/modules/requests/requests.controller');
const { legacyBypassProblem, STRICT_SERVICES } = require('../../src/modules/requests/legacy-body-guard');

async function post(body, user = { id: 7 }) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user }, res, (err) => { out.err = err; });
  return out;
}
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const utc = () => 0 - new Date().getTimezoneOffset();

// One valid, current-format body per service (typed cities: no lookups).
const VALID = {
  tele: () => ({ serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationScope: 'international', consultationType: 'online', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210', currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', preferredDate: null, utcOffsetMinutes: utc() }),
  medvalue: () => ({ serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN', patientContact: '+91 98765 43210', currentCity: { text: 'Pune' }, destinationCity: { text: 'Singapore' }, specialty: 'Oncology', utcOffsetMinutes: utc() }),
  marine: () => ({ serviceType: 'Marine Medical Safety', serviceKey: 'marine', serviceScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN', patientContact: '+91 98765 43210', originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Singapore' }, utcOffsetMinutes: utc() }),
  corporate: () => ({ serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female', programmes: ['doctor', 'nurse'], patientContact: '+91 98765 43210', preferredDate: inDays(10), utcOffsetMinutes: utc(), officeAddress: 'Plot 14, Andheri East,\nMumbai 400069', officeCountry: 'IN' }),
};
// The old generic body of each service.
const generic = (key, extra = {}) => ({ serviceType: STRICT_SERVICES[key], serviceKey: key, patientName: 'John Doe', patientAge: '40', origin: 'Pune', destination: 'Mumbai', description: 'Needs help.', ...extra });
const KEYS = Object.keys(STRICT_SERVICES);

beforeEach(() => { mockSaved.length = 0; mockExisting.clear(); });

describe('valid current-format requests are still accepted (nothing a patient sends today changes)', () => {
  test.each(KEYS)('%s', async (key) => {
    const r = await post(VALID[key]());
    expect({ key, status: r.status, error: r.body && r.body.error }).toEqual({ key, status: 201, error: undefined });
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0].serviceKey).toBe(key);
  });
  test('the deliberate rules of each service still hold: a bad phone and a past date are refused', async () => {
    for (const key of KEYS) {
      const phone = await post({ ...VALID[key](), patientContact: '12345' });
      expect({ key, status: phone.status }).toEqual({ key, status: 400 });
    }
    expect((await post({ ...VALID.corporate(), preferredDate: '2001-01-01' })).status).toBe(400);
    expect((await post({ ...VALID.medvalue(), preferredDate: '2001-01-01' })).status).toBe(400);
    expect((await post({ ...VALID.marine(), preferredDate: '2001-01-01' })).status).toBe(400);
    expect((await post({ ...VALID.tele(), consultationType: 'house_call', preferredDate: '2001-01-01' })).status).toBe(400);
    expect(mockSaved).toHaveLength(0);
  });
});

describe('the generic body of each service is refused and nothing is saved', () => {
  test.each(KEYS)('%s: the old generic body (key, no structured field)', async (key) => {
    const r = await post(generic(key));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('app_update_required');
    expect(r.body.error).toMatch(/update the app/i);
    expect(r.body.fields.serviceKey).toMatch(STRICT_SERVICES[key]);
    expect(mockSaved).toHaveLength(0);
  });
  test.each(KEYS)('%s: a generic body that would have had no phone, no date and none of the required fields', async (key) => {
    for (const body of [{ serviceType: STRICT_SERVICES[key], serviceKey: key, patientName: 'x', origin: 'a', destination: 'b' }, { serviceType: STRICT_SERVICES[key], serviceKey: key, patientContact: 'abc', preferredDate: '2001-01-01', patientName: 'x', origin: 'a', destination: 'b' }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mockSaved).toHaveLength(0);
  });
  test.each(KEYS)('%s: an empty structured marker does not turn the generic path back on (the strict validator judges it)', async (key) => {
    const markers = { tele: { consultationType: undefined, consultationScope: null }, medvalue: { treatmentScope: null }, marine: { serviceScope: null }, corporate: { companyName: null } }[key];
    const r = await post(generic(key, markers));
    expect(r.status).toBe(400);
    expect(r.body.code).not.toBe('app_update_required'); // it WAS routed to the strict validator, which refuses it on its own rules
    expect(mockSaved).toHaveLength(0);
  });
});

describe('naming the service in serviceType with another key (or none) is refused, never relabelled', () => {
  const OTHER_KEYS = [undefined, null, '', 'ground', 'hospital', 'air', 'commercialair_stretcher', 'privatecharter-x'];
  test.each(KEYS)('%s', async (key) => {
    for (const serviceKey of OTHER_KEYS) {
      const r = await post({ serviceType: STRICT_SERVICES[key], ...(serviceKey === undefined ? {} : { serviceKey }), patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', description: 'x' });
      expect({ key, serviceKey, status: r.status }).toEqual({ key, serviceKey, status: 400 });
      expect(r.body.fields.serviceKey).toContain(`"${key}"`);
    }
    expect(mockSaved).toHaveLength(0);
  });
  test('case, spacing and Unicode width variants of the name are caught too', async () => {
    for (const serviceType of ['marine medical safety', '  Marine   Medical Safety  ', 'MARINE MEDICAL SAFETY', 'Ｍarine Medical Safety']) {
      const r = await post({ serviceType, serviceKey: 'hospital', patientName: 'J', origin: 'a', destination: 'b' });
      expect({ serviceType, status: r.status }).toEqual({ serviceType, status: 400 });
    }
  });
  test('other services are unaffected: Ground Ambulance, Hospitalization, the old "air" key and a body with no serviceKey and a different serviceType still go through the generic path', async () => {
    expect((await post({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientContact: '+91 98765 43210', preferredDate: inDays(30), origin: 'Pune', destination: 'Mumbai', description: 'Needs transport.' })).status).toBe(201);
    expect((await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' })).status).toBe(201);
    expect((await post({ serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' })).status).toBe(201);
    expect((await post({ serviceType: 'Ground Ambulance', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', description: 'x' })).status).toBe(201);
  });
});

describe('idempotent replays are not affected', () => {
  test('a retry whose original was already saved gets that request back (200), without being judged again', async () => {
    const key = '11111111-1111-4111-8111-111111111111';
    mockExisting.set(`7:${key}`, { id: 5, userId: 7, serviceKey: 'tele', serviceType: STRICT_SERVICES.tele, referenceNumber: 'REQ-1005', status: 'submitted', patientName: 'Asha Nair', createdAt: new Date(), case: null });
    const r = await post({ ...VALID.tele(), clientRequestId: key });
    expect(r.status).toBe(200);
    expect(mockSaved).toHaveLength(0);
  });
  test('a new current-format submission with a clientRequestId is saved once', async () => {
    const r = await post({ ...VALID.marine(), clientRequestId: '22222222-2222-4222-8222-222222222222' });
    expect(r.status).toBe(201);
    expect(mockSaved).toHaveLength(1);
  });
});

describe('the guard on its own', () => {
  test('it ignores anything that is not an object and returns null for every other service', () => {
    for (const value of [null, undefined, 5, 'x']) expect(legacyBypassProblem(value)).toBeNull();
    expect(legacyBypassProblem({ serviceKey: 'ground', serviceType: 'Ground Ambulance' })).toBeNull();
    expect(legacyBypassProblem({ serviceKey: 'homecare', serviceType: 'Home Healthcare Services' })).toBeNull();
    expect(legacyBypassProblem({ serviceKey: 'Object.prototype' })).toBeNull();
    expect(legacyBypassProblem({ serviceKey: 'constructor', serviceType: 'x' })).toBeNull();
    expect(legacyBypassProblem({ serviceKey: 'toString' })).toBeNull(); // inherited names are not service keys
  });
});
