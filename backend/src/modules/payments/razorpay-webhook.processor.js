// The Razorpay webhook EVENT PROCESSOR: takes an inbox event a worker has claimed and applies it through the payment store, in ONE transaction that also
// records the inbox result. It connects three things that already exist and adds no payment rule of its own:
//   razorpay-webhook.inbox.store.js    claim / lease / fenced result / retry (Step 3)         -> holdLease, writeResult, retryOrFail, claim, findDueIds
//   razorpay-payment.store.js          guarded, invoice-first, current-read payment updates (Step 4)
//   razorpay-config.js                 the configured environment identifier
// It is NOT registered as a recurring job (processBatch is the entry point a later step will schedule). It never calls Razorpay, never logs, and never
// copies a webhook field into an audit record: the payment store writes the audit, from allow-listed fields it validated itself.
//
// ONE TRANSACTION PER EVENT, in this order (never reversed):
//   1. holdLease   lock the inbox row and confirm THIS worker's lease is still live. A worker that lost its lease stops here and changes nothing.
//   2. the store   invoice row, then payment row(s) (current reads), the guarded update and its audit/flags.
//   3. writeResult the fenced inbox result (processed | ignored | received-for-retry), in the SAME transaction. It affects exactly one row or the whole
//                  transaction is rolled back, so a payment change can never commit without the inbox result, nor a result without the change, and a
//                  worker whose lease ran out DURING the work cannot apply anything.
// An exception rolls everything back; the claim then records a retry (or the final failure) with a short code, outside the transaction, again fenced.
//
// WHAT EACH EVENT DOES
//   payment.captured   completes the matching pending payment (or a failed/cancelled one: late capture, flagged), idempotent per gateway payment id.
//   payment.failed     records one failed ATTEMPT (audit only); the payment stays pending and nothing about the invoice changes.
//   refund.processed   marks an EXISTING pending refund completed.   refund.failed   marks it failed. No refund row is ever created.
//   order.paid         reconciliation only: audit evidence and flags, never a payment change.
//
// WAITING, BOUNDED: an order or a refund that does not exist YET (the event overtook the commit that attaches the order / creates the refund row), a refund
// whose original capture has not been applied yet, and an order.paid whose capture has not been applied yet are all retried through the inbox for
// WAIT_ATTEMPTS claims (1, 2, 3, 4 minutes apart: about ten minutes). Nothing is written or flagged while waiting. On the last attempt the store flags
// what is flagged-worthy (an unknown refund of a known payment, an uncaptured paid order, ...); an order unknown on the last attempt is ignored QUIETLY:
// it almost certainly belongs to another environment that shares the Razorpay account, and no alert is raised for that.
const paymentStore = require('./razorpay-payment.store');
const inboxStore = require('./razorpay-webhook.inbox.store');
const { paymentsEnvironmentId } = require('./razorpay-config');

const WAIT_ATTEMPTS = 5; // claims an event may wait for a missing order / row / capture before the outcome is final
const WORKER_BATCH = 10;
// Waiting for a row lock is normal here (the invoice lock serializes writers); Prisma's 5 s default would abort a transaction that is merely queued.
const TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10000, timeout: 30000 });

class LeaseLost extends Error { constructor() { super('lease lost'); this.name = 'LeaseLost'; } }
class InvalidEvent extends Error { constructor(code) { super(code); this.name = 'InvalidEvent'; this.code = code; } }

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- reading the stored (allow-listed) payload; every field is validated again here and again by the store -------------------------------------------
function section(payload, name) {
  if (!isObject(payload) || !isObject(payload[name])) throw new InvalidEvent('invalid_payload');
  return payload[name];
}

// The event is applied by what the claim says it is AND what the stored payload says it is: both must agree.
function requireSameEvent(claim) {
  if (!isObject(claim.payload) || claim.payload.event !== claim.eventType) throw new InvalidEvent('invalid_payload');
}

// ---- outcome -> inbox result ---------------------------------------------------------------------------------------------------------------------------
const CLEAN = new Set(['completed', 'duplicate_capture', 'already_completed', 'already_failed', 'failed', 'attempt_recorded', 'order_paid_recorded']);
const WAITABLE = new Set(['unknown_order', 'unknown_refund', 'original_not_completed', 'order_paid_pending_capture']);

// What the inbox row becomes. `waiting` is true for an outcome that a later attempt may resolve and that is not yet final.
function decide(outcome, flagged, claim) {
  const final = claim.attempts >= WAIT_ATTEMPTS;
  if (WAITABLE.has(outcome) && !final) {
    return { status: 'received', lastError: `awaiting_${outcome}`, delaySeconds: inboxStore.retryDelaySeconds(claim.attempts), waiting: true };
  }
  if (outcome === 'quarantined') return { status: 'ignored', lastError: 'quarantined_invalid_time', delaySeconds: 0 }; // D3: flagged by the store, never completed
  if (CLEAN.has(outcome)) return { status: 'processed', lastError: flagged ? 'flagged_for_operations' : null, delaySeconds: 0 };
  // Everything else is an inconsistency or an unknown the store has dealt with: a flagged one is handled (an Operations flag exists), an unflagged one is
  // ignored quietly (an order or refund of another environment).
  return { status: flagged ? 'processed' : 'ignored', lastError: outcome, delaySeconds: 0 };
}

// ---- applying one event (inside the transaction) -------------------------------------------------------------------------------------------------------
async function apply(tx, claim, payments) {
  requireSameEvent(claim);
  const final = claim.attempts >= WAIT_ATTEMPTS;
  const { eventType, payload } = claim;
  const when = typeof payload.occurredAt === 'string' ? payload.occurredAt : null; // D3: the validated Razorpay event time, or null (quarantined by the store)

  switch (eventType) {
    case 'payment.captured': {
      const p = section(payload, 'payment');
      if (p.status !== 'captured') throw new InvalidEvent('payment_status_mismatch');
      return payments.completePaymentFromCapture(tx, { razorpayOrderId: p.orderId, razorpayPaymentId: p.id, amountMinor: p.amount, currency: p.currency, transactedAt: when, eventType });
    }
    case 'payment.failed': {
      const p = section(payload, 'payment');
      if (p.status !== 'failed') throw new InvalidEvent('payment_status_mismatch');
      return payments.recordPaymentAttemptFailed(tx, { razorpayOrderId: p.orderId, razorpayPaymentId: p.id, amountMinor: p.amount, currency: p.currency, eventType });
    }
    case 'refund.processed':
    case 'refund.failed': {
      const r = section(payload, 'refund');
      const completed = eventType === 'refund.processed';
      if (r.status !== (completed ? 'processed' : 'failed')) throw new InvalidEvent('refund_status_mismatch');
      const input = { razorpayRefundId: r.id, razorpayPaymentId: r.paymentId, amountMinor: r.amount, currency: r.currency, transactedAt: when, eventType };
      return completed ? payments.completeRefund(tx, input, { final }) : payments.failRefund(tx, input, { final });
    }
    case 'order.paid': {
      const o = section(payload, 'order');
      return payments.recordOrderPaid(tx, { razorpayOrderId: o.id, amountMinor: o.amountPaid, eventType }, { final });
    }
    default:
      throw new InvalidEvent('unsupported_event');
  }
}

/**
 * Processes ONE claimed event. Resolves { status, code, outcome }:
 *   status 'processed' | 'ignored' | 'received' (waiting / retry) | 'failed' (final) | 'lease_lost' (nothing written) | 'unrecorded' (the result could
 *   not even be written; the lease will expire and the event be recovered).
 * `claim` is what inboxStore.claim returned. `db` is the Prisma client.
 */
async function processClaim(db, claim, { env = process.env, deps = {} } = {}) {
  const payments = deps.payments || paymentStore;
  const inbox = deps.inbox || inboxStore;

  // The environment identifier must be configured (the receiver would not have accepted the event otherwise). If it is not, nothing is applied: a retry.
  if (!paymentsEnvironmentId(env)) return recordError(db, inbox, claim, 'environment_not_configured');

  let decision;
  let outcome;
  try {
    ({ decision, outcome } = await db.$transaction(async (tx) => {
      if (!(await inbox.holdLease(tx, claim))) throw new LeaseLost();
      const result = await apply(tx, claim, payments);
      const verdict = decide(result.outcome, result.flagged === true, claim);
      const written = await inbox.writeResult(tx, claim, verdict);
      if (written !== 1) throw new LeaseLost(); // the lease ran out while working: roll the payment change back too
      return { decision: verdict, outcome: result.outcome };
    }, TRANSACTION_OPTIONS));
  } catch (err) {
    if (err instanceof LeaseLost) return { status: 'lease_lost', code: null, outcome: null };
    if (err instanceof InvalidEvent || err instanceof RangeError) {
      const code = err instanceof InvalidEvent ? err.code : 'invalid_payload';
      return recordResult(db, inbox, claim, { status: 'ignored', lastError: code, delaySeconds: 0 }, null);
    }
    return recordError(db, inbox, claim, 'processing_error'); // the transaction rolled back; schedule the retry (or the final failure)
  }
  return { status: decision.status, code: decision.lastError, outcome };
}

// Writes a result outside the main transaction (fenced). 0 rows = the lease was lost.
async function recordResult(db, inbox, claim, verdict, outcome) {
  try {
    const written = await inbox.writeResult(db, claim, verdict);
    return written === 1 ? { status: verdict.status, code: verdict.lastError, outcome } : { status: 'lease_lost', code: null, outcome: null };
  } catch {
    return { status: 'unrecorded', code: 'result_not_recorded', outcome: null };
  }
}

async function recordError(db, inbox, claim, code) {
  try {
    const r = await inbox.retryOrFail(db, claim, { code });
    if (r.written !== 1) return { status: 'lease_lost', code: null, outcome: null };
    return { status: r.status, code, outcome: null };
  } catch {
    return { status: 'unrecorded', code, outcome: null };
  }
}

/**
 * One worker pass (NOT scheduled anywhere yet): returns expired leases to the queue, takes up to `limit` due Razorpay events, claims each and processes it.
 * Resolves a tally by status. Errors of the queue queries themselves propagate to the caller (the job runner); an error inside one event never stops the others.
 */
async function processBatch(db, { workerId, limit = WORKER_BATCH, leaseSeconds, env = process.env, deps = {} } = {}) {
  const inbox = deps.inbox || inboxStore;
  const tally = { claimed: 0, skipped: 0, recovered: await inbox.recoverExpiredLeases(db) };
  const ids = await inbox.findDueIds(db, limit);
  for (const id of ids) {
    const claim = await inbox.claim(db, { id, workerId, ...(leaseSeconds && { leaseSeconds }) });
    if (!claim) { tally.skipped += 1; continue; }
    tally.claimed += 1;
    const result = await processClaim(db, claim, { env, deps });
    tally[result.status] = (tally[result.status] || 0) + 1;
  }
  return tally;
}

module.exports = { processClaim, processBatch, decide, WAIT_ATTEMPTS, WORKER_BATCH };
