import { sendFailure } from './otpErrors';

// The proof that a typed code is right, for the Firebase phone flow. Pure (the clock and the two Firebase steps are passed in), so every case is unit-tested; lib/usePhoneCode.js holds one.
//
// Firebase accepts a code ONCE. If it has accepted the code and the NEXT step (our server) then fails for want of a connection, trying again must not ask Firebase to check the same code a second
// time (it would refuse a code it already used, and the person would be told a right code is wrong). So the proof Firebase returned (its ID token) is kept, in memory only, for the very same
// code, for at most PROOF_MAX_AGE_MS (Firebase ID tokens live an hour). It is dropped when a new code is sent, never written anywhere and never sent by itself: it is handed out only when the
// person presses Verify again. Nothing here sends an SMS or retries a step on its own, and the verification session (Firebase's confirmation handle) is the one the send produced: a network
// failure in `confirm` leaves it untouched, so the person can try the same code again as soon as the connection is back.
export const PROOF_MAX_AGE_MS = 50 * 60 * 1000;

export function createProofKeeper({ now = () => Date.now(), maxAgeMs = PROOF_MAX_AGE_MS } = {}) {
  let accepted = null; // { code, token, at }
  return {
    forget() { accepted = null; },
    // `pending`: the promise of Firebase's confirmation handle (the SMS that was sent). `confirm(confirmation, code)`: asks Firebase to check the code (it has its own time limit).
    async prove(code, { pending, confirm }) {
      if (accepted && accepted.code === code && now() - accepted.at < maxAgeMs) return accepted.token;
      let confirmation;
      try {
        confirmation = await pending;
      } catch (err) {
        throw sendFailure(err); // the SMS was never sent: say what really happened, never "this code is no longer valid"
      }
      if (!confirmation) throw sendFailure(null);
      const token = await confirm(confirmation, code);
      accepted = { code, token, at: now() };
      return token;
    },
    // For tests.
    hasProof: () => accepted !== null,
  };
}
