// The generic create path through the REAL controller (submitRequest) and the REAL createRequest, with NO database: Prisma is replaced by a recorder that keeps what would have been written,
// and the GeoNames lookup by a small table. Run with a Jest configuration that skips the database setup (the setup in jest.config.js would empty humancare_test).
process.env.BITRIX_SYNC_ENABLED = 'false';
process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';

const mockStore = { rows: [], cases: [], nextId: 100, creates: 0 };
jest.mock('../src/db/prisma', () => {
  const prisma = {
    serviceRequest: {
      create: async ({ data }) => { mockStore.creates += 1; const row = { id: mockStore.nextId++, createdAt: new Date('2026-11-18T10:00:00Z'), updatedAt: new Date('2026-11-18T10:00:00Z'), ...data }; mockStore.rows.push(row); return { ...row }; },
      update: async ({ where, data }) => { const row = mockStore.rows.find((r) => r.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    case: { create: async ({ data }) => { const row = { id: mockStore.cases.length + 1, ...data }; mockStore.cases.push(row); return row; } },
    caseStageEvent: { create: async () => ({}) },
  };
  // createRequest saves the request, its Case and its first stage event in one transaction: the mock runs the callback on itself (the recorder keeps what each call would have written).
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma };
});
const mockCities = {
  1: { geonameId: 1, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
  3: { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai' },
};
jest.mock('../src/modules/geo/geo.service', () => ({
  resolveCityRefs: async () => ({}),
  getVerifiedCity: async (id) => mockCities[id] || null,
}));

const { submitRequest } = require('../src/modules/requests/requests.controller');

let infoSpy;
beforeEach(() => {
  mockStore.rows.length = 0; mockStore.cases.length = 0; mockStore.nextId = 100; mockStore.creates = 0;
  infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => infoSpy.mockRestore());

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
async function post(body) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user: { id: 7 } }, res, (err) => { out.err = err; });
  return out;
}
const stored = () => mockStore.rows[mockStore.rows.length - 1];
// Ground Ambulance and Commercial Air need a valid contact number and a date that is not in the past (transport-request.validation.js).
const CONTACT = '+91 98765 43210';
const FUTURE_DAY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const logged = () => infoSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[generic-request]'));

// Teleconsultation, Medical Value Travel, Marine and Corporate Medical Solutions are NOT here any more: their generic body is refused (tests/legacy-body-guard.test.js).
describe('valid generic bodies are saved exactly as before', () => {
  // [name, body, the columns the row must hold]
  const GOLDEN = [
    ['Ground Ambulance (the whole mobile body)', { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientAge: '61', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: FUTURE_DAY, careLevel: 'crit_icu,crit_ecmo', description: 'Needs transport.', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h' },
      { serviceKey: 'ground', patientAge: 61, patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', country: 'India', careLevel: 'crit_icu,crit_ecmo', description: 'Needs transport.', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h', mobility: null, equipCardiacMonitor: null, equipVentilator: null }],
    ['Commercial Air stretcher', { serviceType: 'Medical Escort (Commercial Airlines) — Stretcher (CAS)', serviceKey: 'commercialair_stretcher', patientName: 'John Doe', patientAge: '61', patientGender: 'Female', patientLocation: 'Mumbai', patientContact: '+971 50 111 2222', origin: 'Mumbai', destination: 'Dubai', country: 'United Arab Emirates', preferredDate: FUTURE_DAY, careLevel: 'crit_ventilated', equipOxygen: false, equipCardiacMonitor: true, urgency: 'planned' },
      { serviceKey: 'commercialair_stretcher', patientAge: 61, careLevel: 'crit_ventilated', equipOxygen: false, equipOxygenLpm: null, equipCardiacMonitor: true, equipVentilator: null, urgency: 'planned', country: 'United Arab Emirates' }],
    ['Hospitalization', { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', patientAge: '40', patientGender: 'Male', origin: 'Pune', destination: 'Pune', description: 'Planned admission.', urgency: 'planned' },
      { serviceKey: 'hospital', patientAge: 40, description: 'Planned admission.', urgency: 'planned', careLevel: null, mobility: null, equipOxygen: null }],
    ['the older "air" key', { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', patientAge: '70', origin: 'Pune', destination: 'Mumbai', careLevel: 'ICU / Critical, Ambulatory', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false, urgency: 'critical_6h' },
      { serviceKey: 'air', patientAge: 70, careLevel: 'ICU / Critical, Ambulatory', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false, urgency: 'critical_6h' }],
    ['no serviceKey (a very old build)', { serviceType: 'Ground Ambulance', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', description: 'Needs transport.' },
      { serviceKey: null, patientAge: null }],
  ];
  test.each(GOLDEN)('%s', async (_name, input, columns) => {
    const r = await post(input);
    expect(r.err).toBeUndefined();
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ userId: 7, serviceType: input.serviceType, patientName: 'John Doe', origin: input.origin, destination: input.destination, status: 'submitted', ...columns });
    expect(mockStore.cases).toHaveLength(1); // the Case is made as before
    expect(logged()).toEqual([]); // nothing unknown was sent
  });

  test('the date goes through as it always did (a calendar day is stored as that day)', async () => {
    await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', preferredDate: '2026-12-01' });
    expect(stored().preferredDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', preferredDate: '2026-12-01T10:30:00.000Z' });
    expect(stored().preferredDate.toISOString()).toBe('2026-12-01T10:30:00.000Z');
  });

  test('an empty optional text is stored as NULL, as before; the other text is stored exactly as sent (no trimming)', async () => {
    await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: '  John  Doe ', origin: 'Pune', destination: 'Mumbai', patientGender: '', patientContact: '', country: '', description: '', patientLocation: '  Pune  ' });
    expect(stored()).toMatchObject({ patientName: '  John  Doe ', patientGender: null, patientContact: null, country: null, description: null, patientLocation: '  Pune  ' });
  });

  test('a reference and Case are made as before (REQ- reference, the Case copies the request)', async () => {
    const r = await post({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientContact: CONTACT, preferredDate: FUTURE_DAY, origin: 'Pune', destination: 'Mumbai', description: 'Needs transport.' });
    expect(r.body.request.referenceNumber).toBe('REQ-1100');
    expect(mockStore.cases[0]).toMatchObject({ referenceNumber: 'REQ-1100', patientName: 'John Doe', serviceType: 'Ground Ambulance', origin: 'Pune', destination: 'Mumbai' });
  });
});

describe('patient age on the generic path', () => {
  const base = { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' };
  test.each([[0, 0], [129, 129], ['0', 0], ['129', 129], [' 40 ', 40]])('%p is stored as %p', async (age, expected) => {
    expect((await post({ ...base, patientAge: age })).status).toBe(201);
    expect(stored().patientAge).toBe(expected);
  });
  test.each([['an empty text', ''], ['null', null], ['absent', undefined]])('%s is stored as NULL (an empty text is no longer 0)', async (_n, value) => {
    const input = { ...base }; if (value !== undefined) input.patientAge = value;
    expect((await post(input)).status).toBe(201);
    expect(stored().patientAge).toBeNull();
  });
  test.each([[-1], [130], [1.5], ['abc'], ['12.5'], [true], [{}], [NaN]])('%p is a 400, not a 500, and nothing is saved', async (age) => {
    const r = await post({ ...base, patientAge: age });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('patientAge must be a whole number from 0 to 129');
    expect(r.err).toBeUndefined();
    expect(mockStore.creates).toBe(0);
  });
});

describe('invalid input is a 400, never a database error', () => {
  const base = { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' };
  test.each([
    ['a name over 191 characters', { patientName: 'N'.repeat(192) }, /patientName can be at most 191 characters/],
    ['an origin over 191 characters', { origin: 'O'.repeat(192) }, /origin can be at most 191 characters/],
    ['a destination that is not text', { destination: 7 }, /destination must be text/],
    ['a service type that is an object', { serviceType: {} }, /serviceType must be text/],
    ['a contact over 191 characters', { patientContact: 'c'.repeat(192) }, /patientContact can be at most 191 characters/],
    ['a gender that is a list', { patientGender: ['Male'] }, /patientGender must be text/],
    ['a country over 191 characters', { country: 'c'.repeat(192) }, /country can be at most 191 characters/],
    ['a location over 191 characters', { patientLocation: 'l'.repeat(192) }, /patientLocation can be at most 191 characters/],
    ['a date that is not a date', { preferredDate: 'not a date' }, /preferredDate must be a valid date/],
    ['an impossible day', { preferredDate: '2026-02-30' }, /preferredDate must be a valid date/],
    ['a description over 65,535 bytes', { description: 'd'.repeat(65536) }, /description can be at most 65535 bytes/],
    ['a description that is an object', { description: {} }, /description must be text/],
    ['a care level over 191 characters', { careLevel: 'c'.repeat(192) }, /careLevel can be at most 191 characters/],
    ['a care level that is a list', { careLevel: ['x'] }, /careLevel must be text/],
  ])('%s', async (_n, extra, message) => {
    const r = await post({ ...base, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(r.err).toBeUndefined();
    expect(mockStore.creates).toBe(0);
    expect(mockStore.cases).toHaveLength(0);
  });
  test('a description of exactly 65,535 bytes is saved whole', async () => {
    expect((await post({ ...base, description: 'd'.repeat(65535) })).status).toBe(201);
    expect(stored().description).toHaveLength(65535);
  });
  test('the existing generic messages are unchanged (missing fields, unknown service key, the medical page rules)', async () => {
    expect((await post({ serviceType: 'Hospitalization Assistance', patientName: 'x', origin: 'a' })).body.error).toBe('Missing required field(s): destination');
    expect((await post({ ...base, serviceKey: 'nonsense' })).body.error).toBe('Unknown serviceKey');
    expect((await post({ ...base, mobility: 'walking' })).body.error).toMatch(/only accepted for air and ground/);
    expect((await post({ ...base, equipOxygenLpm: 4 })).body.error).toMatch(/only accepted for Commercial Air and Ground/);
    expect((await post({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'x', origin: 'a', destination: 'b' })).body.error).toMatch(/Present Medical Issue/);
    expect((await post({ ...base, serviceKey: 'commercialair' })).body.error).toMatch(/Travel type is required/);
    expect(mockStore.creates).toBe(0);
  });
});

describe('another service\'s own columns are refused for every generic service, and nothing is saved', () => {
  const SERVICES = [
    ['Commercial Air', { serviceType: 'Medical Escort', serviceKey: 'commercialair_stretcher', patientContact: CONTACT, preferredDate: FUTURE_DAY }],
    ['Ground Ambulance', { serviceType: 'Ground Ambulance', serviceKey: 'ground', description: 'Needs transport.', patientContact: CONTACT, preferredDate: FUTURE_DAY }],
    ['Hospitalization', { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital' }],
    ['the older "air" key', { serviceType: 'Air Ambulance', serviceKey: 'air' }],
    ['no serviceKey', { serviceType: 'Ground Ambulance', description: 'Needs transport.' }],
  ];
  const FIELDS = {
    originGeonameId: 1, originCityName: 'Pune', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata', destinationGeonameId: 2, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    deceasedRelation: 'Brother', placeOfDeath: 'Pune', dateOfDeath: '2026-11-01', transferScope: 'domestic', transportMode: 'ground_transportation', careRequirement: '12_hours', caretakerTypes: 'nurse',
  };
  describe.each(SERVICES)('%s', (_name, shape) => {
    test.each(Object.entries(FIELDS))('%s is refused', async (field, value) => {
      const r = await post({ patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', ...shape, [field]: value });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(`${field} is not accepted for this service`);
      expect(r.err).toBeUndefined();
      expect(mockStore.creates).toBe(0);
    });
  });
  test('a hostile value that used to reach the database (a huge id, an over-long scope) is a 400 now', async () => {
    for (const extra of [{ originGeonameId: 'x' }, { originGeonameId: 99999999999 }, { transferScope: 'x'.repeat(40) }, { transportMode: 'y'.repeat(60) }]) {
      const r = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', ...extra });
      expect(r.status).toBe(400);
    }
    expect(mockStore.creates).toBe(0);
  });
  test('a null value is ignored and never stored (nothing is refused)', async () => {
    const r = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', transferScope: null, originGeonameId: null, dateOfDeath: null });
    expect(r.status).toBe(201);
    expect(stored().transferScope ?? null).toBeNull();
    expect(stored().originGeonameId ?? null).toBeNull();
    expect(stored().dateOfDeath ?? null).toBeNull();
  });
});

describe('unknown keys: stage 1 (ignored, names logged, never values)', () => {
  const base = { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' };
  test('an unknown key is ignored (the request is saved) and only its NAME is logged', async () => {
    const r = await post({ ...base, somethingNew: 'my phone is 9876543210', another: { deep: 'secret' } });
    expect(r.status).toBe(201);
    expect(stored()).not.toHaveProperty('somethingNew');
    expect(stored()).not.toHaveProperty('another');
    expect(logged()).toEqual(['[generic-request] unknown fields ignored (service hospital): somethingNew, another']);
    expect(logged().join('')).not.toMatch(/9876543210|secret|John Doe|Pune/);
  });
  test('the retired legacy keys are ignored without a log line', async () => {
    const r = await post({ ...base, medicalSummary: 'a', documentUrl: 'b', additionalInfo: 'c', specialRequirements: 'd', referralSource: 'e' });
    expect(r.status).toBe(201);
    expect(logged()).toEqual([]);
    for (const key of ['medicalSummary', 'documentUrl', 'additionalInfo', 'specialRequirements', 'referralSource']) expect(stored()).not.toHaveProperty(key);
  });
  test('a body that tries to set the request\'s own bookkeeping cannot: the owner, status, reference and review fields come only from the server', async () => {
    const r = await post({ ...base, userId: 999, id: 5, status: 'completed', referenceNumber: 'CASE-1', bitrixLeadId: 12, bitrixSyncAttempts: 5, reviewStatus: 'approved', submittedAt: '2020-01-01', createdAt: '2020-01-01' });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ userId: 7, status: 'submitted', referenceNumber: 'REQ-1100' });
    expect(stored().reviewStatus ?? null).toBeNull();
    expect(stored().bitrixLeadId ?? null).toBeNull();
    expect(stored().bitrixSyncAttempts ?? 0).toBe(0);
    expect(stored().createdAt.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    expect(logged()[0]).toMatch(/userId, id, status, referenceNumber, bitrixLeadId, bitrixSyncAttempts, reviewStatus, submittedAt, createdAt/);
  });
  test('a name that could carry personal data is logged as "[other]", the service key only when known', async () => {
    await post({ ...base, serviceKey: 'hospital', 'John Doe 9876543210': 1 });
    expect(logged()).toEqual(['[generic-request] unknown fields ignored (service hospital): [other]']);
  });
  test('the structured services\' own keys sent to a generic service are ignored and logged by name', async () => {
    const r = await post({ ...base, treatmentScope: 'domestic', specialty: 'Oncology', serviceScope: 'domestic' });
    expect(r.status).toBe(201);
    expect(stored().transferScope ?? null).toBeNull();
    expect(logged()[0]).toMatch(/treatmentScope, specialty, serviceScope/);
  });
});

describe('the structured services are unaffected (their own validators still decide)', () => {
  test('Medical Value Travel (structured) is still accepted and stored as before', async () => {
    const r = await post({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+91 98765 43210', currentCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, specialty: 'Oncology',
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ serviceKey: 'medvalue', transferScope: 'international', originGeonameId: 1, destinationGeonameId: 3 });
    expect(logged()).toEqual([]);
  });
  test('Medical Value Travel: specialty and other specialty go to their columns; the description is only the Medical History', async () => {
    const r = await post({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+91 98765 43210', currentCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, specialty: 'Other', otherSpecialty: 'Sports medicine', medicalHistory: 'Knee pain.',
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ specialty: 'Other', otherSpecialty: 'Sports medicine', transferScope: 'international', description: 'Knee pain.' });
    expect(stored().description).not.toMatch(/Sports medicine|Specialty|Medical Value Travel v1|international/i);
    // a listed specialty with no history: nothing is stored in the description, and no other specialty
    const plain = await post({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'domestic', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+91 98765 43210', currentCity: { geonameId: 1 }, destinationCity: { geonameId: 1 }, specialty: 'Oncology',
    });
    expect(plain.status).toBe(201);
    expect(stored()).toMatchObject({ specialty: 'Oncology', otherSpecialty: null, description: null });
  });
  test('Marine (structured) is still accepted, with its Oxygen flow rate stored', async () => {
    const r = await post({
      serviceType: 'Marine Medical Safety', serviceKey: 'marine', serviceScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+91 98765 43210', originCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4,
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ transferScope: 'international', originGeonameId: 1, careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4 });
  });
  test('Home Healthcare (new format) is still accepted, with its care columns', async () => {
    const r = await post({
      serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210',
      homeAddress: 'Flat 4B, Rose Villa, Pune', preferredDate: inDays(3), utcOffsetMinutes: 0, caretakerTypes: ['nurse'], careRequirement: '12_hours',
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ serviceKey: 'homecare', caretakerTypes: 'nurse', careRequirement: '12_hours', destination: '' });
  });
  test('Home Healthcare: the care answers are in their columns and are not repeated in the description (address and history stay)', async () => {
    const r = await post({
      serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210',
      homeAddress: 'Flat 4B, Rose Villa, Pune', preferredDate: inDays(3), utcOffsetMinutes: 0, caretakerTypes: ['nurse', 'caretaker'], careRequirement: '24_hours', careLevel: 'full_icu',
      equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Diabetes.',
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ caretakerTypes: 'nurse,caretaker', careRequirement: '24_hours', careLevel: 'Full ICU', equipOxygen: true, equipOxygenLpm: 4 });
    expect(stored().description).toContain('Complete home address:\nFlat 4B, Rose Villa, Pune');
    expect(stored().description).toContain('Medical History:\nDiabetes.');
    expect(stored().description).not.toMatch(/Nurse|Caretaker|Care Requirement|Care Level|ICU|24 Hours|Oxygen|LPM/);
  });
  test('Home Healthcare\'s own columns are accepted there and refused on the generic path', async () => {
    const generic = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'x', origin: 'a', destination: 'b', careRequirement: '12_hours', caretakerTypes: 'nurse' });
    expect(generic.body.error).toBe('careRequirement is not accepted for this service');
  });
  test('an older generic Home Healthcare body is still refused by the Home validator, not let through here', async () => {
    const r = await post({ serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/is not accepted for Home Healthcare requests/);
  });
  test('Teleconsultation (structured) is still accepted', async () => {
    const r = await post({
      serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationType: 'online', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India',
      patientContact: '+91 98765 43210', currentAddress: 'Flat 4B, Pune', utcOffsetMinutes: 0,
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ serviceKey: 'tele', destination: '' });
  });
  test('Teleconsultation: the type and the House Call scope are in their columns; the description holds only the two notes', async () => {
    const house = await post({
      serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationType: 'house_call', consultationScope: 'domestic', patientName: 'Asha Nair', patientAge: 61,
      patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210', currentAddress: 'Flat 4B\nPune', preferredDate: inDays(3), utcOffsetMinutes: 0,
      presentMedicalIssue: 'Fever', allergyDetails: 'Penicillin',
    });
    expect(house.status).toBe(201);
    expect(stored()).toMatchObject({ consultationType: 'house_call', transferScope: 'domestic', origin: 'Flat 4B, Pune', description: 'Present medical issue:\nFever\n\nAllergic issue:\nPenicillin' });
    expect(stored().description).not.toMatch(/Consultation type|Scope|Current address|House Call|Domestic|Pune/);
    const online = await post({
      serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationType: 'online', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India',
      patientContact: '+91 98765 43210', currentAddress: 'Flat 4B, Pune', utcOffsetMinutes: 0,
    });
    expect(online.status).toBe(201);
    expect(stored()).toMatchObject({ consultationType: 'online', transferScope: null, description: null });
  });
  test('a request of any other service never writes the new columns', async () => {
    const r = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'x', origin: 'a', destination: 'b', specialty: 'Oncology', consultationType: 'online', otherSpecialty: 'x' });
    expect(r.status).toBe(201);
    for (const key of ['specialty', 'otherSpecialty', 'consultationType']) expect(key in stored()).toBe(false);
  });
  test('Mortal Remains (new format) is still accepted with its own columns, which the generic path now refuses', async () => {
    const r = await post({
      serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', transferScope: 'domestic', transportMode: 'ground_transportation', patientName: 'Suresh Kale', patientAge: 64, patientGender: 'Male',
      deceasedRelation: 'Brother', placeOfDeath: 'Pune', dateOfDeath: inDays(-2), country: 'India', origin: 'Pune', destination: 'Nagpur', patientContact: '+919876543210', preferredDate: inDays(3), urgency: 'planned', utcOffsetMinutes: 0,
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ serviceKey: 'mortal', deceasedRelation: 'Brother', placeOfDeath: 'Pune', transferScope: 'domestic', transportMode: 'ground_transportation' });
  });
  test('Private Charter is still decided by its own validator (a generic-style body is refused there)', async () => {
    const r = await post({ serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' });
    expect(r.status).toBe(400);
    expect(r.body.fields).toBeDefined(); // the Private Charter validator's own field-by-field answer
    expect(mockStore.creates).toBe(0);
  });
});
