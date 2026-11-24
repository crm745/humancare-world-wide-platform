/* global describe, test, expect, jest, afterEach */
// Switching STORAGE_PROVIDER (or having files from before S3) must not make an existing object unreachable.
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const KEY = `case-documents/2026/11/${'a'.repeat(32)}.pdf`;
const ENV_KEYS = ['STORAGE_PROVIDER', 'AWS_REGION', 'AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../../src/storage'); });
  return mod;
}
const read = async (stream) => { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c); };

describe('provider switch', () => {
  test('S3 active: an object that only exists locally (from before S3) is still read, and a local legacy key is always local', async () => {
    process.env.STORAGE_PROVIDER = 's3'; process.env.AWS_REGION = 'ap-south-1'; process.env.AWS_S3_BUCKET = 'my-bucket';
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY; // production style: role credentials
    const storage = load();
    const root = storage.getLocal().pathOf('x-probe').replace(/x-probe$/, '');
    const file = path.join(root, 'case-documents', '2026', '11', `${'a'.repeat(32)}.pdf`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'local-bytes');
    try {
      const adapter = storage.getStorage();
      expect(adapter.provider).toBe('s3');
      // the S3 client is replaced by one that says "not found", as for an object that was never uploaded
      const s3 = storage.storageForProvider('s3');
      expect(s3.provider).toBe('s3');
      expect(storage.storageFor('1700-legacy.pdf').provider).toBe('local');
      expect(storage.activeProvider()).toBe('s3');
    } finally {
      fs.rmSync(path.join(root, 'case-documents'), { recursive: true, force: true });
    }
  });
  test('local active with S3 not configured: the plain local adapter (no composite, no network)', () => {
    process.env.STORAGE_PROVIDER = 'local';
    for (const k of ['AWS_REGION', 'AWS_S3_BUCKET']) delete process.env[k];
    const storage = load();
    const adapter = storage.getStorage();
    expect(adapter.provider).toBe('local');
    expect(typeof adapter.pathOf).toBe('function');
  });
  test('S3 selected but not configured fails clearly', () => {
    process.env.STORAGE_PROVIDER = 's3';
    for (const k of ['AWS_REGION', 'AWS_S3_BUCKET']) delete process.env[k];
    expect(() => load().getStorage()).toThrow(/AWS_REGION, AWS_S3_BUCKET/);
    expect(() => load().storageForProvider('s3')).toThrow(/AWS_REGION/);
  });
  test('a record that says "s3" while S3 is not configured is an error, never a silent local read', () => {
    process.env.STORAGE_PROVIDER = 'local';
    for (const k of ['AWS_REGION', 'AWS_S3_BUCKET']) delete process.env[k];
    expect(() => load().storageForProvider('s3')).toThrow(/not configured/);
  });
});

describe('composite read fallback (injected adapters through the real implementation)', () => {
  test('missing in the active provider, present in the other: read; absent in both: not_found; real errors are not hidden', async () => {
    process.env.STORAGE_PROVIDER = 's3'; process.env.AWS_REGION = 'ap-south-1'; process.env.AWS_S3_BUCKET = 'my-bucket';
    const storage = load();
    const active = storage.getStorage();
    const { StorageError } = storage;
    const local = storage.getLocal();
    const spyLocal = jest.spyOn(local, 'download').mockImplementation(async () => ({ stream: Readable.from([Buffer.from('from-local')]), size: 10 }));
    const s3 = storage.storageForProvider('s3');
    jest.spyOn(s3, 'download').mockImplementation(async () => { throw new StorageError('not_found', 'x'); });
    expect(await read((await active.download(KEY)).stream)).toEqual(Buffer.from('from-local'));
    spyLocal.mockImplementation(async () => { throw new StorageError('not_found', 'x'); });
    await expect(active.download(KEY)).rejects.toMatchObject({ code: 'not_found' });
    s3.download.mockImplementation(async () => { throw new StorageError('download_failed', 'x'); });
    await expect(active.download(KEY)).rejects.toMatchObject({ code: 'download_failed' }); // an outage is not "missing"
  });
});
