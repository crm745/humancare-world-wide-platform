// Sending a request with its idempotency key, and what to do with the outcome. Pure (no React, no native modules): the API functions and the tracker are passed in, so the
// whole flow can be unit-tested against the real api.js. See lib/submissionKey.js for the key's life.
//
// Nothing here ever sends a request by itself: every send is a function the Review screen calls from a person's tap, and a retry sends the SAME key AND the ORIGINAL payload, so
// the server can recognise it and so what it receives is exactly what was first sent. Nothing listens for the connection coming back.
//
// THE ORIGINAL PAYLOAD. The first send of a submission remembers its payload (in memory). If the outcome is then unknown, the request may already exist on the server with THAT content.
// So a later send never silently sends something else under the same key, and never silently drops the person's edits:
//   - the form still says what was first sent       -> the original is sent again (same key), exactly as it was
//   - the form was CHANGED since                    -> nothing is sent, and the caller is told (EDITED_CODE): the person must first find out what happened to the original (Check
//                                                      status). Only then can they choose: keep the original, send it again, or send the changes as a NEW request with a NEW key
//   - "send the original again" (sendOriginal)       -> the original is sent, whatever the form says now
import { isUnconfirmed } from './submissionKey';

export const REQUESTS_PATH = '/requests';
export const EDITED_CODE = 'edited_while_unconfirmed';
export const checkPath = (clientRequestId) => `/requests/me/by-client-request/${encodeURIComponent(clientRequestId)}`;

// Fields that come from the phone's clock and are not something the person edited (the time-zone offset every dated service sends). A change in them is not an edit.
const NOT_AN_EDIT = ['utcOffsetMinutes'];

// A stable text of a payload: keys sorted at every level, the fields above left out (at the top level, where the builders put them).
function canonical(value, top = false) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    // A field that is undefined is not sent (JSON drops it), so it is not part of the content: the stored copy of a payload must equal the payload it was taken from.
    const keys = Object.keys(value).filter((key) => value[key] !== undefined && !(top && NOT_AN_EDIT.includes(key))).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
export const samePayload = (a, b) => canonical(a, true) === canonical(b, true);

const editedError = () => Object.assign(new Error('The request was changed after it was sent.'), { code: EDITED_CODE });

// Sends one request body with the submission's key. The key is made (or reused) and stored on the device BEFORE the send.
export async function postWithKey(tracker, apiPost, body, { sendOriginal = false, service = null } = {}) {
  const clientRequestId = await tracker.begin();
  const original = tracker.getOriginalPayload();
  let toSend = body;
  if (original) {
    if (!sendOriginal && !samePayload(original, body)) {
      tracker.settle(); // nothing was sent: the submission is not running
      throw editedError();
    }
    toSend = original; // a retry sends what was first sent
  } else {
    await tracker.rememberPayload(body, service); // (the encrypted record is on the phone before the request leaves it)
  }
  return apiPost(REQUESTS_PATH, { ...toSend, clientRequestId });
}

// The server said it saved the request.
export const afterSaved = (tracker) => tracker.confirm();

// WHAT A FAILED SEND MEANS. The answer is about THIS attempt only, and it never decides more than it knows:
//   'edited'       the form was changed after the first send and nothing was sent (see above): the key and the original payload stay, untouched
//   'unconfirmed'  no answer at all, a server error (5xx), or anything not recognised: the request MAY have been saved. Never assume nothing happened.
//                  The key and the original payload now stay until the outcome is confirmed (tracker.markUnconfirmed)
//   'notSent'      the server did not process it, and that is CERTAIN: it was refused before anything was sent (the session could not be verified, nobody is signed in, secure storage could
//                  not be read) or the server's authentication check turned it away (401/403, the session expired or could not be renewed)
//   'refused'      the server evaluated it and answered with another 4xx (a field to correct, a conflict): this attempt had no effect
// 'notSent' and 'refused' are both "this attempt had no effect", which is NOT the same as "nothing was saved": if an EARLIER attempt of the same submission ended unconfirmed, that request may
// exist or may still be being processed while this answer arrives, so the tracker keeps the key, the original payload and the stored entry (tracker.answered). Only when there is no unknown
// attempt does a refusal end the submission's pending state. A server error or a lost connection is never a confirmed failure.
//
// Errors that certify "not processed" carry `notProcessed` (api.js, authGuard.js); the codes are listed as well, so an error rebuilt elsewhere is still recognised.
const NOT_PROCESSED_CODES = ['session_unverified', 'not_signed_in', 'session_expired', 'storage_timeout'];

export function classifySendFailure(err) {
  if (err && err.code === EDITED_CODE) return 'edited';
  if (isUnconfirmed(err)) return 'unconfirmed'; // no answer, or a 5xx
  const status = Number(err && err.status);
  if (err && (err.notProcessed === true || NOT_PROCESSED_CODES.includes(err.code) || status === 401 || status === 403)) return 'notSent';
  if (status >= 400 && status < 500) return 'refused';
  return 'unconfirmed'; // not recognised: never assume the server did not process it
}

export async function afterFailure(tracker, err) {
  const kind = classifySendFailure(err);
  if (kind === 'edited') return 'edited';
  if (kind === 'unconfirmed') {
    tracker.markUnconfirmed();
    return 'unconfirmed';
  }
  await tracker.answered(); // 'notSent' | 'refused': this attempt had no effect (state is kept as it was if an earlier attempt is unconfirmed)
  return kind;
}

// "Check status": asks the server whether it saved the submission with this key. It identifies the request by the KEY alone (never by service, name or number).
//   { state: 'found', request }   it was saved: this is the request
//   { state: 'notfound' }         the server has no request for this key (yet: an answer can still be on its way)
//   { state: 'failed', error }    the check itself could not be completed (no connection, a server error, a session problem): nothing is known
export async function checkSubmission(apiGet, clientRequestId) {
  try {
    const { request } = await apiGet(checkPath(clientRequestId));
    if (request && request.id !== undefined) return { state: 'found', request };
    return { state: 'failed', error: new Error('The server answered without a request.') };
  } catch (error) {
    if (error && error.status === 404) return { state: 'notfound' };
    return { state: 'failed', error };
  }
}
