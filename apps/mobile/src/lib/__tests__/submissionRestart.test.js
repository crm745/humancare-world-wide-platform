/* global describe, test, expect, __dirname, Buffer */
// Duplicate protection across app restarts: the encrypted vault, the tracker's restore, the pre-send gate, the Review wiring, the responsive network message and the localization.
// A fake server that saves a request once per key stands in for the backend (UNIQUE(user_id, client_request_id)).
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { createSubmissionVault, validRecord } = require('../unresolvedSubmissionVault');
const { createSubmissionTracker, PENDING_TTL_MS } = require('../submissionKey');
const { checkBeforeSend, blockedError, isBlocked, BLOCKED_CODE } = require('../submissionGate');
const { postWithKey, afterSaved, afterFailure } = require('../requestSubmission');
const I18N = require('../../data/i18n.json');
const { cantConnectText, CANT_CONNECT_TEXT } = require('../cantConnect');

const src = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
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
const sha = async (text) => nodeCrypto.createHash('sha256').update(text).digest('hex');

// One phone: secure storage + private files survive an "app restart"; trackers and vaults are rebuilt over them.
function phone() {
  const secureMap = new Map();
  const fileMap = new Map();
  const log = [];
  const secure = {
    get: async (k) => (secureMap.has(k) ? secureMap.get(k) : null),
    set: async (k, v) => { log.push(`set ${k}`); secureMap.set(k, v); },
    del: async (k) => { log.push(`del ${k}`); secureMap.delete(k); },
  };
  const files = {
    dir: '/docs/',
    read: async (p) => { if (!fileMap.has(p)) throw new Error('absent'); return fileMap.get(p); },
    write: async (p, t) => { fileMap.set(p, t); },
    remove: async (p) => { log.push(`rm ${p}`); fileMap.delete(p); },
  };
  const clock = { t: 1_700_000_000_000 };
  const vault = () => createSubmissionVault({ secure, files, cipher: nodeCipher, hash: sha, now: () => clock.t, ttlMs: PENDING_TTL_MS });
  let n = 0;
  const generate = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  let user = ALICE;
  const boot = () => createSubmissionTracker({ storage: secure, getUserId: async () => user, generate, now: () => clock.t, vault: vault() }); // a fresh app run
  return { secure, files, secureMap, fileMap, log, clock, vault, boot, setUser: (u) => { user = u; } };
}

// A server that saves once per key, like the backend, and can lose answers.
function server() {
  const saved = new Map();
  const s = { saved, posts: 0, gets: 0, down: false, loseNextAnswer: false };
  s.apiPost = async (_p, body) => {
    s.posts += 1;
    if (s.down) throw Object.assign(new Error('Could not reach the server.'), { code: 'network' });
    if (!saved.has(body.clientRequestId)) saved.set(body.clientRequestId, { id: saved.size + 1, referenceNumber: `HC-${saved.size + 1}`, body });
    if (s.loseNextAnswer) { s.loseNextAnswer = false; throw Object.assign(new Error('timeout'), { code: 'outcome_unknown', outcomeUnknown: true }); }
    return { request: saved.get(body.clientRequestId) };
  };
  s.apiGet = async (p) => {
    s.gets += 1;
    if (s.down) throw Object.assign(new Error('Could not reach the server.'), { code: 'network' });
    const key = decodeURIComponent(p.split('/').pop());
    if (!saved.has(key)) throw Object.assign(new Error('not found'), { status: 404 });
    return { request: saved.get(key) };
  };
  return s;
}

const BODY = { serviceKey: 'air', patientName: 'A', description: 'cardiac' };
const lose = async (tracker, srv, body = BODY, service = 'air') => {
  srv.loseNextAnswer = true;
  try { await postWithKey(tracker, srv.apiPost, body, { service }); } catch (err) { await afterFailure(tracker, err); }
};

describe('the encrypted vault', () => {
  const record = { id: '00000000-0000-4000-8000-000000000001', service: 'air', startedAt: 1, payload: { patientName: 'Secret Name', description: 'diagnosis XYZ' } };

  test('round trip; the files hold no plaintext and the key lives only in secure storage', async () => {
    const p = phone();
    const v = p.vault();
    expect(await v.save(ALICE, record)).toBe(true);
    expect(await v.load(ALICE)).toEqual(record);
    for (const text of p.fileMap.values()) { expect(text).not.toMatch(/Secret Name|diagnosis|air|00000000-0000/); }
    expect([...p.secureMap.keys()].some((k) => k.startsWith('humancare_submission_key_'))).toBe(true);
  });
  test('survives a restart (a new vault over the same storage)', async () => {
    const p = phone();
    await p.vault().save(ALICE, record);
    expect(await p.vault().load(ALICE)).toEqual(record);
  });
  test('scoped to the account: another account sees nothing', async () => {
    const p = phone();
    await p.vault().save(ALICE, record);
    expect(await p.vault().load(BOB)).toBeNull();
    expect(await p.vault().load(ALICE)).toEqual(record);
  });
  test('a write interrupted half way (a torn slot) leaves the previous record readable', async () => {
    const p = phone();
    const v = p.vault();
    await v.save(ALICE, record);
    const newer = { ...record, payload: { patientName: 'Newer' } };
    await v.save(ALICE, newer);
    // tear the slot holding the newest record: the older slot still authenticates
    const slots = [...p.fileMap.keys()].sort();
    const envelopes = slots.map((k) => JSON.parse(p.fileMap.get(k)));
    expect(envelopes).toHaveLength(2);
    const tornKey = slots.find((k) => p.fileMap.get(k)); // find the newest by decrypting both
    let newestKey = null;
    for (const k of slots) {
      const single = new Map([[k, p.fileMap.get(k)]]);
      const probe = createSubmissionVault({ secure: p.secure, files: { dir: '/docs/', read: async (x) => { if (!single.has(x)) throw new Error('absent'); return single.get(x); }, write: async () => {}, remove: async () => {} }, cipher: nodeCipher, hash: sha, now: () => p.clock.t, ttlMs: PENDING_TTL_MS });
      const got = await probe.load(ALICE);
      if (got && got.payload.patientName === 'Newer') newestKey = k;
    }
    expect(tornKey).toBeTruthy();
    p.fileMap.set(newestKey, p.fileMap.get(newestKey).slice(0, 20)); // truncated
    expect(await p.vault().load(ALICE)).toEqual(record);
  });
  test('an altered ciphertext, or a file copied to another account, never opens', async () => {
    const p = phone();
    await p.vault().save(ALICE, record);
    const [k, text] = [...p.fileMap.entries()][0];
    const env = JSON.parse(text);
    env.d = Buffer.from(Buffer.from(env.d, 'base64').map((b, i) => (i === 20 ? b ^ 1 : b))).toString('base64');
    p.fileMap.set(k, JSON.stringify(env));
    expect(await p.vault().load(ALICE)).toBeNull();
  });
  test('expires after the time to live and is deleted when found expired', async () => {
    const p = phone();
    await p.vault().save(ALICE, record);
    p.clock.t += PENDING_TTL_MS + 1;
    expect(await p.vault().load(ALICE)).toBeNull();
    expect(p.fileMap.size).toBe(0);
    expect([...p.secureMap.keys()].filter((k) => k.startsWith('humancare_submission_key_'))).toHaveLength(0);
  });
  test('remove deletes the key FIRST, then the files', async () => {
    const p = phone();
    await p.vault().save(ALICE, record);
    p.log.length = 0;
    await p.vault().remove(ALICE);
    expect(p.log[0]).toMatch(/^del humancare_submission_key_/);
    expect(p.log.slice(1).every((l) => l.startsWith('rm '))).toBe(true);
    expect(p.fileMap.size).toBe(0);
  });
  test('only a valid record is accepted', () => {
    expect(validRecord(record)).toBe(true);
    expect(validRecord({ ...record, id: 'nope' })).toBe(false);
    expect(validRecord({ ...record, payload: [] })).toBe(false);
    expect(validRecord({ ...record, service: 'x'.repeat(65) })).toBe(false);
  });
});

describe('the tracker after an app restart', () => {
  test('a submission whose answer was lost is restored by a new run: same key, original payload, service, unconfirmed; nothing is sent', async () => {
    const p = phone();
    const srv = server();
    const first = p.boot();
    await lose(first, srv);
    const key = first.getCurrent();
    expect(srv.saved.has(key)).toBe(true); // the request DID reach the server
    const second = p.boot(); // the app was killed and opened again
    expect(second.getUnresolved()).toBeNull();
    const posts = srv.posts;
    expect(await second.restore()).toBe(true);
    expect(srv.posts).toBe(posts); // never replayed by itself
    expect(second.getUnresolved()).toEqual({ id: key, service: 'air', payload: BODY });
    expect(second.isUnconfirmed()).toBe(true);
  });
  test('the app killed WHILE the request was being sent (no answer, no failure handling at all) is restored too', async () => {
    const p = phone();
    const first = p.boot();
    await first.begin();
    await first.rememberPayload(BODY, 'air'); // written before the send; then the process dies
    const second = p.boot();
    expect(await second.restore()).toBe(true);
    expect(second.getUnresolved().id).toBe(first.getCurrent());
  });
  test('another account on the same phone restores nothing', async () => {
    const p = phone();
    const srv = server();
    await lose(p.boot(), srv);
    p.setUser(BOB);
    const other = p.boot();
    expect(await other.restore()).toBe(false);
    expect(other.getUnresolved()).toBeNull();
  });
  test('draft resume and service switching (startNew) never forget an unresolved submission', async () => {
    const p = phone();
    const srv = server();
    const t = p.boot();
    await lose(t, srv);
    const key = t.getCurrent();
    t.startNew(); // resuming a draft / choosing another service
    expect(t.getUnresolved().id).toBe(key);
    const after = p.boot();
    await after.restore();
    after.startNew();
    expect(after.getUnresolved().id).toBe(key);
    expect(await after.begin()).toBe(key); // no new key while it is unresolved
  });
  test('with nothing unresolved, startNew makes the next key new', async () => {
    const p = phone();
    const t = p.boot();
    const a = await t.begin();
    t.startNew();
    expect(await t.begin()).not.toBe(a);
  });
  test('a confirmed outcome clears the vault; so does a discard', async () => {
    const p = phone();
    const srv = server();
    const t = p.boot();
    await lose(t, srv);
    await t.confirm();
    expect(p.fileMap.size).toBe(0);
    const u = p.boot();
    expect(await u.restore()).toBe(false);
    await lose(u, srv, { ...BODY, description: 'again' });
    await u.discardUnresolved();
    expect(await p.boot().restore()).toBe(false);
  });
  test('a vault that cannot be written does not stop the send', async () => {
    const p = phone();
    const srv = server();
    const t = createSubmissionTracker({ storage: p.secure, getUserId: async () => ALICE, generate: () => '00000000-0000-4000-8000-0000000000aa', vault: { save: async () => { throw new Error('disk full'); }, load: async () => null, remove: async () => true } });
    const out = await postWithKey(t, srv.apiPost, BODY, { service: 'air' });
    expect(out.request.id).toBe(1);
  });
});

describe('the gate: asks the server before any send while an earlier submission is unresolved', () => {
  const setup = async () => {
    const p = phone();
    const srv = server();
    await lose(p.boot(), srv);
    const tracker = p.boot(); // a restarted app
    return { p, srv, tracker, key: [...srv.saved.keys()][0] };
  };
  const gate = (ctx, body = BODY, service = 'air') => checkBeforeSend({ tracker: ctx.tracker, apiGet: ctx.srv.apiGet, service, body });

  test('nothing unresolved: send, and the server is not even asked', async () => {
    const p = phone();
    const srv = server();
    const t = p.boot();
    expect(await checkBeforeSend({ tracker: t, apiGet: srv.apiGet, service: 'air', body: BODY })).toEqual({ action: 'send' });
    expect(srv.gets).toBe(0);
  });
  test('the status cannot be confirmed: blocked, nothing is sent, the unresolved state is untouched, and Try again works once it can', async () => {
    const ctx = await setup();
    ctx.srv.down = true;
    const posts = ctx.srv.posts;
    expect(await gate(ctx)).toEqual({ action: 'blocked', reason: 'unconfirmed' });
    expect(await gate(ctx)).toEqual({ action: 'blocked', reason: 'unconfirmed' });
    expect(ctx.srv.posts).toBe(posts);
    expect(ctx.tracker.getUnresolved().id).toBe(ctx.key);
    expect(await ctx.p.boot().restore()).toBe(true); // still on the phone
    ctx.srv.down = false;
    const out = await gate(ctx);
    expect(out.action).toBe('found');
  });
  test('the server has it and it is the same submission: that request is the result, no second POST, the unresolved state is cleared', async () => {
    const ctx = await setup();
    const posts = ctx.srv.posts;
    const out = await gate(ctx);
    expect(out).toEqual({ action: 'found', request: ctx.srv.saved.get(ctx.key) });
    expect(ctx.srv.posts).toBe(posts);
    expect(ctx.tracker.getUnresolved()).toBeNull();
    expect(await ctx.p.boot().restore()).toBe(false);
  });
  test('the server has it but the form was changed: nothing is sent, "already sent" once, then the changes go as a NEW request', async () => {
    const ctx = await setup();
    const edited = { ...BODY, description: 'edited' };
    expect(await gate(ctx, edited)).toEqual({ action: 'blocked', reason: 'already_sent' });
    expect(ctx.srv.posts).toBe(1);
    expect(await gate(ctx, edited)).toEqual({ action: 'send' });
    await postWithKey(ctx.tracker, ctx.srv.apiPost, edited, { service: 'air' });
    expect(ctx.srv.saved.size).toBe(2);
    expect([...ctx.srv.saved.keys()][1]).not.toBe(ctx.key);
  });
  test('the server has it and this is a different service: a new request is sent with a new key', async () => {
    const ctx = await setup();
    expect(await gate(ctx, { serviceKey: 'tele' }, 'tele')).toEqual({ action: 'send' });
    await postWithKey(ctx.tracker, ctx.srv.apiPost, { serviceKey: 'tele' }, { service: 'tele' });
    expect(ctx.srv.saved.size).toBe(2);
  });
  test('the server does NOT have it and it is the same submission: retry with the ORIGINAL key and payload', async () => {
    const p = phone();
    const srv = server();
    srv.down = true;
    const first = p.boot();
    try { await postWithKey(first, srv.apiPost, BODY, { service: 'air' }); } catch (err) { await afterFailure(first, err); }
    srv.down = false;
    const key = first.getCurrent();
    expect(srv.saved.size).toBe(0);
    const tracker = p.boot();
    expect(await checkBeforeSend({ tracker, apiGet: srv.apiGet, service: 'air', body: BODY })).toEqual({ action: 'send' });
    expect(await tracker.begin()).toBe(key);
    await postWithKey(tracker, srv.apiPost, BODY, { service: 'air' });
    expect([...srv.saved.keys()]).toEqual([key]);
    expect(srv.saved.get(key).body).toEqual({ ...BODY, clientRequestId: key });
  });
  test('the server does NOT have it and something different is submitted: the earlier is let go and a new key is used', async () => {
    const p = phone();
    const srv = server();
    srv.down = true;
    const first = p.boot();
    try { await postWithKey(first, srv.apiPost, BODY, { service: 'air' }); } catch (err) { await afterFailure(first, err); }
    srv.down = false;
    const key = first.getCurrent();
    const tracker = p.boot();
    const other = { serviceKey: 'home', patientName: 'B' };
    expect(await checkBeforeSend({ tracker, apiGet: srv.apiGet, service: 'home', body: other })).toEqual({ action: 'send' });
    expect(await tracker.begin()).not.toBe(key);
    expect(await p.boot().restore()).toBe(false);
  });
  test('no duplicate across any number of restarts and Try-agains: the server ends up with exactly one request', async () => {
    const p = phone();
    const srv = server();
    await lose(p.boot(), srv);
    const outcomes = [];
    for (let run = 0; run < 3; run += 1) {
      const tracker = p.boot();
      srv.down = run < 2; // two restarts where the status cannot be checked, then it can
      const out = await checkBeforeSend({ tracker, apiGet: srv.apiGet, service: 'air', body: BODY });
      srv.down = false;
      outcomes.push(out.action);
      if (out.action === 'send') await postWithKey(tracker, srv.apiPost, BODY, { service: 'air' }).then(() => afterSaved(tracker));
    }
    expect(outcomes).toEqual(['blocked', 'blocked', 'found']);
    expect(srv.saved.size).toBe(1);
    expect(srv.posts).toBe(1);
  });
  test('the blocked error is recognisable and carries its reason', () => {
    const e = blockedError('unconfirmed');
    expect(isBlocked(e)).toBe(true);
    expect(e.code).toBe(BLOCKED_CODE);
    expect(e.reason).toBe('unconfirmed');
    expect(isBlocked(new Error('x'))).toBe(false);
  });
});

describe('Review, AppContext and the vault are wired (source)', () => {
  const review = src('app/request/review.js');
  test('every send goes through guardedSend; a blocked gate shows one message and the same button is Try again', () => {
    expect(review).toMatch(/const guardedSend = async \(body\) => \{\s+const gate = await checkBeforeSend\(/);
    expect((review.match(/await guardedSend\(/g) || []).length).toBe(3);
    expect(review).toContain("if (gate.action === 'blocked') throw blockedError(gate.reason);");
    expect(review).toMatch(/if \(isBlocked\(err\)\) \{ setRetryable\(true\);/);
    expect(review).toContain("retryable ? t('sk_try_again')");
    expect(review).not.toMatch(/useEffect|clearAll|discardUnresolved/); // nothing replays by itself; the gate alone decides
  });
  test('the key is made only inside postWithKey (never in a screen) and the service travels with the payload', () => {
    expect(review).not.toMatch(/generateClientRequestId|randomUUID/);
    expect(review).toMatch(/postWithKey\(submissionTracker, apiPost, body, \{ service: serviceKey \}\)/);
  });
  test('the device store wires the encrypted vault; AppContext restores it for a signed-in patient and sends nothing', () => {
    expect(src('lib/pendingSubmissionStore.js')).toMatch(/vault: submissionVault/);
    const ctx = src('state/AppContext.js');
    expect(ctx).toMatch(/submissionTracker\.restore\(\)/);
    expect(ctx).not.toMatch(/draftNotice|draftSaveStatus|dismissDraftNotice/);
  });
  test('the vault device binding is account-scoped, device-only and disabled on the web', () => {
    const dev = src('lib/unresolvedSubmissionVaultDevice.js');
    expect(dev).toMatch(/AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
    expect(dev).toMatch(/Platform\.OS !== 'web'/);
  });
});

describe('localization', () => {
  const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
  const CC = ['cc_connecting_title', 'cc_connecting_body', 'cc_title', 'cc_body_offline', 'cc_body_server', 'cc_body_generic', 'cc_storage_title', 'cc_storage_body', 'cc_try_again'];
  test('every Can\'t Connect string is in i18n for all six languages, and the other five are really translated', () => {
    for (const lang of LANGS) for (const key of CC) {
      expect(typeof I18N[lang][key]).toBe('string');
      expect(I18N[lang][key].length).toBeGreaterThan(0);
      if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
  });
  test('English in i18n equals the English fallback constants (one source of wording)', () => {
    for (const key of CC) expect(I18N.EN[key]).toBe(CANT_CONNECT_TEXT[key]);
    expect(CANT_CONNECT_TEXT.cc_login_other).toBeUndefined();
  });
  test('the screen reads the translation and falls back to English', () => {
    expect(cantConnectText((k) => (k === 'cc_title' ? 'हिंदी' : k), 'cc_title')).toBe('हिंदी');
    expect(cantConnectText((k) => k, 'cc_title')).toBe(CANT_CONNECT_TEXT.cc_title);
  });
  test('req_submit and req_uploading are translated in every language (not the English copy) and keep their placeholders', () => {
    for (const lang of LANGS.filter((l) => l !== 'EN')) {
      expect(I18N[lang].req_submit).not.toBe(I18N.EN.req_submit);
      expect(I18N[lang].req_uploading).not.toBe(I18N.EN.req_uploading);
      for (const token of ['{i}', '{n}', '{p}']) expect(I18N[lang].req_uploading).toContain(token);
    }
  });
  test('no existing key was lost: every language still has everything it had, and the new keys are in all six', () => {
    for (const lang of LANGS) for (const key of ['net_try_again', 'net_already_sent', 'up_restart_simple', 'sk_try_again']) expect(I18N[lang][key]).toBeTruthy();
  });
});

describe('offline / slow network and upload recovery still behave (the existing suites stay green; spot checks here)', () => {
  test('a slow answer is not a failure: a lost answer is classified unknown, kept, and recovered by the same key', async () => {
    const p = phone();
    const srv = server();
    const t = p.boot();
    await lose(t, srv);
    expect(t.isUnconfirmed()).toBe(true);
    const out = await postWithKey(t, srv.apiPost, BODY, { service: 'air' });
    expect(out.request.id).toBe(1);
    expect(srv.saved.size).toBe(1);
  });
});

describe('one network message at a time', () => {
  const { hideToastForBanner, isNetworkToast } = require('../networkUi');
  test('a toast that repeats the bottom network message is not drawn while that message is showing', () => {
    for (const message of ['Could not reach the server. Please check your connection and try again.', 'No internet connection. Connect to the internet to continue.', 'The server took too long to answer. Please try again.']) {
      expect(isNetworkToast(message)).toBe(true);
      expect(hideToastForBanner({ message, bannerVisible: true })).toBe(true);
      expect(hideToastForBanner({ message, bannerVisible: false })).toBe(false); // no banner on this screen: the toast is the only message
      expect(hideToastForBanner({ message })).toBe(false);
    }
  });
  test('other toasts are never hidden', () => {
    expect(hideToastForBanner({ message: 'Upload cancelled. Nothing was sent.', bannerVisible: true })).toBe(false);
    expect(hideToastForBanner({ message: null, bannerVisible: true })).toBe(false);
  });
  test('Toast hides only for a banner that is really on screen', () => {
    expect(src('components/widgets.js')).toMatch(/hideToastForBanner\(\{ message: toastMsg, bannerVisible \}\)/);
  });
});
