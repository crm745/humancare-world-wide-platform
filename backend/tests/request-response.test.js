// What a patient's phone is sent about a request: an allow-list, so nothing internal leaves the server.
// Covers POST /requests, GET /requests/me and GET /requests/me/:id, including the Private Charter
// request-first workflow's POST (a different code path). Run with --runInBand (it fills the shared
// GeoNames fixture table, like request-review.test.js).
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
const { IDS, ROWS } = require('./fixtures/geo-cities');
const {
  toPatientRequest, toPatientRequests, REQUEST_FIELDS, CASE_FIELDS, STAGE_EVENT_FIELDS, CASE_DOCUMENT_FIELDS, REQUEST_DOCUMENT_FIELDS,
} = require('../src/modules/requests/request-response');

jest.setTimeout(30000);

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const previousFlag = process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW;

beforeAll(async () => {
  await prisma.geonamesCity.deleteMany();
  await prisma.geonamesCity.createMany({ data: ROWS.map((row) => ({ ...row, verifiedAt: new Date() })) });
});

afterAll(async () => {
  await prisma.geonamesCity.deleteMany();
  if (previousFlag === undefined) delete process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW; else process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = previousFlag;
  await prisma.$disconnect();
});

// Every key of a JSON value, at any depth.
function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) { found.add(key); allKeys(inner, found); }
  }
  return found;
}

// Internal data that must never reach a patient's phone, by the name it has in the database rows.
const FORBIDDEN = [
  'userId', 'bitrixLeadId', 'bitrixSyncAttempts', 'bitrixLastError', 'bitrixSyncFailedAt',
  'originGeonameId', 'destinationGeonameId', 'originTimezone',
  'notes', 'billingAmount', 'billingCurrency', 'billingStatus', 'billingInvoicedAt', 'billingPaidAt', 'billingNotes',
  'corporateId', 'policyReference', 'additionalInfo', 'specialRequirements', 'referralSource',
  'serviceRequestId', 'caseId', 'fileUrl', 'storageKey', 'sha256', 'uploadedByUserId', 'reviewedByAdminId',
  'scanEngine', 'scanDetail', 'scannedAt', 'scanAttempts', 'scanNextAttemptAt', 'caseDocumentId', 'mimeType',
];
const expectNoInternalFields = (body) => {
  const keys = allKeys(body);
  for (const key of FORBIDDEN) expect(keys.has(key)).toBe(false);
  expect([...keys].filter((k) => k.startsWith('billing') || k.startsWith('bitrix'))).toEqual([]);
};

describe('the serializer', () => {
  const row = {
    id: 5, userId: 9, referenceNumber: 'REQ-1005', status: 'in_progress', serviceType: 'Home Healthcare', serviceKey: 'homecare',
    patientName: 'A B', patientAge: 40, origin: 'X', destination: 'Y', country: 'India', createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-02T00:00:00Z'),
    bitrixLeadId: 1, bitrixSyncAttempts: 2, bitrixLastError: 'boom', bitrixSyncFailedAt: new Date(), originGeonameId: 1, destinationGeonameId: 2, originTimezone: 'Asia/Kolkata',
    originCityName: 'X', originCountryCode: 'IN', destinationCityName: 'Y', destinationCountryCode: 'IN', someFutureColumn: 'secret',
    case: {
      id: 3, referenceNumber: 'REQ-1005', status: 'in_progress', urgency: 'urgent', notes: 'internal', billingAmount: '10.00', billingStatus: 'pending', bitrixLeadId: 4, corporateId: 7,
      policyReference: 'p', additionalInfo: 'a', specialRequirements: 's', referralSource: 'r', serviceRequestId: 5, patientName: 'A B', someFutureColumn: 'secret', createdAt: new Date(), updatedAt: new Date(),
      stageEvents: [{ id: 1, caseId: 3, stage: 'submitted', note: 'hello', occurredAt: new Date(), internal: 'x' }],
      documents: [{ id: 2, caseId: 3, type: 'Medical Report', name: 'r.pdf', fileUrl: '/uploads/abc', fileSizeBytes: 10, uploadedAt: new Date() }],
    },
    requestDocuments: [{ id: 6, serviceRequestId: 5, originalName: 'x.pdf', storageKey: 'k', sha256: 'h', sizeBytes: 1, mimeType: 'application/pdf', uploadedAt: new Date(), replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', reviewStatus: 'pending', rejectionReason: null, uploadedByUserId: 9, caseDocumentId: null }],
  };

  it('keeps only the listed fields, at every level, and nothing a column added later', () => {
    const out = toPatientRequest(row);
    expect(allKeys(out).has('someFutureColumn')).toBe(false);
    expectNoInternalFields(out);
    expect(Object.keys(out).sort()).toEqual(REQUEST_FIELDS.filter((f) => f in row).concat(['case', 'requestDocuments']).sort());
    expect(Object.keys(out.case).sort()).toEqual([...CASE_FIELDS.filter((f) => f in row.case), 'stageEvents', 'documents'].sort());
    expect(Object.keys(out.case.stageEvents[0]).sort()).toEqual(STAGE_EVENT_FIELDS.filter((f) => f in row.case.stageEvents[0]).sort());
    expect(Object.keys(out.case.documents[0]).sort()).toEqual(CASE_DOCUMENT_FIELDS.slice().sort());
    expect(Object.keys(out.requestDocuments[0]).sort()).toEqual(REQUEST_DOCUMENT_FIELDS.slice().sort());
  });
  it('keeps the values it lets through exactly as they were', () => {
    const out = toPatientRequest(row);
    expect(out.referenceNumber).toBe('REQ-1005');
    expect(out.createdAt).toBe(row.createdAt);
    expect(out.case.stageEvents[0].note).toBe('hello');
    expect(out.case.documents[0].name).toBe('r.pdf');
  });
  it('a request with no Case keeps case: null, and one that was not asked for a Case gets none', () => {
    expect(toPatientRequest({ ...row, case: null }).case).toBeNull();
    const { case: _c, requestDocuments: _r, ...plain } = row;
    const out = toPatientRequest(plain);
    expect('case' in out).toBe(false);
    expect('requestDocuments' in out).toBe(false);
  });
  it('handles a list, nothing and a non-object', () => {
    expect(toPatientRequests([row, row])).toHaveLength(2);
    expect(toPatientRequests([])).toEqual([]);
    expect(toPatientRequest(null)).toBeNull();
    expect(toPatientRequest(undefined)).toBeUndefined();
  });
  it('does not change what it was given', () => {
    const copy = JSON.stringify(row);
    toPatientRequest(row);
    expect(JSON.stringify(row)).toBe(copy);
  });
});

describe('the three endpoints, with a request that has internal data on it', () => {
  async function requestWithInternalData() {
    const patient = await createPatient();
    const created = await request(app).post('/requests').set(auth(patient.token)).send({
      serviceType: 'Home Healthcare', serviceKey: 'homecare', patientName: 'John Doe', patientAge: 40, patientGender: 'Male', patientContact: '+91 9876543210',
      origin: 'Pune, India', destination: 'Pune, India', country: 'India', preferredDate: '2099-01-01', description: 'Needs a nurse', urgency: 'planned',
    });
    expect(created.status).toBe(201);
    const id = created.body.request.id;
    const caseRow = await prisma.case.findUnique({ where: { serviceRequestId: id } });
    await prisma.case.update({
      where: { id: caseRow.id },
      data: {
        notes: 'internal staff note', billingAmount: '123.45', billingCurrency: 'INR', billingStatus: 'invoiced', billingNotes: 'billing note',
        policyReference: 'POL-1', additionalInfo: 'extra', specialRequirements: 'special', referralSource: 'friend', bitrixLastError: 'crm error',
      },
    });
    await prisma.serviceRequest.update({ where: { id }, data: { bitrixLeadId: 77, bitrixSyncAttempts: 3, bitrixLastError: 'crm error', bitrixSyncFailedAt: new Date() } });
    await prisma.caseStageEvent.create({ data: { caseId: caseRow.id, stage: 'in_progress', note: 'Team assigned' } });
    await prisma.document.create({ data: { caseId: caseRow.id, type: 'Medical Report', name: 'report.pdf', fileUrl: '/uploads/secret-name.pdf', fileSizeBytes: 2048 } });
    return { ...patient, id, created };
  }

  it('POST /requests returns the request without internal fields', async () => {
    const r = await requestWithInternalData();
    expectNoInternalFields(r.created.body);
    expect(r.created.body.request).toMatchObject({ serviceKey: 'homecare', status: 'submitted', patientName: 'John Doe', urgency: 'planned' });
    expect(r.created.body.request.referenceNumber).toMatch(/^REQ-\d+$/);
  });

  it('GET /requests/me/:id returns everything the app reads, and none of the internal fields', async () => {
    const r = await requestWithInternalData();
    const res = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(res.status).toBe(200);
    expectNoInternalFields(res.body);
    const req = res.body.request;
    expect(req).toMatchObject({ id: r.id, serviceType: 'Home Healthcare', serviceKey: 'homecare', patientName: 'John Doe', patientAge: 40, patientGender: 'Male', patientContact: '+91 9876543210', country: 'India', description: 'Needs a nurse', urgency: 'planned', status: 'submitted' });
    expect(req.preferredDate).toBe('2099-01-01T00:00:00.000Z');
    expect(req.case).toMatchObject({ status: 'submitted', urgency: 'routine' });
    expect(Object.keys(req.case).sort()).toEqual(['createdAt', 'documents', 'id', 'referenceNumber', 'stageEvents', 'status', 'updatedAt', 'urgency']);
    expect(req.case.stageEvents.map((e) => [e.stage, e.note])).toEqual([['submitted', 'Request received from patient app.'], ['in_progress', 'Team assigned']]);
    expect(Object.keys(req.case.stageEvents[0]).sort()).toEqual(['id', 'note', 'occurredAt', 'stage']);
    expect(req.case.documents).toHaveLength(1);
    expect(Object.keys(req.case.documents[0]).sort()).toEqual(['fileSizeBytes', 'id', 'name', 'type', 'uploadedAt']);
    expect(JSON.stringify(res.body)).not.toContain('secret-name');
    expect(JSON.stringify(res.body)).not.toContain('internal staff note');
    expect(JSON.stringify(res.body)).not.toContain('crm error');
  });

  it('GET /requests/me returns the list without internal fields, and no Case', async () => {
    const r = await requestWithInternalData();
    const res = await request(app).get('/requests/me').set(auth(r.token));
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expectNoInternalFields(res.body);
    expect(res.body.requests[0]).toMatchObject({ id: r.id, serviceKey: 'homecare', status: 'submitted' });
    expect('case' in res.body.requests[0]).toBe(false);
    for (const field of ['id', 'referenceNumber', 'serviceType', 'serviceKey', 'status', 'origin', 'destination', 'createdAt']) expect(res.body.requests[0][field]).toBeDefined();
  });

  it('the summary PDF still reads the full request and its timeline', async () => {
    const r = await requestWithInternalData();
    const res = await request(app).get(`/requests/me/${r.id}/summary`).set(auth(r.token)).buffer(true).parse((resp, cb) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('another patient still gets 404 for it', async () => {
    const r = await requestWithInternalData();
    const other = await createPatient();
    const res = await request(app).get(`/requests/me/${r.id}`).set(auth(other.token));
    expect(res.status).toBe(404);
  });
});

describe('the Private Charter request-first workflow', () => {
  const pcBody = {
    serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', country: 'AE',
    origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI }, patientContact: '+971501234567', preferredDate: '2099-01-01',
    careLevel: ['care_icu', 'care_stable'], description: 'Needs ICU transfer', mobility: 'bedridden', urgency: 'urgent_24h',
  };

  it('POST /requests (the workflow path) returns the request without internal fields', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const patient = await createPatient();
    const res = await request(app).post('/requests').set(auth(patient.token)).send(pcBody);
    expect(res.status).toBe(201);
    expectNoInternalFields(res.body);
    expect(res.body.request).toMatchObject({ serviceKey: 'privatecharter', reviewStatus: 'awaiting_documents', status: 'submitted', patientName: 'Maria Fernandez' });
    expect(res.body.request.originCityName).toBeTruthy();
    expect(res.body.request.destinationCountryCode).toBeTruthy();
  });

  it('POST /requests (the original path, while the workflow is off) returns it without internal fields too', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';
    const patient = await createPatient();
    const res = await request(app).post('/requests').set(auth(patient.token)).send(pcBody);
    expect(res.status).toBe(201);
    expectNoInternalFields(res.body);
    expect(res.body.request.reviewStatus == null).toBe(true);
  });

  it('GET /requests/me/:id returns the review fields and the documents without file storage details', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const patient = await createPatient();
    const created = await request(app).post('/requests').set(auth(patient.token)).send(pcBody);
    const id = created.body.request.id;
    await prisma.requestDocument.create({
      data: {
        serviceRequestId: id, originalName: 'report.pdf', storageKey: `test-${Date.now()}-${id}.pdf`, sizeBytes: 2048, mimeType: 'application/pdf', sha256: 'a'.repeat(64),
        uploadedByUserId: patient.user.id, scanStatus: 'clean', scanEngine: 'clamav', reviewStatus: 'rejected', reviewedByAdminId: 1, rejectionReason: 'Blurred',
      },
    });
    await prisma.serviceRequest.update({ where: { id }, data: { reviewStatus: 'changes_requested', documentsRequestReason: 'Send a clearer copy' } });
    const res = await request(app).get(`/requests/me/${id}`).set(auth(patient.token));
    expect(res.status).toBe(200);
    expectNoInternalFields(res.body);
    expect(res.body.request).toMatchObject({ reviewStatus: 'changes_requested', documentsRequestReason: 'Send a clearer copy', case: null });
    expect(res.body.request.requestDocuments).toHaveLength(1);
    expect(Object.keys(res.body.request.requestDocuments[0]).sort()).toEqual([...REQUEST_DOCUMENT_FIELDS].sort());
    expect(res.body.request.requestDocuments[0]).toMatchObject({ originalName: 'report.pdf', scanStatus: 'clean', reviewStatus: 'rejected', rejectionReason: 'Blurred' });
  });
});
