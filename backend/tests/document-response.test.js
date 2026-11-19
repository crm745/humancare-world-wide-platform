// No API response may carry a document's stored path (`fileUrl`, "/uploads/<storage key>"). It stays in the database for
// the download endpoints; clients open files by document id through GET /documents/:id/file.
// Covers: GET /admin/cases/:id, GET /corporate/cases/:id, GET /requests/me/:id, GET /requests/me/documents,
// POST /corporate/cases/:id/documents and the patient's legacy upload (POST /requests/me/:id/documents).
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
const { createPatient, createCorporateUserAndLogin, createAdminAndLogin } = require('./helpers');

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const PDF = '%PDF-1.4 fake';
const SAFE_FIELDS = ['caseId', 'fileSizeBytes', 'id', 'name', 'type', 'uploadedAt'];
// Nothing in a response body may contain any of these, wherever it appears.
const expectNoStoragePath = (body) => {
  const text = JSON.stringify(body);
  for (const secret of ['fileUrl', '/uploads/', 'storageKey', 'sha256']) expect(text).not.toContain(secret);
};
// The patient's own request lists a Case document without its caseId (the app never reads it); every other response keeps it.
const PATIENT_REQUEST_FIELDS = SAFE_FIELDS.filter((field) => field !== 'caseId');
const expectSafeDocument = (doc, fields = SAFE_FIELDS) => {
  expect(Object.keys(doc).sort()).toEqual(fields);
  expect(doc.name).toBe('report.pdf');
  expect(typeof doc.id).toBe('number');
};

// A patient request with a legacy Case and one uploaded document.
async function patientWithDocument() {
  const patient = await createPatient();
  const created = await request(app).post('/requests').set(auth(patient.token))
    .send({ serviceType: 'Air Ambulance', patientName: 'Doc Owner', origin: 'Mumbai', destination: 'Dubai' });
  const requestId = created.body.request.id;
  const upload = await request(app).post(`/requests/me/${requestId}/documents`).set(auth(patient.token))
    .attach('file', Buffer.from(PDF), { filename: 'report.pdf', contentType: 'application/pdf' });
  return { patient, requestId, upload, caseId: (await prisma.case.findUnique({ where: { serviceRequestId: requestId } })).id };
}

describe('patient endpoints', () => {
  it('the upload response is safe, and the stored row still has its path for downloads', async () => {
    const { upload, caseId } = await patientWithDocument();
    expect(upload.status).toBe(201);
    expectNoStoragePath(upload.body);
    expectSafeDocument(upload.body.document);
    const stored = await prisma.document.findUnique({ where: { id: upload.body.document.id } });
    expect(stored.fileUrl).toMatch(/^\/uploads\//);
    expect(stored.caseId).toBe(caseId);
  });

  it('GET /requests/me/:id lists the Case documents without the path', async () => {
    const { patient, requestId } = await patientWithDocument();
    const res = await request(app).get(`/requests/me/${requestId}`).set(auth(patient.token));
    expect(res.status).toBe(200);
    expectNoStoragePath(res.body);
    expect(res.body.request.case.documents).toHaveLength(1);
    expectSafeDocument(res.body.request.case.documents[0], PATIENT_REQUEST_FIELDS);
    expect(res.body.request.case.stageEvents.length).toBeGreaterThan(0); // the rest of the structure is intact
  });

  it('GET /requests/me/documents lists documents without the path, keeping the Case reference', async () => {
    const { patient } = await patientWithDocument();
    const res = await request(app).get('/requests/me/documents').set(auth(patient.token));
    expect(res.status).toBe(200);
    expectNoStoragePath(res.body);
    expect(res.body.documents).toHaveLength(1);
    expect(Object.keys(res.body.documents[0]).sort()).toEqual([...SAFE_FIELDS, 'case'].sort());
    expect(res.body.documents[0].case.referenceNumber).toBeTruthy();
  });

  it('a legacy document is still downloaded by id, and only by its owner', async () => {
    const { patient, upload } = await patientWithDocument();
    const stranger = await createPatient();
    const ok = await request(app).get(`/documents/${upload.body.document.id}/file`).set(auth(patient.token));
    expect(ok.status).toBe(200);
    expect((await request(app).get(`/documents/${upload.body.document.id}/file`).set(auth(stranger.token))).status).toBe(404);
  });
});

describe('corporate endpoints', () => {
  async function corporateCaseWithDocument() {
    const corporate = await createCorporateUserAndLogin();
    const created = await request(app).post('/corporate/cases').set(auth(corporate.token))
      .send({ patientName: 'Jane Smith', serviceType: 'Ground Ambulance', origin: 'Delhi', destination: 'Singapore' });
    const caseId = created.body.case.id;
    const upload = await request(app).post(`/corporate/cases/${caseId}/documents`).set(auth(corporate.token))
      .attach('file', Buffer.from(PDF), { filename: 'report.pdf', contentType: 'application/pdf' });
    return { corporate, caseId, upload };
  }

  it('POST /corporate/cases/:id/documents still stores the file and returns a safe document', async () => {
    const { upload, caseId } = await corporateCaseWithDocument();
    expect(upload.status).toBe(201);
    expectNoStoragePath(upload.body);
    expectSafeDocument(upload.body.document);
    const stored = await prisma.document.findUnique({ where: { id: upload.body.document.id } });
    expect(stored.fileUrl).toMatch(/^\/uploads\//);
    expect(stored.caseId).toBe(caseId);
  });

  it('GET /corporate/cases/:id keeps its structure and omits the path', async () => {
    const { corporate, caseId } = await corporateCaseWithDocument();
    const res = await request(app).get(`/corporate/cases/${caseId}`).set(auth(corporate.token));
    expect(res.status).toBe(200);
    expectNoStoragePath(res.body);
    expect(res.body.case).toMatchObject({ id: caseId, patientName: 'Jane Smith', status: 'submitted' });
    expect(res.body.case.referenceNumber).toMatch(/^CASE-/);
    expect(res.body.case.stageEvents).toHaveLength(1);
    expect(res.body.case.documents).toHaveLength(1);
    expectSafeDocument(res.body.case.documents[0]);
  });

  it('the owning corporate still downloads the document by id; another corporate cannot', async () => {
    const { corporate, upload } = await corporateCaseWithDocument();
    const other = await createCorporateUserAndLogin({ companyName: 'Some Other Co' });
    expect((await request(app).get(`/documents/${upload.body.document.id}/file`).set(auth(corporate.token))).status).toBe(200);
    expect((await request(app).get(`/documents/${upload.body.document.id}/file`).set(auth(other.token))).status).toBe(404);
  });
});

describe('admin endpoint', () => {
  it('GET /admin/cases/:id keeps its structure (documents, stage events, linked request) and omits the path', async () => {
    const admin = await createAdminAndLogin();
    const { requestId, caseId } = await patientWithDocument();
    const res = await request(app).get(`/admin/cases/${caseId}`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expectNoStoragePath(res.body);
    expect(res.body.case).toMatchObject({ id: caseId, serviceType: 'Air Ambulance', status: 'submitted' });
    expect(res.body.case.serviceRequest).toMatchObject({ id: requestId });
    expect(res.body.case.stageEvents.length).toBeGreaterThan(0);
    expect(res.body.case.documents).toHaveLength(1);
    expectSafeDocument(res.body.case.documents[0]);
  });

  it('still requires an Admin token', async () => {
    const { caseId } = await patientWithDocument();
    expect((await request(app).get(`/admin/cases/${caseId}`)).status).toBe(401);
  });
});
