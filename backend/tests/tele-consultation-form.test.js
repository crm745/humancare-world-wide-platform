// Teleconsultation (structured format) end to end: submission, what is stored, the Case, retrieval, the upload refusal, older requests and the
// older payload, and what Bitrix receives. Needs the test database, like requests.test.js. The rules themselves are tested without a database in
// tele-consultation-validation.test.js.
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
const { createLead } = require('../src/modules/bitrix/bitrix.service');
const { buildLeadFields, REQUIRED_SERVICE_BY_KEY } = require('../src/modules/bitrix/bitrix-lead');

afterAll(async () => {
  await prisma.$disconnect();
});

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const body = (extra = {}) => ({
  serviceType: 'Tele Consultation & House Call',
  serviceKey: 'tele',
  consultationScope: 'international',
  consultationType: 'house_call',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'India',
  patientContact: '+91 98765 43210',
  currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
  preferredDate: inDays(3),
  utcOffsetMinutes: 0, // the device's minutes east of UTC; the server works out the patient's own today from it
  presentMedicalIssue: 'Fever and cough for three days.',
  allergyDetails: 'Penicillin.',
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const get = (token, path) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const mine = async (token) => (await get(token, '/requests/me')).body.requests;
const COMBINATIONS = [['domestic', 'online'], ['domestic', 'house_call'], ['international', 'online'], ['international', 'house_call']];
const legacyBody = (extra = {}) => ({
  serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', patientName: 'Old Patient', patientAge: 70, patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210',
  origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: inDays(5), description: 'Cough and fever.', urgency: 'planned', ...extra,
});

describe('POST /requests: a structured Teleconsultation request', () => {
  it.each(COMBINATIONS)('%s + %s is saved, with the derived fields and an empty destination', async (scope, type) => {
    const { token } = await createPatient();
    const date = type === 'house_call' ? inDays(4) : null;
    const res = await post(token, body({ consultationScope: scope, consultationType: type, preferredDate: date }));
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r).toMatchObject({
      serviceKey: 'tele', serviceType: 'Tele Consultation & House Call', status: 'submitted', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      patientContact: '+91 98765 43210', country: 'India', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', patientLocation: 'Flat 4B, Rose Villa, MG Road, Pune 411001',
      destination: '', urgency: null,
    });
    expect(r.referenceNumber).toMatch(/^REQ-\d+$/);
    expect(r.preferredDate).toBe(date ? `${date}T00:00:00.000Z` : null);
    const label = { domestic: 'Domestic', international: 'International' }[scope];
    const typeLabel = type === 'house_call' ? 'House Call' : 'Online Consultation';
    // the type and the House Call scope are their own fields (an Online Consultation, whatever an older build sent as its scope, has none); the description holds only the notes
    expect(r.consultationType).toBe(type);
    expect(r.transferScope).toBe(type === 'house_call' ? scope : null);
    expect(label && typeLabel).toBeTruthy();
    expect(r.description).toBe(['Present medical issue:\nFever and cough for three days.', 'Allergic issue:\nPenicillin.'].join('\n\n'));
    expect(r.description).not.toMatch(/Consultation type|Scope|Current address|House Call|Online Consultation|Domestic|International/);
    // and it is what is in the database
    const row = await prisma.serviceRequest.findUnique({ where: { id: r.id } });
    expect(row).toMatchObject({ serviceKey: 'tele', origin: r.origin, patientLocation: r.origin, destination: '', urgency: null, careLevel: null, mobility: null });
    expect(row.description).toBe(r.description);
    expect(row).toMatchObject({ consultationType: type, transferScope: type === 'house_call' ? scope : null });
    expect(row.preferredDate ? row.preferredDate.toISOString().slice(0, 10) : null).toBe(date);
  });

  it('keeps age 0', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ consultationType: 'online', preferredDate: null, patientAge: 0 }));
    expect(res.status).toBe(201);
    expect(res.body.request.patientAge).toBe(0);
    expect((await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } })).patientAge).toBe(0);
  });

  it('a long multi-line address is kept in origin / patient_location as one shortened line; the description never holds it', async () => {
    const { token } = await createPatient();
    const lines = Array.from({ length: 30 }, (_, i) => `Building ${i + 1}, Sector ${i + 1}`);
    const address = lines.join('\n');
    const res = await post(token, body({ consultationType: 'online', preferredDate: null, currentAddress: address }));
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(Array.from(r.origin).length).toBeLessThanOrEqual(191);
    expect(r.origin.endsWith('…')).toBe(true);
    expect(r.patientLocation).toBe(r.origin);
    expect(r.description).not.toContain('Current address');
    expect(r.description).not.toContain('Building 30');
    const fetched = (await get(token, `/requests/me/${r.id}`)).body.request;
    expect(fetched.origin).toBe(r.origin);
  });

  it('writes a short single-line address once (no repeat in the description)', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ consultationType: 'online', preferredDate: null, currentAddress: '12 Lake View Road, Pune', presentMedicalIssue: undefined, allergyDetails: undefined }));
    expect(res.status).toBe(201);
    expect(res.body.request.origin).toBe('12 Lake View Road, Pune');
    expect(res.body.request).toMatchObject({ consultationType: 'online', description: null });
  });

  it('does not trust what the app says about the stored fields: they cannot be sent', async () => {
    const { token } = await createPatient();
    for (const extra of [{ origin: 'x' }, { destination: 'y' }, { description: 'z' }, { urgency: 'planned' }, { patientLocation: 'p' }, { careLevel: 'crit_icu' }, { equipOxygen: true }, { mobility: 'walking' }]) {
      const res = await post(token, body(extra));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/is not accepted for Teleconsultation requests$/);
    }
    expect(await mine(token)).toHaveLength(0);
  });

  it.each([
    ['a missing address', { currentAddress: '' }, 'currentAddress is required'],
    ['an address over 2000 characters', { currentAddress: 'a'.repeat(2001) }, 'currentAddress can be at most 2000 characters'],
    ['an age of 130', { patientAge: 130 }, 'patientAge must be a whole number from 0 to 129'],
    ['a bad number', { patientContact: '12345' }, 'patientContact must be a valid phone number with its country code'],
    ['no scope', { consultationScope: undefined }, 'consultationScope must be one of: domestic, international'],
    ['a House Call with no date', { preferredDate: null }, 'preferredDate is required for a House Call'],
    ['a House Call on a day that has passed', { preferredDate: '2020-01-01' }, 'preferredDate must be tomorrow or later'],
    ['a House Call for yesterday', { preferredDate: inDays(-1) }, 'preferredDate must be tomorrow or later'],
    ['a House Call for today', { preferredDate: inDays(0) }, 'preferredDate must be tomorrow or later'],
    ['a House Call without the device offset', { utcOffsetMinutes: undefined }, 'utcOffsetMinutes is required for a House Call (the device\'s minutes east of UTC)'],
    ['an Online Consultation with a date', { consultationType: 'online' }, 'preferredDate is only accepted for a House Call'],
    ['a note over 2000 characters', { presentMedicalIssue: 'n'.repeat(2001) }, 'presentMedicalIssue can be at most 2000 characters'],
  ])('refuses %s, with the existing { error } format, and saves nothing', async (_name, extra, message) => {
    const { token } = await createPatient();
    const res = await post(token, body(extra));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(await mine(token)).toHaveLength(0);
  });

  it('needs a signed-in patient', async () => {
    expect((await request(app).post('/requests').send(body())).status).toBe(401);
  });
});

describe('POST /requests: the Scope belongs to a House Call only', () => {
  const onlineBody = (extra = {}) => { const payload = body({ consultationType: 'online', preferredDate: null, ...extra }); delete payload.consultationScope; return payload; };

  it('an Online Consultation with no Scope is saved: no scope in the description, no date, the rest as for any request', async () => {
    const { token } = await createPatient();
    const res = await post(token, onlineBody());
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: 'tele', serviceType: 'Tele Consultation & House Call', destination: '', preferredDate: null, country: 'India', patientContact: '+91 98765 43210' });
    expect(res.body.request).toMatchObject({ consultationType: 'online', transferScope: null });
    expect(res.body.request.description).toBe(['Present medical issue:\nFever and cough for three days.', 'Allergic issue:\nPenicillin.'].join('\n\n'));
    expect(res.body.request.description).not.toMatch(/Scope|Domestic|International/);
    const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id }, include: { case: true } });
    expect(saved.case).toMatchObject({ status: 'submitted' });
  });

  it('an Online Consultation still needs the Country and the Contact Number', async () => {
    const { token, user } = await createPatient();
    expect((await post(token, onlineBody({ country: '' }))).status).toBe(400);
    expect((await post(token, onlineBody({ patientContact: '98765' }))).status).toBe(400);
    expect((await post(token, onlineBody({ patientContact: undefined }))).status).toBe(400);
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });

  it('a House Call still needs its Scope, and keeps it in transfer_scope (not in the description)', async () => {
    const { token } = await createPatient();
    const missing = await post(token, body({ consultationScope: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('consultationScope must be one of: domestic, international');
    const ok = await post(token, body({ consultationScope: 'domestic' }));
    expect(ok.status).toBe(201);
    expect(ok.body.request).toMatchObject({ consultationType: 'house_call', transferScope: 'domestic' });
    expect(ok.body.request.description).not.toMatch(/Scope|Domestic|House Call/);
  });

  it('a request an older build made, with a Scope on an Online Consultation, still works and the Scope is dropped', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ consultationType: 'online', consultationScope: 'domestic', preferredDate: null }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ consultationType: 'online', transferScope: null });
    expect(res.body.request.description).not.toMatch(/Scope|Domestic|Online Consultation/);
  });

  it('a request stored before this change (with its Scope in the description) is returned unchanged', async () => {
    const { token, user } = await createPatient();
    const created = await post(token, body());
    await prisma.serviceRequest.update({
      where: { id: created.body.request.id },
      data: { description: 'Scope: International\nConsultation type: Online Consultation\n\nCurrent address:\nFlat 4B, Rose Villa', preferredDate: null },
    });
    const one = (await get(token, `/requests/me/${created.body.request.id}`)).body.request;
    expect(one.description).toBe('Scope: International\nConsultation type: Online Consultation\n\nCurrent address:\nFlat 4B, Rose Villa');
    expect(user.id).toBeDefined();
  });
});

describe('POST /requests: the House Call date over HTTP (tomorrow or later)', () => {
  // The server's clock is real here; the patient's clock is UTC (offset 0), so "today" is today's UTC date.
  const house = (preferredDate, extra = {}) => body({ consultationType: 'house_call', preferredDate, utcOffsetMinutes: 0, ...extra });

  it('yesterday: rejected', async () => {
    const { token } = await createPatient();
    const res = await post(token, house(inDays(-1)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'preferredDate must be tomorrow or later' });
  });
  it('today: rejected', async () => {
    const { token } = await createPatient();
    const res = await post(token, house(inDays(0)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'preferredDate must be tomorrow or later' });
    expect(await mine(token)).toHaveLength(0);
  });
  it('tomorrow: accepted, and stored as that day', async () => {
    const { token } = await createPatient();
    const date = inDays(1);
    const res = await post(token, house(date));
    expect(res.status).toBe(201);
    expect(res.body.request.preferredDate).toBe(`${date}T00:00:00.000Z`);
    expect((await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } })).preferredDate.toISOString().slice(0, 10)).toBe(date);
  });
  it('a valid future date: accepted', async () => {
    const { token } = await createPatient();
    const res = await post(token, house(inDays(30)));
    expect(res.status).toBe(201);
  });
  it('an Online Consultation with a date: rejected', async () => {
    const { token } = await createPatient();
    for (const date of [inDays(1), inDays(0), inDays(-1)]) {
      const res = await post(token, body({ consultationType: 'online', preferredDate: date }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'preferredDate is only accepted for a House Call' });
    }
    expect(await mine(token)).toHaveLength(0);
  });
  it('an Online Consultation with a null date: accepted, with no date stored', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ consultationType: 'online', preferredDate: null }));
    expect(res.status).toBe(201);
    expect(res.body.request.preferredDate).toBeNull();
  });
  it('the patient\'s own date decides: a device far ahead of UTC cannot send a day that is already its today', async () => {
    const { token } = await createPatient();
    // UTC+14 is at least as far on as UTC, so its today is UTC today or the day after: both are refused for it
    const res = await post(token, house(inDays(0), { utcOffsetMinutes: 840 }));
    expect(res.status).toBe(400);
    // and a device 12 hours behind UTC may send what is, for UTC, today (it is that device's tomorrow only when its own clock says so)
    const behind = await post(token, house(inDays(3), { utcOffsetMinutes: -720 }));
    expect(behind.status).toBe(201);
  });
  it('the offset must be a real UTC offset', async () => {
    const { token } = await createPatient();
    const res = await post(token, house(inDays(5), { utcOffsetMinutes: 900 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('utcOffsetMinutes must be a whole number of minutes from -720 to 840 (minutes east of UTC)');
  });
});

describe('the Case, retrieval and the summary of a structured request', () => {
  it('creates the Case as for every request, with the one-line address and an empty destination', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    const kase = await prisma.case.findUnique({ where: { serviceRequestId: res.body.request.id }, include: { stageEvents: true } });
    expect(kase).toMatchObject({
      referenceNumber: res.body.request.referenceNumber, serviceType: 'Tele Consultation & House Call', patientName: 'Asha Nair', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001',
      destination: '', status: 'submitted', urgency: 'routine',
    });
    expect(kase.stageEvents.map((e) => e.stage)).toEqual(['submitted']);
  });

  it('is returned by the single request and the list', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const one = (await get(token, `/requests/me/${created.body.request.id}`)).body.request;
    expect(one).toMatchObject({ serviceKey: 'tele', destination: '', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', urgency: null });
    expect(one).toMatchObject({ consultationType: 'house_call', transferScope: 'international' });
    expect(one.case).toMatchObject({ status: 'submitted' });
    const list = await mine(token);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.body.request.id, destination: '' });
  });

  it('the request summary PDF prints the details and no empty "To:" line', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id } });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'From:')).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001');
    expect(valueAfter(lines, 'To:')).toBeUndefined();
    expect(valueAfter(lines, 'Urgency:')).toBeUndefined();
  });
});

describe('document uploads', () => {
  const upload = (token, id) => request(app)
    .post(`/requests/me/${id}/documents`)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'report.pdf', contentType: 'application/pdf' });

  it('are refused for a structured Teleconsultation request with HTTP 400, and nothing is attached', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const res = await upload(token, created.body.request.id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Document uploads are not available for Teleconsultation requests.' });
    const kase = await prisma.case.findUnique({ where: { serviceRequestId: created.body.request.id } });
    expect(await prisma.document.count({ where: { caseId: kase.id } })).toBe(0);
    expect(await prisma.requestDocument.count({ where: { serviceRequestId: created.body.request.id } })).toBe(0);
  });

  it('a request of someone else is still a 404 (the refusal does not reveal it)', async () => {
    const owner = await createPatient();
    const other = await createPatient();
    const created = await post(owner.token, body());
    expect((await upload(other.token, created.body.request.id)).status).toBe(404);
  });

  it('other services keep taking documents', async () => {
    const { token } = await createPatient();
    const created = await post(token, { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'J', origin: 'Pune', destination: 'Pune' });
    expect((await upload(token, created.body.request.id)).status).toBe(201);
  });

  it('an older Teleconsultation request keeps its documents readable and still takes uploads (older app builds)', async () => {
    const { token } = await createPatient();
    const old = await post(token, legacyBody());
    expect(old.status).toBe(201);
    const first = await upload(token, old.body.request.id);
    expect(first.status).toBe(201);
    // a structured request made afterwards does not change that
    expect((await post(token, body())).status).toBe(201);
    const docs = (await get(token, '/requests/me/documents')).body.documents;
    expect(docs.map((d) => d.name)).toContain('report.pdf');
    const detail = (await get(token, `/requests/me/${old.body.request.id}`)).body.request;
    expect(detail.case.documents.map((d) => d.name)).toContain('report.pdf');
    expect((await upload(token, old.body.request.id)).status).toBe(201);
  });
});

describe('older Teleconsultation requests and the older payload', () => {
  it('the older payload is still accepted and stored as it always was (destination, urgency, description, date of service)', async () => {
    const { token } = await createPatient();
    const res = await post(token, legacyBody());
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: 'tele', origin: 'Pune', destination: 'Mumbai', urgency: 'planned', description: 'Cough and fever.', patientLocation: 'Pune' });
    const kase = await prisma.case.findUnique({ where: { serviceRequestId: res.body.request.id } });
    expect(kase).toMatchObject({ origin: 'Pune', destination: 'Mumbai', urgency: 'routine' });
  });

  it('the older rules still apply to it: destination is required', async () => {
    const { token } = await createPatient();
    const { destination, ...without } = legacyBody();
    expect(destination).toBe('Mumbai');
    const res = await post(token, without);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required field(s): destination');
    const emptied = await post(token, legacyBody({ destination: '' }));
    expect(emptied.status).toBe(400);
  });

  it('the older rules for other fields still apply: mobility and equipment are refused for Teleconsultation', async () => {
    const { token } = await createPatient();
    expect((await post(token, legacyBody({ mobility: 'walking' }))).status).toBe(400);
  });

  it('an older request with a destination reads exactly as it was; a new one is told apart by its empty destination', async () => {
    const { token } = await createPatient();
    const old = await post(token, legacyBody());
    const fresh = await post(token, body());
    expect(old.body.request.destination).toBe('Mumbai');
    expect(fresh.body.request.destination).toBe('');
    const ids = (await mine(token)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([old.body.request.id, fresh.body.request.id]));
  });
});

describe('Bitrix24 receives the stored request through its existing code, which is unchanged', () => {
  beforeEach(() => {
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.BITRIX_SYNC_ENABLED;
  });
  const FIELD = {
    REQUIRED_SERVICE: 'UF_CRM_1781505417891', DATE_OF_SERVICE: 'UF_CRM_1775637683789', PICKUP_CITY: 'UF_CRM_1768812307305', DROP_CITY: 'UF_CRM_1768812329423',
    CURRENT_LOCATION: 'UF_CRM_1775637732390', DESTINATION_LOCATION: 'UF_CRM_1775637753105', URGENCY: 'UF_CRM_1775637825406', INDUSTRY: 'UF_CRM_1775717843808',
  };

  it('the service is still Telemedicine (2836) under the key "tele"', () => {
    expect(REQUIRED_SERVICE_BY_KEY.tele).toBe(2836);
    expect(Object.keys(REQUIRED_SERVICE_BY_KEY)).toEqual(expect.arrayContaining(['tele', 'ground', 'homecare', 'privatecharter', 'mortal_domestic']));
  });

  it('a House Call lead: title "<address> to ", the address as pickup and current location, the visit day as Date of Service, service 2836, no destination fields', async () => {
    const { token } = await createPatient();
    const date = inDays(6);
    const res = await post(token, body({ preferredDate: date }));
    expect(res.status).toBe(201);
    expect(createLead).toHaveBeenCalledTimes(1);
    const fields = buildLeadFields(createLead.mock.calls[0][0]);
    expect(fields.TITLE).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001 to ');
    expect(fields[FIELD.PICKUP_CITY]).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001');
    expect(fields[FIELD.CURRENT_LOCATION]).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001');
    expect(fields[FIELD.DATE_OF_SERVICE]).toBe(date);
    expect(fields[FIELD.REQUIRED_SERVICE]).toEqual([2836]);
    expect(fields[FIELD.INDUSTRY]).toBe(712);
    expect(fields).not.toHaveProperty(FIELD.DROP_CITY);
    expect(fields).not.toHaveProperty(FIELD.DESTINATION_LOCATION);
    expect(fields).not.toHaveProperty(FIELD.URGENCY);
    expect(fields.COMMENTS.startsWith('Requirement: Scope: International\nConsultation type: House Call')).toBe(true);
    expect(fields.COMMENTS).toContain('Present medical issue:\nFever and cough for three days.');
    expect(fields.COMMENTS).toContain('Allergic issue:\nPenicillin.');
    expect(fields.COMMENTS).not.toContain('Service:'); // the service is mapped, so it is not spelled out
    // the lead id is recorded on the request, as for every service
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.bitrixLeadId).toBe(12345);
  });

  it('an Online Consultation lead carries no Date of Service', async () => {
    const { token } = await createPatient();
    await post(token, body({ consultationType: 'online', preferredDate: null }));
    const fields = buildLeadFields(createLead.mock.calls[0][0]);
    expect(fields).not.toHaveProperty(FIELD.DATE_OF_SERVICE);
    expect(fields[FIELD.REQUIRED_SERVICE]).toEqual([2836]);
    expect(fields.TITLE.endsWith(' to ')).toBe(true);
  });

  it('an older Teleconsultation request makes the same lead as before (title, drop city, destination, urgency, date)', async () => {
    const { token } = await createPatient();
    const date = inDays(8);
    await post(token, legacyBody({ preferredDate: date }));
    const fields = buildLeadFields(createLead.mock.calls[0][0]);
    expect(fields.TITLE).toBe('Pune to Mumbai');
    expect(fields[FIELD.PICKUP_CITY]).toBe('Pune');
    expect(fields[FIELD.DROP_CITY]).toBe('Mumbai');
    expect(fields[FIELD.DESTINATION_LOCATION]).toBe('Mumbai');
    expect(fields[FIELD.URGENCY]).toBe(382);
    expect(fields[FIELD.DATE_OF_SERVICE]).toBe(date);
    expect(fields[FIELD.REQUIRED_SERVICE]).toEqual([2836]);
    expect(fields.COMMENTS).toContain('Requirement: Cough and fever.');
  });

  it('a failure to reach Bitrix does not fail the patient\'s request, and the retry reads the stored row', async () => {
    createLead.mockRejectedValueOnce(new Error('Bitrix down'));
    const { token } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.bitrixLeadId).toBeNull();
    expect(row.bitrixSyncAttempts).toBe(1);
    expect(row.bitrixLastError).toBe('Bitrix down');
  });
});

describe('other services are unaffected', () => {
  it('a request for another service with a "currentAddress" field is not treated as Teleconsultation', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'J', origin: 'Pune', destination: 'Pune', currentAddress: 'x' });
    expect(res.status).toBe(201);
    expect(res.body.request.destination).toBe('Pune');
  });
  it('Private Charter keeps refusing what it refuses', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Asha Nair', currentAddress: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.fields.currentAddress).toBe('This field is not accepted for Private Charter requests.');
  });
});
