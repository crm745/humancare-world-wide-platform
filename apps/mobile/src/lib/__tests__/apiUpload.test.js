/* global describe, test, expect, jest, beforeEach, afterAll, __dirname */
// apiUpload: the optional `fields` (extra multipart text fields, e.g. replacesDocumentId) on native and
// web, and that an upload without them, its progress and its 401 retry are unchanged. Nothing here
// touches the network, a device or a database: the platform, file system, session and fetch are fakes.

// babel-preset-expo turns `process.env.EXPO_PUBLIC_*` in api.js into an import of this ESM-only module.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({
  createUploadTask: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
}));
jest.mock('../session', () => ({
  getAccessToken: jest.fn(),
  getRefreshToken: jest.fn(),
  saveTokens: jest.fn(),
  compareAndSaveTokens: jest.fn(),
  clearTokens: jest.fn(),
  compareAndClearTokens: jest.fn(),
}));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));

const { Platform } = require('react-native');
const FileSystem = require('expo-file-system/legacy');
const session = require('../session');
const { navReplace } = require('../nav');
const { setApiAuthStatus } = require('../authGuard');
const { apiUpload } = require('../api');

const PATH = '/requests/me/5/documents';
const FILE = { uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' };
const OK_BODY = JSON.stringify({ document: { id: 9, name: 'report.pdf' } });

// ---- native: expo-file-system's upload task ------------------------------------------------------

// Queues the answers of successive upload tasks; every task made is kept for the assertions.
function fakeNativeServer(...results) {
  const tasks = [];
  FileSystem.createUploadTask.mockImplementation((url, uri, options, onProgress) => {
    const result = results.shift() || { status: 201, body: OK_BODY };
    const task = { url, uri, options, onProgress, uploadAsync: jest.fn(async () => result) };
    tasks.push(task);
    return task;
  });
  return tasks;
}

// ---- web: XMLHttpRequest + fetch -----------------------------------------------------------------

class FakeXHR {
  constructor() {
    this.upload = {};
    this.headers = {};
    FakeXHR.instances.push(this);
  }

  open(method, url) { this.method = method; this.url = url; }

  setRequestHeader(key, value) { this.headers[key] = value; }

  send(form) {
    this.form = form;
    const answer = FakeXHR.answers.shift() || { status: 201, body: OK_BODY };
    this.status = answer.status;
    this.responseText = answer.body;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
      this.onload();
    });
  }
}
FakeXHR.instances = [];
FakeXHR.answers = [];

const realFetch = global.fetch;
const realXHR = global.XMLHttpRequest;

function fakeFetch(refresh = { ok: true, json: { token: 'new-token', refreshToken: 'new-refresh' } }, me = { status: 200 }) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(url);
    if (String(url).endsWith('/auth/refresh') && refresh.throws) throw new TypeError('Network request failed');
    if (String(url).endsWith('/auth/me')) return { ok: me.status < 400, status: me.status, json: async () => ({}) };
    if (String(url).endsWith('/auth/refresh')) return { ok: refresh.ok, status: refresh.ok ? 200 : (refresh.status || 401), json: async () => refresh.json };
    return { blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }; // the picked file's blob: URL
  });
  return calls;
}

const entries = (form) => [...form.entries()];

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  session.getAccessToken.mockResolvedValue('tok');
  session.getRefreshToken.mockResolvedValue('rt');
  // Like the real session store: after a refresh, the next read returns the new token.
  session.compareAndSaveTokens.mockImplementation(async ({ token }) => { session.getAccessToken.mockResolvedValue(token); return true; });
  setApiAuthStatus('authed'); // a signed-in person: protected calls are sent
  session.clearTokens.mockResolvedValue(undefined);
  session.compareAndClearTokens.mockResolvedValue('cleared');
  FakeXHR.instances = [];
  FakeXHR.answers = [];
  global.XMLHttpRequest = FakeXHR;
  fakeFetch();
});

afterAll(() => {
  global.fetch = realFetch;
  global.XMLHttpRequest = realXHR;
});

describe('apiUpload on native', () => {
  test('without fields it sends the file exactly as before: same endpoint, field, headers, no parameters', async () => {
    const tasks = fakeNativeServer();
    const data = await apiUpload(PATH, FILE);
    expect(data).toEqual({ document: { id: 9, name: 'report.pdf' } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toMatch(/\/requests\/me\/5\/documents$/);
    expect(tasks[0].uri).toBe(FILE.uri);
    expect(tasks[0].options).toEqual({
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: 'application/pdf',
      headers: { Authorization: 'Bearer tok' },
    });
    expect(tasks[0].options).not.toHaveProperty('parameters');
  });

  test('empty or all-blank fields add no parameters', async () => {
    for (const fields of [undefined, null, {}, { replacesDocumentId: undefined }, { replacesDocumentId: null }, { replacesDocumentId: '' }]) {
      const tasks = fakeNativeServer();
      await apiUpload(PATH, FILE, false, undefined, fields);
      expect(tasks[0].options).not.toHaveProperty('parameters');
    }
  });

  test('replacesDocumentId goes in the upload task parameters, as text, next to the same file field', async () => {
    const tasks = fakeNativeServer();
    await apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 });
    expect(tasks[0].options.parameters).toEqual({ replacesDocumentId: '12' });
    expect(tasks[0].options.fieldName).toBe('file');
    expect(tasks[0].options.uploadType).toBe(FileSystem.FileSystemUploadType.MULTIPART);
    expect(tasks[0].url).toMatch(/\/requests\/me\/5\/documents$/);
    expect(tasks[0].options.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  test('a `file` key in fields cannot replace the file field', async () => {
    const tasks = fakeNativeServer();
    await apiUpload(PATH, FILE, false, undefined, { file: 'evil', replacesDocumentId: 3 });
    expect(tasks[0].options.parameters).toEqual({ replacesDocumentId: '3' });
    expect(tasks[0].options.fieldName).toBe('file');
  });

  test('progress is reported as a fraction, with or without fields', async () => {
    for (const fields of [undefined, { replacesDocumentId: 12 }]) {
      const tasks = fakeNativeServer();
      const seen = [];
      await apiUpload(PATH, FILE, false, (p) => seen.push(p), fields);
      tasks[0].onProgress({ totalBytesSent: 50, totalBytesExpectedToSend: 100 });
      tasks[0].onProgress({ totalBytesSent: 0, totalBytesExpectedToSend: 0 }); // unknown size: ignored
      expect(seen).toEqual([0.5]);
    }
  });

  test('a 401 refreshes the session and retries once, keeping the fields and using the new token', async () => {
    const tasks = fakeNativeServer({ status: 401, body: '{}' }, { status: 201, body: OK_BODY });
    const data = await apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 });
    expect(data.document.id).toBe(9);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].options.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(tasks[1].options.headers).toEqual({ Authorization: 'Bearer new-token' });
    expect(tasks[1].options.parameters).toEqual({ replacesDocumentId: '12' });
    expect(session.compareAndSaveTokens).toHaveBeenCalledWith({ expectedRefreshToken: 'rt', token: 'new-token', refreshToken: 'new-refresh' });
  });

  test('a 401 retry without fields still sends none', async () => {
    const tasks = fakeNativeServer({ status: 401, body: '{}' }, { status: 201, body: OK_BODY });
    await apiUpload(PATH, FILE);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].options).not.toHaveProperty('parameters');
  });

  test('a session that cannot be renewed signs out and rejects', async () => {
    fakeFetch({ ok: false, json: { error: 'Session expired' } });
    fakeNativeServer({ status: 401, body: '{}' });
    await expect(apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 })).rejects.toThrow('Your session expired. Please log in again.');
    expect(session.compareAndClearTokens).toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith('/login');
  });

  test('a server error carries the server message; a failure without one gets the default', async () => {
    fakeNativeServer({ status: 400, body: JSON.stringify({ error: 'The document to replace was not found.' }) });
    await expect(apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 99 })).rejects.toThrow('The document to replace was not found.');
    fakeNativeServer({ status: 500, body: 'not json' });
    await expect(apiUpload(PATH, FILE)).rejects.toThrow('Upload failed. Please try again.');
  });
});

describe('apiUpload on native: refresh failures (revision 3)', () => {
  const kept = () => {
    expect(session.compareAndClearTokens).not.toHaveBeenCalled();
    expect(navReplace).not.toHaveBeenCalled();
  };
  test('a network failure while refreshing keeps the credentials and says the server could not be reached', async () => {
    fakeFetch({ throws: true });
    fakeNativeServer({ status: 401, body: '{}' });
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'network' });
    kept();
  });
  test.each([[500], [503]])('a refresh answering HTTP %i keeps the credentials', async (status) => {
    fakeFetch({ ok: false, status, json: { error: 'down' } });
    fakeNativeServer({ status: 401, body: '{}' });
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'network' });
    kept();
  });
  test('an invalid refresh token (401) signs out and goes to Login', async () => {
    fakeFetch({ ok: false, status: 401, json: { error: 'Invalid or expired refresh token' } });
    fakeNativeServer({ status: 401, body: '{}' });
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_expired' });
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('a retry that also answers 401: signed out only if the server says the session is invalid', async () => {
    fakeFetch(undefined, { status: 401 });
    fakeNativeServer({ status: 401, body: '{}' }, { status: 401, body: '{}' });
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_expired' });
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    session.getAccessToken.mockResolvedValue('tok');
    session.getRefreshToken.mockResolvedValue('rt');
    session.compareAndSaveTokens.mockImplementation(async ({ token }) => { session.getAccessToken.mockResolvedValue(token); return true; });
    session.clearTokens.mockResolvedValue(undefined);
  session.compareAndClearTokens.mockResolvedValue('cleared');
    fakeFetch(undefined, { status: 200 }); // the session is fine: the 401 was the endpoint's own
    fakeNativeServer({ status: 401, body: '{}' }, { status: 401, body: JSON.stringify({ error: 'Not allowed' }) });
    await expect(apiUpload(PATH, FILE)).rejects.toThrow('Not allowed');
    kept();
  });
  test('while the session is unresolved nothing is uploaded', async () => {
    const { setApiAuthStatus } = require('../authGuard');
    setApiAuthStatus('unreachable');
    const tasks = fakeNativeServer();
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_unverified' });
    expect(tasks).toHaveLength(0);
  });
});

describe('apiUpload on web', () => {
  beforeEach(() => { Platform.OS = 'web'; });

  test('without fields the form holds only the file, sent with the same header and endpoint', async () => {
    const data = await apiUpload(PATH, FILE);
    expect(data).toEqual({ document: { id: 9, name: 'report.pdf' } });
    const [xhr] = FakeXHR.instances;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toMatch(/\/requests\/me\/5\/documents$/);
    expect(xhr.headers).toEqual({ Authorization: 'Bearer tok' });
    const sent = entries(xhr.form);
    expect(sent.map(([key]) => key)).toEqual(['file']);
    expect(sent[0][1].name).toBe('report.pdf');
    expect(sent[0][1].type).toBe('application/pdf');
  });

  test('empty or all-blank fields add nothing to the form', async () => {
    for (const fields of [undefined, null, {}, { replacesDocumentId: null }, { replacesDocumentId: '' }]) {
      await apiUpload(PATH, FILE, false, undefined, fields);
      expect(entries(FakeXHR.instances.at(-1).form).map(([key]) => key)).toEqual(['file']);
    }
  });

  test('replacesDocumentId is appended to the form as text, with the file still in `file`', async () => {
    await apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 });
    const sent = entries(FakeXHR.instances[0].form);
    expect(sent.map(([key]) => key)).toEqual(['replacesDocumentId', 'file']);
    expect(sent[0][1]).toBe('12');
    expect(sent[1][1].name).toBe('report.pdf');
  });

  test('a `file` key in fields cannot add a second file entry', async () => {
    await apiUpload(PATH, FILE, false, undefined, { file: 'evil', replacesDocumentId: 3 });
    const keys = entries(FakeXHR.instances[0].form).map(([key]) => key);
    expect(keys.filter((key) => key === 'file')).toHaveLength(1);
    expect(keys).toContain('replacesDocumentId');
  });

  test('progress is reported as a fraction', async () => {
    const seen = [];
    await apiUpload(PATH, FILE, false, (p) => seen.push(p), { replacesDocumentId: 12 });
    expect(seen).toEqual([0.25]);
  });

  test('a 401 refreshes the session and retries once, keeping the fields and using the new token', async () => {
    FakeXHR.answers = [{ status: 401, body: '{}' }, { status: 201, body: OK_BODY }];
    const data = await apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 });
    expect(data.document.id).toBe(9);
    expect(FakeXHR.instances).toHaveLength(2);
    expect(FakeXHR.instances[0].headers).toEqual({ Authorization: 'Bearer tok' });
    expect(FakeXHR.instances[1].headers).toEqual({ Authorization: 'Bearer new-token' });
    expect(entries(FakeXHR.instances[1].form).find(([key]) => key === 'replacesDocumentId')[1]).toBe('12');
  });

  test('a session that cannot be renewed signs out and rejects', async () => {
    fakeFetch({ ok: false, json: { error: 'Session expired' } });
    FakeXHR.answers = [{ status: 401, body: '{}' }];
    await expect(apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 12 })).rejects.toThrow('Your session expired. Please log in again.');
    expect(session.compareAndClearTokens).toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith('/login');
  });

  test('a server error carries the server message', async () => {
    FakeXHR.answers = [{ status: 400, body: JSON.stringify({ error: 'The document to replace was not found.' }) }];
    await expect(apiUpload(PATH, FILE, false, undefined, { replacesDocumentId: 99 })).rejects.toThrow('The document to replace was not found.');
  });
});

describe('apiUpload on web: refresh failures (revision 3)', () => {
  beforeEach(() => { Platform.OS = 'web'; });
  const kept = () => {
    expect(session.compareAndClearTokens).not.toHaveBeenCalled();
    expect(navReplace).not.toHaveBeenCalled();
  };
  test('a network failure while refreshing keeps the credentials', async () => {
    fakeFetch({ throws: true });
    FakeXHR.answers = [{ status: 401, body: '{}' }];
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'network' });
    kept();
  });
  test.each([[500], [503]])('a refresh answering HTTP %i keeps the credentials', async (status) => {
    fakeFetch({ ok: false, status, json: { error: 'down' } });
    FakeXHR.answers = [{ status: 401, body: '{}' }];
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'network' });
    kept();
  });
  test('an invalid refresh token (401) signs out and goes to Login', async () => {
    fakeFetch({ ok: false, status: 401, json: { error: 'Invalid or expired refresh token' } });
    FakeXHR.answers = [{ status: 401, body: '{}' }];
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_expired' });
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('a retry that also answers 401, with the server confirming the session is invalid, signs out', async () => {
    fakeFetch(undefined, { status: 401 });
    FakeXHR.answers = [{ status: 401, body: '{}' }, { status: 401, body: '{}' }];
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_expired' });
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
  });
  test('a retry that fails with an ordinary error after a good refresh does not sign out', async () => {
    FakeXHR.answers = [{ status: 401, body: '{}' }, { status: 400, body: JSON.stringify({ error: 'Bad file' }) }];
    await expect(apiUpload(PATH, FILE)).rejects.toThrow('Bad file');
    kept();
  });
  test('while the session is unresolved nothing is uploaded', async () => {
    const { setApiAuthStatus } = require('../authGuard');
    setApiAuthStatus('error');
    await expect(apiUpload(PATH, FILE)).rejects.toMatchObject({ code: 'session_unverified' });
    expect(FakeXHR.instances).toHaveLength(0);
  });
});

describe('existing callers', () => {
  test('the create flow and the retry screen are untouched: they still call apiUpload with four arguments and no fields', () => {
    const fs = require('fs');
    const path = require('path');
    for (const file of ['../../app/request/review.js', '../../app/request/submitted.js']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).toMatch(/apiUpload\(`\/requests\/me\/\$\{[\w.]+\}\/documents`, [\w.[\]]+, false, [^,)]+\)/);
      expect(source).not.toMatch(/replacesDocumentId/);
    }
  });
});
