jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
// A real Bitrix call is an external network dependency tests shouldn't rely on —
// requests.service.js already treats it as best-effort (wrapped in try/catch), so
// mocking it out just keeps tests fast and offline, not changing what's under test.
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient } = require('./helpers');
const { createLead, sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
const { retryFailedBitrixSyncs } = require('../src/modules/bitrix/bitrix-retry.service');

afterAll(async () => {
  await prisma.$disconnect();
});

const baseRequestBody = {
  serviceType: 'Air Ambulance',
  patientName: 'John Doe',
  origin: 'Mumbai, India',
  destination: 'Dubai, UAE',
};

const mortalBody = {
  serviceType: 'Mortal Remains Transportation — Within India',
  serviceKey: 'mortal_domestic',
  patientName: 'Late Suresh Kale',
  origin: 'Pune',
  destination: 'Nagpur',
  deceasedRelation: 'Brother',
  placeOfDeath: 'Pune',
  dateOfDeath: '2026-10-20',
};

describe('POST /requests', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/requests').send(baseRequestBody);
    expect(res.status).toBe(401);
  });

  it('rejects a request missing required fields', async () => {
    const { token } = await createPatient();
    const res = await request(app)
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ serviceType: 'Air Ambulance' });
    expect(res.status).toBe(400);
  });

  it('creates a request with a reference number, auto-creating its Case', async () => {
    const { token } = await createPatient();
    const res = await request(app)
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(baseRequestBody);
    expect(res.status).toBe(201);
    expect(res.body.request.referenceNumber).toMatch(/^REQ-/);
    expect(res.body.request.status).toBe('submitted');
  });
});

describe('Bitrix24 on/off switch', () => {
  afterEach(() => { delete process.env.BITRIX_SYNC_ENABLED; });

  it('sends nothing and records no failure while the switch is off', async () => {
    createLead.mockClear();
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(baseRequestBody);
    expect(res.status).toBe(201);
    expect(createLead).not.toHaveBeenCalled();
    const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(saved.bitrixLeadId).toBeNull();
    expect(saved.bitrixSyncAttempts).toBe(0);
    await expect(retryFailedBitrixSyncs()).resolves.toBe(0);
    expect(createLead).not.toHaveBeenCalled();
  });

  it('sends new requests once switched on, but never the ones made while it was off', async () => {
    createLead.mockClear();
    const { token } = await createPatient();
    const whileOff = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(baseRequestBody);

    process.env.BITRIX_SYNC_ENABLED = 'true';
    const whileOn = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(baseRequestBody);
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0].referenceNumber).toBe(whileOn.body.request.referenceNumber);

    await retryFailedBitrixSyncs();
    const off = await prisma.serviceRequest.findUnique({ where: { id: whileOff.body.request.id } });
    expect(off.bitrixLeadId).toBeNull();
    expect(createLead).toHaveBeenCalledTimes(1);
  });
  it('saves the app service key and sends it with the lead', async () => {
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`)
      .send({ ...baseRequestBody, serviceType: 'Commercial Airlines — Wheelchair (CAW)', serviceKey: 'commercialair_wheelchair' });
    expect(res.status).toBe(201);
    expect(res.body.request.serviceKey).toBe('commercialair_wheelchair');
    expect(createLead.mock.calls[0][0]).toMatchObject({ serviceKey: 'commercialair_wheelchair', industry: 712, origin: 'Mumbai, India' });
  });

  it('ignores the optional "More details" answers an older app version may still send', async () => {
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`)
      .send({ ...baseRequestBody, additionalInfo: 'Prefers a female nurse', specialRequirements: 'Oxygen', referralSource: 'Google Search' });
    expect(res.status).toBe(201);
    expect(res.body.request).not.toHaveProperty('additionalInfo');
    expect(res.body.request).not.toHaveProperty('specialRequirements');
    expect(res.body.request).not.toHaveProperty('referralSource');
    const { buildLeadFields } = jest.requireActual('../src/modules/bitrix/bitrix-lead');
    const sent = JSON.stringify(buildLeadFields(createLead.mock.calls[0][0]));
    expect(sent).not.toMatch(/female nurse|Google Search/);
  });

  it('sends an uploaded medical report to the Bitrix lead of the request', async () => {
    sendMedicalReportToBitrix.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const created = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(baseRequestBody);
    const upload = await request(app).post(`/requests/me/${created.body.request.id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(sendMedicalReportToBitrix).toHaveBeenCalledWith(
      12345,
      expect.objectContaining({ type: 'Medical Report', name: 'report.pdf' }),
      { comments: expect.stringContaining('Medical reports (1): report.pdf') },
    );
  });

  it('lists the names of every report in the lead comment, so none is lost when the field keeps one', async () => {
    sendMedicalReportToBitrix.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const created = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(baseRequestBody);
    const send = (filename) => request(app).post(`/requests/me/${created.body.request.id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), { filename, contentType: 'application/pdf' });
    expect((await send('discharge.pdf')).status).toBe(201);
    expect((await send('ct-report.pdf')).status).toBe(201);
    expect(sendMedicalReportToBitrix).toHaveBeenCalledTimes(2);
    expect(sendMedicalReportToBitrix.mock.calls[1][2].comments).toContain('Medical reports (2): discharge.pdf, ct-report.pdf');
  });

  it('keeps a death certificate with us and does not send it to the lead as a medical report', async () => {
    sendMedicalReportToBitrix.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const created = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(mortalBody);
    expect(created.status).toBe(201);
    const upload = await request(app).post(`/requests/me/${created.body.request.id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'death-certificate.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(upload.body.document.type).toBe('Death Certificate');
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
  });

  it('refuses a service key the app does not have', async () => {
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send({ ...baseRequestBody, serviceKey: 'spaceship' });
    expect(res.status).toBe(400);
  });
});

describe('Mortal Remains requests', () => {
  it('saves the deceased details', async () => {
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(mortalBody);
    expect(res.status).toBe(201);
    const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(saved).toMatchObject({ serviceKey: 'mortal_domestic', deceasedRelation: 'Brother', placeOfDeath: 'Pune' });
    expect(saved.dateOfDeath.toISOString().slice(0, 10)).toBe('2026-10-20');
  });

  it.each(['deceasedRelation', 'placeOfDeath', 'dateOfDeath'])('requires %s', async (field) => {
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send({ ...mortalBody, [field]: '' });
    expect(res.status).toBe(400);
  });

  it('refuses a date of death in the future', async () => {
    const { token } = await createPatient();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send({ ...mortalBody, dateOfDeath: nextWeek });
    expect(res.status).toBe(400);
  });
});

describe('request lifecycle for the patient who submitted it', () => {
  it('lists, fetches, and downloads the summary for an own request', async () => {
    const { token } = await createPatient();
    const createRes = await request(app)
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(baseRequestBody);
    const requestId = createRes.body.request.id;

    const listRes = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.requests.some((r) => r.id === requestId)).toBe(true);

    const detailRes = await request(app).get(`/requests/me/${requestId}`).set('Authorization', `Bearer ${token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.request.id).toBe(requestId);

    const summaryRes = await request(app)
      .get(`/requests/me/${requestId}/summary`)
      .set('Authorization', `Bearer ${token}`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.headers['content-type']).toMatch(/pdf/);
  });

  it('accepts a document upload for its own (auto-created) case', async () => {
    const { token } = await createPatient();
    const createRes = await request(app)
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(baseRequestBody);
    const requestId = createRes.body.request.id;

    const uploadRes = await request(app)
      .post(`/requests/me/${requestId}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.document.name).toBe('report.pdf');
  });

  it("rejects an unsupported file type", async () => {
    const { token } = await createPatient();
    const createRes = await request(app)
      .post('/requests')
      .set('Authorization', `Bearer ${token}`)
      .send(baseRequestBody);
    const requestId = createRes.body.request.id;

    const uploadRes = await request(app)
      .post(`/requests/me/${requestId}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('bad'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(uploadRes.status).toBe(400);
  });
});

describe('POST /requests: medical page fields', () => {
  // A patient-transport service on the shared (legacy) rules. Private Charter has its own strict
  // validation, tested in private-charter-validation.test.js and in the persistence test below.
  const airBody = { ...baseRequestBody, serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground' };
  const post = (token, body) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);

  it('saves mobility, equipment and urgency for an air ambulance request', async () => {
    const { token } = await createPatient();
    const res = await post(token, {
      ...airBody, mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: false, urgency: 'critical_6h',
    });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: false, urgency: 'critical_6h',
    });
  });

  it('copies the urgency to the Case on the older critical / urgent / routine scale', async () => {
    const { token } = await createPatient();
    const cases = {};
    for (const urgency of ['critical_6h', 'urgent_24h', 'planned']) {
      const res = await post(token, { ...airBody, urgency });
      cases[urgency] = (await prisma.case.findUnique({ where: { serviceRequestId: res.body.request.id } })).urgency;
    }
    expect(cases).toEqual({ critical_6h: 'critical', urgent_24h: 'urgent', planned: 'routine' });
  });

  it('accepts a request without them (older app versions) and leaves them empty', async () => {
    const { token } = await createPatient();
    const res = await post(token, airBody);
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ mobility: null, equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null, urgency: null });
    const saved = await prisma.case.findUnique({ where: { serviceRequestId: res.body.request.id } });
    expect(saved.urgency).toBe('routine');
  });

  it('refuses a mobility, equipment or urgency value that is not on the list', async () => {
    const { token } = await createPatient();
    const mobility = await post(token, { ...airBody, mobility: 'flying' });
    expect(mobility.status).toBe(400);
    expect(mobility.body.error).toMatch(/Invalid mobility/);
    const urgency = await post(token, { ...airBody, urgency: 'asap' });
    expect(urgency.status).toBe(400);
    expect(urgency.body.error).toMatch(/Invalid urgency/);
    const equipment = await post(token, { ...airBody, equipOxygen: 'yes' });
    expect(equipment.status).toBe(400);
    expect(equipment.body.error).toMatch(/equipOxygen must be true or false/);
  });

  it('accepts mobility and equipment for ground ambulance and commercial airline too', async () => {
    const { token } = await createPatient();
    for (const serviceKey of ['ground', 'commercialair_stretcher', 'commercialair_wheelchair']) {
      const res = await post(token, { ...baseRequestBody, serviceKey, mobility: 'wheelchair', equipVentilator: false });
      expect(res.status).toBe(201);
    }
  });

  it.each([['hospital'], ['homecare'], ['tele'], ['mortal_domestic']])('refuses mobility and equipment for %s', async (serviceKey) => {
    const { token } = await createPatient();
    const extra = serviceKey === 'mortal_domestic' ? { deceasedRelation: 'Son', placeOfDeath: 'Pune', dateOfDeath: '2026-10-20' } : {};
    const mobility = await post(token, { ...baseRequestBody, ...extra, serviceKey, mobility: 'walking' });
    expect(mobility.status).toBe(400);
    expect(mobility.body.error).toMatch(/only accepted for air and ground/);
    const equipment = await post(token, { ...baseRequestBody, ...extra, serviceKey, equipOxygen: false });
    expect(equipment.status).toBe(400);
  });

  it('still takes an urgency on a service that has no mobility or equipment', async () => {
    const { token } = await createPatient();
    const res = await post(token, { ...baseRequestBody, serviceKey: 'hospital', urgency: 'urgent_24h' });
    expect(res.status).toBe(201);
    expect(res.body.request.urgency).toBe('urgent_24h');
  });

  it('sends the urgency, mobility and equipment to Bitrix', async () => {
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    await post(token, { ...airBody, mobility: 'wheelchair', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: true, urgency: 'urgent_24h' });
    const { buildLeadFields } = jest.requireActual('../src/modules/bitrix/bitrix-lead');
    const fields = buildLeadFields(createLead.mock.calls[0][0]);
    expect(fields.UF_CRM_1775637825406).toBe(380); // Transfer Urgency: Urgent
    expect(fields.COMMENTS).toContain('Mobility: Wheelchair');
    expect(fields.COMMENTS).toContain('On board: Oxygen, Ventilator');
    expect(fields.COMMENTS).toContain('Urgency: Urgent (24h)');
    delete process.env.BITRIX_SYNC_ENABLED;
  });

  it('returns the new fields wherever a request is returned', async () => {
    const { token } = await createPatient();
    const created = await post(token, { ...airBody, mobility: 'walking', equipOxygen: false, equipCardiacMonitor: false, equipVentilator: false, urgency: 'planned' });
    const one = await request(app).get(`/requests/me/${created.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request).toMatchObject({ mobility: 'walking', urgency: 'planned', equipOxygen: false });
    const list = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(list.body.requests[0]).toMatchObject({ mobility: 'walking', urgency: 'planned' });
  });
});

// Needs the test database (like the rest of this file). The validation rules themselves are
// tested without a database in private-charter-validation.test.js.
describe('POST /requests: Private Charter persistence', () => {
  // The cities are looked up in the local GeoNames table: put the fixtures in it (and take them out).
  const { IDS, ROWS } = require('./fixtures/geo-cities');
  beforeAll(async () => {
    await prisma.geonamesCity.deleteMany();
    await prisma.geonamesCity.createMany({ data: ROWS.map((row) => ({ ...row, verifiedAt: new Date() })) });
  });
  afterAll(() => prisma.geonamesCity.deleteMany());

  it('saves the validated, normalised values and copies the urgency to the Case', async () => {
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send({
      serviceKey: 'privatecharter',
      patientName: '  Maria Fernandez ',
      patientAge: '47',
      patientGender: 'Female', // legacy capitalised value, stored lowercase
      country: 'AE',
      origin: { geonameId: IDS.DUBAI },
      destination: { geonameId: IDS.MUMBAI },
      patientContact: '+971 50 123 4567', // legacy spaced format, stored as E.164
      preferredDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      careLevel: 'ICU / Critical', // legacy label, stored as the key
      description: ' BP <90/60 ',
      mobility: 'bedridden',
      urgency: 'urgent_24h',
    });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      serviceType: 'Private Charter Air Ambulance Service',
      serviceKey: 'privatecharter',
      patientName: 'Maria Fernandez',
      patientAge: 47,
      patientGender: 'female',
      country: 'AE',
      patientContact: '+971501234567',
      careLevel: 'care_icu',
      description: 'BP <90/60',
      urgency: 'urgent_24h',
      // the cities as the server verified them, and the readable labels everything else shows
      origin: 'Dubai, United Arab Emirates',
      originGeonameId: IDS.DUBAI,
      originCityName: 'Dubai',
      originCountryCode: 'AE',
      originTimezone: 'Asia/Dubai',
      destination: 'Mumbai, Maharashtra, India',
      destinationGeonameId: IDS.MUMBAI,
      destinationCountryCode: 'IN',
    });
    const saved = await prisma.case.findUnique({ where: { serviceRequestId: res.body.request.id } });
    expect(saved.urgency).toBe('urgent');
    expect(saved).toMatchObject({ origin: 'Dubai, United Arab Emirates', destination: 'Mumbai, Maharashtra, India' });
  });

  it('writes nothing when a Private Charter request is refused', async () => {
    const { token } = await createPatient();
    const before = await prisma.serviceRequest.count();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`)
      .send({ serviceKey: 'privatecharter', patientName: 'Maria Fernandez' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toBeDefined();
    expect(await prisma.serviceRequest.count()).toBe(before);
  });
});
