/* global describe, test, expect, jest */
// The safe tests never reach a real bucket. backend/.env can select S3 (STORAGE_PROVIDER=s3, AWS_*), and @prisma/client loads that file into process.env the first time a test requires it
// (it only fills variables that are not set). tests/safe/no-network-or-database.js therefore fixes the storage settings first. This is the regression test for that: requiring the real Prisma
// client (which is what loads .env) leaves the storage on the local adapter, with no AWS setting for the S3 adapter (or its read fallback) to be built from. No database, no network.
const path = require('path');

describe('safe tests use local storage only', () => {
  test('after the real Prisma client has been required (and has loaded backend/.env, if there is one) the storage is still local', () => {
    require('@prisma/client'); // loads backend/.env into process.env, without overriding what is already set
    const { readStorageConfig } = require('../../src/storage/config');
    expect(readStorageConfig().provider).toBe('local');
    for (const key of ['AWS_REGION', 'AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_READ_FALLBACK_BUCKET', 'AWS_S3_READ_FALLBACK_REGION']) {
      expect({ key, value: process.env[key] }).toEqual({ key, value: '' });
    }
  });

  test('the storage service is the local adapter, rooted where the test says, and has no S3 read fallback', () => {
    const fs = require('fs');
    const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-isolation-'));
    jest.resetModules();
    jest.doMock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: root }));
    try {
      const storage = require('../../src/storage');
      const adapter = storage.getStorage();
      expect(adapter.provider).toBe('local');
      expect(typeof adapter.pathOf).toBe('function'); // only the local adapter has one: no composite with an S3 fallback
      expect(adapter.pathOf('case-documents/2026/11/' + 'a'.repeat(32) + '.pdf').startsWith(root)).toBe(true);
    } finally {
      jest.dontMock('../../src/middleware/upload.middleware');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an S3 provider cannot be selected by the environment of a safe test (it is refused for lack of settings, never built)', () => {
    const { readStorageConfig } = require('../../src/storage/config');
    expect(() => readStorageConfig({ ...process.env, STORAGE_PROVIDER: 's3' })).toThrow(/AWS_REGION|AWS_S3_BUCKET/);
  });
});
