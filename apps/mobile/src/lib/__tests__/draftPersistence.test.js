/* global describe, test, expect, __dirname, Buffer */
// Phase 6: encrypted draft persistence. The REAL schema, envelope, store and manager run against in-memory secure storage and files, with Node's AES-256-GCM standing in for the
// phone's native one (same algorithm, same nonce/tag layout, same additional-data binding). Plus source checks on the wiring (account policy, cleanup, no network, no logging).
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { DRAFT_SERVICES, draftKeysFor, hasAnswers, pickAnswers, validateAnswers } = require('../draftSchema');
const { MAX_DRAFT_BYTES, buildAad, openDraft, sealDraft, utf8Decode, utf8Encode } = require('../draftCrypto');
const { DRAFT_TTL_MS, createDraftStore } = require('../draftStore');
const { createDraftManager } = require('../draftManager');
const I18N = require('../../data/i18n.json');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
const ALICE = 'patient:7';
const BOB = 'patient:8';

const nodeCipher = {
  generateKey: async () => nodeCrypto.randomBytes(32).toString('base64'),
  encrypt: async (keyB64, plain, aad) => {
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
  },
  decrypt: async (keyB64, combinedB64, aad) => {
    const all = Buffer.from(combinedB64, 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), all.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(all.subarray(all.length - 16));
    return new Uint8Array(Buffer.concat([d.update(all.subarray(12, all.length - 16)), d.final()]));
  },
};

const INITIAL = {
  service: 'air', name: '', age: '', gender: '', location: '', sentRequest: null, uploaded: [], uploadErrors: {}, originCity: null, destCity: null, country: '', countryIso: '', cc: '+91',
  phoneCountry: 'IN', ccEdited: false, phone: '', care: [], airlineMode: '', homeAddress: '', homeCaretakers: [], desc: '', dest: '', date: '', files: [], mobility: '', equipOxygen: false,
  equipCardiac: false, equipVentilator: false, urgency: '', changingService: false, oxygenLpm: '',
};

function rig(start = 1_700_000_000_000) {
  const clock = { t: start };
  const secureMap = new Map();
  const fileMap = new Map();
  const log = { removed: [] };
  const secure = { get: async (k) => (secureMap.has(k) ? secureMap.get(k) : null), set: async (k, v) => { secureMap.set(k, v); }, del: async (k) => { secureMap.delete(k); } };
  const files = {
    dir: 'mem://docs/',
    read: async (p) => (fileMap.has(p) ? fileMap.get(p) : null),
    write: async (p, text) => { fileMap.set(p, text); },
    remove: async (p) => { log.removed.push(p); fileMap.delete(p); },
  };
  const hash = async (text) => nodeCrypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
  const store = createDraftStore({ secure, files, cipher: nodeCipher, hash, now: () => clock.t });
  return { clock, secureMap, fileMap, log, secure, files, hash, store };
}

const transportDraft = (extra = {}) => ({
  ...INITIAL, service: 'commercialair', name: 'Asha Rao', age: '45', gender: 'Female', location: 'Mumbai', dest: 'Delhi', phone: '9876543210', desc: 'Chest pain with breathlessness',
  date: '2026-12-01', urgency: 'urgent_24h', care: ['crit_icu'], equipOxygen: true, oxygenLpm: '4', ...extra,
});

describe('envelope: AES-256-GCM, bound to account, version and service', () => {
  test('round trip; the file holds no plaintext, no account, no service, no field name', async () => {
    const r = rig();
    const saved = await r.store.save(ALICE, 'commercialair', 2, transportDraft());
    expect(saved.ok).toBe(true);
    const text = [...r.fileMap.values()].join('');
    for (const secret of ['Asha Rao', 'Chest pain', 'Mumbai', '9876543210', 'commercialair', 'patient:7', 'urgency', 'name']) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({ v: 1, d: expect.any(String) });
    const loaded = await r.store.load(ALICE, INITIAL);
    expect(loaded.status).toBe('ok');
    expect(loaded.service).toBe('commercialair');
    expect(loaded.step).toBe(2);
    expect(loaded.values.name).toBe('Asha Rao');
    expect(loaded.values.desc).toBe('Chest pain with breathlessness');
  });

  test('UTF-8 helpers round trip text in every app language', () => {
    for (const s of ['plain', 'हिन्दी अनुरोध', 'ગુજરાતી', 'తెలుగు', 'عربي', 'emoji 🚑 ok']) expect(utf8Decode(utf8Encode(s))).toBe(s);
    expect(() => utf8Decode(Uint8Array.from([0xff, 0xfe]))).toThrow();
  });

  test('a wrong key, another account, another service, another version, or a changed byte never decrypts', async () => {
    const key = await nodeCipher.generateKey();
    const file = await sealDraft(nodeCipher, key, ALICE, 'tele', { savedAt: 1, step: 1, values: { name: 'X' } });
    expect(await openDraft(nodeCipher, key, ALICE, 'tele', file)).toEqual({ savedAt: 1, step: 1, values: { name: 'X' } });
    expect(await openDraft(nodeCipher, await nodeCipher.generateKey(), ALICE, 'tele', file)).toBeNull();
    expect(await openDraft(nodeCipher, key, BOB, 'tele', file)).toBeNull();
    expect(await openDraft(nodeCipher, key, ALICE, 'marine', file)).toBeNull();
    expect(await openDraft(nodeCipher, key, ALICE, 'tele', JSON.stringify({ ...JSON.parse(file), v: 2 }))).toBeNull();
    const bytes = Buffer.from(JSON.parse(file).d, 'base64');
    bytes[20] ^= 1;
    expect(await openDraft(nodeCipher, key, ALICE, 'tele', JSON.stringify({ v: 1, d: bytes.toString('base64') }))).toBeNull();
    expect(await openDraft(nodeCipher, key, ALICE, 'tele', 'not json')).toBeNull();
    expect(Buffer.from(buildAad(ALICE, 'tele')).toString()).toBe('humancare-draft|v1|patient:7|tele');
  });

  test('a tampered or copied file is discarded together with its key', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'Meera' });
    const [file] = [...r.fileMap.keys()];
    const env = JSON.parse(r.fileMap.get(file));
    const bytes = Buffer.from(env.d, 'base64');
    bytes[bytes.length - 1] ^= 1; // the authentication tag
    r.fileMap.set(file, JSON.stringify({ v: 1, d: bytes.toString('base64') }));
    expect(await r.store.load(ALICE, INITIAL)).toEqual({ status: 'invalid', reason: 'authentication' });
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });
});

describe('whitelist: only form answers and the step are persisted', () => {
  test('files, sentRequest, uploaded, uploadErrors, changingService, tokens, OTPs and Phase 4 data never reach the store', async () => {
    const r = rig();
    const dirty = transportDraft({
      files: [{ uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 10 }], sentRequest: { id: 5, referenceNumber: 'HC-1' }, uploaded: ['file:///cache/report.pdf'],
      uploadErrors: { 'file:///cache/report.pdf': 'boom' }, changingService: true, clientRequestId: '00000000-0000-4000-8000-000000000001', token: 'jwt.token.sig', otp: '123456', payload: { a: 1 },
    });
    const answers = pickAnswers('commercialair', dirty);
    for (const banned of ['files', 'sentRequest', 'uploaded', 'uploadErrors', 'changingService', 'clientRequestId', 'token', 'otp', 'payload', 'service']) expect(answers).not.toHaveProperty(banned);
    await r.store.save(ALICE, 'commercialair', 3, dirty);
    const loaded = await r.store.load(ALICE, INITIAL);
    expect(loaded.values.files).toEqual([]); // the empty default, not the saved list
    expect(loaded.values.sentRequest).toBeNull();
    expect(loaded.values.uploaded).toEqual([]);
    expect(loaded.values.changingService).toBe(false);
    expect(loaded.values).not.toHaveProperty('clientRequestId');
    expect(loaded.values).not.toHaveProperty('token');
  });

  test('each service saves only its own keys (a Corporate draft carries no patient trip fields)', () => {
    const corp = { ...INITIAL, service: 'corporate', name: 'HR Lead', corpCompany: 'Acme', corpEmployees: '120', corpProgrammes: ['doctor', 'events'], corpOfficeCountryIso: 'IN', location: 'Mumbai', dest: 'Pune', desc: 'x' };
    const picked = pickAnswers('corporate', corp);
    expect(Object.keys(picked).sort()).toEqual(['age', 'cc', 'ccEdited', 'corpCompany', 'corpEmployees', 'corpOfficeCountryIso', 'corpProgrammes', 'country', 'countryIso', 'gender', 'name', 'phone', 'phoneCountry']);
    expect(picked).not.toHaveProperty('location');
    expect(picked).not.toHaveProperty('desc');
    expect(draftKeysFor('nonsense')).toEqual([]);
  });

  test('a draft with nothing typed is not worth saving; the preset phone code is not an answer', () => {
    expect(hasAnswers('commercialair', INITIAL, INITIAL)).toBe(false);
    expect(hasAnswers('commercialair', { ...INITIAL, name: 'A' }, INITIAL)).toBe(true);
    expect(hasAnswers('commercialair', { ...INITIAL, cc: '+971', phoneCountry: 'AE' }, INITIAL)).toBe(false);
  });

  test('about 64 KB at most: the envelope refuses a larger draft, and the largest whitelisted draft is far below the cap', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'Meera', desc: 'small' });
    const huge = { ...INITIAL, service: 'tele', name: 'Meera', desc: 'x'.repeat(4000), address: 'y'.repeat(4000), allergies: 'z'.repeat(4000) };
    expect((await r.store.save(ALICE, 'tele', 1, huge)).ok).toBe(true); // three 4,000-character fields fit (well under the cap)
    expect(MAX_DRAFT_BYTES).toBe(65536);
    const key = await nodeCipher.generateKey();
    await expect(sealDraft(nodeCipher, key, ALICE, 'tele', { savedAt: 1, step: 1, values: { desc: 'é'.repeat(40000) } })).rejects.toThrow('too_large');
  });
});

describe('seven-day expiry from the last save', () => {
  test('a save restarts the clock; at seven days the ciphertext AND the key are deleted on read', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'Meera' });
    r.clock.t += DRAFT_TTL_MS - 1000;
    expect((await r.store.load(ALICE, INITIAL)).status).toBe('ok');
    await r.store.save(ALICE, 'tele', 2, { ...INITIAL, service: 'tele', name: 'Meera K' }); // saved again: seven days start over
    r.clock.t += DRAFT_TTL_MS - 1000;
    const still = await r.store.load(ALICE, INITIAL);
    expect(still.status).toBe('ok');
    expect(still.step).toBe(2);
    r.clock.t += 2000;
    expect(await r.store.load(ALICE, INITIAL)).toEqual({ status: 'expired' });
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });

  test('writing over an expired draft deletes the old key first (the new draft has a fresh key)', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'Old' });
    const oldKey = [...r.secureMap.values()][0];
    r.clock.t += DRAFT_TTL_MS + 5;
    await r.store.save(ALICE, 'marine', 1, { ...INITIAL, service: 'marine', name: 'New' });
    expect([...r.secureMap.values()][0]).not.toBe(oldKey);
    expect((await r.store.load(ALICE, INITIAL)).values.name).toBe('New');
  });
});

const storeWith = (r, { files = r.files, cipher = nodeCipher, secure = r.secure } = {}) => createDraftStore({ secure, files, cipher, hash: r.hash, now: () => r.clock.t });
const slotPaths = (r) => [...r.fileMap.keys()];
const isSlot = (p) => /\.[ab]\.enc$/.test(p);
const draftOf = (name, service = 'tele') => ({ ...INITIAL, service, name });
// A process that DIES at the Nth file write: 'before' (nothing of it lands), 'torn' (half the bytes land) or 'after' (every byte lands). From that moment nothing else it tries
// (including cleanup in a catch block) reaches storage, exactly as when a process is killed. The test then "restarts" with a fresh store over the same storage.
const crashing = (r, mode, nth) => {
  let count = 0;
  let dead = false;
  const files = {
    ...r.files,
    write: async (p, text) => {
      if (dead) return undefined;
      count += 1;
      if (count !== nth) return r.files.write(p, text);
      dead = true;
      if (mode === 'torn') await r.files.write(p, text.slice(0, Math.floor(text.length / 2)));
      if (mode === 'after') await r.files.write(p, text);
      throw new Error('process died: Meera');
    },
    remove: async (p) => (dead ? undefined : r.files.remove(p)),
  };
  const secure = { ...r.secure, set: async (k, v) => (dead ? undefined : r.secure.set(k, v)), del: async (k) => (dead ? undefined : r.secure.del(k)) };
  return { files, secure };
};

describe('replacement without deleting the last known-good draft (two slots, newest authenticated slot wins)', () => {
  test('a replacement never deletes, moves or rewrites the slot that holds the newest valid draft; saves alternate between the slots and the sequence rises', async () => {
    const r = rig();
    const writes = [];
    const files = { ...r.files, write: async (p, t) => { writes.push(p); return r.files.write(p, t); } };
    const store = storeWith(r, { files });
    await store.save(ALICE, 'tele', 1, draftOf('One'));
    const first = slotPaths(r).filter(isSlot);
    expect(first).toHaveLength(1);
    r.log.removed.length = 0;
    await store.save(ALICE, 'tele', 1, draftOf('Two'));
    expect(r.log.removed.filter(isSlot)).toEqual([]); // nothing of a slot was deleted
    expect(writes[1]).not.toBe(writes[0]); // the new draft went to the OTHER slot
    expect(slotPaths(r).filter(isSlot)).toHaveLength(2);
    await store.save(ALICE, 'tele', 1, draftOf('Three'));
    expect(writes[2]).toBe(writes[0]); // the older slot is reused
    expect((await store.load(ALICE, INITIAL)).values.name).toBe('Three');
    expect(writes.every((p) => isSlot(p))).toBe(true); // no temp file, no plaintext file
    expect([...r.fileMap.values()].join('')).not.toContain('Three');
  });

  test.each(['before', 'torn', 'after'])('an interrupted REPLACEMENT (%s) leaves exactly the previous or the new valid draft, never a corrupted or empty one', async (mode) => {
    const r = rig();
    await storeWith(r).save(ALICE, 'tele', 2, draftOf('Old'));
    const dying = storeWith(r, crashing(r, mode, 1));
    const result = await dying.save(ALICE, 'tele', 3, draftOf('New'));
    expect(result).toEqual({ ok: false, reason: 'storage' }); // reported as not saved, with no cause
    // "the app restarts": a fresh store over the same storage
    const loaded = await storeWith(r).load(ALICE, INITIAL);
    expect(loaded.status).toBe('ok');
    expect(loaded.values.name).toBe(mode === 'after' ? 'New' : 'Old');
    expect(loaded.step).toBe(mode === 'after' ? 3 : 2);
    expect(JSON.stringify([...r.fileMap.values()])).not.toContain('Meera'); // no error text, no plaintext
    // and a later save works and wins, reusing the torn slot
    expect((await storeWith(r).save(ALICE, 'tele', 1, draftOf('Later'))).ok).toBe(true);
    expect((await storeWith(r).load(ALICE, INITIAL)).values.name).toBe('Later');
  });

  test.each(['before', 'torn', 'after'])('an interrupted FIRST save (%s) leaves the new draft or nothing, never half a draft and never an orphan key', async (mode) => {
    const r = rig();
    expect((await storeWith(r, crashing(r, mode, 1)).save(ALICE, 'tele', 1, draftOf('First'))).ok).toBe(false);
    const loaded = await storeWith(r).load(ALICE, INITIAL);
    if (mode === 'after') { expect(loaded.status).toBe('ok'); expect(loaded.values.name).toBe('First'); return; }
    expect(['none', 'invalid']).toContain(loaded.status); // 'invalid' = a torn file that failed authentication: discarded and explained
    expect(loaded.status).toBe(mode === 'before' ? 'none' : 'invalid');
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0); // the key made for the save that did not happen is gone too
  });

  test('an interruption while the key is being stored saves nothing and leaves nothing', async () => {
    const r = rig();
    const brokenSecure = { ...r.secure, set: async () => { throw new Error('keystore locked'); } };
    expect(await storeWith(r, { secure: brokenSecure }).save(ALICE, 'tele', 1, draftOf('A'))).toEqual({ ok: false, reason: 'storage' });
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });

  test('the newest slot is corrupted (or fails validation): the previous valid draft is returned, and both slots bad is reported, not returned as empty', async () => {
    const r = rig();
    const store = storeWith(r);
    await store.save(ALICE, 'tele', 1, draftOf('Previous'));
    await store.save(ALICE, 'tele', 2, draftOf('Newest'));
    const newest = slotPaths(r).find((p) => p.endsWith('.b.enc')); // the saves alternate a, b: the second one is in b
    const bytes = Buffer.from(JSON.parse(r.fileMap.get(newest)).d, 'base64');
    bytes[15] ^= 1;
    r.fileMap.set(newest, JSON.stringify({ v: 1, d: bytes.toString('base64') }));
    const fallback = await storeWith(r).load(ALICE, INITIAL);
    expect(fallback.status).toBe('ok');
    expect(fallback.values.name).toBe('Previous');
    for (const p of slotPaths(r)) r.fileMap.set(p, r.fileMap.get(p).slice(0, 20)); // both slots torn
    expect(await storeWith(r).load(ALICE, INITIAL)).toEqual({ status: 'invalid', reason: 'authentication' });
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });

  test('a newer slot that fails restore validation falls back to the older valid one', async () => {
    const r = rig();
    const key = await nodeCipher.generateKey();
    const id = await r.hash(`humancare-draft-account|${ALICE}`);
    r.secureMap.set(`humancare_draft_key_${id}`, key);
    const put = async (suffix, seq, values) => r.fileMap.set(`mem://docs/humancare-draft-${id}.${suffix}.enc`, await sealDraft(nodeCipher, key, ALICE, 'tele', { seq, savedAt: r.clock.t, step: 1, values }));
    await put('a', 4, { name: 'Good older' });
    await put('b', 5, { name: 'Bad newer', gender: 'Robot' });
    const loaded = await storeWith(r).load(ALICE, INITIAL);
    expect(loaded.status).toBe('ok');
    expect(loaded.values.name).toBe('Good older');
  });

  test('stale temporary, backup and older-layout files are deleted by the next read; a valid draft survives them', async () => {
    const r = rig();
    await storeWith(r).save(ALICE, 'tele', 1, draftOf('Keep'));
    const id = await r.hash(`humancare-draft-account|${ALICE}`);
    const stale = [`mem://docs/humancare-draft-${id}.tmp`, `mem://docs/humancare-draft-${id}.enc`];
    for (const p of stale) r.fileMap.set(p, 'leftover');
    expect((await storeWith(r).load(ALICE, INITIAL)).values.name).toBe('Keep');
    for (const p of stale) expect(r.fileMap.has(p)).toBe(false);
  });

  test('discard removes every slot, every stale file and the key', async () => {
    const r = rig();
    const store = storeWith(r);
    await store.save(ALICE, 'tele', 1, draftOf('A'));
    await store.save(ALICE, 'tele', 1, draftOf('B'));
    const id = await r.hash(`humancare-draft-account|${ALICE}`);
    r.fileMap.set(`mem://docs/humancare-draft-${id}.tmp`, 'leftover');
    await store.discard(ALICE);
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });

  test('a failing write reports the failure without throwing, keeps no orphan key, and keeps the earlier draft', async () => {
    const r = rig();
    const failing = { ...r.files, write: async () => { throw new Error('disk full: Meera'); } };
    expect(await storeWith(r, { files: failing }).save(ALICE, 'tele', 1, draftOf('Meera'))).toEqual({ ok: false, reason: 'storage' });
    expect(r.secureMap.size).toBe(0);
    await storeWith(r).save(ALICE, 'tele', 1, draftOf('Kept'));
    expect((await storeWith(r, { files: failing }).save(ALICE, 'tele', 2, draftOf('Lost'))).ok).toBe(false);
    expect((await storeWith(r).load(ALICE, INITIAL)).values.name).toBe('Kept');
  });

  test('no move or rename is used anywhere (no assumption about how a platform replaces a target)', () => {
    const code = (file) => read(file).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code('lib/draftStore.js')).not.toMatch(/files\.move|moveAsync|rename/);
    expect(code('lib/draftStoreDevice.js')).not.toMatch(/moveAsync|copyAsync|\bmove:/);
  });
});

// A manager over a rig, with a controllable "signed-in account", manual timers and gates that hold the encryption or the file write open.
function managerRig({ gateEncrypt = false, gateWrite = false } = {}) {
  const r = rig();
  const state = { current: ALICE };
  const gates = { encrypt: null, write: null };
  const hold = (name) => { let release; const entered = new Promise((resolve) => { gates[name] = { entered: resolve }; }); const open = new Promise((resolve) => { release = resolve; }); return { entered, open, release }; };
  const encryptGate = gateEncrypt ? hold('encrypt') : null;
  const writeGate = gateWrite ? hold('write') : null;
  const cipher = { ...nodeCipher, encrypt: async (k, p, a) => { if (encryptGate) { gates.encrypt.entered(); await encryptGate.open; } return nodeCipher.encrypt(k, p, a); } };
  const files = { ...r.files, write: async (p, t) => { if (writeGate) { gates.write.entered(); await writeGate.open; } return r.files.write(p, t); } };
  const store = storeWith(r, { files, cipher });
  const timers = [];
  const manager = createDraftManager({ store, getAccountId: async () => state.current, defaults: INITIAL, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
  manager.setAccount(ALICE);
  return { r, state, manager, store, encryptGate, writeGate, timers };
}
const states = (manager) => { const seen = []; manager.subscribe((s) => seen.push(s)); return seen; };

describe('account switch during an asynchronous save', () => {
  test('a switch during a delayed ENCRYPTION stops the save: nothing is written, no key is left, and the new account sees nothing', async () => {
    const m = managerRig({ gateEncrypt: true });
    m.manager.schedule(draftOf('Alice typed'), 1);
    const saving = m.manager.flush();
    await m.encryptGate.entered;
    m.state.current = BOB;
    m.manager.setAccount(BOB); // another account signed in while Alice's save was encrypting
    m.encryptGate.release();
    const result = await saving;
    expect(result).toEqual({ ok: false, reason: 'account' });
    expect(m.r.fileMap.size).toBe(0);
    expect(m.r.secureMap.size).toBe(0);
    expect(await m.store.load(BOB, INITIAL)).toEqual({ status: 'none' });
    expect(await m.store.load(ALICE, INITIAL)).toEqual({ status: 'none' });
    expect(m.manager.getStatus()).not.toBe('saved');
  });

  test('a switch during a delayed FILE WRITE: the bytes land only in the owner\'s own slot, are not reported as saved, and the other account sees nothing', async () => {
    const m = managerRig({ gateWrite: true });
    m.manager.schedule(draftOf('Alice typed'), 1);
    const saving = m.manager.flush();
    await m.writeGate.entered;
    m.state.current = BOB;
    m.manager.setAccount(BOB);
    m.writeGate.release();
    expect(await saving).toEqual({ ok: false, reason: 'account' });
    expect(m.manager.getStatus()).not.toBe('saved');
    expect(await m.store.load(BOB, INITIAL)).toEqual({ status: 'none' });
    for (const p of m.r.fileMap.keys()) expect(p).toContain(await m.r.hash(`humancare-draft-account|${ALICE}`)); // only Alice's slot names exist
    const alices = await m.store.load(ALICE, INITIAL); // her draft is hers: it is there for her when she signs in again
    expect(alices.values.name).toBe('Alice typed');
  });

  test('an explicit logout during a delayed write leaves nothing behind: the running save finishes first, then the deletion removes it and the key', async () => {
    const m = managerRig({ gateWrite: true });
    m.manager.schedule(draftOf('Alice typed'), 1);
    const saving = m.manager.flush();
    await m.writeGate.entered;
    const logout = m.manager.discard(ALICE);
    m.writeGate.release();
    await saving;
    await logout;
    expect(m.r.fileMap.size).toBe(0);
    expect(m.r.secureMap.size).toBe(0);
    expect(await m.store.load(ALICE, INITIAL)).toEqual({ status: 'none' });
  });

  test('a switch while a save is only WAITING drops it; the old account\'s edits are never written for anyone', async () => {
    const m = managerRig();
    m.manager.schedule(draftOf('Alice typed'), 1);
    expect(m.manager.isWaiting()).toBe(true);
    m.state.current = BOB;
    m.manager.setAccount(BOB);
    expect(m.manager.isWaiting()).toBe(false);
    await m.manager.flush();
    expect(m.r.fileMap.size).toBe(0);
    m.manager.schedule(draftOf('Bob typed'), 1); // Bob's own change is saved for Bob
    expect((await m.manager.flush()).ok).toBe(true);
    expect((await m.store.load(BOB, INITIAL)).values.name).toBe('Bob typed');
    expect(await m.store.load(ALICE, INITIAL)).toEqual({ status: 'none' });
  });

  test('the store checks the account before the key, before encrypting, before writing and after writing', async () => {
    const r = rig();
    const calls = [];
    const verify = async () => { calls.push(1); return true; };
    await storeWith(r).save(ALICE, 'tele', 1, draftOf('A'), { verify });
    expect(calls.length).toBe(4); // on entry, before the key is made, before writing, after writing
    const refusing = await storeWith(r).save(ALICE, 'tele', 1, draftOf('B'), { verify: async () => false });
    expect(refusing).toEqual({ ok: false, reason: 'account' });
    expect((await storeWith(r).load(ALICE, INITIAL)).values.name).toBe('A');
  });
});

describe('save status: Saving, Saved, Unable to save (no content, never blocks the form)', () => {
  test('idle -> saving on a change -> saved only after the encrypted write completed', async () => {
    const m = managerRig();
    const seen = states(m.manager);
    expect(m.manager.getStatus()).toBe('idle');
    m.manager.schedule(draftOf('Meera'), 1);
    expect(m.manager.getStatus()).toBe('saving');
    await m.manager.flush();
    expect(m.manager.getStatus()).toBe('saved');
    m.manager.schedule(draftOf('Meera K'), 1); // an edit after a save is "saving" again, never still "saved"
    expect(m.manager.getStatus()).toBe('saving');
    await m.manager.flush();
    expect(seen).toEqual(['saving', 'saved', 'saving', 'saved']);
  });

  test('a failing store says "Unable to save" and never "saved"; the form keeps working and the next good write recovers', async () => {
    const r = rig();
    let failing = true;
    const files = { ...r.files, write: async (p, t) => { if (failing) throw new Error('disk full: Meera Kapoor'); return r.files.write(p, t); } };
    const manager = createDraftManager({ store: storeWith(r, { files }), getAccountId: async () => ALICE, defaults: INITIAL, setTimer: () => 1, clearTimer: () => undefined });
    manager.setAccount(ALICE);
    const seen = states(manager);
    manager.schedule(draftOf('Meera Kapoor'), 1);
    await expect(manager.flush()).resolves.toEqual({ ok: false, reason: 'storage' }); // nothing is thrown into the form
    expect(manager.getStatus()).toBe('error');
    manager.schedule(draftOf('Meera Kapoor 2'), 1); // typing goes on, and is attempted again
    expect(manager.getStatus()).toBe('saving');
    failing = false;
    await manager.flush();
    expect(manager.getStatus()).toBe('saved');
    expect(seen.every((s) => ['idle', 'saving', 'saved', 'error'].includes(s))).toBe(true); // only the four words ever leave the manager
    expect(JSON.stringify(seen)).not.toMatch(/Meera|disk/);
  });

  test('a save stopped because the account changed is not "saved" and not "error" for the new account; discard and reset return to idle', async () => {
    const m = managerRig({ gateWrite: true });
    m.manager.schedule(draftOf('Alice typed'), 1);
    const saving = m.manager.flush();
    await m.writeGate.entered;
    m.state.current = BOB;
    m.manager.setAccount(BOB);
    expect(m.manager.getStatus()).toBe('idle');
    m.writeGate.release();
    await saving;
    expect(m.manager.getStatus()).toBe('idle');
    m.manager.schedule(draftOf('Bob'), 1);
    m.manager.reset(false);
    expect(m.manager.getStatus()).toBe('idle');
  });

  test('on a phone without secure storage (the web preview) no status is ever shown, because nothing is scheduled', () => {
    const device = read('lib/draftStoreDevice.js');
    expect(device).toContain("save: async () => ({ ok: false, reason: 'unsupported' })");
    expect(read('state/AppContext.js')).toMatch(/formStep === null \|\| !draftsSupported\) return;\n {4}draftManager\.schedule/);
  });

  test('there is no draft status line: the form shows nothing about saving, and never blocks entry when storage fails', () => {
    expect(fs.existsSync(path.join(__dirname, '../../components/request/DraftStatus.js'))).toBe(false);
    expect(read('components/request/RequestFrame.js')).not.toMatch(/DraftStatus/);
  });
});

describe('accounts: a draft belongs to one account', () => {
  test('the same account finds its draft; a different account never sees it; each has its own key', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'Alice draft' });
    expect((await r.store.load(ALICE, INITIAL)).values.name).toBe('Alice draft');
    expect(await r.store.load(BOB, INITIAL)).toEqual({ status: 'none' });
    expect(await r.store.load(null, INITIAL)).toEqual({ status: 'none' });
    await r.store.save(BOB, 'marine', 1, { ...INITIAL, service: 'marine', name: 'Bob draft' });
    expect(new Set(r.secureMap.values()).size).toBe(2);
    expect((await r.store.load(ALICE, INITIAL)).values.name).toBe('Alice draft');
  });

  test('discard deletes the key first, then both files, and leaves the other account alone', async () => {
    const r = rig();
    await r.store.save(ALICE, 'tele', 1, { ...INITIAL, service: 'tele', name: 'A' });
    await r.store.save(BOB, 'tele', 1, { ...INITIAL, service: 'tele', name: 'B' });
    expect(await r.store.discard(ALICE)).toBe(true);
    expect((await r.store.load(ALICE, INITIAL)).status).toBe('none');
    expect((await r.store.load(BOB, INITIAL)).values.name).toBe('B');
    expect(r.secureMap.size).toBe(1);
    expect(r.fileMap.size).toBe(1);
  });

  test('the manager writes for the account that made the change, never for another; an expired session (nobody signed in) still saves for its owner', async () => {
    const r = rig();
    let current = ALICE;
    const timers = [];
    const manager = createDraftManager({ store: r.store, getAccountId: async () => current, defaults: INITIAL, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    manager.schedule({ ...INITIAL, service: 'tele', name: 'Alice typed' }, 1);
    await new Promise((resolve) => setImmediate(resolve)); // the change has been attributed to Alice
    current = BOB; // another account signed in before the write was due
    expect(await manager.flush()).toEqual({ ok: false, reason: 'account' });
    expect(r.fileMap.size).toBe(0);
    current = ALICE;
    manager.schedule({ ...INITIAL, service: 'tele', name: 'Alice typed' }, 1);
    await new Promise((resolve) => setImmediate(resolve));
    current = null; // the session expired: the draft is kept for Alice
    expect((await manager.flush()).ok).toBe(true);
    current = ALICE;
    expect((await r.store.load(ALICE, INITIAL)).values.name).toBe('Alice typed');
  });

  test('the manager debounces, skips a submitted form and an empty one, and clears the draft when everything is erased by hand', async () => {
    const r = rig();
    const timers = [];
    const manager = createDraftManager({ store: r.store, getAccountId: async () => ALICE, defaults: INITIAL, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined });
    manager.schedule({ ...INITIAL, service: 'tele', name: 'A' }, 1);
    manager.schedule({ ...INITIAL, service: 'tele', name: 'Ab' }, 1);
    expect(manager.isWaiting()).toBe(true);
    expect(r.fileMap.size).toBe(0); // nothing written until the delay has passed or the app is backgrounded
    await manager.flush();
    expect((await r.store.load(ALICE, INITIAL)).values.name).toBe('Ab');
    manager.schedule({ ...INITIAL, service: 'tele', name: 'Ab', sentRequest: { id: 1 } }, 1);
    expect(manager.isWaiting()).toBe(false); // a request that was saved is not a draft
    manager.schedule({ ...INITIAL, service: 'tele' }, 1);
    expect((await manager.flush()).cleared).toBe(true);
    expect((await r.store.load(ALICE, INITIAL)).status).toBe('none');
    expect(r.secureMap.size).toBe(0);
  });

  test('a confirmed submission drops what is waiting and deletes the draft and its key', async () => {
    const r = rig();
    const manager = createDraftManager({ store: r.store, getAccountId: async () => ALICE, defaults: INITIAL, setTimer: () => 1, clearTimer: () => undefined });
    manager.schedule({ ...INITIAL, service: 'tele', name: 'A' }, 1);
    await manager.flush();
    manager.schedule({ ...INITIAL, service: 'tele', name: 'AA' }, 1);
    await manager.submitted(ALICE);
    expect(manager.isWaiting()).toBe(false);
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
  });
});

describe('restore validation', () => {
  const ok = { name: 'Asha', age: '45', gender: 'Female', cc: '+91', phoneCountry: 'IN', phone: '98765 43210', date: '2026-12-01', urgency: 'planned', care: ['crit_icu'] };
  test('merges the answers over the form defaults, strips unknown keys, and keeps the service', () => {
    const result = validateAnswers('commercialair', { ...ok, sentRequest: { id: 1 }, files: [{ uri: 'file:///x' }], bogus: 1 }, INITIAL);
    expect(result.ok).toBe(true);
    expect(result.values.name).toBe('Asha');
    expect(result.values.service).toBe('commercialair');
    expect(result.values.files).toEqual([]);
    expect(result.values.sentRequest).toBeNull();
    expect(result.values).not.toHaveProperty('bogus');
    expect(result.values.equipOxygen).toBe(false); // not saved: the normal empty value
  });

  test.each([
    ['gender not one of the choices', { gender: 'Robot' }],
    ['urgency not one of the choices', { urgency: 'whenever' }],
    ['a date that does not exist', { date: '2026-02-30' }],
    ['a date in the wrong format', { date: '01/12/2026' }],
    ['a country code that is not two capitals', { countryIso: 'india' }],
    ['a phone code that is not a +number', { cc: '91' }],
    ['age that is not digits', { age: '4x' }],
    ['a number where text belongs', { name: 5 }],
    ['text over the length limit', { desc: 'x'.repeat(4001) }],
    ['a care level that is not known', { care: ['made_up'] }],
    ['two care levels where one is allowed', { care: ['crit_icu', 'crit_ecmo'] }],
    ['a city that is not a verified pick', { originCity: { geonameId: 1, name: 'A', label: 'B', countryCode: 'india' } }],
    ['a boolean that is a string', { equipOxygen: 'true' }],
  ])('refuses %s (nothing is repaired)', (_why, bad) => {
    const result = validateAnswers('commercialair', { ...ok, ...bad }, INITIAL);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Asha'); // the reason never carries answers
  });

  test('an unusable draft on disk is discarded (file and key) and reported as invalid, never half restored', async () => {
    const r = rig();
    const key = await nodeCipher.generateKey();
    const text = await sealDraft(nodeCipher, key, ALICE, 'tele', { seq: 1, savedAt: r.clock.t, step: 1, values: { name: 'Meera', gender: 'Robot' } });
    const id = await r.hash(`humancare-draft-account|${ALICE}`);
    r.secureMap.set(`humancare_draft_key_${id}`, key);
    r.fileMap.set(`mem://docs/humancare-draft-${id}.a.enc`, text);
    expect(await r.store.load(ALICE, INITIAL)).toEqual({ status: 'invalid', reason: 'field:gender' });
    expect(r.fileMap.size).toBe(0);
    expect(r.secureMap.size).toBe(0);
    // a step that is not 1..3 is unusable too
    r.secureMap.set(`humancare_draft_key_${id}`, key);
    r.fileMap.set(`mem://docs/humancare-draft-${id}.a.enc`, await sealDraft(nodeCipher, key, ALICE, 'tele', { seq: 1, savedAt: r.clock.t, step: 9, values: { name: 'M' } }));
    expect((await r.store.load(ALICE, INITIAL)).status).toBe('invalid'); // not a step of the form
    expect(r.fileMap.size).toBe(0);
  });
});

describe('all services are covered', () => {
  const samples = {
    air: { name: 'A', desc: 'd', location: 'Mumbai', dest: 'Delhi' },
    privatecharter: { name: 'A', desc: 'd', location: 'Mumbai', dest: 'Delhi' },
    commercialair: { name: 'A', airlineMode: 'stretcher', care: ['crit_ecmo'] },
    ground: { name: 'A', care: ['crit_icu'], oxygenLpm: '6' },
    mortal: { name: 'A', relation: 'Spouse', deathPlace: 'Pune', deathDate: '2026-11-01', transferScope: 'domestic', transportMode: 'ground_transportation' },
    homecare: { name: 'A', homeAddress: '12 Street', homeCaretakers: ['nurse'], homeCareHours: '24_hours', homeCareLevel: 'semi_icu', homeOxygen: 'yes', oxygenLpm: '3' },
    tele: { name: 'A', teleScope: 'international', teleType: 'house_call', address: '1 Road', allergies: 'none' },
    marine: { name: 'A', serviceScope: 'domestic', marineCare: ['crit_icu'], marineOxygen: 'no' },
    medvalue: { name: 'A', treatmentScope: 'international', specialty: 'Oncology', otherSpecialty: '' },
    corporate: { name: 'A', corpCompany: 'Acme', corpEmployees: '50', corpProgrammes: ['doctor', 'nurse'], corpOfficeAddress: 'HQ', corpOfficeCountry: 'India', corpOfficeCountryIso: 'IN' },
  };
  test.each(DRAFT_SERVICES)('%s saves, restores on its saved step, and restores nothing it did not save', async (service) => {
    const r = rig();
    expect(samples[service]).toBeDefined();
    await r.store.save(ALICE, service, 3, { ...INITIAL, ...samples[service], service });
    const loaded = await r.store.load(ALICE, INITIAL);
    expect(loaded.status).toBe('ok');
    expect(loaded.service).toBe(service);
    expect(loaded.step).toBe(3);
    for (const [k, v] of Object.entries(samples[service])) expect(loaded.values[k]).toEqual(v);
  });
  test('every service in the app that has a request form is listed (the hospital listing has none)', () => {
    const services = Object.keys(require('../../data/services.json'));
    expect(DRAFT_SERVICES.slice().sort()).toEqual(services.filter((s) => s !== 'hospital').sort());
  });
});

describe('wiring (source checks)', () => {
  const ctx = read('state/AppContext.js');
  test('explicit logout and account deletion delete the draft and key BEFORE the tokens are cleared; an expired session does not', () => {
    const profile = read('app/(tabs)/profile.js');
    expect(profile).toContain('await signOutSession({ isCorporate, beforeClear: clearDraftEverywhere });'); // sessionEnd.js runs beforeClear (the draft) BEFORE clear (the tokens): sessionEnd.test.js
    const del = read('app/delete-account-otp.js');
    expect(del.indexOf('await clearDraftEverywhere()')).toBeGreaterThan(del.indexOf('submissionTracker.clearAll()'));
    expect(del.indexOf('await clearDraftEverywhere()')).toBeLessThan(del.indexOf('await clearTokens()'));
    expect(read('lib/api.js')).not.toMatch(/draft/i); // the session-expiry path in api.js touches no draft
    expect(read('lib/session.js')).not.toMatch(/draft/i);
    expect(ctx).toContain('else setSavedDraft(null); // signed out (explicit or expired): what is saved stays saved');
    expect(ctx).toContain('trackerSession(signedIn); return signedIn ? authStore.signedIn() : authStore.signedOut(); });'); // the existing session listener is untouched
  });

  test('a confirmed submission deletes the draft (send success and the Submitted screen)', () => {
    expect(read('app/request/review.js')).toContain('discardDraft().catch(() => undefined); // and its saved draft (and key) is deleted');
    expect(read('app/request/submitted.js')).toContain('discardDraft().catch(() => undefined)');
  });

  test('another account never inherits the form in memory or the saved draft', () => {
    expect(ctx).toContain('formAccountRef.current !== id');
    expect(ctx).toMatch(/Promise\.resolve\(currentAccountId\(\)\)\.then\(noteAccount/);
    expect(ctx).toMatch(/draftStore\.load\(id, INITIAL_DRAFT\)/); // loads by the signed-in account only
  });

  test('restoring asks the server for nothing and sends nothing; nothing is submitted by it', () => {
    const resume = ctx.slice(ctx.indexOf('const resumeDraft = useCallback'), ctx.indexOf('// Discard: deletes'));
    expect(resume).not.toMatch(/apiGet|apiPost|apiPatch|fetch\(|postWithKey|submit/);
    const notice = read('components/home/DraftNotice.js');
    expect(notice).not.toMatch(/apiPost|fetch\(|postWithKey/);
    expect(notice).toContain("router.push('/request/step1')"); // it opens the form; Submit stays the person's
    expect(read('app/service/[key].js')).toContain('<DraftSheet'); // the bottom sheet (components/home/DraftSheet.js): Resume / Start new / Cancel, never a silent replace
    expect(read('components/home/DraftSheet.js')).toContain("t('draft_prompt_title')");
  });

  test('the saved-draft card is just the card (Resume / Discard); resuming never touches the unresolved submission keys', () => {
    const notice = read('components/home/DraftNotice.js');
    expect(notice).not.toMatch(/draft_card_warning|submissionTracker|draftNotice/);
    expect(ctx.slice(ctx.indexOf('const resumeDraft'), ctx.indexOf('// Discard: deletes'))).not.toMatch(/discard\(|clearAll/); // pending keys stay stored
  });

  test('nothing is persisted on the web, the key is device-only, and no module logs', () => {
    const device = read('lib/draftStoreDevice.js');
    expect(device).toContain("Platform.OS !== 'web'");
    expect(device).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    expect(device).toContain('FileSystem.documentDirectory');
    expect(device).not.toMatch(/window.localStorage|AsyncStorage/);
    for (const file of ['lib/draftSchema.js', 'lib/draftCrypto.js', 'lib/draftStore.js', 'lib/draftManager.js', 'lib/draftStoreDevice.js', 'lib/draftCryptoDevice.js', 'components/home/DraftNotice.js']) {
      expect(read(file)).not.toMatch(/console\.|alert\(/);
    }
  });

  test('the cipher is AES-256-GCM with the account/version/service bound as additional data', () => {
    const device = read('lib/draftCryptoDevice.js');
    expect(device).toContain('AESEncryptionKey.generate(256)');
    expect(device).toContain('additionalData: aadBytes');
    expect(read('lib/draftStore.js')).toContain('files.write(target, text)');
  });

  test('the step is remembered by the form frame, and background flushes the pending save', () => {
    expect(read('components/request/RequestFrame.js')).toContain('setFormStep(step)');
    expect(ctx).toContain('flushOnBackground(draftManager)');
    expect(read('lib/draftStoreDevice.js')).toContain("state !== 'active') manager.flush()");
  });

  test('the 12 draft strings (and the 3 status strings) exist in all six languages, with the placeholders the card uses', () => {
    const keys = ['draft_prompt_title', 'draft_prompt_body', 'draft_resume', 'draft_start_new', 'draft_discard', 'draft_card_title', 'draft_card_body', 'draft_card_warning', 'draft_unusable', 'draft_expired_notice', 'draft_invalid_notice', 'draft_dismiss'];
    for (const lang of Object.keys(I18N)) {
      for (const key of keys) expect(typeof I18N[lang][key]).toBe('string');
      expect(I18N[lang].draft_card_body).toContain('{service}');
      expect(I18N[lang].draft_card_body).toContain('{date}');
    }
  });
});
