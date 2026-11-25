/* global describe, test, expect, jest, beforeEach, afterAll */
// Phase 5: apiUpload's cancel, stall timeout and failure classification, on native and web. The platform, file system, session and fetch are fakes: nothing touches the network or a device.
// An upload is a write. Once the transfer has begun the server may have the file with only the answer lost, so a lost connection, a stall and a cancel after the start are UNKNOWN outcomes
// (`outcomeUnknown`); only a cancel before anything was sent is certain (`notProcessed`).
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
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
const { setApiAuthStatus } = require('../authGuard');
const { apiUpload } = require('../api');
const { classifyUploadFailure } = require('../uploadRecovery');
const { createStallWatch, UPLOAD_NETWORK_MESSAGE, UPLOAD_TIMEOUT_MESSAGE } = require('../uploadErrors');

const PATH = '/requests/me/5/documents';
const FILE = { uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' };
const ID = '11111111-1111-4111-8111-111111111111';
const OK_BODY = JSON.stringify({ document: { id: 9, name: 'report.pdf' } });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A native upload task that stays open until it is cancelled or answered, like a transfer in flight.
function openTask() {
  const task = { cancelled: false };
  task.uploadAsync = jest.fn(() => new Promise((resolve) => { task.answer = resolve; }));
  task.cancelAsync = jest.fn(async () => { task.cancelled = true; task.answer(undefined); }); // a cancelled task resolves with nothing
  FileSystem.createUploadTask.mockImplementation((url, uri, options, onProgress) => { task.url = url; task.options = options; task.onProgress = onProgress; return task; });
  return task;
}

class HangXHR {
  constructor() { this.upload = {}; this.headers = {}; HangXHR.instances.push(this); }

  open(method, url) { this.method = method; this.url = url; }

  setRequestHeader(key, value) { this.headers[key] = value; }

  send(form) { this.form = form; this.sent = true; }

  abort() { this.aborted = true; if (this.onabort) this.onabort(); }
}
HangXHR.instances = [];

const realFetch = global.fetch;
const realXHR = global.XMLHttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  session.getAccessToken.mockResolvedValue('tok');
  session.getRefreshToken.mockResolvedValue('rt');
  setApiAuthStatus('authed');
  HangXHR.instances = [];
  global.XMLHttpRequest = HangXHR;
  global.fetch = jest.fn(async () => ({ blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }) }));
});
afterAll(() => { global.fetch = realFetch; global.XMLHttpRequest = realXHR; });

describe('native: cancelling', () => {
  test('before the transfer began: nothing was sent, certain (notProcessed), and no upload task is even made', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await apiUpload(PATH, FILE, false, undefined, undefined, { signal: controller.signal }).catch((e) => e);
    expect(error).toMatchObject({ code: 'cancelled', cancelled: true, notProcessed: true, outcomeUnknown: false });
    expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
    expect(classifyUploadFailure(error)).toBe('notSent'); // the file stays pending: it can simply be sent
  });

  test('after the transfer began: the outcome is UNKNOWN, the task is cancelled, and it is never called failed', async () => {
    const task = openTask();
    const controller = new AbortController();
    const pending = apiUpload(PATH, FILE, false, undefined, { clientUploadId: ID }, { signal: controller.signal });
    await tick(5);
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(task.cancelAsync).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'cancelled', cancelled: true, outcomeUnknown: true });
    expect(error.notProcessed).toBeUndefined();
    expect(classifyUploadFailure(error)).toBe('unconfirmed');
    expect(error.message).toMatch(/cannot tell whether the file was received/);
  });

  test('the upload carries the file\'s own id as a multipart field', async () => {
    const task = openTask();
    const pending = apiUpload(PATH, FILE, false, undefined, { clientUploadId: ID, replacesDocumentId: 12 }, {});
    await tick(5);
    expect(task.options.parameters).toEqual({ clientUploadId: ID, replacesDocumentId: '12' });
    task.answer({ status: 201, body: OK_BODY });
    await expect(pending).resolves.toEqual({ document: { id: 9, name: 'report.pdf' } });
  });
});

describe('native: no progress means stalled (no fixed total duration)', () => {
  test('an upload that stops moving ends as a timeout, which is an UNKNOWN outcome, and its task is cancelled', async () => {
    const task = openTask();
    const error = await apiUpload(PATH, FILE, false, undefined, undefined, { stallTimeoutMs: 25 }).catch((e) => e);
    expect(task.cancelAsync).toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'timeout', failure: 'timeout', outcomeUnknown: true });
    expect(error.message).toBe(UPLOAD_TIMEOUT_MESSAGE);
    expect(classifyUploadFailure(error)).toBe('unconfirmed');
  });

  test('progress keeps it alive: a transfer longer than the stall window still completes, and the progress callbacks are unchanged', async () => {
    const task = openTask();
    const seen = [];
    const pending = apiUpload(PATH, FILE, false, (fraction) => seen.push(fraction), undefined, { stallTimeoutMs: 60 });
    await tick(5);
    for (const sent of [25, 50, 75, 100]) {
      task.onProgress({ totalBytesSent: sent, totalBytesExpectedToSend: 100 });
      await tick(35); // 140 ms in all: far more than one stall window, but never 60 ms without progress...
    }
    task.answer({ status: 201, body: OK_BODY });
    await expect(pending).resolves.toEqual({ document: { id: 9, name: 'report.pdf' } });
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
  });

  test('once every byte is sent the server may still be scanning: the wait for its answer is longer than the stall window', () => {
    const fired = jest.fn();
    jest.useFakeTimers();
    const watch = createStallWatch({ stallMs: 1000, responseMs: 5000, onStall: fired });
    watch.start();
    watch.touch(true); // everything sent
    jest.advanceTimersByTime(4000);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1500);
    expect(fired).toHaveBeenCalledTimes(1);
    watch.stop();
    jest.useRealTimers();
  });
});

describe('native: how a failure is classified', () => {
  test('a lost connection (the task throws) is an UNKNOWN outcome with a plain message, never a raw error', async () => {
    const task = { uploadAsync: jest.fn(async () => { throw new TypeError('Network request failed'); }) };
    FileSystem.createUploadTask.mockImplementation(() => task);
    const error = await apiUpload(PATH, FILE).catch((e) => e);
    expect(error).toMatchObject({ code: 'network', failure: 'network', outcomeUnknown: true });
    expect(error.message).toBe(UPLOAD_NETWORK_MESSAGE);
    expect(error.message).not.toMatch(/Network request failed/);
    expect(classifyUploadFailure(error)).toBe('unconfirmed');
  });

  test('a 5xx is unknown (the server may have processed it); a 4xx is a refusal; a 401 that cannot be renewed is not-sent', async () => {
    FileSystem.createUploadTask.mockImplementation(() => ({ uploadAsync: async () => ({ status: 503, body: '{"error":"busy"}' }) }));
    const server = await apiUpload(PATH, FILE).catch((e) => e);
    expect(server).toMatchObject({ status: 503, failure: 'server' });
    expect(classifyUploadFailure(server)).toBe('unconfirmed');
    FileSystem.createUploadTask.mockImplementation(() => ({ uploadAsync: async () => ({ status: 422, body: '{"error":"Unsupported file type.","code":"bad_type"}' }) }));
    const refused = await apiUpload(PATH, FILE).catch((e) => e);
    expect(refused).toMatchObject({ status: 422, code: 'bad_type', message: 'Unsupported file type.' });
    expect(classifyUploadFailure(refused)).toBe('refused');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 401, notProcessed: true }))).toBe('notSent');
  });

  test('a plain error nobody recognises is treated as unknown, never as "not received"', () => {
    expect(classifyUploadFailure(new Error('something'))).toBe('unconfirmed');
    expect(classifyUploadFailure(undefined)).toBe('unconfirmed');
    expect(classifyUploadFailure(Object.assign(new Error('x'), { status: 409 }))).toBe('refused');
  });
});

describe('web: the same rules over XMLHttpRequest', () => {
  beforeEach(() => { Platform.OS = 'web'; });

  test('a cancel before anything was sent is certain; a cancel after xhr.send is unknown', async () => {
    const early = new AbortController();
    early.abort();
    const before = await apiUpload(PATH, FILE, false, undefined, undefined, { signal: early.signal }).catch((e) => e);
    expect(before).toMatchObject({ code: 'cancelled', notProcessed: true, outcomeUnknown: false });
    expect(HangXHR.instances).toHaveLength(0);

    const controller = new AbortController();
    const pending = apiUpload(PATH, FILE, false, undefined, { clientUploadId: ID }, { signal: controller.signal });
    await tick(10);
    expect(HangXHR.instances[0].sent).toBe(true);
    expect(HangXHR.instances[0].form.get('clientUploadId')).toBe(ID);
    controller.abort();
    const after = await pending.catch((e) => e);
    expect(HangXHR.instances[0].aborted).toBe(true);
    expect(after).toMatchObject({ code: 'cancelled', outcomeUnknown: true });
  });

  test('a stall aborts the request and is an unknown outcome; a network error after the start is unknown too', async () => {
    const stalled = await apiUpload(PATH, FILE, false, undefined, undefined, { stallTimeoutMs: 25 }).catch((e) => e);
    expect(HangXHR.instances[0].aborted).toBe(true);
    expect(stalled).toMatchObject({ code: 'timeout', outcomeUnknown: true });

    const pending = apiUpload(PATH, FILE);
    await tick(10);
    HangXHR.instances[1].onerror();
    const lost = await pending.catch((e) => e);
    expect(lost).toMatchObject({ code: 'network', outcomeUnknown: true });
  });

  test('a file that could not even be read is not-sent (nothing reached the server)', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('blob gone'); });
    const error = await apiUpload(PATH, FILE).catch((e) => e);
    expect(error).toMatchObject({ code: 'network', notProcessed: true, outcomeUnknown: false });
    expect(classifyUploadFailure(error)).toBe('notSent');
  });
});
