/* global describe, test, expect, jest, Buffer */
// Phase 4 (idempotency), mobile side: the submission key's whole life (lib/submissionKey.js), the account it belongs to (lib/tokenIdentity.js) and the card's rules
// (lib/unconfirmedView.js). Pure; no network, no device.
const {
  PENDING_KEY, MAX_PENDING, PENDING_TTL_MS, STORE_VERSION, generateClientRequestId, isClientRequestId, isUnconfirmed, createSubmissionTracker, sessionChangeHandler,
} = require('../submissionKey');
const { userIdFromToken } = require('../tokenIdentity');
const { noAnswerError } = require('../apiErrors');
const { PHASES, unconfirmedView } = require('../unconfirmedView');

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ME = 'patient:7';
const memoryStorage = (initial) => {
  const map = new Map(initial ? [[PENDING_KEY, initial]] : []);
  return { map, get: jest.fn(async (k) => (map.has(k) ? map.get(k) : null)), set: jest.fn(async (k, v) => { map.set(k, v); }), del: jest.fn(async (k) => { map.delete(k); }) };
};
const sequence = () => { let n = 0; return jest.fn(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`); };
const stored = (storage) => (storage.map.has(PENDING_KEY) ? JSON.parse(storage.map.get(PENDING_KEY)) : null);
// A tracker whose signed-in account can be changed by the test (`who.id`), on a Map storage.
function make({ storage = memoryStorage(), user = ME, generate = sequence(), now } = {}) {
  const who = { id: user };
  const tracker = createSubmissionTracker({ storage, getUserId: async () => who.id, generate, ...(now ? { now } : {}) });
  return { tracker, storage, who, generate };
}

describe('generateClientRequestId', () => {
  test('is a lower-case version 4 UUID, whichever source of randomness exists', () => {
    const sources = [
      {},
      { getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 255; return bytes; } },
      { randomUUID: () => '3F2B8C1E-6A4D-4E0B-9C7A-1D2E3F4A5B6C' },
    ];
    for (const source of sources) {
      const id = generateClientRequestId(source);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(id).toBe(id.toLowerCase());
      expect(id).toHaveLength(36);
    }
  });
  test('the fallbacks set the version and variant bits and are not all the same', () => {
    const ids = new Set();
    for (let n = 0; n < 2000; n += 1) { const id = generateClientRequestId({}); expect(id).toMatch(V4); ids.add(id); }
    expect(ids.size).toBe(2000);
  });
  test('uses the platform\'s randomUUID when it has one (lower-cased)', () => {
    expect(generateClientRequestId({ randomUUID: () => 'ABCDEF01-2345-4678-89AB-CDEF01234567' })).toBe('abcdef01-2345-4678-89ab-cdef01234567');
  });
  test('isClientRequestId accepts UUIDs only', () => {
    expect(isClientRequestId(generateClientRequestId({}))).toBe(true);
    for (const bad of ['', 'abc', null, undefined, 12, '3f2b8c1e6a4d4e0b9c7a1d2e3f4a5b6c']) expect(isClientRequestId(bad)).toBe(false);
  });
});

describe('isUnconfirmed: only an ANSWER is a confirmed outcome', () => {
  test.each([
    ['no connection on a write', noAnswerError({ method: 'POST' }), true],
    ['timeout on a write', noAnswerError({ method: 'POST', timedOut: true }), true],
    ['HTTP 500', Object.assign(new Error('x'), { status: 500 }), true],
    ['HTTP 502', Object.assign(new Error('x'), { status: 502 }), true],
    ['HTTP 503', Object.assign(new Error('x'), { status: 503 }), true],
    ['HTTP 400 (a field to correct)', Object.assign(new Error('x'), { status: 400 }), false],
    ['HTTP 401 (session)', Object.assign(new Error('x'), { status: 401 }), false],
    ['HTTP 404', Object.assign(new Error('x'), { status: 404 }), false],
    ['HTTP 409', Object.assign(new Error('x'), { status: 409 }), false],
    ['HTTP 422', Object.assign(new Error('x'), { status: 422 }), false],
    ['a plain error', new Error('boom'), false],
    ['nothing', undefined, false],
  ])('%s -> %s', (_name, err, expected) => { expect(isUnconfirmed(err)).toBe(expected); });
});

describe('the key\'s life', () => {
  test('begin() makes the key ONCE and every later begin() (a retry) returns the SAME one', async () => {
    const { tracker, generate } = make();
    const first = await tracker.begin();
    expect([await tracker.begin(), await tracker.begin()]).toEqual([first, first]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('a lost answer or a timeout never makes a new key: settle() then begin() is the same key', async () => {
    const { tracker, generate } = make();
    const first = await tracker.begin();
    tracker.settle();
    expect(await tracker.begin()).toBe(first);
    tracker.settle();
    expect(await tracker.begin()).toBe(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('the key is on the device BEFORE begin() resolves, so before anything is sent, with the account it belongs to', async () => {
    const { tracker, storage } = make({ now: () => 1000 });
    const key = await tracker.begin();
    expect(stored(storage)).toEqual({ v: STORE_VERSION, items: [{ id: key, startedAt: 1000, userId: ME }] });
  });
  test('only { id, startedAt, userId } is ever stored: no patient, medical or form data, and never the payload', async () => {
    const { tracker, storage } = make({ now: () => 5 });
    await tracker.begin();
    tracker.rememberPayload({ patientName: 'Asha Nair', patientContact: '+91 98765 43210', description: 'Heart valve surgery' });
    await tracker.begin(); // a second save would have been the moment to leak it
    tracker.settle();
    const raw = storage.map.get(PENDING_KEY);
    expect(Object.keys(JSON.parse(raw))).toEqual(['v', 'items']);
    expect(Object.keys(JSON.parse(raw).items[0]).sort()).toEqual(['id', 'startedAt', 'userId']);
    expect(raw).not.toMatch(/Asha|98765|Heart|valve|patientName|description|name|phone|contact|diagnos|history|address|email/i);
    expect(JSON.stringify([...storage.map.entries()])).not.toMatch(/Asha|98765|Heart/);
  });
  test('it survives a restart while the outcome is unknown: a new tracker on the same storage finds it', async () => {
    const storage = memoryStorage();
    const before = make({ storage, now: () => 1000 }).tracker;
    const key = await before.begin();
    before.settle();
    const after = make({ storage, now: () => 2000 }).tracker; // the app was restarted
    expect(await after.pending()).toEqual([{ id: key, startedAt: 1000 }]);
  });
  test('an unconfirmed submission that is still RUNNING is not offered as "unconfirmed" until its outcome is unknown', async () => {
    const { tracker } = make();
    await tracker.begin();
    expect(await tracker.pending()).toEqual([]);
    tracker.settle();
    expect(await tracker.pending()).toHaveLength(1);
  });
  test('after the server CONFIRMS it saved the request, the key is removed and the next submission gets a NEW key', async () => {
    const { tracker, storage, generate } = make();
    const first = await tracker.begin();
    await tracker.confirm();
    expect(stored(storage)).toBeNull();
    expect(tracker.getCurrent()).toBeNull();
    const second = await tracker.begin();
    expect(second).not.toBe(first);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test('after the server ANSWERS with a refusal, nothing is unconfirmed any more, and the corrected form keeps the same key', async () => {
    const { tracker, storage, generate } = make();
    const first = await tracker.begin();
    await tracker.answered();
    expect(stored(storage)).toBeNull();
    expect(await tracker.begin()).toBe(first);
    expect(stored(storage).items).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  test('a genuinely new submission (a fresh start of a service) gets a new key, and the old unconfirmed one is still there to check', async () => {
    const { tracker, generate } = make();
    const first = await tracker.begin();
    tracker.settle();
    tracker.startNew();
    const second = await tracker.begin();
    expect(second).not.toBe(first);
    tracker.settle();
    expect((await tracker.pending()).map((p) => p.id)).toEqual([first, second]);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test('the person\'s explicit discard forgets one, and only that one', async () => {
    const { tracker } = make();
    const first = await tracker.begin();
    tracker.settle();
    tracker.startNew();
    const second = await tracker.begin();
    tracker.settle();
    await tracker.discard(first);
    expect((await tracker.pending()).map((p) => p.id)).toEqual([second]);
    await tracker.discard(second); // the current one: discarding it also ends the draft's key and payload
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(await tracker.pending()).toEqual([]);
  });
  test('an unconfirmed submission is forgotten after two weeks, and at most five are kept', async () => {
    let now = 1_000_000;
    const { tracker } = make({ now: () => now });
    for (let n = 0; n < 7; n += 1) { await tracker.begin(); tracker.settle(); tracker.startNew(); now += 1000; }
    expect(await tracker.pending()).toHaveLength(MAX_PENDING);
    now += PENDING_TTL_MS;
    expect(await tracker.pending()).toEqual([]);
  });
  test('the limits are unchanged: five entries, fourteen days, secure storage', () => {
    expect([MAX_PENDING, PENDING_TTL_MS]).toEqual([5, 14 * 24 * 60 * 60 * 1000]);
  });
});

describe('the original payload (memory only)', () => {
  const ORIGINAL = { serviceType: 'Ground Ambulance', patientName: 'Asha Nair', care: ['icu', 'o2'], nested: { a: 1 } };
  test('is remembered as a COPY: nothing the form does afterwards can reach it', async () => {
    const { tracker } = make();
    await tracker.begin();
    const body = JSON.parse(JSON.stringify(ORIGINAL));
    tracker.rememberPayload(body);
    body.patientName = 'Someone Else';
    body.care.push('vent');
    expect(tracker.getOriginalPayload()).toEqual(ORIGINAL);
  });
  test('what is read back is a copy too: changing it changes nothing', async () => {
    const { tracker } = make();
    await tracker.begin();
    tracker.rememberPayload(ORIGINAL);
    const read = tracker.getOriginalPayload();
    read.patientName = 'x';
    expect(tracker.getOriginalPayload().patientName).toBe('Asha Nair');
  });
  test('survives an unknown outcome (settle) and every retry', async () => {
    const { tracker } = make();
    await tracker.begin();
    tracker.rememberPayload(ORIGINAL);
    tracker.settle();
    await tracker.begin();
    expect(tracker.getOriginalPayload()).toEqual(ORIGINAL);
  });
  test('is dropped when the outcome is confirmed, refused, a new submission starts, or the person discards it', async () => {
    for (const end of [(t) => t.confirm(), (t) => t.answered(), (t) => t.startNew(), (t) => t.discard(t.getCurrent()), (t) => t.clearAll()]) {
      const { tracker } = make();
      await tracker.begin();
      tracker.rememberPayload(ORIGINAL);
      await end(tracker);
      expect(tracker.getOriginalPayload()).toBeNull();
    }
  });
  test('is NEVER written to storage, and is gone after a restart (only the key can be checked then)', async () => {
    const storage = memoryStorage();
    const first = make({ storage }).tracker;
    await first.begin();
    first.rememberPayload(ORIGINAL);
    first.settle();
    expect(JSON.stringify([...storage.map.entries()])).not.toMatch(/Asha|Ground|icu/);
    const restarted = make({ storage }).tracker;
    expect(restarted.getOriginalPayload()).toBeNull();
    expect(await restarted.pending()).toHaveLength(1); // the key itself survived
  });
});

describe('whose key it is (the account)', () => {
  test('the same account signing in again keeps its stored key, its draft key and its original payload', async () => {
    const { tracker, storage } = make();
    const key = await tracker.begin();
    tracker.rememberPayload({ a: 1 });
    tracker.settle();
    await tracker.onSignOut(); // the session expired or the person logged out
    expect(stored(storage).items).toHaveLength(1);
    await tracker.onSignIn(); // and logged in again, as the same account
    expect(stored(storage).items.map((i) => i.id)).toEqual([key]);
    expect(tracker.getCurrent()).toBe(key);
    expect(tracker.getOriginalPayload()).toEqual({ a: 1 });
    expect((await tracker.pending()).map((p) => p.id)).toEqual([key]);
  });
  test('a sign-out or an ended session clears NOTHING', async () => {
    const { tracker, storage } = make();
    await tracker.begin();
    tracker.rememberPayload({ a: 1 });
    tracker.settle();
    await tracker.onSignOut();
    expect(stored(storage).items).toHaveLength(1);
    expect(tracker.getCurrent()).not.toBeNull();
    expect(tracker.getOriginalPayload()).toEqual({ a: 1 });
  });
  test('ANOTHER account signing in finds none of it: the stored keys are deleted and the draft\'s key and payload are dropped', async () => {
    const { tracker, storage, who, generate } = make();
    const mine = await tracker.begin();
    tracker.rememberPayload({ a: 1 });
    tracker.settle();
    await tracker.onSignOut();
    who.id = 'patient:8'; // a different account logs in
    await tracker.onSignIn();
    expect(stored(storage)).toBeNull(); // deleted, not just hidden
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(await tracker.pending()).toEqual([]);
    const theirs = await tracker.begin();
    expect(theirs).not.toBe(mine); // a NEW key: the first account's key is not reused
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test('only the OTHER account\'s entries go: the signing-in account\'s own entries stay', async () => {
    const storage = memoryStorage();
    const a = make({ storage, user: 'patient:7' });
    await a.tracker.begin(); a.tracker.settle();
    const b = make({ storage, user: 'patient:8', generate: jest.fn(() => '00000000-0000-4000-8000-0000000000bb') });
    await b.tracker.begin(); b.tracker.settle();
    expect(stored(storage).items).toHaveLength(2);
    await b.tracker.onSignIn();
    expect(stored(storage).items.map((i) => i.userId)).toEqual(['patient:8']);
  });
  test('a patient and a corporate user with the same number are different accounts', async () => {
    const { tracker, who } = make({ user: 'patient:7' });
    await tracker.begin(); tracker.settle();
    who.id = 'corporate:7';
    expect(await tracker.pending()).toEqual([]);
  });
  test('pending() never shows another account\'s keys (even before anyone has cleaned them up)', async () => {
    const { tracker, who } = make();
    await tracker.begin(); tracker.settle();
    who.id = 'patient:8';
    expect(await tracker.pending()).toEqual([]);
    who.id = 'patient:7';
    expect(await tracker.pending()).toHaveLength(1);
  });
  test('begin() refuses to carry a key across accounts even if nobody announced the switch', async () => {
    const { tracker, who, generate } = make();
    const mine = await tracker.begin();
    tracker.rememberPayload({ a: 1 });
    tracker.settle();
    who.id = 'patient:8';
    const theirs = await tracker.begin();
    expect(theirs).not.toBe(mine);
    expect(tracker.getOriginalPayload()).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test('with no account that can be named a key still works for this run, but nothing is stored and nothing is shown', async () => {
    const { tracker, storage, who } = make({ user: null });
    const key = await tracker.begin();
    expect(await tracker.begin()).toBe(key);
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(await tracker.pending()).toEqual([]);
    who.id = null;
    await expect(tracker.onSignIn()).resolves.toBeUndefined();
  });
  test('an account that cannot be read (the reader throws) counts as "none"', async () => {
    const tracker = createSubmissionTracker({ storage: memoryStorage(), getUserId: async () => { throw new Error('keychain'); }, generate: sequence() });
    await expect(tracker.begin()).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await tracker.pending()).toEqual([]);
  });
  test('deleting the account (clearAll) clears everything: every stored key, the draft\'s key and its payload', async () => {
    const storage = memoryStorage();
    const other = make({ storage, user: 'patient:9' });
    await other.tracker.begin(); other.tracker.settle();
    const { tracker } = make({ storage });
    await tracker.begin();
    tracker.rememberPayload({ a: 1 });
    await tracker.clearAll();
    expect(stored(storage)).toBeNull();
    expect(tracker.getCurrent()).toBeNull();
    expect(tracker.getOriginalPayload()).toBeNull();
  });
  test('entries written before accounts were tracked (version 1) are not read', async () => {
    const legacy = JSON.stringify({ v: 1, items: [{ id: '00000000-0000-4000-8000-000000000001', startedAt: Date.now() }] });
    const { tracker } = make({ storage: memoryStorage(legacy) });
    expect(await tracker.pending()).toEqual([]);
  });
  test('an entry with no account is ignored', async () => {
    const raw = JSON.stringify({ v: STORE_VERSION, items: [{ id: '00000000-0000-4000-8000-000000000001', startedAt: Date.now() }, { id: '00000000-0000-4000-8000-000000000002', startedAt: Date.now(), userId: '' }] });
    const { tracker } = make({ storage: memoryStorage(raw) });
    expect(await tracker.pending()).toEqual([]);
  });
  test('sessionChangeHandler routes true to onSignIn and false to onSignOut', () => {
    const tracker = { onSignIn: jest.fn(), onSignOut: jest.fn() };
    const handler = sessionChangeHandler(tracker);
    handler(true);
    handler(false);
    expect([tracker.onSignIn.mock.calls.length, tracker.onSignOut.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('a broken storage never breaks a submission', () => {
  test('unreadable, damaged or foreign content is treated as empty', async () => {
    for (const raw of ['not json', '{"v":99,"items":[]}', '{"v":2,"items":"x"}', '{"v":2,"items":[{"id":"nope","startedAt":1,"userId":"patient:7"},{"id":null},{"startedAt":5}]}', '[]', 'null']) {
      const { tracker } = make({ storage: memoryStorage(raw), now: () => 10 });
      expect(await tracker.pending()).toEqual([]);
      expect(await tracker.begin()).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
  test('a storage that throws on read or write still yields a working key for this run', async () => {
    const storage = { get: async () => { throw new Error('keychain'); }, set: async () => { throw new Error('keychain'); }, del: async () => { throw new Error('keychain'); } };
    const generate = sequence();
    const tracker = createSubmissionTracker({ storage, getUserId: async () => ME, generate });
    const key = await tracker.begin();
    expect(await tracker.begin()).toBe(key);
    await expect(tracker.confirm()).resolves.toBeUndefined();
    await expect(tracker.clearAll()).resolves.toBeUndefined();
    await expect(tracker.onSignIn()).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('userIdFromToken: who a token belongs to (never whether it is valid)', () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = (claims) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`;
  test('names the account from the claims the backend signs (sub and role)', () => {
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient', exp: 1 }))).toBe('patient:7');
    expect(userIdFromToken(jwt({ sub: '42', role: 'corporate' }))).toBe('corporate:42');
    expect(userIdFromToken(jwt({ sub: 9 }))).toBe('patient:9'); // no role: a patient
  });
  test('an EXPIRED token still names its owner (it is only read, never trusted: the server decides access)', () => {
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient', exp: 1, iat: 0 }))).toBe('patient:7');
  });
  test('the same account always gives the same id; different accounts differ', () => {
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient' }))).toBe(userIdFromToken(jwt({ sub: 7, role: 'patient', exp: 999 })));
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient' }))).not.toBe(userIdFromToken(jwt({ sub: 8, role: 'patient' })));
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient' }))).not.toBe(userIdFromToken(jwt({ sub: 7, role: 'corporate' })));
  });
  test('anything that is not a token with a subject is "nobody"', () => {
    for (const bad of [null, undefined, 42, '', 'abc', 'a.b', 'a.b.c.d', '..', `${b64({})}.${b64({ role: 'patient' })}.x`, `${b64({})}.${b64({ sub: '' })}.x`, `${b64({})}.${b64({ sub: {} })}.x`, `${b64({})}.!!!.x`]) {
      expect(userIdFromToken(bad)).toBeNull();
    }
  });
  test('non-ASCII claims do not break it', () => {
    expect(userIdFromToken(jwt({ sub: 7, role: 'patient', name: 'आशा नायर' }))).toBe('patient:7');
  });
});

describe('unconfirmedView: the card never says "failed"', () => {
  const I18N = require('../../data/i18n.json');
  const ALL = [{ edited: false }, { edited: true }];
  test('every phase, edited or not, has a title, a body and sensible actions, all translated', () => {
    for (const { edited } of ALL) for (const phase of PHASES) {
      const view = unconfirmedView({ phase, edited });
      expect(I18N.EN[view.titleKey]).toBeDefined();
      expect(I18N.EN[view.bodyKey]).toBeDefined();
      if (view.noteKey) expect(I18N.EN[view.noteKey]).toBeDefined();
      for (const action of view.actions) expect(I18N.EN[action.labelKey]).toBeDefined();
    }
  });
  test('the title is "we couldn\'t confirm", "received" or "you changed it": never a confirmed failure', () => {
    for (const { edited } of ALL) for (const phase of PHASES) {
      expect(['req_unconfirmed_title', 'req_status_received_title', 'req_edited_title']).toContain(unconfirmedView({ phase, edited }).titleKey);
    }
    expect(I18N.EN.req_unconfirmed_title).toBe("We couldn't confirm whether your request was received");
    for (const key of ['req_unconfirmed_title', 'req_unconfirmed_body', 'req_status_not_found', 'req_status_check_failed', 'req_edited_title', 'req_edited_body', 'req_edited_not_found', 'req_resend_note']) {
      expect(I18N.EN[key]).not.toMatch(/\b(failed|failure|error|not submitted|could not be submitted|wasn't submitted)\b/i);
    }
  });
  test('Review (the form is still here): Check status and Submit again, with a note that Submit again sends the request exactly as first sent', () => {
    const view = unconfirmedView({ phase: 'unknown', canSubmitAgain: true });
    expect(view.actions.map((a) => a.id)).toEqual(['check', 'submitAgain']);
    expect(view.noteKey).toBe('req_resend_note');
    expect(I18N.EN.req_resend_note).toMatch(/exactly as it was first sent/);
  });
  test('Home (no form): Check status and Dismiss, and no "submit again" note', () => {
    const view = unconfirmedView({ phase: 'unknown', canSubmitAgain: false });
    expect(view.actions.map((a) => a.id)).toEqual(['check', 'dismiss']);
    expect(view.noteKey).toBeUndefined();
  });
  test('the form was CHANGED: nothing offers to send the edits under the old key; the choices are explicit and the original is resolved first', () => {
    const unknown = unconfirmedView({ phase: 'unknown', edited: true });
    expect(unknown.titleKey).toBe('req_edited_title');
    expect(unknown.actions.map((a) => a.id)).toEqual(['check', 'resendOriginal']); // no "submit my changes" until the original is resolved
    expect(unconfirmedView({ phase: 'failed', edited: true }).actions.map((a) => a.id)).toEqual(['check', 'resendOriginal']);
    expect(unconfirmedView({ phase: 'found', edited: true }).actions.map((a) => a.id)).toEqual(['submitChanges', 'keepOriginal']);
    expect(unconfirmedView({ phase: 'notfound', edited: true }).actions.map((a) => a.id)).toEqual(['check', 'resendOriginal', 'discardAndSubmit']);
    for (const phase of ['unknown', 'failed', 'checking']) {
      expect(unconfirmedView({ phase, edited: true }).actions.map((a) => a.id)).not.toContain('submitChanges');
      expect(unconfirmedView({ phase, edited: true }).actions.map((a) => a.id)).not.toContain('discardAndSubmit');
    }
  });
  test('the edited texts say the original may exist, that changes are not applied to it, and that there could be two requests', () => {
    expect(I18N.EN.req_edited_body).toMatch(/original may already have been received/);
    expect(I18N.EN.req_edited_found).toMatch(/without your changes/);
    expect(I18N.EN.req_edited_not_found).toMatch(/there could be two requests/);
  });
  test('while checking only the loading Check button shows (no second send can be started meanwhile)', () => {
    for (const edited of [false, true]) expect(unconfirmedView({ phase: 'checking', edited }).actions).toEqual([{ id: 'check', labelKey: 'req_check_status', primary: true, loading: true }]);
  });
  test('"not found" and "could not check" keep both choices', () => {
    for (const phase of ['notfound', 'failed']) expect(unconfirmedView({ phase }).actions.map((a) => a.id)).toEqual(['check', 'submitAgain']);
  });
  test('found: with documents still to upload it continues (the same key); without, there is nothing to do', () => {
    expect(unconfirmedView({ phase: 'found', hasFiles: true }).actions.map((a) => a.id)).toEqual(['continue']);
    expect(unconfirmedView({ phase: 'found', hasFiles: false }).actions).toEqual([]);
    expect(unconfirmedView({ phase: 'found', hasFiles: true, canSubmitAgain: false }).actions).toEqual([]);
  });
  test('Home never shows the edited choices (there is no form to have changed)', () => {
    expect(unconfirmedView({ phase: 'unknown', edited: true, canSubmitAgain: false })).toEqual(unconfirmedView({ phase: 'unknown', edited: false, canSubmitAgain: false }));
  });
  test('an unknown phase is treated as "unknown"', () => {
    expect(unconfirmedView({ phase: 'nonsense' })).toEqual(unconfirmedView({ phase: 'unknown' }));
    expect(unconfirmedView()).toEqual(unconfirmedView({ phase: 'unknown' }));
  });
});
