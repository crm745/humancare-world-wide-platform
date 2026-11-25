// Mortal Remains (single key "mortal") end to end: submission and what is stored, the six scope and mode combinations, the Case, retrieval, the
// summary PDF, the Bitrix lead it produces (Bitrix itself is not changed), uploads (neutral type, 10-file cap, content check, never sent to Bitrix,
// not even by the retry sweep), downloads (nosniff, ownership) and older stored requests. Needs the test database, like requests.test.js. The rules
// themselves are tested without a database in mortal-remains-validation.test.js.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient, createCorporateUserAndLogin } = require('./helpers');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { createLead, sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
const { retryFailedBitrixSyncs } = require('../src/modules/bitrix/bitrix-retry.service');
const { buildLeadFields, leadInputFromRequest } = require('../src/modules/bitrix/bitrix-lead');
const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');
const { SCOPES, MODES } = require('../src/modules/requests/mortal-remains.validation');

afterAll(async () => {
  await prisma.$disconnect();
});

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const body = (extra = {}) => ({
  serviceType: 'Mortal Remains Transportation',
  serviceKey: 'mortal',
  transferScope: 'international',
  transportMode: 'private_charter',
  patientName: 'Suresh Kale',
  patientAge: 0,
  patientGender: 'Male',
  deceasedRelation: 'Brother',
  placeOfDeath: 'Rashid Hospital, Dubai',
  dateOfDeath: inDays(-2),
  country: 'India',
  origin: 'Dubai, United Arab Emirates',
  destination: 'Pune, India',
  patientContact: '+91 98765 43210',
  preferredDate: inDays(3),
  details: 'Please arrange a hearse at the airport.',
  urgency: 'urgent_24h',
  utcOffsetMinutes: 0,
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const pdf = (name, contentType = 'application/pdf', content = '%PDF-1.4 test') => ({ buffer: Buffer.from(content), filename: name, contentType });
const upload = (token, id, file) => request(app).post(`/requests/me/${id}/documents`).set('Authorization', `Bearer ${token}`)
  .attach('file', file.buffer, { filename: file.filename, contentType: file.contentType });
const uploadsOnDisk = () => new Set(fs.readdirSync(UPLOAD_DIR));

describe('submitting a Mortal Remains request', () => {
  it('stores every field in the right column for all six scope and mode combinations', async () => {
    const { token } = await createPatient();
    for (const transferScope of Object.keys(SCOPES)) {
      for (const transportMode of Object.keys(MODES)) {
        const res = await post(token, body({ transferScope, transportMode }));
        expect(res.status).toBe(201);
        expect(res.body.request).toMatchObject({ serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', transferScope, transportMode });
        const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
        expect(saved).toMatchObject({
          serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', transferScope, transportMode,
          patientName: 'Suresh Kale', patientAge: 0, patientGender: 'Male', deceasedRelation: 'Brother', placeOfDeath: 'Rashid Hospital, Dubai',
          country: 'India', origin: 'Dubai, United Arab Emirates', patientLocation: 'Dubai, United Arab Emirates', destination: 'Pune, India',
          patientContact: '+91 98765 43210', urgency: 'urgent_24h',
          description: `Transfer Scope: ${SCOPES[transferScope]}\nTransport Mode: ${MODES[transportMode]}\n\nAdditional Details: Please arrange a hearse at the airport.`,
        });
        expect(saved.dateOfDeath.toISOString().slice(0, 10)).toBe(inDays(-2));
        expect(saved.preferredDate.toISOString().slice(0, 10)).toBe(inDays(3));
        expect(saved.mobility).toBeNull();
      }
    }
  });

  it('creates the Case like any request, and returns the two new fields on every read', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    expect(created.status).toBe(201);
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: true } });
    expect(row.case).toMatchObject({ patientName: 'Suresh Kale', patientAge: 0, origin: 'Dubai, United Arab Emirates', destination: 'Pune, India', country: 'India' });
    const list = await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`);
    expect(list.body.requests[0]).toMatchObject({ transferScope: 'international', transportMode: 'private_charter' });
    const one = await request(app).get(`/requests/me/${created.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request).toMatchObject({ transferScope: 'international', transportMode: 'private_charter', patientAge: 0 });
  });

  it('without Details the description holds only the scope and mode', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ details: undefined }));
    expect(res.status).toBe(201);
    expect(res.body.request.description).toBe('Transfer Scope: International\nTransport Mode: Private Charter');
  });

  it('refuses a bad request with a 400, saves nothing, and never fails with a 500 on over-long text', async () => {
    const { token, user } = await createPatient();
    const bad = [
      body({ transferScope: 'both' }), body({ transportMode: undefined }), body({ patientAge: 130 }), body({ patientGender: 'x' }),
      body({ deceasedRelation: 'Cousin' }), body({ patientContact: '9876543210' }), body({ urgency: undefined }), body({ utcOffsetMinutes: undefined }),
      body({ dateOfDeath: inDays(5) }), body({ preferredDate: inDays(-5) }), body({ placeOfDeath: 'x'.repeat(192) }), body({ origin: 'x'.repeat(5000) }),
      body({ destination: 'x'.repeat(192) }), body({ details: 'x'.repeat(2001) }), body({ description: 'forged' }), body({ patientLocation: 'forged' }),
      body({ serviceKey: 'mortal_domestic' }), body({ serviceKey: 'mortal_international' }), body({ serviceType: 'Mortal Remains Transportation — International' }),
    ];
    for (const payload of bad) {
      const res = await post(token, payload);
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
    expect(await prisma.serviceRequest.count({ where: { userId: user.id } })).toBe(0);
  });

  it('does not change what other services store: no scope or mode, same description', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai', description: 'Needs oxygen' });
    expect(res.status).toBe(201);
    const saved = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(saved).toMatchObject({ transferScope: null, transportMode: null, description: 'Needs oxygen' });
  });
});

describe('the summary PDF', () => {
  it('prints the label "Deceased Person\'s Name", the scope and mode as rows, and only the user\'s own Details', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: { include: { stageEvents: true } } } });
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, "Deceased Person's Name:")).toBe('Suresh Kale');
    expect(valueAfter(lines, 'Transfer scope:')).toBe('International');
    expect(valueAfter(lines, 'Transport mode:')).toBe('Private Charter');
    expect(valueAfter(lines, 'Service:')).toBe('Mortal Remains Transportation');
    expect(valueAfter(lines, 'Details:')).toBe('Please arrange a hearse at the airport.');
    expect(lines.join('\n')).not.toMatch(/Additional Details|Transfer Scope:/);
  });

  it('prints no Details row when there are none, and still reads an older request', async () => {
    const { token } = await createPatient();
    const created = await post(token, body({ details: undefined }));
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id } });
    expect(await renderPdfLines(row)).not.toContain('Details:');
    const old = { ...row, serviceKey: 'mortal_domestic', serviceType: 'Mortal Remains Transportation — Within India', transferScope: null, transportMode: null, description: 'Transfer to the hometown' };
    const lines = await renderPdfLines(old);
    expect(valueAfter(lines, "Deceased Person's Name:")).toBe('Suresh Kale');
    expect(valueAfter(lines, 'Details:')).toBe('Transfer to the hometown');
    expect(lines).not.toContain('Transfer scope:');
  });
});

describe('what Bitrix receives (the integration itself is unchanged)', () => {
  afterEach(() => { delete process.env.BITRIX_SYNC_ENABLED; });

  it('builds a Mortal Remains lead (service 2828, the existing title) whose Requirement comment carries the scope and mode', async () => {
    createLead.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    expect(createLead).toHaveBeenCalledTimes(1);
    const fields = buildLeadFields(createLead.mock.calls[0][0]);
    expect(createLead.mock.calls[0][0]).toMatchObject({ serviceKey: 'mortal', origin: 'Dubai, United Arab Emirates', destination: 'Pune, India', deceasedName: 'Suresh Kale' });
    expect(fields.TITLE).toBe('Dubai, United Arab Emirates to Pune, India');
    expect(JSON.stringify(fields)).toMatch(/2828/);
    expect(JSON.stringify(fields.COMMENTS)).toMatch(/Requirement: Transfer Scope: International/);
    expect(JSON.stringify(fields.COMMENTS)).toMatch(/Transport Mode: Private Charter/);
    expect(JSON.stringify(fields.COMMENTS)).toMatch(/Additional Details: Please arrange a hearse at the airport\./);
  });

  it('a retry rebuilds the same lead from the stored request', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id }, include: { user: true } });
    const first = buildLeadFields(leadInputFromRequest(row, row.user));
    const again = buildLeadFields(leadInputFromRequest(row, row.user));
    expect(again).toEqual(first);
  });
});

describe('Mortal Remains documents', () => {
  afterEach(() => { delete process.env.BITRIX_SYNC_ENABLED; });

  it('stores every upload as a Supporting Document, whatever it is called', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    for (const name of ['death-certificate.pdf', 'passport.pdf', 'letter.pdf']) {
      const res = await upload(token, created.body.request.id, pdf(name));
      expect(res.status).toBe(201);
      expect(res.body.document.type).toBe('Supporting Document');
    }
    const docs = await prisma.document.findMany({ where: { case: { serviceRequestId: created.body.request.id } } });
    expect(docs.map((d) => d.type)).toEqual(['Supporting Document', 'Supporting Document', 'Supporting Document']);
  });

  it('accepts every allowed format with matching content', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    const files = [
      pdf('a.pdf'),
      { buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]), filename: 'a.jpg', contentType: 'image/jpeg' },
      { buffer: png, filename: 'a.png', contentType: 'image/png' },
      { buffer: Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]), filename: 'a.webp', contentType: 'image/webp' },
      { buffer: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(8)]), filename: 'a.doc', contentType: 'application/msword' },
      { buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]), filename: 'a.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ];
    for (const file of files) expect((await upload(token, created.body.request.id, file)).status).toBe(201);
  });

  it('refuses a file whose content is not what it claims, and leaves nothing on disk or in the database', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const before = uploadsOnDisk();
    const spoofed = [
      pdf('virus.pdf', 'application/pdf', '<html><script>alert(1)</script></html>'),
      pdf('photo.jpg', 'image/jpeg', '%PDF-1.4 this is a pdf named jpg'),
      pdf('empty.pdf', 'application/pdf', ''),
    ];
    for (const file of spoofed) {
      const res = await upload(token, created.body.request.id, file);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/content does not match/i);
    }
    expect(await prisma.document.count({ where: { case: { serviceRequestId: created.body.request.id } } })).toBe(0);
    expect([...uploadsOnDisk()].filter((name) => !before.has(name))).toEqual([]);
  });

  it('refuses the 11th file, discards it, and keeps the first ten', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    for (let i = 1; i <= 10; i += 1) expect((await upload(token, created.body.request.id, pdf(`doc-${i}.pdf`))).status).toBe(201);
    const before = uploadsOnDisk();
    const eleventh = await upload(token, created.body.request.id, pdf('doc-11.pdf'));
    expect(eleventh.status).toBe(400);
    expect(eleventh.body.error).toMatch(/at most 10/);
    expect(await prisma.document.count({ where: { case: { serviceRequestId: created.body.request.id } } })).toBe(10);
    expect([...uploadsOnDisk()].filter((name) => !before.has(name))).toEqual([]);
  });

  it('refuses a file over 10 MB and a type that is not allowed', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const big = await upload(token, created.body.request.id, pdf('big.pdf', 'application/pdf', `%PDF-${'x'.repeat(10 * 1024 * 1024)}`));
    expect(big.status).toBeGreaterThanOrEqual(400);
    expect(big.status).toBeLessThan(500);
    const exe = await upload(token, created.body.request.id, pdf('run.exe', 'application/x-msdownload', 'MZ'));
    expect(exe.status).toBeGreaterThanOrEqual(400);
    expect(exe.status).toBeLessThan(500);
    expect(await prisma.document.count({ where: { case: { serviceRequestId: created.body.request.id } } })).toBe(0);
  });

  it('never sends a Mortal Remains document to Bitrix, by the upload or by the retry sweep', async () => {
    sendMedicalReportToBitrix.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const created = await post(token, body());
    const id = created.body.request.id;
    expect((await upload(token, id, pdf('mortal-sweep-check.pdf'))).status).toBe(201);
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();

    // Make the request a retry candidate (its first lead creation "failed" an hour ago) and run the sweep.
    await prisma.serviceRequest.update({
      where: { id }, data: { bitrixLeadId: null, bitrixSyncAttempts: 1, bitrixSyncFailedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await retryFailedBitrixSyncs();
    const sent = sendMedicalReportToBitrix.mock.calls.map((call) => call[1] && call[1].name);
    expect(sent).not.toContain('mortal-sweep-check.pdf');
  });

  it('still sends another service\'s medical report to Bitrix as before', async () => {
    sendMedicalReportToBitrix.mockClear();
    process.env.BITRIX_SYNC_ENABLED = 'true';
    const { token } = await createPatient();
    const created = await post(token, { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai' });
    const res = await upload(token, created.body.request.id, pdf('discharge.pdf'));
    expect(res.status).toBe(201);
    expect(res.body.document.type).toBe('Medical Report');
    expect(sendMedicalReportToBitrix).toHaveBeenCalledTimes(1);
  });

  it('does not apply the Mortal Remains content check to other services (their uploads are unchanged)', async () => {
    const { token } = await createPatient();
    const created = await post(token, { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai' });
    const res = await upload(token, created.body.request.id, pdf('anything.pdf', 'application/pdf', 'not really a pdf'));
    expect(res.status).toBe(201);
  });

  it('treats an older stored Mortal Remains request (older key) the same way', async () => {
    const { token, user } = await createPatient();
    const created = await post(token, body());
    await prisma.serviceRequest.update({ where: { id: created.body.request.id }, data: { serviceKey: 'mortal_domestic', transferScope: null, transportMode: null } });
    expect(user.id).toBeDefined();
    sendMedicalReportToBitrix.mockClear();
    const res = await upload(token, created.body.request.id, pdf('old.pdf'));
    expect(res.status).toBe(201);
    expect(res.body.document.type).toBe('Supporting Document');
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
  });
});

describe('downloads (shared by every service)', () => {
  it('sends X-Content-Type-Options: nosniff, and the file, to the owner', async () => {
    const { token } = await createPatient();
    const created = await post(token, body());
    const uploaded = await upload(token, created.body.request.id, pdf('cert.pdf'));
    const res = await request(app).get(`/documents/${uploaded.body.document.id}/file`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.toString()).toContain('%PDF-1.4');
  });

  it('still downloads another service\'s document, with the same header', async () => {
    const { token } = await createPatient();
    const created = await post(token, { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai' });
    const uploaded = await upload(token, created.body.request.id, pdf('report.pdf'));
    const res = await request(app).get(`/documents/${uploaded.body.document.id}/file`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('gives another patient and an unrelated corporate a 404, not the file', async () => {
    const owner = await createPatient();
    const other = await createPatient();
    const corporate = await createCorporateUserAndLogin();
    const created = await post(owner.token, body());
    const uploaded = await upload(owner.token, created.body.request.id, pdf('cert.pdf'));
    const url = `/documents/${uploaded.body.document.id}/file`;
    expect((await request(app).get(url).set('Authorization', `Bearer ${other.token}`)).status).toBe(404);
    expect((await request(app).get(url).set('Authorization', `Bearer ${corporate.token}`)).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(401);
  });

  it('refuses an upload to someone else\'s request and leaves no file behind', async () => {
    const owner = await createPatient();
    const other = await createPatient();
    const created = await post(owner.token, body());
    const before = uploadsOnDisk();
    const res = await upload(other.token, created.body.request.id, pdf('intruder.pdf'));
    expect(res.status).toBe(404);
    expect([...uploadsOnDisk()].filter((name) => !before.has(name))).toEqual([]);
    expect(path.basename(UPLOAD_DIR)).toBeTruthy();
  });
});
