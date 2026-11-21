// The words of an error, in the person's language. The app's own error messages (lib/api.js, lib/apiErrors.js) are written in English as a fallback and carry a `code`; this turns the
// ones the app wrote into the dictionary text, and leaves anything else alone: a message the SERVER sent (a refused field, "account locked") is shown as it arrived, because the app has
// no key for text it has not seen (translating server messages is a backend change).
//
//   errorText(err, t)             the translated text for an app-written error, else err.message
//   errorText(err, t, fallbackKey) ... and, when the error has no message at all, t(fallbackKey)
import { NETWORK_READ_MESSAGE, NETWORK_WRITE_MESSAGE, TIMEOUT_READ_MESSAGE, TIMEOUT_WRITE_MESSAGE } from './apiErrors';

// The messages the app itself writes (exact text), and the dictionary key of each.
export const KNOWN_MESSAGES = Object.freeze({
  [NETWORK_READ_MESSAGE]: 'err_network_read',
  [TIMEOUT_READ_MESSAGE]: 'net_load_timeout',
  [NETWORK_WRITE_MESSAGE]: 'err_network_write',
  [TIMEOUT_WRITE_MESSAGE]: 'err_timeout_write',
  'Could not reach the server. Please try again.': 'err_network_short',
  'The server took too long to answer. Please try again.': 'net_load_timeout',
  'Your session expired. Please log in again.': 'docs_err_session',
  'Please log in to continue.': 'err_not_signed_in',
  'Something went wrong. Please try again.': 'err_generic',
  'Upload failed. Please try again.': 'up_failed_generic',
  'No personal details for this account.': 'err_no_personal',
  'We could not complete sign-in. Please try again.': 'err_signin_incomplete',
});

// The same, by the error's own code, for an app-written error whose text was changed.
export const KNOWN_CODES = Object.freeze({ network: 'err_network_short', timeout: 'net_load_timeout', session_expired: 'docs_err_session', not_signed_in: 'err_not_signed_in' });

const own = (object, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

export function errorKey(err) {
  if (!err) return undefined;
  return own(KNOWN_MESSAGES, err.message) || own(KNOWN_CODES, err.code);
}

export function errorText(err, t, fallbackKey) {
  const key = errorKey(err);
  if (key) return t(key);
  const message = err && typeof err.message === 'string' ? err.message : '';
  if (message) return message;
  return fallbackKey ? t(fallbackKey) : '';
}
