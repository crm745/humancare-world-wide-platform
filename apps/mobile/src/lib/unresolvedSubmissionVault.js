// The encrypted record of an UNRESOLVED request submission. When a request is sent and its answer is lost (or the app is killed while it is being sent), the request may already exist on the
// server. To avoid sending it a second time after an app restart, the app must still know three things about it: the random key it was sent with (`clientRequestId`), WHAT was sent (the original
// payload: a retry must send exactly that, under that key), and which service it was for. The payload is medical data, so it is never written in the clear: it is sealed with AES-256-GCM
// (the same primitive as the encrypted drafts, lib/draftCrypto.js) under ONE random key per account that lives only in the phone's secure storage, and the ciphertext goes to the app's private
// document directory. Deleting the key makes any surviving file unreadable (crypto-shredding), which is why every removal deletes the key FIRST.
//
// One record per account (the latest unresolved submission). Two slot files with a rising sequence number, written in place: a write interrupted half way leaves a torn slot that fails
// authentication, so a read always returns the newest slot that authenticates (the previous record), never half a record. The AAD binds the ciphertext to the account, so a file copied to
// another account's slot never opens. A record expires after `ttlMs` (the same two weeks as the stored key list) and is deleted when it is found expired.
//
// Pure: secure storage, files, cipher, hash and clock are injected (lib/unresolvedSubmissionVaultDevice.js wires the phone's). Nothing here logs. It holds no file, no file uri and no token.
import { MAX_DRAFT_BYTES, utf8Decode, utf8Encode } from './draftCrypto';
import { isClientRequestId } from './submissionKey';

export const VAULT_VERSION = 1;

const aad = (accountId) => utf8Encode(`humancare-submission|v${VAULT_VERSION}|${accountId}`);
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// What a record must look like to be written or accepted: nothing else ever passes.
export function validRecord(record) {
  return isPlainObject(record) && isClientRequestId(record.id) && typeof record.service === 'string' && record.service.length <= 64
    && Number.isFinite(record.startedAt) && isPlainObject(record.payload);
}

export function createSubmissionVault({ secure, files, cipher, hash, now = () => Date.now(), ttlMs }) {
  let chain = Promise.resolve();
  const serial = (work) => { const run = chain.then(work, work); chain = run.then(() => undefined, () => undefined); return run; };

  const slot = async (accountId) => {
    const id = await hash(`humancare-submission-account|${accountId}`);
    const base = `${files.dir}humancare-submission-${id}`;
    return { keyName: `humancare_submission_key_${id}`, slots: [`${base}.a.enc`, `${base}.b.enc`] };
  };
  const removeAll = async (s) => {
    let ok = true;
    try { await secure.del(s.keyName); } catch { ok = false; } // the key first
    for (const path of s.slots) { try { await files.remove(path); } catch { ok = false; } }
    return ok;
  };

  // The newest slot that authenticates and holds a valid, unexpired record: { record, seq, index, slot } or { none: true, slot }. Anything unusable is deleted.
  const read = async (accountId) => {
    const s = await slot(accountId);
    const keyB64 = await secure.get(s.keyName).catch(() => null);
    const texts = [];
    for (let i = 0; i < s.slots.length; i += 1) {
      try { const text = await files.read(s.slots[i]); if (text) texts.push({ index: i, text }); } catch { /* absent */ }
    }
    if (!texts.length) { if (keyB64) await removeAll(s); return { none: true, slot: s }; }
    if (!keyB64) { await removeAll(s); return { none: true, slot: s }; }
    const found = [];
    for (const { index, text } of texts) {
      try {
        const envelope = JSON.parse(text);
        if (!envelope || envelope.v !== VAULT_VERSION || typeof envelope.d !== 'string') continue;
        const plain = JSON.parse(utf8Decode(await cipher.decrypt(keyB64, envelope.d, aad(accountId))));
        if (isPlainObject(plain) && Number.isInteger(plain.seq) && plain.seq >= 1 && Number.isFinite(plain.at) && validRecord(plain.record)) found.push({ index, plain });
      } catch { /* torn, altered or another account's: not usable */ }
    }
    if (!found.length) { await removeAll(s); return { none: true, slot: s }; }
    found.sort((a, b) => b.plain.seq - a.plain.seq);
    const newest = found[0];
    if (ttlMs && now() - newest.plain.at >= ttlMs) { await removeAll(s); return { none: true, slot: s }; }
    return { record: newest.plain.record, seq: newest.plain.seq, index: newest.index, slot: s };
  };

  return {
    // Writes the account's unresolved submission. Resolves true when it is on the phone, false when it could not be written (the caller then carries on: the submission still works for
    // this run, it just could not be recovered after a restart).
    save: (accountId, record) => serial(async () => {
      if (!accountId || !validRecord(record)) return false;
      try {
        const existing = await read(accountId);
        const s = existing.slot;
        const have = !existing.none;
        let keyB64 = have ? await secure.get(s.keyName).catch(() => null) : null;
        if (!keyB64) { keyB64 = await cipher.generateKey(); await secure.set(s.keyName, keyB64); }
        const bytes = utf8Encode(JSON.stringify({ seq: (have ? existing.seq : 0) + 1, at: now(), record }));
        if (bytes.length > MAX_DRAFT_BYTES) return false;
        const combined = await cipher.encrypt(keyB64, bytes, aad(accountId));
        await files.write(s.slots[have ? (existing.index === 0 ? 1 : 0) : 0], JSON.stringify({ v: VAULT_VERSION, d: combined })); // never the slot that holds the newest record
        return true;
      } catch {
        return false;
      }
    }),
    // The account's unresolved submission, or null. Never another account's.
    load: (accountId) => serial(async () => {
      if (!accountId) return null;
      try { const r = await read(accountId); return r.none ? null : r.record; } catch { return null; }
    }),
    // Forgets it: the key first, then both files.
    remove: (accountId) => serial(async () => (accountId ? removeAll(await slot(accountId)) : true)),
  };
}
