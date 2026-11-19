// Commercial Air care level: exactly ICU, Ventilated, Tracheostomy, ECMO (keys crit_icu, crit_ventilated, crit_tracheostomy, crit_ecmo).
// Needs the test database, like requests.test.js. Private Charter keeps its own four care levels and its own validator, untouched.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient } = require('./helpers');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { careLevelText } = require('../src/common/utils/care-level');
const {
  COMMERCIAL_AIR_CARE_LEVEL_KEYS, CARE_LEVEL_KEYS, commercialAirCareLevelProblem,
} = require('../src/common/constants/request.constants');

afterAll(async () => {
  await prisma.$disconnect();
});

const body = (serviceKey, extra = {}) => ({
  serviceType: 'Medical Escort (Commercial Airlines)',
  serviceKey,
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  origin: 'Mumbai, India',
  destination: 'Dubai, UAE',
  mobility: 'bedridden',
  urgency: 'urgent_24h',
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const SUBTYPES = ['commercialair_stretcher', 'commercialair_wheelchair'];

describe('the four Commercial Air care levels', () => {
  it('are exactly ICU, Ventilated, Tracheostomy, ECMO', () => {
    expect(COMMERCIAL_AIR_CARE_LEVEL_KEYS).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
  });
  it('leave the original care levels (Private Charter, older requests) exactly as they were', () => {
    expect(CARE_LEVEL_KEYS).toEqual(['care_icu', 'care_stable', 'care_ambulatory', 'care_na']);
  });
});

describe('POST /requests: Commercial Air care level', () => {
  it.each(SUBTYPES.flatMap((key) => COMMERCIAL_AIR_CARE_LEVEL_KEYS.map((level) => [key, level])))('%s saves %s and returns it everywhere', async (key, level) => {
    const { token } = await createPatient();
    const res = await post(token, body(key, { careLevel: level }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe(level);
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.careLevel).toBe(level);
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.careLevel).toBe(level);
  });

  it('takes more than one, in the order chosen', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', { careLevel: 'crit_icu,crit_ventilated,crit_ecmo' }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe('crit_icu,crit_ventilated,crit_ecmo');
  });

  it('still takes a request with no care level, and works together with the oxygen flow rate', async () => {
    const { token } = await createPatient();
    expect((await post(token, body('commercialair_wheelchair'))).status).toBe(201);
    const res = await post(token, body('commercialair_stretcher', { careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4 }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 4 });
  });

  it.each([
    ['an original care level key', 'care_icu'],
    ['an original label', 'ICU / Critical'],
    ['Stable / Monitored', 'Stable / Monitored'],
    ['Not Applicable', 'care_na'],
    ['an unknown option', 'crit_other'],
    ['free text', 'very sick'],
    ['a good one and a bad one', 'crit_icu,care_stable'],
    ['a repeated option', 'crit_icu,crit_icu'],
    ['an empty piece', 'crit_icu,'],
    ['an empty text', ''],
    ['the wrong case', 'CRIT_ICU'],
    ['a list instead of text', ['crit_icu']],
    ['a number', 5],
    ['a boolean', true],
  ])('refuses %s', async (_name, value) => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', { careLevel: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid careLevel/);
    const mine = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(mine.body.requests).toHaveLength(0); // nothing saved
  });

  it('the other services keep their care level exactly as before (the labels the app sends)', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('air', { careLevel: 'ICU / Critical, Stable / Monitored' }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe('ICU / Critical, Stable / Monitored');
  });
});

describe('Private Charter keeps its own care levels (untouched)', () => {
  it('still refuses a Commercial Air care level, as any value that is not one of its own four', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Asha Nair', careLevel: ['crit_icu'] });
    expect(res.status).toBe(400);
    expect(res.body.fields.careLevel).toMatch(/Care level must be a list of: care_icu, care_stable, care_ambulatory, care_na/);
  });
});

describe('how a stored Commercial Air care level reads (PDF, Bitrix comment)', () => {
  it('careLevelText gives the English labels, and leaves the original ones as they were', () => {
    expect(careLevelText('crit_icu,crit_ventilated')).toBe('ICU, Ventilated');
    expect(careLevelText('crit_tracheostomy, crit_ecmo')).toBe('Tracheostomy, ECMO');
    expect(careLevelText('care_icu,care_stable')).toBe('ICU / Critical, Stable / Monitored');
    expect(careLevelText('needs crit_icu bed')).toBe('needs crit_icu bed'); // a key inside a sentence is not a piece
  });
  it('the request summary PDF says "ICU, ECMO"', async () => {
    const lines = await renderPdfLines({
      referenceNumber: 'REQ-2002', serviceType: 'Medical Escort (Commercial Airlines)', serviceKey: 'commercialair_stretcher', patientName: 'Asha Nair',
      origin: 'Mumbai', destination: 'Dubai', status: 'submitted', createdAt: '2031-01-01T10:00:00.000Z', case: null, careLevel: 'crit_icu,crit_ecmo',
    });
    expect(valueAfter(lines, 'Care level:')).toBe('ICU, ECMO');
  });
  it('commercialAirCareLevelProblem accepts exactly the four, once each', () => {
    for (const ok of ['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo', 'crit_icu, crit_ecmo']) expect(commercialAirCareLevelProblem(ok)).toBeNull();
    for (const bad of ['', 'care_icu', 'crit_icu,crit_icu', null, undefined, 3, ['crit_icu']]) expect(commercialAirCareLevelProblem(bad)).toEqual(expect.any(String));
  });
});
