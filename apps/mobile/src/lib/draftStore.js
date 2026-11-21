// Phase 6: the encrypted draft store. One draft per account (a draft is the work in progress of one request form), kept as ciphertext under the app's private document directory,
// encrypted with ONE random AES-256 key per account that lives only in the phone's secure storage (Keychain / Keystore). Deleting the key makes every file unreadable even if a copy
// survives (a backup, a failed delete), which is why every removal deletes the KEY FIRST.
//
// Pure: secure storage, files, cipher, hash and clock are all injected (lib/draftStoreDevice.js wires the phone's; the tests wire in-memory ones and Node's AES-GCM).
// Nothing here logs. No plaintext is ever written to a file: the only plaintext is in memory, inside these functions.
//
// REPLACEMENT WITHOUT A MOVE OR A DELETE: the draft has TWO slot files (a and b). Each holds a complete authenticated envelope whose plaintext carries a rising sequence number `seq`.
// A save writes the new draft into the slot that does NOT hold the newest valid draft, by overwriting that file in place; the last known-good draft is never deleted, moved or touched
// before the new one is fully stored. A write that is interrupted (a crash, a full disk) leaves that slot torn, and AES-GCM authentication rejects a torn file, so a read always
// returns the newest slot that authenticates and validates: either the previous draft (the interrupted write is ignored) or the new one (it completed). It never returns a half-written
// draft, and it never returns "nothing" while a valid draft exists. This relies on no rename/replace semantics at all (moveAsync is not used). Slots that cannot be read, and files
// left by an older layout, are deleted by the next read or write.
import { isDraftService, isDraftStep, DRAFT_SERVICES, pickAnswers, validateAnswers } from './draftSchema';
import { MAX_DRAFT_BYTES, openDraft, sealDraft } from './draftCrypto';

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a draft lasts seven days from its LAST SAVE

export function createDraftStore({ secure, files, cipher, hash, now = () => Date.now() }) {
  let chain = Promise.resolve();
  // Operations run one at a time (a save never interleaves with a discard or a read).
  const serial = (work) => {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const slot = async (accountId) => {
    const id = await hash(`humancare-draft-account|${accountId}`);
    const base = `${files.dir}humancare-draft-${id}`;
    return { keyName: `humancare_draft_key_${id}`, slots: [`${base}.a.enc`, `${base}.b.enc`], stale: [`${base}.enc`, `${base}.tmp`] };
  };

  const removeStale = async (s) => { for (const path of s.stale) { try { await files.remove(path); } catch { /* best effort: a leftover is retried on the next read */ } } };

  const removeAll = async (s) => {
    let ok = true;
    try { await secure.del(s.keyName); } catch { ok = false; } // the key first: without it nothing that remains can be read
    for (const path of [...s.slots, ...s.stale]) { try { await files.remove(path); } catch { ok = false; } }
    return ok;
  };

  // Reads and authenticates the draft of this account. Returns { status, ... } and deletes what is expired or unusable.
  const readSlot = async (accountId, defaults) => {
    const s = await slot(accountId);
    await removeStale(s);
    const keyB64 = await secure.get(s.keyName).catch(() => null);
    const texts = [];
    for (let i = 0; i < s.slots.length; i += 1) {
      try { const text = await files.read(s.slots[i]); if (text) texts.push({ index: i, text }); } catch { /* a file that cannot be read is treated as absent */ }
    }
    if (!texts.length && !keyB64) return { status: 'none', slot: s };
    if (!texts.length) { await removeAll(s); return { status: 'none', slot: s }; } // a key with no file: nothing to keep
    if (!keyB64) { await removeAll(s); return { status: 'invalid', reason: 'key', slot: s }; }

    const candidates = []; // the slots that authenticate, with a draft's shape
    for (const { index, text } of texts) {
      for (const service of DRAFT_SERVICES) { // the service is not in the clear: it is part of what authenticates, so each candidate is tried
        const plain = await openDraft(cipher, keyB64, accountId, service, text);
        if (!plain) continue;
        if (Number.isInteger(plain.seq) && plain.seq >= 1 && Number.isFinite(plain.savedAt) && isDraftStep(plain.step)) candidates.push({ index, service, plain });
        break;
      }
    }
    if (!candidates.length) { await removeAll(s); return { status: 'invalid', reason: 'authentication', slot: s }; }
    candidates.sort((a, b) => b.plain.seq - a.plain.seq); // newest first: an older candidate is the fallback if the newest cannot be used
    const maxSeq = candidates[0].plain.seq;
    let sawExpired = false;
    let firstReason = null;
    for (const c of candidates) {
      if (now() - c.plain.savedAt >= DRAFT_TTL_MS) { sawExpired = true; continue; }
      const checked = validateAnswers(c.service, c.plain.values, defaults);
      if (!checked.ok) { firstReason = firstReason || checked.reason; continue; }
      return { status: 'ok', service: c.service, step: c.plain.step, savedAt: c.plain.savedAt, expiresAt: c.plain.savedAt + DRAFT_TTL_MS, values: checked.values, seq: maxSeq, index: c.index, slot: s };
    }
    await removeAll(s);
    return sawExpired && !firstReason ? { status: 'expired', slot: s } : { status: 'invalid', reason: firstReason || 'expired', slot: s };
  };

  const strip = (result) => { const { slot: _slot, index: _index, seq: _seq, ...rest } = result; return rest; };

  return {
    // The saved draft of `accountId`: { status: 'none' } | { status: 'ok', service, step, savedAt, expiresAt, values } | { status: 'expired' } | { status: 'invalid', reason }.
    // `defaults` is the form's empty draft that the restored answers are merged over. An expired or unusable draft (and its key) is deleted before this returns.
    load: (accountId, defaults) => serial(async () => (accountId ? strip(await readSlot(accountId, defaults)) : { status: 'none' })),

    // Writes the draft of `accountId`: only the whitelisted, valid answers of `service`, and the step. Returns { ok: true, savedAt } or { ok: false, reason }
    // ('account' when `verify` says the account changed, 'too_large', 'storage', 'input').
    // `verify` (optional, async, returns a boolean) is asked before the key is made, before the data is encrypted, before it is written and after it is written: a false answer stops the save
    // there (nothing of it is committed), or, after the write, reports it as not saved. It is how the caller invalidates a save when another account signs in mid-write.
    save: (accountId, service, step, answers, { verify } = {}) => serial(async () => {
      if (!accountId) return { ok: false, reason: 'account' };
      if (!isDraftService(service) || !isDraftStep(step)) return { ok: false, reason: 'input' };
      const stillValid = async () => { try { return verify ? !!(await verify()) : true; } catch { return false; } };
      if (!(await stillValid())) return { ok: false, reason: 'account' };
      const values = pickAnswers(service, answers);
      const existing = await readSlot(accountId, null); // also clears an expired or unusable one, so the new draft starts with a fresh key
      const s = existing.slot;
      const had = existing.status === 'ok';
      let keyB64 = had ? await secure.get(s.keyName).catch(() => null) : null;
      let madeKey = false;
      const abort = async (reason) => { if (madeKey && !had) await removeAll(s); return { ok: false, reason }; }; // a key made for a save that did not happen is not left behind
      try {
        if (!keyB64) {
          if (!(await stillValid())) return await abort('account');
          keyB64 = await cipher.generateKey(); await secure.set(s.keyName, keyB64); madeKey = true;
        }
        const savedAt = now();
        const text = await sealDraft(cipher, keyB64, accountId, service, { seq: (had ? existing.seq : 0) + 1, savedAt, step, values });
        if (!(await stillValid())) return await abort('account');
        const target = had ? s.slots[existing.index === 0 ? 1 : 0] : s.slots[0]; // never the slot that holds the newest valid draft
        await files.write(target, text);
        if (!(await stillValid())) return { ok: false, reason: 'account' }; // written, but the account changed meanwhile: it is not reported as saved
        return { ok: true, savedAt };
      } catch (err) {
        const reason = err && err.message === 'too_large' ? 'too_large' : 'storage';
        return await abort(reason); // the cause is deliberately not reported (it could carry data); the previous draft, if any, is untouched
      }
    }),

    // Deletes the draft AND its key. Used by explicit sign-out, account deletion, a confirmed submission and "Discard".
    discard: (accountId) => serial(async () => (accountId ? removeAll(await slot(accountId)) : true)),
  };
}

export { MAX_DRAFT_BYTES };
