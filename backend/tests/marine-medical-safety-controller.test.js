// Marine Medical Safety, structured format, through the REAL controller (submitRequest) and the REAL createRequest and PDF code, with NO database: Prisma is replaced
// by a recorder that keeps what would have been written, and the GeoNames lookup (getVerifiedCity) by a small controlled table. The lookup's own logic is not what is
// tested here (geo.service has its own tests); what is tested is that the controller asks it for every picked city and enforces the answer.
// Run with a Jest configuration that skips the database setup (see the Phase 2 report): the setup in jest.config.js would empty humancare_test.
process.env.BITRIX_SYNC_ENABLED = 'false';
process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';

const mockStore = { rows: [], cases: [], nextId: 100 };
jest.mock('../src/db/prisma', () => {
  const prisma = {
    serviceRequest: {
      create: async ({ data }) => { const row = { id: mockStore.nextId++, createdAt: new Date('2026-11-18T10:00:00Z'), updatedAt: new Date('2026-11-18T10:00:00Z'), ...data }; mockStore.rows.push(row); return { ...row }; },
      update: async ({ where, data }) => { const row = mockStore.rows.find((r) => r.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    case: { create: async ({ data }) => { const row = { id: mockStore.cases.length + 1, ...data }; mockStore.cases.push(row); return row; } },
    caseStageEvent: { create: async () => ({}) },
  };
  // createRequest saves the request, its Case and its first stage event in one transaction: the mock runs the callback on itself (the recorder keeps what each call would have written).
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma };
});
const mockLookups = [];
const mockFail = { on: false };
const mockCities = {
  1: { geonameId: 1, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
  2: { geonameId: 2, name: 'Chennai', label: 'Chennai, Tamil Nadu, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
  3: { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai' },
};
jest.mock('../src/modules/geo/geo.service', () => ({
  resolveCityRefs: async () => ({}),
  getVerifiedCity: async (id) => {
    mockLookups.push(id);
    if (mockFail.on) { const e = new Error('City verification is temporarily unavailable.'); e.statusCode = 503; throw e; }
    return mockCities[id] || null;
  },
}));

const { submitRequest } = require('../src/modules/requests/requests.controller');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { composeMarineDescription } = require('../src/modules/requests/marine-medical-safety.validation');
const { composeMvtDescription } = require('../src/modules/requests/medical-value-travel.validation');
const { composeHomeDescription } = require('../src/modules/requests/home-healthcare.validation');

beforeEach(() => { mockStore.rows.length = 0; mockStore.cases.length = 0; mockStore.nextId = 100; mockLookups.length = 0; mockFail.on = false; });

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const marine = (extra = {}) => ({
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
// What the app sends for a Marine request that has none of the structured fields (every older build).
const legacy = (extra = {}) => ({ serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', origin: 'Mumbai, India', destination: 'Dubai, UAE', ...extra });
async function post(body) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user: { id: 7 } }, res, (err) => { out.err = err; });
  return out;
}
const stored = () => mockStore.rows[mockStore.rows.length - 1];

describe('a structured Marine request through the controller', () => {
  test('is saved in the existing columns, with a Case, and the response carries only what a phone may see', async () => {
    const day = inDays(9);
    const r = await post(marine({ preferredDate: day, utcOffsetMinutes: 0, careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Chest pain since 04:00.' }));
    expect(r.status).toBe(201);
    expect(mockStore.rows).toHaveLength(1);
    expect(stored()).toMatchObject({
      userId: 7, serviceType: 'Marine Medical Safety', serviceKey: 'marine', transferScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      country: 'India', patientContact: '+919876543210', origin: mockCities[1].label, patientLocation: mockCities[1].label, destination: mockCities[3].label,
      originGeonameId: 1, originCityName: 'Mumbai', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata', destinationGeonameId: 3, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
      careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, urgency: null, mobility: null, equipCardiacMonitor: null, equipVentilator: null,
      description: 'Marine Medical Safety v1 (history 23)\nMedical History:\nChest pain since 04:00.', status: 'submitted', referenceNumber: 'REQ-1100',
    });
    expect(stored().preferredDate.toISOString().slice(0, 10)).toBe(day);
    expect(mockStore.cases).toHaveLength(1);
    expect(mockStore.cases[0]).toMatchObject({ serviceRequestId: stored().id, serviceType: 'Marine Medical Safety', origin: mockCities[1].label, destination: mockCities[3].label, country: 'India' });
    expect(mockStore.cases[0]).not.toHaveProperty('urgency'); // no urgency was given: the Case keeps its own default
    expect(r.body.request).toMatchObject({ transferScope: 'international', careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, urgency: null, originCityName: 'Mumbai', destinationCountryCode: 'AE' });
    for (const hidden of ['originGeonameId', 'destinationGeonameId', 'originTimezone', 'userId', 'bitrixLeadId']) expect(r.body.request).not.toHaveProperty(hidden);
  });

  test('every picked city is looked up by the server (the lookup is asked for each id), and a typed one is not', async () => {
    await post(marine());
    expect(mockLookups).toEqual([1, 3]);
    mockLookups.length = 0;
    await post(marine({ originCity: { text: 'Port of Mumbai' }, destinationCity: { geonameId: 3 } }));
    expect(mockLookups).toEqual([3]);
    mockLookups.length = 0;
    await post(marine({ originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Dubai' } }));
    expect(mockLookups).toEqual([]);
  });
});

describe('scope rules for picked cities, enforced from what the lookup returns', () => {
  test.each([
    ['Domestic with a destination abroad', { serviceScope: 'domestic' }, /must be in the selected country for a Domestic request/],
    ['International with a destination in the same country', { destinationCity: { geonameId: 2 } }, /must be in a different country for an International request/],
    ['an Origin outside the selected country', { country: 'AE' }, /originCity must be in the selected country/],
    ['an unknown city id', { originCity: { geonameId: 999 } }, /originCity is not a valid city/],
  ])('%s is refused with a 400 and nothing is saved', async (_n, extra, message) => {
    const r = await post(marine(extra));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(mockStore.rows).toHaveLength(0);
    expect(mockStore.cases).toHaveLength(0);
  });
  test('Domestic with both cities in the country, and International across countries, are accepted', async () => {
    expect((await post(marine({ serviceScope: 'domestic', destinationCity: { geonameId: 2 } }))).status).toBe(201);
    expect(stored().transferScope).toBe('domestic');
    expect((await post(marine())).status).toBe(201);
    expect(stored().transferScope).toBe('international');
  });
  test('a city data problem (the lookup fails) is not swallowed: it reaches the error handler, nothing is saved', async () => {
    mockFail.on = true;
    const r = await post(marine());
    expect(r.err && r.err.statusCode).toBe(503);
    expect(mockStore.rows).toHaveLength(0);
    // a request with only typed cities needs no lookup and is unaffected
    expect((await post(marine({ originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Dubai' } }))).status).toBe(201);
  });
});

describe('manual city or port entries are preserved exactly and are never verified', () => {
  test('exact text, spaces included, and every GeoNames column is NULL', async () => {
    const origin = '  Port   of Mumbai (Ballard Pier) ';
    const destination = 'Jawaharlal Nehru Port ';
    const r = await post(marine({ serviceScope: 'domestic', originCity: { text: origin }, destinationCity: { text: destination } }));
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({
      origin, patientLocation: origin, destination, transferScope: 'domestic',
      originGeonameId: null, originCityName: null, originCountryCode: null, originTimezone: null, destinationGeonameId: null, destinationCityName: null, destinationCountryCode: null,
    });
    expect(r.body.request).toMatchObject({ origin, destination, originCityName: null, originCountryCode: null, destinationCityName: null, destinationCountryCode: null });
  });
  test('no country rule is claimed: a typed destination that names a place abroad is accepted for a Domestic request', async () => {
    expect((await post(marine({ serviceScope: 'domestic', originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Dubai' } }))).status).toBe(201);
  });
  test('one picked and one typed: only the picked one has metadata', async () => {
    await post(marine({ destinationCity: { text: 'Port of Singapore' } }));
    expect(stored()).toMatchObject({ originGeonameId: 1, originCountryCode: 'IN', destination: 'Port of Singapore', destinationGeonameId: null, destinationCountryCode: null });
  });
});

describe('Oxygen: not answered, Yes, No (and the flow rate is really persisted)', () => {
  test('not answered: the answer and the flow rate are both NULL in the stored row', async () => {
    expect((await post(marine())).status).toBe(201);
    expect(stored().equipOxygen).toBeNull();
    expect(stored().equipOxygenLpm).toBeNull();
    expect('equipOxygenLpm' in stored()).toBe(true); // written (as NULL), not left to a default
  });
  test.each([[4], [2.5], [0.5], [15]])('Yes with %p LPM is stored as true with that exact flow rate (the Marine-only write in createRequest)', async (lpm) => {
    const r = await post(marine({ equipOxygen: true, equipOxygenLpm: lpm }));
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ equipOxygen: true, equipOxygenLpm: lpm });
    expect(r.body.request).toMatchObject({ equipOxygen: true, equipOxygenLpm: lpm });
  });
  test('No is stored as false with a NULL flow rate, and the response carries no flow rate', async () => {
    const r = await post(marine({ equipOxygen: false }));
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
    expect(r.body.request).toMatchObject({ equipOxygen: false });
    expect(r.body.request).not.toHaveProperty('equipOxygenLpm');
  });
  test.each([
    ['Yes without a flow rate', { equipOxygen: true }, /equipOxygenLpm is required when Oxygen is Yes/],
    ['Yes with a flow rate over 15', { equipOxygen: true, equipOxygenLpm: 16 }, /equipOxygenLpm must be greater than 0 and at most 15/],
    ['Yes with a flow rate as text', { equipOxygen: true, equipOxygenLpm: '4' }, /equipOxygenLpm must be a number/],
    ['No with a flow rate', { equipOxygen: false, equipOxygenLpm: 4 }, /only accepted when Oxygen is Yes/],
    ['a flow rate without an answer', { equipOxygenLpm: 4 }, /only accepted when Oxygen is Yes/],
    ['an answer that is not true or false', { equipOxygen: 'yes' }, /equipOxygen must be true or false/],
  ])('%s is refused and nothing is saved', async (_n, extra, message) => {
    const r = await post(marine(extra));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(mockStore.rows).toHaveLength(0);
  });
});

describe('Critical Level: optional, several allowed, stored in care_level', () => {
  test.each([
    ['none', {}, null],
    ['an empty text', { careLevel: '' }, null],
    ['an empty list', { careLevel: [] }, null],
    ['one key', { careLevel: 'crit_ventilated' }, 'crit_ventilated'],
    ['two keys as text', { careLevel: 'crit_icu,crit_ecmo' }, 'crit_icu,crit_ecmo'],
    ['all four as a list, in the order chosen', { careLevel: ['crit_tracheostomy', 'crit_icu', 'crit_ecmo', 'crit_ventilated'] }, 'crit_tracheostomy,crit_icu,crit_ecmo,crit_ventilated'],
  ])('%s -> care_level %p', async (_n, extra, expected) => {
    const r = await post(marine(extra));
    expect(r.status).toBe(201);
    expect(stored().careLevel).toBe(expected);
    expect(r.body.request.careLevel).toBe(expected);
  });
  test.each([['an old care level', 'care_icu'], ['free text', 'critical'], ['a repeat', 'crit_icu,crit_icu'], ['a bad key in a list', ['crit_icu', 'ecmo']]])('refuses %s', async (_n, value) => {
    const r = await post(marine({ careLevel: value }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/^Invalid careLevel/);
    expect(mockStore.rows).toHaveLength(0);
  });
});

describe('Medical History in the description', () => {
  test.each([
    ['none', undefined, 'Marine Medical Safety v1 (history 0)'],
    ['an empty text', '', 'Marine Medical Safety v1 (history 0)'],
    ['whitespace only counts as empty', '  \n\t ', 'Marine Medical Safety v1 (history 0)'],
    ['plain text', 'Stable.', 'Marine Medical Safety v1 (history 7)\nMedical History:\nStable.'],
    ['meaningful text keeps its own whitespace and line breaks', '  Stable.\r\nSecond line  ', 'Marine Medical Safety v1 (history 24)\nMedical History:\n  Stable.\r\nSecond line  '],
    ['emoji count as two code units', '\u{1F600}', 'Marine Medical Safety v1 (history 2)\nMedical History:\n\u{1F600}'],
  ])('%s', async (_n, history, expected) => {
    const extra = {}; if (history !== undefined) extra.medicalHistory = history;
    const r = await post(marine(extra));
    expect(r.status).toBe(201);
    expect(stored().description).toBe(expected);
    expect(r.body.request.description).toBe(expected);
  });
  test('over 2,000 characters is refused; exactly 2,000 is stored whole', async () => {
    expect((await post(marine({ medicalHistory: 'h'.repeat(2001) }))).status).toBe(400);
    expect(mockStore.rows).toHaveLength(0);
    expect((await post(marine({ medicalHistory: 'h'.repeat(2000) }))).status).toBe(201);
    expect(stored().description).toBe(`Marine Medical Safety v1 (history 2000)\nMedical History:\n${'h'.repeat(2000)}`);
  });
});

describe('fields the structured format does not carry are refused (and nothing is saved)', () => {
  test.each([['urgency', 'urgent_24h'], ['mobility', 'walking'], ['equipCardiacMonitor', true], ['equipVentilator', true], ['emergencyContact', 'Jo'], ['vesselName', 'MV Aurora'],
    ['gpsCoordinates', '1,2'], ['description', 'x'], ['origin', 'Mumbai'], ['destination', 'Dubai']])('%s', async (field, value) => {
    const r = await post(marine({ [field]: value }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(`${field} is not accepted for Marine Medical Safety requests`);
    expect(mockStore.rows).toHaveLength(0);
  });
});

describe('older generic Marine requests are refused (tests/legacy-body-guard.test.js has the full set)', () => {
  test('the generic body is refused with app_update_required and nothing is saved or looked up', async () => {
    const r = await post(legacy({ description: 'Crew member injured on deck.', urgency: 'planned', country: 'India', patientContact: '+971 50 111 2222', preferredDate: '2030-01-01' }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('app_update_required');
    expect(mockStore.rows).toHaveLength(0);
    expect(mockLookups).toEqual([]);
  });
  test('a generic body is refused whatever else it carries: mobility, equipment, a flow rate', async () => {
    for (const extra of [{ mobility: 'walking' }, { equipOxygen: false }, { equipCardiacMonitor: true }, { equipOxygenLpm: 4 }]) {
      const r = await post(legacy(extra));
      expect({ extra, status: r.status }).toEqual({ extra, status: 400 });
    }
    expect(mockStore.rows).toHaveLength(0);
  });
  test('the structured fields on another service key are not taken for Marine\'s: a hospital body stays generic', async () => {
    const r = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', serviceScope: 'domestic' });
    expect(r.status).toBe(201);
    expect(stored().serviceKey).toBe('hospital');
    expect(stored().transferScope ?? null).toBeNull();
    expect(mockLookups).toEqual([]);
  });
});

describe('other services\' flow-rate writes are unchanged', () => {
  test('Ground Ambulance still stores its flow rate (and none for Oxygen off)', async () => {
    const base = { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientContact: '+91 98765 43210', preferredDate: inDays(30), origin: 'Pune', destination: 'Mumbai', description: 'Needs transport.', urgency: 'urgent_24h' };
    expect((await post({ ...base, equipOxygen: true, equipOxygenLpm: 3 })).status).toBe(201);
    expect(stored()).toMatchObject({ equipOxygen: true, equipOxygenLpm: 3 });
    expect((await post({ ...base, equipOxygen: false })).status).toBe(201);
    expect(stored()).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
  });
  test('Commercial Air still stores its flow rate', async () => {
    const r = await post({ serviceType: 'Medical Escort (Commercial Airlines)', serviceKey: 'commercialair_stretcher', patientName: 'John Doe', patientContact: '+91 98765 43210', preferredDate: inDays(30), origin: 'Pune', destination: 'Mumbai', urgency: 'urgent_24h', equipOxygen: true, equipOxygenLpm: 2.5 });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ equipOxygen: true, equipOxygenLpm: 2.5 });
  });
  test('a service without a flow rate (Hospitalization) writes no flow rate key, as before', async () => {
    await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' });
    expect('equipOxygenLpm' in stored()).toBe(false);
  });
  test('Medical Value Travel in its structured format still goes through its own validator', async () => {
    const r = await post({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+91 98765 43210', currentCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, specialty: 'Oncology',
    });
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({ serviceKey: 'medvalue', transferScope: 'international', specialty: 'Oncology', otherSpecialty: null, description: null, careLevel: null });
    expect('equipOxygenLpm' in stored()).toBe(false);
  });
});

describe('the PDF', () => {
  const base = { id: 1, referenceNumber: 'REQ-1001', status: 'submitted', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', createdAt: new Date('2026-11-18T10:00:00Z'), urgency: null };
  const newMarine = (extra = {}) => ({
    ...base, serviceType: 'Marine Medical Safety', serviceKey: 'marine', transferScope: 'international', origin: mockCities[1].label, destination: mockCities[3].label,
    preferredDate: new Date('2026-12-01T00:00:00Z'), careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4,
    description: composeMarineDescription({ history: 'Chest pain since 04:00.' }), ...extra,
  });

  test('a structured Marine request prints its own section: patient, Service scope, Origin, Destination, Date of service, Critical level, Oxygen, Medical History', async () => {
    const lines = await renderPdfLines(newMarine());
    expect(valueAfter(lines, 'Patient Name:')).toBe('Asha Nair');
    expect(valueAfter(lines, 'Age / Gender:')).toBe('61 / Female');
    expect(valueAfter(lines, 'Service:')).toBe('Marine Medical Safety');
    expect(valueAfter(lines, 'Service scope:')).toBe('International');
    expect(valueAfter(lines, 'Origin:')).toBe(mockCities[1].label);
    expect(valueAfter(lines, 'Destination:')).toBe(mockCities[3].label);
    expect(valueAfter(lines, 'Date of service:')).toBe('Tue Dec 01 2026');
    expect(valueAfter(lines, 'Critical level:')).toBe('ICU, ECMO');
    expect(valueAfter(lines, 'Oxygen:')).toBe('Yes (4 LPM)');
    expect(valueAfter(lines, 'Medical History:')).toBe('Chest pain since 04:00.');
    expect(valueAfter(lines, 'Status:')).toBe('Submitted'); // the status is written as a word, not as its stored key
  });
  test('rows that were not answered are left out: no date, no Critical Level, no Oxygen answer, no history', async () => {
    const lines = await renderPdfLines(newMarine({ preferredDate: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null, description: composeMarineDescription({}) }));
    for (const label of ['Date of service:', 'Critical level:', 'Oxygen:', 'Medical History:']) expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
    expect(valueAfter(lines, 'Service scope:')).toBe('International');
  });
  test('Oxygen No prints "No" and no flow rate', async () => {
    const lines = await renderPdfLines(newMarine({ equipOxygen: false, equipOxygenLpm: null }));
    expect(valueAfter(lines, 'Oxygen:')).toBe('No');
  });
  test('Domestic, a single Critical Level and a typed port print as stored', async () => {
    const lines = await renderPdfLines(newMarine({ transferScope: 'domestic', careLevel: 'crit_tracheostomy', origin: '  Port of Mumbai ', destination: 'Port of Chennai' }));
    expect(valueAfter(lines, 'Service scope:')).toBe('Domestic');
    expect(valueAfter(lines, 'Critical level:')).toBe('Tracheostomy');
    expect(valueAfter(lines, 'Destination:')).toBe('Port of Chennai');
  });
  test('it prints none of the generic rows a structured Marine request does not have (urgency, mobility, on board, care level, condition)', async () => {
    const lines = await renderPdfLines(newMarine());
    for (const label of ['Urgency:', 'Patient mobility:', 'Required on board:', 'Care level:', 'Condition & diagnosis:', 'From:', 'To:', 'Transfer scope:', 'Treatment scope:']) {
      expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
    }
  });
  test('a historical generic Marine request prints exactly as before (the generic layout, its urgency and condition)', async () => {
    const lines = await renderPdfLines({
      ...base, serviceType: 'Marine Medical Safety', serviceKey: 'marine', transferScope: null, origin: 'Mumbai', destination: 'Dubai', description: 'Crew member injured on deck.', urgency: 'planned',
      preferredDate: new Date('2026-12-01T00:00:00Z'),
    });
    expect(valueAfter(lines, 'From:')).toBe('Mumbai');
    expect(valueAfter(lines, 'To:')).toBe('Dubai');
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Crew member injured on deck.');
    expect(valueAfter(lines, 'Urgency:')).toBe('Planned');
    expect(valueAfter(lines, 'Date Of Service:')).toBe('Tue Dec 01 2026');
    for (const label of ['Service scope:', 'Origin:', 'Destination:', 'Critical level:', 'Oxygen:', 'Medical History:']) expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
  });
  test('text that only looks like the new description, with no scope (or a scope with free text), is still printed the generic way', async () => {
    for (const extra of [{ transferScope: null, description: composeMarineDescription({}) }, { transferScope: 'domestic', description: 'Crew member injured on deck.' }]) {
      const lines = await renderPdfLines({ ...base, serviceType: 'Marine Medical Safety', serviceKey: 'marine', origin: 'A', destination: 'B', ...extra });
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
      expect(valueAfter(lines, 'From:')).toBe('A');
    }
  });

  describe('every other service prints as before', () => {
    test('Mortal Remains: Transfer scope and Transport mode, never Service scope', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', transferScope: 'domestic', transportMode: 'ground_transportation', origin: 'A', destination: 'B', description: 'Transfer Scope: Domestic\nTransport Mode: Ground Transportation' });
      expect(valueAfter(lines, 'Transfer scope:')).toBe('Domestic');
      expect(valueAfter(lines, 'Transport mode:')).toBe('Ground Transportation');
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
      expect(valueAfter(lines, 'From:')).toBe('A');
    });
    test('Medical Value Travel (new format): Treatment scope, Specialty, Current and Destination city', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', transferScope: 'international', origin: 'Pune', destination: 'Dubai', description: composeMvtDescription({ specialty: 'Oncology', history: 'Knee pain.' }) });
      expect(valueAfter(lines, 'Treatment scope:')).toBe('International');
      expect(valueAfter(lines, 'Specialty:')).toBe('Oncology');
      expect(valueAfter(lines, 'Current city:')).toBe('Pune');
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    });
    test('Medical Value Travel (columns): Specialty with the Other text and the Medical History from the description', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', transferScope: 'domestic', specialty: 'Other', otherSpecialty: 'Sports medicine', origin: 'Pune', destination: 'Mumbai', description: 'Knee pain.' });
      expect(valueAfter(lines, 'Treatment scope:')).toBe('Domestic');
      expect(valueAfter(lines, 'Specialty:')).toBe('Other (Sports medicine)');
      expect(valueAfter(lines, 'Medical History:')).toBe('Knee pain.');
      expect(valueAfter(lines, 'From:')).toBeUndefined();
    });
    test('Teleconsultation (with consultation_type): type, scope, address and notes; not the generic Transfer scope', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationType: 'house_call', transferScope: 'domestic', origin: 'Flat 4B, Pune', destination: '', description: 'Present medical issue:\nFever' });
      expect(valueAfter(lines, 'Consultation type:')).toBe('House Call');
      expect(valueAfter(lines, 'Scope:')).toBe('Domestic');
      expect(valueAfter(lines, 'Current address:')).toBe('Flat 4B, Pune');
      expect(valueAfter(lines, 'Transfer scope:')).toBeUndefined();
      expect(valueAfter(lines, 'From:')).toBeUndefined();
    });
    test('Medical Value Travel (older): the generic layout', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', transferScope: null, origin: 'Delhi', destination: 'Singapore', description: 'Heart valve surgery.', urgency: 'planned' });
      expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Heart valve surgery.');
      expect(valueAfter(lines, 'Treatment scope:')).toBeUndefined();
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    });
    test('Home Healthcare (new format): its own layout, home address and Service Date', async () => {
      const lines = await renderPdfLines({
        ...base, serviceType: 'Home Healthcare Services', serviceKey: 'homecare', origin: 'Flat 4B, Pune', destination: '', preferredDate: new Date('2026-12-01T00:00:00Z'), equipOxygen: true, equipOxygenLpm: 3,
        description: composeHomeDescription({ care: { equipOxygen: true, equipOxygenLpm: 3 }, address: 'Flat 4B, Pune', history: 'None.' }),
      });
      expect(valueAfter(lines, 'Home address:')).toBe('Flat 4B, Pune');
      expect(valueAfter(lines, 'Oxygen:')).toBe('Yes (3 LPM)');
      expect(valueAfter(lines, 'Medical History:')).toBe('None.');
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    });
    test('Ground Ambulance: the generic layout with its Care level and Required on board', async () => {
      const lines = await renderPdfLines({ ...base, serviceType: 'Ground Ambulance', serviceKey: 'ground', origin: 'Pune', destination: 'Mumbai', urgency: 'urgent_24h', description: 'Needs transport.', careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4 });
      expect(valueAfter(lines, 'Care level:')).toBe('ICU');
      expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen (4 LPM)');
      expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Needs transport.');
      expect(valueAfter(lines, 'Urgency:')).toBe('Urgent (24h)');
      expect(valueAfter(lines, 'Critical level:')).toBeUndefined();
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    });
    test('Private Charter: the generic layout, its date and urgency', async () => {
      const lines = await renderPdfLines({
        ...base, serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', urgency: 'urgent_24h',
        description: 'Stable.', careLevel: 'care_icu', mobility: 'bedridden', preferredDate: new Date('2026-12-01T00:00:00Z'),
      });
      expect(valueAfter(lines, 'From:')).toBe('Mumbai, Maharashtra, India');
      expect(valueAfter(lines, 'Date Of Service:')).toBe('Tue Dec 01 2026');
      expect(valueAfter(lines, 'Urgency:')).toBe('Urgent (24h)');
      expect(valueAfter(lines, 'Patient mobility:')).toBe('Bedridden');
      expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    });
  });
});

describe('what a structured Marine request stores is exactly what its PDF reads back', () => {
  test('a request made through the controller prints the values it was made with', async () => {
    const day = inDays(5);
    const r = await post(marine({ serviceScope: 'domestic', destinationCity: { geonameId: 2 }, preferredDate: day, utcOffsetMinutes: 0, careLevel: ['crit_ventilated', 'crit_icu'], equipOxygen: true, equipOxygenLpm: 2.5, medicalHistory: '  Needs oxygen.\nStable.  ' }));
    expect(r.status).toBe(201);
    const lines = await renderPdfLines(stored());
    expect(valueAfter(lines, 'Service scope:')).toBe('Domestic');
    expect(valueAfter(lines, 'Origin:')).toBe(mockCities[1].label);
    expect(valueAfter(lines, 'Destination:')).toBe(mockCities[2].label);
    expect(valueAfter(lines, 'Critical level:')).toBe('Ventilated, ICU');
    expect(valueAfter(lines, 'Oxygen:')).toBe('Yes (2.5 LPM)');
  });
});
