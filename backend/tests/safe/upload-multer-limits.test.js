/* global describe, test, expect, afterAll */
// The REAL multer configuration that every patient document upload goes through (src/middleware/upload.middleware.js, shared and untouched): a file over 10 MB and a type outside the allow-list
// are refused before anything is stored, and an allowed file is accepted. Files go to a temporary folder (HC_UPLOAD_DIR), never to backend/uploads. No database, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-multer-limits-'));
process.env.HC_UPLOAD_DIR = dir;

const express = require('express');
const request = require('supertest');
const { upload, UPLOAD_DIR } = require('../../src/middleware/upload.middleware');
const { MAX_FILE_BYTES } = require('../../src/modules/requests/upload-policy');

const app = express();
app.post('/up', upload.single('file'), (req, res) => res.status(201).json({ name: req.file.originalname, size: req.file.size }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(err.name === 'MulterError' || /Unsupported file type/.test(err.message) ? 400 : 500).json({ error: err.message, code: err.code }));

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const stored = () => fs.readdirSync(dir).filter((f) => f !== 'quarantine');
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('multer limits shared by every upload', () => {
  test('the upload folder is the temporary one', () => { expect(UPLOAD_DIR).toBe(path.resolve(dir)); });
  test('the policy\'s size limit is the one multer enforces: exactly 10 MB is accepted, one byte more is refused and nothing is kept', async () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES - PDF.length, 0x20)]);
    const ok = await request(app).post('/up').attach('file', exact, { filename: 'exact.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.size).toBe(MAX_FILE_BYTES);
    const before = stored().length;
    const big = await request(app).post('/up').attach('file', Buffer.concat([exact, Buffer.from([0x20])]), { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe('LIMIT_FILE_SIZE');
    expect(stored().length).toBe(before); // the partial file was removed
  });
  test.each([['text/plain', 'a.txt'], ['text/html', 'a.html'], ['application/x-msdownload', 'a.exe'], ['image/gif', 'a.gif'], ['application/javascript', 'a.js'], ['image/svg+xml', 'a.svg']])('%s is refused by type', async (contentType, filename) => {
    const before = stored().length;
    const res = await request(app).post('/up').attach('file', Buffer.from('x'), { filename, contentType });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
    expect(stored().length).toBe(before);
  });
  test('the six allowed types are accepted by multer (their content is then checked by the upload policy)', async () => {
    for (const [type, name] of [['application/pdf', 'a.pdf'], ['image/jpeg', 'a.jpg'], ['image/png', 'a.png'], ['image/webp', 'a.webp'], ['application/msword', 'a.doc'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx']]) {
      expect((await request(app).post('/up').attach('file', PDF, { filename: name, contentType: type })).status).toBe(201);
    }
  });
  test('stored names are sanitised and cannot escape the folder', async () => {
    const res = await request(app).post('/up').attach('file', PDF, { filename: '../../etc/passwd.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(stored().some((f) => /passwd\.pdf$/.test(f) && !f.includes('/') && !f.includes('..'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '..', '..', 'etc'))).toBe(false);
  });
});
