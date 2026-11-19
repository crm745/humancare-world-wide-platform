// Commercial Air restructuring (backend): Travel type (Stretcher / Wheelchair) is the service key's subtype, so it is already persisted and
// returned; Required on board is Oxygen and Cardiac monitor only (the Ventilator is the care level "Ventilated"). Needs the test database.
// Private Charter and every other service keep their rules (their suites, and the checks at the end).
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
  urgency: 'urgent_24h',
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const SUBTYPES = [['commercialair_stretcher', 'Stretcher'], ['commercialair_wheelchair', 'Wheelchair']];

describe('Travel type', () => {
  it.each(SUBTYPES)('%s is saved with the request and returned by every API that returns it', async (key) => {
    const { token } = await createPatient();
    const res = await post(token, body(key, { serviceType: `Medical Escort (Commercial Airlines) — ${key.split('_')[1]}` }));
    expect(res.status).toBe(201);
    expect(res.body.request.serviceKey).toBe(key);
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.serviceKey).toBe(key);
    const list = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(list.body.requests[0].serviceKey).toBe(key);
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.serviceKey).toBe(key); // survives a restart: it is a column
  });

  it('is mandatory: a Commercial Air request with no subtype is refused, with the existing { error } format', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Travel type is required: serviceKey must be commercialair_stretcher or commercialair_wheelchair' });
  });

  it('only Stretcher or Wheelchair: any other subtype is an unknown service key', async () => {
    const { token } = await createPatient();
    for (const key of ['commercialair_cargo', 'commercialair_', 'commercialair_Stretcher']) {
      const res = await post(token, body(key));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Unknown serviceKey');
    }
  });

  it('works with every other Commercial Air answer: oxygen flow rate, care levels in the order chosen, Cardiac monitor', async () => {
    const { token } = await createPatient();
    for (const [key] of SUBTYPES) {
      const res = await post(token, body(key, { careLevel: 'crit_ecmo,crit_icu,crit_ventilated', equipOxygen: true, equipOxygenLpm: 3.5, equipCardiacMonitor: true }));
      expect(res.status).toBe(201);
      expect(res.body.request).toMatchObject({ careLevel: 'crit_ecmo,crit_icu,crit_ventilated', equipOxygen: true, equipOxygenLpm: 3.5, equipCardiacMonitor: true });
    }
  });
});

describe('Required on board: Oxygen and Cardiac monitor only', () => {
  it.each(SUBTYPES)('%s refuses the Ventilator as equipment', async (key) => {
    const { token } = await createPatient();
    const refused = await post(token, body(key, { equipVentilator: true }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('equipVentilator is not accepted for Commercial Air requests (Ventilated is a care level)');
    // a value that is not even a boolean is refused by the existing equipment check, as for every service
    for (const value of ['true', 1]) {
      const res = await post(token, body(key, { equipVentilator: value }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('equipVentilator must be true or false');
    }
    const mine = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(mine.body.requests).toHaveLength(0);
  });

  it('tolerates equipVentilator: false (older builds always send it) but never stores it', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', { equipVentilator: false }));
    expect(res.status).toBe(201);
    expect(res.body.request.equipVentilator).toBeNull();
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.equipVentilator).toBeNull();
  });

  it('"Ventilated" is still available, as a care level', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_wheelchair', { careLevel: 'crit_ventilated' }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe('crit_ventilated');
  });

  it('Patient mobility is not required (the new form does not ask it), and an older build that still sends it is accepted', async () => {
    const { token } = await createPatient();
    expect((await post(token, body('commercialair_stretcher'))).status).toBe(201);
    const old = await post(token, body('commercialair_stretcher', { mobility: 'bedridden' }));
    expect(old.status).toBe(201);
    expect(old.body.request.mobility).toBe('bedridden');
  });

  it('the other services keep the Ventilator exactly as before', async () => {
    const { token } = await createPatient();
    const res = await post(token, { ...body('air'), serviceType: 'Air Ambulance', mobility: 'wheelchair', equipVentilator: true });
    expect(res.status).toBe(201);
    expect(res.body.request.equipVentilator).toBe(true);
  });
});

describe('request summary PDF', () => {
  const base = {
    referenceNumber: 'REQ-3001', serviceType: 'Medical Escort (Commercial Airlines)', patientName: 'Asha Nair', origin: 'Mumbai', destination: 'Dubai',
    status: 'submitted', createdAt: '2031-01-01T10:00:00.000Z', case: null, equipOxygen: true, equipOxygenLpm: 4, equipCardiacMonitor: true, careLevel: 'crit_icu,crit_ecmo',
  };
  it.each(SUBTYPES)('%s: shows the Travel type, care level and equipment', async (key, label) => {
    const lines = await renderPdfLines({ ...base, serviceKey: key });
    expect(valueAfter(lines, 'Travel type:')).toBe(label);
    expect(valueAfter(lines, 'Care level:')).toBe('ICU, ECMO');
    expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen (4 LPM), Cardiac monitor');
  });
  it('other services have no Travel type row', async () => {
    const lines = await renderPdfLines({ ...base, serviceKey: 'ground', equipOxygenLpm: null });
    expect(valueAfter(lines, 'Travel type:')).toBeUndefined();
  });
  it('older Commercial Air requests (Ventilator saved as equipment) still print as they were', async () => {
    const lines = await renderPdfLines({ ...base, serviceKey: 'commercialair_stretcher', equipVentilator: true });
    expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen (4 LPM), Cardiac monitor, Ventilator');
  });
});
