/* global describe, test, expect, jest, beforeEach, afterEach */
// The shared storage abstraction: local adapter, S3 adapter (mocked client, no network), key rules and configuration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createLocalAdapter } = require('../../src/storage/local.adapter');
const { createS3Adapter } = require('../../src/storage/s3.adapter');
const { readStorageConfig } = require('../../src/storage/config');
const { generateKey, assertSafeKey, isLegacyLocalKey, keyFromStoredReference, GENERATED_KEY, AREAS } = require('../../src/storage/keys');
const { StorageError } = require('../../src/storage/errors');

const sha = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');
const read = async (stream) => { const c = []; for await (const x of stream) c.push(x); return Buffer.concat(c); };

describe('keys', () => {
  test('generated keys are unpredictable and area-scoped', () => {
    const a = generateKey(AREAS.REQUEST_DOCUMENTS, '.pdf');
    const b = generateKey(AREAS.REQUEST_DOCUMENTS, '.pdf');
    expect(a).toMatch(GENERATED_KEY);
    expect(a).not.toBe(b);
    expect(() => generateKey('../etc', '.pdf')).toThrow(StorageError);
    expect(() => generateKey(AREAS.CASE_DOCUMENTS, '.exe')).toThrow(StorageError);
  });
  test('path traversal and odd keys are refused', () => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', '.hidden', 'a/.b', '', 'x'.repeat(200), 'a/b c', 'a/%2e%2e/b']) {
      expect(() => assertSafeKey(bad)).toThrow(StorageError);
    }
    expect(assertSafeKey('request-documents/2026/11/abc.pdf')).toBeTruthy();
  });
  test('legacy references', () => {
    expect(isLegacyLocalKey('1700-report.pdf')).toBe(true);
    expect(isLegacyLocalKey('request-documents/2026/11/ab.pdf')).toBe(false);
    expect(keyFromStoredReference('/uploads/1700-report.pdf')).toBe('1700-report.pdf');
    expect(keyFromStoredReference('case-documents/2026/11/ab.pdf')).toBe('case-documents/2026/11/ab.pdf');
  });
});

describe('local adapter', () => {
  let root;
  let adapter;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-storage-')); adapter = createLocalAdapter({ root }); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('upload, metadata, exists, download, delete', async () => {
    const body = Buffer.from('%PDF-1.4 hello');
    const key = generateKey(AREAS.CASE_DOCUMENTS, '.pdf');
    const out = await adapter.upload(key, Readable.from([body]));
    expect(out).toMatchObject({ key, size: body.length, sha256: sha(body) });
    expect(await adapter.exists(key)).toBe(true);
    expect((await adapter.getMetadata(key)).size).toBe(body.length);
    expect(await read((await adapter.download(key)).stream)).toEqual(body);
    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);
    expect(await adapter.getMetadata(key)).toBeNull();
    await expect(adapter.download(key)).rejects.toMatchObject({ code: 'not_found' });
  });
  test('never overwrites, refuses oversize, leaves no temp file', async () => {
    const key = generateKey(AREAS.CASE_DOCUMENTS, '.pdf');
    await adapter.upload(key, Buffer.from('one'));
    await expect(adapter.upload(key, Buffer.from('two'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(adapter.upload(generateKey(AREAS.CASE_DOCUMENTS), Buffer.alloc(100), { maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large' });
    expect(fs.readdirSync(root, { recursive: true }).filter((n) => String(n).includes('.tmp-'))).toEqual([]);
  });
  test('cannot leave its root', async () => {
    await expect(adapter.download('../outside')).rejects.toMatchObject({ code: 'key_invalid' });
  });
});

describe('S3 adapter (mocked client)', () => {
  const config = { region: 'ap-southeast-2', bucket: 'test-bucket', accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' };
  const sent = [];
  const makeClient = (impl) => ({ send: jest.fn(async (cmd) => { sent.push(cmd); return impl(cmd); }) });
  beforeEach(() => { sent.length = 0; });

  test('upload is private, encrypted, streamed and returns the content hash', async () => {
    let captured;
    const uploader = jest.fn(async (_client, params) => { captured = await read(params.Body); return { ETag: '"e"', VersionId: 'v1' }; });
    const adapter = createS3Adapter({ config, client: makeClient(() => ({})), uploader });
    const body = Buffer.from('%PDF-1.4 secret');
    const key = generateKey(AREAS.REQUEST_DOCUMENTS, '.pdf');
    const out = await adapter.upload(key, Readable.from([body]), { contentType: 'application/pdf' });
    const params = uploader.mock.calls[0][1];
    expect(params).toMatchObject({ Bucket: 'test-bucket', Key: key, ServerSideEncryption: 'AES256', ContentType: 'application/pdf' });
    expect(params.ACL).toBeUndefined();
    expect(captured).toEqual(body);
    expect(out).toMatchObject({ key, size: body.length, sha256: sha(body), versionId: 'v1' });
  });
  test('download streams, metadata, exists, delete', async () => {
    const client = makeClient((cmd) => {
      const n = cmd.constructor.name;
      if (n === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('abc')]), ContentLength: 3, ContentType: 'application/pdf', ETag: '"e"' };
      if (n === 'HeadObjectCommand') return { ContentLength: 3, ContentType: 'application/pdf' };
      return {};
    });
    const adapter = createS3Adapter({ config, client });
    const key = `case-documents/2026/11/${'a'.repeat(32)}.pdf`;
    expect(await read((await adapter.download(key)).stream)).toEqual(Buffer.from('abc'));
    expect((await adapter.getMetadata(key)).size).toBe(3);
    expect(await adapter.exists(key)).toBe(true);
    await adapter.delete(key);
    expect(sent.map((c) => c.constructor.name)).toEqual(['GetObjectCommand', 'HeadObjectCommand', 'HeadObjectCommand', 'DeleteObjectCommand']);
    expect(sent[0].input).toEqual({ Bucket: 'test-bucket', Key: key });
  });
  test('missing object: not_found / null / false', async () => {
    const missing = Object.assign(new Error('x'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    const adapter = createS3Adapter({ config, client: makeClient(() => { throw missing; }) });
    const key = `case-documents/2026/11/${'b'.repeat(32)}`;
    await expect(adapter.download(key)).rejects.toMatchObject({ code: 'not_found' });
    expect(await adapter.getMetadata(key)).toBeNull();
    expect(await adapter.exists(key)).toBe(false);
  });
  test('S3 failures become safe StorageErrors without leaking details', async () => {
    const boom = Object.assign(new Error('AccessDenied for arn:aws:iam::123:user/x bucket test-bucket'), { name: 'AccessDenied' });
    const adapter = createS3Adapter({ config, client: makeClient(() => { throw boom; }), uploader: async () => { throw boom; } });
    const key = `case-documents/2026/11/${'c'.repeat(32)}`;
    for (const call of [() => adapter.download(key), () => adapter.getMetadata(key), () => adapter.delete(key), () => adapter.upload(key, Buffer.from('x'))]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect(err.message).not.toMatch(/arn:|test-bucket|AccessDenied/);
    }
  });
  test('invalid keys never reach S3', async () => {
    const client = makeClient(() => ({}));
    const adapter = createS3Adapter({ config, client });
    await expect(adapter.download('../x')).rejects.toMatchObject({ code: 'key_invalid' });
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('S3 adapter credentials and read fallback', () => {
  const base = { region: 'ap-south-1', bucket: 'new-bucket' };
  test('no keys in config: the SDK client is built WITHOUT explicit credentials (default chain); with keys they are passed', async () => {
    for (const [config, expectCreds] of [[base, false], [{ ...base, accessKeyId: 'a', secretAccessKey: 'b' }, true]]) {
      let options;
      await jest.isolateModulesAsync(async () => {
        jest.doMock('@aws-sdk/client-s3', () => ({
          S3Client: class { constructor(o) { options = o; } async send() { return { ContentLength: 1 }; } },
          HeadObjectCommand: class { constructor(i) { this.input = i; } },
        }));
        const { createS3Adapter: create } = require('../../src/storage/s3.adapter');
        await create({ config }).getMetadata(`case-documents/2026/11/${'e'.repeat(32)}`);
      });
      jest.dontMock('@aws-sdk/client-s3');
      expect(options.region).toBe('ap-south-1');
      expect('credentials' in options).toBe(expectCreds);
    }
  });
  test('a missing object is looked for in the read-only fallback bucket; writes and deletes never touch it', async () => {
    const calls = [];
    const send = async (cmd) => {
      calls.push([cmd.constructor.name, cmd.input.Bucket]);
      if (cmd.input.Bucket === 'new-bucket' && cmd.constructor.name !== 'DeleteObjectCommand') throw Object.assign(new Error('x'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([Buffer.from('old')]), ContentLength: 3 };
    };
    const adapter = createS3Adapter({ config: { ...base, readFallback: { bucket: 'old-bucket', region: 'ap-southeast-2' } }, client: { send }, fallbackClient: { send }, uploader: async () => ({}) });
    const key = `case-documents/2026/11/${'d'.repeat(32)}.pdf`;
    expect(await read((await adapter.download(key)).stream)).toEqual(Buffer.from('old'));
    expect((await adapter.getMetadata(key)).size).toBe(3);
    await adapter.delete(key);
    expect(calls.filter(([n, b]) => b === 'old-bucket' && n === 'DeleteObjectCommand')).toEqual([]);
    expect(calls.some(([, b]) => b === 'old-bucket')).toBe(true);
  });
});

describe('configuration', () => {
  test('local is the default', () => expect(readStorageConfig({})).toEqual({ provider: 'local' }));
  test('S3 needs region and bucket and names only the variables', () => {
    let err;
    try { readStorageConfig({ STORAGE_PROVIDER: 's3' }); } catch (e) { err = e; }
    expect(err.code).toBe('config_missing');
    expect(err.message).toMatch(/AWS_REGION/);
    expect(err.message).toMatch(/AWS_S3_BUCKET/);
  });
  test('credentials: keys for development, none (default provider chain / EC2 role) for production, never just one', () => {
    const base = { STORAGE_PROVIDER: 's3', AWS_REGION: 'ap-south-1', AWS_S3_BUCKET: 'my-bucket' };
    const prod = readStorageConfig(base);
    expect(prod.accessKeyId).toBeUndefined();
    expect(prod.secretAccessKey).toBeUndefined();
    expect(readStorageConfig({ ...base, AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toMatchObject({ accessKeyId: 'a', secretAccessKey: 'b' });
    expect(() => readStorageConfig({ ...base, AWS_ACCESS_KEY_ID: 'a' })).toThrow(/together/);
    expect(() => readStorageConfig({ ...base, AWS_SECRET_ACCESS_KEY: 'b' })).toThrow(/together/);
  });
  test('the read fallback bucket (migration) needs both settings', () => {
    const base = { STORAGE_PROVIDER: 's3', AWS_REGION: 'ap-south-1', AWS_S3_BUCKET: 'new-bucket' };
    expect(readStorageConfig({ ...base, AWS_S3_READ_FALLBACK_BUCKET: 'old-bucket', AWS_S3_READ_FALLBACK_REGION: 'ap-southeast-2' }).readFallback).toEqual({ bucket: 'old-bucket', region: 'ap-southeast-2' });
    expect(() => readStorageConfig({ ...base, AWS_S3_READ_FALLBACK_BUCKET: 'old-bucket' })).toThrow(/together/);
  });
  test('invalid values are refused; no fallback bucket or region', () => {
    const ok = { STORAGE_PROVIDER: 's3', AWS_REGION: 'ap-southeast-2', AWS_S3_BUCKET: 'my-bucket', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' };
    expect(readStorageConfig(ok)).toMatchObject({ provider: 's3', bucket: 'my-bucket', forcePathStyle: false });
    expect(() => readStorageConfig({ ...ok, STORAGE_PROVIDER: 'gcs' })).toThrow(/STORAGE_PROVIDER/);
    expect(() => readStorageConfig({ ...ok, AWS_REGION: 'nowhere' })).toThrow(/AWS_REGION/);
    expect(() => readStorageConfig({ ...ok, AWS_S3_BUCKET: 'Bad_Bucket' })).toThrow(/AWS_S3_BUCKET/);
    expect(() => readStorageConfig({ ...ok, AWS_S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(/FORCE_PATH_STYLE/);
    expect(() => readStorageConfig({ ...ok, AWS_S3_BUCKET: '' })).toThrow(StorageError);
  });
});
