// Marine Medical Safety (serviceKey "marine") through the API and the test database: the structured format is validated and stored in the existing columns, its Oxygen
// flow rate is really persisted, reports upload through the shared route, the patient response and the PDF read it back, and the generic body an older app build sends keeps
// working. Needs the test database, like requests.test.js (the pure rules are in marine-medical-safety-validation.test.js, the controller without a database in
// marine-medical-safety-controller.test.js). The GeoNames lookup is replaced by a small table, so no city data is needed. Every record is made by this file (createPatient
// and the requests below); the suite's global setup is the repository's own.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/modules/geo/geo.service', () => {
  const actual = jest.requireActual('../src/modules/geo/geo.service');
  const CITIES = {
    1: { geonameId: 1, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
    2: { geonameId: 2, name: 'Chennai', label: 'Chennai, Tamil Nadu, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
    3: { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai' },
  };
  return { ...actual, getVerifiedCity: jest.fn(async (id) => CITIES[id] || null) };
});

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient } = require('./helpers');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { composeMvtDescription } = require('../src/modules/requests/medical-value-travel.validation');

afterAll(async () => {
  await prisma.$disconnect();
});

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
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const mine = async (token) => (await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`)).body.requests;
const rowOf = (id) => prisma.serviceRequest.findUnique({ where: { id }, include: { case: true } });
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const rawDay = async (id) => (await prisma.$queryRawUnsafe('SELECT DATE_FORMAT(preferred_date, "%Y-%m-%d") AS day FROM service_requests WHERE id = ?', id))[0].day;

describe('POST /requests: a structured Marine Medical Safety request', () => {
  it('is saved in the existing columns, with a Case, no urgency, and the scope in transfer_scope; the phone gets only what it may see', async () => {
    const { token } = await createPatient();
    const day = inDays(9);
    const res = await post(token, body({ preferredDate: day, utcOffsetMinutes: 0, careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Chest pain since 04:00.' }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      serviceKey: 'marine', serviceType: 'Marine Medical Safety', status: 'submitted', transferScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      country: 'India', patientContact: '+919876543210', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, Dubai, United Arab Emirates', urgency: null,
      originCityName: 'Mumbai', originCountryCode: 'IN', destinationCityName: 'Dubai', destinationCountryCode: 'AE', careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4,
      description: 'Marine Medical Safety v1 (history 23)\nMedical History:\nChest pain since 04:00.',
    });
    for (const hidden of ['originGeonameId', 'destinationGeonameId', 'originTimezone', 'userId', 'bitrixLeadId']) expect(res.body.request).not.toHaveProperty(hidden);
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({
      transferScope: 'international', transportMode: null, urgency: null, mobility: null, equipCardiacMonitor: null, equipVentilator: null, patientLocation: 'Mumbai, Maharashtra, India',
      originGeonameId: 1, originTimezone: 'Asia/Kolkata', destinationGeonameId: 3, patientContact: '+919876543210', country: 'India', careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4,
    });
    expect(row.case).toBeTruthy();
    expect(row.case.urgency).toBe('routine'); // no urgency was given: the Case keeps its own default
    expect(await rawDay(res.body.request.id)).toBe(day);
  });

  it('returns the same request through the list and the single-request endpoints', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ careLevel: 'crit_ventilated', equipOxygen: true, equipOxygenLpm: 2.5, medicalHistory: 'Stable.' }));
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(one.body.request).toMatchObject({ transferScope: 'international', careLevel: 'crit_ventilated', equipOxygen: true, equipOxygenLpm: 2.5, description: 'Marine Medical Safety v1 (history 7)\nMedical History:\nStable.' });
    expect((await mine(token))[0]).toMatchObject({ id: res.body.request.id, transferScope: 'international', equipOxygenLpm: 2.5 });
  });
});

describe('Service Scope and the verified (picked) cities', () => {
  it.each([
    ['a Domestic destination abroad', { serviceScope: 'domestic' }, /must be in the selected country for a Domestic request/],
    ['an International destination in the same country', { destinationCity: { geonameId: 2 } }, /must be in a different country for an International request/],
    ['an Origin outside the selected country', { country: 'AE' }, /originCity must be in the selected country/],
    ['an unknown city id', { originCity: { geonameId: 999 } }, /originCity is not a valid city/],
    ['a missing scope', { serviceScope: undefined }, /serviceScope \(Service Scope\) must be one of/],
    ['a wrong scope', { serviceScope: 'both' }, /serviceScope \(Service Scope\) must be one of/],
    ['a past Date of Service', { preferredDate: '2000-01-01', utcOffsetMinutes: 0 }, /preferredDate cannot be in the past/],
  ])('refuses %s with a 400 and saves nothing', async (_n, extra, message) => {
    const { token } = await createPatient();
    const payload = body(extra);
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const res = await post(token, payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await mine(token)).toHaveLength(0);
  });

  it('accepts Domestic with both cities in the country, and stores the scope', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ serviceScope: 'domestic', destinationCity: { geonameId: 2 } }));
    expect(res.status).toBe(201);
    expect((await rowOf(res.body.request.id)).transferScope).toBe('domestic');
  });
});

describe('manually entered cities and ports', () => {
  it('are kept exactly as typed, and every GeoNames column is NULL (an unverified location)', async () => {
    const { token } = await createPatient();
    const origin = '  Port   of Mumbai (Ballard Pier) ';
    const destination = 'Jawaharlal Nehru Port';
    const res = await post(token, body({ serviceScope: 'domestic', originCity: { text: origin }, destinationCity: { text: destination } }));
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({
      origin, patientLocation: origin, destination, transferScope: 'domestic',
      originGeonameId: null, originCityName: null, originCountryCode: null, originTimezone: null, destinationGeonameId: null, destinationCityName: null, destinationCountryCode: null,
    });
    expect(res.body.request).toMatchObject({ origin, destination, originCityName: null, destinationCountryCode: null });
  });
});

describe('Date of Service and Medical History', () => {
  it('the date is optional, and a date is stored as that calendar day', async () => {
    const { token } = await createPatient();
    const none = await post(token, body());
    expect(none.status).toBe(201);
    expect((await rowOf(none.body.request.id)).preferredDate).toBeNull();
    const day = inDays(12);
    const withDate = await post(token, body({ preferredDate: day, utcOffsetMinutes: 0 }));
    expect(withDate.status).toBe(201);
    expect(await rawDay(withDate.body.request.id)).toBe(day);
  });

  it.each([
    ['none', undefined, 'Marine Medical Safety v1 (history 0)'],
    ['whitespace only counts as empty', '  \n\t ', 'Marine Medical Safety v1 (history 0)'],
    ['meaningful text keeps its whitespace and line breaks exactly', '  Stable.\r\nSecond line  ', 'Marine Medical Safety v1 (history 24)\nMedical History:\n  Stable.\r\nSecond line  '],
    ['emoji and accents are kept (an emoji counts two code units)', 'Café \u{1F600}', 'Marine Medical Safety v1 (history 7)\nMedical History:\nCafé \u{1F600}'],
  ])('Medical History: %s', async (_n, history, expected) => {
    const { token } = await createPatient();
    const extra = {}; if (history !== undefined) extra.medicalHistory = history;
    const res = await post(token, body(extra));
    expect(res.status).toBe(201);
    expect(res.body.request.description).toBe(expected);
    expect((await rowOf(res.body.request.id)).description).toBe(expected);
  });

  it('2,000 characters are stored whole; 2,001 are refused', async () => {
    const { token } = await createPatient();
    const ok = await post(token, body({ medicalHistory: 'h'.repeat(2000) }));
    expect(ok.status).toBe(201);
    expect((await rowOf(ok.body.request.id)).description).toBe(`Marine Medical Safety v1 (history 2000)\nMedical History:\n${'h'.repeat(2000)}`);
    const tooLong = await post(token, body({ medicalHistory: 'h'.repeat(2001) }));
    expect(tooLong.status).toBe(400);
  });
});

describe('Critical Level: optional, several allowed', () => {
  it.each([
    ['none', {}, null],
    ['an empty list', { careLevel: [] }, null],
    ['one key', { careLevel: 'crit_tracheostomy' }, 'crit_tracheostomy'],
    ['several as text', { careLevel: 'crit_icu,crit_ecmo' }, 'crit_icu,crit_ecmo'],
    ['all four as a list, in the order chosen', { careLevel: ['crit_ecmo', 'crit_icu', 'crit_ventilated', 'crit_tracheostomy'] }, 'crit_ecmo,crit_icu,crit_ventilated,crit_tracheostomy'],
  ])('%s is stored in care_level and returned', async (_n, extra, expected) => {
    const { token } = await createPatient();
    const res = await post(token, body(extra));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe(expected);
    expect((await rowOf(res.body.request.id)).careLevel).toBe(expected);
  });

  it.each([['an old care level', 'care_icu'], ['free text', 'critical'], ['a repeat', 'crit_icu,crit_icu']])('refuses %s and saves nothing', async (_n, value) => {
    const { token } = await createPatient();
    const res = await post(token, body({ careLevel: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid careLevel/);
    expect(await mine(token)).toHaveLength(0);
  });
});

describe('Oxygen: not answered, Yes with its exact flow rate, No', () => {
  it('not answered stores NULL for the answer and for the flow rate', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    expect(await rowOf(res.body.request.id)).toMatchObject({ equipOxygen: null, equipOxygenLpm: null });
  });

  it.each([[4], [2.5], [0.5], [15]])('Yes with %p LPM stores true and exactly that flow rate (read back from the database)', async (lpm) => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipOxygen: true, equipOxygenLpm: lpm }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ equipOxygen: true, equipOxygenLpm: lpm });
    expect(await rowOf(res.body.request.id)).toMatchObject({ equipOxygen: true, equipOxygenLpm: lpm });
    expect((await mine(token))[0].equipOxygenLpm).toBe(lpm);
  });

  it('No stores false with a NULL flow rate, and the response carries no flow rate', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipOxygen: false }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ equipOxygen: false });
    expect(res.body.request).not.toHaveProperty('equipOxygenLpm');
    expect(await rowOf(res.body.request.id)).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
  });

  it.each([
    ['Yes without a flow rate', { equipOxygen: true }, /equipOxygenLpm is required when Oxygen is Yes/],
    ['Yes with a flow rate over 15', { equipOxygen: true, equipOxygenLpm: 16 }, /at most 15/],
    ['Yes with a flow rate as text', { equipOxygen: true, equipOxygenLpm: '4' }, /equipOxygenLpm must be a number/],
    ['No with a flow rate', { equipOxygen: false, equipOxygenLpm: 4 }, /only accepted when Oxygen is Yes/],
    ['a flow rate without an answer', { equipOxygenLpm: 4 }, /only accepted when Oxygen is Yes/],
  ])('%s creates no request', async (_n, extra, message) => {
    const { token } = await createPatient();
    const res = await post(token, body(extra));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await mine(token)).toHaveLength(0);
  });
});

describe('fields the structured format does not carry', () => {
  it.each([['urgency', 'urgent_24h'], ['mobility', 'walking'], ['equipCardiacMonitor', true], ['equipVentilator', true], ['emergencyContact', 'Jo'], ['vesselName', 'MV Aurora'], ['gpsCoordinates', '1,2'], ['description', 'x']])('%s is refused and nothing is saved', async (field, value) => {
    const { token } = await createPatient();
    const res = await post(token, body({ [field]: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${field} is not accepted for Marine Medical Safety requests`);
    expect(await mine(token)).toHaveLength(0);
  });
});

describe('Medical Reports', () => {
  it('are optional: a request needs none', async () => {
    const { token } = await createPatient();
    expect((await post(token, body())).status).toBe(201);
  });

  it('go through the existing upload route with its shared rules: an allowed type is saved on the request\'s Case, an .exe is refused', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const id = created.body.request.id;
    const ok = await request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 marine report'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.document.name).toBe('report.pdf');
    const bad = await request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('bad'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unsupported file type/);
    const one = await request(app).get(`/requests/me/${id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.case.documents.map((d) => d.name)).toEqual(['report.pdf']);
  });
});

describe('the PDF of a structured Marine request', () => {
  it('prints the Service scope, Origin, Destination, Date of service, Critical level, Oxygen with its flow rate and the Medical History', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ preferredDate: inDays(12), utcOffsetMinutes: 0, careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Chest pain.' }));
    expect(res.status).toBe(201);
    const lines = await renderPdfLines(await rowOf(res.body.request.id));
    expect(valueAfter(lines, 'Service scope:')).toBe('International');
    expect(valueAfter(lines, 'Origin:')).toBe('Mumbai, Maharashtra, India');
    expect(valueAfter(lines, 'Destination:')).toBe('Dubai, Dubai, United Arab Emirates');
    expect(valueAfter(lines, 'Date of service:')).toBeTruthy();
    expect(valueAfter(lines, 'Critical level:')).toBe('ICU, ECMO');
    expect(valueAfter(lines, 'Oxygen:')).toBe('Yes (4 LPM)');
    expect(valueAfter(lines, 'Medical History:')).toBe('Chest pain.');
    for (const label of ['Urgency:', 'Patient mobility:', 'Required on board:', 'Care level:', 'Condition & diagnosis:', 'Transfer scope:', 'Treatment scope:']) {
      expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
    }
  });

  it('leaves out what was not answered and prints Oxygen No as "No"', async () => {
    const { token } = await createPatient();
    const bare = await post(token, body({ serviceScope: 'domestic', destinationCity: { geonameId: 2 } }));
    const bareLines = await renderPdfLines(await rowOf(bare.body.request.id));
    expect(valueAfter(bareLines, 'Service scope:')).toBe('Domestic');
    for (const label of ['Date of service:', 'Critical level:', 'Oxygen:', 'Medical History:']) expect({ label, value: valueAfter(bareLines, label) }).toEqual({ label, value: undefined });
    const no = await post(token, body({ equipOxygen: false }));
    expect(valueAfter(await renderPdfLines(await rowOf(no.body.request.id)), 'Oxygen:')).toBe('No');
  });
});

describe('older generic Marine requests and historical records', () => {
  const generic = (extra = {}) => ({ serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', origin: 'Mumbai, India', destination: 'Dubai, UAE', ...extra });

  it('the generic body an older build sends is refused, not saved as an incomplete request (legacy-body-guard.js)', async () => {
    const { token } = await createPatient();
    const res = await post(token, generic({ description: 'Crew member injured on deck.', urgency: 'planned', country: 'India', patientContact: '+971 50 111 2222' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('app_update_required');
  });

  it('the generic rules still refuse mobility, equipment and a flow rate for Marine', async () => {
    const { token } = await createPatient();
    for (const extra of [{ mobility: 'walking' }, { equipOxygen: false }, { equipOxygenLpm: 4 }]) expect((await post(token, generic(extra))).status).toBe(400);
  });

  it('a historical generic request is returned and its PDF prints as it always did', async () => {
    const { token, user } = await createPatient();
    const old = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'Old Patient', patientAge: 50, patientGender: 'Male', origin: 'Chennai', destination: 'Singapore',
        description: 'Engine-room burn.', urgency: 'planned', referenceNumber: `TEST-MARINE-${Date.now()}`, status: 'submitted',
      },
    });
    const one = await request(app).get(`/requests/me/${old.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(one.body.request).toMatchObject({ description: 'Engine-room burn.', transferScope: null, urgency: 'planned' });
    const lines = await renderPdfLines(old);
    expect(valueAfter(lines, 'From:')).toBe('Chennai');
    expect(valueAfter(lines, 'To:')).toBe('Singapore');
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Engine-room burn.');
    expect(valueAfter(lines, 'Urgency:')).toBe('Planned');
    for (const label of ['Service scope:', 'Origin:', 'Critical level:', 'Oxygen:', 'Medical History:']) expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
  });

  it('text that merely looks like the new format, on a row with no scope, stays a legacy row', async () => {
    const { user } = await createPatient();
    const row = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'Look Alike', origin: 'A', destination: 'B',
        description: 'Marine Medical Safety v1 (history 0)', referenceNumber: `TEST-MARINE-${Date.now()}-2`, status: 'submitted',
      },
    });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
    expect(valueAfter(lines, 'From:')).toBe('A');
  });
});

describe('other services\' PDFs are unchanged', () => {
  it('Mortal Remains still prints its own "Transfer scope", never "Service scope"', async () => {
    const { user } = await createPatient();
    const mortal = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', patientName: 'Name', origin: 'A', destination: 'B', transferScope: 'domestic',
        transportMode: 'ground_transportation', referenceNumber: `TEST-MORTAL-${Date.now()}`, status: 'submitted',
      },
    });
    const lines = await renderPdfLines(mortal);
    expect(valueAfter(lines, 'Transfer scope:')).toBe('Domestic');
    expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
  });

  it('Medical Value Travel (new format) still prints its Treatment scope and Specialty', async () => {
    const { user } = await createPatient();
    const mvt = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'Name', origin: 'Pune', destination: 'Dubai', transferScope: 'international',
        description: composeMvtDescription({ specialty: 'Oncology', history: 'Knee pain.' }), referenceNumber: `TEST-MVT-${Date.now()}`, status: 'submitted',
      },
    });
    const lines = await renderPdfLines(mvt);
    expect(valueAfter(lines, 'Treatment scope:')).toBe('International');
    expect(valueAfter(lines, 'Specialty:')).toBe('Oncology');
    expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
  });

  it('Ground Ambulance still stores and prints its flow rate', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', description: 'Needs transport.', urgency: 'urgent_24h', equipOxygen: true, equipOxygenLpm: 3, careLevel: 'crit_icu' });
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({ equipOxygen: true, equipOxygenLpm: 3, careLevel: 'crit_icu' });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen (3 LPM)');
    expect(valueAfter(lines, 'Service scope:')).toBeUndefined();
  });
});
