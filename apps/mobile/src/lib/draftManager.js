// Phase 6: when drafts are written and deleted, and whether the last save worked. Pure (the store, the clock and the account lookup are injected).
//
// ACCOUNT SAFETY. Every change is attributed to the account that was signed in when it was MADE (the account AppContext reported with setAccount(); only if none was reported yet is it
// read from the token). A save is checked against the signed-in account and against an "epoch" before it starts, before the key is made, before the data is encrypted, before it is
// written and after it is written (lib/draftStore.js `verify`). Another account signing in (setAccount with a different id) or an explicit discard/logout bumps the epoch: every waiting
// or running save of the old epoch is dropped or stops, so an account's answers can never be committed under another's. A session that merely EXPIRES (nobody signed in) does not bump it:
// the owner's draft is still saved for the owner, who finds it again on signing in. Saving never touches the network and never throws into the UI. Nothing is logged.
//
// SAVE STATUS. A small non-sensitive signal for the form: 'idle' | 'saving' | 'saved' | 'error'. It says only whether the last write is known to have completed; it never carries any
// content, and 'saved' is reported only after the write and the final account check have both succeeded. A failed write (a full disk, a locked store) is 'error': the form stays usable.
import { hasAnswers, isDraftService, isDraftStep } from './draftSchema';

export function createDraftManager({ store, getAccountId, defaults, delay = 800, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = null; // { ownerP, epoch, service, step, draft }
  let timer = null;
  let savedThisSession = false;
  let writing = Promise.resolve();
  let epoch = 0;
  let knownAccount = null;
  let status = 'idle';
  const listeners = new Set();

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    for (const listener of listeners) { try { listener(status); } catch { /* a listener never stops a save */ } }
  };
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const readAccount = async () => { try { return (await getAccountId()) || null; } catch { return null; } };

  const run = async (job) => {
    try {
      const owner = await job.ownerP;
      if (!owner || job.epoch !== epoch) return { ok: false, reason: 'account' };
      // The signed-in account must still be the owner (nobody signed in is fine: an expired session keeps its owner's draft) and nothing may have invalidated this save.
      const verify = async () => { if (job.epoch !== epoch) return false; const current = await readAccount(); return !current || current === owner; };
      if (!(await verify())) return { ok: false, reason: 'account' };
      if (!hasAnswers(job.service, job.draft, defaults)) {
        if (savedThisSession) { savedThisSession = false; await store.discard(owner); return { ok: true, cleared: true }; } // everything was cleared by hand
        return { ok: false, reason: 'empty' };
      }
      const result = await store.save(owner, job.service, job.step, job.draft, { verify });
      if (result.ok) savedThisSession = true;
      return result;
    } catch {
      return { ok: false, reason: 'storage' };
    }
  };

  const flush = () => {
    stop();
    const job = pending;
    pending = null;
    if (!job) return writing;
    writing = writing.then(async () => {
      const result = await run(job);
      if (job.epoch === epoch) { // a save of an old epoch says nothing about the form now on screen
        if (result.ok && result.savedAt) setStatus(pending ? 'saving' : 'saved');
        else if (result.ok || result.reason === 'account' || result.reason === 'empty') setStatus(pending ? 'saving' : 'idle');
        else setStatus('error'); // 'storage' | 'too_large' | 'input' | 'unsupported': not saved, and the person is told
      }
      return result;
    });
    return writing;
  };

  const invalidate = () => { epoch += 1; stop(); pending = null; savedThisSession = false; setStatus('idle'); };

  return {
    // The form changed (or moved to another step). `draft` is the whole form state: only its whitelisted answers are ever written.
    schedule(draft, step) {
      if (!draft || draft.sentRequest || !isDraftService(draft.service) || !isDraftStep(step)) return;
      const ownerP = knownAccount ? Promise.resolve(knownAccount) : readAccount();
      pending = { ownerP, epoch, service: draft.service, step, draft: { ...draft } };
      stop();
      setStatus('saving');
      timer = setTimer(() => { timer = null; flush(); }, delay);
    },
    flush, // the app is going to the background: write what is waiting now
    cancel() { stop(); pending = null; setStatus('idle'); },
    // AppContext reports who is signed in. A DIFFERENT account invalidates everything of the previous one; the same one, or nobody, changes nothing.
    setAccount(id) {
      if (!id) return;
      if (knownAccount && knownAccount !== id) invalidate();
      knownAccount = id;
    },
    // A confirmed submission, an explicit logout, account deletion, "Discard": what is waiting is dropped, a running save is invalidated, then the draft (and its key) is deleted.
    // The store runs operations in order, so a save already running finishes before this deletion and cannot bring the draft back.
    async discard(accountId) {
      invalidate();
      const id = accountId || knownAccount || await readAccount();
      await writing.catch(() => undefined);
      return store.discard(id);
    },
    submitted(accountId) { return this.discard(accountId); },
    isWaiting: () => pending !== null,
    getStatus: () => status,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // A fresh form was started or the draft was restored: the "everything cleared" rule starts over.
    reset(restored = false) { stop(); pending = null; savedThisSession = restored; setStatus('idle'); },
  };
}
