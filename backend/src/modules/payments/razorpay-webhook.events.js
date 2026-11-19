// Validation and ALLOW-LIST of a Razorpay webhook event, for the receiver. Pure: no database, no network, no logging.
//
// The payload that is stored is BUILT FROM SCRATCH out of a few validated fields; nothing is copied from the request. So nothing that is not
// listed here can ever be stored: no e-mail, phone, card, UPI/VPA, bank or wallet detail, no error description, no notes, no raw body, no
// signature. What is kept:
//   payment.captured / payment.failed   payment id, order id, amount (integer, smallest currency unit), currency, status
//   refund.processed / refund.failed    refund id, payment id, amount, currency, status
//   order.paid                          order id, amount paid
//   every event                         the event name, the validated occurrence time (or null), the SHA-256 of the raw body (a fingerprint,
//                                       never the body), and where the event identity came from
//
// Three outcomes for a signed, parsed envelope:
//   { malformed: true, code }  it is not an event envelope at all (no usable event name): the receiver answers 400
//   status "received"          a supported event whose required fields are all valid: the worker will apply it
//   status "ignored"           an unsupported event name ("unsupported_event"), or a supported one whose fields are not what we can use
//                              ("invalid_payload"): stored for reconciliation, answered 200, never retried
const SUPPORTED_EVENTS = Object.freeze(['payment.captured', 'payment.failed', 'refund.processed', 'refund.failed', 'order.paid']);

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,60}$/;
const ORDER_ID = /^order_[A-Za-z0-9]{1,58}$/;
const REFUND_ID = /^rfnd_[A-Za-z0-9]{1,60}$/;
const CURRENCY = /^[A-Z]{3}$/;
const STATUS = /^[a-z_]{1,24}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveAmount = (value) => Number.isSafeInteger(value) && value > 0;

// The event's own time (top-level created_at, whole seconds since the epoch) as a Date, or null when it is missing or not credible.
function occurrenceTime(envelope) {
  const seconds = envelope.created_at;
  if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds > 4_102_444_800) return null; // 2001 .. 2100
  return new Date(seconds * 1000);
}

// The nested entity of a payload ({ payload: { payment: { entity: {...} } } }), or null.
function entityOf(envelope, name) {
  const payload = envelope.payload;
  const holder = isObject(payload) ? payload[name] : null;
  return isObject(holder) && isObject(holder.entity) ? holder.entity : null;
}

function paymentFields(envelope) {
  const e = entityOf(envelope, 'payment');
  if (!e) return null;
  if (typeof e.id !== 'string' || !PAYMENT_ID.test(e.id)) return null;
  if (typeof e.order_id !== 'string' || !ORDER_ID.test(e.order_id)) return null; // every HumanCare payment belongs to an order
  if (!positiveAmount(e.amount)) return null;
  if (typeof e.currency !== 'string' || !CURRENCY.test(e.currency)) return null;
  if (typeof e.status !== 'string' || !STATUS.test(e.status)) return null;
  return { id: e.id, orderId: e.order_id, amount: e.amount, currency: e.currency, status: e.status };
}

function refundFields(envelope) {
  const e = entityOf(envelope, 'refund');
  if (!e) return null;
  if (typeof e.id !== 'string' || !REFUND_ID.test(e.id)) return null;
  if (typeof e.payment_id !== 'string' || !PAYMENT_ID.test(e.payment_id)) return null;
  if (!positiveAmount(e.amount)) return null;
  if (typeof e.currency !== 'string' || !CURRENCY.test(e.currency)) return null;
  if (typeof e.status !== 'string' || !STATUS.test(e.status)) return null;
  return { id: e.id, paymentId: e.payment_id, amount: e.amount, currency: e.currency, status: e.status };
}

function orderFields(envelope) {
  const e = entityOf(envelope, 'order');
  if (!e) return null;
  if (typeof e.id !== 'string' || !ORDER_ID.test(e.id)) return null;
  if (!Number.isSafeInteger(e.amount_paid) || e.amount_paid < 0) return null;
  return { id: e.id, amountPaid: e.amount_paid };
}

/**
 * @param envelope    the parsed JSON of a SIGNED request body
 * @param context     { bodySha256, eventIdSource }  both are fingerprints / provenance, never request content
 */
function classifyEvent(envelope, { bodySha256, eventIdSource }) {
  if (!isObject(envelope)) return { malformed: true, code: 'envelope_not_object' };
  const eventType = envelope.event;
  if (typeof eventType !== 'string' || !EVENT_NAME.test(eventType)) return { malformed: true, code: 'event_name_invalid' };

  const occurredAt = occurrenceTime(envelope);
  const base = { event: eventType, occurredAt: occurredAt ? occurredAt.toISOString() : null, bodySha256, eventIdSource };
  const ignored = (lastError) => ({ eventType, status: 'ignored', lastError, entityType: null, entityId: null, occurredAt, payload: base });

  if (!SUPPORTED_EVENTS.includes(eventType)) return ignored('unsupported_event');

  if (eventType === 'payment.captured' || eventType === 'payment.failed') {
    const payment = paymentFields(envelope);
    if (!payment) return ignored('invalid_payload');
    return { eventType, status: 'received', lastError: null, entityType: 'order', entityId: payment.orderId, occurredAt, payload: { ...base, payment } };
  }
  if (eventType === 'refund.processed' || eventType === 'refund.failed') {
    const refund = refundFields(envelope);
    if (!refund) return ignored('invalid_payload');
    return { eventType, status: 'received', lastError: null, entityType: 'refund', entityId: refund.id, occurredAt, payload: { ...base, refund } };
  }
  const order = orderFields(envelope); // order.paid
  if (!order) return ignored('invalid_payload');
  return { eventType, status: 'received', lastError: null, entityType: 'order', entityId: order.id, occurredAt, payload: { ...base, order } };
}

module.exports = { classifyEvent, SUPPORTED_EVENTS };
