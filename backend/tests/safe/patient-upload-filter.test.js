/* global describe, test, expect, beforeAll, afterAll */
// The patient-facing multer instance refuses Word documents before anything is written to disk; the organization one still accepts them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

let dir;
let app;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-upload-filter-'));
  process.env.HC_UPLOAD_DIR = dir;
  let mw;
  jest.isolateModules(() => { mw = require('../../src/middleware/upload.middleware'); });
  app = express();
  app.post('/patient', mw.uploadPatient.single('file'), (req, res) => res.status(201).json({ ok: true }));
  app.post('/organization', mw.upload.single('file'), (req, res) => res.status(201).json({ ok: true }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(400).json({ error: err.message }));
});
afterAll(() => { delete process.env.HC_UPLOAD_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('upload filters', () => {
  test.each([
    ['application/msword', 'a.doc'],
    [DOCX, 'a.docx'],
    ['application/zip', 'a.zip'],
    ['text/html', 'a.html'],
  ])('patient endpoint refuses %s before writing it', async (type, name) => {
    const res = await request(app).post('/patient').attach('file', Buffer.from('x'), { filename: name, contentType: type });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF, JPG, PNG, WEBP/);
    expect(res.body.error).not.toMatch(/DOC/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  test('the organization endpoint still lets DOCX reach the (stricter) content checks', async () => {
    const res = await request(app).post('/organization').attach('file', Buffer.from('x'), { filename: 'a.docx', contentType: DOCX });
    expect(res.status).toBe(201);
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  });
});
