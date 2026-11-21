// Phase 5: the upload journal. When the app is closed or killed while a file is being sent, the file's answer is lost with it, and after a restart nothing in memory says the server may
// already have that file. This keeps the one safe fact needed to find out: for each request, the random upload ids (`clientUploadId`) of the uploads that were STARTED and whose outcome is
// not known. It is written before a file is sent (like the Phase 4 submission key) and forgotten as soon as the outcome is known.
//
// WHAT IS KEPT: { requestId, ids } for the signed-in account, and when it was written. WHAT IS NEVER KEPT: file names, file uris, file contents, sizes, or anything a person typed. An id is
// a random number that names nothing; with the request id it can only be used to ask the server "do you have this upload?". After a restart the file itself is gone, so the person must
// attach it again; the journal is what lets the app check first (so a file that did arrive is not sent twice) and lets the re-attached file reuse the id (so an original that arrives
// late is recognised by the server as the same upload).
//
// Pure: the storage (the phone's secure storage; a Map in the tests) and the account lookup are injected. Entries belong to one account and are never read by another; they expire after
// TTL_MS. Nothing here logs.
import { isClientRequestId } from './submissionKey';

export const JOURNAL_KEY = 'humancare_upload_journal';
export const JOURNAL_VERSION = 1;
export const JOURNAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 20;
const MAX_IDS = 30; // a request holds at most 30 documents

const same = (a, b) => String(a) === String(b);

export function createUploadJournal({ storage, getUserId, now = () => Date.now() }) {
  const me = async () => { try { return (await getUserId()) || null; } catch { return null; } };

  async function load() {
    try {
      const raw = await storage.get(JOURNAL_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const cutoff = now() - JOURNAL_TTL_MS;
      const items = parsed && parsed.v === JOURNAL_VERSION && Array.isArray(parsed.items) ? parsed.items : [];
      return items
        .filter((item) => item && (typeof item.requestId === 'number' || typeof item.requestId === 'string') && String(item.requestId) !== ''
          && typeof item.userId === 'string' && item.userId && Number.isFinite(item.at) && item.at > cutoff && Array.isArray(item.ids))
        .map((item) => ({ requestId: item.requestId, userId: item.userId, at: item.at, ids: [...new Set(item.ids.filter(isClientRequestId).map((id) => id.toLowerCase()))].slice(0, MAX_IDS) }))
        .filter((item) => item.ids.length)
        .slice(-MAX_REQUESTS);
    } catch {
      return []; // unreadable storage or damaged content: nothing is remembered, nothing breaks
    }
  }
  async function save(items) {
    try {
      if (!items.length) await storage.del(JOURNAL_KEY);
      else await storage.set(JOURNAL_KEY, JSON.stringify({ v: JOURNAL_VERSION, items: items.map(({ requestId, userId, at, ids }) => ({ requestId, userId, at, ids })) }));
      return true;
    } catch {
      return false; // best effort: a failed write only means a restart cannot check this upload
    }
  }

  const api = {
    // An upload is about to be sent: its id is written BEFORE the first byte goes.
    async begin(requestId, id) {
      const user = await me();
      if (!user || !isClientRequestId(id)) return false;
      const lower = id.toLowerCase();
      const items = await load();
      const mine = items.find((item) => item.userId === user && same(item.requestId, requestId));
      if (mine) { if (!mine.ids.includes(lower)) mine.ids.push(lower); mine.at = now(); } else items.push({ requestId, userId: user, at: now(), ids: [lower] });
      return save(items);
    },
    // The outcome is known (the server has the file, or refused it, or certainly never received it): the id is forgotten. An UNKNOWN outcome keeps it (kind 'unconfirmed').
    async settle(requestId, id, kind = 'accepted') {
      if (kind === 'unconfirmed') return true;
      return this.forget(requestId, [id]);
    },
    async forget(requestId, ids) {
      const user = await me();
      if (!user) return false;
      const drop = new Set((ids || []).filter(isClientRequestId).map((id) => id.toLowerCase()));
      const items = await load();
      const next = items
        .map((item) => (item.userId === user && same(item.requestId, requestId) ? { ...item, ids: item.ids.filter((id) => !drop.has(id)) } : item))
        .filter((item) => item.ids.length);
      return save(next);
    },
    // The ids of this account's uploads of this request whose outcome is not known (never another account's).
    async idsFor(requestId) {
      const user = await me();
      if (!user) return [];
      const item = (await load()).find((entry) => entry.userId === user && same(entry.requestId, requestId));
      return item ? item.ids.slice() : [];
    },
    async forgetRequest(requestId) {
      const user = await me();
      if (!user) return false;
      return save((await load()).filter((item) => !(item.userId === user && same(item.requestId, requestId))));
    },
    // Account deletion: nothing of the account is kept.
    async clearAll() {
      try { await storage.del(JOURNAL_KEY); return true; } catch { return false; }
    },
  };

  // Writes read the whole list and write it back, so they run one at a time.
  let chain = Promise.resolve();
  const serial = (fn) => (...args) => { const run = chain.then(() => fn.apply(api, args)); chain = run.then(() => undefined, () => undefined); return run; };
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, serial(fn)]));
}
