// Pure rules for sending a request and its report files (no React, no native modules), so they can
// be unit-tested.
//
// The request and its files are two steps: POST /requests, then one upload per file. The request
// is saved by the first step whatever happens to the second, so a failed file must never be
// treated as sent and a retry must never create a second request. This keeps three things in the
// draft (the form's own state, so the answers and the chosen files are never cleared by it):
//   sentRequest   { id, referenceNumber, title } once the request is saved, else null
//   uploaded      the `uri` of every file the server accepted
//   uploadErrors  { uri: message } for the files that failed on the last attempt

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

// Saves the request if that has not happened yet, then uploads every file not yet accepted, one at
// a time: a failure on one file never stops the others. Resolves the new upload state. Throws only
// if the request itself could not be saved (nothing is then marked as sent).
//   createRequest()          -> { id, referenceNumber, title }  (called at most once, and never again once saved)
//   upload(file, onProgress, sentRequest) -> resolves when the server has the file, throws when it has not
//   onSent(state)            -> called right after the request is saved, before any file is sent
//   onProgress({ index, total, progress })
export async function runSubmission({ sentRequest, uploaded, uploadErrors, files, createRequest, upload, onSent, onProgress }) {
  let sent = sentRequest || null;
  const accepted = sent ? [...(uploaded || [])] : [];
  const errors = sent ? { ...(uploadErrors || {}) } : {};
  if (!sent) {
    sent = await createRequest();
    onSent?.({ sentRequest: sent, uploaded: accepted, uploadErrors: errors });
  }

  const todo = pendingFiles(files, accepted);
  const failed = {};
  for (let i = 0; i < todo.length; i += 1) {
    const file = todo[i];
    const report = (progress) => onProgress?.({ index: i + 1, total: todo.length, progress });
    report(0);
    try {
      await upload(file, report, sent);
      accepted.push(file.uri);
    } catch (err) {
      failed[file.uri] = (err && err.message) || 'Upload failed. Please try again.';
    }
  }
  return { sentRequest: sent, uploaded: accepted, uploadErrors: failed };
}
