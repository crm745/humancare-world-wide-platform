// The check that runs BEFORE a request is sent, when an earlier submission of this account is still unresolved (its answer was lost, or the app was closed or killed while it was being
// sent; lib/submissionKey.js keeps its key, original payload and service, in memory and, encrypted, across restarts). Pure: the tracker and the API call are passed in.
//
// The rule: a new key is never made for a request while an earlier one for the same request is unresolved, and nothing is sent until the server has been asked what it has.
//   the server cannot be asked / does not answer     BLOCKED ('unconfirmed'): nothing is sent, the unresolved state is kept exactly as it was. The screen says one short message and the
//                                                    person presses the same button again (Try again).
//   the server HAS the earlier request (by its key)  it exists, so it is never sent again. If this is the SAME submission (same service, same content), that request is the result ('found');
//                                                    if the person changed the form, nothing is sent and they are told the request was already sent ('already_sent', once): the unresolved
//                                                    state is cleared because the outcome is now confirmed, so pressing the button again sends their changes as a new request. A different service is simply new.
//   the server does NOT have it, same submission     'send': the ORIGINAL payload goes again under the SAME key (the server saves it once, even if an earlier copy is still on its way)
//   the server does NOT have it, something different the earlier request is let go (the server has nothing to be duplicated) and this is a new submission with a new key. If the earlier one
//                                                    still arrives late, it is a different request: it cannot duplicate this one.
// Nothing here sends a request by itself, and nothing runs unless a person pressed the button.
import { checkSubmission, samePayload } from './requestSubmission';

export const BLOCKED_CODE = 'submission_blocked';

export const blockedError = (reason) => Object.assign(
  new Error(reason === 'already_sent' ? 'The request was already sent.' : 'We could not confirm the earlier request yet.'),
  { code: BLOCKED_CODE, reason },
);
export const isBlocked = (err) => !!err && err.code === BLOCKED_CODE;

// Resolves { action: 'send' } | { action: 'found', request } | { action: 'blocked', reason: 'unconfirmed' | 'already_sent' }.
export async function checkBeforeSend({ tracker, apiGet, service, body }) {
  await tracker.restore(); // after a restart the unresolved submission is read back from the encrypted record first
  const unresolved = tracker.getUnresolved();
  if (!unresolved) return { action: 'send' };

  const result = await checkSubmission(apiGet, unresolved.id);
  if (result.state === 'failed') return { action: 'blocked', reason: 'unconfirmed' };

  const sameService = (unresolved.service || '') === (service || '');
  const same = sameService && samePayload(unresolved.payload, body);
  if (result.state === 'found') {
    await tracker.confirm(); // the server has it: nothing is unresolved any more
    if (same) return { action: 'found', request: result.request };
    return sameService ? { action: 'blocked', reason: 'already_sent' } : { action: 'send' };
  }
  // not found
  if (same) return { action: 'send' }; // tracker.begin() hands back the SAME key and postWithKey sends the ORIGINAL payload
  await tracker.discardUnresolved();
  return { action: 'send' };
}
