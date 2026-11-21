// A time limit for the two Firebase phone-verification steps (sending the SMS, and confirming the code), so a hung reCAPTCHA, a stalled SMS request or a slow connection ends with a clear message
// instead of leaving the code screen waiting for ever. Pure (timers injectable), so it is unit-tested; lib/phoneAuth.web.js and lib/phoneAuth.native.js apply it.
//
// A limit only stops WAITING. It never repeats the step: nothing here sends a second SMS or confirms a second time, and the person decides whether to tap "Resend OTP".
// A step that finishes AFTER its limit is a LATE answer: it is dropped (the screen has already moved on, and the app never uses it), and a late failure is swallowed so it cannot surface as
// an unhandled error. The step's own clean-up (Firebase's own sign-in is dropped straight after the token is read) still runs, because the limit wraps the whole step, it does not cancel it.
export const PHONE_SEND_TIMEOUT_MS = 25000; // within the 20-30 s the app allows a phone step
export const PHONE_CONFIRM_TIMEOUT_MS = 25000;
export const PHONE_TIMEOUT_CODE = 'phone_timeout';

export const SEND_TIMEOUT_KEY = 'otp_send_timeout';
export const CONFIRM_TIMEOUT_KEY = 'otp_confirm_timeout';

export function phoneTimeoutError(messageKey, message) {
  return Object.assign(new Error(message), { code: PHONE_TIMEOUT_CODE, messageKey });
}
export const isPhoneTimeout = (err) => !!err && err.code === PHONE_TIMEOUT_CODE;

// Resolves or rejects like `promise`, unless `ms` pass first: then it rejects with the timeout error. `onLate(valueOrError, ok)` (optional) hears a step that finishes after the limit.
export function withPhoneTimeout(promise, { ms, messageKey, message, onLate, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(phoneTimeoutError(messageKey, message));
    }, ms);
    promise.then(
      (value) => { if (settled) { if (onLate) onLate(value, true); return; } settled = true; clearTimer(timer); resolve(value); },
      (error) => { if (settled) { if (onLate) onLate(error, false); return; } settled = true; clearTimer(timer); reject(error); },
    );
  });
}

export const withSendTimeout = (promise, options = {}) => withPhoneTimeout(promise, {
  ms: PHONE_SEND_TIMEOUT_MS, messageKey: SEND_TIMEOUT_KEY, message: 'The code could not be sent in time. Tap "Resend OTP" to try again.', ...options,
});
export const withConfirmTimeout = (promise, options = {}) => withPhoneTimeout(promise, {
  ms: PHONE_CONFIRM_TIMEOUT_MS, messageKey: CONFIRM_TIMEOUT_KEY, message: "We couldn't check the code in time. Check your connection and try again.", ...options,
});
