// Medical Value Travel (serviceKey "medvalue") through the API: the structured format is validated and stored in the existing columns; the generic body an
// older app build sends keeps working; historical requests stay readable. Needs the test database, like requests.test.js (the pure rules are in
// medical-value-travel-validation.test.js). The GeoNames lookup is replaced by a small table so no city data is needed.
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
    1: { geonameId: 1, name: 'Pune', label: 'Pune, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
    2: { geonameId: 2, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
    3: { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai' },
  };
  return { ...actual, getVerifiedCity: jest.fn(async (id) => CITIES[id] || null) };
});

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient } = require('./helpers');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');

afterAll(async () => {
  await prisma.$disconnect();
});

const body = (extra = {}) => ({
  serviceType: 'Medical Value Travel',
  serviceKey: 'medvalue',
  treatmentScope: 'international',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'IN',
  patientContact: '+91 98765 43210',
  currentCity: { geonameId: 1 },
  destinationCity: { geonameId: 3 },
  specialty: 'Oncology',
  utcOffsetMinutes: 0,
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const mine = async (token) => (await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`)).body.requests;
const rowOf = (id) => prisma.serviceRequest.findUnique({ where: { id }, include: { case: true } });
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('POST /requests: a structured Medical Value Travel request', () => {
  it('is saved in the existing columns, with a Case, no urgency, and the scope in transfer_scope', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ medicalHistory: 'Knee pain for two years.' }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      serviceKey: 'medvalue', serviceType: 'Medical Value Travel', status: 'submitted', transferScope: 'international', patientName: 'Asha Nair', patientAge: 61,
      patientGender: 'Female', country: 'India', patientContact: '+919876543210', origin: 'Pune, Maharashtra, India', destination: 'Dubai, Dubai, United Arab Emirates',
      preferredDate: null, urgency: null, originCityName: 'Pune', originCountryCode: 'IN', destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    });
    // the specialty is in its own column; the description is only the Medical History
    expect(res.body.request).toMatchObject({ specialty: 'Oncology', otherSpecialty: null, description: 'Knee pain for two years.' });
    expect(res.body.request).not.toHaveProperty('originGeonameId'); // never sent to a phone
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({
      transferScope: 'international', transportMode: null, urgency: null, mobility: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null,
      patientLocation: 'Pune, Maharashtra, India', originGeonameId: 1, originTimezone: 'Asia/Kolkata', destinationGeonameId: 3, patientContact: '+919876543210', country: 'India',
    });
    expect(row.case).toBeTruthy();
    expect(row.case.urgency).toBe('routine'); // the Case keeps its own default: no urgency was given
  });

  it('keeps a typed city exactly as typed and leaves its GeoNames columns empty (an unverified city)', async () => {
    const { token } = await createPatient();
    const typed = '  Hinjewadi   Phase 2 ';
    const res = await post(token, body({ treatmentScope: 'domestic', currentCity: { text: typed }, destinationCity: { text: 'Chennai' } }));
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({
      origin: typed, patientLocation: typed, destination: 'Chennai', transferScope: 'domestic',
      originGeonameId: null, originCityName: null, originCountryCode: null, originTimezone: null,
      destinationGeonameId: null, destinationCityName: null, destinationCountryCode: null,
    });
  });

  it('stores Other with its own text, and an optional date', async () => {
    const { token } = await createPatient();
    const day = inDays(10);
    const res = await post(token, body({ specialty: 'Other', otherSpecialty: 'Sports medicine', preferredDate: day }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ specialty: 'Other', otherSpecialty: 'Sports medicine', description: null });
    expect(await rowOf(res.body.request.id)).toMatchObject({ specialty: 'Other', otherSpecialty: 'Sports medicine', description: null });
    const [raw] = await prisma.$queryRawUnsafe('SELECT DATE_FORMAT(preferred_date, "%Y-%m-%d") AS day FROM service_requests WHERE id = ?', res.body.request.id);
    expect(raw.day).toBe(day);
  });

  it.each([
    ['a missing specialty', { specialty: undefined }, /specialty must be one of/],
    ['Other without its text', { specialty: 'Other' }, /otherSpecialty is required/],
    ['a past date', { preferredDate: '2000-01-01' }, /preferredDate cannot be in the past/],
    ['a wrong scope', { treatmentScope: 'both' }, /treatmentScope must be one of/],
    ['an urgency', { urgency: 'urgent_24h' }, /urgency is not accepted/],
    ['a client description', { description: 'x' }, /description is not accepted/],
    ['a Domestic destination abroad', { treatmentScope: 'domestic' }, /must be in the selected country for a Domestic request/],
    ['an International destination at home', { destinationCity: { geonameId: 2 } }, /must be in a different country for an International request/],
    ['a Current City outside the country', { country: 'AE' }, /currentCity must be in the selected country/],
    ['an unknown city id', { currentCity: { geonameId: 999 } }, /currentCity is not a valid city/],
    ['a bad phone', { patientContact: '12345' }, /patientContact must be a valid phone/],
  ])('refuses %s with a 400 and saves nothing', async (_n, extra, message) => {
    const { token } = await createPatient();
    const payload = body(extra);
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const res = await post(token, payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(await mine(token)).toHaveLength(0);
  });

  it('takes medical reports through the existing upload route, and the shared rules still apply', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const id = created.body.request.id;
    const ok = await request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 mvt report'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.document.name).toBe('report.pdf');
    const bad = await request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('bad'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
    const one = await request(app).get(`/requests/me/${id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.case.documents.map((d) => d.name)).toEqual(['report.pdf']);
  });

  it('a request is optional in its reports: none are needed', async () => {
    const { token } = await createPatient();
    expect((await post(token, body())).status).toBe(201);
  });
});

describe('Medical Value Travel: older app builds and historical requests', () => {
  const generic = (extra = {}) => ({ serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'John Doe', origin: 'Mumbai, India', destination: 'Dubai, UAE', ...extra });

  it('the generic body an older build sends is still accepted, exactly as before (no scope, its own urgency and description)', async () => {
    const { token } = await createPatient();
    const res = await post(token, generic({ description: 'Needs a knee replacement.', urgency: 'planned', country: 'India', patientContact: '+971 50 111 2222' }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: 'medvalue', transferScope: null, urgency: 'planned', description: 'Needs a knee replacement.', origin: 'Mumbai, India' });
    expect((await rowOf(res.body.request.id)).case).toBeTruthy();
  });

  it('the generic rules still refuse mobility and equipment for medvalue', async () => {
    const { token } = await createPatient();
    expect((await post(token, generic({ mobility: 'walking' }))).status).toBe(400);
    expect((await post(token, generic({ equipOxygen: false }))).status).toBe(400);
  });

  it('a historical generic request is returned and printed as it always was ("Condition & diagnosis", no scope, no specialty)', async () => {
    const { token, user } = await createPatient();
    const old = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'Old Patient', patientAge: 50, patientGender: 'Male',
        origin: 'Delhi', destination: 'Singapore', description: 'Heart valve surgery.', urgency: 'planned', referenceNumber: `TEST-MVT-${Date.now()}`, status: 'submitted',
      },
    });
    const one = await request(app).get(`/requests/me/${old.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(one.body.request).toMatchObject({ description: 'Heart valve surgery.', transferScope: null, urgency: 'planned' });
    const lines = await renderPdfLines(old);
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Heart valve surgery.');
    expect(valueAfter(lines, 'Treatment scope:')).toBeUndefined();
    expect(valueAfter(lines, 'Specialty:')).toBeUndefined();
    expect(valueAfter(lines, 'Urgency:')).toBe('Planned');
  });

  it('text that merely looks like the new format, on a row with no scope, stays a legacy row', async () => {
    const { user } = await createPatient();
    const row = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'Look Alike', origin: 'A', destination: 'B',
        description: 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology', referenceNumber: `TEST-MVT-${Date.now()}-2`, status: 'submitted',
      },
    });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'Treatment scope:')).toBeUndefined();
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBeDefined(); // the text is printed the way the old generic row prints any description
    expect(valueAfter(lines, 'Specialty:')).toBeUndefined();
  });
});

describe('Medical Value Travel: the PDF of a new request', () => {
  it('shows the Treatment scope, the Specialty (with Other), the cities, the date and the Medical History; no urgency, care or oxygen rows', async () => {
    const { token } = await createPatient();
    const day = inDays(12);
    const res = await post(token, body({ specialty: 'Other', otherSpecialty: 'Sports medicine', medicalHistory: 'Knee pain.', preferredDate: day }));
    expect(res.status).toBe(201);
    const lines = await renderPdfLines(await rowOf(res.body.request.id));
    expect(valueAfter(lines, 'Treatment scope:')).toBe('International');
    expect(valueAfter(lines, 'Specialty:')).toBe('Other (Sports medicine)');
    expect(valueAfter(lines, 'Current city:')).toBe('Pune, Maharashtra, India');
    expect(valueAfter(lines, 'Destination city:')).toBe('Dubai, Dubai, United Arab Emirates');
    expect(valueAfter(lines, 'Medical History:')).toBe('Knee pain.');
    expect(valueAfter(lines, 'Preferred treatment date:')).toBeTruthy();
    for (const label of ['Urgency:', 'Care level:', 'Required on board:', 'Patient mobility:', 'Transfer scope:']) expect(valueAfter(lines, label)).toBeUndefined();
  });

  it('a Domestic request with no history prints no Medical History row', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ treatmentScope: 'domestic', destinationCity: { geonameId: 2 } }));
    expect(res.status).toBe(201);
    const lines = await renderPdfLines(await rowOf(res.body.request.id));
    expect(valueAfter(lines, 'Treatment scope:')).toBe('Domestic');
    expect(valueAfter(lines, 'Medical History:')).toBeUndefined();
  });
});

describe('other services are unaffected', () => {
  it('Mortal Remains still prints its "Transfer scope" and stores its own scope', async () => {
    const { user } = await createPatient();
    const mortal = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', patientName: 'Name', origin: 'A', destination: 'B', transferScope: 'domestic',
        transportMode: 'ground_transportation', referenceNumber: `TEST-MORTAL-${Date.now()}`, status: 'submitted',
      },
    });
    const lines = await renderPdfLines(mortal);
    expect(valueAfter(lines, 'Transfer scope:')).toBe('Domestic');
    expect(valueAfter(lines, 'Treatment scope:')).toBeUndefined();
  });

  it('the structured fields are not taken for another service: a hospital body with a specialty is still the generic request', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', specialty: 'Oncology' });
    expect(res.status).toBe(201);
    expect((await rowOf(res.body.request.id)).transferScope).toBeNull();
  });
});
