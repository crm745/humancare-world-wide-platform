/* global describe, test, expect, jest, beforeEach, afterAll, __dirname */
// apiDownload on its own: the authenticated file download shares the session rules of apiFetch and apiUpload.
// The platform, file system, session and fetch are fakes; nothing touches a network, a device or a database.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: jest.fn(),
  deleteAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  createUploadTask: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
}));
jest.mock('../session', () => ({
  getAccessToken: jest.fn(), getRefreshToken: jest.fn(), saveTokens: jest.fn(),
  compareAndSaveTokens: jest.fn(), compareAndClearTokens: jest.fn(), clearTokens: jest.fn(),
}));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));

const { Platform } = require('react-native');
const FileSystem = require('expo-file-system/legacy');
const session = require('../session');
const { navReplace } = require('../nav');
const { setApiAuthStatus } = require('../authGuard');
const { apiDownload } = require('../api');

const PATH = '/documents/7/file';
const DEST = 'file:///cache/1-report.pdf';
const realFetch = global.fetch;

// ---- web: a fetch that answers in order ----------------------------------------------------------------------
function webBody(chunks) {
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) };
}
function fileResponse(chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])], headers = { 'content-length': '6', 'content-type': 'application/pdf' }) {
  return { ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: webBody(chunks), blob: async () => new Blob(chunks), json: async () => ({}) };
}
const answer = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, body: null, blob: async () => new Blob([]), json: async () => body });

// Which URL a call went to, and the Authorization header it carried.
const calls = () => global.fetch.mock.calls.map(([url, init]) => ({ url: String(url).replace(/^.*:4000/, ''), auth: init && init.headers && init.headers.Authorization }));
const fileCalls = () => calls().filter((c) => c.url === PATH);

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'web';
  setApiAuthStatus('authed');
  session.getAccessToken.mockResolvedValue('tok');
  session.getRefreshToken.mockResolvedValue('rt');
  session.compareAndSaveTokens.mockImplementation(async ({ token }) => { session.getAccessToken.mockResolvedValue(token); return true; });
  session.compareAndClearTokens.mockResolvedValue('cleared');
  FileSystem.deleteAsync.mockResolvedValue(undefined);
  global.fetch = jest.fn();
});
afterAll(() => { global.fetch = realFetch; });

describe('apiDownload on web', () => {
  test('sends the saved token and resolves the file as a blob, reporting progress up to 1', async () => {
    global.fetch.mockResolvedValue(fileResponse());
    const seen = [];
    const { blob } = await apiDownload(PATH, { onProgress: (p) => seen.push(p) });
    expect(fileCalls()).toEqual([{ url: PATH, auth: 'Bearer tok' }]);
    expect(blob.size).toBe(6);
    expect(blob.type).toBe('application/pdf');
    expect(seen).toEqual([4 / 6, 1, 1]);
    expect(seen.every((p, i) => i === 0 || p >= seen[i - 1])).toBe(true);
  });
  test('without a size from the server there is no partial progress, only the end', async () => {
    global.fetch.mockResolvedValue(fileResponse(undefined, { 'content-type': 'application/pdf' }));
    const seen = [];
    await apiDownload(PATH, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([1]);
  });
  test('a body that cannot be streamed is read whole', async () => {
    global.fetch.mockResolvedValue({ ...fileResponse(), body: null });
    const seen = [];
    const { blob } = await apiDownload(PATH, { onProgress: (p) => seen.push(p) });
    expect(blob.size).toBe(6);
    expect(seen).toEqual([1]);
  });

  test('a 401 renews the session ONCE and tries again with the new token', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return answer(200, { token: 'new-tok', refreshToken: 'new-r' });
      return fileCalls().length === 0 ? answer(401, { error: 'Token expired' }) : fileResponse();
    });
    // fileCalls() counts the calls made so far, including this one, so the first call is the one that sees 1
    global.fetch.mockImplementationOnce(async () => answer(401, { error: 'Token expired' }));
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? answer(200, { token: 'new-tok', refreshToken: 'new-r' }) : fileResponse()));
    await expect(apiDownload(PATH)).resolves.toHaveProperty('blob');
    expect(calls().map((c) => c.url)).toEqual([PATH, '/auth/refresh', PATH]);
    expect(calls()[2].auth).toBe('Bearer new-tok');
    expect(session.compareAndSaveTokens).toHaveBeenCalledTimes(1);
  });
  test('two 401s in a row do not loop: one refresh, two attempts, then the session is checked once', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return answer(200, { token: 'new-tok', refreshToken: 'new-r' });
      if (String(url).endsWith('/auth/me')) return answer(401, { error: 'Invalid token' });
      return answer(401, { error: 'Invalid token' });
    });
    await expect(apiDownload(PATH)).rejects.toMatchObject({ code: 'session_expired' });
    const urls = calls().map((c) => c.url);
    expect(urls).toEqual([PATH, '/auth/refresh', PATH, '/auth/me']);
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
  test('a second 401 that the server does not call an invalid session ends nothing', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return answer(200, { token: 'new-tok', refreshToken: 'new-r' });
      if (String(url).endsWith('/auth/me')) return answer(200, { user: {} });
      return answer(401, { error: 'Not yours' });
    });
    await expect(apiDownload(PATH)).rejects.toMatchObject({ status: 401, message: 'Not yours' });
    expect(session.compareAndClearTokens).not.toHaveBeenCalled();
    expect(navReplace).not.toHaveBeenCalled();
  });
  test('a refused refresh token signs out through the same guarded path (no second download attempt)', async () => {
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? answer(401, { error: 'Invalid or expired refresh token' }) : answer(401, { error: 'Token expired' })));
    await expect(apiDownload(PATH)).rejects.toMatchObject({ code: 'session_expired' });
    expect(fileCalls()).toHaveLength(1);
    expect(session.compareAndClearTokens).toHaveBeenCalledWith('tok');
  });
  test('a refresh that cannot reach the server keeps the credentials', async () => {
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) throw new TypeError('Network request failed');
      return answer(401, { error: 'Token expired' });
    });
    await expect(apiDownload(PATH)).rejects.toMatchObject({ code: 'network' });
    expect(session.compareAndClearTokens).not.toHaveBeenCalled();
  });
  test('concurrent downloads with an expired token share one refresh', async () => {
    let refreshes = 0;
    const first = new Set();
    global.fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) { refreshes += 1; return answer(200, { token: 'new-tok', refreshToken: 'new-r' }); }
      const key = String(url);
      const hadToken = session.getAccessToken.mock.results.length;
      if (!first.has(key + hadToken) && first.size < 2) { first.add(key + hadToken); return answer(401, { error: 'Token expired' }); }
      return fileResponse();
    });
    await Promise.all([apiDownload('/documents/1/file'), apiDownload('/documents/2/file')]);
    expect(refreshes).toBe(1);
  });

  test.each([
    [404, { error: 'Document not found' }, 'Document not found', undefined],
    [409, { error: 'This document has not passed its virus scan and approval, so it will not be opened.', code: 'document_not_clean' }, 'This document has not passed its virus scan and approval, so it will not be opened.', 'document_not_clean'],
    [500, null, 'Download failed. Please try again.', undefined],
  ])('HTTP %i rejects with its status, the server\'s words and code', async (status, body, message, code) => {
    global.fetch.mockResolvedValue(answer(status, body));
    await expect(apiDownload(PATH)).rejects.toMatchObject({ status, message, code });
    expect(fileCalls()).toHaveLength(1); // no retry for anything but a 401
  });
  test('a network failure rejects with code "network" and keeps the session', async () => {
    global.fetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(apiDownload(PATH)).rejects.toMatchObject({ code: 'network' });
    expect(session.compareAndClearTokens).not.toHaveBeenCalled();
  });

  test('held while the session is unresolved: nothing is sent', async () => {
    for (const status of ['unreachable', 'error', 'anon']) {
      setApiAuthStatus(status);
      await expect(apiDownload(PATH)).rejects.toBeTruthy();
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('while loading it waits and is sent once the session is valid', async () => {
    setApiAuthStatus('loading');
    global.fetch.mockResolvedValue(fileResponse());
    const pending = apiDownload(PATH);
    await new Promise((r) => setTimeout(r, 20));
    expect(global.fetch).not.toHaveBeenCalled();
    setApiAuthStatus('authed');
    await pending;
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('no saved token: nothing is sent, the person goes to Login', async () => {
    session.getAccessToken.mockResolvedValue(null);
    await expect(apiDownload(PATH)).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(navReplace).toHaveBeenCalledWith('/login');
  });
});

// ---- phone: expo-file-system's resumable download -------------------------------------------------------------
function fakeNative(...results) {
  const tasks = [];
  FileSystem.createDownloadResumable.mockImplementation((url, destination, options, onProgress) => {
    const result = results.shift() || { status: 200, uri: destination };
    const task = { url, destination, options, onProgress, downloadAsync: jest.fn(async () => (typeof result === 'function' ? result() : result)) };
    tasks.push(task);
    return task;
  });
  return tasks;
}

describe('apiDownload on a phone', () => {
  beforeEach(() => { Platform.OS = 'ios'; });

  test('downloads into the destination with the saved token and resolves its uri; progress follows the bytes', async () => {
    const tasks = fakeNative();
    const seen = [];
    const out = await apiDownload(PATH, { destination: DEST, onProgress: (p) => seen.push(p) });
    expect(out).toEqual({ uri: DEST });
    expect(tasks[0].url).toMatch(/\/documents\/7\/file$/);
    expect(tasks[0].destination).toBe(DEST);
    expect(tasks[0].options).toEqual({ headers: { Authorization: 'Bearer tok' } });
    tasks[0].onProgress({ totalBytesWritten: 50, totalBytesExpectedToWrite: 200 });
    tasks[0].onProgress({ totalBytesWritten: 200, totalBytesExpectedToWrite: 200 });
    tasks[0].onProgress({ totalBytesWritten: 10, totalBytesExpectedToWrite: 0 }); // unknown size: ignored
    expect(seen).toEqual([0.25, 1]);
  });
  test('a 401 renews the session once and downloads again with the new token; the error body is removed', async () => {
    const tasks = fakeNative({ status: 401, uri: DEST }, { status: 200, uri: DEST });
    FileSystem.readAsStringAsync.mockResolvedValue(JSON.stringify({ error: 'Token expired' }));
    global.fetch.mockResolvedValue(answer(200, { token: 'new-tok', refreshToken: 'new-r' })); // /auth/refresh
    await expect(apiDownload(PATH, { destination: DEST })).resolves.toEqual({ uri: DEST });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].options.headers.Authorization).toBe('Bearer tok');
    expect(tasks[1].options.headers.Authorization).toBe('Bearer new-tok');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(DEST, { idempotent: true });
    expect(session.compareAndSaveTokens).toHaveBeenCalledTimes(1);
  });
  test('two 401s do not loop: two downloads, one refresh, one session check, then sign-out', async () => {
    const tasks = fakeNative({ status: 401, uri: DEST }, { status: 401, uri: DEST });
    FileSystem.readAsStringAsync.mockResolvedValue('{}');
    global.fetch.mockImplementation(async (url) => (String(url).endsWith('/auth/refresh') ? answer(200, { token: 'new-tok', refreshToken: 'new-r' }) : answer(401, { error: 'Invalid token' })));
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toMatchObject({ code: 'session_expired' });
    expect(tasks).toHaveLength(2);
    expect(calls().map((c) => c.url)).toEqual(['/auth/refresh', '/auth/me']);
    expect(session.compareAndClearTokens).toHaveBeenCalledTimes(1);
  });
  test('a failure answer is read for its message, the file it was written to is deleted, and nothing is shared', async () => {
    fakeNative({ status: 409, uri: DEST });
    FileSystem.readAsStringAsync.mockResolvedValue(JSON.stringify({ error: 'This document has not passed its virus scan and approval, so it will not be opened.', code: 'document_not_clean' }));
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toMatchObject({ status: 409, code: 'document_not_clean', message: expect.stringContaining('virus scan') });
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(DEST, { idempotent: true });
  });
  test('a failure answer that is not JSON still ends in a clear error and a deleted file', async () => {
    fakeNative({ status: 500, uri: DEST });
    FileSystem.readAsStringAsync.mockRejectedValue(new Error('not text'));
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toMatchObject({ status: 500, message: 'Download failed. Please try again.' });
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });
  test('a download that throws, or that returns nothing, is a network failure and leaves no file', async () => {
    fakeNative(() => { throw new Error('offline'); });
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toMatchObject({ code: 'network' });
    fakeNative(() => undefined);
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toMatchObject({ code: 'network' });
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(2);
  });
  test('held while the session is unresolved: no download starts', async () => {
    const tasks = fakeNative();
    setApiAuthStatus('unreachable');
    await expect(apiDownload(PATH, { destination: DEST })).rejects.toBeTruthy();
    expect(tasks).toHaveLength(0);
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });
});

describe('the same code path', () => {
  test('apiDownload reuses the session helpers of apiFetch and apiUpload (no second refresh mechanism)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
    const body = source.slice(source.indexOf('export async function apiDownload'));
    expect(body).toContain('await renewSession(token)');
    expect(body).toContain('await endSessionIfInvalid(token)');
    expect(body).toContain('ensureAuthenticated()');
    expect(body).not.toMatch(/refreshAccessToken|runRefresh|fetch\(`\$\{API_URL\}\/auth\/refresh/);
    expect(body).not.toContain('/auth/me'); // it is not used as a refresh trigger
    expect(body).not.toMatch(/signIn/);
  });
});
