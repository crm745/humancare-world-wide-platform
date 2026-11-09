// Firebase service-account setup (src/integrations/firebase/firebase.js): how the key path is
// resolved and what is reported when the key file is missing or wrong. No real credentials are
// used: files are temporary and clearly not keys, and firebase-admin is replaced by a stand-in.
const fs = require('fs');
const os = require('os');
const path = require('path');

const VARIABLE = 'FIREBASE_SERVICE_ACCOUNT_PATH';
const BACKEND_DIR = path.resolve(__dirname, '..');
// Written into the bad files below; it must never show up in an error message.
const FILE_CONTENT_MARKER = 'CONTENT-MARKER-MUST-NOT-APPEAR';

// A shape-only stand-in for a key (what loadServiceAccount checks). It is not a credential.
const SHAPE_ONLY_KEY = {
  type: 'service_account',
  project_id: 'test-fixture',
  client_email: 'test-fixture@example.invalid',
  private_key: 'test-fixture-not-a-key',
};

let dir;
const originalCwd = process.cwd();
const originalValue = process.env[VARIABLE];

function load() {
  let mod;
  jest.isolateModules(() => { mod = require('../src/integrations/firebase/firebase'); });
  return mod;
}
function writeFile(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-config-test-')); });
afterEach(() => {
  process.chdir(originalCwd);
  if (originalValue === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = originalValue;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.resetModules();
  jest.dontMock('firebase-admin/app');
  jest.dontMock('firebase-admin/auth');
});

describe('resolveKeyPath', () => {
  it.each([['unset', undefined], ['empty', ''], ['blank', '   ']])('says the variable is not set when it is %s', (_label, value) => {
    const { resolveKeyPath, FirebaseConfigError } = load();
    expect(() => resolveKeyPath(value)).toThrow(FirebaseConfigError);
    expect(() => resolveKeyPath(value)).toThrow(VARIABLE);
    expect(() => resolveKeyPath(value)).toThrow(/is not set/);
  });

  it('reads the variable from the environment when no value is passed', () => {
    const { resolveKeyPath } = load();
    process.env[VARIABLE] = path.join(dir, 'key.json');
    expect(resolveKeyPath()).toBe(path.join(dir, 'key.json'));
  });

  it('uses an absolute path as it is', () => {
    const { resolveKeyPath } = load();
    const absolute = path.join(dir, 'secrets', 'key.json');
    expect(resolveKeyPath(absolute)).toBe(absolute);
  });

  it('resolves a relative path against the backend folder, whatever the working directory is', () => {
    const { resolveKeyPath } = load();
    process.chdir(os.tmpdir());
    expect(resolveKeyPath('secrets/key.json')).toBe(path.join(BACKEND_DIR, 'secrets', 'key.json'));
    expect(resolveKeyPath('./secrets/key.json')).toBe(path.join(BACKEND_DIR, 'secrets', 'key.json'));
  });

  it('trims stray spaces around the value', () => {
    const { resolveKeyPath } = load();
    expect(resolveKeyPath(`  ${path.join(dir, 'key.json')}  `)).toBe(path.join(dir, 'key.json'));
  });
});

describe('loadServiceAccount', () => {
  it('reports a missing file clearly (not a raw ENOENT) and names the path and variable', () => {
    const { loadServiceAccount, FirebaseConfigError } = load();
    const missing = path.join(dir, 'does-not-exist.json');
    let error;
    try { loadServiceAccount(missing); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(FirebaseConfigError);
    expect(error.code).toBe('firebase_not_configured');
    expect(error.message).toContain(missing);
    expect(error.message).toContain(VARIABLE);
    expect(error.message).toMatch(/does not exist/);
    expect(error.message).not.toMatch(/ENOENT/);
  });

  it('reports a path that is a folder as unreadable', () => {
    const { loadServiceAccount, FirebaseConfigError } = load();
    expect(() => loadServiceAccount(dir)).toThrow(FirebaseConfigError);
    expect(() => loadServiceAccount(dir)).toThrow(/could not be read/);
  });

  it('reports invalid JSON without echoing the file content', () => {
    const { loadServiceAccount } = load();
    const file = writeFile('bad.json', `{ ${FILE_CONTENT_MARKER} not json`);
    let error;
    try { loadServiceAccount(file); } catch (err) { error = err; }
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.message).not.toContain(FILE_CONTENT_MARKER);
  });

  it.each([['an array', '[]'], ['a string', '"text"'], ['null', 'null'], ['a number', '5']])('rejects JSON that is %s', (_label, json) => {
    const { loadServiceAccount } = load();
    expect(() => loadServiceAccount(writeFile('shape.json', json))).toThrow(/not a service-account key/);
  });

  it('rejects a JSON key of another type', () => {
    const { loadServiceAccount } = load();
    const file = writeFile('type.json', { ...SHAPE_ONLY_KEY, type: 'authorized_user' });
    expect(() => loadServiceAccount(file)).toThrow(/"type" is not "service_account"/);
  });

  it('lists every missing required field, and none of the content', () => {
    const { loadServiceAccount } = load();
    const file = writeFile('partial.json', { type: 'service_account', project_id: 'test-fixture', note: FILE_CONTENT_MARKER });
    let error;
    try { loadServiceAccount(file); } catch (err) { error = err; }
    expect(error.message).toMatch(/missing required field\(s\): client_email, private_key/);
    expect(error.message).not.toContain(FILE_CONTENT_MARKER);
  });

  it.each(['project_id', 'client_email', 'private_key'])('treats an empty or non-string %s as missing', (field) => {
    const { loadServiceAccount } = load();
    expect(() => loadServiceAccount(writeFile(`empty-${field}.json`, { ...SHAPE_ONLY_KEY, [field]: '  ' }))).toThrow(field);
    expect(() => loadServiceAccount(writeFile(`num-${field}.json`, { ...SHAPE_ONLY_KEY, [field]: 5 }))).toThrow(field);
  });

  it('returns the parsed key when every required field is present', () => {
    const { loadServiceAccount } = load();
    expect(loadServiceAccount(writeFile('ok.json', SHAPE_ONLY_KEY))).toEqual(SHAPE_ONLY_KEY);
  });
});

describe('firebaseApp / assertFirebaseConfigured', () => {
  function loadWithAdmin({ getApps = () => [], cert = jest.fn(() => 'credential') } = {}) {
    const initializeApp = jest.fn(() => ({ name: 'app' }));
    jest.doMock('firebase-admin/app', () => ({ initializeApp, cert, getApps }));
    jest.doMock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: jest.fn() }) }));
    return { ...load(), initializeApp, cert };
  }

  it('initialises the Admin SDK only once, however often it is asked for', () => {
    process.env[VARIABLE] = writeFile('ok.json', SHAPE_ONLY_KEY);
    const { firebaseApp, initializeApp } = loadWithAdmin();
    const first = firebaseApp();
    expect(firebaseApp()).toBe(first);
    expect(firebaseApp()).toBe(first);
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('reuses an app that already exists instead of creating another', () => {
    const existing = { name: 'already-there' };
    const { firebaseApp, initializeApp } = loadWithAdmin({ getApps: () => [existing] });
    expect(firebaseApp()).toBe(existing);
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('wraps a key the SDK refuses in a clear configuration error', () => {
    process.env[VARIABLE] = writeFile('ok.json', SHAPE_ONLY_KEY);
    const { firebaseApp, FirebaseConfigError } = loadWithAdmin({ cert: jest.fn(() => { throw new Error('Failed to parse private key'); }) });
    expect(() => firebaseApp()).toThrow(FirebaseConfigError);
    expect(() => firebaseApp()).toThrow(/could not be used: Failed to parse private key/);
  });

  it('assertFirebaseConfigured passes with a complete key and throws a clear error without one', () => {
    process.env[VARIABLE] = writeFile('ok.json', SHAPE_ONLY_KEY);
    expect(() => loadWithAdmin().assertFirebaseConfigured()).not.toThrow();

    process.env[VARIABLE] = path.join(dir, 'gone.json');
    const broken = loadWithAdmin();
    expect(() => broken.assertFirebaseConfigured()).toThrow(broken.FirebaseConfigError);
    expect(() => broken.assertFirebaseConfigured()).toThrow(/does not exist/);

    delete process.env[VARIABLE];
    expect(() => loadWithAdmin().assertFirebaseConfigured()).toThrow(/is not set/);
  });

  it('does not treat a configuration problem as a wrong code from the user', async () => {
    process.env[VARIABLE] = path.join(dir, 'gone.json');
    const { verifyPhoneProof, FirebaseConfigError, PhoneProofError } = loadWithAdmin();
    const error = await verifyPhoneProof('some-token').catch((err) => err);
    expect(error).toBeInstanceOf(FirebaseConfigError);
    expect(error).not.toBeInstanceOf(PhoneProofError);
  });
});
