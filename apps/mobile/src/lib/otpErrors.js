// What a failed code check or code send MEANS, told apart so the person is never told something untrue. Pure (no React), so it is unit-tested; components/OtpScreen.js shows it.
//
//   invalid    the code was wrong                      the typed code stays, so one digit can be fixed
//   expired    the code ran out                        a new code is needed (Resend OTP): the typed code is cleared
//   locked     too many wrong tries                    a new code is needed: cleared
//   session    the step itself expired                 start again: cleared
//   missing    the code's session is really gone       a new code is needed: cleared
//   not_sent   the SMS never went out (the send failed or timed out)   Resend OTP; the typed code stays
//   network    no internet / no answer                 NOTHING is wrong with the code: it stays, and the person tries again when the connection is back
//   timeout    no answer in time                       the same: the code stays
//   server     our server failed (5xx)                 the same: the code stays
//   other      anything else                           the error's own text, in a toast; the code stays
// "This code is no longer valid" is said ONLY for a code the server or Firebase actually refused as expired or missing, never because the connection failed.
export const TRANSIENT_KINDS = Object.freeze(['network', 'timeout', 'server', 'not_sent']); // the failure is not about the code: it can be retried as it is

export function classifyOtpError(err) {
  const code = err && err.code;
  const status = Number(err && err.status);
  switch (code) {
    case 'otp_invalid': return { kind: 'invalid', literal: 'Incorrect code. Please try again.', keepCode: true };
    case 'otp_expired': return { kind: 'expired', literal: 'This code has expired. Request a new one with "Resend OTP".', keepCode: false };
    case 'otp_locked': return { kind: 'locked', literal: 'Too many incorrect attempts. Request a new code with "Resend OTP".', keepCode: false };
    case 'otp_missing': return { kind: 'missing', literal: 'This code is no longer valid. Request a new one with "Resend OTP".', keepCode: false };
    case 'ticket_invalid': return { kind: 'session', literal: 'This step has expired. Go back and start again.', keepCode: false };
    case 'otp_not_sent': return { kind: 'not_sent', key: 'otp_err_not_sent', keepCode: true };
    case 'phone_timeout': return { kind: 'timeout', key: err.messageKey || 'otp_err_timeout', keepCode: true };
    case 'timeout': return { kind: 'timeout', key: 'otp_err_timeout', keepCode: true };
    case 'network': return { kind: 'network', key: 'otp_err_network', keepCode: true };
    default:
      if (status >= 500) return { kind: 'server', key: 'otp_err_server', keepCode: true };
      return { kind: 'other', keepCode: true };
  }
}

export const isTransientOtpKind = (kind) => TRANSIENT_KINDS.includes(kind);

// What a failed SEND becomes when the person then presses Verify. There is no verification session without a sent code, so trying the same code again cannot help: the true message is that the
// code was not sent (a send that timed out keeps its own message, which says so), and Resend OTP is the way on. Never "this code is no longer valid".
export function sendFailure(err) {
  const code = err && err.code;
  if (code === 'phone_timeout') return err;
  if (code === 'otp_throttled' || code === 'invalid_phone' || code === 'sms_not_allowed' || code === 'phone_auth_not_configured') return err; // these say their own, true thing
  return Object.assign(new Error('The code could not be sent. Tap "Resend OTP" to try again.'), { code: 'otp_not_sent' });
}
