// Phase 5: what is known about each file of a request, and what may be done about it. Pure (no React, no native modules): the API calls are passed in.
//
// STABLE UPLOAD IDENTITY. Every file gets ONE random UUID, `clientUploadId`, when it first enters the upload workflow (stampUploadIds). It lives on the file's own entry in the form
// state, so every retry of that file sends the SAME id, a different file always has a different one, and taking a file off the list and choosing it again is a new upload with a new
// id. It is held in memory with the file entry only: neither the id nor the file's uri or contents are ever written to the phone's storage or to the encrypted draft (Phase 6).
//
// THE FIVE STATES of a file (uploadStateOf):
//   pending      not sent yet, or sent and certainly not received (cancelled before anything was sent, the session had to be renewed first)
//   sending      the transfer is running right now
//   unconfirmed  the answer never arrived: the server MAY have the file. Never shown as failed, never sent again blindly
//   accepted     the server said it has the file
//   refused      the server evaluated the file and said no (a 4xx): sending it again as it is would be refused again
// The screens keep three plain collections (the draft's existing `uploaded`, `uploadErrors`, plus `uploadUnknown`); the state is read from them, so older code keeps working.
//
// UNKNOWN OUTCOMES ARE CHECKED, NOT GUESSED. checkUploads asks the server for the request's own document list and matches by `clientUploadId` ONLY (never by name or size):
//   the id is listed          -> accepted
//   the id is not listed      -> missing, but only when the server says it keeps upload ids (`clientUploadIdSupported`) and gave the list; then, and only then, it may be sent again
//   an older server, an incomplete answer, a file with no id, or no answer at all -> still unconfirmed, and the person is told what to do (never "missing", never "failed")
// Nothing here runs by itself: every call is made from a person's tap, and nothing listens for the connection coming back.
import { classifySendFailure } from './requestSubmission';
import { generateClientRequestId, isClientRequestId } from './submissionKey';

export const UPLOAD_STATES = ['pending', 'sending', 'unconfirmed', 'accepted', 'refused'];

export const uploadIdOf = (file) => (file && isClientRequestId(file.clientUploadId) ? file.clientUploadId.toLowerCase() : null);

// Gives every file without an id a new one, and keeps the ones that have one. Returns the SAME array when nothing was missing (so state that holds it does not change).
// `adopt` (optional) are ids of EARLIER uploads of this request whose outcome was never confirmed (the upload journal, after a restart): the first files without an id take them, in order,
// before any new id is made. A re-attached file then carries the id of the upload it is most likely the same as, so if that original arrives at the server late the server recognises it as
// the same upload (by id, and its SHA-256 must match) and keeps one document. If it is in fact a different file the server refuses it (409), and the file is given a fresh id (withoutUploadId).
export function stampUploadIds(files, generate = generateClientRequestId, adopt = []) {
  const list = Array.isArray(files) ? files : [];
  if (list.every((file) => uploadIdOf(file))) return list;
  const used = new Set(list.map(uploadIdOf).filter(Boolean));
  const spare = (Array.isArray(adopt) ? adopt : []).filter((id) => isClientRequestId(id)).map((id) => id.toLowerCase()).filter((id) => !used.has(id));
  return list.map((file) => {
    if (uploadIdOf(file)) return file;
    let id = spare.shift();
    if (!id) do { id = String(generate()).toLowerCase(); } while (used.has(id));
    used.add(id);
    return { ...file, clientUploadId: id };
  });
}

export function withoutUploadId(file) {
  const copy = { ...file };
  delete copy.clientUploadId;
  return copy;
}

// What a failed upload means. 'unconfirmed' (no answer, a 5xx, a cancel after the transfer began, anything not recognised), 'notSent' (certainly not received: cancelled before the
// transfer, session refused it, nobody signed in), 'refused' (the server said no). The same rules as a failed request (lib/requestSubmission.js classifySendFailure).
export function classifyUploadFailure(err) {
  if (err && err.cancelled) return err.notProcessed ? 'notSent' : 'unconfirmed';
  // The server said it could not scan the file and therefore did NOT save it (a fail-closed 503): that is a certain "not received", unlike any other 5xx. The same upload can simply be sent again.
  if (err && err.code === 'scan_unavailable') return 'notSent';
  const kind = classifySendFailure(err);
  return kind === 'edited' ? 'refused' : kind;
}

export function uploadStateOf(file, { uploaded = [], unknown = {}, errors = {} } = {}, sendingUri = null) {
  if (uploaded.includes(file.uri)) return 'accepted';
  if (sendingUri !== null && sendingUri === file.uri) return 'sending';
  if (unknown[file.uri]) return 'unconfirmed';
  if (errors[file.uri]) return 'refused';
  return 'pending';
}

// The files that may be sent: not accepted, and not waiting to be checked. An unconfirmed file is never in this list.
export const sendableFiles = (files, uploaded, unknown) => (files || []).filter((file) => !(uploaded || []).includes(file.uri) && !(unknown && unknown[file.uri]));

// Everything a screen needs to draw the list and decide which buttons to offer.
export function uploadSummary(files, state, sendingUri = null) {
  const list = Array.isArray(files) ? files : [];
  const rows = list.map((file) => ({ file, state: uploadStateOf(file, state, sendingUri) }));
  const by = (name) => rows.filter((row) => row.state === name).map((row) => row.file);
  const accepted = by('accepted');
  const unconfirmed = by('unconfirmed');
  const refused = by('refused');
  const pending = by('pending');
  const sendable = sendableFiles(list, state && state.uploaded, state && state.unknown);
  return {
    rows,
    accepted,
    unconfirmed,
    refused,
    pending,
    sendable,
    needsCheck: unconfirmed.length > 0,
    canRetry: sendable.length > 0,
    complete: list.length > 0 && accepted.length === list.length,
    outstanding: list.length - accepted.length,
  };
}

// The request's own document list, as the server sent it: both places a document can be kept (the review workflow's and the original Case's).
export function documentsOf(request) {
  const out = [];
  if (request && Array.isArray(request.requestDocuments)) out.push(...request.requestDocuments);
  if (request && request.case && Array.isArray(request.case.documents)) out.push(...request.case.documents);
  return out;
}

// Reads the request again and decides, for each unconfirmed file, from its upload id alone. `fetchRequest(requestId)` resolves the API's `{ request }` (or the request).
// Resolves { result, uploaded, unknown, matched, missing, unverifiable } and never throws:
//   result 'nothing'      no file was waiting to be checked
//   result 'unreachable'  the list could not be read (offline, a timeout, an error): nothing changes, nothing is assumed
//   result 'checked'      every waiting file was decided as far as the server's answer allows (see matched / missing / unverifiable)
export async function checkUploads({ requestId, files, uploaded, unknown, fetchRequest, journal }) {
  const accepted = [...(uploaded || [])];
  const waiting = { ...(unknown || {}) };
  const toCheck = (files || []).filter((file) => !accepted.includes(file.uri) && waiting[file.uri]);
  if (!toCheck.length) return { result: 'nothing', uploaded: accepted, unknown: waiting, matched: 0, missing: 0, unverifiable: 0 };
  let request;
  try {
    const answer = await fetchRequest(requestId);
    request = answer && answer.request ? answer.request : answer;
  } catch {
    return { result: 'unreachable', uploaded: accepted, unknown: waiting, matched: 0, missing: 0, unverifiable: toCheck.length };
  }
  const documents = documentsOf(request);
  const listed = request && typeof request === 'object' && Array.isArray(request.requestDocuments);
  const supported = !!request && request.clientUploadIdSupported === true && listed; // an older server, or an answer without the list, proves nothing
  const ids = new Set(documents.map((doc) => (doc && typeof doc.clientUploadId === 'string' ? doc.clientUploadId.toLowerCase() : null)).filter(Boolean));
  let matched = 0;
  let missing = 0;
  let unverifiable = 0;
  for (const file of toCheck) {
    const id = uploadIdOf(file);
    if (id && ids.has(id)) { accepted.push(file.uri); delete waiting[file.uri]; matched += 1; if (journal) await journal.settle(requestId, id, 'accepted'); } else if (id && supported) { delete waiting[file.uri]; missing += 1; } else unverifiable += 1;
  }
  return { result: 'checked', uploaded: accepted, unknown: waiting, matched, missing, unverifiable };
}

// AFTER A RESTART: the files are gone, only the journal's ids remain (lib/uploadJournal.js). Asks the server for the request's document list and decides each id by itself, with the same
// rules as above (an id that is listed is found; an id that is not is missing ONLY when the server says it keeps upload ids and gave the list; anything else cannot be decided).
// Resolves { result: 'nothing' | 'unreachable' | 'checked', found, missing, unverifiable } (arrays of ids). Never throws, never sends anything.
export async function checkStoredUploads({ requestId, ids, fetchRequest }) {
  const waiting = (ids || []).filter((id) => typeof id === 'string').map((id) => id.toLowerCase());
  if (!waiting.length) return { result: 'nothing', found: [], missing: [], unverifiable: [] };
  let request;
  try {
    const answer = await fetchRequest(requestId);
    request = answer && answer.request ? answer.request : answer;
  } catch {
    return { result: 'unreachable', found: [], missing: [], unverifiable: waiting };
  }
  const listed = request && typeof request === 'object' && Array.isArray(request.requestDocuments);
  const supported = !!request && request.clientUploadIdSupported === true && listed;
  const present = new Set(documentsOf(request).map((doc) => (doc && typeof doc.clientUploadId === 'string' ? doc.clientUploadId.toLowerCase() : null)).filter(Boolean));
  const found = waiting.filter((id) => present.has(id));
  const rest = waiting.filter((id) => !present.has(id));
  return { result: 'checked', found, missing: supported ? rest : [], unverifiable: supported ? [] : rest };
}

// The word for the result of checkStoredUploads (the same words as checkMessageKey).
export function storedCheckKey(check) {
  if (!check || check.result === 'nothing') return 'nothing';
  if (check.result === 'unreachable') return 'unreachable';
  if (check.unverifiable.length > 0) return 'cannotConfirm';
  if (check.missing.length > 0) return 'someMissing';
  return 'allFound';
}

// The one word a screen turns into a message after a check.
//   'unreachable'   could not ask the server: nothing changed
//   'cannotConfirm' some files cannot be decided (an older server, or no list): the person must look at the request's documents and attach again only what is not there
//   'someMissing'   the server confirmed it does not have some files: they can be sent again
//   'allFound'      every waiting file was found on the server
//   'nothing'       nothing was waiting
export function checkMessageKey(check) {
  if (!check || check.result === 'nothing') return 'nothing';
  if (check.result === 'unreachable') return 'unreachable';
  if (check.unverifiable > 0) return 'cannotConfirm';
  if (check.missing > 0) return 'someMissing';
  return 'allFound';
}
