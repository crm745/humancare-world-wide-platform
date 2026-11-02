import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiUrlError, validateDevelopmentApiUrl, validateProductionApiUrl } from './apiUrl.mjs';

// `.test` is a reserved TLD (RFC 2606): these are fixtures, not real domains.
const GOOD = 'https://api.example.test';

test('production: accepts a plain https origin, with or without one trailing slash', () => {
  for (const value of [GOOD, `${GOOD}/`, 'https://api.example.test:8443', 'https://a.b.example.test', 'HTTPS://API.Example.TEST']) {
    assert.equal(validateProductionApiUrl(value), value, value);
  }
});

const REJECTED = {
  'missing (undefined)': undefined,
  'missing (null)': null,
  empty: '',
  'whitespace only': '   ',
  'not a url': 'not a url',
  'no scheme': 'api.example.test',
  'scheme without slashes': 'https:api.example.test',
  'plain http': 'http://api.example.test',
  'other scheme': 'ftp://api.example.test',
  'non-string': 12345,
  'leading space': ` ${GOOD}`,
  'trailing space': `${GOOD} `,
  'trailing newline': `${GOOD}\n`,
  localhost: 'https://localhost',
  'localhost with port': 'https://localhost:4000',
  'localhost subdomain': 'https://app.localhost',
  'localhost, upper case': 'https://LOCALHOST',
  'localhost, trailing dot': 'https://localhost.',
  'loopback IPv4': 'https://127.0.0.1',
  'loopback IPv4, short form': 'https://127.1',
  'loopback IPv4, hex': 'https://0x7f.0.0.1',
  'loopback IPv4, decimal': 'https://2130706433',
  'any-address IPv4': 'https://0.0.0.0',
  'loopback IPv6': 'https://[::1]',
  'public IPv6': 'https://[2001:db8::1]',
  'private IPv4 10/8': 'https://10.0.0.5',
  'private IPv4 192.168/16': 'https://192.168.1.10',
  'private IPv4 172.16/12': 'https://172.16.0.1',
  'public IPv4': 'https://8.8.8.8',
  'single-label host': 'https://api',
  'trailing dot': 'https://api.example.test.',
  'underscore in host': 'https://exa_mple.test',
  'empty label': 'https://api..example.test',
  'username and password': 'https://admin:s3cretPW@api.example.test',
  'username only': 'https://admin@api.example.test',
  'query string': 'https://api.example.test?x=1',
  'query after slash': 'https://api.example.test/?x=1',
  fragment: 'https://api.example.test#frag',
  '/v1 path': 'https://api.example.test/v1',
  'two slashes': 'https://api.example.test//',
  backslash: 'https://api.example.test\\v1',
};

for (const [name, value] of Object.entries(REJECTED)) {
  test(`production: rejects ${name}`, () => {
    assert.throws(() => validateProductionApiUrl(value), ApiUrlError);
  });
}

test('production: error messages never repeat the value (it may hold credentials)', () => {
  for (const value of Object.values(REJECTED)) {
    if (typeof value !== 'string' || value.trim().length < 4) continue;
    try {
      validateProductionApiUrl(value);
    } catch (err) {
      assert.ok(!err.message.includes(value.trim()), `message repeats the value: ${err.message}`);
      assert.ok(!err.message.includes('s3cretPW'), 'message leaks the password');
      assert.ok(err.message.startsWith('VITE_API_BASE_URL'), err.message);
    }
  }
});

test('development: unset or empty is allowed (the caller applies the localhost default)', () => {
  for (const value of [undefined, null, '']) assert.doesNotThrow(() => validateDevelopmentApiUrl(value));
});

test('development: well-formed http(s) URLs are accepted, including localhost', () => {
  for (const value of ['http://localhost:4000', 'http://192.168.1.5:4000', GOOD]) {
    assert.equal(validateDevelopmentApiUrl(value), value);
  }
});

test('development: a supplied but malformed value fails instead of silently falling back', () => {
  for (const value of ['not a url', ' ', 'localhost:4000', 'ftp://api.example.test', 'http://', 'http://user:pw@host.example.test']) {
    assert.throws(() => validateDevelopmentApiUrl(value), ApiUrlError, value);
  }
});
