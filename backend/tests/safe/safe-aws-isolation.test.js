/* global describe, test, expect, jest */
// A safe test can never reach AWS, or any other outside service (tests/safe/no-network-or-database.js). This file proves it, with the REAL AWS SDK and the real http / https / net modules:
//   * nothing from backend/.env enters process.env (the real Prisma client, which loads that file, is required first, exactly as a test that needs the database layer would);
//   * every setting the SDK's credential chain and endpoint resolution read is blank: static and session keys, profiles, web identity, container credentials, role assumption, endpoint overrides,
//     the shared credentials and config files (pointed at a path that does not exist) and the instance-metadata lookup (switched off);
//   * an outgoing socket to anything but this machine is refused BEFORE any name is resolved (no DNS), whichever client opens it: net, http, https, tls, the AWS SDK;
//   * what a test legitimately needs still works: servers on loopback, and an S3 adapter given a fake client.
// No database, no outside network (the only connections made are to a server this file starts on 127.0.0.1).
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const AWS_CHAIN = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_STS', 'AWS_USE_FIPS_ENDPOINT', 'AWS_USE_DUALSTACK_ENDPOINT',
  'AWS_S3_BUCKET', 'AWS_S3_FORCE_PATH_STYLE', 'AWS_S3_READ_FALLBACK_BUCKET', 'AWS_S3_READ_FALLBACK_REGION',
];

const outcome = (open) => new Promise((resolve) => {
  const request = open();
  request.on('error', (err) => resolve({ error: err }));
  request.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
  if (typeof request.end === 'function' && !request.writableEnded) request.end();
});

describe('nothing from backend/.env, and no AWS setting, reaches a safe test', () => {
  test('after the real Prisma client has loaded backend/.env, none of its values is in process.env', () => {
    require('@prisma/client'); // loads backend/.env into process.env without overriding what is already set
    const envFile = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envFile)) return; // nothing to leak on this machine (the next tests still check the settings themselves)
    const parsed = require('dotenv').parse(fs.readFileSync(envFile));
    const leaked = Object.entries(parsed).filter(([key, value]) => value !== '' && process.env[key] === value).map(([key]) => key);
    expect(leaked).toEqual([]);
  });

  test.each(AWS_CHAIN)('%s is blank', (name) => {
    expect(process.env[name]).toBe('');
  });

  test('any other AWS_* variable the machine happens to have is blank too, except the three that are set on purpose', () => {
    const allowed = new Set(['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED']);
    const live = Object.entries(process.env).filter(([key, value]) => /^AWS_/i.test(key) && !allowed.has(key) && value !== '').map(([key]) => key);
    expect(live).toEqual([]);
  });

  test('the shared credentials and config files point at paths that do not exist, and the instance-metadata lookup is off', () => {
    for (const name of ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE']) {
      expect(process.env[name]).toBeTruthy(); // not empty: an empty value would make the SDK use ~/.aws
      expect(fs.existsSync(process.env[name])).toBe(false);
      expect(path.resolve(process.env[name]).startsWith(require('os').tmpdir())).toBe(true);
    }
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });

  test('the storage provider is local, and an S3 provider cannot even be configured from this environment', () => {
    const { readStorageConfig } = require('../../src/storage/config');
    expect(process.env.STORAGE_PROVIDER).toBe('local');
    expect(readStorageConfig().provider).toBe('local');
    expect(() => readStorageConfig({ ...process.env, STORAGE_PROVIDER: 's3' })).toThrow(/AWS_REGION|AWS_S3_BUCKET/);
  });
});

describe('the network guard', () => {
  test('a raw socket to the instance-metadata address, to AWS and to any other host is refused, and no DNS lookup is made', async () => {
    const dns = require('dns');
    const lookup = jest.spyOn(dns, 'lookup');
    try {
      for (const target of [{ host: '169.254.169.254', port: 80 }, { host: 's3.ap-south-1.amazonaws.com', port: 443 }, { host: 'example.com', port: 80 }, { host: '8.8.8.8', port: 53 }]) {
        const result = await outcome(() => net.connect(target));
        expect({ target: target.host, code: result.error && result.error.code }).toEqual({ target: target.host, code: 'SAFE_TESTS_NETWORK_BLOCKED' });
        expect(result.error.message).toMatch(/blocked in the safe tests/);
      }
      expect(lookup).not.toHaveBeenCalled(); // refused before any name was resolved
    } finally {
      lookup.mockRestore();
    }
  });

  test('https and http clients are refused the same way', async () => {
    const s3 = await outcome(() => https.get('https://my-bucket.s3.ap-south-1.amazonaws.com/some-key'));
    expect(s3.error && s3.error.code).toBe('SAFE_TESTS_NETWORK_BLOCKED');
    const metadata = await outcome(() => http.get('http://169.254.169.254/latest/meta-data/iam/security-credentials/'));
    expect(metadata.error && metadata.error.code).toBe('SAFE_TESTS_NETWORK_BLOCKED');
    const tls = await outcome(() => require('tls').connect({ host: 'sts.amazonaws.com', port: 443 }));
    expect(tls.error && tls.error.code).toBe('SAFE_TESTS_NETWORK_BLOCKED');
  });

  test('fetch is refused', async () => {
    await expect(fetch('https://s3.amazonaws.com/')).rejects.toThrow(/blocked in the safe tests/);
  });

  test('loopback still works: a server on 127.0.0.1 answers (the tests\' own servers, supertest, fake SMTP / ClamAV)', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 204; res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      expect((await outcome(() => http.get({ host: '127.0.0.1', port, path: '/' }))).status).toBe(204);
      expect((await outcome(() => http.get({ host: 'localhost', port, path: '/' }))).error).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('installing the guard twice does not stack it (the setup file runs before every test file)', () => {
    const before = net.Socket.prototype.connect;
    jest.isolateModules(() => { require('./no-network-or-database'); });
    expect(net.Socket.prototype.connect).toBe(before);
  });
});

describe('the real AWS SDK cannot reach AWS from a safe test', () => {
  const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const head = new HeadObjectCommand({ Bucket: 'a-bucket-that-must-never-be-contacted', Key: 'case-documents/2026/11/' + 'a'.repeat(32) + '.pdf' });

  test('a client with explicit (fake) credentials: the request is refused at the socket', async () => {
    const client = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'fake-secret' }, maxAttempts: 1 });
    const err = await client.send(head).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(`${err.code || ''} ${err.name || ''} ${err.message || ''} ${err.cause && err.cause.code || ''}`).toMatch(/SAFE_TESTS_NETWORK_BLOCKED|blocked in the safe tests/);
  }, 30000);

  test('a client with NO credentials (the default chain, as on a server): it finds none, and never asks the metadata service or STS', async () => {
    const client = new S3Client({ region: 'ap-south-1', maxAttempts: 1 });
    const err = await client.send(head).then(() => null, (e) => e);
    expect(err).not.toBeNull();
    // no credential could be found in the (blanked) environment, the (missing) shared files, or the (disabled) metadata service
    expect(`${err.name} ${err.message}`).toMatch(/credential|Credential|blocked in the safe tests/);
  }, 30000);

  test('an S3 adapter given a fake client still works (the storage tests rely on this)', async () => {
    const { createS3Adapter } = require('../../src/storage/s3.adapter');
    const sent = [];
    const client = { send: jest.fn(async (command) => { sent.push(command.constructor.name); return { ContentLength: 3, ContentType: 'application/pdf', ETag: '"e"', LastModified: new Date('2026-11-25T00:00:00Z') }; }) };
    const adapter = createS3Adapter({ config: { provider: 's3', region: 'ap-south-1', bucket: 'fake-bucket' }, client });
    const key = 'case-documents/2026/11/' + 'b'.repeat(32) + '.pdf';
    expect(await adapter.getMetadata(key)).toMatchObject({ size: 3 });
    expect(sent).toEqual(['HeadObjectCommand']);
  });
});
