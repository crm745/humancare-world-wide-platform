// The request-first review workflow (Private Charter): a request without a Case, documents scanned
// by ClamAV (here a fake clamd speaking the real protocol) and reviewed by an Admin, and a Case
// created only on approval. Run with --runInBand (it fills the shared GeoNames fixture table).
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient, createAdminAndLogin } = require('./helpers');
const { startFakeClamd, unusedPort } = require('./helpers/fake-clamd');
const { createLead } = require('../src/modules/bitrix/bitrix.service');
const { scanFile } = require('../src/integrations/clamav/clamav');
const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');
const review = require('../src/modules/request-review/request-review.service');
const { SCAN_RETRY } = require('../src/modules/request-review/request-review.config');
const { IDS, ROWS } = require('./fixtures/geo-cities');

jest.setTimeout(30000);

const PDF = '%PDF-1.4 a medical report';
const EICAR = '%PDF-1.4 EICAR-TEST-FILE';
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');
const pcBody = {
  serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', country: 'AE',
  origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI }, patientContact: '+971501234567', preferredDate: '2099-01-01',
  careLevel: ['care_icu', 'care_stable'], description: 'Needs ICU transfer', mobility: 'bedridden', urgency: 'urgent_24h',
};

let clamd;
let admin;
const previousEnv = {};

beforeAll(async () => {
  for (const key of ['PRIVATE_CHARTER_REVIEW_WORKFLOW', 'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_TIMEOUT_MS']) previousEnv[key] = process.env[key];
  clamd = await startFakeClamd();
  process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String(clamd.port);
  process.env.CLAMAV_TIMEOUT_MS = '1500';
  await prisma.geonamesCity.deleteMany();
  await prisma.geonamesCity.createMany({ data: ROWS.map((row) => ({ ...row, verifiedAt: new Date() })) });
  admin = await createAdminAndLogin();
  admin.id = (await prisma.adminUser.findUnique({ where: { email: admin.email } })).id;
});

afterAll(async () => {
  // Files this suite stored (shared uploads folder): only those a request_documents row points at.
  const rows = await prisma.requestDocument.findMany({ select: { storageKey: true } });
  for (const { storageKey } of rows) {
    fs.rmSync(path.join(UPLOAD_DIR, path.basename(storageKey)), { force: true });
    fs.rmSync(path.join(review.QUARANTINE_DIR, path.basename(storageKey)), { force: true });
  }
  try { fs.rmdirSync(review.QUARANTINE_DIR); } catch { /* not empty or not there */ }
  await prisma.geonamesCity.deleteMany();
  await clamd.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  clamd.setMode('ok');
  process.env.CLAMAV_PORT = String(clamd.port);
});

// ---- helpers ----------------------------------------------------------------------------------
async function newRequest(body = pcBody) {
  const patient = await createPatient();
  const res = await request(app).post('/requests').set(auth(patient.token)).send(body);
  return { ...patient, res, id: res.body.request && res.body.request.id };
}
const upload = (token, id, { name = 'report.pdf', content = PDF, replaces } = {}) => {
  const req = request(app).post(`/requests/me/${id}/documents`).set(auth(token)).attach('file', Buffer.from(content), { filename: name, contentType: 'application/pdf' });
  if (replaces !== undefined) req.field('replacesDocumentId', String(replaces));
  return req;
};
const adminGet = (url) => request(app).get(url).set(auth(admin.token));
const adminPost = (url, body = {}) => request(app).post(url).set(auth(admin.token)).send(body);
const approveDocument = (reqId, docId) => adminPost(`/admin/requests/${reqId}/documents/${docId}/review`, { decision: 'approved' });
const eventsOf = async (id) => (await prisma.requestEvent.findMany({ where: { serviceRequestId: id }, orderBy: { id: 'asc' } }));
const actions = async (id) => (await eventsOf(id)).map((e) => e.action);
const caseOf = (id) => prisma.case.findUnique({ where: { serviceRequestId: id } });

// A request with one clean document that an Admin has approved.
async function approvableRequest() {
  const r = await newRequest();
  const up = await upload(r.token, r.id);
  await approveDocument(r.id, up.body.document.id);
  return { ...r, docId: up.body.document.id };
}

// ---- creating the request ---------------------------------------------------------------------
describe('creating a Private Charter request in the workflow', () => {
  it('saves it with a permanent REQ- reference, no Case, no Bitrix lead and an initial event', async () => {
    createLead.mockClear();
    const r = await newRequest();
    expect(r.res.status).toBe(201);
    expect(r.res.body.request).toMatchObject({ reviewStatus: 'awaiting_documents', status: 'submitted' });
    expect(r.res.body.request.referenceNumber).toBe(`REQ-${1000 + r.id}`);
    expect(await caseOf(r.id)).toBeNull();
    expect(createLead).not.toHaveBeenCalled();
    const events = await eventsOf(r.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'request_created', toStatus: 'awaiting_documents', actorType: 'patient', actorId: r.user.id });
  });

  it('stores exactly the same fields as the original flow does', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';
    const old = await newRequest();
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const next = await newRequest();
    const columns = (row) => {
      const copy = { ...row };
      for (const key of ['id', 'userId', 'referenceNumber', 'createdAt', 'updatedAt', 'reviewStatus', 'preferredDate']) delete copy[key];
      return copy;
    };
    const a = await prisma.serviceRequest.findUnique({ where: { id: old.id } });
    const b = await prisma.serviceRequest.findUnique({ where: { id: next.id } });
    expect(columns(b)).toEqual(columns(a));
    expect(b.preferredDate).toEqual(a.preferredDate);
  });

  it('is all-or-nothing: if the first event cannot be saved, no request is left behind', async () => {
    const patient = await createPatient();
    const realTransaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((fn, options) => realTransaction(
      (tx) => fn(new Proxy(tx, { get: (target, key) => (key === 'requestEvent' ? { create: () => Promise.reject(new Error('disk full')) } : target[key]) })),
      options,
    ));
    const res = await request(app).post('/requests').set(auth(patient.token)).send(pcBody);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await prisma.serviceRequest.count({ where: { userId: patient.user.id } })).toBe(0);
  });

  it('is unchanged when the workflow is off: the Case is created with the request', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';
    const r = await newRequest();
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    expect(r.res.body.request.reviewStatus).toBeNull();
    expect((await caseOf(r.id)).referenceNumber).toBe(r.res.body.request.referenceNumber);
  });

  it('is unchanged for other services even with the workflow on', async () => {
    const r = await newRequest({ serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' });
    expect(r.res.status).toBe(201);
    expect(r.res.body.request.reviewStatus).toBeNull();
    expect(await caseOf(r.id)).not.toBeNull();
  });
});

// ---- the patient uploads ----------------------------------------------------------------------
describe('uploading documents', () => {
  it('stores the file against the request, scans it, and moves the request into review', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    expect(up.status).toBe(201);
    expect(up.body.document).toMatchObject({ name: 'report.pdf', scanStatus: 'clean', reviewStatus: 'pending', replacesId: null });
    const saved = await prisma.serviceRequest.findUnique({ where: { id: r.id } });
    expect(saved.reviewStatus).toBe('in_review');
    expect(saved.submittedAt).toBeTruthy();
    expect(await caseOf(r.id)).toBeNull();
    expect(await actions(r.id)).toEqual(['request_created', 'document_uploaded', 'status_changed', 'scan_clean']);
    const docRow = await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } });
    expect(docRow).toMatchObject({ scanEngine: 'clamav', serviceRequestId: r.id, uploadedByUserId: r.user.id });
    expect(docRow.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the existing upload URL and response field names', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id, { name: 'a.pdf' });
    expect(up.body.document).toEqual(expect.objectContaining({ id: expect.any(Number), name: 'a.pdf', fileSizeBytes: PDF.length, uploadedAt: expect.any(String) }));
  });

  it('accepts several documents, and shows the patient only safe fields', async () => {
    const r = await newRequest();
    await upload(r.token, r.id, { name: 'one.pdf' });
    await upload(r.token, r.id, { name: 'two.pdf' });
    const res = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(res.status).toBe(200);
    expect(res.body.request.case).toBeNull();
    expect(res.body.request.reviewStatus).toBe('in_review');
    expect(res.body.request.requestDocuments.map((d) => d.originalName)).toEqual(['one.pdf', 'two.pdf']);
    for (const d of res.body.request.requestDocuments) {
      expect(Object.keys(d).sort()).toEqual(['id', 'originalName', 'rejectionReason', 'replacesId', 'reviewStatus', 'scanStatus', 'sizeBytes', 'supersededAt', 'uploadedAt']);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|sha256|reviewedByAdminId/);
  });

  it('refuses a request that is not the patient\'s own', async () => {
    const owner = await newRequest();
    const other = await createPatient();
    const res = await upload(other.token, owner.id);
    expect(res.status).toBe(404);
    expect(await prisma.requestDocument.count({ where: { serviceRequestId: owner.id } })).toBe(0);
  });

  it('still refuses an unsupported file type', async () => {
    const r = await newRequest();
    const res = await request(app).post(`/requests/me/${r.id}/documents`).set(auth(r.token)).attach('file', Buffer.from('x'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
  });

  it('removes the stored file when the upload is refused', async () => {
    const owner = await newRequest();
    const other = await createPatient();
    const before = fs.readdirSync(UPLOAD_DIR).filter((f) => f.includes('orphan-check')).length;
    await upload(other.token, owner.id, { name: 'orphan-check.pdf' });
    expect(fs.readdirSync(UPLOAD_DIR).filter((f) => f.includes('orphan-check')).length).toBe(before);
  });

  it('replaces a document: the old row is kept and marked, the new one points back to it', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'old.pdf' });
    const second = await upload(r.token, r.id, { name: 'new.pdf', replaces: first.body.document.id });
    expect(second.status).toBe(201);
    expect(second.body.document.replacesId).toBe(first.body.document.id);
    const rows = await prisma.requestDocument.findMany({ where: { serviceRequestId: r.id }, orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].supersededAt).toBeTruthy();
    expect(rows[1].supersededAt).toBeNull();
    expect((await actions(r.id))).toContain('document_replaced');
  });

  it('refuses to replace something that is not a current document of this request', async () => {
    const r = await newRequest();
    const mine = await upload(r.token, r.id, { name: 'a.pdf' });
    const other = await newRequest();
    const theirs = await upload(other.token, other.id, { name: 'b.pdf' });
    expect((await upload(r.token, r.id, { replaces: theirs.body.document.id })).status).toBe(400);
    expect((await upload(r.token, r.id, { replaces: 'abc' })).status).toBe(400);
    await upload(r.token, r.id, { name: 'c.pdf', replaces: mine.body.document.id });
    expect((await upload(r.token, r.id, { replaces: mine.body.document.id })).status).toBe(400); // already replaced
  });

  it('refuses uploads once the request is approved (they would skip the scan)', async () => {
    const r = await approvableRequest();
    expect((await adminPost(`/admin/requests/${r.id}/approve`)).status).toBe(201);
    const res = await upload(r.token, r.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('request_approved');
  });
});

// ---- ClamAV, fail closed ----------------------------------------------------------------------
describe('virus scanning fails closed', () => {
  it('an infected file is quarantined and can be opened by nobody, Admin included', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id, { name: 'bad.pdf', content: EICAR });
    expect(up.status).toBe(201);
    expect(up.body.document.scanStatus).toBe('infected');
    const row = await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } });
    expect(row.scanDetail).toBe('Eicar-Test-Signature');
    expect(fs.existsSync(path.join(UPLOAD_DIR, row.storageKey))).toBe(false);
    expect(fs.existsSync(path.join(review.QUARANTINE_DIR, row.storageKey))).toBe(true);
    const dl = await adminGet(`/admin/requests/${r.id}/documents/${row.id}/file`);
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('document_not_clean');
    expect((await adminPost(`/admin/requests/${r.id}/documents/${row.id}/review`, { decision: 'approved' })).status).toBe(409);
    expect(await actions(r.id)).toContain('scan_infected');
  });

  it('while the scanner is down a document is saved but unusable, then usable once it is scanned', async () => {
    process.env.CLAMAV_PORT = String(await unusedPort());
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    expect(up.status).toBe(201);
    expect(up.body.document.scanStatus).toBe('error');
    const id = up.body.document.id;
    expect((await adminGet(`/admin/requests/${r.id}/documents/${id}/file`)).status).toBe(409);
    expect((await approveDocument(r.id, id)).status).toBe(409);

    // The worker's sweep retries; while the scanner is still down nothing becomes clean and the
    // failure is recorded once, not on every retry.
    await review.sweepPendingScans();
    await review.sweepPendingScans();
    expect((await prisma.requestDocument.findUnique({ where: { id } })).scanStatus).toBe('error');
    expect((await actions(r.id)).filter((a) => a === 'scan_error')).toHaveLength(1);

    process.env.CLAMAV_PORT = String(clamd.port);
    await review.sweepPendingScans();
    expect((await prisma.requestDocument.findUnique({ where: { id } })).scanStatus).toBe('clean');
    expect((await adminGet(`/admin/requests/${r.id}/documents/${id}/file`)).status).toBe(200);
  });

  it('a document that was never scanned cannot be opened or reviewed', async () => {
    const r = await newRequest();
    const row = await prisma.requestDocument.create({
      data: { serviceRequestId: r.id, originalName: 'raw.pdf', storageKey: `raw-${Date.now()}.pdf`, sizeBytes: 3, uploadedByUserId: r.user.id },
    });
    expect(row.scanStatus).toBe('pending');
    expect((await adminGet(`/admin/requests/${r.id}/documents/${row.id}/file`)).status).toBe(409);
    expect((await adminPost(`/admin/requests/${r.id}/documents/${row.id}/review`, { decision: 'approved' })).status).toBe(409);
  });

  it.each([['garbage'], ['wrongok'], ['close']])('treats a "%s" scanner answer as an error, never as clean', async (mode) => {
    clamd.setMode(mode);
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    expect(up.body.document.scanStatus).toBe('error');
  });

  it('treats a scanner that never answers as an error after the timeout', async () => {
    clamd.setMode('hang');
    const result = await scanFile(path.join(__dirname, 'request-review.test.js'), { host: '127.0.0.1', port: clamd.port, timeoutMs: 300 });
    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/deadline exceeded|timed out/);
  });

  it('treats an unreadable file as an error', async () => {
    const result = await scanFile(path.join(__dirname, 'does-not-exist.pdf'), { host: '127.0.0.1', port: clamd.port, timeoutMs: 1000 });
    expect(result.status).toBe('error');
  });

  it('streams the whole file to the scanner', async () => {
    clamd.state.contents.length = 0;
    const r = await newRequest();
    await upload(r.token, r.id, { content: PDF });
    expect(clamd.state.contents.pop().toString()).toBe(PDF);
  });

  it('does not serve a file that changed after it was scanned', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    const row = await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } });
    fs.writeFileSync(path.join(UPLOAD_DIR, row.storageKey), 'swapped after the scan');
    const dl = await adminGet(`/admin/requests/${r.id}/documents/${row.id}/file`);
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('file_changed');
  });
});

// ---- Admin: reading ---------------------------------------------------------------------------
describe('Admin can see every request, including incomplete ones', () => {
  it('requires an Admin', async () => {
    const patient = await createPatient();
    expect((await request(app).get('/admin/requests')).status).toBe(401);
    expect((await request(app).get('/admin/requests').set(auth(patient.token))).status).toBe(403);
  });

  it('lists the submissions, keeps drafts out of the default list, and filters by status', async () => {
    const waiting = await newRequest();
    const inReview = await newRequest();
    await upload(inReview.token, inReview.id);
    const all = await adminGet('/admin/requests?limit=200');
    expect(all.status).toBe(200);
    const byId = Object.fromEntries(all.body.requests.map((x) => [x.id, x]));
    expect(byId[waiting.id]).toBeUndefined(); // no document yet: a draft, not a submission
    expect(byId[inReview.id]).toMatchObject({ reviewStatus: 'in_review', documents: { current: 1, awaitingReview: 1 } });
    const only = await adminGet('/admin/requests?status=awaiting_documents&limit=200');
    expect(only.body.requests.every((x) => x.reviewStatus === 'awaiting_documents')).toBe(true);
    expect(only.body.requests.some((x) => x.id === waiting.id)).toBe(true);
    expect((await adminGet('/admin/requests?status=bogus')).status).toBe(400);
  });

  it('reports the total of the matching requests, whatever the page size', async () => {
    const name = `Totalcheck ${Date.now()}`;
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await newRequest({ ...pcBody, patientName: `${name} ${i}` });
      await upload(r.token, r.id);
      ids.push(r.id);
    }
    const page = await adminGet(`/admin/requests?search=${encodeURIComponent(name)}&limit=2&offset=0`);
    expect(page.status).toBe(200);
    expect(page.body.requests).toHaveLength(2);
    expect(page.body.total).toBe(3);
    const rest = await adminGet(`/admin/requests?search=${encodeURIComponent(name)}&limit=2&offset=2`);
    expect(rest.body.requests).toHaveLength(1);
    expect(rest.body.total).toBe(3);
    // The default list also reports a total, and it is at least what this search found.
    expect((await adminGet('/admin/requests?limit=1')).body.total).toBeGreaterThanOrEqual(3);
    expect(ids).toHaveLength(3);
  });

  it('searches by request reference or patient name, case-insensitively, within the same filters', async () => {
    const name = `Searchable Patient ${Date.now()}`;
    const submitted = await newRequest({ ...pcBody, patientName: name });
    await upload(submitted.token, submitted.id);
    const draft = await newRequest({ ...pcBody, patientName: name });
    const reference = submitted.res.body.request.referenceNumber;

    const byReference = await adminGet(`/admin/requests?search=${encodeURIComponent(reference.toLowerCase())}`);
    expect(byReference.body.requests.map((x) => x.id)).toEqual([submitted.id]);
    expect(byReference.body.total).toBe(1);

    const byName = await adminGet(`/admin/requests?search=${encodeURIComponent(name.toUpperCase())}&limit=200`);
    expect(byName.body.requests.map((x) => x.id)).toEqual([submitted.id]); // the draft stays out of the default list
    const drafts = await adminGet(`/admin/requests?status=awaiting_documents&search=${encodeURIComponent(name)}`);
    expect(drafts.body.requests.map((x) => x.id)).toEqual([draft.id]);
    expect(drafts.body.total).toBe(1);

    const none = await adminGet('/admin/requests?search=zzz-no-such-request-zzz');
    expect(none.body).toMatchObject({ requests: [], total: 0 });
    // Blank search is ignored; wildcard characters are not treated as "match everything".
    expect((await adminGet('/admin/requests?search=%20%20')).body.total).toBeGreaterThanOrEqual(1);
    expect((await adminGet('/admin/requests?search=%25')).body.total).toBe(0);
  });

  it('accepts several statuses at once, and leaves out approved requests and drafts when asked for the open ones', async () => {
    const inReview = await newRequest();
    await upload(inReview.token, inReview.id);
    const changes = await newRequest();
    await upload(changes.token, changes.id);
    await adminPost(`/admin/requests/${changes.id}/request-documents`, { reason: 'Please add the certificate.' });
    const approved = await newRequest();
    await upload(approved.token, approved.id);
    await prisma.serviceRequest.update({ where: { id: approved.id }, data: { reviewStatus: 'approved' } });
    const draft = await newRequest();

    const open = await adminGet('/admin/requests?status=in_review,changes_requested&limit=200');
    expect(open.status).toBe(200);
    const ids = open.body.requests.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([inReview.id, changes.id]));
    expect(ids).not.toContain(approved.id);
    expect(ids).not.toContain(draft.id);
    expect(open.body.requests.every((x) => ['in_review', 'changes_requested'].includes(x.reviewStatus))).toBe(true);
    expect(open.body.total).toBe(open.body.requests.length);

    // A single status behaves as before, and the existing default list still shows approved ones.
    expect((await adminGet('/admin/requests?status=changes_requested&limit=200')).body.requests.map((x) => x.id)).toContain(changes.id);
    expect((await adminGet('/admin/requests?limit=200')).body.requests.map((x) => x.id)).toContain(approved.id);
    expect((await adminGet('/admin/requests?status=in_review,bogus')).status).toBe(400);
  });

  it('does not list older requests (they are read through their Case, as before)', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';
    const legacy = await newRequest();
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    const list = await adminGet('/admin/requests?limit=200');
    expect(list.body.requests.some((x) => x.id === legacy.id)).toBe(false);
    expect((await adminGet(`/admin/requests/${legacy.id}`)).status).toBe(404);
    const cases = await adminGet('/admin/cases');
    expect(cases.body.cases.some((c) => c.serviceRequestId === legacy.id)).toBe(true);
  });

  it('shows one request with every document version and its audit history', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'old.pdf' });
    await upload(r.token, r.id, { name: 'new.pdf', replaces: first.body.document.id });
    const res = await adminGet(`/admin/requests/${r.id}`);
    expect(res.status).toBe(200);
    const body = res.body.request;
    expect(body.user).toMatchObject({ id: r.user.id });
    expect(body.requestDocuments.map((d) => d.originalName)).toEqual(['old.pdf', 'new.pdf']);
    expect(body.requestDocuments[0].supersededAt).toBeTruthy();
    expect(body.requestEvents.map((e) => e.action)).toEqual(expect.arrayContaining(['request_created', 'document_uploaded', 'document_replaced', 'scan_clean']));
    expect(body.case).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/storageKey/);
  });

  it('returns every field the Admin Portal details page reads, and keeps the stored file name private', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'old.pdf' });
    await adminPost(`/admin/requests/${r.id}/documents/${first.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    await upload(r.token, r.id, { name: 'new.pdf', replaces: first.body.document.id });
    const body = (await adminGet(`/admin/requests/${r.id}`)).body.request;

    // Request, patient and request-information fields.
    for (const field of ['id', 'referenceNumber', 'reviewStatus', 'submittedAt', 'createdAt', 'documentsRequestReason', 'patientName', 'patientAge', 'patientGender',
      'patientContact', 'patientLocation', 'serviceType', 'origin', 'destination', 'country', 'preferredDate', 'careLevel', 'urgency', 'mobility', 'description',
      'equipOxygen', 'equipCardiacMonitor', 'equipVentilator', 'deceasedRelation', 'placeOfDeath', 'dateOfDeath']) {
      expect(body).toHaveProperty(field);
    }
    expect(body).toMatchObject({ reviewStatus: 'in_review', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', urgency: 'urgent_24h', country: 'AE' });
    expect(body.careLevel).toBe('care_icu,care_stable'); // keys: the page translates them
    // Account holder.
    expect(body.user).toEqual({ id: r.user.id, name: expect.any(String), email: expect.any(String), mobile: expect.anything() });
    // Document history, including the replaced original with its rejection and the replacement link.
    const [old, current] = body.requestDocuments;
    for (const field of ['id', 'originalName', 'sizeBytes', 'mimeType', 'uploadedAt', 'replacesId', 'supersededAt', 'scanStatus', 'scanDetail', 'scannedAt', 'reviewStatus',
      'reviewedByAdminId', 'reviewedAt', 'rejectionReason']) {
      expect(old).toHaveProperty(field);
    }
    expect(old).toMatchObject({ reviewStatus: 'rejected', rejectionReason: 'Please resend a clearer copy.', reviewedByAdminId: admin.id });
    expect(old.supersededAt).toBeTruthy();
    expect(current.replacesId).toBe(old.id);
    // Timeline: id, action, actor, statuses, detail and time. Admin events carry only the id.
    for (const event of body.requestEvents) {
      for (const field of ['id', 'documentId', 'action', 'fromStatus', 'toStatus', 'actorType', 'actorId', 'detail', 'occurredAt']) expect(event).toHaveProperty(field);
    }
    expect(body.requestEvents.find((e) => e.action === 'document_rejected')).toMatchObject({ actorType: 'admin', actorId: admin.id, detail: { reason: 'Please resend a clearer copy.' } });
    expect(body.requestEvents.find((e) => e.action === 'document_replaced').detail).toMatchObject({ name: 'new.pdf', replacesId: old.id });
    // Summary and linked Case.
    expect(body.documentSummary).toEqual({ current: 1, awaitingScan: 0, scanErrors: 0, scanFailed: 0, infected: 0, awaitingReview: 1, approved: 0, rejected: 0 });
    expect(body.case).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/storageKey/);
    expect(text).not.toMatch(/passwordHash|password_hash/);
  });

  it('lets an Admin download a clean document, and records it', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id, { content: PDF });
    const dl = await adminGet(`/admin/requests/${r.id}/documents/${up.body.document.id}/file`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    expect(Buffer.from(dl.body).toString()).toBe(PDF);
    const events = await eventsOf(r.id);
    expect(events.find((e) => e.action === 'document_downloaded')).toMatchObject({ actorType: 'admin', actorId: admin.id, documentId: up.body.document.id });
  });

  it('will not serve a document through another request\'s URL', async () => {
    const a = await newRequest();
    const b = await newRequest();
    const up = await upload(a.token, a.id);
    expect((await adminGet(`/admin/requests/${b.id}/documents/${up.body.document.id}/file`)).status).toBe(404);
  });
});

// ---- Admin: decisions -------------------------------------------------------------------------
describe('reviewing documents and asking for more', () => {
  it('approves a clean document, recording who and when', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    const res = await approveDocument(r.id, up.body.document.id);
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ reviewStatus: 'approved', reviewedByAdminId: admin.id });
    expect((await eventsOf(r.id)).find((e) => e.action === 'document_approved')).toMatchObject({ actorType: 'admin', actorId: admin.id });
  });

  it('rejecting needs a reason; it is shown to the patient and asks for a replacement', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id, { name: 'blurry.pdf' });
    const url = `/admin/requests/${r.id}/documents/${up.body.document.id}/review`;
    expect((await adminPost(url, { decision: 'rejected' })).status).toBe(400);
    expect((await adminPost(url, { decision: 'rejected', reason: 'no' })).status).toBe(400);
    expect((await adminPost(url, { decision: 'maybe' })).status).toBe(400);
    const res = await adminPost(url, { decision: 'rejected', reason: 'The scan is unreadable, please send a clearer copy.' });
    expect(res.status).toBe(200);
    const mine = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(mine.body.request.reviewStatus).toBe('changes_requested');
    expect(mine.body.request.requestDocuments[0]).toMatchObject({ reviewStatus: 'rejected', rejectionReason: 'The scan is unreadable, please send a clearer copy.' });
    expect((await actions(r.id))).toEqual(expect.arrayContaining(['document_rejected', 'status_changed']));
    // A rejected document stays rejected: the patient replaces it.
    expect((await approveDocument(r.id, up.body.document.id)).status).toBe(409);
  });

  it('keeps the rejected original in the history when the patient replaces it', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'blurry.pdf' });
    await adminPost(`/admin/requests/${r.id}/documents/${first.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    const second = await upload(r.token, r.id, { name: 'clear.pdf', replaces: first.body.document.id });
    expect(second.status).toBe(201);
    const rows = await prisma.requestDocument.findMany({ where: { serviceRequestId: r.id }, orderBy: { id: 'asc' } });
    expect(rows[0]).toMatchObject({ reviewStatus: 'rejected', rejectionReason: 'Please resend a clearer copy.' });
    expect(rows[0].supersededAt).toBeTruthy();
    expect((await prisma.serviceRequest.findUnique({ where: { id: r.id } })).reviewStatus).toBe('in_review');
  });

  it('cannot review a document that was replaced', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id);
    await upload(r.token, r.id, { replaces: first.body.document.id });
    expect((await approveDocument(r.id, first.body.document.id)).status).toBe(409);
  });

  it('asks for additional documents with a reason the patient can read', async () => {
    const r = await newRequest();
    await upload(r.token, r.id);
    const url = `/admin/requests/${r.id}/request-documents`;
    expect((await adminPost(url, {})).status).toBe(400);
    const res = await adminPost(url, { reason: 'Please add the fitness-to-fly certificate.' });
    expect(res.status).toBe(200);
    const mine = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(mine.body.request).toMatchObject({ reviewStatus: 'changes_requested', documentsRequestReason: 'Please add the fitness-to-fly certificate.' });
    const ask = (await eventsOf(r.id)).find((e) => e.action === 'documents_requested');
    expect(ask).toMatchObject({ actorType: 'admin', actorId: admin.id, detail: { reason: 'Please add the fitness-to-fly certificate.' } });
  });

  it('a new upload answers the request: back in review, the old documents untouched', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'one.pdf' });
    await approveDocument(r.id, first.body.document.id);
    await adminPost(`/admin/requests/${r.id}/request-documents`, { reason: 'Please add the discharge summary.' });
    await upload(r.token, r.id, { name: 'two.pdf' });
    const saved = await prisma.serviceRequest.findUnique({ where: { id: r.id } });
    expect(saved).toMatchObject({ reviewStatus: 'in_review', documentsRequestReason: null });
    expect((await prisma.requestDocument.findUnique({ where: { id: first.body.document.id } })).reviewStatus).toBe('approved');
  });

  it('nothing can be reviewed or requested on a request that does not exist or is older', async () => {
    expect((await adminPost('/admin/requests/999999/request-documents', { reason: 'Please send more.' })).status).toBe(404);
    expect((await adminPost('/admin/requests/999999/approve')).status).toBe(404);
    expect((await adminPost('/admin/requests/abc/approve')).status).toBe(400);
  });
});

// ---- asking for additional documents: the guards ----------------------------------------------
describe('asking for additional documents is only possible in review, once at a time', () => {
  const askUrl = (id) => `/admin/requests/${id}/request-documents`;
  const ask = (id, reason = 'Please add the fitness-to-fly certificate.') => adminPost(askUrl(id), { reason });
  // A submitted request (one document uploaded): in review.
  const inReview = async () => {
    const r = await newRequest();
    await upload(r.token, r.id);
    return r;
  };
  const stateOf = (id) => prisma.serviceRequest.findUnique({ where: { id }, select: { reviewStatus: true, documentsRequestReason: true, reviewedAt: true } });
  const asks = async (id) => (await eventsOf(id)).filter((e) => e.action === 'documents_requested');

  it('refuses a draft (no document uploaded yet) with 409 request_is_draft, and leaves it exactly as it was', async () => {
    const r = await newRequest(); // awaiting_documents: not submitted
    const eventsBefore = (await eventsOf(r.id)).length;
    const res = await ask(r.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('request_is_draft');
    expect(res.body.error).toMatch(/draft/);
    expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'awaiting_documents', documentsRequestReason: null, reviewedAt: null });
    expect((await eventsOf(r.id)).length).toBe(eventsBefore); // no event was written
    // It is still a draft for the Admin: out of the submissions list, in the drafts list.
    expect((await adminGet('/admin/requests?limit=200')).body.requests.some((x) => x.id === r.id)).toBe(false);
    expect((await adminGet('/admin/requests?status=awaiting_documents&limit=200')).body.requests.some((x) => x.id === r.id)).toBe(true);
    // And the patient still sees a request that is waiting for its first document, with no reason.
    const mine = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(mine.body.request).toMatchObject({ reviewStatus: 'awaiting_documents', documentsRequestReason: null });
  });

  it('refuses a request that is already waiting for the patient with 409 documents_request_already_pending, keeping the first reason', async () => {
    const r = await inReview();
    const first = await ask(r.id, 'Please add the fitness-to-fly certificate.');
    expect(first.status).toBe(200);
    const stamp = (await stateOf(r.id)).reviewedAt;

    const second = await ask(r.id, 'Also send the insurance letter.');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('documents_request_already_pending');
    expect(second.body.error).toMatch(/already been asked/);
    // Nothing changed: the patient still reads the first reason, and there is still one ask in the history.
    expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'changes_requested', documentsRequestReason: 'Please add the fitness-to-fly certificate.' });
    expect((await stateOf(r.id)).reviewedAt).toEqual(stamp);
    const history = await asks(r.id);
    expect(history).toHaveLength(1);
    expect(history[0].detail).toEqual({ reason: 'Please add the fitness-to-fly certificate.' });
    const mine = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(mine.body.request.documentsRequestReason).toBe('Please add the fitness-to-fly certificate.');
  });

  it('also refuses while changes are pending because a document was rejected (the status is what counts)', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    await adminPost(`/admin/requests/${r.id}/documents/${up.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    expect((await stateOf(r.id)).reviewStatus).toBe('changes_requested');
    const res = await ask(r.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('documents_request_already_pending');
    expect(await asks(r.id)).toHaveLength(0);
  });

  it('can ask again once the patient has answered (back in review), and the history keeps both asks in order', async () => {
    const r = await inReview();
    expect((await ask(r.id, 'First: the discharge summary.')).status).toBe(200);
    expect((await ask(r.id, 'Second: too early.')).status).toBe(409);
    await upload(r.token, r.id, { name: 'discharge.pdf' }); // the patient answers: in review again, reason cleared
    expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'in_review', documentsRequestReason: null });
    const again = await ask(r.id, 'Second: the insurance letter.');
    expect(again.status).toBe(200);
    expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'changes_requested', documentsRequestReason: 'Second: the insurance letter.' });
    const history = await asks(r.id);
    expect(history.map((e) => e.detail.reason)).toEqual(['First: the discharge summary.', 'Second: the insurance letter.']);
    expect(history.map((e) => [e.fromStatus, e.toStatus])).toEqual([['in_review', 'changes_requested'], ['in_review', 'changes_requested']]);
    expect(history.every((e) => e.actorType === 'admin' && e.actorId === admin.id)).toBe(true);
  });

  it('keeps the order of the checks: an invalid reason is 400 and an unknown request 404, even where a guard would also apply', async () => {
    const draft = await newRequest();
    const bad = await adminPost(askUrl(draft.id), { reason: 'ab' });
    expect(bad.status).toBe(400); // not 409 request_is_draft
    expect(bad.body.code).toBe('reason_required');
    const waiting = await inReview();
    await ask(waiting.id);
    expect((await adminPost(askUrl(waiting.id), {})).status).toBe(400); // not 409 documents_request_already_pending
    expect((await ask(999999)).status).toBe(404);
    expect((await adminPost('/admin/requests/abc/request-documents', { reason: 'Please send more.' })).status).toBe(400);
  });

  it('refuses an approved request with 409 request_approved, and creates nothing', async () => {
    const r = await approvableRequest();
    const approval = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(approval.status).toBe(201);
    const eventsBefore = (await eventsOf(r.id)).length;
    const res = await ask(r.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('request_approved');
    expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'approved', documentsRequestReason: null });
    expect((await eventsOf(r.id)).length).toBe(eventsBefore);
    expect(await prisma.case.count({ where: { serviceRequestId: r.id } })).toBe(1); // the Case from the approval, no second one
  });

  it('does not create a Case, and approval stays blocked until the patient answers', async () => {
    const r = await approvableRequest();
    expect((await ask(r.id)).status).toBe(200);
    expect(await caseOf(r.id)).toBeNull();
    const blocked = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers.map((b) => b.code)).toEqual(['documents_requested']);
    expect(await caseOf(r.id)).toBeNull();
  });

  describe('the reason: 3 to 1000 characters after trimming', () => {
    // Each success moves its request to changes_requested, so every case gets a fresh request in review.
    it('2 characters (and 2 after trimming) is refused with 400 reason_required, and nothing changes', async () => {
      for (const reason of ['ab', '   ab   ', '', '    ', undefined]) {
        const r = await inReview();
        const res = await adminPost(askUrl(r.id), reason === undefined ? {} : { reason });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('reason_required');
        expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'in_review', documentsRequestReason: null });
        expect(await asks(r.id)).toHaveLength(0);
      }
    });

    it('a non-string reason is refused with 400 as well', async () => {
      const r = await inReview();
      for (const reason of [123, { text: 'Please send more.' }, ['Please send more.'], null, true]) {
        expect((await adminPost(askUrl(r.id), { reason })).status).toBe(400);
      }
      expect((await stateOf(r.id)).reviewStatus).toBe('in_review');
    });

    it('exactly 3 characters is accepted and stored as given', async () => {
      const r = await inReview();
      const res = await ask(r.id, 'abc');
      expect(res.status).toBe(200);
      expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'changes_requested', documentsRequestReason: 'abc' });
    });

    it('exactly 1000 characters is accepted, and the surrounding spaces are not counted or stored', async () => {
      const a = await inReview();
      expect((await ask(a.id, 'x'.repeat(1000))).status).toBe(200);
      expect((await stateOf(a.id)).documentsRequestReason).toHaveLength(1000);
      const b = await inReview();
      expect((await ask(b.id, `  ${'y'.repeat(1000)}  `)).status).toBe(200); // 1000 once trimmed
      expect((await stateOf(b.id)).documentsRequestReason).toBe('y'.repeat(1000));
    });

    it('1001 characters is refused with 400 reason_required, and nothing changes', async () => {
      const r = await inReview();
      const res = await ask(r.id, 'z'.repeat(1001));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('reason_required');
      expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'in_review', documentsRequestReason: null });
      expect(await asks(r.id)).toHaveLength(0);
    });
  });

  describe('who may ask', () => {
    it('needs an Admin: no token 401, a bad token 401, a patient or a corporate user 403, and nothing changes', async () => {
      const r = await inReview();
      const url = askUrl(r.id);
      const body = { reason: 'Please send more.' };
      expect((await request(app).post(url).send(body)).status).toBe(401);
      expect((await request(app).post(url).set('Authorization', 'Bearer not-a-real-token').send(body)).status).toBe(401);
      expect((await request(app).post(url).set(auth(r.token)).send(body)).status).toBe(403); // the request's own patient
      const other = await createPatient();
      expect((await request(app).post(url).set(auth(other.token)).send(body)).status).toBe(403);
      const corp = await createCorporateUserAndLogin();
      expect((await request(app).post(url).set(auth(corp.token)).send(body)).status).toBe(403);
      expect(await stateOf(r.id)).toMatchObject({ reviewStatus: 'in_review', documentsRequestReason: null });
      expect(await asks(r.id)).toHaveLength(0);
      // A regular Admin (not only a superadmin) is allowed.
      expect((await ask(r.id)).status).toBe(200);
    });

    it('is checked before anything else: an unauthenticated call to a draft is 401, not 409', async () => {
      const r = await newRequest();
      expect((await request(app).post(askUrl(r.id)).send({ reason: 'Please send more.' })).status).toBe(401);
    });
  });
});

// ---- approval and the Case --------------------------------------------------------------------
describe('approving a request creates the Case', () => {
  it('creates a CASE- Case with the request\'s details and copies the approved documents', async () => {
    const r = await approvableRequest();
    const res = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(res.status).toBe(201);
    const made = await caseOf(r.id);
    expect(made.referenceNumber).toBe(`CASE-${1000 + made.id}`);
    expect(made).toMatchObject({
      patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567', country: 'AE',
      origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', careLevel: 'care_icu,care_stable',
      description: 'Needs ICU transfer', urgency: 'urgent', status: 'submitted', corporateId: null,
    });
    expect((await prisma.serviceRequest.findUnique({ where: { id: r.id } })).referenceNumber).toBe(`REQ-${1000 + r.id}`);
    const request2 = await prisma.serviceRequest.findUnique({ where: { id: r.id } });
    expect(request2).toMatchObject({ reviewStatus: 'approved', status: 'submitted' });

    const docs = await prisma.document.findMany({ where: { caseId: made.id } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: 'report.pdf', type: 'Medical Report', fileSizeBytes: PDF.length });
    expect((await prisma.requestDocument.findUnique({ where: { id: r.docId } })).caseDocumentId).toBe(docs[0].id);
    const stage = await prisma.caseStageEvent.findMany({ where: { caseId: made.id } });
    expect(stage).toHaveLength(1);
    expect((await actions(r.id)).slice(-2)).toEqual(['request_approved', 'case_created']);
    expect((await eventsOf(r.id)).find((e) => e.action === 'request_approved')).toMatchObject({ actorType: 'admin', actorId: admin.id, fromStatus: 'in_review', toStatus: 'approved' });
  });

  it('the patient then reads the Case and downloads the document through the existing endpoints', async () => {
    const r = await approvableRequest();
    await adminPost(`/admin/requests/${r.id}/approve`);
    const mine = await request(app).get(`/requests/me/${r.id}`).set(auth(r.token));
    expect(mine.body.request.case).toMatchObject({ referenceNumber: expect.stringMatching(/^CASE-\d+$/) });
    expect(mine.body.request.case.documents).toHaveLength(1);
    const dl = await request(app).get(`/documents/${mine.body.request.case.documents[0].id}/file`).set(auth(r.token));
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).toString()).toBe(PDF);
  });

  it('is safe to repeat: the same Case is returned, never a second one', async () => {
    const r = await approvableRequest();
    const first = await adminPost(`/admin/requests/${r.id}/approve`);
    const again = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.alreadyApproved).toBe(true);
    expect(again.body.case.id).toBe(first.body.case.id);
    expect(await prisma.case.count({ where: { serviceRequestId: r.id } })).toBe(1);
    expect((await actions(r.id)).filter((a) => a === 'case_created')).toHaveLength(1);
  });

  it('two approvals at the same moment still create one Case', async () => {
    const r = await approvableRequest();
    const [a, b] = await Promise.all([adminPost(`/admin/requests/${r.id}/approve`), adminPost(`/admin/requests/${r.id}/approve`)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.case.count({ where: { serviceRequestId: r.id } })).toBe(1);
  });

  it('is refused, with the reasons, while there is no document', async () => {
    const r = await newRequest();
    const res = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('approval_blocked');
    expect(res.body.blockers.map((b) => b.code)).toEqual(['no_documents']);
    expect(await caseOf(r.id)).toBeNull();
  });

  it('is refused while a document is waiting for review', async () => {
    const r = await newRequest();
    await upload(r.token, r.id);
    const res = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toEqual(['awaiting_review']);
  });

  it('is refused while a document is unscanned, failed its scan, or is infected', async () => {
    const r = await newRequest();
    const ok = await upload(r.token, r.id, { name: 'ok.pdf' });
    await approveDocument(r.id, ok.body.document.id);
    await upload(r.token, r.id, { name: 'virus.pdf', content: EICAR });
    process.env.CLAMAV_PORT = String(await unusedPort());
    await upload(r.token, r.id, { name: 'offline.pdf' });
    await prisma.requestDocument.create({ data: { serviceRequestId: r.id, originalName: 'raw.pdf', storageKey: `raw-${Date.now()}-x.pdf`, sizeBytes: 1, uploadedByUserId: r.user.id } });
    const res = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code).sort()).toEqual(['infected', 'scan_failed', 'unscanned']);
    expect(await caseOf(r.id)).toBeNull();
  });

  it('is refused while a rejected document has not been replaced, and allowed once it has and the new one is approved', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'blurry.pdf' });
    await adminPost(`/admin/requests/${r.id}/documents/${first.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    const blocked = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blockers.map((b) => b.code)).toContain('documents_requested');
    expect(blocked.body.blockers.map((b) => b.code)).toContain('rejected');

    const second = await upload(r.token, r.id, { name: 'clear.pdf', replaces: first.body.document.id });
    await approveDocument(r.id, second.body.document.id);
    const done = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(done.status).toBe(201);
    const copied = await prisma.document.findMany({ where: { caseId: done.body.case.id } });
    expect(copied.map((d) => d.name)).toEqual(['clear.pdf']); // the replaced original is history, not a Case document
    expect(await prisma.requestDocument.count({ where: { serviceRequestId: r.id } })).toBe(2);
  });

  it('is refused while additional documents requested by an Admin are missing', async () => {
    const r = await approvableRequest();
    await adminPost(`/admin/requests/${r.id}/request-documents`, { reason: 'Please add the discharge summary.' });
    const res = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.blockers.map((b) => b.code)).toEqual(['documents_requested']);
    expect(await caseOf(r.id)).toBeNull();
  });

  it('leaves corporate-created Cases and the admin Case list working', async () => {
    const r = await approvableRequest();
    await adminPost(`/admin/requests/${r.id}/approve`);
    const cases = await adminGet('/admin/cases');
    expect(cases.status).toBe(200);
    expect(cases.body.cases.find((c) => c.serviceRequestId === r.id).referenceNumber).toMatch(/^CASE-\d+$/);
  });
});

// ---- the audit history ------------------------------------------------------------------------
describe('the business audit history', () => {
  it('records the whole story in order, with the actor of each step', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id);
    await adminPost(`/admin/requests/${r.id}/documents/${first.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    const second = await upload(r.token, r.id, { replaces: first.body.document.id });
    await approveDocument(r.id, second.body.document.id);
    await adminPost(`/admin/requests/${r.id}/approve`);
    const events = await eventsOf(r.id);
    expect(events.map((e) => e.action)).toEqual([
      'request_created', 'document_uploaded', 'status_changed', 'scan_clean', 'document_rejected', 'status_changed',
      'document_replaced', 'status_changed', 'scan_clean', 'document_approved', 'request_approved', 'case_created',
    ]);
    expect(events.filter((e) => e.actorType === 'admin').every((e) => e.actorId === admin.id)).toBe(true);
    expect(events.filter((e) => e.actorType === 'patient').every((e) => e.actorId === r.user.id)).toBe(true);
    expect(events.filter((e) => e.action.startsWith('scan_')).every((e) => e.actorType === 'system')).toBe(true);
  });

  it('is never written to security_events', async () => {
    const patient = await createPatient();
    const created = await request(app).post('/requests').set(auth(patient.token)).send(pcBody);
    const id = created.body.request.id;
    const count = () => prisma.securityEvent.count();
    const before = await count();
    const up = await upload(patient.token, id);
    await adminPost(`/admin/requests/${id}/documents/${up.body.document.id}/review`, { decision: 'approved' });
    await adminPost(`/admin/requests/${id}/request-documents`, { reason: 'Please add the discharge summary.' });
    await upload(patient.token, id, { name: 'two.pdf' });
    expect(await count()).toBe(before);
    expect((await eventsOf(id)).length).toBeGreaterThan(5);
  });

  it('has no code path that edits or deletes an event', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(dir, f.name)) : [path.join(dir, f.name)]));
    const offenders = walk(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js')).filter((f) => /requestEvent\.(update|updateMany|delete|deleteMany|upsert)/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// ---- the worker ---------------------------------------------------------------------------------
describe('the scan job', () => {
  it('is registered with the worker and valid for the job runner', () => {
    const { jobs } = require('../src/jobs');
    const { createJobRunner } = require('../src/jobs/job-runner');
    expect(jobs.map((j) => j.name)).toContain('scan-request-documents');
    expect(() => createJobRunner(jobs)).not.toThrow();
  });

  it('scans documents that are waiting, and respects the batch limit', async () => {
    const r = await newRequest();
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const key = `sweep-${Date.now()}-${i}.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIR, key), PDF);
      ids.push((await prisma.requestDocument.create({ data: { serviceRequestId: r.id, originalName: key, storageKey: key, sizeBytes: PDF.length, sha256: sha(PDF), uploadedByUserId: r.user.id } })).id);
    }
    const first = await review.sweepPendingScans({ limit: 2 });
    expect(first.checked).toBe(2);
    const rest = await review.sweepPendingScans({ limit: 50 });
    expect(rest.checked).toBeGreaterThanOrEqual(1);
    const rows = await prisma.requestDocument.findMany({ where: { id: { in: ids } } });
    expect(rows.every((d) => d.scanStatus === 'clean')).toBe(true);
  });
});

// =====================================================================================================
// Phase 1 corrections: file integrity on every download, the one-document rule, small hardening.
// =====================================================================================================
const { createCorporateUserAndLogin } = require('./helpers');
const { cleanOriginalName } = require('../src/modules/request-review/request-review.files');

const storedFile = async (requestDocumentId) => path.join(UPLOAD_DIR, (await prisma.requestDocument.findUnique({ where: { id: requestDocumentId } })).storageKey);
const sameSizeGarbage = (file) => fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 'X'));

// A request with one approved document, approved by an Admin: returns the Case and its `documents` row.
async function approvedCase() {
  const r = await approvableRequest();
  const res = await adminPost(`/admin/requests/${r.id}/approve`);
  const [doc] = await prisma.document.findMany({ where: { caseId: res.body.case.id } });
  return { ...r, caseId: res.body.case.id, doc };
}
const download = (token, documentId) => request(app).get(`/documents/${documentId}/file`).set(auth(token));
const drainScans = async () => {
  for (let i = 0; i < 20 && (await prisma.requestDocument.count({ where: { scanStatus: 'pending' } })) > 0; i += 1) await review.sweepPendingScans({ limit: 50 });
};
// A stored document made directly (a real file with its checksum), not through the upload endpoint.
async function rawDocument(r, content = PDF, extra = {}) {
  const key = `raw-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR, key), content);
  return prisma.requestDocument.create({
    data: { serviceRequestId: r.id, originalName: key, storageKey: key, sizeBytes: Buffer.byteLength(content), sha256: sha(content), uploadedByUserId: r.user.id, ...extra },
  });
}

describe('documents of an approved request, opened through the existing download endpoint', () => {
  it('stay linked to the scanned original they were copied from', async () => {
    const a = await approvedCase();
    const original = await prisma.requestDocument.findUnique({ where: { id: a.docId } });
    expect(original.caseDocumentId).toBe(a.doc.id);
    expect(a.doc.fileUrl).toBe(`/uploads/${original.storageKey}`);
    expect(original).toMatchObject({ scanStatus: 'clean', reviewStatus: 'approved' });
    expect(original.sha256).toBe(sha(PDF));
  });

  it('are served to their patient, and only to their patient', async () => {
    const a = await approvedCase();
    const ok = await download(a.token, a.doc.id);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).toString()).toBe(PDF);
    expect(ok.headers['content-disposition']).toMatch(/attachment; filename="report\.pdf"/);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    const stranger = await createPatient();
    expect((await download(stranger.token, a.doc.id)).status).toBe(404);
    expect((await request(app).get(`/documents/${a.doc.id}/file`)).status).toBe(401);
  });

  it('never show their stored path in the Admin Case details or the patient request, yet are still downloaded by id', async () => {
    const a = await approvedCase();
    const original = await prisma.requestDocument.findUnique({ where: { id: a.docId } });
    const adminView = await adminGet(`/admin/cases/${a.caseId}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.case.documents).toHaveLength(1);
    expect(Object.keys(adminView.body.case.documents[0]).sort()).toEqual(['caseId', 'fileSizeBytes', 'id', 'name', 'type', 'uploadedAt']);
    const patientView = await request(app).get(`/requests/me/${a.id}`).set(auth(a.token));
    expect(patientView.status).toBe(200);
    for (const body of [adminView.body, patientView.body]) {
      const text = JSON.stringify(body);
      for (const secret of ['fileUrl', '/uploads/', original.storageKey, original.sha256]) expect(text).not.toContain(secret);
    }
    // The stored row keeps its path, and the workflow checks (clean, approved, checksum) still decide the download.
    expect((await prisma.document.findUnique({ where: { id: a.doc.id } })).fileUrl).toBe(`/uploads/${original.storageKey}`);
    const ok = await download(a.token, a.doc.id);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).toString()).toBe(PDF);
  });

  it('are served to the corporate the Case is assigned to, and to no other corporate', async () => {
    const a = await approvedCase();
    const corp = await createCorporateUserAndLogin();
    const other = await createCorporateUserAndLogin({ companyName: 'Some Other Co' });
    expect((await download(corp.token, a.doc.id)).status).toBe(404); // not assigned yet
    const assigned = await request(app).patch(`/admin/cases/${a.caseId}/assign`).set(auth(admin.token)).send({ corporateId: corp.corporate.id });
    expect(assigned.status).toBe(200);
    const ok = await download(corp.token, a.doc.id);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).toString()).toBe(PDF);
    expect((await download(other.token, a.doc.id)).status).toBe(404);
  });

  it('cannot be downloaded once the stored file is altered, even to the same size', async () => {
    const a = await approvedCase();
    const corp = await createCorporateUserAndLogin();
    await request(app).patch(`/admin/cases/${a.caseId}/assign`).set(auth(admin.token)).send({ corporateId: corp.corporate.id });
    sameSizeGarbage(await storedFile(a.docId));
    for (const token of [a.token, corp.token]) {
      const res = await download(token, a.doc.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('file_changed');
    }
  });

  it('cannot be downloaded once the stored file is missing', async () => {
    const a = await approvedCase();
    const file = await storedFile(a.docId);
    fs.renameSync(file, `${file}.moved`);
    const res = await download(a.token, a.doc.id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('file_missing');
    fs.renameSync(`${file}.moved`, file);
    expect((await download(a.token, a.doc.id)).status).toBe(200);
  });

  it('are refused if the stored record has no checksum', async () => {
    const a = await approvedCase();
    await prisma.requestDocument.update({ where: { id: a.docId }, data: { sha256: null } });
    const res = await download(a.token, a.doc.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('checksum_missing');
  });

  it('cannot be reached through a documents row that was not created by the approval', async () => {
    const a = await approvedCase();
    const other = await newRequest();
    const up = await upload(other.token, other.id); // clean, but its request is not approved: no link
    const key = (await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } })).storageKey;
    const stray = await prisma.document.create({ data: { caseId: a.caseId, name: 'x.pdf', type: 'Medical Report', fileUrl: `/uploads/${key}` } });
    const res = await download(a.token, stray.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_verified');
  });

  it('cannot be reached if the scanned original is not clean and approved', async () => {
    const a = await approvedCase();
    await prisma.requestDocument.update({ where: { id: a.docId }, data: { scanStatus: 'error' } });
    const res = await download(a.token, a.doc.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('document_not_clean');
  });
});

describe('documents that predate the workflow keep working', () => {
  it('are served as before: no scan data is needed and none is assumed', async () => {
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';
    const old = await newRequest();
    process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'true';
    expect(old.res.body.request.reviewStatus).toBeNull();
    const up = await upload(old.token, old.id, { name: 'legacy.pdf', content: 'older report' });
    expect(up.status).toBe(201);
    const [doc] = await prisma.document.findMany({ where: { caseId: (await caseOf(old.id)).id } });

    const first = await download(old.token, doc.id);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).toString()).toBe('older report');
    expect(await prisma.requestDocument.count({ where: { storageKey: path.basename(doc.fileUrl) } })).toBe(0);

    // There is no checksum to compare for these, so a changed file is not (and cannot be) refused.
    fs.writeFileSync(path.join(UPLOAD_DIR, path.basename(doc.fileUrl)), 'edited later');
    const second = await download(old.token, doc.id);
    expect(second.status).toBe(200);
    expect(Buffer.from(second.body).toString()).toBe('edited later');
  });
});

describe('approval checks the stored files before creating the Case', () => {
  it('refuses a file that changed after the Admin approved it, then accepts it once it is restored', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    await approveDocument(r.id, up.body.document.id);
    const file = await storedFile(up.body.document.id);
    const original = fs.readFileSync(file);
    sameSizeGarbage(file);
    const refused = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.blockers).toEqual([expect.objectContaining({ code: 'file_changed', documentId: up.body.document.id })]);
    expect(await caseOf(r.id)).toBeNull();
    fs.writeFileSync(file, original);
    expect((await adminPost(`/admin/requests/${r.id}/approve`)).status).toBe(201);
  });

  it('refuses a file that is missing, and a document with no recorded checksum', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    await approveDocument(r.id, up.body.document.id);
    const file = await storedFile(up.body.document.id);
    fs.renameSync(file, `${file}.moved`);
    const missing = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(missing.body.blockers.map((b) => b.code)).toEqual(['file_missing']);
    fs.renameSync(`${file}.moved`, file);
    await prisma.requestDocument.update({ where: { id: up.body.document.id }, data: { sha256: null } });
    const noSum = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(noSum.body.blockers.map((b) => b.code)).toEqual(['checksum_missing']);
    expect(await caseOf(r.id)).toBeNull();
  });

  it('an Admin cannot download a document whose file changed or whose checksum is missing', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    const url = `/admin/requests/${r.id}/documents/${up.body.document.id}/file`;
    expect((await adminGet(url)).status).toBe(200);
    await prisma.requestDocument.update({ where: { id: up.body.document.id }, data: { sha256: null } });
    expect((await adminGet(url)).body.code).toBe('checksum_missing');
    await prisma.requestDocument.update({ where: { id: up.body.document.id }, data: { sha256: sha(PDF) } });
    sameSizeGarbage(await storedFile(up.body.document.id));
    expect((await adminGet(url)).body.code).toBe('file_changed');
  });
});

describe('a clean verdict describes the bytes that are kept', () => {
  it('a file changed between upload and scan is never marked clean', async () => {
    process.env.CLAMAV_PORT = String(await unusedPort()); // scanner down at upload: the scan waits
    const r = await newRequest();
    const up = await upload(r.token, r.id);
    expect(up.body.document.scanStatus).toBe('error');
    sameSizeGarbage(await storedFile(up.body.document.id));
    process.env.CLAMAV_PORT = String(clamd.port);
    await review.sweepPendingScans();
    const row = await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } });
    expect(row.scanStatus).toBe('failed'); // the bytes no longer match the upload: no retry can fix that, so it is final
    expect(row.scanDetail).toMatch(/checksum/);
  });

  it('a file changed while it is being scanned is never marked clean', async () => {
    const r = await newRequest();
    const doc = await rawDocument(r);
    const file = path.join(UPLOAD_DIR, doc.storageKey);
    const result = await review.scanRequestDocument(doc.id, { scanner: async () => { fs.writeFileSync(file, Buffer.alloc(PDF.length, 'Y')); return { status: 'clean' }; } });
    expect(result.scanStatus).toBe('failed');
    expect(result.scanDetail).toMatch(/changed while/);
  });

  it('a document whose file is gone fails for good, and is never clean', async () => {
    const r = await newRequest();
    // A file is lost for good only when another stored document proves the storage is intact: make one that is scanned clean.
    expect((await review.scanRequestDocument((await rawDocument(r)).id)).scanStatus).toBe('clean');
    const doc = await rawDocument(r);
    fs.rmSync(path.join(UPLOAD_DIR, doc.storageKey));
    expect((await review.scanRequestDocument(doc.id)).scanStatus).toBe('failed');
  });
});

describe('a request needs at least one document to be submitted', () => {
  it('is only a draft until a document is uploaded: not submitted, not listed, not approvable', async () => {
    const r = await newRequest();
    expect(r.res.body.request).toMatchObject({ reviewStatus: 'awaiting_documents', submittedAt: null });
    const list = await adminGet('/admin/requests?limit=200');
    expect(list.body.requests.some((x) => x.id === r.id)).toBe(false);
    const drafts = await adminGet('/admin/requests?status=awaiting_documents&limit=200');
    expect(drafts.body.requests.some((x) => x.id === r.id)).toBe(true);
    const approval = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(approval.status).toBe(409);
    expect(approval.body.blockers.map((b) => b.code)).toEqual(['no_documents']);
    expect(await caseOf(r.id)).toBeNull();
  });

  it('becomes a submission with its first document, and is then visible to Admin', async () => {
    const r = await newRequest();
    await upload(r.token, r.id);
    const saved = await prisma.serviceRequest.findUnique({ where: { id: r.id } });
    expect(saved.reviewStatus).toBe('in_review');
    expect(saved.submittedAt).toBeTruthy();
    const list = await adminGet('/admin/requests?limit=200');
    expect(list.body.requests.find((x) => x.id === r.id)).toMatchObject({ reviewStatus: 'in_review', documents: { current: 1 } });
  });

  it('stays visible while its documents wait for a scan, for review, or after they fail the scan', async () => {
    const waiting = await newRequest();
    process.env.CLAMAV_PORT = String(await unusedPort());
    await upload(waiting.token, waiting.id);
    process.env.CLAMAV_PORT = String(clamd.port);
    const infected = await newRequest();
    await upload(infected.token, infected.id, { content: EICAR });
    const reviewing = await newRequest();
    await upload(reviewing.token, reviewing.id);
    const byId = Object.fromEntries((await adminGet('/admin/requests?limit=200')).body.requests.map((x) => [x.id, x]));
    expect(byId[waiting.id]).toMatchObject({ reviewStatus: 'in_review', documents: { awaitingScan: 1 } });
    expect(byId[infected.id]).toMatchObject({ reviewStatus: 'in_review', documents: { infected: 1 } });
    expect(byId[reviewing.id]).toMatchObject({ reviewStatus: 'in_review', documents: { awaitingReview: 1 } });
  });

  it('counts failed scans separately (scanErrors) while awaitingScan keeps counting them too', async () => {
    const failed = await newRequest();
    process.env.CLAMAV_PORT = String(await unusedPort());
    await upload(failed.token, failed.id); // the scanner is down: the scan fails
    process.env.CLAMAV_PORT = String(clamd.port);
    const unscanned = await newRequest();
    const doc = await upload(unscanned.token, unscanned.id);
    await prisma.requestDocument.update({ where: { id: doc.body.document.id }, data: { scanStatus: 'pending', scannedAt: null } });
    const clean = await newRequest();
    await upload(clean.token, clean.id);

    const byId = Object.fromEntries((await adminGet('/admin/requests?limit=200')).body.requests.map((x) => [x.id, x]));
    expect(byId[failed.id].documents).toMatchObject({ awaitingScan: 1, scanErrors: 1 });
    expect(byId[unscanned.id].documents).toMatchObject({ awaitingScan: 1, scanErrors: 0 });
    expect(byId[clean.id].documents).toMatchObject({ awaitingScan: 0, scanErrors: 0 });
    // The detail view reads the same summary, and the other fields are all still there.
    const detail = (await adminGet(`/admin/requests/${failed.id}`)).body.request.documentSummary;
    expect(detail).toEqual({ current: 1, awaitingScan: 1, scanErrors: 1, scanFailed: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 0 });
  });

  it('allows further documents when Admin asks, and replacements for rejected ones, on the same request', async () => {
    const r = await newRequest();
    const first = await upload(r.token, r.id, { name: 'one.pdf' });
    await adminPost(`/admin/requests/${r.id}/request-documents`, { reason: 'Please add the fitness-to-fly certificate.' });
    const extra = await upload(r.token, r.id, { name: 'fitness.pdf' });
    expect(extra.status).toBe(201);
    await adminPost(`/admin/requests/${r.id}/documents/${first.body.document.id}/review`, { decision: 'rejected', reason: 'Please resend a clearer copy.' });
    const replacement = await upload(r.token, r.id, { name: 'one-clear.pdf', replaces: first.body.document.id });
    expect(replacement.status).toBe(201);
    expect(await prisma.serviceRequest.count({ where: { userId: r.user.id } })).toBe(1);
    expect(await prisma.requestDocument.count({ where: { serviceRequestId: r.id } })).toBe(3);
  });
});

describe('small hardening', () => {
  it('cuts off a scanner that keeps the connection busy: one total deadline', async () => {
    clamd.setMode('drip');
    const started = Date.now();
    const result = await scanFile(path.join(__dirname, 'request-review.test.js'), { host: '127.0.0.1', port: clamd.port, timeoutMs: 400 });
    expect(result.status).toBe('error');
    expect(result.detail).toMatch(/deadline exceeded/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('bounds the stored name and key of a very long file name, and the whole flow still works', async () => {
    const r = await newRequest();
    const up = await upload(r.token, r.id, { name: `${'a'.repeat(400)}.pdf` });
    expect(up.status).toBe(201);
    const row = await prisma.requestDocument.findUnique({ where: { id: up.body.document.id } });
    expect(row.storageKey.length).toBeLessThanOrEqual(134);
    expect(row.storageKey.endsWith('.pdf')).toBe(true);
    expect(row.originalName.length).toBeLessThanOrEqual(191);
    expect(row.originalName.endsWith('.pdf')).toBe(true);
    await approveDocument(r.id, row.id);
    const approval = await adminPost(`/admin/requests/${r.id}/approve`);
    expect(approval.status).toBe(201);
    const [copied] = await prisma.document.findMany({ where: { caseId: approval.body.case.id } });
    expect(copied.fileUrl.length).toBeLessThanOrEqual(191);
  });

  it('stores a display name without control characters or path separators', () => {
    expect(cleanOriginalName('a\u0000b\r\nc\\d/e.pdf')).toBe('abcde.pdf');
    expect(cleanOriginalName('   ')).toBe('document');
    expect(cleanOriginalName(undefined)).toBe('document');
    const long = cleanOriginalName(`${'x'.repeat(500)}.pdf`);
    expect(long.length).toBe(191);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  it('keeps permanently failing documents from starving newer ones', async () => {
    await drainScans();
    const r = await newRequest();
    const failing = [];
    for (let i = 0; i < 12; i += 1) {
      const row = await prisma.requestDocument.create({
        data: {
          serviceRequestId: r.id, originalName: `gone-${i}.pdf`, storageKey: `gone-${Date.now()}-${i}.pdf`, sizeBytes: 5, sha256: sha('gone'),
          uploadedByUserId: r.user.id, scanStatus: 'error', scannedAt: new Date(Date.UTC(2020, 0, 1 + i)),
          // A failed attempt leaves a retry time (past here, so they are due), oldest first; documents never scanned have none.
          scanAttempts: 1, scanNextAttemptAt: new Date(Date.UTC(2020, 0, 1 + i)),
        },
      });
      failing.push(row.id);
    }
    const fresh = await rawDocument(r);
    const retriedIds = async () => (await prisma.requestDocument.findMany({ where: { id: { in: failing } } })).filter((d) => d.scannedAt > new Date('2021-01-01')).map((d) => d.id).sort((a, b) => a - b);

    expect((await review.sweepPendingScans({ limit: 5 })).checked).toBe(5);
    expect((await prisma.requestDocument.findUnique({ where: { id: fresh.id } })).scanStatus).toBe('clean'); // never waited behind them
    expect(await retriedIds()).toEqual(failing.slice(0, 4)); // then the longest-waiting failures, oldest attempt first
    await review.sweepPendingScans({ limit: 5 });
    expect(await retriedIds()).toEqual(failing.slice(0, 9)); // the next sweep moves on, not back to the same ones
  });

  it('saves a scan verdict and its audit event together: if the event fails, nothing is recorded and it is retried', async () => {
    await drainScans();
    const r = await newRequest();
    const doc = await rawDocument(r);
    const realTransaction = prisma.$transaction.bind(prisma);
    const failOnce = () => jest.spyOn(prisma, '$transaction').mockImplementationOnce((fn, options) => realTransaction(
      (tx) => fn(new Proxy(tx, { get: (target, key) => (key === 'requestEvent' ? { create: () => Promise.reject(new Error('disk full')) } : target[key]) })),
      options,
    ));
    const spy = failOnce();
    await expect(review.scanRequestDocument(doc.id)).rejects.toThrow('disk full');
    spy.mockRestore();
    const stuck = await prisma.requestDocument.findUnique({ where: { id: doc.id } });
    expect(stuck).toMatchObject({ scanStatus: 'pending', scannedAt: null });
    expect(await prisma.requestEvent.count({ where: { documentId: doc.id } })).toBe(0);

    // The failed save left the document leased to the cut-off attempt: an immediate retry is refused, one after the lease runs out scans it.
    await review.scanRequestDocument(doc.id);
    expect((await prisma.requestDocument.findUnique({ where: { id: doc.id } })).scanStatus).toBe('pending');
    await review.scanRequestDocument(doc.id, { clock: () => Date.now() + SCAN_RETRY.leaseMs + 1000 });
    expect((await prisma.requestDocument.findUnique({ where: { id: doc.id } })).scanStatus).toBe('clean');
    expect((await eventsOf(r.id)).filter((e) => e.documentId === doc.id).map((e) => e.action)).toEqual(['scan_clean']);
  });

  it('a document that cannot be recorded does not stop the sweep from scanning the others', async () => {
    await drainScans();
    const r = await newRequest();
    const first = await rawDocument(r);
    const second = await rawDocument(r);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const realTransaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((fn, options) => realTransaction(
      (tx) => fn(new Proxy(tx, { get: (target, key) => (key === 'requestEvent' ? { create: () => Promise.reject(new Error('disk full')) } : target[key]) })),
      options,
    ));
    const result = await review.sweepPendingScans({ limit: 50 });
    spy.mockRestore();
    quiet.mockRestore();
    // Older documents left in "error" by earlier cases are retried in the same sweep and may now be clean,
    // so the count is a lower bound; what matters is the two documents below.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect((await prisma.requestDocument.findUnique({ where: { id: first.id } })).scanStatus).toBe('pending');
    expect((await prisma.requestDocument.findUnique({ where: { id: second.id } })).scanStatus).toBe('clean');
  });
});
