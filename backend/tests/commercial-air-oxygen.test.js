// Commercial Air: the oxygen flow rate (LPM) under "Required on board". Needs the test database, like requests.test.js.
//   - Oxygen chosen  -> equipOxygenLpm is required, a positive number up to 15 with at most one decimal
//   - Oxygen not chosen -> equipOxygenLpm is refused
//   - any other service -> equipOxygenLpm is refused; Private Charter keeps its own validator, untouched
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
const { toPatientRequest } = require('../src/modules/requests/request-response');
const { oxygenLpmProblem, OXYGEN_LPM_MAX } = require('../src/common/constants/request.constants');

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
  patientContact: '+91 98765 43210',
  preferredDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), // Ground / Commercial Air need a contact number and a day that is not past (transport-request.validation.js)
  mobility: 'bedridden',
  urgency: 'urgent_24h',
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const KEYS = ['commercialair_stretcher', 'commercialair_wheelchair'];

describe('POST /requests: Commercial Air oxygen flow rate', () => {
  it.each(KEYS)('saves the flow rate with Oxygen for %s and returns it everywhere the request is returned', async (key) => {
    const { token } = await createPatient();
    const res = await post(token, body(key, { equipOxygen: true, equipOxygenLpm: 4 }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: key, equipOxygen: true, equipOxygenLpm: 4 });

    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request).toMatchObject({ equipOxygen: true, equipOxygenLpm: 4 });
    const list = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(list.body.requests[0]).toMatchObject({ equipOxygenLpm: 4 });

    // it is really stored (survives a restart), as a number
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.equipOxygenLpm).toBe(4);
  });

  it('keeps one decimal place (2.5 LPM)', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', { equipOxygen: true, equipOxygenLpm: 2.5 }));
    expect(res.status).toBe(201);
    expect(res.body.request.equipOxygenLpm).toBe(2.5);
  });

  it('refuses Oxygen without a flow rate', async () => {
    const { token } = await createPatient();
    for (const extra of [{ equipOxygen: true }, { equipOxygen: true, equipOxygenLpm: null }]) {
      const res = await post(token, body('commercialair_wheelchair', extra));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('equipOxygenLpm is required when Oxygen is selected');
    }
  });

  it.each([[0], [-2], [OXYGEN_LPM_MAX + 1], [2.55], ['4'], [true], ['abc'], [[4]]])('refuses the flow rate %p', async (value) => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', { equipOxygen: true, equipOxygenLpm: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/equipOxygenLpm/);
    const mine = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(mine.body.requests).toHaveLength(0); // nothing was saved
  });

  it.each([
    ['Oxygen not selected', { equipOxygen: false, equipOxygenLpm: 4 }],
    ['Oxygen not sent', { equipOxygenLpm: 4 }],
  ])('refuses a flow rate when %s', async (_name, extra) => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_stretcher', extra));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only accepted when Oxygen is selected/);
  });

  it('still takes a Commercial Air request with no oxygen at all, and returns no flow rate', async () => {
    const { token } = await createPatient();
    for (const extra of [{}, { equipOxygen: false }, { equipOxygen: false, equipOxygenLpm: null }, { equipCardiacMonitor: true }, { equipVentilator: false }]) {
      const res = await post(token, body('commercialair_stretcher', extra));
      expect(res.status).toBe(201);
      expect(res.body.request).not.toHaveProperty('equipOxygenLpm');
    }
  });

  it('still takes the other Required-on-board items and the medical report upload', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('commercialair_wheelchair', { equipOxygen: true, equipOxygenLpm: 3, equipCardiacMonitor: true, equipVentilator: false }));
    expect(res.status).toBe(201);
    // equipVentilator: false (all that older builds send) is tolerated but never stored for Commercial Air
    expect(res.body.request).toMatchObject({ equipCardiacMonitor: true, equipVentilator: null });
    const upload = await request(app)
      .post(`/requests/me/${res.body.request.id}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
  });

  // (Home Healthcare is not in this list any more: it has its own validator, which refuses these fields with its own message; see home-healthcare-validation.test.js.)
  it.each([['air'], ['hospital'], ['tele'], ['marine'], ['medvalue']])('refuses a flow rate for %s', async (key) => {
    const { token } = await createPatient();
    const extra = key === 'air' ? { equipOxygen: true } : {};
    const res = await post(token, body(key, { ...extra, mobility: undefined, equipOxygenLpm: 4 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('equipOxygenLpm is only accepted for Commercial Air and Ground Ambulance requests');
  });

  it('keeps the older air key\'s oxygen exactly as it was (no flow rate)', async () => {
    const { token } = await createPatient();
    const res = await post(token, body('air', { equipOxygen: true }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ equipOxygen: true });
    expect(res.body.request).not.toHaveProperty('equipOxygenLpm');
  });

  it('does not change Private Charter: its own validator still refuses the field, as any unknown one', async () => {
    const { token } = await createPatient();
    const res = await post(token, {
      serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Asha Nair', equipOxygen: true, equipOxygenLpm: 4,
    });
    expect(res.status).toBe(400);
    expect(res.body.fields.equipOxygenLpm).toBe('This field is not accepted for Private Charter requests.');
  });
});

describe('Commercial Air oxygen flow rate: the pieces', () => {
  it('oxygenLpmProblem accepts 0.5 to 15 with one decimal, and nothing else', () => {
    for (const ok of [0.5, 1, 2.5, 4, 10.5, 15]) expect(oxygenLpmProblem(ok)).toBeNull();
    for (const bad of [0, -1, 15.1, 16, 1.25, NaN, Infinity, '4', null, undefined, {}, true]) expect(oxygenLpmProblem(bad)).toEqual(expect.any(String));
  });

  it('the patient response carries the flow rate only when one was saved (every other service returns what it always did)', () => {
    const row = { id: 1, serviceKey: 'privatecharter', equipOxygen: true, equipOxygenLpm: null };
    expect(toPatientRequest(row)).not.toHaveProperty('equipOxygenLpm');
    expect(toPatientRequest({ ...row, serviceKey: 'commercialair_stretcher', equipOxygenLpm: 6 })).toMatchObject({ equipOxygenLpm: 6 });
  });

  it('the request summary PDF says "Oxygen (4 LPM)" and leaves plain Oxygen alone for other services', async () => {
    const base = {
      referenceNumber: 'REQ-2001', serviceType: 'Medical Escort (Commercial Airlines)', patientName: 'Asha Nair',
      origin: 'Mumbai', destination: 'Dubai', status: 'submitted', createdAt: '2031-01-01T10:00:00.000Z', case: null, equipOxygen: true, equipVentilator: true,
    };
    const commercial = await renderPdfLines({ ...base, serviceKey: 'commercialair_stretcher', equipOxygenLpm: 4 });
    expect(valueAfter(commercial, 'Required on board:')).toBe('Oxygen (4 LPM), Ventilator');
    const ground = await renderPdfLines({ ...base, serviceKey: 'ground', equipOxygenLpm: null });
    expect(valueAfter(ground, 'Required on board:')).toBe('Oxygen, Ventilator');
  });
});
