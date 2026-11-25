// A Medical Report is OPTIONAL for every service except Private Charter (which is deliberately not covered here and not touched): each of these services accepts and
// saves a request with NO document, creates its Case as usual, and still takes a report afterwards (the upload path, its limits and its checks are unchanged).
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

afterAll(async () => {
  await prisma.$disconnect();
});

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const generic = (serviceType, serviceKey, extra = {}) => ({ serviceType, serviceKey, patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', ...extra });
const SERVICES = [
  ['Ground Ambulance', generic('Ground Ambulance', 'ground', { description: 'Needs transport.' })], // (Ground's Present Medical Issue is mandatory; it is not a medical report)
  ['Hospitalization Assistance', generic('Hospitalization Assistance', 'hospital')],
  ['Commercial Airlines (wheelchair)', generic('Commercial Airlines — Wheelchair (CAW)', 'commercialair_wheelchair')],
  ['Marine Medical Safety', generic('Marine Medical Safety', 'marine')],
  ['Medical Value Travel', generic('Medical Value Travel', 'medvalue')],
  ['Teleconsultation', {
    serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', consultationType: 'online', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India',
    patientContact: '+91 98765 43210', currentAddress: 'Flat 4B, Pune', utcOffsetMinutes: 0,
  }],
  ['Mortal Remains', {
    serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', transferScope: 'domestic', transportMode: 'ground_transportation', patientName: 'Suresh Kale', patientAge: 64,
    patientGender: 'Male', deceasedRelation: 'Brother', placeOfDeath: 'Pune', dateOfDeath: inDays(-2), country: 'India', origin: 'Pune', destination: 'Nagpur',
    patientContact: '+919876543210', preferredDate: inDays(3), urgency: 'planned', utcOffsetMinutes: 0,
  }],
  ['Home Healthcare', {
    serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210',
    homeAddress: 'Flat 4B, Rose Villa, Pune', preferredDate: inDays(3), utcOffsetMinutes: 0,
  }],
];

describe.each(SERVICES)('%s', (_name, body) => {
  it('is accepted and saved with no medical report, gets its Case, and the request has no document', async () => {
    const { token } = await createPatient();
    const res = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id }, include: { case: { include: { documents: true } } } });
    expect(row.status).toBe('submitted');
    expect(row.case).toBeTruthy();
    expect(row.case.documents).toHaveLength(0);
    expect(row.reviewStatus).toBeNull(); // the request-first review workflow is Private Charter's only
  });

  it('still takes a report afterwards, as before', async () => {
    const { token } = await createPatient();
    const created = await request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(body);
    expect(created.status).toBe(201);
    if (body.serviceKey === 'tele') return; // Teleconsultation takes no documents (the backend refuses them): nothing to attach
    const upload = await request(app).post(`/requests/me/${created.body.request.id}/documents`).set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
  });
});
