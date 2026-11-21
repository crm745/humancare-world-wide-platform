// Pure rules for sending a request and its report files (no React, no native modules), so they can
// be unit-tested.
//
// The request and its files are two steps: POST /requests, then one upload per file. The request
// is saved by the first step whatever happens to the second, so a failed file must never be
// treated as sent and a retry must never create a second request. This keeps these things in the
// draft (the form's own state, so the answers and the chosen files are never cleared by it):
//   sentRequest    { id, referenceNumber, title } once the request is saved, else null
//   uploaded       the `uri` of every file the server accepted
//   uploadErrors   { uri: message } for the files the server REFUSED (it answered, and said no)
//   uploadUnknown  { uri: message } for the files whose answer never arrived: the server MAY have them (Phase 5, lib/uploadRecovery.js)
// and every file carries its own `clientUploadId`, made once and reused by every retry (lib/uploadRecovery.js stampUploadIds).
import { checkUploads, classifyUploadFailure, sendableFiles, stampUploadIds, withoutUploadId } from './uploadRecovery';

// The files the server has not accepted yet, in the order they were chosen.
export const pendingFiles = (files, uploaded) => (files || []).filter((file) => !(uploaded || []).includes(file.uri));

// Where a saved request stands, from what the server has accepted:
//   'none'     nothing was sent yet
//   'draft'    saved, but not one document is accepted: it is NOT submitted (a request needs at least one)
//   'partial'  submitted, with at least one document accepted, but others still not uploaded
//   'complete' submitted, every chosen document accepted
export function submissionState({ sentRequest, files, uploaded }) {
  if (!sentRequest) return 'none';
  if (!(uploaded || []).length) return 'draft';
  return pendingFiles(files, uploaded).length ? 'partial' : 'complete';
}

// Saves the request if that has not happened yet, then uploads the files that may be sent (not accepted, not waiting to be checked), one at a time. Resolves the new upload state:
// { sentRequest, uploaded, uploadErrors, uploadUnknown, files, note }. Throws only if the request itself could not be saved (nothing is then marked as sent).
//   createRequest()          -> { id, referenceNumber, title }  (called at most once, and never again once saved)
//   upload(file, onProgress, sentRequest) -> resolves when the server has the file, throws when it has not
//   onSent(state)            -> called right after the request is saved, before any file is sent, and when ids were given to files of an already-saved request
//   onProgress({ index, total, progress })   onFile(file | null) -> the file being sent now (null between files)
//   generateId()             -> a new random UUID for a file that has none (the screens pass the phone's secure generator)
//   adoptIds                 -> ids of earlier uploads of this request that were never confirmed (the journal, after a restart): files without an id take them first (see stampUploadIds)
//   journal                  -> { begin(requestId, id), settle(requestId, id, kind) } (lib/uploadJournal.js): an upload's id is written BEFORE it is sent and forgotten once its outcome is known,
//                               so a restart can still check an upload that was in flight. Best effort: a journal that fails never stops an upload.
//
// WHAT A FAILED FILE MEANS (lib/uploadRecovery.js classifyUploadFailure):
//   refused      the server answered and said no: the message is kept for that file and the OTHER files carry on
//   unconfirmed  no answer: the server may have the file. It is NOT a failure and is never sent again by this function. The loop STOPS here: the connection is not to be trusted, and every
//                further file would only be a further unknown. The files not yet tried stay pending.
//   notSent      certainly not received (cancelled before the transfer, the session needed renewing): the file stays pending and the loop stops
// `note` says why the loop stopped early: null, or { stopped: 'unconfirmed' | 'notSent', message }.
export async function runSubmission({ sentRequest, uploaded, uploadErrors, uploadUnknown, files, createRequest, upload, onSent, onProgress, onFile, generateId, adoptIds, journal }) {
  let sent = sentRequest || null;
  const accepted = sent ? [...(uploaded || [])] : [];
  const errors = sent ? { ...(uploadErrors || {}) } : {};
  const unknown = sent ? { ...(uploadUnknown || {}) } : {};
  let stamped = stampUploadIds(files, generateId, adoptIds);
  const state = (extra = {}) => ({ sentRequest: sent, uploaded: accepted, uploadErrors: errors, uploadUnknown: unknown, files: stamped, ...extra });
  if (!sent) {
    sent = await createRequest();
    onSent?.(state());
  } else if (stamped !== files) {
    onSent?.(state()); // ids were just given to files that had none: kept before anything is sent, so every retry of a file sends the same one
  }

  const todo = sendableFiles(stamped, accepted, unknown);
  let note = null;
  for (let i = 0; i < todo.length; i += 1) {
    const file = todo[i];
    const report = (progress) => onProgress?.({ index: i + 1, total: todo.length, progress });
    report(0);
    onFile?.(file);
    const id = file.clientUploadId;
    try {
      if (journal) await journal.begin(sent.id, id).catch(() => undefined); // written BEFORE the first byte is sent
      await upload(file, report, sent);
      accepted.push(file.uri);
      delete errors[file.uri];
      delete unknown[file.uri];
      if (journal) await journal.settle(sent.id, id, 'accepted').catch(() => undefined);
    } catch (err) {
      const kind = classifyUploadFailure(err);
      const message = (err && err.message) || 'Upload failed. Please try again.';
      if (kind === 'unconfirmed') { unknown[file.uri] = message; delete errors[file.uri]; note = { stopped: 'unconfirmed', message }; } else if (kind === 'notSent') { delete errors[file.uri]; note = { stopped: 'notSent', message }; } else {
        errors[file.uri] = message;
        // The id was already used for DIFFERENT content (a re-attached file that was not the one the id was first given to): the file is given a fresh id for the person's next try.
        if (err && err.code === 'client_upload_id_reused') stamped = stamped.map((f) => (f.uri === file.uri ? withoutUploadId(f) : f));
      }
      if (journal && kind !== 'unconfirmed') await journal.settle(sent.id, id, kind).catch(() => undefined); // an unknown outcome keeps its id for a restart to check
    } finally {
      onFile?.(null);
    }
    if (note) break;
  }
  return state({ note });
}

// "Retry missing": FIRST asks the server which of the waiting (unconfirmed) files it already has, by upload id, THEN sends only the files that may be sent: those never sent, the ones the
// server refused earlier, and the ones the server has just been confirmed NOT to have. A file the server cannot confirm either way (an older server, an incomplete answer) is left
// waiting, and `check.result` tells the screen to ask the person. If the list cannot be read at all, nothing is sent. Resolves runSubmission's state plus `check`.
//   fetchRequest(requestId) -> the API's { request }
export async function recoverUploads({ requestId, files, uploaded, uploadErrors, uploadUnknown, fetchRequest, upload, onProgress, onFile, generateId, adoptIds, journal }) {
  const stamped = stampUploadIds(files, generateId, adoptIds);
  const check = await checkUploads({ requestId, files: stamped, uploaded, unknown: uploadUnknown, fetchRequest, journal });
  if (check.result === 'unreachable') {
    return { sentRequest: { id: requestId }, uploaded: [...(uploaded || [])], uploadErrors: { ...(uploadErrors || {}) }, uploadUnknown: { ...(uploadUnknown || {}) }, files: stamped, note: null, check };
  }
  const run = await runSubmission({
    sentRequest: { id: requestId }, uploaded: check.uploaded, uploadErrors, uploadUnknown: check.unknown, files: stamped, upload, onProgress, onFile, generateId, journal,
  });
  return { ...run, check };
}
