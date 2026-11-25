/* global describe, test, expect, beforeEach, afterAll, jest */
// Legacy document scan protection: the Bitrix24 sender and its retry sweep, the corporate / owner download gate, and the backfill worker. No database, no network, no real ClamAV, no real
// Bitrix24: Prisma is a recorder, fetch is a counter, the scanner is a stub, and every file is a temporary one. Run with jest.safe.config.js.
process.env.BITRIX_SYNC_ENABLED = 'true';
process.env.BITRIX24_WEBHOOK_URL = 'https://bitrix.example.invalid/rest/1/token/';
delete process.env.LEGACY_DOCUMENT_OWNER_GATE;

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

jest.mock('../../src/middleware/upload.middleware', () => {
  const nodeFs = require('fs');
  const nodeOs = require('os');
  const nodePath = require('path');
  return { upload: {}, UPLOAD_DIR: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hc-legacy-scan-')) };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({ scanFile: jest.fn(), ping: jest.fn(async () => true), ENGINE: 'clamav', settings: () => ({}) }));
jest.mock('../../src/db/prisma', () => {
  const state = { documents: [], serviceRequests: [], cases: [], workflowSources: [], updates: [] };
  const prisma = {
    __state: state,
    document: { findUnique: jest.fn(async ({ where }) => { const row = state.documents.find((d) => d.id === where.id); return row ? { ...row } : null; }) },
    requestDocument: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    serviceRequest: { findMany: jest.fn(async () => state.serviceRequests), update: jest.fn(async ({ data }) => { state.updates.push(['request', data]); return {}; }) },
    case: { findMany: jest.fn(async () => state.cases), update: jest.fn(async ({ data }) => { state.updates.push(['case', data]); return {}; }) },
  };
  return { prisma };
});

const { prisma } = require('../../src/db/prisma');
const clamav = require('../../src/integrations/clamav/clamav');
const { UPLOAD_DIR } = require('../../src/middleware/upload.middleware');
const { sendMedicalReportToBitrix, attachMedicalReport } = require('../../src/modules/bitrix/bitrix.service');
const { retryFailedBitrixSyncs } = require('../../src/modules/bitrix/bitrix-retry.service');
const { downloadDocument } = require('../../src/modules/documents/documents.controller');
const { isScanClean, isKnownUnsafe, ownerDownloadGateEnabled, cleanScanRecord } = require('../../src/modules/documents/document-scan');
const { backfillLegacyDocuments, MAX_ATTEMPTS, BACKOFF_MINUTES, LEASE_MINUTES } = require('../../src/modules/documents/legacy-backfill');

const state = prisma.__state;
const QUARANTINE = path.join(UPLOAD_DIR, 'quarantine');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const writeUpload = (name, body = '%PDF-1.4 legacy report') => { fs.writeFileSync(path.join(UPLOAD_DIR, name), body); return body; };
afterAll(() => { try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch { /* gone */ } });

// ---- Bitrix24: a fake CRM that counts what it is sent -------------------------------------------------------------------------------------------------------------------------------
const crm = { calls: [] };
beforeEach(() => {
  crm.calls = [];
  global.fetch = jest.fn(async (url, init) => {
    const method = String(url).replace(/^.*\//, '').replace(/\.json$/, '');
    const body = JSON.parse(init.body);
    crm.calls.push({ method, body });
    const result = method === 'crm.lead.add' ? 555 : method === 'crm.lead.get' ? {} : true;
    return { ok: true, status: 200, json: async () => ({ result }) };
  });
  state.documents.length = 0; state.serviceRequests.length = 0; state.cases.length = 0; state.updates.length = 0;
  prisma.requestDocument.findFirst.mockImplementation(async () => null);
  clamav.scanFile.mockReset();
  clamav.ping.mockReset();
  clamav.ping.mockImplementation(async () => true);
  delete process.env.LEGACY_DOCUMENT_OWNER_GATE;
});
const uploadsOf = () => crm.calls.filter((c) => c.method === 'crm.lead.update');

describe('the scan record', () => {
  test('only "clean" is clean; NULL, pending, infected, error and failed are not; infected and failed are never served', () => {
    expect(isScanClean({ scanStatus: 'clean' })).toBe(true);
    for (const status of [null, undefined, 'pending', 'infected', 'error', 'failed', 'CLEAN', '']) expect(isScanClean({ scanStatus: status })).toBe(false);
    expect(isScanClean(null)).toBe(false);
    expect(isKnownUnsafe({ scanStatus: 'infected' })).toBe(true);
    expect(isKnownUnsafe({ scanStatus: 'failed' })).toBe(true);
    for (const status of [null, 'pending', 'error', 'clean']) expect(isKnownUnsafe({ scanStatus: status })).toBe(false);
  });

  test('a clean record needs the digest and the engine; the owner gate is on only for exactly "true"', () => {
    expect(cleanScanRecord({ sha256: sha('x'), engine: 'clamav', scannedAt: new Date(5) })).toEqual({ sha256: sha('x'), scanStatus: 'clean', scanEngine: 'clamav', scannedAt: new Date(5) });
    expect(() => cleanScanRecord({ engine: 'clamav' })).toThrow();
    expect(() => cleanScanRecord({ sha256: sha('x') })).toThrow();
    expect(() => cleanScanRecord(null)).toThrow();
    expect(ownerDownloadGateEnabled({})).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', '', 'false']) expect(ownerDownloadGateEnabled({ LEGACY_DOCUMENT_OWNER_GATE: value })).toBe(false);
    expect(ownerDownloadGateEnabled({ LEGACY_DOCUMENT_OWNER_GATE: 'true' })).toBe(true);
  });
});

describe('Bitrix24: only a confirmed clean document is ever forwarded', () => {
  test('a clean document is sent (once), exactly as before', async () => {
    writeUpload('clean.pdf');
    const sent = await sendMedicalReportToBitrix(555, { id: 1, name: 'r.pdf', fileUrl: '/uploads/clean.pdf', scanStatus: 'clean' }, { comments: 'x' });
    expect(sent).toBe(true);
    expect(crm.calls.map((c) => c.method)).toEqual(['crm.lead.get', 'crm.lead.update']);
  });

  test.each([null, undefined, 'pending', 'infected', 'error', 'failed'])('a document whose scan status is %s is NOT sent: no file is read, no CRM call is made, and it is reported as not sent', async (status) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const read = jest.spyOn(fs.promises, 'readFile');
    const doc = { id: 2, name: 'secret-report.pdf', fileUrl: '/uploads/not-even-there.pdf', scanStatus: status };
    expect(await sendMedicalReportToBitrix(555, doc)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(warn.mock.calls.join(' ')).not.toContain('secret-report'); // the file name is not logged
    await expect(attachMedicalReport(555, doc)).rejects.toMatchObject({ code: 'document_not_scanned' }); // defence in depth: the lower function refuses too
    expect(global.fetch).not.toHaveBeenCalled();
    read.mockRestore();
    warn.mockRestore();
  });

  test('the retry sweep forwards only the clean reports, names only those in the lead comment, and does not count a skipped one as sent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    writeUpload('clean-1.pdf');
    writeUpload('clean-2.pdf');
    const reports = [
      { id: 1, name: 'clean-one.pdf', type: 'Medical Report', fileUrl: '/uploads/clean-1.pdf', scanStatus: 'clean' },
      { id: 2, name: 'legacy-unscanned.pdf', type: 'Medical Report', fileUrl: '/uploads/legacy.pdf', scanStatus: null },
      { id: 3, name: 'infected-one.pdf', type: 'Medical Report', fileUrl: '/uploads/inf.pdf', scanStatus: 'infected' },
      { id: 4, name: 'clean-two.pdf', type: 'Medical Report', fileUrl: '/uploads/clean-2.pdf', scanStatus: 'clean' },
    ];
    state.serviceRequests.push({
      id: 9, referenceNumber: 'REQ-1009', bitrixSyncAttempts: 1, user: { fullName: 'A B', email: 'a@example.invalid' }, patientName: 'A B', serviceType: 'Ground Ambulance', serviceKey: 'ground',
      origin: 'Pune', destination: 'Delhi', case: { documents: reports },
    });
    const retried = await retryFailedBitrixSyncs();
    expect(retried).toBe(1);
    const updates = uploadsOf();
    expect(updates).toHaveLength(2); // clean-one and clean-two, nothing else
    const sentNames = updates.map((u) => u.body.fields.UF_CRM_MEDICAL_REPORT?.fileData?.[0] || Object.values(u.body.fields).find((v) => v && v.fileData)?.fileData[0]);
    expect(sentNames.sort()).toEqual(['clean-one.pdf', 'clean-two.pdf']);
    const allSent = JSON.stringify(crm.calls);
    expect(allSent).not.toContain('legacy-unscanned');
    expect(allSent).not.toContain('infected-one');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/2 medical report\(s\) were NOT forwarded/);
    warn.mockRestore();
    console.log.mockRestore();
  });

  test('a sweep with only unscanned reports creates the lead and forwards no file at all', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    state.cases.push({ id: 3, referenceNumber: 'CASE-3', bitrixSyncAttempts: 2, patientName: 'C', serviceType: 'x', origin: 'a', destination: 'b', documents: [{ id: 7, name: 'old.pdf', type: 'Medical Report', fileUrl: '/uploads/old.pdf', scanStatus: null }] });
    await retryFailedBitrixSyncs();
    expect(crm.calls.map((c) => c.method)).toEqual(['crm.lead.add']);
    console.warn.mockRestore();
    console.log.mockRestore();
  });

  test('the source: the shared sender and the sweep both import the one gate; no other module sends a file to Bitrix24', () => {
    const root = path.join(__dirname, '../../src');
    expect(fs.readFileSync(path.join(root, 'modules/bitrix/bitrix.service.js'), 'utf8')).toContain("require('../documents/document-scan')");
    expect(fs.readFileSync(path.join(root, 'modules/bitrix/bitrix-retry.service.js'), 'utf8')).toContain('allReports.filter(isScanClean)');
    const callers = [];
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.js$/.test(entry.name) && /attachMedicalReport\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(path.relative(root, full).split(path.sep).join('/')); } };
    walk(root);
    expect(callers.sort()).toEqual(['modules/bitrix/bitrix.service.js']);
  });
});

// ---- downloads ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe('legacy document downloads', () => {
  const PATIENT = { id: 7, role: 'patient' };
  const OTHER_PATIENT = { id: 8, role: 'patient' };
  const CORPORATE = { id: 40, role: 'corporate', corporateId: 5 };
  const patientCase = { corporateId: 5, serviceRequest: { userId: 7 } }; // a patient's Case that was given to corporate 5
  const corporateCase = { corporateId: 5, serviceRequest: null }; // a Case the corporate created itself

  async function download(user, doc) {
    state.documents.length = 0;
    state.documents.push({ id: 1, name: 'r.pdf', fileUrl: '/uploads/legacy-file.pdf', ...doc });
    const out = { downloaded: null };
    // The controller streams the stored file through the storage service (storage/respond.js sendStoredFile): the file is real, in the uploads folder, and the response is a real stream.
    writeUpload('legacy-file.pdf');
    const { Writable } = require('stream');
    let attachedName = null;
    const res = Object.assign(new Writable({ write(_chunk, _enc, done) { done(); } }), {
      set() { return this; }, type() { return this; }, send() { return this; }, status() { return this; }, json() { return this; },
      attachment(name) { attachedName = name; return this; },
    });
    await downloadDocument({ params: { id: 1 }, user }, res, (err) => { out.err = err; });
    if (!out.err) out.downloaded = { file: 'legacy-file.pdf', name: attachedName };
    return out;
  }
  const refusal = (out) => out.err && (out.err.publicCode || out.err.statusCode);

  test('a corporate holding a PATIENT\'s Case is served only a clean document: NULL, pending, error, failed and infected are all refused', async () => {
    for (const status of [null, 'pending', 'error', 'failed', 'infected']) {
      const out = await download(CORPORATE, { case: patientCase, scanStatus: status });
      expect(out.downloaded).toBeNull();
      expect(out.err.statusCode).toBe(409);
      expect(out.err.publicCode).toBe(status === 'failed' || status === 'infected' ? 'document_not_clean' : 'document_not_scanned');
    }
    const clean = await download(CORPORATE, { case: patientCase, scanStatus: 'clean' });
    expect(clean.err).toBeUndefined();
    expect(clean.downloaded.name).toBe('r.pdf');
  });

  test('the patient who owns the request keeps their OWN older, never-scanned documents for now (the approved temporary behaviour)', async () => {
    for (const status of [null, 'pending', 'error']) {
      const out = await download(PATIENT, { case: patientCase, scanStatus: status });
      expect(out.err).toBeUndefined();
      expect(out.downloaded.file).toContain('legacy-file.pdf');
    }
    expect((await download(PATIENT, { case: patientCase, scanStatus: 'clean' })).err).toBeUndefined();
  });

  test('...but never one that is known infected or unusable, and never another patient\'s', async () => {
    for (const status of ['infected', 'failed']) expect(refusal(await download(PATIENT, { case: patientCase, scanStatus: status }))).toBe('document_not_clean');
    const stranger = await download(OTHER_PATIENT, { case: patientCase, scanStatus: 'clean' });
    expect(stranger.err.statusCode).toBe(404);
    expect(stranger.downloaded).toBeNull();
  });

  test('a corporate that created the Case itself is its owner: its own older documents stay available for now', async () => {
    expect((await download(CORPORATE, { case: corporateCase, scanStatus: null })).err).toBeUndefined();
    expect(refusal(await download(CORPORATE, { case: corporateCase, scanStatus: 'infected' }))).toBe('document_not_clean');
  });

  test('LEGACY_DOCUMENT_OWNER_GATE=true (after the backfill) requires a clean scan of owners too; it is off by default', async () => {
    expect((await download(PATIENT, { case: patientCase, scanStatus: null })).err).toBeUndefined(); // default: off
    process.env.LEGACY_DOCUMENT_OWNER_GATE = 'true';
    for (const status of [null, 'pending', 'error']) expect(refusal(await download(PATIENT, { case: patientCase, scanStatus: status }))).toBe('document_not_scanned');
    expect(refusal(await download(CORPORATE, { case: corporateCase, scanStatus: null }))).toBe('document_not_scanned');
    expect((await download(PATIENT, { case: patientCase, scanStatus: 'clean' })).err).toBeUndefined();
    process.env.LEGACY_DOCUMENT_OWNER_GATE = 'false';
    expect((await download(PATIENT, { case: patientCase, scanStatus: null })).err).toBeUndefined();
  });

  test('an admin token never reaches the route (requireAuth refuses it) and the administrators\' routes never read the legacy table', () => {
    const root = path.join(__dirname, '../../src');
    expect(fs.readFileSync(path.join(root, 'common/middleware/auth.middleware.js'), 'utf8')).toMatch(/payload\.role === 'admin'\) \{\s+return res\.status\(401\)/);
    const adminDir = path.join(root, 'modules/admin');
    for (const name of fs.readdirSync(adminDir).filter((f) => f.endsWith('.js'))) expect(fs.readFileSync(path.join(adminDir, name), 'utf8')).not.toMatch(/prisma\.document\.|documents\.service|document-scan/);
  });
});

// ---- the backfill -------------------------------------------------------------------------------------------------------------------------------------------------------------
function fakeDb(rows) {
  const db = { docs: rows.map((r) => ({ scanAttempts: 0, scanNextAttemptAt: null, scanStatus: null, sha256: null, ...r })), audit: [], failAudit: false, noAuditTable: false, noScanColumns: false, claimsLost: new Set() };
  const eq = (value, want) => (want === null ? value === null || value === undefined : value === want);
  const matches = (row, where) => Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => matches(row, w));
    const value = row[key];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('lt' in want) return value != null && value < want.lt;
      if ('lte' in want) return value != null && value <= want.lte;
      throw new Error(`unsupported where: ${JSON.stringify(want)}`);
    }
    return eq(value, want);
  });
  const forCase = (r) => ({ ...r, case: r.case || { id: r.caseId, referenceNumber: `CASE-${r.caseId}`, bitrixLeadId: null, serviceRequest: null } });
  db.document = {
    groupBy: async () => { const counts = new Map(); for (const r of db.docs) counts.set(r.scanStatus, (counts.get(r.scanStatus) || 0) + 1); return [...counts].map(([scanStatus, n]) => ({ scanStatus, _count: { _all: n } })); },
    findMany: async ({ where, take }) => db.docs.filter((r) => matches(r, where)).sort((a, b) => a.id - b.id).slice(0, take).map((r) => forCase({ ...r })),
    findFirst: async () => { if (db.noScanColumns) throw new Error('Unknown column scan_status'); return db.docs[0] || null; },
    updateMany: async ({ where, data }) => {
      if (db.claimsLost.has(where.id) && where.scanStatus !== 'pending') return { count: 0 };
      const row = db.docs.find((r) => r.id === where.id && eq(r.scanStatus, where.scanStatus) && r.scanAttempts === where.scanAttempts);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  db.auditLog = {
    findFirst: async () => { if (db.noAuditTable) throw new Error('Table audit_logs does not exist'); return null; },
    create: async ({ data }) => { if (db.failAudit) throw new Error('audit write failed'); db.audit.push(data); return data; },
  };
  db.$transaction = async (callback) => {
    const snapshot = db.docs.map((r) => ({ ...r }));
    const auditCount = db.audit.length;
    try { return await callback(db); } catch (err) { db.docs.splice(0, db.docs.length, ...snapshot); db.audit.length = auditCount; throw err; }
  };
  return db;
}

describe('the backfill worker', () => {
  let dir;
  let quarantineDir;
  let clock;
  const T0 = Date.UTC(2030, 0, 1, 12, 0, 0);
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-backfill-'));
    quarantineDir = path.join(dir, 'quarantine');
    clock = { t: T0 };
  });
  const put = (name, body) => { fs.writeFileSync(path.join(dir, name), body); return body; };
  const run = (db, extra = {}) => backfillLegacyDocuments({ db, execute: true, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: dir, quarantineDir, clock: () => clock.t, runId: 'run-1', ...extra });
  const snapshot = (db) => JSON.stringify([db.docs, db.audit]);
  const withLeadReport = { id: 1, caseId: 10, type: 'Medical Report', fileUrl: '/uploads/secret-name-one.pdf', case: { id: 10, referenceNumber: 'CASE-10', bitrixLeadId: null, serviceRequest: { id: 77, referenceNumber: 'REQ-1077', bitrixLeadId: 4321 } } };

  test('DRY RUN is read only: nothing is claimed, scanned, written or moved; it reports the counts and what each stored file looks like', async () => {
    put('present.pdf', 'AAAA');
    fs.mkdirSync(path.join(dir, 'unreadable.pdf')); // a directory where a file should be
    const db = fakeDb([
      { id: 1, caseId: 10, type: 'Medical Report', fileUrl: '/uploads/present.pdf' },
      { id: 2, caseId: 11, type: 'Medical Report', fileUrl: '/uploads/gone.pdf' },
      { id: 3, caseId: 12, type: 'Medical Report', fileUrl: '/uploads/unreadable.pdf' },
      { id: 4, caseId: 13, type: 'Medical Report', fileUrl: '/uploads/done.pdf', scanStatus: 'clean', sha256: sha('x') },
    ]);
    const before = snapshot(db);
    const report = await backfillLegacyDocuments({ db, execute: false, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: dir, quarantineDir, clock: () => clock.t });
    expect(snapshot(db)).toBe(before);
    expect(clamav.scanFile).not.toHaveBeenCalled();
    expect(fs.existsSync(quarantineDir)).toBe(false);
    expect(report).toMatchObject({ mode: 'dry-run', selected: 3, processed: 0, legacyRowsByStatus: { unscanned: 3, clean: 1 } });
    expect(report.items.map((i) => [i.documentId, i.file])).toEqual([[1, 'readable'], [2, 'missing'], [3, 'unreadable']]);
    expect(fs.existsSync(path.join(dir, 'present.pdf'))).toBe(true);
  });

  test('a clean file is recorded with its digest, engine and time, and ONE audit entry; reruns never rescan it', async () => {
    const body = put('secret-name-one.pdf', 'THE CLEAN REPORT');
    clamav.scanFile.mockResolvedValue({ status: 'clean' });
    const db = fakeDb([withLeadReport]);
    const report = await run(db);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'clean', sha256: sha(body), scanEngine: 'clamav', scanAttempts: 1, scanNextAttemptAt: null });
    expect(db.docs[0].scannedAt).toBeInstanceOf(Date);
    expect(report.outcomes).toMatchObject({ clean: 1, infected: 0, error: 0, failed: 0 });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ entityType: 'document', entityId: '1', action: 'legacy_document_scan', actorType: 'system', actorId: 'backfill', source: 'backfill', reasonCode: 'scan_clean', caseId: 10, correlationId: 'run-1' });
    expect(db.audit[0].beforeData).toEqual({ status: 'unscanned' });
    expect(db.audit[0].afterData).toEqual({ status: 'clean', caseId: 10 });
    clamav.scanFile.mockClear();
    const again = await run(db);
    expect(again.selected).toBe(0);
    expect(clamav.scanFile).not.toHaveBeenCalled();
    expect(db.audit).toHaveLength(1);
    expect(db.docs[0].scanAttempts).toBe(1); // a confirmed clean result is never overwritten
  });

  test('an infected file is recorded, MOVED to quarantine (never deleted), audited, and listed for Operations as probably forwarded to Bitrix24; no file name is in the report', async () => {
    const body = put('secret-name-one.pdf', 'EICAR-LIKE');
    clamav.scanFile.mockResolvedValue({ status: 'infected', signature: 'Eicar-Test-Signature' });
    const db = fakeDb([withLeadReport, { id: 2, caseId: 11, type: 'Medical Report', fileUrl: '/uploads/b.pdf', case: { id: 11, referenceNumber: 'CASE-11', bitrixLeadId: null, serviceRequest: null } }]);
    put('b.pdf', 'fine');
    clamav.scanFile.mockImplementation(async (file) => (file.endsWith('b.pdf') ? { status: 'clean' } : { status: 'infected', signature: 'Eicar-Test-Signature' }));
    const report = await run(db);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'infected', sha256: sha(body), scanEngine: 'clamav' });
    expect(fs.existsSync(path.join(dir, 'secret-name-one.pdf'))).toBe(false);
    expect(fs.readFileSync(path.join(quarantineDir, 'secret-name-one.pdf'), 'utf8')).toBe('EICAR-LIKE'); // moved, content intact
    expect(db.audit.find((a) => a.entityId === '1').reasonCode).toBe('scan_infected');
    expect(report.outcomes).toMatchObject({ infected: 1, clean: 1 });
    expect(report.infectedPossiblyForwardedToBitrix).toEqual([{ documentId: 1, caseReference: 'CASE-10', requestReference: 'REQ-1077', bitrixLeadId: 4321, signature: 'Eicar-Test-Signature' }]);
    const text = JSON.stringify(report);
    expect(text).not.toContain('secret-name-one');
    expect(report.items.find((i) => i.documentId === 1)).toMatchObject({ outcome: 'infected', quarantined: true, possiblyForwardedToBitrix: true });
    // final: an infected row is never selected again
    expect((await run(db)).selected).toBe(0);
  });

  test('a missing file (healthy storage) is "failed"; the same on an unavailable folder is a retry, not a failure; an unreadable one is "failed"', async () => {
    put('other.pdf', 'so the folder is clearly fine');
    fs.mkdirSync(path.join(dir, 'unreadable.pdf'));
    const db = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/gone.pdf' }, { id: 2, caseId: 2, fileUrl: '/uploads/unreadable.pdf' }]);
    const report = await run(db);
    expect(db.docs[0]).toMatchObject({ scanStatus: 'failed', scanDetail: 'the stored file is missing' });
    expect(db.docs[1].scanStatus).toBe('failed');
    expect(db.docs[1].scanDetail).toMatch(/cannot be read/);
    expect(report.outcomes.failed).toBe(2);
    expect(clamav.scanFile).not.toHaveBeenCalled(); // nothing that cannot be read is sent to the scanner
    expect(db.audit.map((a) => a.reasonCode)).toEqual(['scan_failed', 'scan_failed']);
    // storage that looks unavailable (the folder is empty or gone) must not fail valid documents for good
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-backfill-empty-'));
    const db2 = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/gone.pdf' }]);
    await backfillLegacyDocuments({ db: db2, execute: true, scanner: clamav.scanFile, ping: clamav.ping, uploadDir: empty, quarantineDir, clock: () => clock.t });
    expect(db2.docs[0].scanStatus).toBe('error');
    expect(db2.docs[0].scanNextAttemptAt.getTime()).toBe(T0 + BACKOFF_MINUTES[0] * 60000);
  });

  test('a scanner ERROR is retried with bounded backoff, becomes "failed" when the attempts are used up, and is selected again only when due', async () => {
    put('a.pdf', 'AAAA');
    clamav.scanFile.mockResolvedValue({ status: 'error', detail: 'scan timed out' });
    const db = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const report = await run(db);
      expect(report.outcomes.error).toBe(1);
      expect(db.docs[0]).toMatchObject({ scanStatus: 'error', scanAttempts: attempt, scanDetail: 'scan timed out' });
      expect(db.docs[0].scanNextAttemptAt.getTime()).toBe(clock.t + BACKOFF_MINUTES[attempt - 1] * 60000);
      expect((await run(db)).selected).toBe(0); // not due yet: nothing is selected, nothing is rescanned
      clock.t = db.docs[0].scanNextAttemptAt.getTime() + 1; // time passes
    }
    const last = await run(db);
    expect(last.outcomes.failed).toBe(1);
    expect(db.docs[0].scanStatus).toBe('failed');
    expect(db.docs[0].scanDetail).toMatch(/retries used up/);
    expect(clamav.scanFile).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect((await run(db)).selected).toBe(0); // final
  });

  test('when ClamAV itself is not answering the attempt is given back and the run STOPS without touching the other documents', async () => {
    put('a.pdf', 'AAAA');
    put('b.pdf', 'BBBB');
    clamav.scanFile.mockResolvedValue({ status: 'error', detail: 'cannot reach the scanner (ECONNREFUSED)' });
    clamav.ping.mockResolvedValue(false);
    const db = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }, { id: 2, caseId: 2, fileUrl: '/uploads/b.pdf' }]);
    const report = await run(db);
    expect(report.scannerUnavailable).toBe(true);
    expect(clamav.scanFile).toHaveBeenCalledTimes(1);
    expect(db.docs[0]).toMatchObject({ scanStatus: null, scanAttempts: 0, scanNextAttemptAt: null }); // exactly as it was
    expect(db.docs[1]).toMatchObject({ scanStatus: null, scanAttempts: 0 });
    expect(db.audit).toHaveLength(0);
  });

  test('"clean" must describe the bytes that are kept: a file that changes while it is scanned is an error, not clean', async () => {
    put('a.pdf', 'AAAA');
    clamav.scanFile.mockImplementation(async (file) => { fs.appendFileSync(file, 'tampered'); return { status: 'clean' }; });
    const db = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    await run(db);
    expect(db.docs[0].scanStatus).toBe('error');
    expect(db.docs[0].scanDetail).toMatch(/changed while it was being scanned/);
    expect(db.docs[0].sha256).toBeNull();
  });

  test('the claim is a compare-and-swap with a lease: a row another run took is skipped, an abandoned claim is picked up after its lease, a live one is left alone', async () => {
    put('a.pdf', 'AAAA');
    clamav.scanFile.mockResolvedValue({ status: 'clean' });
    const lost = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    lost.claimsLost.add(1);
    const skipped = await run(lost);
    expect(skipped.outcomes.skipped).toBe(1);
    expect(clamav.scanFile).not.toHaveBeenCalled();
    const live = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf', scanStatus: 'pending', scanAttempts: 1, scanNextAttemptAt: new Date(T0 + 60000) }]);
    expect((await run(live)).selected).toBe(0); // another run holds it
    clock.t = T0 + LEASE_MINUTES * 60000 + 120000; // its lease has run out (that run crashed)
    expect((await run(live)).outcomes.clean).toBe(1);
    expect(live.docs[0]).toMatchObject({ scanStatus: 'clean', scanAttempts: 2 });
  });

  test('the outcome and its audit entry are recorded TOGETHER: if the audit cannot be written, no verdict is recorded and the row is retried after its lease', async () => {
    put('a.pdf', 'AAAA');
    clamav.scanFile.mockResolvedValue({ status: 'clean' });
    const db = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    db.failAudit = true;
    const report = await run(db);
    expect(report.outcomes.skipped).toBe(1);
    expect(report.items[0].outcome).toBe('not recorded');
    expect(db.docs[0].scanStatus).toBe('pending'); // still claimed, never "clean" without its audit entry
    expect(db.docs[0].sha256).toBeNull();
    db.failAudit = false;
    clock.t += (LEASE_MINUTES + 1) * 60000;
    expect((await run(db)).outcomes.clean).toBe(1);
    expect(db.audit).toHaveLength(1);
  });

  test('a real run refuses to start when the scan columns or the audit table are missing, and touches nothing', async () => {
    const noAudit = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    noAudit.noAuditTable = true;
    expect((await run(noAudit)).aborted).toBe('audit_unavailable');
    const noColumns = fakeDb([{ id: 1, caseId: 1, fileUrl: '/uploads/a.pdf' }]);
    noColumns.noScanColumns = true;
    expect((await run(noColumns)).aborted).toBe('scan_columns_missing');
    for (const db of [noAudit, noColumns]) expect(db.docs[0]).toMatchObject({ scanStatus: null, scanAttempts: 0 });
    expect(clamav.scanFile).not.toHaveBeenCalled();
  });

  test('the --limit bounds a run, and a rerun carries on with the rest', async () => {
    for (const n of ['1', '2', '3']) put(`f${n}.pdf`, `body ${n}`);
    clamav.scanFile.mockResolvedValue({ status: 'clean' });
    const db = fakeDb([1, 2, 3].map((n) => ({ id: n, caseId: n, fileUrl: `/uploads/f${n}.pdf` })));
    expect((await run(db, { limit: 2 })).processed).toBe(2);
    expect((await run(db, { limit: 2 })).processed).toBe(1);
    expect((await run(db, { limit: 2 })).selected).toBe(0);
  });

  test('the command line: a dry run by default, a real run needs --execute AND the exact database name, nothing schedules it, and no real run is made here', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../scripts/backfill-legacy-document-scans.js'), 'utf8');
    expect(script).toContain("execute: false"); // the default
    expect(script).toContain('if (args.execute && args.confirmDatabase !== database)');
    expect(script).toContain("{ flag: 'wx' }"); // a report is never overwritten
    expect(script).toMatch(/--env-file is required/);
    const jobs = fs.readFileSync(path.join(__dirname, '../../src/jobs/index.js'), 'utf8');
    expect(jobs).not.toMatch(/backfill|legacy-backfill/);
    const core = fs.readFileSync(path.join(__dirname, '../../src/modules/documents/legacy-backfill.js'), 'utf8');
    expect(core).not.toMatch(/bitrix\.service|sendMedicalReport|attachMedicalReport|fetch\(/); // it can never send anything to Bitrix24
    expect(core).not.toMatch(/\brm\(|unlink/); // it never deletes a file
  });

  test('the migration adds the eight scan columns and the index to documents, keeps both upload-id columns and unique indexes, and the rollback removes exactly those', () => {
    const base = path.join(__dirname, '../../prisma/migrations/20261120100000_document_client_upload_id');
    const code = (file) => fs.readFileSync(path.join(base, file), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const up = code('migration.sql');
    for (const column of ['`client_upload_id` VARCHAR(36) NULL', '`sha256` CHAR(64) NULL', '`scan_status` VARCHAR(16) NULL', '`scan_engine` VARCHAR(40) NULL', '`scan_detail` VARCHAR(255) NULL', '`scanned_at` DATETIME(3) NULL', '`scan_attempts` INT NOT NULL DEFAULT 0', '`scan_next_attempt_at` DATETIME(3) NULL']) expect(up).toContain(`ADD COLUMN ${column}`);
    expect(up).toContain('ADD INDEX `idx_documents_scan_status` (`scan_status`, `scan_next_attempt_at`)');
    expect(up).toContain('ADD UNIQUE INDEX `uq_documents_case_client_upload` (`case_id`, `client_upload_id`)');
    expect(up).toContain('ADD UNIQUE INDEX `uq_request_documents_request_client_upload` (`service_request_id`, `client_upload_id`)');
    expect(up).not.toMatch(/DROP|DELETE|UPDATE|TRUNCATE|MODIFY|RENAME/i);
    expect(up.match(/ADD COLUMN/g)).toHaveLength(9); // 8 on documents + client_upload_id on request_documents
    const down = code('down.sql');
    expect(down.match(/DROP COLUMN/g)).toHaveLength(9);
    expect(down).toContain('DROP INDEX `idx_documents_scan_status`');
    const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('@@index([scanStatus, scanNextAttemptAt], map: "idx_documents_scan_status")');
    expect(schema).toMatch(/scanStatus\s+String\?\s+@map\("scan_status"\) @db\.VarChar\(16\)/);
  });
});
