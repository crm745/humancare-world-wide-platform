/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// The network store after the OTP-screen findings: link and backend kept apart, a stale /health answer never overwrites a newer state, recovery within seconds, a late NetInfo event backed up by a refresh;
// and the OTP rules: separate, true messages, the typed code and the Firebase session kept, nothing resent or re-verified by itself. Real store, stand-in probe / NetInfo / Firebase.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { NET, LINK_UP_RECHECK_MS, RECOVERY_PROBE_TIMEOUT_MS, MIN_PROBE_GAP_MS, createNetworkStore } = require('../network');
const { createHealthProbe, PROBE_TIMEOUT_MS } = require('../healthProbe');
const { classifyOtpError, isTransientOtpKind, sendFailure } = require('../otpErrors');
const { createProofKeeper, PROOF_MAX_AGE_MS } = require('../phoneProof');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

const WIFI = { isConnected: true, isInternetReachable: true, type: 'wifi' };
const WIFI_UNSURE = { isConnected: true, isInternetReachable: null, type: 'wifi' }; // just reconnected: NetInfo has not tested reachability yet
const NONE = { isConnected: false, isInternetReachable: false, type: 'none' };
const OK = { ok: true, status: 200, ms: 80 };
const REFUSED = { ok: false, timedOut: false, ms: 10 };
const UNAVAILABLE = { ok: false, status: 503, ms: 90 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// A store whose probe answers are held until the test releases them (so answers can arrive late and out of order).
function rig({ refresh } = {}) {
  const asked = [];
  const probe = jest.fn(() => new Promise((resolve) => { asked.push(resolve); }));
  const subs = new Set();
  const store = createNetworkStore({ probe, subscribeLink: (cb) => { subs.add(cb); return () => subs.delete(cb); }, refreshLink: refresh || null });
  store.start();
  const statuses = [];
  store.subscribe((s) => { if (statuses[statuses.length - 1] !== s.status) statuses.push(s.status); });
  return { store, probe, asked, statuses, link: (s) => subs.forEach((cb) => cb(s)), status: () => store.getState().status, restored: () => store.getState().restoredCount };
}
const flush = () => jest.advanceTimersByTimeAsync(0);

describe('a stale /health answer never overwrites a newer state', () => {
  test('a probe asked before the link dropped and came back is dropped; the new one decides', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    expect(t.asked).toHaveLength(1);
    t.link(NONE); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    t.link(WIFI); await flush();
    expect(t.asked).toHaveLength(2); // a NEW question was asked for the new link state even though the old one was still in flight
    t.asked[0](REFUSED); await flush(); // the old answer arrives late, saying "refused"
    expect(t.status()).not.toBe(NET.SERVER_DOWN);
    expect(t.status()).not.toBe(NET.OFFLINE);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('an old "all good" answer that arrives after the link dropped does not bring the phone back online', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.link(NONE); await flush();
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
  });
  test('rapid changes: whatever order the answers arrive in, the last link state wins', async () => {
    const t = rig();
    for (let i = 0; i < 6; i += 1) { t.link(WIFI); await flush(); t.link(NONE); await flush(); }
    t.link(WIFI); await flush();
    for (const resolve of [...t.asked].reverse()) { resolve(REFUSED); await flush(); } // every old answer says "refused", the newest one too
    // the newest (last asked) probe answered LAST in reverse order? it answered first; what matters: old ones never decided
    expect(t.status()).not.toBe(NET.OFFLINE);
    const last = t.asked[t.asked.length - 1];
    last(OK); await flush();
    expect([NET.ONLINE, NET.SERVER_DOWN]).toContain(t.status()); // the latest answer already counted once; a later duplicate cannot flip an older epoch
  });
  test('a late answer for an old link state never resurrects "offline" either', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    t.link(NONE); await flush();
    t.link(WIFI); await flush();
    expect(t.status()).toBe(NET.UNKNOWN); // not offline: the link is up; the backend is being asked
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
});

describe('link and backend are separate facts', () => {
  test('offline comes from the LINK: the moment NetInfo says disconnected, the state is offline (no waiting for /health)', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.link(NONE); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
  });
  test('the moment the link is back the phone is NOT offline any more (buttons are enabled), and the outage ends when the backend answers', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.link(NONE); await flush();
    const before = t.restored();
    t.link(WIFI_UNSURE); await flush();
    expect(t.status()).toBe(NET.UNKNOWN); // not offline: Verify / Submit are enabled while the backend is asked
    expect(t.restored()).toBe(before); // not announced yet
    t.asked[t.asked.length - 1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(before + 1); // the restoration is announced once, when the backend is confirmed
  });
  test('the backend not answering on a phone whose link is UP is "servers unreachable", never "no internet"', async () => {
    for (const answer of [REFUSED, UNAVAILABLE]) {
      const t = rig();
      t.link(WIFI); await flush();
      t.asked[0](answer); await flush();
      expect(t.status()).toBe(NET.SERVER_DOWN);
    }
  });
  test('a just-reconnected radio that refuses the first request does not leave "offline" on screen: it is asked again within 1.5 s and the state becomes online', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.link(NONE); await flush();
    t.link(WIFI_UNSURE); await flush();
    t.asked[t.asked.length - 1](REFUSED); await flush(); // the first request fails: the radio is not ready
    expect(t.status()).toBe(NET.SERVER_DOWN);
    expect(t.status()).not.toBe(NET.OFFLINE);
    const asks = t.asked.length;
    await jest.advanceTimersByTimeAsync(LINK_UP_RECHECK_MS[0]);
    expect(t.asked.length).toBe(asks + 1); // asked again after 1.5 s, not after 15 s
    t.asked[t.asked.length - 1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(LINK_UP_RECHECK_MS[0]).toBeLessThanOrEqual(2000);
  });
  test('when nothing is known about the link at all (no NetInfo in the build) a failure to connect still says offline', async () => {
    const t = rig();
    t.link({ isConnected: null, isInternetReachable: null, type: 'unknown' }); await flush();
    t.asked[0](REFUSED); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
  });
});

describe('a call that got no answer asks the phone for its connection NOW', () => {
  test('NetInfo is late with its event: the failed call triggers a refresh, which finds the phone offline at once', async () => {
    const refresh = jest.fn(async () => NONE);
    const t = rig({ refresh });
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    t.store.reportOutcome('network');
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(t.status()).toBe(NET.OFFLINE);
  });
  test('the same for a timeout; a refresh that fails or says nothing changes nothing', async () => {
    const t = rig({ refresh: jest.fn(async () => { throw new Error('no module'); }) });
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.store.reportOutcome('timeout'); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    const u = rig({ refresh: jest.fn(async () => null) });
    u.link(WIFI); await flush(); u.asked[0](OK); await flush();
    u.store.reportOutcome('network'); await flush();
    expect(u.status()).toBe(NET.ONLINE);
  });
  test('a refresh that says the same thing again is a no-op (no extra question)', async () => {
    const t = rig({ refresh: jest.fn(async () => WIFI) });
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    const asks = t.asked.length;
    t.store.reportOutcome('network'); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.asked.length).toBeLessThanOrEqual(asks + 1); // at most the one gap-limited /health question, as before
    expect(MIN_PROBE_GAP_MS).toBeGreaterThan(0);
  });
  test('the device store hands NetInfo\'s refresh to the store', () => {
    expect(read('lib/networkDevice.js')).toContain('refreshLink,');
    expect(read('lib/networkDevice.js')).toContain('NetInfo.refresh');
  });
});

// Android can report "connected, internet NOT reachable" (a Wi-Fi without upstream, NetInfo's own test address blocked) while our backend answers. Only "not connected" is proof of no link.
const WIFI_UNREACHABLE = { isConnected: true, isInternetReachable: false, type: 'wifi' };
describe('NetInfo "internet unreachable" is a hint, not proof: the backend\'s /health decides', () => {
  test('connected + unreachable + backend answers -> /health is asked and the state is ONLINE (buttons enabled)', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    expect(t.asked).toHaveLength(1); // asked, not skipped
    expect(t.status()).not.toBe(NET.OFFLINE);
    t.asked[0](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('connected + unreachable + a slow answer -> SLOW, never OFFLINE', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    t.asked[0]({ ok: true, status: 200, ms: 5000 }); await flush();
    expect(t.status()).toBe(NET.SLOW);
  });
  test('connected + unreachable + backend refuses -> SERVER_DOWN (not "no internet"), and it is re-asked on the back-off', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    t.asked[0](REFUSED); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    await jest.advanceTimersByTimeAsync(LINK_UP_RECHECK_MS[0]);
    expect(t.asked).toHaveLength(2);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('connected + unreachable + backend answers 503 -> SERVER_DOWN', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    t.asked[0](UNAVAILABLE); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
  });
  test('connected + unreachable + every quick probe times out -> SERVER_DOWN only once the quick ones are used up, never OFFLINE', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    for (let i = 0; i < LINK_UP_RECHECK_MS.length; i += 1) {
      t.asked[i]({ ok: false, timedOut: true, ms: RECOVERY_PROBE_TIMEOUT_MS }); await flush();
      expect([NET.UNKNOWN, NET.SERVER_DOWN]).toContain(t.status());
      expect(t.status()).not.toBe(NET.OFFLINE);
      await jest.advanceTimersByTimeAsync(LINK_UP_RECHECK_MS[i]);
    }
    t.asked[LINK_UP_RECHECK_MS.length]({ ok: false, timedOut: true, ms: RECOVERY_PROBE_TIMEOUT_MS }); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
  });
  test('Wi-Fi disconnected (isConnected false) is still hard offline: /health is not asked', async () => {
    const t = rig();
    t.link({ isConnected: false, isInternetReachable: true, type: 'none' }); await flush(); // even a stale "reachable" cannot override "not connected"
    expect(t.status()).toBe(NET.OFFLINE);
    expect(t.probe).not.toHaveBeenCalled();
    t.link({ isConnected: false, isInternetReachable: null, type: 'none' }); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    expect(t.probe).not.toHaveBeenCalled();
  });
  test('offline -> connected-but-unreachable -> backend answers: recovers, one restoration, no recovery message before the backend answers', async () => {
    const t = rig();
    t.link(WIFI); await flush(); t.asked[0](OK); await flush();
    t.link(NONE); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
    t.link(WIFI_UNREACHABLE); await flush();
    expect(t.status()).toBe(NET.UNKNOWN); // not offline any more (Submit can be enabled), not announced as restored yet
    expect(t.restored()).toBe(0);
    t.asked[t.asked.length - 1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('NetInfo flips between unreachable and reachable: only the newest answer counts', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    t.link(WIFI); await flush();
    expect(t.asked).toHaveLength(2);
    t.asked[1](OK); await flush();
    t.asked[0](REFUSED); await flush(); // the first answer is about an older link state
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('a real call that succeeds while NetInfo says unreachable -> ONLINE', async () => {
    const t = rig();
    t.link(WIFI_UNREACHABLE); await flush();
    t.asked[0](REFUSED); await flush();
    expect(t.status()).toBe(NET.SERVER_DOWN);
    t.store.reportOutcome('ok');
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('no NetInfo at all and no answer -> still OFFLINE (the fallback is unchanged)', async () => {
    const t = rig();
    t.link(null); await flush();
    t.asked[0](REFUSED); await flush();
    expect(t.status()).toBe(NET.OFFLINE);
  });
});

describe('OTP: separate, true messages', () => {
  const err = (code, extra = {}) => Object.assign(new Error('x'), { code, ...extra });
  test('invalid, expired, locked, session and missing keep their own wording', () => {
    expect(classifyOtpError(err('otp_invalid'))).toMatchObject({ kind: 'invalid', keepCode: true });
    expect(classifyOtpError(err('otp_expired'))).toMatchObject({ kind: 'expired', keepCode: false });
    expect(classifyOtpError(err('otp_locked'))).toMatchObject({ kind: 'locked', keepCode: false });
    expect(classifyOtpError(err('ticket_invalid'))).toMatchObject({ kind: 'session', keepCode: false });
    expect(classifyOtpError(err('otp_missing')).literal).toMatch(/no longer valid/);
    expect(classifyOtpError(err('otp_invalid')).literal).not.toBe(classifyOtpError(err('otp_expired')).literal);
  });
  test('no internet, a timeout and a server error each say so, keep the typed code, and are NEVER "no longer valid"', () => {
    const cases = [err('network'), err('timeout'), err('phone_timeout', { messageKey: 'otp_confirm_timeout' }), err('x', { status: 503 }), err('x', { status: 500 })];
    for (const e of cases) {
      const view = classifyOtpError(e);
      expect(['network', 'timeout', 'server']).toContain(view.kind);
      expect(view.keepCode).toBe(true);
      expect(view.literal).toBeUndefined();
      expect(typeof view.key).toBe('string');
      expect(isTransientOtpKind(view.kind)).toBe(true);
    }
    expect(classifyOtpError(err('network')).key).toBe('otp_err_network');
    expect(classifyOtpError(err('timeout')).key).toBe('otp_err_timeout');
    expect(classifyOtpError(err('x', { status: 502 })).key).toBe('otp_err_server');
    expect(classifyOtpError(err('phone_timeout', { messageKey: 'otp_send_timeout' })).key).toBe('otp_send_timeout');
    for (const key of ['otp_err_network', 'otp_err_timeout', 'otp_err_server', 'otp_err_not_sent']) expect(I18N.EN[key]).not.toMatch(/no longer valid/i);
  });
  test('a 4xx the app has no word for, and an unknown error, are not called "invalid" either', () => {
    expect(classifyOtpError(err('x', { status: 429 })).kind).toBe('other');
    expect(classifyOtpError(null).kind).toBe('other');
  });
  test('a failed SEND is "the code could not be sent: Resend OTP" (or its own true reason), never "no longer valid"', () => {
    for (const e of [err('network'), err('auth/internal'), null]) {
      const out = sendFailure(e);
      expect(out.code).toBe('otp_not_sent');
      expect(classifyOtpError(out).key).toBe('otp_err_not_sent');
    }
    expect(sendFailure(err('phone_timeout')).code).toBe('phone_timeout');
    expect(sendFailure(err('otp_throttled')).code).toBe('otp_throttled');
  });
  test('all four new messages are in the six languages, translated', () => {
    for (const key of ['otp_err_network', 'otp_err_timeout', 'otp_err_server', 'otp_err_not_sent']) for (const lang of LANGS) {
      expect(typeof I18N[lang][key]).toBe('string');
      if (lang !== 'EN') expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
  });
});

describe('OTP: the typed code and the Firebase session survive a network failure; nothing is repeated by itself', () => {
  const handle = { id: 'verification-session' };
  test('correct OTP while offline: the check fails with a network error, nothing is consumed, and trying again when online uses the SAME session', async () => {
    const keeper = createProofKeeper();
    const confirm = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'network' })) // offline: Firebase could not be reached
      .mockResolvedValueOnce('firebase-id-token');
    const pending = Promise.resolve(handle);
    await expect(keeper.prove('123456', { pending, confirm })).rejects.toMatchObject({ code: 'network' });
    expect(keeper.hasProof()).toBe(false);
    await expect(keeper.prove('123456', { pending, confirm })).resolves.toBe('firebase-id-token'); // online again: manual retry
    expect(confirm).toHaveBeenNthCalledWith(1, handle, '123456');
    expect(confirm).toHaveBeenNthCalledWith(2, handle, '123456'); // the same verification session, the same code
  });
  test('Firebase accepted the code but OUR server then failed: the same code is tried again WITHOUT asking Firebase a second time', async () => {
    const keeper = createProofKeeper();
    const confirm = jest.fn().mockResolvedValue('firebase-id-token');
    const pending = Promise.resolve(handle);
    expect(await keeper.prove('123456', { pending, confirm })).toBe('firebase-id-token');
    expect(await keeper.prove('123456', { pending, confirm })).toBe('firebase-id-token'); // the person pressed Verify again after the network failure
    expect(confirm).toHaveBeenCalledTimes(1); // Firebase accepts a code once: it is not asked twice
  });
  test('a different code, a new code sent, or an old proof is NOT reused', async () => {
    let clock = 1000;
    const keeper = createProofKeeper({ now: () => clock });
    const confirm = jest.fn(async (_h, code) => `token-${code}`);
    const pending = Promise.resolve(handle);
    await keeper.prove('111111', { pending, confirm });
    expect(await keeper.prove('222222', { pending, confirm })).toBe('token-222222');
    expect(confirm).toHaveBeenCalledTimes(2);
    keeper.forget(); // a new code was sent
    await keeper.prove('222222', { pending, confirm });
    expect(confirm).toHaveBeenCalledTimes(3);
    clock += PROOF_MAX_AGE_MS + 1;
    await keeper.prove('222222', { pending, confirm });
    expect(confirm).toHaveBeenCalledTimes(4);
  });
  test('an invalid or expired code is refused by Firebase itself: nothing is cached, the next try is a real check', async () => {
    const keeper = createProofKeeper();
    const confirm = jest.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'otp_invalid' })).mockResolvedValueOnce('t');
    const pending = Promise.resolve(handle);
    await expect(keeper.prove('000000', { pending, confirm })).rejects.toMatchObject({ code: 'otp_invalid' });
    expect(await keeper.prove('123456', { pending, confirm })).toBe('t');
  });
  test('the SMS never went out: Verify says so (not "no longer valid") and asks Firebase nothing', async () => {
    const keeper = createProofKeeper();
    const confirm = jest.fn();
    const pending = Promise.reject(Object.assign(new Error('x'), { code: 'network' }));
    pending.catch(() => {});
    await expect(keeper.prove('123456', { pending, confirm })).rejects.toMatchObject({ code: 'otp_not_sent' });
    expect(confirm).not.toHaveBeenCalled();
  });
  test('nothing resends or re-verifies by itself: the proof code never calls a send, and the hook only calls it on a press', () => {
    const proof = read('lib/phoneProof.js');
    expect(proof.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')).not.toMatch(/sendPhoneCode|signInWithPhoneNumber|apiPost|setTimeout|setInterval/);
    const hook = read('lib/usePhoneCode.js');
    expect(hook).toContain('keeper.forget();');
    expect(hook).toContain('keeper.prove(code, { pending: pending.current, confirm: confirmPhoneCode })');
    expect(hook).toContain("apiPost('/auth/otp/resend', { ticket })"); // the resend call is unchanged and still only on a tap
    expect(hook).toContain('if (inFlight.current) return inFlight.current;'); // never two sends at once
  });
});

describe('the OTP screen', () => {
  const otp = read('components/OtpScreen.js');
  test('Verify is disabled the moment the phone is offline, with the reason right under it, and comes back by itself', () => {
    expect(otp).toMatch(/<Button large=\{!compact\} title=\{t\('otp_verify_btn'\)\} onPress=\{verify\} loading=\{busy\} needsNetwork \/>\s+<NeedsInternet \/>/);
    expect(otp).toContain('const { isOffline, restoredCount } = useNetwork();');
  });
  test('only a code that cannot be tried again is cleared; a network failure, a timeout and a server error keep it typed', () => {
    expect(otp).toContain('if (!shown.keepCode) setCode(\'\');');
    expect(otp).not.toMatch(/if \(err\.code !== 'otp_invalid'\) setCode/);
  });
  test('a "no internet" or "timed out" message goes away by itself when the connection returns (the code stays)', () => {
    expect(otp).toContain("const staleFailure = (errorKind === 'network' || errorKind === 'timeout') && (restoredCount !== errorAtRestore || (errorKind === 'network' && isOffline));");
    expect(otp).toContain('const shownError = staleFailure ? null : error;');
  });
  test('the messages come from lib/otpErrors.js, so the screen cannot call a network failure "no longer valid"', () => {
    expect(otp).toContain('classifyOtpError(err)');
    expect(otp).not.toMatch(/no longer valid/);
    expect(otp).toContain('t(view.key)');
  });
  test('the screens that use the code screen are unchanged in their security: the same endpoints, tickets and proofs', () => {
    for (const file of ['app/login-otp.js', 'app/register-otp.js', 'app/forgot-password-otp.js', 'app/change-contact-otp.js', 'app/delete-account-otp.js']) {
      expect({ file, proof: /proof\(code\)/.test(read(file)) }).toEqual({ file, proof: true });
    }
  });
});

describe('the recovery probe: a short per-call limit, quick sequential re-asks, nothing wrongly online or slow', () => {
  const hang = () => jest.fn((_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }));

  test('healthProbe: the default limit is 6 s, a per-call limit overrides it for that call only', async () => {
    expect(PROBE_TIMEOUT_MS).toBe(6000);
    expect(RECOVERY_PROBE_TIMEOUT_MS).toBe(2000);
    const fetchImpl = hang();
    const probe = createHealthProbe({ baseUrl: 'http://x', fetchImpl });
    let result = null;
    probe({ timeoutMs: 2000 }).then((r) => { result = r; });
    await jest.advanceTimersByTimeAsync(1999);
    expect(result).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    result = null;
    probe().then((r) => { result = r; }); // the default again
    await jest.advanceTimersByTimeAsync(5999);
    expect(result).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    result = null;
    probe({ timeoutMs: 'nonsense' }).then((r) => { result = r; }); // an unusable value falls back to the default
    await jest.advanceTimersByTimeAsync(5999);
    expect(result).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(result).not.toBeNull();
  });
  test('the retry schedule is 500, 1000, 1500, 2500, 4000, 6000 ms, then the long back-off', () => {
    expect([...LINK_UP_RECHECK_MS]).toEqual([500, 1000, 1500, 2500, 4000, 6000]);
  });
  test('the first probe after a link-up uses the 2 s limit; a normal probe is asked without one', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    expect(t.probe.mock.calls[0]).toEqual([{ timeoutMs: RECOVERY_PROBE_TIMEOUT_MS }]);
    t.asked[0](OK); await flush();
    await jest.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS);
    t.store.check();
    expect(t.probe.mock.calls[1]).toEqual([]);
  });
  test('a recovery probe that times out leaves the state alone (not ONLINE, not SLOW) and the next one is asked after 500 ms', async () => {
    const t = rig();
    t.link(NONE); await flush();
    t.link(WIFI); await flush();
    expect(t.status()).toBe(NET.UNKNOWN);
    t.asked[0]({ ok: false, timedOut: true, ms: 2000 }); await flush();
    expect(t.status()).toBe(NET.UNKNOWN);
    expect(t.status()).not.toBe(NET.SLOW);
    await jest.advanceTimersByTimeAsync(LINK_UP_RECHECK_MS[0] - 1);
    expect(t.asked).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.asked).toHaveLength(2);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
    expect(t.restored()).toBe(1);
  });
  test('probes stay sequential: a hung recovery probe is never doubled by the re-ask timer, and a stale answer from an older link state is still dropped', async () => {
    const t = rig();
    t.link(WIFI); await flush();
    await jest.advanceTimersByTimeAsync(20000); // nothing answered: no timer fires another while one is in flight
    expect(t.asked).toHaveLength(1);
    t.link(NONE); await flush();
    t.link(WIFI); await flush();
    expect(t.asked).toHaveLength(2);
    t.asked[0](OK); await flush(); // stale
    expect(t.status()).toBe(NET.UNKNOWN);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
  test('end to end with a real probe: a swallowed first request (hangs) is given up after 2 s and the second, answered one recovers at about 2.5 s', async () => {
    let calls = 0;
    const fetchImpl = jest.fn((_url, { signal }) => {
      calls += 1;
      if (calls === 1) return new Promise((_r, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); });
      return Promise.resolve({ ok: true, status: 200 });
    });
    const probe = createHealthProbe({ baseUrl: 'http://x', fetchImpl });
    const subs = new Set();
    const store = createNetworkStore({ probe, subscribeLink: (cb) => { subs.add(cb); return () => subs.delete(cb); } });
    store.start();
    subs.forEach((cb) => cb(NONE));
    subs.forEach((cb) => cb(WIFI));
    await jest.advanceTimersByTimeAsync(1999);
    expect(store.getState().status).toBe(NET.UNKNOWN);
    await jest.advanceTimersByTimeAsync(1 + LINK_UP_RECHECK_MS[0] + 5);
    expect(store.getState().status).toBe(NET.ONLINE);
    expect(store.getState().restoredCount).toBe(1);
  });
  test('a quick refusal after a link-up (radio not ready) is retried at 500 ms and recovers within about 1 s', async () => {
    const t = rig();
    t.link(NONE); await flush();
    t.link(WIFI); await flush();
    t.asked[0](REFUSED); await flush();
    await jest.advanceTimersByTimeAsync(LINK_UP_RECHECK_MS[0]);
    t.asked[1](OK); await flush();
    expect(t.status()).toBe(NET.ONLINE);
  });
});
