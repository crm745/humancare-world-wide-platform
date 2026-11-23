/* global describe, test, expect, jest, beforeEach, afterEach, __dirname, Buffer */
// Phase 4 final safety fix: an UNKNOWN submission state is preserved. When an earlier attempt's outcome is unknown, a LATER attempt that is refused (the session could not be verified,
// the session expired, a 4xx) says nothing about the earlier one (it may have been saved, or may still be processing), so the key, the original payload and the stored entry must all
// survive, and a changed form must stay blocked under that key. The REAL api.js, session.js, authGuard and tracker run against a fake server that behaves like the real one.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), createDownloadResumable: jest.fn(), deleteAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  const read = async (key) => (memory.has(key) ? memory.get(key) : null);
  return {
    __memory: memory,
    __read: read,
    setItemAsync: jest.fn(async (key, value) => { memory.set(key, value); }),
    deleteItemAsync: jest.fn(async (key) => { memory.delete(key); }),
    getItemAsync: jest.fn(read),
  };
});

const fs = require('fs');
const path = require('path');
const SecureStore = require('expo-secure-store');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const { navReplace } = require('../nav');
const { createSubmissionTracker, sessionChangeHandler, PENDING_KEY } = require('../submissionKey');
const { postWithKey, afterSaved, afterFailure, checkSubmission, classifySendFailure, EDITED_CODE } = require('../requestSubmission');
const { userIdFromToken } = require('../tokenIdentity');
const { noAnswerError } = require('../apiErrors');
const { unconfirmedView } = require('../unconfirmedView');
const I18N = require('../../data/i18n.json');

const T = 'humancare_token';
const R = 'humancare_refresh_token';
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const hang = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
const memoryStorage = () => { const map = new Map(); return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };
const sequence = () => { let n = 0; return jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`); };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub, role = 'patient') => `${b64({ alg: 'HS256' })}.${b64({ sub, role, exp: 4102444800 })}.sig`;
const accountId = async () => userIdFromToken(await session.getAccessToken());
const signInAs = (sub) => session.saveTokens({ token: jwt(sub), refreshToken: `refresh-${sub}-${Math.random().toString(16).slice(2)}` }, { signIn: true, attempt: session.beginSignIn() });
const makeTracker = (storage = memoryStorage(), generate = sequence()) => createSubmissionTracker({ storage, getUserId: accountId, generate });

// Distinctive medical content, so a leak into any storage is caught.
const ORIGINAL = { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'Zephyrina Quillfeather', description: 'Hodgkin lymphoma stage IV, needs oxygen', patientContact: '+91 98765 43210', care: ['icu', 'o2'] };
const EDITED = { ...ORIGINAL, description: 'Hodgkin lymphoma stage IV, ventilator required' };
const PHI = /Zephyrina|Quillfeather|Hodgkin|lymphoma|98765|ventilator/i;

// A tiny server: saves once per (account, key); the account is the one in the bearer token.
//   behaviour: 'ok' | 'drop-after-save' (saved, answer lost) | 'hang' (never answered, not saved) | '400' | '409'
//   expired: every authenticated call is turned away with 401 (the server's auth check, before any handler)   refresh: 'invalid' (401) | 'unreachable' | 'ok'
function fakeServer() {
  const server = { saved: [], posts: [], gets: [], behaviour: 'ok', nextId: 100, expired: false, refresh: 'invalid' };
  const who = (init) => userIdFromToken(String((init && init.headers && init.headers.Authorization) || '').replace('Bearer ', ''));
  global.fetch = jest.fn(async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.endsWith('/auth/refresh')) {
      if (server.refresh === 'unreachable') throw new TypeError('Network request failed');
      if (server.refresh === 'ok') return reply(200, { token: jwt(7), refreshToken: 'refresh-new' });
      return reply(401, { error: 'invalid refresh token' });
    }
    if (server.expired) { if (method === 'POST') server.posts.push({ __refused: 401 }); return reply(401, { error: 'Token expired' }); }
    const user = who(init);
    if (method === 'POST' && u.endsWith('/requests')) {
      const body = JSON.parse(init.body);
      server.posts.push({ ...body, __user: user });
      const existing = body.clientRequestId ? server.saved.find((r) => r.key === body.clientRequestId && r.user === user) : null;
      if (server.behaviour === 'hang') return hang(url, init);
      if (server.behaviour === 'drop-after-save') {
        if (!existing) server.saved.push({ id: server.nextId++, key: body.clientRequestId, user, body, referenceNumber: `REQ-${1000 + server.nextId}` });
        return hang(url, init);
      }
      if (existing) return reply(200, { request: { id: existing.id, referenceNumber: existing.referenceNumber } });
      if (server.behaviour === '400') return reply(400, { error: 'Please correct the highlighted fields.', fields: { patientName: 'Required' } });
      if (server.behaviour === '409') return reply(409, { error: 'This request ID was already used for a different service.', code: 'client_request_id_reused' });
      const row = { id: server.nextId++, key: body.clientRequestId || null, user, body, referenceNumber: `REQ-${1000 + server.nextId}` };
      server.saved.push(row);
      return reply(201, { request: { id: row.id, referenceNumber: row.referenceNumber } });
    }
    if (method === 'GET' && u.includes('/requests/me/by-client-request/')) {
      server.gets.push(u);
      const key = decodeURIComponent(u.split('/by-client-request/')[1]);
      const row = server.saved.find((r) => r.key === key && r.user === user);
      return row ? reply(200, { request: { id: row.id, referenceNumber: row.referenceNumber } }) : reply(404, { error: 'Request not found', code: 'not_found' });
    }
    return reply(200, {});
  });
  return server;
}

let server;
let stopListening;
const sentCount = () => global.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/requests') && init && init.method === 'POST').length;
const strip = ({ clientRequestId, __user, __refused, ...rest }) => rest;

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.getItemAsync.mockImplementation(SecureStore.__read);
  SecureStore.__memory.set(T, jwt(7));
  SecureStore.__memory.set(R, 'refresh-7-initial');
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  api.setWriteTimeoutForTests(60);
  guard.setApiAuthStatus('authed');
  guard.setCurrentPath('/request/review');
  server = fakeServer();
  stopListening = null;
});
afterEach(() => { if (stopListening) stopListening(); SecureStore.getItemAsync.mockImplementation(SecureStore.__read); });

// An attempt whose answer is lost. 'saved' says whether the server DID save it (the app cannot tell).
async function lostFirstAttempt(tracker, { saved = true, body = ORIGINAL } = {}) {
  server.behaviour = saved ? 'drop-after-save' : 'hang';
  const err = await postWithKey(tracker, api.apiPost, body).catch((e) => e);
  expect(await afterFailure(tracker, err)).toBe('unconfirmed');
  server.behaviour = 'ok';
}
const intact = async (tracker, storage, key) => {
  expect(tracker.getCurrent()).toBe(key);
  expect(tracker.getOriginalPayload()).toEqual(ORIGINAL);
  expect(tracker.isUnconfirmed()).toBe(true);
  expect(JSON.parse(storage.map.get(PENDING_KEY)).items).toEqual([expect.objectContaining({ id: key, userId: 'patient:7' })]);
  expect((await tracker.pending()).map((p) => p.id)).toEqual([key]);
};

describe('the classification of a failed send (what it says about THIS attempt)', () => {
  const statusError = (status, extra = {}) => Object.assign(new Error('x'), { status, ...extra });
  test.each([
    // no answer, a server error, or anything not recognised: the request MAY exist
    ['lost connection (write)', noAnswerError({ method: 'POST' }), 'unconfirmed'],
    ['timeout (write)', noAnswerError({ method: 'POST', timedOut: true }), 'unconfirmed'],
    ['HTTP 500', statusError(500), 'unconfirmed'],
    ['HTTP 502', statusError(502), 'unconfirmed'],
    ['HTTP 503', statusError(503), 'unconfirmed'],
    ['a plain error (not recognised)', new Error('boom'), 'unconfirmed'],
    ['an abort (not recognised for a write)', Object.assign(new Error('x'), { name: 'AbortError' }), 'unconfirmed'],
    ['no error at all', undefined, 'unconfirmed'],
    // refused before anything was sent, or turned away by the server's authentication check: certainly not processed
    ['session could not be verified (pre-send)', Object.assign(new Error('x'), { code: 'session_unverified' }), 'notSent'],
    ['nobody signed in (pre-send)', Object.assign(new Error('x'), { code: 'not_signed_in', status: 401 }), 'notSent'],
    ['session expired / could not be renewed', Object.assign(new Error('x'), { code: 'session_expired', status: 401 }), 'notSent'],
    ['secure storage could not be read (pre-send)', Object.assign(new Error('x'), { code: 'storage_timeout' }), 'notSent'],
    ['marked notProcessed by the API client', Object.assign(new Error('x'), { code: 'network', notProcessed: true }), 'notSent'],
    ['HTTP 401', statusError(401), 'notSent'],
    ['HTTP 403', statusError(403), 'notSent'],
    // the server evaluated it and said no
    ['HTTP 400', statusError(400), 'refused'],
    ['HTTP 404', statusError(404), 'refused'],
    ['HTTP 409', statusError(409), 'refused'],
    ['HTTP 422', statusError(422), 'refused'],
    ['HTTP 429', statusError(429), 'refused'],
    // the form was changed after the first send: nothing sent
    ['edited', Object.assign(new Error('x'), { code: EDITED_CODE }), 'edited'],
  ])('%s -> %s', (_name, err, expected) => { expect(classifySendFailure(err)).toBe(expected); });

  test('a "no answer" error that is NOT marked notProcessed is never treated as safe (the POST may have been processed)', () => {
    expect(classifySendFailure(Object.assign(new Error('x'), { code: 'network' }))).toBe('unconfirmed');
    expect(classifySendFailure(noAnswerError({ method: 'POST' }))).toBe('unconfirmed');
  });
  test('the real errors the API client raises are classified as above (not just hand-made ones)', async () => {
    guard.setApiAuthStatus('unreachable');
    expect(classifySendFailure(await api.apiPost('/requests', {}).catch((e) => e))).toBe('notSent'); // session_unverified
    guard.setApiAuthStatus('anon');
    expect(classifySendFailure(await api.apiPost('/requests', {}).catch((e) => e))).toBe('notSent'); // not_signed_in
    guard.setApiAuthStatus('authed');
    server.expired = true;
    const expired = await api.apiPost('/requests', {}).catch((e) => e);
    expect(expired.code).toBe('session_expired');
    expect(classifySendFailure(expired)).toBe('notSent');
    SecureStore.__memory.set(T, jwt(7)); SecureStore.__memory.set(R, 'r'); session.resetSessionStateForTests();
    server.refresh = 'unreachable';
    const unreachable = await api.apiPost('/requests', {}).catch((e) => e);
    expect(unreachable.code).toBe('network');
    expect(unreachable.outcomeUnknown).toBeUndefined();
    expect(classifySendFailure(unreachable)).toBe('notSent'); // the 401 turned the call away; the renewal could not reach the server
    server.expired = false;
    server.behaviour = 'hang';
    expect(classifySendFailure(await api.apiPost('/requests', {}).catch((e) => e))).toBe('unconfirmed'); // a real timeout
  });
});

describe('the tracker rule: a refusal clears nothing while an earlier attempt is unconfirmed', () => {
  test('answered() with no unknown attempt ends the pending state (as before)', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await tracker.begin();
    tracker.rememberPayload(ORIGINAL);
    expect(tracker.isUnconfirmed()).toBe(false);
    await tracker.answered();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
  });
  test('answered() after markUnconfirmed() keeps the key, the original and the stored entry, however many times it is called', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    const key = await tracker.begin();
    tracker.rememberPayload(ORIGINAL);
    tracker.markUnconfirmed();
    for (let n = 0; n < 3; n += 1) await tracker.answered();
    await intact(tracker, storage, key);
  });
  test('the unknown state ends only by a confirmed outcome, an explicit discard or an account change (a new draft or service switch no longer ends it)', async () => {
    const ends = {
      confirm: (t) => t.confirm(),
      discard: (t) => t.discard(t.getCurrent()),
      clearAll: (t) => t.clearAll(),
    };
    for (const [name, end] of Object.entries(ends)) {
      const tracker = makeTracker();
      await tracker.begin();
      tracker.rememberPayload(ORIGINAL);
      tracker.markUnconfirmed();
      await end(tracker);
      expect({ name, flag: tracker.isUnconfirmed(), original: tracker.getOriginalPayload() }).toEqual({ name, flag: false, original: null });
    }
  });
  test('settle() alone is not "unconfirmed": only a recorded unknown outcome protects the state', async () => {
    const tracker = makeTracker();
    await tracker.begin();
    tracker.settle();
    expect(tracker.isUnconfirmed()).toBe(false);
  });
});

describe('1. the initial submission becomes unconfirmed after a lost response', () => {
  test('the key, the original payload and the owning account are kept, and the entry is stored', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker);
    await intact(tracker, storage, tracker.getCurrent());
    expect(server.saved).toHaveLength(1); // (it WAS saved: the app cannot know)
  });
});

describe('2. a retry refused BEFORE sending because the session is unverified', () => {
  test.each([['unreachable', 'session_unverified'], ['error', 'session_unverified'], ['anon', 'not_signed_in']])('auth status "%s" (%s): nothing is sent and nothing is cleared', async (status, code) => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    const sent = sentCount();

    guard.setApiAuthStatus(status);
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    expect(err.code).toBe(code);
    expect(sentCount()).toBe(sent); // really not sent
    expect(await afterFailure(tracker, err)).toBe('notSent');

    await intact(tracker, storage, key); // 4. the original payload and key are intact
    expect(storage.map.get(PENDING_KEY)).not.toMatch(PHI);
  });
  test('secure storage unreadable during the retry (storage_timeout, nothing sent): state kept', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    const sent = sentCount();
    session.setStorageTimeoutForTests(30);
    SecureStore.getItemAsync.mockImplementation(() => new Promise(() => {})); // the keychain hangs
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    SecureStore.getItemAsync.mockImplementation(SecureStore.__read);
    expect(err.code).toBe('storage_timeout');
    expect(sentCount()).toBe(sent);
    expect(await afterFailure(tracker, err)).toBe('notSent');
    await intact(tracker, storage, key);
  });
});

describe('3. a retry that receives a 401 / session expiry', () => {
  test('the server\'s auth check turns it away and the renewal is refused: the real sign-out happens, and the state is KEPT', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    const savedBefore = server.saved.length;

    server.expired = true; // the session expired
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    await flush();
    expect(err).toMatchObject({ code: 'session_expired', status: 401, notProcessed: true });
    expect(SecureStore.__memory.get(T)).toBeUndefined(); // the existing sign-out ran (compare-and-clear)
    expect(navReplace).toHaveBeenCalledWith('/login');
    expect(await afterFailure(tracker, err)).toBe('notSent');
    expect(server.saved).toHaveLength(savedBefore); // the retry created nothing

    expect(tracker.getCurrent()).toBe(key);
    expect(tracker.getOriginalPayload()).toEqual(ORIGINAL);
    expect(tracker.isUnconfirmed()).toBe(true);
    expect(JSON.parse(storage.map.get(PENDING_KEY)).items.map((i) => i.id)).toEqual([key]); // still stored for the same account
  });
  test('the renewal could not even reach the server (a 401, then no connection): session kept, state kept', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    server.expired = true;
    server.refresh = 'unreachable';
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    expect(err.code).toBe('network');
    expect(await afterFailure(tracker, err)).toBe('notSent');
    expect(SecureStore.__memory.get(T)).toBe(jwt(7)); // a network failure never signs anyone out
    await intact(tracker, storage, key);
  });
  test('a 403 from the auth check: state kept', async () => {
    const tracker = makeTracker();
    const storage = memoryStorage();
    const t2 = makeTracker(storage);
    await lostFirstAttempt(t2);
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(await afterFailure(t2, err)).toBe('notSent');
    await intact(t2, storage, t2.getCurrent());
    expect(tracker.isUnconfirmed()).toBe(false); // (an unrelated tracker is unaffected)
  });
  test('the retry\'s refusal is repeated several times in a row: still nothing is lost', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    guard.setApiAuthStatus('unreachable');
    for (let n = 0; n < 4; n += 1) {
      const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
      await afterFailure(tracker, err);
    }
    await intact(tracker, storage, key);
  });
});

describe('the earlier request may STILL be processing when a later attempt is answered', () => {
  test.each([['a 400', '400'], ['a 409', '409']])('%s to the retry says nothing about the earlier attempt: state kept, and the original can still be retried', async (_name, behaviour) => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await lostFirstAttempt(tracker, { saved: false }); // as far as the server is concerned nothing has landed yet (the first request may still be on its way)
    const key = tracker.getCurrent();

    server.behaviour = behaviour; // the retry is evaluated and refused while the first is still in flight
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    expect(await afterFailure(tracker, err)).toBe('refused');
    await intact(tracker, storage, key);

    // the first request now lands; a later retry of the ORIGINAL under the same key finds it: no duplicate, no lost state
    server.saved.push({ id: server.nextId++, key, user: 'patient:7', body: ORIGINAL, referenceNumber: 'REQ-1999' });
    server.behaviour = 'ok';
    const out = await postWithKey(tracker, api.apiPost, ORIGINAL);
    expect(out.request.referenceNumber).toBe('REQ-1999');
    expect(server.saved).toHaveLength(1);
  });
  test('without an unknown attempt, the same refusal DOES end the pending state (nothing is in flight)', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = '400';
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    expect(await afterFailure(tracker, err)).toBe('refused');
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
  });
  test('a FIRST attempt refused before sending (nothing was ever sent) leaves no false "unconfirmed" notice and does not freeze the form', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    guard.setApiAuthStatus('anon');
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    expect(await afterFailure(tracker, err)).toBe('notSent');
    expect(tracker.isUnconfirmed()).toBe(false);
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(await tracker.pending()).toEqual([]);
    guard.setApiAuthStatus('authed');
    await postWithKey(tracker, api.apiPost, EDITED); // the person may still edit freely: nothing was sent
    expect(server.saved).toHaveLength(1);
    expect(server.saved[0].body.description).toBe(EDITED.description);
  });
});

describe('5, 6 and 7. after authentication is restored', () => {
  async function expireAndRelogin(tracker) {
    server.expired = true;
    const err = await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e);
    await afterFailure(tracker, err);
    await flush();
    server.expired = false;
    await signInAs(7); // the same account logs in again
    await flush();
    guard.setApiAuthStatus('authed');
  }

  test('5. the UNCHANGED payload retries safely under the original key; the server returns the original; the pending state is then cleared', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    await expireAndRelogin(tracker);
    await intact(tracker, storage, key); // everything survived the expiry and the re-login

    const out = await postWithKey(tracker, api.apiPost, JSON.parse(JSON.stringify(ORIGINAL)));
    expect(out.request.id).toBe(server.saved[0].id);
    expect(server.saved).toHaveLength(1); // one request, ever
    const lastPost = server.posts[server.posts.length - 1];
    expect(lastPost.clientRequestId).toBe(key);
    expect(strip(lastPost)).toEqual(ORIGINAL); // exactly what was first sent

    await afterSaved(tracker); // 7. a confirmed success clears the pending state
    expect(tracker.isUnconfirmed()).toBe(false);
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
  });
  test('6. a CHANGED payload stays blocked under the original key: before, during and after the refusal and the re-login', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    const blocked = async () => {
      const sent = sentCount();
      const err = await postWithKey(tracker, api.apiPost, EDITED).catch((e) => e);
      expect(err.code).toBe(EDITED_CODE);
      expect(sentCount()).toBe(sent); // nothing went out
      expect(await afterFailure(tracker, err)).toBe('edited');
      expect(tracker.getCurrent()).toBe(key);
      expect(tracker.getOriginalPayload()).toEqual(ORIGINAL);
    };
    await blocked(); // right after the lost answer
    guard.setApiAuthStatus('unreachable');
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e)); // a refused retry in between
    guard.setApiAuthStatus('authed');
    await blocked(); // after the refusal
    await expireAndRelogin(tracker);
    await blocked(); // after the session expired and the same account logged in again
    expect(server.saved).toHaveLength(1);
    expect(server.saved[0].body.description).toBe(ORIGINAL.description); // the edit never reached the server under this key
  });
  test('the blocked edit is never silently converted into a replay: the only ways forward are the explicit ones', async () => {
    const tracker = makeTracker();
    await lostFirstAttempt(tracker);
    const key = tracker.getCurrent();
    expect((await postWithKey(tracker, api.apiPost, EDITED).catch((e) => e)).code).toBe(EDITED_CODE);
    // "send the original again": the ORIGINAL goes, the edit does not
    const out = await postWithKey(tracker, api.apiPost, EDITED, { sendOriginal: true });
    expect(strip(server.posts[server.posts.length - 1])).toEqual(ORIGINAL);
    expect(out.request.id).toBe(server.saved[0].id);
    // "submit my changes as a new request": the original is let go and the changes get a NEW key
    await tracker.discard(key);
    await postWithKey(tracker, api.apiPost, EDITED);
    expect(server.saved).toHaveLength(2);
    expect(server.saved[1].key).not.toBe(key);
  });
  test('7. a confirmed first-time success clears the pending state too (201)', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    await postWithKey(tracker, api.apiPost, ORIGINAL);
    await afterSaved(tracker);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(tracker.isUnconfirmed()).toBe(false);
  });
});

describe('8. a full restart retains only the key, never the medical payload', () => {
  test('the new process finds the entry and nothing else', async () => {
    const storage = memoryStorage();
    const before = makeTracker(storage);
    await lostFirstAttempt(before);
    guard.setApiAuthStatus('unreachable');
    await afterFailure(before, await postWithKey(before, api.apiPost, ORIGINAL).catch((e) => e)); // a refused retry too
    guard.setApiAuthStatus('authed');
    const key = before.getCurrent();

    const restarted = makeTracker(storage); // a new process: nothing in memory
    expect(restarted.getCurrent()).toBeNull();
    expect(restarted.getOriginalPayload()).toBeNull();
    expect(restarted.isUnconfirmed()).toBe(false);
    expect((await restarted.pending()).map((p) => p.id)).toEqual([key]); // only the key

    const everything = JSON.stringify([...storage.map.entries(), ...SecureStore.__memory.entries()]);
    expect(everything).not.toMatch(PHI); // no medical data in the pending store or the secure store
    expect(Object.keys(JSON.parse(storage.map.get(PENDING_KEY)).items[0]).sort()).toEqual(['id', 'startedAt', 'userId']);
  });
  test('the code that keeps the state has no way to persist a payload: no file, async-storage or secure-store use outside the entry writer', () => {
    const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
    for (const file of ['lib/submissionKey.js', 'lib/requestSubmission.js', 'lib/unconfirmedView.js']) {
      expect(read(file)).not.toMatch(/async-storage|AsyncStorage|expo-file-system|FileSystem|expo-secure-store|SecureStore|localStorage/);
    }
    const tracker = read('lib/submissionKey.js');
    expect((tracker.match(/storage\.set\(/g) || []).length).toBe(1); // the one write: the entries
    expect(tracker).toMatch(/storage\.set\(PENDING_KEY, JSON\.stringify\(\{ v: STORE_VERSION, items: items\.slice\(-MAX_PENDING\) \}\)\)/);
    expect(tracker).toMatch(/save\(\[\.\.\.items, \{ id: current, startedAt: now\(\), userId: user \}\]\)/);
  });
});

describe('9. a 404 after a restart shows the corrected Home message', () => {
  const HOME = { phase: 'notfound', canSubmitAgain: false };
  test('the Check status call really ends in "not found" after a restart (the original never reached the server)', async () => {
    const storage = memoryStorage();
    const before = makeTracker(storage);
    await lostFirstAttempt(before, { saved: false });
    const restarted = makeTracker(storage);
    const [entry] = await restarted.pending();
    const result = await checkSubmission(api.apiGet, entry.id);
    expect(result).toEqual({ state: 'notfound' });
    const view = unconfirmedView({ phase: result.state, canSubmitAgain: false });
    expect(view.bodyKey).toBe('req_pending_not_found');
  });
  test('Home offers ONLY actions that are available: Check status and Dismiss (no resend, no continue, no "submit my changes")', () => {
    const view = unconfirmedView(HOME);
    expect(view.actions.map((a) => a.id)).toEqual(['check', 'dismiss']);
    expect(view.noteKey).toBeUndefined();
    for (const gone of ['submitAgain', 'resendOriginal', 'continue', 'submitChanges', 'keepOriginal', 'discardAndSubmit']) expect(view.actions.map((a) => a.id)).not.toContain(gone);
    // and an edited flag cannot bring any of them back on Home
    expect(unconfirmedView({ ...HOME, edited: true }).actions.map((a) => a.id)).toEqual(['check', 'dismiss']);
  });
  test('Review (the form is still here, the original is held) keeps its own text: the original CAN be sent again there', () => {
    const view = unconfirmedView({ phase: 'notfound', canSubmitAgain: true });
    expect(view.bodyKey).toBe('req_status_not_found');
    expect(view.actions.map((a) => a.id)).toEqual(['check', 'submitAgain']);
    expect(I18N.EN.req_status_not_found).toMatch(/submit again: it will not be sent twice if it did arrive/);
  });
  test('the English wording says it may still arrive late, cannot be sent again from here, and a new request could duplicate it', () => {
    expect(I18N.EN.req_pending_not_found).toBe("We can't see that earlier request yet, but it could still arrive late. Your request details were not kept when the app closed, so it can't be sent again from here. If you start a new request, it will be treated as a separate one, and you could end up with a duplicate if the original arrives later. Check again later, or dismiss this notice.");
    expect(I18N.EN.req_pending_not_found).toMatch(/could still arrive late/);
    expect(I18N.EN.req_pending_not_found).toMatch(/can't be sent again from here/);
    expect(I18N.EN.req_pending_not_found).toMatch(/duplicate/);
    expect(I18N.EN.req_pending_not_found).not.toMatch(/submit again|safely|guarantee|will not be sent twice/i);
  });
  test('it exists, translated, in all six languages; no language lost or changed anything else, and the other not-found text is untouched', () => {
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) {
      expect(typeof I18N[lang].req_pending_not_found).toBe('string');
      expect(I18N[lang].req_pending_not_found.trim().length).toBeGreaterThan(60);
      if (lang !== 'EN') expect(I18N[lang].req_pending_not_found).not.toBe(I18N.EN.req_pending_not_found);
      expect(I18N[lang].req_status_not_found).toBeDefined();
    }
    expect(Object.keys(I18N)).toEqual(['EN', 'HI', 'MR', 'GU', 'TE', 'AR']);
  });
  test('Home no longer shows the card, so it can neither read nor send anything; the stored key is untouched', () => {
    expect(fs.existsSync(path.join(__dirname, '../../components/home/PendingSubmissionNotice.js'))).toBe(false);
  });
});

describe('10. account isolation stays intact', () => {
  test('another account logging in inherits neither the keys, nor the original, nor the unknown flag', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    await lostFirstAttempt(tracker);
    const aliceKey = tracker.getCurrent();
    guard.setApiAuthStatus('unreachable');
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, ORIGINAL).catch((e) => e));
    guard.setApiAuthStatus('authed');
    await session.clearTokens();
    await flush();
    await signInAs(8); // Bob
    await flush();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(tracker.isUnconfirmed()).toBe(false);
    expect(await tracker.pending()).toEqual([]);

    // Bob's own submission is unaffected by Alice's unknown state, and his refusals behave as ordinary refusals
    guard.setApiAuthStatus('authed');
    server.behaviour = '400';
    const err = await postWithKey(tracker, api.apiPost, EDITED).catch((e) => e);
    expect(server.posts[server.posts.length - 1].clientRequestId).not.toBe(aliceKey);
    expect(await afterFailure(tracker, err)).toBe('refused');
    expect(tracker.getOriginalPayload()).toBeNull(); // Bob had no unknown attempt: his refusal ends his pending state
  });
  test('the server still scopes the key: Bob cannot find Alice\'s request by her key', async () => {
    const tracker = makeTracker();
    await lostFirstAttempt(tracker);
    const aliceKey = tracker.getCurrent();
    SecureStore.__memory.set(T, jwt(8));
    expect((await checkSubmission(api.apiGet, aliceKey)).state).toBe('notfound');
  });
  test('without any announcement, begin() refuses to carry the key, the original or the flag across accounts', async () => {
    const tracker = makeTracker();
    await lostFirstAttempt(tracker);
    const aliceKey = tracker.getCurrent();
    SecureStore.__memory.set(T, jwt(8));
    const bobKey = await tracker.begin();
    expect(bobKey).not.toBe(aliceKey);
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(tracker.isUnconfirmed()).toBe(false);
  });
});

describe('the screens and the API client (source checks)', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8').split('\r\n').join('\n');
  test('the errors that certify "not processed" are marked where they are made', () => {
    const apiSource = read('lib/api.js');
    expect(apiSource).toMatch(/const sessionExpired = \(\) => Object\.assign\(new Error\('Your session expired\. Please log in again\.'\), \{ status: 401, code: 'session_expired', notProcessed: true \}\);/);
    expect(apiSource).toMatch(/const unavailable = \(\) => Object\.assign\(new Error\('Could not reach the server\. Please try again\.'\), \{ code: 'network', notProcessed: true \}\);/);
    expect(apiSource).toMatch(/const notSignedIn = \(\) => Object\.assign\(new Error\('Please log in to continue\.'\), \{ status: 401, code: 'not_signed_in', notProcessed: true \}\);/);
    expect(read('lib/authGuard.js')).toMatch(/err\.notProcessed = true; \/\/ refused before any request was made/);
  });
  test('the no-answer error is NOT marked notProcessed (a lost write may have been processed)', () => {
    expect(read('lib/apiErrors.js')).not.toMatch(/notProcessed/);
  });
  test('the classifier does not clear on every 4xx or every non-network error: its fall-through is "unconfirmed"', () => {
    const source = read('lib/requestSubmission.js');
    const body = source.slice(source.indexOf('export function classifySendFailure'), source.indexOf('export async function afterFailure'));
    expect(body).toMatch(/return 'unconfirmed'; \/\/ not recognised: never assume the server did not process it/);
    expect(body).toMatch(/if \(status >= 400 && status < 500\) return 'refused';/);
    expect(source).toMatch(/if \(kind === 'unconfirmed'\) \{\s+tracker\.markUnconfirmed\(\);/);
  });
  test('the tracker keeps everything while unconfirmed: answered() returns before it clears anything', () => {
    const source = read('lib/submissionKey.js');
    expect(source).toMatch(/async answered\(\) \{\s+active = null;\s+if \(unconfirmed\) return;\s+original = null;/);
    expect(source).toMatch(/markUnconfirmed\(\) \{ active = null; unconfirmed = true; \}/);
    expect(source).toMatch(/const forgetDraft = \(\) => \{ current = null; currentUser = null; active = null; original = null; unconfirmed = false; service = null; \};/);
  });
  test('Review: a lost answer, or a refusal while one is unknown, is ONE short message (no field is blamed, nothing is cleared); the same button retries', () => {
    const review = read('app/request/review.js');
    const catchBlock = review.slice(review.indexOf('} catch (err) {\n      setUploading(null);'));
    const at = (text) => catchBlock.indexOf(text);
    expect(at("if (outcome === 'unconfirmed' || submissionTracker.isUnconfirmed()) { setRetryable(true); setNotice('lost'); return; }")).toBeGreaterThan(-1);
    expect(at('submissionTracker.isUnconfirmed()')).toBeLessThan(at('fieldErrorsFromError(err, t)'));
  });
});
