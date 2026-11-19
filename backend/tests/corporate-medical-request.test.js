// Corporate Medical Solutions, patient side (key "corporate"), end to end over HTTP against the TEST database: what is stored, returned, listed, tracked and notified.
// Needs the company_name, employee_count and selected_programmes columns (migration 20261119110000_corporate_medical_fields) in the test database AND a regenerated
// Prisma Client. It was written but NOT run for this change: like every database-backed suite it empties humancare_test, which was not authorised. The same flow was
// checked without a test database by corporate-medical-controller.test.js (a recorder in place of Prisma) and, on humancare_dev only, in a rolled-back transaction.
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
const { updateCaseStage } = require('../src/modules/cases/cases.service');
const { corporateFieldsOf, isNewCorporateFormat } = require('../src/modules/requests/corporate-medical.validation');

afterAll(async () => {
  await prisma.$disconnect();
});

const body = (extra = {}) => ({
  serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female',
  programmes: ['events', 'doctor'], anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.',
  patientContact: '+91 98765 43210', preferredDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), utcOffsetMinutes: 0,
  officeAddress: 'Plot 14, Andheri East,\nMumbai, Maharashtra 400069', officeCountry: 'IN', ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const get = (token, path) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const rowOf = (id) => prisma.serviceRequest.findUnique({ where: { id }, include: { case: true } });

describe('POST /requests: Corporate Medical Solutions', () => {
  it('stores all seven fields, each in its own place, and returns them', async () => {
    const { token, user } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      serviceKey: 'corporate', serviceType: 'Corporate Medical Solutions', status: 'submitted', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair',
      patientGender: 'Female', selectedProgrammes: ['doctor', 'events'], origin: '', destination: '', urgency: null, patientAge: null,
    });
    expect(Array.isArray(res.body.request.selectedProgrammes)).toBe(true);
    expect(corporateFieldsOf(res.body.request)).toMatchObject({ ok: true, anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.' });
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({ userId: user.id, companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, selectedProgrammes: ['doctor', 'events'], patientName: 'Asha Nair', patientGender: 'Female' });
    // the structured fields are not repeated in the description (it only holds the two requirements)
    expect(row.description).not.toMatch(/Acme|Asha Nair|Female|events/);
    expect(isNewCorporateFormat(row)).toBe(true);
  });

  it('creates the Case linked to the request, with no corporate, and the standard REQ- reference (from the REQUEST id) on both', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    const row = await rowOf(res.body.request.id);
    expect(row.case).toBeTruthy();
    expect(row.case.serviceRequestId).toBe(row.id);
    expect(row.case.corporateId).toBeNull();
    expect(row.referenceNumber).toBe(`REQ-${1000 + row.id}`);
    expect(row.referenceNumber).not.toMatch(/^CASE-/);
    expect(row.case.referenceNumber).toBe(row.referenceNumber);
    expect(res.body.request.referenceNumber).toBe(row.referenceNumber);
    const events = await prisma.caseStageEvent.findMany({ where: { caseId: row.case.id } });
    expect(events.map((e) => e.stage)).toEqual(['submitted']);
  });

  it('a request without the two optional requirements stores a NULL description and is still new format', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ anyRequirement: undefined, specialRequirement: undefined }));
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row.description).toBeNull();
    expect(isNewCorporateFormat(row)).toBe(true);
  });

  it.each([
    ['no company name', { companyName: undefined }], ['a zero count', { employeeCount: 0 }], ['a fractional count', { employeeCount: 2.5 }], ['a text count', { employeeCount: 'many' }],
    ['no employee name', { patientName: undefined }], ['no gender', { patientGender: undefined }], ['no programmes', { programmes: [] }], ['an unknown programme', { programmes: ['dentist'] }],
  ])('%s is refused and nothing is saved', async (_name, extra) => {
    const { token, user } = await createPatient();
    const res = await post(token, body(extra));
    expect(res.status).toBe(400);
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });

  it('takes no documents', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const res = await request(app).post(`/requests/me/${created.body.request.id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'r.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Document uploads are not available for Corporate Medical Solutions requests.');
  });
});

describe('the office and contact fields', () => {
  it('stores Patient Contact, Preferred Date, Office Address and Office Country in the existing columns, on the request and its Case', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row).toMatchObject({ patientContact: '+91 98765 43210', origin: 'Plot 14, Andheri East,\nMumbai, Maharashtra 400069', country: 'India', patientLocation: null, destination: '' });
    expect(row.preferredDate.toISOString().slice(0, 10)).toBe(body().preferredDate);
    expect(row.case).toMatchObject({ patientContact: '+91 98765 43210', origin: row.origin, country: 'India', corporateId: null });
  });

  it('a 2,000-character Office Address is saved whole (the migration widened origin); 2,001 is refused', async () => {
    const { token } = await createPatient();
    const exact = 'Z'.repeat(2000);
    const res = await post(token, body({ officeAddress: exact }));
    expect(res.status).toBe(201);
    const row = await rowOf(res.body.request.id);
    expect(row.origin).toBe(exact);
    expect(row.case.origin).toBe(exact);
    const tooLong = await post(token, body({ officeAddress: 'Z'.repeat(2001) }));
    expect(tooLong.status).toBe(400);
  });

  it.each([
    ['an invalid phone', { patientContact: '98765' }], ['a past date', { preferredDate: '2020-01-01' }], ['an unknown country code', { officeCountry: 'ZZ' }],
    ['no office address', { officeAddress: undefined }], ['10,001 employees', { employeeCount: 10001 }],
  ])('%s is refused and nothing is saved', async (_name, extra) => {
    const { token, user } = await createPatient();
    expect((await post(token, body(extra))).status).toBe(400);
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('reading it back: My Requests, Request Details, Tracking, notifications, PDF', () => {
  it('is returned, whole, by the single request and the list', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const one = (await get(token, `/requests/me/${created.body.request.id}`)).body.request;
    expect(one).toMatchObject({ companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, selectedProgrammes: ['doctor', 'events'], patientName: 'Asha Nair', patientGender: 'Female' });
    expect(one.case).toMatchObject({ status: 'submitted', referenceNumber: created.body.request.referenceNumber });
    expect(one).not.toHaveProperty('userId');
    const list = (await get(token, '/requests/me')).body.requests;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.body.request.id, companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, selectedProgrammes: ['doctor', 'events'] });
  });

  it('a stage change updates the request and notifies the patient under the REQ- reference (the behaviour every patient request has)', async () => {
    const { token, user } = await createPatient();
    const created = await post(token, body());
    const row = await rowOf(created.body.request.id);
    await updateCaseStage(row.case.id, 'in_progress', 'Our team is on it.');
    expect((await get(token, `/requests/me/${row.id}`)).body.request.status).toBe('in_progress');
    const notes = await prisma.notification.findMany({ where: { recipientType: 'patient', recipientId: user.id } });
    expect(notes.map((n) => n.title)).toEqual([`${row.referenceNumber} update`]);
  });

  it('the PDF summary prints the seven fields', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const res = await get(token, `/requests/me/${created.body.request.id}/summary`).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    const lines = await renderPdfLines({ ...(await rowOf(created.body.request.id)), createdAt: new Date() });
    expect(valueAfter(lines, 'Company Name:')).toBe('Acme Industries Pvt Ltd');
    expect(valueAfter(lines, 'Programmes:')).toBe('Doctor, Events');
  });
});

describe('historical requests', () => {
  it('a Corporate Medical request saved with a CASE- reference and only the first seven fields is returned unchanged, still new format, with no invented office fields', async () => {
    const { token, user } = await createPatient();
    const old = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'Earlier Employee', patientGender: 'Female', origin: '', destination: '',
        companyName: 'Earlier Co', employeeCount: 40, selectedProgrammes: ['doctor'], referenceNumber: `CASE-${9000 + Math.floor(Math.random() * 900)}`, status: 'submitted',
      },
    });
    const one = (await get(token, `/requests/me/${old.id}`)).body.request;
    expect(one.referenceNumber).toBe(old.referenceNumber); // never renumbered
    expect(one).toMatchObject({ companyName: 'Earlier Co', origin: '', country: null, patientContact: null, preferredDate: null });
    expect(isNewCorporateFormat(one)).toBe(true);
    expect(corporateFieldsOf(one)).toMatchObject({ officeAddress: '', officeCountry: '', patientContact: '' });
  });

  it('an older Corporate Medical request (free text, a REQ- reference, none of the columns) is returned unchanged and is not new format', async () => {
    const { token, user } = await createPatient();
    const old = await prisma.serviceRequest.create({
      data: { userId: user.id, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'Old Patient', origin: 'Pune', destination: 'Pune', description: 'Annual checkups.', referenceNumber: `TEST-CORP-${Date.now()}`, status: 'submitted' },
    });
    const one = (await get(token, `/requests/me/${old.id}`)).body.request;
    expect(one).toMatchObject({ description: 'Annual checkups.', companyName: null, employeeCount: null, selectedProgrammes: null });
    expect(isNewCorporateFormat(one)).toBe(false);
  });

  it('the older generic body is still accepted and keeps its REQ- reference', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'John Doe', patientAge: '35', origin: 'Pune', destination: 'Pune', description: 'Annual checkups.' });
    expect(res.status).toBe(201);
    expect(res.body.request.referenceNumber).toMatch(/^REQ-\d+$/);
    expect(res.body.request.companyName).toBeNull();
  });
});
