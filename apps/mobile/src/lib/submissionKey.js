// The idempotency key of a request submission (Phase 4 of the network work), kept apart from React so its whole life can be unit-tested.
//
// Every logical submission gets ONE random UUID (`clientRequestId`), sent with POST /requests. The server saves a request at most once per (patient, key), so the SAME key
// can be sent again, by a retry after a lost answer, with no risk of a second request. The rules, all of them tested:
//   - generated ONCE per new submission (the first time it is about to be sent), never because an answer was slow or lost
//   - reused for every retry of that submission, and a retry sends the ORIGINAL payload: what was first sent is remembered (in memory only) and is what is sent again
//   - written to the device BEFORE the first send, so the key is not lost if the app is closed or killed while the answer is outstanding
//   - removed only when the outcome is CONFIRMED (the server said it saved the request, or the server refused it with an answer) or the person discards it
//   - a genuinely new submission (a fresh start of a service, another service chosen, another account) starts with a NEW key
//
// WHOSE it is. Every stored key carries the id of the account that made it (read from the access token's claims, lib/tokenIdentity.js: an identifier, not a credential):
//   - the same account logging in again (a session that expired, a log-out and in) finds its unresolved keys, and its draft keeps its key and original payload, so a request that was
//     received while the answer was lost is found by "Check status" instead of being sent twice
//   - ANOTHER account logging in (an account switch) finds none of them: they are deleted, and the draft's key and payload are dropped, so a key is never used for an account that
//     did not make it (the server also scopes every key to its patient, so it could not collide, but nothing is carried over)
//   - the account being deleted clears everything (clearAll)
// What is stored: only { id, startedAt, userId } of submissions whose outcome is not confirmed yet: no name, no medical detail, no service, no field of the form, and never the payload
// (the original payload and service of an UNRESOLVED submission are kept ENCRYPTED in lib/unresolvedSubmissionVault.js, never in this list, so after a restart the same key and original payload are restored and the server is asked before anything is sent: lib/submissionGate.js). It is stored in the phone's secure
// storage (Keychain / Keystore), is dropped after PENDING_TTL_MS, and holds at most MAX_PENDING entries.
// Nothing in this file sends anything: it only remembers the key, and the person decides to check or to submit again.
import { isOutcomeUnknown } from './apiErrors';

export const PENDING_KEY = 'humancare_pending_submissions';
export const MAX_PENDING = 5;
export const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000; // an unconfirmed submission is kept for two weeks, then forgotten
export const STORE_VERSION = 2; // 2: entries carry the account they belong to (version 1 had none and is not read)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A random version 4 UUID, lower-case. Uses the platform's crypto when it has one, and otherwise fills the bytes itself. The key only has to be unique for one patient, and the
// server scopes it to the patient, so it is not a secret.
export function generateClientRequestId(source = globalThis.crypto) {
  if (source && typeof source.randomUUID === 'function') return String(source.randomUUID()).toLowerCase();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // the usual variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isClientRequestId = (value) => typeof value === 'string' && UUID.test(value);

// An answer that does NOT say whether the request was saved: no answer at all (a lost connection, a timeout: lib/apiErrors.js outcomeUnknown) or a server error (5xx), which
// is not a confirmation that nothing was saved. Anything else (a 4xx refusal, a session problem) is an ANSWER: the server said no.
export const isUnconfirmed = (err) => isOutcomeUnknown(err) || Number(err && err.status) >= 500;

// A copy that nothing the form does afterwards can reach (the payload is plain JSON data).
const snapshot = (value) => JSON.parse(JSON.stringify(value));

// storage: { get(key) -> Promise<string|null>, set(key, value), del(key) } (the phone's secure storage; a Map in the tests).
// getUserId: async () -> "<role>:<id>" of the signed-in account, or null when there is none / it cannot be read (lib/tokenIdentity.js).
// `vault` (optional, lib/unresolvedSubmissionVault.js): where the original payload and service of an UNRESOLVED submission are kept ENCRYPTED across an app restart, so the key is never
// replaced while the earlier request may still exist (restore(), getUnresolved()).
export function createSubmissionTracker({ storage, getUserId, generate = generateClientRequestId, now = () => Date.now(), vault = null }) {
  let current = null; // the key of the submission the person is working on (this draft)
  let currentUser = null; // the account that key was made for
  let active = null; // the key whose answer is still awaited right now (so the Home notice does not call a running submission "unconfirmed")
  let original = null; // the payload first sent with `current` (memory only): what a retry sends again
  let unconfirmed = false; // an attempt of `current` ended with an UNKNOWN outcome: the request may exist (or still be being processed). While true, nothing a LATER attempt hears clears the key or the original

  const me = async () => { try { return (await getUserId()) || null; } catch { return null; } };
  let service = null; // the service key of the submission in progress / unresolved (never medical content)
  const forgetDraft = () => { current = null; currentUser = null; active = null; original = null; unconfirmed = false; service = null; };
  // Forgets the encrypted record of the signed-in account (best effort: a failure leaves a record that expires by itself).
  const dropVault = async () => { if (!vault) return; const user = await me(); if (user) await vault.remove(user).catch(() => undefined); };

  async function load() {
    try {
      const raw = await storage.get(PENDING_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const items = parsed && parsed.v === STORE_VERSION && Array.isArray(parsed.items) ? parsed.items : [];
      const cutoff = now() - PENDING_TTL_MS;
      return items
        .filter((item) => item && isClientRequestId(item.id) && Number.isFinite(item.startedAt) && item.startedAt > cutoff && typeof item.userId === 'string' && item.userId)
        .map((item) => ({ id: item.id.toLowerCase(), startedAt: item.startedAt, userId: item.userId }))
        .slice(-MAX_PENDING);
    } catch {
      return []; // unreadable storage or damaged content: nothing is remembered, nothing breaks
    }
  }
  async function save(items) {
    try {
      if (!items.length) await storage.del(PENDING_KEY);
      else await storage.set(PENDING_KEY, JSON.stringify({ v: STORE_VERSION, items: items.slice(-MAX_PENDING) }));
    } catch { /* the key still works for this run; it just would not survive a restart */ }
  }
  async function remove(id) { await save((await load()).filter((item) => item.id !== id)); }

  return {
    getCurrent: () => current,
    // What was first sent with the current key (a copy), or null. A retry sends THIS, never what the form says now.
    getOriginalPayload: () => (original ? snapshot(original) : null),
    // Remembers the payload that is about to be sent for the first time with the current key, and the service it is for. In memory, and ENCRYPTED in the vault (never in the clear) BEFORE the
    // send, so an app that is killed mid-send still knows after a restart what was sent and under which key. A vault that cannot be written does not stop the send.
    async rememberPayload(body, serviceKey = null) {
      original = snapshot(body);
      service = serviceKey || null;
      if (!vault || !current) return;
      const user = await me();
      if (user) await vault.save(user, { id: current, service: service || '', startedAt: now(), payload: original }).catch(() => undefined);
    },

    // Called right before a send. The first time for a submission it makes the key; every later time (a retry) it returns the SAME one. The key is on the device before this
    // resolves, so before anything is sent.
    async begin() {
      const user = await me();
      // The account changed since this draft's key was made (and nobody told us): it is not this account's key. Start over rather than carry it across.
      if (current && currentUser && user && user !== currentUser) forgetDraft();
      if (!current) current = generate();
      if (user) currentUser = user;
      active = current;
      // A key is only remembered for an account we can name; without one it still works for this run.
      if (user) {
        const items = await load();
        if (!items.some((item) => item.id === current)) await save([...items, { id: current, startedAt: now(), userId: user }]);
      }
      return current;
    },

    // The server confirmed it saved the request: this submission is finished, the next one is new.
    async confirm() {
      const id = current;
      forgetDraft();
      if (id) await remove(id);
      await dropVault();
    },

    // THIS attempt had no effect: the server refused it with an answer (a field to correct), or it was turned away before it could be processed (the session expired or could not be
    // verified, so nothing was sent, or the server's authentication check refused it). If it was the FIRST attempt nothing was saved, so there is nothing unconfirmed to remember and
    // the payload no longer matters; the same draft keeps its key, so the corrected form is still one logical submission.
    // But if an EARLIER attempt of this submission ended with an unknown outcome, this refusal says NOTHING about it: that request may have been saved, or may still be being processed
    // while this answer arrives. The key, the original payload and the stored entry are then all kept, exactly as they were.
    async answered() {
      active = null;
      if (unconfirmed) return;
      original = null;
      if (current) await remove(current);
      await dropVault();
    },

    // The outcome is unknown (no answer): the key and the original payload stay, and the submission is no longer "running".
    settle() { active = null; },

    // An attempt ended with an UNKNOWN outcome (no answer, or a server error): the request may exist. From now on the key and the original payload stay until the outcome is CONFIRMED
    // (the server says it saved the request), the person discards the submission, or the account changes. Nothing a later refusal says can clear them.
    markUnconfirmed() { active = null; unconfirmed = true; },
    isUnconfirmed: () => unconfirmed,

    // A new submission is starting (a fresh start of a service, another service chosen): the next begin() makes a NEW key. Unconfirmed submissions already stored stay (so
    // "Check status" can still find them); only the person's explicit discard, a confirmed outcome, an account switch or the account's deletion forgets them.
    // An UNRESOLVED submission (unconfirmed) is NOT forgotten by this: starting another request, resuming a draft or switching service never replaces its key. Before anything is sent the
    // Review screen asks the server about it (lib/submissionGate.js), and only a verified outcome clears it.
    startNew() { if (unconfirmed) return; forgetDraft(); },

    // After an app restart: reads the account's unresolved submission back from the encrypted record (its key, original payload and service) and marks it unconfirmed. Nothing is sent. true when one
    // was restored. Does nothing while a submission is already in memory.
    async restore() {
      if (current || !vault) return false;
      const user = await me();
      if (!user) return false;
      const record = await vault.load(user).catch(() => null);
      if (!record) return false;
      current = record.id; currentUser = user; original = snapshot(record.payload); service = record.service || null; unconfirmed = true; active = null;
      const items = await load();
      if (!items.some((item) => item.id === current)) await save([...items, { id: current, startedAt: record.startedAt, userId: user }]);
      return true;
    },
    // The unresolved submission (key, service and original payload as a copy), or null.
    getUnresolved: () => (unconfirmed && current && original ? { id: current, service, payload: snapshot(original) } : null),
    // A verified outcome says the earlier submission needs no further care (the server has nothing to be duplicated): it is forgotten, here and in the vault.
    async discardUnresolved() {
      const id = current;
      forgetDraft();
      if (id) await remove(id);
      await dropVault();
    },

    // The unconfirmed submissions of the SIGNED-IN account that the person may check, oldest first, without the one still running. Another account's are never shown.
    async pending() {
      const user = await me();
      if (!user) return [];
      return (await load()).filter((item) => item.userId === user && item.id !== active).map(({ id, startedAt }) => ({ id, startedAt }));
    },

    // The person dismissed one (or it was found): forget it.
    async discard(id) {
      if (current === id) { forgetDraft(); await dropVault(); } else if (active === id) active = null;
      await remove(id);
    },

    // A sign-in (a first login, a login after the session expired or after logging out). The same account keeps everything. ANOTHER account (an account switch) keeps nothing of
    // the previous one: its stored keys are deleted and the draft's key and payload are dropped. If the account cannot be named, nothing is changed here (nothing is shown to
    // an account that cannot be named either: pending() needs one).
    async onSignIn() {
      const user = await me();
      if (!user) return;
      if (currentUser && currentUser !== user) forgetDraft();
      const items = await load();
      const mine = items.filter((item) => item.userId === user);
      if (mine.length !== items.length) await save(mine);
    },

    // A sign-out, or a session that ended (expired and could not be renewed): NOTHING is cleared. The same account will log in again, and its unresolved keys and its draft must
    // still be there; a different account is handled at sign-in.
    onSignOut() {},

    // The account is deleted (or everything must go): nothing is kept.
    async clearAll() {
      await dropVault(); // (before forgetting: the account is read from the token)
      forgetDraft();
      try { await storage.del(PENDING_KEY); } catch { /* nothing more can be done */ }
    },
  };
}

// The handler for the app's session announcements (lib/session.js onSessionChange: true = signed in, false = signed out).
export const sessionChangeHandler = (tracker) => (signedIn) => (signedIn ? tracker.onSignIn() : tracker.onSignOut());
