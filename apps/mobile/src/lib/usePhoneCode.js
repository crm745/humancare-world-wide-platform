import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext';
import { errorText } from './errorText';
import { apiPost } from './api';
import { confirmPhoneCode, sendPhoneCode } from './phoneAuth';
import { createProofKeeper } from './phoneProof';

// For every code screen. `step` is what the previous screen stored via authFlow.
//
// When the backend says phoneVerification === "firebase", the app sends the SMS itself
// through Firebase as soon as the screen opens, and `proof(code)` turns the typed code
// into Firebase's ID token. Otherwise the backend has already sent the code and the
// typed code is the proof. Either way the screen just does:
//   apiPost(url, { ticket, ...(await proof(code)) })
export function usePhoneCode(step) {
  const { toast, t } = useApp();
  const isFirebase = step?.phoneVerification === 'firebase';
  const phoneNumber = step?.phoneNumber;
  const ticket = step?.ticket;
  const pending = useRef(null); // the latest send (a promise of Firebase's confirmation handle)
  const [keeper] = useState(() => createProofKeeper()); // the proof of a code Firebase accepted (lib/phoneProof.js)
  const inFlight = useRef(null); // the send that is still running: a second request for one while it runs gets the SAME one (never a second SMS)
  const started = useRef(false);

  // The send has its own time limit (lib/phoneAuthTimeout.js): it ends with an error instead of waiting for ever. A handle from an earlier send that arrives late is never used: only `pending.current`,
  // the latest send, is.
  const send = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    keeper.forget(); // a new code is being sent: the old proof belongs to the old code
    const attempt = sendPhoneCode(phoneNumber);
    pending.current = attempt;
    const done = () => { if (inFlight.current === attempt) inFlight.current = null; };
    inFlight.current = attempt;
    attempt.then(done, done);
    return attempt;
  }, [phoneNumber, keeper]);

  // Send once when the screen opens. The ref keeps React's development double-run of
  // effects from sending two SMS.
  useEffect(() => {
    if (!isFirebase || started.current) return;
    started.current = true;
    send().catch((err) => toast(err.messageKey ? t(err.messageKey) : errorText(err, t)));
  }, [isFirebase, send, toast, t]);

  const proof = useCallback(async (code) => {
    if (!isFirebase) return { code };
    return { firebaseIdToken: await keeper.prove(code, { pending: pending.current, confirm: confirmPhoneCode }) };
  }, [isFirebase, keeper]);

  const resend = useCallback(
    () => (isFirebase ? send() : apiPost('/auth/otp/resend', { ticket })),
    [isFirebase, send, ticket],
  );

  return { proof, resend };
}
