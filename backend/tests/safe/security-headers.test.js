/* global describe, test, expect, jest */
// The REAL application (src/app.js) over HTTP with supertest, no database: every response (a healthy one, a refused one, an unknown route) carries X-Content-Type-Options: nosniff
// and none announces "Express".
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  return { UPLOAD_DIR: require('os').tmpdir(), upload: { single: pass, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: pass, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const request = require('supertest');
const { app } = require('../../src/app');

describe('response headers', () => {
  test.each([['/health', 200], ['/requests/me', 401], ['/no-such-route', 404]])('%s (%i)', async (path, status) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(status);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
  test('an error answer (malformed JSON) carries them too', async () => {
    const res = await request(app).post('/auth/login').set('content-type', 'application/json').send('{"phone":');
    expect(res.status).toBe(400);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
