// Home Healthcare Services (key "homecare") end to end over HTTP: what is refused (needs no new column), then what is stored and returned.
//
// TWO PARTS.
//   1. Refusals and routing: run always. They return before anything is written, so they work on any database.
//   2. Persistence: needs the care_requirement and caretaker_types columns (migration 20261117140000_home_healthcare_care_fields) in the TEST database AND a
//      regenerated Prisma Client. Until the migration has been approved and applied to humancare_test, this part is SKIPPED (it shows as skipped in the run, never
//      as passed). Run it with:  HOME_HEALTHCARE_DB_TESTS=1 npx cross-env NODE_ENV=test jest --runInBand tests/home-healthcare-request.test.js
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
const { createLead, sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
const { parseHomeDescription, isNewHomeFormat } = require('../src/modules/requests/home-healthcare.validation');

afterAll(async () => {
  await prisma.$disconnect();
});

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const body = (extra = {}) => ({
  serviceType: 'Home Healthcare Services',
  serviceKey: 'homecare',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'India',
  patientContact: '+91 98765 43210',
  homeAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
  preferredDate: inDays(3),
  utcOffsetMinutes: 0, // the device's minutes east of UTC; the server works out the patient's own today from it
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const get = (token, path) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const pdf = (name = 'report.pdf') => ({ buffer: Buffer.from('%PDF-1.4 test'), filename: name, contentType: 'application/pdf' });
const upload = (token, id, file = pdf()) => request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
  .attach('file', file.buffer, { filename: file.filename, contentType: file.contentType });

describe('POST /requests for Home Healthcare: what is refused (runs on any database)', () => {
  it('refuses the older generic body (Current Location, Destination, Urgency, description) with a 400 and saves nothing', async () => {
    const { token, user } = await createPatient();
    const old = { serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'John Doe', origin: 'Pune', destination: 'Pune', description: 'Needs a nurse', urgency: 'planned' };
    const res = await post(token, old);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is not accepted for Home Healthcare requests/);
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses every invalid field with { error } and a 400, never a 500', async () => {
    const { token, user } = await createPatient();
    const bad = [
      body({ patientName: 'A' }), body({ patientAge: 0 }), body({ patientAge: 130 }), body({ patientGender: 'x' }), body({ country: '' }), body({ patientContact: '9876543210' }),
      body({ homeAddress: '' }), body({ homeAddress: '  \n ' }), body({ homeAddress: 'x'.repeat(2001) }), body({ homeAddress: 'a\u0000b' }), body({ homeAddress: 'a\uD83Db' }),
      body({ medicalHistory: 'y'.repeat(2001) }), body({ medicalHistory: 'a\u0007b' }), body({ preferredDate: inDays(-1) }), body({ preferredDate: undefined }), body({ utcOffsetMinutes: undefined }),
      body({ caretakerTypes: ['doctor'] }), body({ caretakerTypes: ['nurse', 'nurse'] }), body({ careRequirement: '36_hours' }), body({ careLevel: 'icu' }),
      body({ equipOxygen: true }), body({ equipOxygen: false, equipOxygenLpm: 4 }), body({ equipOxygenLpm: 4 }), body({ equipOxygen: true, equipOxygenLpm: 16 }),
      body({ urgency: 'planned' }), body({ origin: 'Pune' }), body({ destination: 'Pune' }), body({ description: 'forged' }), body({ patientLocation: 'forged' }), body({ mobility: 'walking' }),
      body({ serviceType: 'Home Healthcare' }),
    ];
    for (const payload of bad) {
      const res = await post(token, payload);
      expect({ status: res.status, hasError: typeof res.body.error === 'string' }).toEqual({ status: 400, hasError: true });
    }
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/requests').send(body())).status).toBe(401);
  });

  it('does not change what another service accepts: the generic path still takes its generic body', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Pune', description: 'Needs a bed' });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: 'hospital', description: 'Needs a bed', destination: 'Pune' });
    // the two new columns exist for every request but are NULL for every other service (like transferScope and transportMode for services other than Mortal Remains)
    expect(res.body.request).toMatchObject({ careRequirement: null, caretakerTypes: null, equipOxygen: null });
    expect(res.body.request).not.toHaveProperty('equipOxygenLpm'); // (the flow rate is only returned when it has a value)
  });
});

// ---- persistence: needs the migration applied to the test database (see the note at the top) ------------------------------------------------------------------------
const maybe = process.env.HOME_HEALTHCARE_DB_TESTS === '1' ? describe : describe.skip;

maybe('Home Healthcare persistence (needs the migrated test database)', () => {
  it('stores every answer in its column, composes the description, and creates the Case', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({
      caretakerTypes: ['caretaker', 'nurse'], careRequirement: '24_hours', careLevel: 'full_icu', equipOxygen: true, equipOxygenLpm: 4, medicalHistory: 'Post-op.\r\nNeeds wound care.',
    }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      serviceKey: 'homecare', serviceType: 'Home Healthcare Services', status: 'submitted', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India',
      patientContact: '+91 98765 43210', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', patientLocation: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', urgency: null,
      careRequirement: '24_hours', caretakerTypes: 'nurse,caretaker', careLevel: 'Full ICU', equipOxygen: true, equipOxygenLpm: 4,
    });
    expect(res.body.request.preferredDate).toBe(`${inDays(3)}T00:00:00.000Z`);
    const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id }, include: { case: true } });
    expect(saved).toMatchObject({ careRequirement: '24_hours', caretakerTypes: 'nurse,caretaker', careLevel: 'Full ICU', equipOxygen: true, equipOxygenLpm: 4, mobility: null, urgency: null });
    expect(saved.case).toMatchObject({ patientName: 'Asha Nair', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', status: 'submitted' });
    expect(isNewHomeFormat(saved)).toBe(true);
    // the care answers are NOT repeated in the description (only the address and the Medical History are)
    expect(saved.description).not.toMatch(/Nurse|Caretaker|Care Requirement|Care Level|ICU|24 Hours|Oxygen|LPM/);
    expect(parseHomeDescription(saved.description)).toMatchObject({ ok: true, history: 'Post-op.\r\nNeeds wound care.' });
  });

  it('unanswered care selections store NULL, and Oxygen No stores false with no flow rate', async () => {
    const { token } = await createPatient();
    const none = await post(token, body());
    expect(none.status).toBe(201);
    const row = await prisma.serviceRequest.findUnique({ where: { id: none.body.request.id } });
    expect(row).toMatchObject({ careRequirement: null, caretakerTypes: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null });
    const no = await post(token, body({ equipOxygen: false }));
    expect(await prisma.serviceRequest.findUnique({ where: { id: no.body.request.id } })).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
  });

  it.each([
    ['leading and trailing whitespace', '   padded   \n\n'], ['CRLF and a lone CR', 'a\r\nb\rc'], ['Unicode separators', 'a b c'], ['no-break and ideographic spaces', 'a b　c'],
    ['emoji and a ZWJ sequence', `\u{1F3E5} ${family}`], ['decomposed accents', 'café'], ['Arabic and Telugu', 'مرحبا తెలుగు'], ['tabs', 'a\tb'],
    ['text that looks like the format', 'Medical History:\nx\nComplete home address:\ny\nHome Healthcare v1 (address 1, history 1)\nOxygen: Yes (99 LPM)'],
    ['2,000 emoji', '\u{1F600}'.repeat(2000)],
  ])('stores %s exactly: the same characters come back from the database, the response and a fresh read', async (_name, text) => {
    const { token } = await createPatient();
    const res = await post(token, body({ homeAddress: text, medicalHistory: text }));
    expect(res.status).toBe(201);
    for (const description of [
      res.body.request.description,
      (await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } })).description,
      (await get(token, `/requests/me/${res.body.request.id}`)).body.request.description,
      (await get(token, '/requests/me')).body.requests.find((r) => r.id === res.body.request.id).description,
    ]) {
      const parsed = parseHomeDescription(description);
      expect(parsed.ok).toBe(true);
      expect(parsed.address).toBe(text);
      expect(parsed.history).toBe(text);
    }
  });

  it('returns the two new fields on every read, and the PDF prints the new layout', async () => {
    const { token } = await createPatient();
    const created = await post(token, body({ caretakerTypes: ['nurse'], careRequirement: '12_hours', medicalHistory: 'Post-op.' }));
    const one = (await get(token, `/requests/me/${created.body.request.id}`)).body.request;
    expect(one).toMatchObject({ careRequirement: '12_hours', caretakerTypes: 'nurse' });
    const list = (await get(token, '/requests/me')).body.requests;
    expect(list.find((r) => r.id === created.body.request.id)).toMatchObject({ careRequirement: '12_hours', caretakerTypes: 'nurse' });
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: { include: { stageEvents: true } } } });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'Home address:')).toBe('Flat 4B, Rose Villa');
    expect(valueAfter(lines, 'Nurse / Caretaker:')).toBe('Nurse');
    expect(valueAfter(lines, 'Care Requirement:')).toBe('12 Hours');
    expect(lines).not.toContain('From:');
  });

  it('medical reports keep the existing flow: typed Medical Report, and forwarded to Bitrix', async () => {
    sendMedicalReportToBitrix.mockClear();
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    try {
      const { token } = await createPatient();
      const created = await post(token, body());
      expect(createLead).toHaveBeenCalledTimes(1);
      const input = createLead.mock.calls[0][0];
      expect(input).toMatchObject({ serviceKey: 'homecare', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '' });
      expect(input.comments.startsWith('Requirement: Home Healthcare v1 (address ')).toBe(true);
      const res = await upload(token, created.body.request.id);
      expect(res.status).toBe(201);
      expect(res.body.document.type).toBe('Medical Report');
      expect(sendMedicalReportToBitrix).toHaveBeenCalledTimes(1);
      // and the shared download still works for it, with nosniff (documents-nosniff.test.js covers the other services)
      const download = await get(token, `/documents/${res.body.document.id}/file`);
      expect(download.status).toBe(200);
      expect(download.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      delete process.env.BITRIX_SYNC_ENABLED;
    }
  });

  it('an older Home Healthcare request (a plain description, a destination) stays legacy', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    await prisma.serviceRequest.update({
      where: { id: created.body.request.id },
      data: { description: 'Needs a nurse for post-surgery care.', origin: 'Pune', destination: 'Mumbai', careRequirement: null, caretakerTypes: null, urgency: 'planned' },
    });
    const one = (await get(token, `/requests/me/${created.body.request.id}`)).body.request;
    expect(isNewHomeFormat(one)).toBe(false);
    expect(one).toMatchObject({ description: 'Needs a nurse for post-surgery care.', destination: 'Mumbai', urgency: 'planned' });
  });
});
