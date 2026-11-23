/* global describe, test, expect, jest, beforeEach, afterEach, __dirname, Buffer */
// Phase 4 (idempotency), mobile side, end to end: the REAL api.js and session.js against a fake server that behaves like the real one (it saves a request once per ACCOUNT and key,
// and returns it again for a repeated key), with a lost answer, a retry, a changed form, an app restart, an expired session and a new login, "Check status", and a connection that
// comes back. Plus source checks on the screens.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), createDownloadResumable: jest.fn(), deleteAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => {
  const memory = new Map();
  return {
    __memory: memory,
    setItemAsync: jest.fn(async (key, value) => { memory.set(key, value); }),
    deleteItemAsync: jest.fn(async (key) => { memory.delete(key); }),
    getItemAsync: jest.fn(async (key) => (memory.has(key) ? memory.get(key) : null)),
  };
});

const fs = require('fs');
const path = require('path');
const SecureStore = require('expo-secure-store');
const session = require('../session');
const api = require('../api');
const guard = require('../authGuard');
const { createSubmissionTracker, sessionChangeHandler, PENDING_KEY } = require('../submissionKey');
const { postWithKey, afterSaved, afterFailure, checkSubmission, checkPath, samePayload, EDITED_CODE } = require('../requestSubmission');
const { userIdFromToken } = require('../tokenIdentity');
const { createNetworkStore } = require('../network');
const { buildTelePayload } = require('../teleConsultation');
const { buildMarinePayload } = require('../marineMedicalSafety');
const I18N = require('../../data/i18n.json');

const T = 'humancare_token';
const R = 'humancare_refresh_token';
const flush = () => new Promise((resolve) => setTimeout(resolve, 30)); // lets an announced (async) session change finish
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const hang = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
const memoryStorage = () => { const map = new Map(); return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, v); }, del: async (k) => { map.delete(k); } }; };
const sequence = () => { let n = 0; return jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`); };
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub, role = 'patient') => `${b64({ alg: 'HS256' })}.${b64({ sub, role, exp: 4102444800 })}.sig`;
const accountId = async () => userIdFromToken(await session.getAccessToken());
const signInAs = (sub) => session.saveTokens({ token: jwt(sub), refreshToken: `refresh-${sub}-${Math.random().toString(16).slice(2)}` }, { signIn: true, attempt: session.beginSignIn() });
const makeTracker = (storage = memoryStorage(), generate = sequence()) => createSubmissionTracker({ storage, getUserId: accountId, generate });

// A tiny server: POST /requests saves once per (account, key) and returns the same request again for a repeated key (HTTP 200), like the real backend; the account is the one
// in the bearer token. GET /requests/me/by-client-request/<key> finds only the caller's own.
function fakeServer() {
  const server = { saved: [], posts: [], gets: [], behaviour: 'ok', nextId: 100, expired: false };
  const who = (init) => userIdFromToken(String((init && init.headers && init.headers.Authorization) || '').replace('Bearer ', ''));
  global.fetch = jest.fn(async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (u.endsWith('/auth/refresh')) return reply(401, { error: 'invalid refresh token' });
    if (server.expired && !u.endsWith('/auth/me')) return reply(401, { error: 'Token expired' });
    const user = who(init);
    if (method === 'POST' && u.endsWith('/requests')) {
      const body = JSON.parse(init.body);
      server.posts.push({ ...body, __user: user });
      if (server.behaviour === 'hang') return hang(url, init);
      if (server.behaviour === 'drop-after-save') { // saved, but the answer is lost
        if (!server.saved.find((r) => r.key === body.clientRequestId && r.user === user)) server.saved.push({ id: server.nextId++, key: body.clientRequestId, user, body, referenceNumber: `REQ-${1000 + server.nextId}` });
        return hang(url, init);
      }
      if (server.behaviour === '503') return reply(503, { error: 'Service unavailable' });
      if (server.behaviour === '400') return reply(400, { error: 'Please correct the highlighted fields.', fields: { patientName: 'Required' } });
      const existing = body.clientRequestId ? server.saved.find((r) => r.key === body.clientRequestId && r.user === user) : null;
      if (existing) return reply(200, { request: { id: existing.id, referenceNumber: existing.referenceNumber } });
      const row = { id: server.nextId++, key: body.clientRequestId || null, user, body, referenceNumber: `REQ-${1000 + server.nextId}` };
      server.saved.push(row);
      return reply(201, { request: { id: row.id, referenceNumber: row.referenceNumber } });
    }
    if (method === 'GET' && u.includes('/requests/me/by-client-request/')) {
      server.gets.push(u);
      if (server.behaviour === 'offline') throw new TypeError('Network request failed');
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
beforeEach(async () => {
  jest.clearAllMocks();
  SecureStore.__memory.clear();
  SecureStore.__memory.set(T, jwt(7));
  SecureStore.__memory.set(R, 'tok-r');
  session.setStorageTimeoutForTests(500);
  session.resetSessionStateForTests();
  api.setRefreshTimeoutForTests(500);
  api.setWriteTimeoutForTests(60);
  guard.setApiAuthStatus('authed');
  guard.setCurrentPath('/request/review');
  server = fakeServer();
  stopListening = null;
});
afterEach(() => { jest.useRealTimers(); if (stopListening) stopListening(); });

describe('1. the original payload stays unchanged after an unknown outcome', () => {
  test('what is sent again is EXACTLY what was first sent, whatever happens to the form object afterwards', async () => {
    const tracker = makeTracker();
    const form = { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'Asha Nair', care: ['icu', 'o2'], nested: { floor: 3 } };
    server.behaviour = 'drop-after-save';
    const lost = await postWithKey(tracker, api.apiPost, form).catch((e) => e);
    expect(await afterFailure(tracker, lost)).toBe('unconfirmed');
    const snapshot = JSON.parse(JSON.stringify(form));
    form.patientName = 'Changed'; form.care.push('vent'); form.nested.floor = 9; // the form object is mutated in memory
    expect(tracker.getOriginalPayload()).toEqual(snapshot); // the original is untouched

    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, snapshot); // the form says what it said: a clean retry
    const [first, second] = server.posts;
    expect(second.clientRequestId).toBe(first.clientRequestId);
    const strip = ({ clientRequestId, __user, ...rest }) => rest;
    expect(strip(second)).toEqual(strip(first)); // byte-for-byte the same content
    expect(strip(second)).toEqual(snapshot);
  });
  test('a retry of an unchanged form sends the stored original even if the clock-based offset differs (that is not an edit)', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    const lost = await postWithKey(tracker, api.apiPost, { serviceKey: 'tele', patientName: 'A', utcOffsetMinutes: 330 }).catch((e) => e);
    await afterFailure(tracker, lost);
    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, { serviceKey: 'tele', patientName: 'A', utcOffsetMinutes: 0 }); // the person travelled / DST: not an edit
    expect(server.posts[1].utcOffsetMinutes).toBe(330); // the ORIGINAL offset the server first saw
    expect(server.saved).toHaveLength(1);
  });
  test('the original is held in memory only: gone after a restart, and never in storage', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    const lost = await postWithKey(tracker, api.apiPost, { serviceKey: 'tele', patientName: 'Asha Nair' }).catch((e) => e);
    await afterFailure(tracker, lost);
    expect(storage.map.get(PENDING_KEY)).not.toMatch(/Asha|tele/);
    const restarted = makeTracker(storage);
    expect(restarted.getOriginalPayload()).toBeNull();
    expect(await restarted.pending()).toHaveLength(1);
  });
});

describe('2. editing after an unknown outcome is never silently ignored', () => {
  // One representative payload per service path, with the shapes their builders produce (strings, numbers, booleans, arrays, nested objects, a clock-based offset).
  const SERVICES = {
    'Air Ambulance (generic body)': { serviceType: 'Air Ambulance', serviceKey: 'commercialair_stretcher', patientName: 'A', careLevel: 'crit_icu', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h' },
    'Ground Ambulance (generic body)': { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'A', origin: 'Pune', destination: 'Mumbai', equipOxygen: false },
    'Private Charter': { serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'A', originCity: { geonameId: 1, name: 'Mumbai' }, destinationCity: { geonameId: 3, name: 'Dubai' } },
    Teleconsultation: { serviceKey: 'tele', patientName: 'A', teleScope: 'domestic', utcOffsetMinutes: 330 },
    'Home Healthcare': { serviceKey: 'homecare', patientName: 'A', caretakerTypes: ['nurse', 'caretaker'], utcOffsetMinutes: 330 },
    'Mortal Remains': { serviceKey: 'mortal', patientName: 'A', transferScope: 'domestic', transportMode: 'ground_transportation', utcOffsetMinutes: 330 },
    'Corporate Medical Solutions': { serviceKey: 'corporate', companyName: 'Acme', employeeCount: 250, programmes: ['nurse', 'doctor'], utcOffsetMinutes: 330 },
    'Marine Medical Safety': { serviceKey: 'marine', patientName: 'A', serviceScope: 'domestic', marineCare: ['crit_icu'], utcOffsetMinutes: 330 },
    'Medical Value Travel': { serviceKey: 'medvalue', patientName: 'A', treatmentScope: 'international', specialty: 'Cardiology', utcOffsetMinutes: 330 },
  };

  test.each(Object.entries(SERVICES))('%s: a changed form is REFUSED before anything is sent, and the key and original are untouched', async (_name, original) => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    const lost = await postWithKey(tracker, api.apiPost, original).catch((e) => e);
    expect(await afterFailure(tracker, lost)).toBe('unconfirmed');
    const key = tracker.getCurrent();
    const sentBefore = global.fetch.mock.calls.length;

    const edited = { ...original, patientName: 'A (edited)', companyName: original.companyName && 'Acme (edited)', description: 'new text' };
    const err = await postWithKey(tracker, api.apiPost, edited).catch((e) => e);
    expect(err.code).toBe(EDITED_CODE);
    expect(global.fetch.mock.calls.length).toBe(sentBefore); // NOTHING was sent
    expect(await afterFailure(tracker, err)).toBe('edited');
    expect(tracker.getCurrent()).toBe(key); // the same key
    expect(tracker.getOriginalPayload()).toEqual(original); // the same original
    expect((await tracker.pending()).map((p) => p.id)).toEqual([key]); // still unresolved, still stored
    expect(server.saved).toHaveLength(1);
  });
  test.each(Object.entries(SERVICES))('%s: an UNCHANGED form is a clean retry with the same key and content', async (_name, original) => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, original).catch((e) => e));
    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, JSON.parse(JSON.stringify(original)));
    expect(server.posts[1].clientRequestId).toBe(server.posts[0].clientRequestId);
    expect(server.saved).toHaveLength(1);
  });
  test('a field that is undefined is not content: the stored copy equals what it was taken from (the builders leave optional fields undefined)', () => {
    expect(samePayload({ a: 1, patientAge: undefined, nested: { x: undefined, y: 2 } }, JSON.parse(JSON.stringify({ a: 1, patientAge: undefined, nested: { x: undefined, y: 2 } })))).toBe(true);
    expect(samePayload({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(samePayload({ a: 1, b: null }, { a: 1 })).toBe(false); // null IS sent, so it is content
  });
  test('every kind of edit is noticed: a changed value, an added or removed field, a reordered list, a nested change', () => {
    const base = { a: 1, list: ['x', 'y'], nested: { k: 'v' } };
    expect(samePayload(base, { nested: { k: 'v' }, list: ['x', 'y'], a: 1 })).toBe(true); // key order is not an edit
    for (const edited of [{ ...base, a: 2 }, { ...base, extra: 1 }, { list: base.list, nested: base.nested }, { ...base, list: ['y', 'x'] }, { ...base, nested: { k: 'w' } }, { ...base, a: '1' }]) {
      expect(samePayload(base, edited)).toBe(false);
    }
  });
  test('"send the original again" sends the original whatever the form says now', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    const original = { serviceKey: 'ground', patientName: 'Asha', description: 'first' };
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, original).catch((e) => e));
    server.behaviour = 'ok';
    const out = await postWithKey(tracker, api.apiPost, { ...original, description: 'edited' }, { sendOriginal: true });
    expect(server.posts[1]).toMatchObject({ patientName: 'Asha', description: 'first' }); // not the edit
    expect(server.posts[1].clientRequestId).toBe(server.posts[0].clientRequestId);
    expect(out.request.id).toBe(server.saved[0].id);
    expect(server.saved).toHaveLength(1);
  });
  test('the original is received -> "Keep the original": the request stands and the key is finished', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Asha' }).catch((e) => e));
    server.behaviour = 'ok';
    const found = await checkSubmission(api.apiGet, tracker.getCurrent());
    expect(found.state).toBe('found');
    await afterSaved(tracker); // keepOriginal
    expect(tracker.getCurrent()).toBeNull();
    expect(await tracker.pending()).toEqual([]);
    expect(server.saved).toHaveLength(1); // the changes were never sent
  });
  test('the original is received -> "Submit my changes as a new request": a NEW key, and the original is left alone', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    const original = { serviceKey: 'ground', patientName: 'Asha', description: 'first' };
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, original).catch((e) => e));
    const oldKey = tracker.getCurrent();
    server.behaviour = 'ok';
    expect((await checkSubmission(api.apiGet, oldKey)).state).toBe('found');
    await tracker.discard(oldKey); // submitChanges: let the original go ...
    await postWithKey(tracker, api.apiPost, { ...original, description: 'edited' }); // ... and send the changes as a new submission
    expect(server.saved).toHaveLength(2); // the original AND the new request (the person was told)
    expect(server.saved[0].body.description).toBe('first');
    expect(server.saved[1].body.description).toBe('edited');
    expect(server.saved[1].key).not.toBe(oldKey);
  });
  test('the original is NOT found -> "Send the original again" saves it once, and the changes are still not sent', async () => {
    const tracker = makeTracker();
    server.behaviour = 'hang'; // the request never reached the server
    const original = { serviceKey: 'ground', patientName: 'Asha', description: 'first' };
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, original).catch((e) => e));
    server.behaviour = 'ok';
    expect((await checkSubmission(api.apiGet, tracker.getCurrent())).state).toBe('notfound');
    await postWithKey(tracker, api.apiPost, { ...original, description: 'edited' }, { sendOriginal: true });
    expect(server.saved).toHaveLength(1);
    expect(server.saved[0].body.description).toBe('first');
  });
  test('the original is NOT found -> "Discard the original and submit my changes": a new key; the person chose it knowing there could be two', async () => {
    const tracker = makeTracker();
    server.behaviour = 'hang';
    const original = { serviceKey: 'ground', patientName: 'Asha', description: 'first' };
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, original).catch((e) => e));
    const oldKey = tracker.getCurrent();
    server.behaviour = 'ok';
    await tracker.discard(oldKey);
    await postWithKey(tracker, api.apiPost, { ...original, description: 'edited' });
    expect(server.saved.map((r) => r.body.description)).toEqual(['edited']);
    expect(tracker.getCurrent()).not.toBe(oldKey);
  });
  test('NOTHING resolves on its own: with a changed form no request is sent until the person acts', async () => {
    jest.useFakeTimers();
    const tracker = makeTracker();
    server.behaviour = 'hang';
    const failing = postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'A' }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(100);
    await afterFailure(tracker, await failing);
    const sent = global.fetch.mock.calls.length;
    await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'B' }).catch(() => {});
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(global.fetch.mock.calls.length).toBe(sent);
  });
});

describe('3. the same account logging in again keeps its unresolved keys: expired session -> re-login -> Check status', () => {
  test('the whole path, on the real session code', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker)); // exactly how AppContext wires it

    // 1. a submission whose answer is lost (the server DID save it)
    server.behaviour = 'drop-after-save';
    const original = { serviceKey: 'ground', patientName: 'Asha', description: 'first' };
    const lost = await postWithKey(tracker, api.apiPost, original).catch((e) => e);
    expect(await afterFailure(tracker, lost)).toBe('unconfirmed');
    const key = tracker.getCurrent();
    expect(JSON.parse(storage.map.get(PENDING_KEY)).items).toEqual([expect.objectContaining({ id: key, userId: 'patient:7' })]);

    // 2. the session expires and cannot be renewed: the real sign-out (api.js -> compareAndClearTokens -> announced)
    server.expired = true;
    const expired = await checkSubmission(api.apiGet, key);
    expect(expired.state).toBe('failed');
    expect(expired.error.code).toBe('session_expired');
    await flush();
    expect(SecureStore.__memory.get(T)).toBeUndefined(); // the session really ended
    expect(JSON.parse(storage.map.get(PENDING_KEY)).items.map((i) => i.id)).toEqual([key]); // and the unresolved key was NOT cleared
    expect(tracker.getCurrent()).toBe(key);
    expect(tracker.getOriginalPayload()).toEqual(original);

    // 3. the same account logs in again
    server.expired = false;
    await signInAs(7);
    await flush();
    expect(JSON.parse(storage.map.get(PENDING_KEY)).items.map((i) => i.id)).toEqual([key]);
    expect((await tracker.pending()).map((p) => p.id)).toEqual([key]);

    // 4. Check status finds the request that was received
    server.behaviour = 'ok';
    const found = await checkSubmission(api.apiGet, key);
    expect(found.state).toBe('found');
    expect(found.request.id).toBe(server.saved[0].id);
    await tracker.discard(key);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(server.saved).toHaveLength(1); // one request, ever
  });
  test('the draft keeps its key through the re-login, so a retry is still the SAME submission (no duplicate)', async () => {
    const tracker = makeTracker();
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    server.behaviour = 'drop-after-save';
    const body = { serviceKey: 'ground', patientName: 'Asha' };
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, body).catch((e) => e));
    const key = tracker.getCurrent();
    await session.clearTokens(); // logged out (or expired)
    await flush();
    await signInAs(7); // and in again, as the same account
    await flush();
    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, body);
    expect(server.posts[1].clientRequestId).toBe(key);
    expect(server.saved).toHaveLength(1);
  });
  test('after a restart plus a re-login the stored key is still found (the app was closed while signed out)', async () => {
    const storage = memoryStorage();
    const before = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    await afterFailure(before, await postWithKey(before, api.apiPost, { serviceKey: 'ground', patientName: 'A' }).catch((e) => e));
    const key = before.getCurrent();
    await session.clearTokens();
    const restarted = makeTracker(storage); // a new process
    stopListening = session.onSessionChange(sessionChangeHandler(restarted));
    expect(await restarted.pending()).toEqual([]); // signed out: nothing is shown
    await signInAs(7);
    await flush();
    server.behaviour = 'ok';
    expect((await restarted.pending()).map((p) => p.id)).toEqual([key]);
    expect((await checkSubmission(api.apiGet, key)).state).toBe('found');
  });
});

describe('4. a different account cannot reuse pending keys', () => {
  test('logging in as another account deletes the first account\'s keys and drops its draft key and payload', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    stopListening = session.onSessionChange(sessionChangeHandler(tracker));
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Asha' }).catch((e) => e));
    const aliceKey = tracker.getCurrent();
    await session.clearTokens();
    await flush();
    await signInAs(8); // a different account
    await flush();
    expect(storage.map.has(PENDING_KEY)).toBe(false); // deleted, not just hidden
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(await tracker.pending()).toEqual([]);

    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Ben' });
    expect(server.posts[server.posts.length - 1].clientRequestId).not.toBe(aliceKey); // a NEW key
    expect(server.posts[server.posts.length - 1].__user).toBe('patient:8');
  });
  test('even if the key is somehow known, the server scopes it: the other account finds nothing', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Asha' }).catch((e) => e));
    const aliceKey = tracker.getCurrent();
    SecureStore.__memory.set(T, jwt(8)); // swapped to another account
    server.behaviour = 'ok';
    expect((await checkSubmission(api.apiGet, aliceKey)).state).toBe('notfound');
  });
  test('without an announcement (the token simply changed), begin() still refuses to carry the key across', async () => {
    const tracker = makeTracker();
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Asha' }).catch((e) => e));
    const aliceKey = tracker.getCurrent();
    SecureStore.__memory.set(T, jwt(8));
    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Ben' });
    expect(server.posts[1].clientRequestId).not.toBe(aliceKey);
    expect(server.posts[1].patientName).toBe('Ben');
    expect(await tracker.pending()).toEqual([]);
  });
  test('Alice\'s keys never show on Bob\'s Home, even before they are cleaned up', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'Asha' }).catch((e) => e));
    SecureStore.__memory.set(T, jwt(8));
    expect(await tracker.pending()).toEqual([]);
  });
});

describe('5, 6 and the account\'s deletion: when a key is cleared', () => {
  test('5. a confirmed completion clears the key (and the next submission gets a new one)', async () => {
    const storage = memoryStorage();
    const generate = sequence();
    const tracker = makeTracker(storage, generate);
    await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'A' });
    await afterSaved(tracker);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'B' });
    expect(server.posts[0].clientRequestId).not.toBe(server.posts[1].clientRequestId);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test('6. an explicit discard clears the key (and only that one)', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'A' }).catch((e) => e));
    const key = tracker.getCurrent();
    await tracker.discard(key);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
  });
  test('the account\'s deletion clears everything, before the session is cleared', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    await afterFailure(tracker, await postWithKey(tracker, api.apiPost, { serviceKey: 'ground', patientName: 'A' }).catch((e) => e));
    await tracker.clearAll();
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getCurrent()).toBeNull();
    const screen = fs.readFileSync(path.join(__dirname, '../../app/delete-account-otp.js'), 'utf8').split('\r\n').join('\n');
    expect(screen.indexOf('await submissionTracker.clearAll();')).toBeGreaterThan(screen.indexOf('clearAuthSteps();'));
    expect(screen.indexOf('await submissionTracker.clearAll();')).toBeLessThan(screen.indexOf("navReplace('/login');"));
    expect(screen.indexOf('await submissionTracker.clearAll();')).toBeLessThan(screen.indexOf('await clearTokens();'));
  });
});

describe('6 and 10. a lost response followed by a retry: one request, the same key', () => {
  test('the answer never arrives; the retry carries the SAME key; the server returns the original; the key is then finished', async () => {
    const storage = memoryStorage();
    const generate = sequence();
    const tracker = makeTracker(storage, generate);
    const body = buildTelePayload({ service: 'tele', name: 'Asha', age: '40', gender: 'Female', phone: '9876543210', cc: '+91', phoneCountry: 'IN', teleScope: 'domestic', teleType: 'online', desc: 'x', allergies: '', address: '' });
    server.behaviour = 'drop-after-save';
    const lost = await postWithKey(tracker, api.apiPost, body).catch((e) => e);
    expect(lost).toMatchObject({ code: 'timeout', outcomeUnknown: true });
    expect(await afterFailure(tracker, lost)).toBe('unconfirmed');
    server.behaviour = 'ok';
    const retry = await postWithKey(tracker, api.apiPost, body);
    await afterSaved(tracker);
    expect(server.posts[0].clientRequestId).toBe(server.posts[1].clientRequestId);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(server.saved).toHaveLength(1);
    expect(retry.request.id).toBe(server.saved[0].id);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
  });
  test('a genuinely new submission afterwards gets a NEW key and is a separate request', async () => {
    const tracker = makeTracker();
    await postWithKey(tracker, api.apiPost, { serviceType: 'x' });
    await afterSaved(tracker);
    await postWithKey(tracker, api.apiPost, { serviceType: 'x' });
    expect(server.posts[0].clientRequestId).not.toBe(server.posts[1].clientRequestId);
    expect(server.saved).toHaveLength(2);
  });
  test('the key is added to a COPY of the body: the payload builders\' output is not changed', async () => {
    const tracker = makeTracker();
    const body = { serviceType: 'Marine Medical Safety', serviceKey: 'marine' };
    await postWithKey(tracker, api.apiPost, body);
    expect(body).toEqual({ serviceType: 'Marine Medical Safety', serviceKey: 'marine' });
    expect(JSON.stringify(buildMarinePayload({ service: 'marine', name: 'A', serviceScope: 'domestic', marineOxygen: 'no', marineCare: [], desc: '' }))).not.toContain('clientRequestId');
  });
  test('the key is stored on the device BEFORE the request leaves (it is already there when the server first sees it)', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    let storedWhenSent = null;
    const spy = jest.fn(async (p, body) => { storedWhenSent = JSON.parse(storage.map.get(PENDING_KEY)).items.map((i) => i.id); return { request: { id: 1 }, p, body }; });
    await postWithKey(tracker, spy, { a: 1 });
    expect(storedWhenSent).toEqual([spy.mock.calls[0][1].clientRequestId]);
  });
});

describe('what an outcome means', () => {
  test('503: the server answered with an error, which is NOT a confirmation: still unconfirmed, key kept', async () => {
    const storage = memoryStorage();
    const tracker = makeTracker(storage);
    server.behaviour = '503';
    const err = await postWithKey(tracker, api.apiPost, { a: 1 }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(await afterFailure(tracker, err)).toBe('unconfirmed');
    expect(storage.map.has(PENDING_KEY)).toBe(true);
    expect(tracker.getOriginalPayload()).toEqual({ a: 1 });
  });
  test('400: the server ANSWERED no: a confirmed failure, nothing is unconfirmed, the original is dropped, and the corrected form keeps the same key', async () => {
    const storage = memoryStorage();
    const generate = sequence();
    const tracker = makeTracker(storage, generate);
    server.behaviour = '400';
    const err = await postWithKey(tracker, api.apiPost, { a: 1 }).catch((e) => e);
    expect(await afterFailure(tracker, err)).toBe('refused'); // the server evaluated it and said no; nothing earlier was unconfirmed, so nothing is kept
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(tracker.getOriginalPayload()).toBeNull(); // nothing was saved: the corrected form is simply the first payload now
    server.behaviour = 'ok';
    await postWithKey(tracker, api.apiPost, { a: 2 }); // not "edited": there is no original to differ from
    expect(server.posts[0].clientRequestId).toBe(server.posts[1].clientRequestId);
    expect(server.posts[1].a).toBe(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('a lost connection (no answer) is never reported as a confirmed failure', async () => {
    const tracker = makeTracker();
    global.fetch = jest.fn(() => { throw new TypeError('Network request failed'); });
    const err = await postWithKey(tracker, api.apiPost, { a: 1 }).catch((e) => e);
    expect(err.outcomeUnknown).toBe(true);
    expect(await afterFailure(tracker, err)).toBe('unconfirmed');
  });
  test('the person stays signed in through all of it', async () => {
    const tracker = makeTracker();
    server.behaviour = 'hang';
    await postWithKey(tracker, api.apiPost, { a: 1 }).catch(() => {});
    expect(SecureStore.__memory.get(T)).toBe(jwt(7));
    expect(SecureStore.__memory.get(R)).toBe('tok-r');
  });
});

describe('10. "Check status" and a restart', () => {
  test('after a restart the stored key is found and Check status asks the server by that KEY alone', async () => {
    const storage = memoryStorage();
    const before = makeTracker(storage);
    server.behaviour = 'drop-after-save';
    await afterFailure(before, await postWithKey(before, api.apiPost, { a: 1 }).catch((e) => e));
    const after = makeTracker(storage);
    const [entry] = await after.pending();
    expect(entry.id).toBe(server.saved[0].key);
    server.behaviour = 'ok';
    const result = await checkSubmission(api.apiGet, entry.id);
    expect(result.state).toBe('found');
    expect(result.request.id).toBe(server.saved[0].id);
    expect(server.gets).toEqual([expect.stringMatching(new RegExp(`${checkPath(entry.id)}$`))]);
    expect(server.gets[0]).not.toMatch(/name|phone|contact|service/i);
    await after.discard(entry.id);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
  });
  test('not found (yet): the server says 404, the key is kept, nothing is claimed', async () => {
    expect(await checkSubmission(api.apiGet, '11111111-2222-4333-8444-555555555555')).toEqual({ state: 'notfound' });
  });
  test('the check itself cannot complete (offline): "failed", not "not found" and not "found"', async () => {
    server.behaviour = 'offline';
    const result = await checkSubmission(api.apiGet, '11111111-2222-4333-8444-555555555555');
    expect(result.state).toBe('failed');
    expect(result.error.code).toBe('network');
  });
  test('Check status is a READ: it never creates anything', async () => {
    await checkSubmission(api.apiGet, '11111111-2222-4333-8444-555555555555');
    expect(server.posts).toHaveLength(0);
    expect(server.saved).toHaveLength(0);
  });
});

describe('11. no automatic replay on network restoration', () => {
  test('after a lost answer, the connection dropping and returning sends NOTHING', async () => {
    jest.useFakeTimers();
    const tracker = makeTracker();
    server.behaviour = 'hang';
    const failing = postWithKey(tracker, api.apiPost, { a: 1 }).catch((e) => e);
    await jest.advanceTimersByTimeAsync(100);
    await afterFailure(tracker, await failing);
    expect(server.posts).toHaveLength(1);
    const linkSubs = new Set();
    const net = createNetworkStore({ probe: async () => ({ ok: true, status: 200, ms: 20 }), subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); } });
    const restored = jest.fn();
    net.onRestored(restored);
    net.start();
    const link = (s) => linkSubs.forEach((cb) => cb(s));
    link({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    await jest.advanceTimersByTimeAsync(0);
    link({ isConnected: false, isInternetReachable: false, type: 'none' });
    await jest.advanceTimersByTimeAsync(0);
    link({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    await jest.advanceTimersByTimeAsync(0);
    expect(restored).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(server.posts).toHaveLength(1);
    expect((await tracker.pending()).length).toBe(1);
  });
  test('the idempotency code listens to nothing: no network state, no timer, no listener, and no function that sends on its own', () => {
    const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
    for (const file of ['lib/submissionKey.js', 'lib/requestSubmission.js', 'lib/unconfirmedView.js', 'lib/pendingSubmissionStore.js', 'lib/tokenIdentity.js']) {
      const code = read(file).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      expect(code).not.toMatch(/useNetwork|NetworkContext|restoredCount|NetInfo|AppState|setInterval|setTimeout|useEffect|addEventListener/);
    }
  });
});

describe('the screens (source checks)', () => {
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8').split('\r\n').join('\n');
  const review = read('app/request/review.js');

  test('all eight service sends go through the key-carrying send(); not one raw apiPost(\'/requests\') is left', () => {
    expect(review).not.toMatch(/apiPost\('\/requests'/);
    expect((review.match(/await guardedSend\(/g) || []).length).toBe(3); // Teleconsultation, Corporate, and the one inside sendWithDocuments (Phase 5) that every other service's body goes through; guardedSend asks the server first when an earlier submission is unresolved
    expect((review.match(/return send\(body\)/g) || []).length).toBe(1); // and is the only caller of send()
    expect(review).toContain('createRequest: async () => {\n          const { request } = await guardedSend(buildBody());');
    expect((review.match(/sendWithDocuments\(/g) || []).length).toBe(2); // the calls: Private Charter, and every generic/structured service
    expect(review).toMatch(/const out = await postWithKey\(submissionTracker, apiPost, body, \{ service: serviceKey \}\);\s+await afterSaved\(submissionTracker\);/);
  });
  test('an unknown outcome and an edited form are handled BEFORE any "failure" handling: no error toast and no field errors', () => {
    const catchBlock = review.slice(review.indexOf('} catch (err) {\n      setUploading(null);'));
    const at = (text) => catchBlock.indexOf(text);
    expect(at('const outcome = await afterFailure(submissionTracker, err);')).toBeGreaterThan(-1);
    expect(at("outcome === 'edited'")).toBeGreaterThan(-1);
    expect(at("outcome === 'unconfirmed'")).toBeGreaterThan(-1);
    for (const handling of ['fieldErrorsFromError(err, t)', 'toast(errorText(err, t))']) {
      expect(at("outcome === 'edited'")).toBeLessThan(at(handling));
      expect(at("outcome === 'unconfirmed'")).toBeLessThan(at(handling));
    }
  });
  test('an edited form after an unknown first send is never silently sent: one short message and nothing to choose (the recovery cards are gone)', () => {
    expect(review).not.toMatch(/resendOriginal|submitChanges|keepOriginal|UnconfirmedSubmission|checkSubmission/);
    expect(review).toContain("if (outcome === 'edited') { setNotice('sent'); return; }");
    expect(I18N.EN.net_already_sent).toMatch(/already sent/);
  });
  test('submit() is only ever started by a person: the Review button (nothing calls it from an effect); a lost answer is one message and the same button is the retry', () => {
    expect(review).toMatch(/onNext=\{submit\}/);
    expect(review).not.toMatch(/useEffect/);
    expect(review).not.toMatch(/useNetwork|restoredCount|NetInfo/);
    expect(review).toContain("if (outcome === 'unconfirmed' || submissionTracker.isUnconfirmed()) { setRetryable(true); setNotice('lost'); return; }");
  });
  test('a retry is the same Submit button: it goes through postWithKey, which reuses the stored key and sends the ORIGINAL payload', () => {
    expect(review).toMatch(/postWithKey\(submissionTracker, apiPost, body, \{ service: serviceKey \}\)/);
    expect(read('lib/requestSubmission.js')).toMatch(/toSend = original; \/\/ a retry sends what was first sent/);
  });
  test('a new submission starts a new key; the session handler keeps keys through sign-out and sign-in of the same account, and AppContext no longer wipes them', () => {
    const context = read('state/AppContext.js');
    expect(context).toMatch(/setServerErrors\(null\); submissionTracker\.startNew\(\); \}/);
    expect(context).toMatch(/const trackerSession = sessionChangeHandler\(submissionTracker\);/);
    expect(context).toMatch(/onSessionChange\(\(signedIn\) => \{ clearCache\(\); trackerSession\(signedIn\); return signedIn/);
    expect(context).not.toMatch(/submissionTracker\.clearAll\(\)/);
  });
  test('the device store names the account from the access token and passes it to the tracker', () => {
    const store = read('lib/pendingSubmissionStore.js');
    expect(store).toMatch(/userIdFromToken\(await getAccessToken\(\)\)/);
    expect(store).toMatch(/createSubmissionTracker\(\{ storage: deviceStorage, getUserId: currentAccountId, generate: secureUuid, vault: submissionVault \}\)/); // the shared secure generator (Phase 5)
  });
  test('Home no longer draws the unconfirmed-request card (its key stays stored); only the saved-draft card is there', () => {
    const home = read('app/home.js');
    expect(home).not.toMatch(/PendingSubmissionNotice/);
    expect(home).toMatch(/<>\s+<DraftNotice \/>\s+<BannerCarousel/);
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'components/home/PendingSubmissionNotice.js'))).toBe(false);
  });
  test('the Review button asks the server and is switched off while offline (needsNetwork); the old card is gone', () => {
    expect(review).toMatch(/<RequestFrame step=\{3\} showService=\{false\} onNext=\{submit\} busy=\{busy\} needsNetwork /);
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'components/request/UnconfirmedSubmission.js'))).toBe(false);
  });
  test('the Review screen\'s other behaviour is intact: the document upload loop and the Private Charter runSubmission are still there', () => {
    expect(review).toMatch(/runSubmission\(\{/);
    expect(review).toMatch(/apiUpload\(`\/requests\/me\/\$\{sent\.id\}\/documents`/);
    expect(review).toMatch(/needsDocument\(d\)/);
  });
});

describe('the translations of the card', () => {
  const KEYS = [
    'req_unconfirmed_title', 'req_unconfirmed_body', 'req_check_status', 'req_submit_again', 'req_status_checking', 'req_status_received_title', 'req_status_received',
    'req_status_received_files', 'req_status_continue', 'req_status_not_found', 'req_status_check_failed', 'req_pending_dismiss',
    'req_edited_title', 'req_edited_body', 'req_edited_found', 'req_edited_not_found', 'req_resend_note', 'req_resend_original', 'req_submit_changes', 'req_keep_original', 'req_discard_submit',
    'req_pending_not_found',
  ];
  test('every key exists, translated, in all six languages (nothing else of any language changed in size)', () => {
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of KEYS) {
      expect(typeof I18N[lang][key]).toBe('string');
      expect(I18N[lang][key].trim().length).toBeGreaterThan(0);
      if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
    expect(Object.keys(I18N.EN).length).toBeGreaterThanOrEqual(867); // English only grows; the other five must hold exactly the same keys (translationParity.test.js) // + the 15 draft keys of Phase 6 (draftPersistence.test.js)
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) expect(Object.keys(I18N[lang]).length).toBe(Object.keys(I18N.EN).length);
  });
  test('the reference placeholder survives in every language', () => {
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of ['req_status_received', 'req_status_received_files', 'req_edited_found']) expect(I18N[lang][key]).toContain('{{reference}}');
  });
  test('the English message is exactly the wording that was asked for', () => {
    expect(I18N.EN.req_unconfirmed_title).toBe("We couldn't confirm whether your request was received");
    expect(I18N.EN.req_check_status).toBe('Check status');
  });
});
