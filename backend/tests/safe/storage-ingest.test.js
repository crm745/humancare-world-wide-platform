/* global describe, test, expect, jest, beforeAll, beforeEach, afterEach */
// Upload checks, format policy and the fail-closed virus scan in front of storage. ClamAV (a fake clamd over TCP) and the storage are mocked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { ingestUpload, validateUpload, detectType } = require('../../src/storage/ingest');
const { StorageError } = require('../../src/storage/errors');
const clamav = require('../../src/integrations/clamav/clamav');
const { startFakeClamd, unusedPort } = require('../helpers/fake-clamd');
const fx = require('./document-fixtures');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let PDF;
const JPG = fx.validJpeg();
let dir;
const tempFile = (content, name = 'report.pdf', mimetype = 'application/pdf') => {
  const p = path.join(dir, `${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(p, content);
  return { path: p, originalname: name, mimetype, size: content.length };
};
const memoryStorage = () => {
  const objects = new Map();
  return {
    objects,
    provider: 'memory',
    upload: jest.fn(async (key, body) => {
      const chunks = [];
      for await (const x of body) chunks.push(x);
      const buf = Buffer.concat(chunks);
      objects.set(key, buf);
      return { key, size: buf.length, sha256: require('crypto').createHash('sha256').update(buf).digest('hex'), versionId: null };
    }),
    delete: jest.fn(async (key) => { objects.delete(key); }),
  };
};
const clean = jest.fn(async () => ({ status: 'clean' }));

beforeAll(async () => { PDF = await fx.validPdf(); });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ingest-')); clean.mockClear(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('validation and format policy', () => {
  test('type is read from the bytes and must match the MIME type and the extension', async () => {
    expect(detectType(PDF)).toBe('pdf');
    await expect(validateUpload(tempFile(PDF))).resolves.toMatchObject({ type: 'pdf', extension: '.pdf' });
    await expect(validateUpload(tempFile(JPG, 'photo.jpeg', 'image/jpeg'))).resolves.toMatchObject({ type: 'jpeg', extension: '.jpg' });
    await expect(validateUpload(tempFile(Buffer.from('MZ-an-executable-pretending-to-be-a-pdf'), 'report.pdf'))).rejects.toMatchObject({ statusCode: 400, publicCode: 'file_type_invalid' });
    await expect(validateUpload(tempFile(PDF, 'report.pdf', 'image/png'))).rejects.toMatchObject({ publicCode: 'file_type_mismatch' });
    await expect(validateUpload(tempFile(PDF, 'report.exe'))).rejects.toMatchObject({ publicCode: 'file_extension_invalid' });
    await expect(validateUpload(tempFile(Buffer.alloc(0)))).rejects.toMatchObject({ publicCode: 'file_empty' });
    await expect(validateUpload(tempFile(Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)])))).rejects.toMatchObject({ statusCode: 413 });
  });
  test('patient policy: PDF and images only; Word documents are refused', async () => {
    await expect(validateUpload(tempFile(fx.validPng(), 'a.png', 'image/png'), { policy: 'patient' })).resolves.toMatchObject({ type: 'png' });
    await expect(validateUpload(tempFile(fx.validWebp(), 'a.webp', 'image/webp'))).resolves.toMatchObject({ type: 'webp' });
    await expect(validateUpload(tempFile(fx.validDocx(), 'a.docx', DOCX_MIME))).rejects.toMatchObject({ statusCode: 400, publicCode: 'file_type_not_allowed' });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40)]);
    await expect(validateUpload(tempFile(ole, 'a.doc', 'application/msword'), { policy: 'patient' })).rejects.toMatchObject({ publicCode: 'file_type_not_allowed' });
    await expect(validateUpload(tempFile(ole, 'a.doc', 'application/msword'), { policy: 'organization' })).rejects.toMatchObject({ publicCode: 'file_type_not_allowed' }); // DOC is accepted nowhere
  });
  test('organization policy (corporate and registration uploads) also accepts a valid DOCX', async () => {
    await expect(validateUpload(tempFile(fx.validDocx(), 'a.docx', DOCX_MIME), { policy: 'organization' })).resolves.toMatchObject({ type: 'docx', extension: '.docx' });
    await expect(validateUpload(tempFile(PDF), { policy: 'organization' })).resolves.toMatchObject({ type: 'pdf' });
  });
  test('an unknown policy accepts nothing', async () => {
    await expect(validateUpload(tempFile(PDF), { policy: 'whatever' })).rejects.toMatchObject({ statusCode: 500 });
  });
  test('structure problems are refused with a generic public code', async () => {
    await expect(validateUpload(tempFile(Buffer.concat([JPG, Buffer.from('<script>')]), 'a.jpg', 'image/jpeg'))).rejects.toMatchObject({ publicCode: 'file_trailing_data' });
    await expect(validateUpload(tempFile(await fx.pdfWith('openaction')))).rejects.toMatchObject({ publicCode: 'file_structure_invalid', structureCode: 'pdf_active_content' });
    await expect(validateUpload(tempFile(await fx.pdfWith('encrypted')))).rejects.toMatchObject({ publicCode: 'file_encrypted' });
    const encrypted = fx.docxEntries(); encrypted[2] = { ...encrypted[2], flags: 1 };
    await expect(validateUpload(tempFile(fx.zip(encrypted), 'a.docx', DOCX_MIME), { policy: 'organization' })).rejects.toMatchObject({ publicCode: 'file_encrypted' });
    await expect(validateUpload(tempFile(fx.validDocx({ extra: [{ name: 'word/vbaProject.bin', data: Buffer.from('x') }] }), 'a.docx', DOCX_MIME), { policy: 'organization' })).rejects.toMatchObject({ publicCode: 'file_structure_invalid' });
  });
});

describe('ingestUpload', () => {
  test('a clean file is scanned first, stored under a generated key, temp file removed', async () => {
    const storage = memoryStorage();
    const file = tempFile(PDF, '../../etc/passwd.pdf');
    const out = await ingestUpload({ file, area: 'case-documents', scanner: clean, storage });
    expect(clean).toHaveBeenCalledWith(file.path);
    expect(out.key).toMatch(/^case-documents\/\d{4}\/\d{2}\/[a-f0-9]{32}\.pdf$/);
    expect(out.key).not.toMatch(/passwd/);
    expect(storage.objects.get(out.key)).toEqual(PDF);
    expect(out).toMatchObject({ scanned: true, size: PDF.length });
    expect(fs.existsSync(file.path)).toBe(false);
  });
  test('a structurally unsafe file is refused BEFORE the scanner or storage see it', async () => {
    const storage = memoryStorage();
    const file = tempFile(await fx.pdfWith('embedded'));
    await expect(ingestUpload({ file, area: 'case-documents', scanner: clean, storage })).rejects.toMatchObject({ statusCode: 400 });
    expect(clean).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });
  test('an infected file is refused (422) and nothing is stored', async () => {
    const storage = memoryStorage();
    const file = tempFile(PDF);
    await expect(ingestUpload({ file, area: 'case-documents', storage, scanner: async () => ({ status: 'infected', signature: 'Eicar' }) }))
      .rejects.toMatchObject({ statusCode: 422, publicCode: 'file_infected' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });
  test.each([
    ['scanner unavailable', { status: 'error', detail: 'cannot reach the scanner (ECONNREFUSED)' }],
    ['scan timeout', { status: 'error', detail: 'scan timed out' }],
    ['no verdict', undefined],
    ['unknown status', { status: 'ok' }],
  ])('%s fails closed (503), nothing stored', async (_name, verdict) => {
    const storage = memoryStorage();
    const file = tempFile(PDF);
    await expect(ingestUpload({ file, area: 'corporate-documents', storage, policy: 'organization', scanner: async () => verdict })).rejects.toMatchObject({ statusCode: 503, publicCode: 'scan_unavailable' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });
  test('a scanner that is not READY (stale or unverifiable signatures) fails closed even if it would say clean', async () => {
    for (const state of [{ ok: false, reason: 'signatures_stale' }, { ok: false, reason: 'version_unavailable' }, { ok: false, reason: 'unreachable' }, false, undefined]) {
      const storage = memoryStorage();
      const file = tempFile(PDF);
      await expect(ingestUpload({ file, area: 'case-documents', storage, scanner: clean, health: async () => state })).rejects.toMatchObject({ statusCode: 503, publicCode: 'scan_unavailable' });
      expect(clean).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    }
    const ok = memoryStorage();
    await expect(ingestUpload({ file: tempFile(PDF), area: 'case-documents', storage: ok, scanner: clean, health: async () => ({ ok: true }) })).resolves.toMatchObject({ scanned: true });
  });
  test('deferred scan (request-review workflow) stores without scanning, after the same checks', async () => {
    const storage = memoryStorage();
    const scanner = jest.fn();
    const out = await ingestUpload({ file: tempFile(PDF), area: 'request-documents', scan: 'deferred', scanner, storage });
    expect(scanner).not.toHaveBeenCalled();
    expect(out.scanned).toBe(false);
    expect(out.key).toMatch(/^request-documents\//);
    await expect(ingestUpload({ file: tempFile(fx.validDocx(), 'a.docx', DOCX_MIME), area: 'request-documents', scan: 'deferred', storage })).rejects.toMatchObject({ publicCode: 'file_type_not_allowed' });
  });
  test('a storage (S3) upload failure propagates and leaves no temp file', async () => {
    const storage = { provider: 's3', upload: jest.fn(async () => { throw new StorageError('upload_failed', 'x'); }), delete: jest.fn() };
    const file = tempFile(PDF);
    await expect(ingestUpload({ file, area: 'case-documents', scanner: clean, storage })).rejects.toMatchObject({ code: 'upload_failed' });
    expect(fs.existsSync(file.path)).toBe(false);
  });
  test('a file that changes between scan and store is rejected and removed again', async () => {
    const storage = memoryStorage();
    const file = tempFile(PDF);
    const tampering = async (p) => { fs.writeFileSync(p, Buffer.concat([PDF, Buffer.from('tampered')])); return { status: 'clean' }; };
    await expect(ingestUpload({ file, area: 'case-documents', scanner: tampering, storage })).rejects.toMatchObject({ code: 'file_changed' });
    expect(storage.objects.size).toBe(0);
  });
});

describe('ClamAV client (fake clamd over TCP)', () => {
  let clamd;
  afterEach(async () => { if (clamd) await clamd.close(); clamd = null; });
  const opts = () => ({ host: '127.0.0.1', port: clamd.port, timeoutMs: 800 });

  test('scanStream: clean, infected, and every failure is an error, never clean', async () => {
    clamd = await startFakeClamd('ok');
    expect((await clamav.scanStream(Readable.from([PDF]), opts())).status).toBe('clean');
    expect((await clamav.scanStream(Readable.from([Buffer.from('EICAR-TEST')]), opts())).status).toBe('infected');
    for (const mode of ['garbage', 'wrongok', 'hang', 'drip', 'close']) {
      clamd.setMode(mode);
      expect((await clamav.scanStream(Readable.from([PDF]), opts())).status).toBe('error');
    }
  });
  test('scanner down (nothing listening) is an error', async () => {
    const port = await unusedPort();
    expect((await clamav.scanStream(Readable.from([PDF]), { host: '127.0.0.1', port, timeoutMs: 500 })).status).toBe('error');
    expect((await clamav.scanFile(path.join(os.tmpdir(), 'does-not-exist.bin'), { host: '127.0.0.1', port, timeoutMs: 500 })).status).toBe('error');
  });
  test('a failing source stream (e.g. an S3 read error) is an error', async () => {
    clamd = await startFakeClamd('ok');
    const broken = new Readable({ read() { this.destroy(Object.assign(new Error('x'), { code: 'EIO' })); } });
    expect((await clamav.scanStream(broken, opts())).status).toBe('error');
  });
});
