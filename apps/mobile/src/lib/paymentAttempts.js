// A payment attempt, remembered on the phone so a retry — after a timeout, or after the app was closed — reuses the
// SAME Idempotency-Key and so can never create a second order (see backend payment-orders.service.js: the key is the
// only thing that makes "create the order" safe to repeat).
//
// One record per invoice, in AsyncStorage (it holds no secret: a random key, ids and a few words):
//   { key, requestId, phase, paymentId, baselineBalance, hint, startedAt }
//   phase  'creating'   the key exists; the order request may or may not have reached the server
//          'order'      the server confirmed the order (paymentId known); Checkout not opened yet
//          'checkout'   Checkout was opened; the result must be confirmed from the invoice
//   hint   what the browser said on return ("submitted", "cancelled" ...). Informational only, never proof of payment.
//
// A NEW key is made only when there is no record: i.e. a new attempt. A timeout, a 5xx, an app restart: the record is
// still there, so the same key is used again. The record is removed only when the attempt is over (paid, failed,
// closed by the server, or refused for good).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const PREFIX = 'hc_payment_attempt:';
// The backend accepts /^[A-Za-z0-9_-]{16,64}$/.
export const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const attemptKeyFor = (invoiceId) => `${PREFIX}${invoiceId}`;

export function newIdempotencyKey(uuid = () => Crypto.randomUUID()) {
  return `hc_${String(uuid()).replace(/-/g, '')}`;
}

function parse(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && KEY_PATTERN.test(value.key || '') ? value : null;
  } catch {
    return null; // an unreadable record is treated as "no record"
  }
}

export async function loadAttempt(invoiceId) {
  try {
    return parse(await AsyncStorage.getItem(attemptKeyFor(invoiceId)));
  } catch {
    return null;
  }
}

async function save(invoiceId, attempt) {
  await AsyncStorage.setItem(attemptKeyFor(invoiceId), JSON.stringify(attempt));
  return attempt;
}

/** The invoice's open attempt, or a brand new one. The record is SAVED before this resolves, so the key is on disk
 * before any network call uses it. If it cannot be saved this throws, and no order request is made with a key that
 * could be lost. */
export async function getOrCreateAttempt(invoiceId, { requestId = null, baselineBalance = null, uuid, now = Date.now } = {}) {
  const existing = await loadAttempt(invoiceId);
  if (existing) {
    if (requestId != null && existing.requestId == null) return save(invoiceId, { ...existing, requestId });
    return existing;
  }
  return save(invoiceId, {
    key: newIdempotencyKey(uuid), requestId, phase: 'creating', paymentId: null, baselineBalance, hint: null, startedAt: now(),
  });
}

export async function updateAttempt(invoiceId, patch) {
  const existing = await loadAttempt(invoiceId);
  if (!existing) return null;
  return save(invoiceId, { ...existing, ...patch });
}

export async function clearAttempt(invoiceId) {
  try {
    await AsyncStorage.removeItem(attemptKeyFor(invoiceId));
  } catch {
    /* nothing more can be done; a stale record is harmless: the server answers it with the closed payment's status */
  }
}
