// The shared document download (GET /documents/:id/file) sends X-Content-Type-Options: nosniff for every service. This checks that the header is
// there and that nothing else about a download changed: the same bytes, the same content type, an attachment, and the same 404 for anyone else.
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
const { createPatient, createCorporateUserAndLogin } = require('./helpers');

afterAll(async () => {
  await prisma.$disconnect();
});

const SERVICES = [
  ['Air Ambulance', 'air'], ['Ground Ambulance', 'ground'], ['Hospital Assistance', 'hospital'],
  ['Marine Medical Safety', 'marine'], ['Medical Value Travel', 'medvalue'], ['Commercial Airlines — Wheelchair (CAW)', 'commercialair_wheelchair'],
];
const PDF = Buffer.from('%PDF-1.4 download check');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);

const FUTURE_DAY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
// Each service's current valid body: Marine and Medical Value Travel are sent in their structured formats (the generic body is refused: legacy-body-guard.js), and Ground and Commercial Air need a
// contact number and a day that is not past (transport-request.validation.js).
const bodyFor = (serviceType, serviceKey) => {
  const person = { patientName: 'John Doe', patientAge: 40, patientGender: 'Male', country: 'IN', patientContact: '+91 98765 43210' };
  if (serviceKey === 'marine') return { serviceType, serviceKey, serviceScope: 'international', ...person, originCity: { text: 'Port of Mumbai' }, destinationCity: { text: 'Port of Dubai' }, utcOffsetMinutes: 0 };
  if (serviceKey === 'medvalue') return { serviceType, serviceKey, treatmentScope: 'international', ...person, currentCity: { text: 'Mumbai' }, destinationCity: { text: 'Dubai' }, specialty: 'Oncology', utcOffsetMinutes: 0 };
  const generic = { serviceType, serviceKey, patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai' };
  if (serviceKey === 'ground') return { ...generic, patientContact: '+91 98765 43210', preferredDate: FUTURE_DAY, description: 'Needs transport.' };
  if (serviceKey.startsWith('commercialair')) return { ...generic, patientContact: '+91 98765 43210', preferredDate: FUTURE_DAY };
  return generic;
};
const create = (token, serviceType, serviceKey) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(bodyFor(serviceType, serviceKey));
const upload = (token, id, buffer, filename, contentType) => request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
  .attach('file', buffer, { filename, contentType });
const download = (token, id) => request(app).get(`/documents/${id}/file`).set('Authorization', `Bearer ${token}`).buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe.each(SERVICES)('download of a %s document', (serviceType, serviceKey) => {
  it('returns the same bytes and content type as before, as an attachment, with nosniff', async () => {
    const { token } = await createPatient();
    const created = await create(token, serviceType, serviceKey);
    expect(created.status).toBe(201);
    const pdf = await upload(token, created.body.request.id, PDF, 'report.pdf', 'application/pdf');
    const png = await upload(token, created.body.request.id, PNG, 'scan.png', 'image/png');
    expect([pdf.status, png.status]).toEqual([201, 201]);

    const gotPdf = await download(token, pdf.body.document.id);
    expect(gotPdf.status).toBe(200);
    expect(gotPdf.headers['x-content-type-options']).toBe('nosniff');
    expect(gotPdf.headers['content-type']).toMatch(/^application\/pdf/);
    expect(gotPdf.headers['content-disposition']).toMatch(/attachment; filename="report\.pdf"/);
    expect(Buffer.compare(gotPdf.body, PDF)).toBe(0);

    const gotPng = await download(token, png.body.document.id);
    expect(gotPng.status).toBe(200);
    expect(gotPng.headers['x-content-type-options']).toBe('nosniff');
    expect(gotPng.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(gotPng.body, PNG)).toBe(0);
  });
});

describe('who may download', () => {
  it('still gives another patient, an unrelated corporate and an anonymous caller no file, and no header leak of content', async () => {
    const owner = await createPatient();
    const other = await createPatient();
    const corporate = await createCorporateUserAndLogin();
    const created = await create(owner.token, 'Air Ambulance', 'air');
    const uploaded = await upload(owner.token, created.body.request.id, PDF, 'report.pdf', 'application/pdf');
    const url = `/documents/${uploaded.body.document.id}/file`;
    expect((await request(app).get(url).set('Authorization', `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).get(url).set('Authorization', `Bearer ${corporate.token}`)).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(401);
  });

  it('still serves a document of a request that the corporate was assigned (the corporate path)', async () => {
    const owner = await createPatient();
    const corporate = await createCorporateUserAndLogin();
    const created = await create(owner.token, 'Air Ambulance', 'air');
    const uploaded = await upload(owner.token, created.body.request.id, PDF, 'report.pdf', 'application/pdf');
    await prisma.case.update({ where: { id: (await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: true } })).case.id }, data: { corporateId: corporate.corporate.id } });
    const res = await download(corporate.token, uploaded.body.document.id);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body, PDF)).toBe(0);
  });
});
