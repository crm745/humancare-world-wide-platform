// What the "we couldn't confirm whether your request was received" card shows, for each stage of checking. Pure (no React), so it can be unit-tested.
// Used by the Review screen (the submission that just lost its answer) and by the Home notice (one found stored on the device after a restart).
//
// The wording never says the request FAILED: nothing here is a confirmed failure. The only things this card ever says are "we could not confirm" (the answer was lost),
// "received" (the server says it has the request), "we cannot see it yet" (not found, and an answer may still be on its way) and "we could not check" (the check itself did
// not complete). The translations are in data/i18n.json (req_*).
//
// phase:  'unknown'   the answer to the send was lost
//         'checking'  asking the server by the submission's key
//         'found'     the server has the request (with documents still to upload, the person continues)
//         'notfound'  the server has no request for the key (yet)
//         'failed'    the check could not be completed
// canSubmitAgain: the form is still here, so it can be sent again with the SAME key (Review). On Home there is no form: the person can only check or dismiss.
// hasFiles: the form has documents that are uploaded after the request is saved (so "found" continues to the upload instead of finishing).
// edited: the form was CHANGED after the request was first sent (lib/requestSubmission.js EDITED_CODE). The original may already exist without those changes, so nothing is sent
//         until the person has found out what happened to it, and the choices are always explicit: keep the original, send the original again, or send the changes as a NEW
//         request (a new key). It is never "resend with the edits": the server would hand back the original and the edits would be lost without a word.
export const PHASES = Object.freeze(['unknown', 'checking', 'found', 'notfound', 'failed']);

const CHECKING = { titleKey: 'req_unconfirmed_title', bodyKey: 'req_status_checking', actions: [{ id: 'check', labelKey: 'req_check_status', primary: true, loading: true }] };

export function unconfirmedView({ phase = 'unknown', canSubmitAgain = true, hasFiles = false, edited = false } = {}) {
  if (phase === 'checking') return CHECKING;

  if (edited && canSubmitAgain) {
    switch (phase) {
      case 'found':
        return {
          titleKey: 'req_status_received_title', bodyKey: 'req_edited_found',
          actions: [{ id: 'submitChanges', labelKey: 'req_submit_changes', primary: true }, { id: 'keepOriginal', labelKey: 'req_keep_original' }],
        };
      case 'notfound':
        return {
          titleKey: 'req_unconfirmed_title', bodyKey: 'req_edited_not_found',
          actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, { id: 'resendOriginal', labelKey: 'req_resend_original' }, { id: 'discardAndSubmit', labelKey: 'req_discard_submit' }],
        };
      case 'failed':
        return {
          titleKey: 'req_edited_title', bodyKey: 'req_status_check_failed',
          actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, { id: 'resendOriginal', labelKey: 'req_resend_original' }],
        };
      default:
        return {
          titleKey: 'req_edited_title', bodyKey: 'req_edited_body',
          actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, { id: 'resendOriginal', labelKey: 'req_resend_original' }],
        };
    }
  }

  const second = canSubmitAgain ? { id: 'submitAgain', labelKey: 'req_submit_again' } : { id: 'dismiss', labelKey: 'req_pending_dismiss' };
  // Where the form is still here, say what "Submit again" does: it sends the request exactly as it was first sent.
  const noteKey = canSubmitAgain ? 'req_resend_note' : undefined;
  switch (phase) {
    case 'found':
      return {
        titleKey: 'req_status_received_title',
        bodyKey: hasFiles && canSubmitAgain ? 'req_status_received_files' : 'req_status_received',
        actions: hasFiles && canSubmitAgain ? [{ id: 'continue', labelKey: 'req_status_continue', primary: true }] : [],
      };
    case 'notfound':
      // With the form here (Review) the original can be sent again under the same key. On Home (after a restart) it cannot: only the key survived, so the text says the request may
      // still arrive, that it cannot be sent again from here, and that a NEW request could duplicate it. The actions are only Check status and Dismiss.
      return { titleKey: 'req_unconfirmed_title', bodyKey: canSubmitAgain ? 'req_status_not_found' : 'req_pending_not_found', noteKey, actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, second] };
    case 'failed':
      return { titleKey: 'req_unconfirmed_title', bodyKey: 'req_status_check_failed', noteKey, actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, second] };
    default:
      return { titleKey: 'req_unconfirmed_title', bodyKey: 'req_unconfirmed_body', noteKey, actions: [{ id: 'check', labelKey: 'req_check_status', primary: true }, second] };
  }
}
