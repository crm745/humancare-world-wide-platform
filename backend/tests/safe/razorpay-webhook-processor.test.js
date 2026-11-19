/* global describe, test, expect, jest */
// The Razorpay event processor, with injected fakes for the payment store and the inbox store: how each event is mapped onto the store, how every store
// outcome becomes an inbox result, the bounded waiting, the environment check, lease fencing, atomicity (payment change + inbox result commit or roll back
// together), error handling, and the batch pass. No database, no network.
const fs = require('fs');
const path = require('path');
const processor = require('../../src/modules/payments/razorpay-webhook.processor');
const inboxStore = require('../../src/modules/payments/razorpay-webhook.inbox.store');

const ENV = { PAYMENTS_ENVIRONMENT_ID: 'test' };
const T = '2026-11-20T10:00:00.000Z';

const claimOf = (eventType, extra = {}, over = {}) => {
  const payloads = {
    'payment.captured': { payment: { id: 'pay_P1', orderId: 'order_O1', amount: 150000, currency: 'INR', status: 'captured' } },
    'payment.failed': { payment: { id: 'pay_P1', orderId: 'order_O1', amount: 150000, currency: 'INR', status: 'failed' } },
    'refund.processed': { refund: { id: 'rfnd_R1', paymentId: 'pay_P1', amount: 50000, currency: 'INR', status: 'processed' } },
    'refund.failed': { refund: { id: 'rfnd_R1', paymentId: 'pay_P1', amount: 50000, currency: 'INR', status: 'failed' } },
    'order.paid': { order: { id: 'order_O1', amountPaid: 150000 } },
  };
  return { id: 1, workerId: 'W1', attempts: 1, eventType, externalEventId: 'evt_1', payload: { event: eventType, occurredAt: T, bodySha256: 'a'.repeat(64), ...payloads[eventType], ...extra }, ...over };
};

// An in-memory "world" that a transaction can change and that rolls back when the transaction throws.
function makeWorld({ leaseLive = true, writeCount = 1, storeResult = { outcome: 'completed', flagged: false } } = {}) {
  const world = { committed: [], staged: null, calls: [], txOptions: [], results: [], leaseLive, writeCount, storeResult };
  const db = {
    $transaction: jest.fn(async (fn, options) => {
      world.txOptions.push(options);
      world.staged = [];
      try {
        const out = await fn({ id: 'tx' });
        world.committed.push(...world.staged);
        return out;
      } finally { world.staged = null; }
    }),
  };
  const stage = (what) => { if (world.staged) world.staged.push(what); else world.committed.push(what); };
  const result = () => (typeof world.storeResult === 'function' ? world.storeResult() : world.storeResult);
  const op = (name) => jest.fn(async (tx, input, options) => { world.calls.push({ name, tx, input, options }); stage(`payment:${name}`); return result(); });
  const payments = {
    completePaymentFromCapture: op('completePaymentFromCapture'), recordPaymentAttemptFailed: op('recordPaymentAttemptFailed'), recordOrderPaid: op('recordOrderPaid'),
    completeRefund: op('completeRefund'), failRefund: op('failRefund'),
  };
  const inbox = {
    retryDelaySeconds: inboxStore.retryDelaySeconds,
    holdLease: jest.fn(async (tx) => { world.calls.push({ name: 'holdLease', tx }); return world.leaseLive; }),
    writeResult: jest.fn(async (tx, claim, verdict) => { world.calls.push({ name: 'writeResult', tx, verdict }); if (world.writeCount === 1) stage(`inbox:${verdict.status}`); return world.writeCount; }),
    retryOrFail: jest.fn(async (db2, claim, { code }) => { world.calls.push({ name: 'retryOrFail', tx: db2, code }); return { status: claim.attempts >= 8 ? 'failed' : 'received', delaySeconds: 60, written: 1 }; }),
    recoverExpiredLeases: jest.fn(async () => ({ failed: 0, again: 1 })),
    findDueIds: jest.fn(async () => []),
    claim: jest.fn(async () => null),
  };
  return { world, db, deps: { payments, inbox }, payments, inbox };
}
const run = (w, claim, env = ENV) => processor.processClaim(w.db, claim, { env, deps: w.deps });
const verdictOf = (w) => w.world.calls.find((c) => c.name === 'writeResult').verdict;

describe('mapping each event onto the payment store', () => {
  test('payment.captured: order, gateway id, amount, currency and the VALIDATED event time are passed; nothing else', async () => {
    const w = makeWorld();
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect(w.payments.completePaymentFromCapture).toHaveBeenCalledWith(expect.anything(), {
      razorpayOrderId: 'order_O1', razorpayPaymentId: 'pay_P1', amountMinor: 150000, currency: 'INR', transactedAt: T, eventType: 'payment.captured',
    });
  });
  test('payment.failed records an attempt through its own operation; it never calls the completion', async () => {
    const w = makeWorld({ storeResult: { outcome: 'attempt_recorded', flagged: false } });
    expect(await run(w, claimOf('payment.failed'))).toMatchObject({ status: 'processed', outcome: 'attempt_recorded' });
    expect(w.payments.recordPaymentAttemptFailed).toHaveBeenCalledWith(expect.anything(), { razorpayOrderId: 'order_O1', razorpayPaymentId: 'pay_P1', amountMinor: 150000, currency: 'INR', eventType: 'payment.failed' });
    for (const fn of ['completePaymentFromCapture', 'completeRefund', 'failRefund', 'recordOrderPaid']) expect(w.payments[fn]).not.toHaveBeenCalled();
  });
  test('refund.processed completes and refund.failed fails an existing refund; the final flag follows the attempt number', async () => {
    const a = makeWorld({ storeResult: { outcome: 'completed', flagged: false } });
    await run(a, claimOf('refund.processed'));
    expect(a.payments.completeRefund).toHaveBeenCalledWith(expect.anything(), { razorpayRefundId: 'rfnd_R1', razorpayPaymentId: 'pay_P1', amountMinor: 50000, currency: 'INR', transactedAt: T, eventType: 'refund.processed' }, { final: false });
    const b = makeWorld({ storeResult: { outcome: 'failed', flagged: false } });
    await run(b, claimOf('refund.failed', {}, { attempts: 5 }));
    expect(b.payments.failRefund).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ razorpayRefundId: 'rfnd_R1' }), { final: true });
  });
  test('order.paid is reconciliation only: it calls recordOrderPaid and NEVER a completion', async () => {
    const w = makeWorld({ storeResult: { outcome: 'order_paid_recorded', flagged: false } });
    expect(await run(w, claimOf('order.paid'))).toMatchObject({ status: 'processed', outcome: 'order_paid_recorded' });
    expect(w.payments.recordOrderPaid).toHaveBeenCalledWith(expect.anything(), { razorpayOrderId: 'order_O1', amountMinor: 150000, eventType: 'order.paid' }, { final: false });
    for (const fn of ['completePaymentFromCapture', 'completeRefund', 'failRefund', 'recordPaymentAttemptFailed']) expect(w.payments[fn]).not.toHaveBeenCalled();
  });
  test('a missing or invalid event time is passed on as null: the store quarantines it, the processor never invents one (D3)', async () => {
    const w = makeWorld({ storeResult: { outcome: 'quarantined', flagged: true } });
    const claim = claimOf('payment.captured', { occurredAt: null });
    expect(await run(w, claim)).toMatchObject({ status: 'ignored', code: 'quarantined_invalid_time' });
    expect(w.payments.completePaymentFromCapture.mock.calls[0][1].transactedAt).toBeNull();
    const x = makeWorld({ storeResult: { outcome: 'quarantined', flagged: true } });
    const odd = claimOf('refund.processed', { occurredAt: 12345 });
    await run(x, odd);
    expect(x.payments.completeRefund.mock.calls[0][1].transactedAt).toBeNull();
  });
});

describe('every store outcome becomes the right inbox result', () => {
  test.each([
    ['completed', false, 'processed', null],
    ['completed', true, 'processed', 'flagged_for_operations'], // overpayment
    ['duplicate_capture', false, 'processed', null],
    ['late_capture', true, 'processed', 'late_capture'],
    ['different_payment_id', true, 'processed', 'different_payment_id'],
    ['amount_mismatch', true, 'processed', 'amount_mismatch'],
    ['currency_mismatch', true, 'processed', 'currency_mismatch'],
    ['reference_conflict', true, 'processed', 'reference_conflict'],
    ['quarantined', true, 'ignored', 'quarantined_invalid_time'],
  ])('payment.captured: %s (flagged %s) -> %s', async (outcome, flagged, status, code) => {
    const w = makeWorld({ storeResult: { outcome, flagged } });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status, code });
    expect(verdictOf(w)).toMatchObject({ status, lastError: code, delaySeconds: 0 });
  });
  test.each([
    ['completed', 'processed', null], ['already_completed', 'processed', null], ['already_failed', 'processed', null],
    ['refund_exceeds_payment', 'processed', 'refund_exceeds_payment'], ['state_conflict', 'processed', 'state_conflict'], ['amount_mismatch', 'processed', 'amount_mismatch'],
  ])('refund.processed: %s -> %s', async (outcome, status, code) => {
    const w = makeWorld({ storeResult: { outcome, flagged: code !== null } });
    expect(await run(w, claimOf('refund.processed'))).toMatchObject({ status, code });
  });
  test('an unknown order WAITS: attempts 1-4 go back to "received" with a growing delay, and nothing is flagged', async () => {
    for (const [attempts, delay] of [[1, 60], [2, 120], [3, 180], [4, 240]]) {
      const w = makeWorld({ storeResult: { outcome: 'unknown_order', flagged: false } });
      expect(await run(w, claimOf('payment.captured', {}, { attempts }))).toMatchObject({ status: 'received', code: 'awaiting_unknown_order' });
      expect(verdictOf(w)).toMatchObject({ status: 'received', delaySeconds: delay });
    }
  });
  test('an order still unknown on the LAST attempt is ignored quietly (another environment): no alert, no failure', async () => {
    const w = makeWorld({ storeResult: { outcome: 'unknown_order', flagged: false } });
    expect(await run(w, claimOf('payment.captured', {}, { attempts: processor.WAIT_ATTEMPTS }))).toMatchObject({ status: 'ignored', code: 'unknown_order' });
  });
  test('a refund that overtook its row waits; on the last attempt an unknown refund of a known payment is flagged (processed), of an unknown payment ignored', async () => {
    const wait = makeWorld({ storeResult: { outcome: 'unknown_refund', flagged: false } });
    expect(await run(wait, claimOf('refund.processed'))).toMatchObject({ status: 'received', code: 'awaiting_unknown_refund' });
    const flagged = makeWorld({ storeResult: { outcome: 'unknown_refund', flagged: true } });
    expect(await run(flagged, claimOf('refund.processed', {}, { attempts: 5 }))).toMatchObject({ status: 'processed', code: 'unknown_refund' });
    const quiet = makeWorld({ storeResult: { outcome: 'unknown_refund', flagged: false } });
    expect(await run(quiet, claimOf('refund.processed', {}, { attempts: 5 }))).toMatchObject({ status: 'ignored', code: 'unknown_refund' });
  });
  test('a refund whose capture is not applied yet, and an order.paid whose capture is not applied yet, wait as well', async () => {
    const a = makeWorld({ storeResult: { outcome: 'original_not_completed', flagged: false } });
    expect(await run(a, claimOf('refund.processed'))).toMatchObject({ status: 'received', code: 'awaiting_original_not_completed' });
    const b = makeWorld({ storeResult: { outcome: 'order_paid_pending_capture', flagged: false } });
    expect(await run(b, claimOf('order.paid'))).toMatchObject({ status: 'received', code: 'awaiting_order_paid_pending_capture' });
    const c = makeWorld({ storeResult: { outcome: 'order_paid_unreconciled', flagged: true } });
    expect(await run(c, claimOf('order.paid', {}, { attempts: 5 }))).toMatchObject({ status: 'processed', code: 'order_paid_unreconciled' });
  });
  test('the waiting bound is below the attempt cap, so a waiting event can never end as a hard failure', () => {
    expect(processor.WAIT_ATTEMPTS).toBeLessThan(inboxStore.MAX_ATTEMPTS);
  });
});

describe('invalid events are ignored, never applied', () => {
  test.each([
    ['status that is not captured', claimOf('payment.captured', { payment: { id: 'pay_P1', orderId: 'order_O1', amount: 1, currency: 'INR', status: 'authorized' } }), 'payment_status_mismatch'],
    ['failed event with a captured status', claimOf('payment.failed', { payment: { id: 'pay_P1', orderId: 'order_O1', amount: 1, currency: 'INR', status: 'captured' } }), 'payment_status_mismatch'],
    ['refund event with the wrong status', claimOf('refund.processed', { refund: { id: 'rfnd_R1', paymentId: 'pay_P1', amount: 1, currency: 'INR', status: 'failed' } }), 'refund_status_mismatch'],
    ['no payment section', claimOf('payment.captured', { payment: undefined }), 'invalid_payload'],
    ['payload for another event', { ...claimOf('payment.captured'), payload: { ...claimOf('payment.failed').payload } }, 'invalid_payload'],
    ['no payload', { ...claimOf('payment.captured'), payload: null }, 'invalid_payload'],
    ['an unsupported event name', { ...claimOf('payment.captured'), eventType: 'payment.authorized', payload: { event: 'payment.authorized' } }, 'unsupported_event'],
  ])('%s', async (_l, claim, code) => {
    const w = makeWorld();
    expect(await run(w, claim)).toMatchObject({ status: 'ignored', code });
    for (const fn of Object.values(w.payments)) expect(fn).not.toHaveBeenCalled();
    expect(w.inbox.writeResult).toHaveBeenCalledTimes(1);
    expect(w.inbox.writeResult.mock.calls[0][2]).toMatchObject({ status: 'ignored', lastError: code });
  });
  test('an argument error from the store (a malformed id) is an ignored invalid payload, not a retry', async () => {
    const w = makeWorld({ storeResult: () => { throw new RangeError('razorpayOrderId is not a valid Razorpay id'); } });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'ignored', code: 'invalid_payload' });
    expect(w.inbox.retryOrFail).not.toHaveBeenCalled();
  });
});

describe('environment', () => {
  test.each([[{}], [{ PAYMENTS_ENVIRONMENT_ID: '' }], [{ PAYMENTS_ENVIRONMENT_ID: 'Bad Value' }]])('an unconfigured environment (%j) applies nothing and schedules a retry', async (env) => {
    const w = makeWorld();
    expect(await run(w, claimOf('payment.captured'), env)).toMatchObject({ status: 'received', code: 'environment_not_configured' });
    expect(w.db.$transaction).not.toHaveBeenCalled();
    for (const fn of Object.values(w.payments)) expect(fn).not.toHaveBeenCalled();
    expect(w.inbox.retryOrFail).toHaveBeenCalledWith(w.db, expect.anything(), { code: 'environment_not_configured' });
  });
  test('an order of another environment is simply unknown locally: it waits briefly, then is ignored with no flag and no failure', async () => {
    const w = makeWorld({ storeResult: { outcome: 'unknown_order', flagged: false } });
    const final = await run(w, claimOf('payment.captured', {}, { attempts: 5 }));
    expect(final).toMatchObject({ status: 'ignored', code: 'unknown_order' });
  });
});

describe('one transaction: lease first, store, fenced result; fencing and atomicity', () => {
  test('the order of operations inside the transaction: holdLease, the store call, then writeResult, all on the SAME transaction', async () => {
    const w = makeWorld();
    await run(w, claimOf('payment.captured'));
    expect(w.world.calls.map((c) => c.name)).toEqual(['holdLease', 'completePaymentFromCapture', 'writeResult']);
    expect(new Set(w.world.calls.map((c) => c.tx)).size).toBe(1);
    expect(w.db.$transaction).toHaveBeenCalledTimes(1);
    expect(w.world.txOptions[0]).toMatchObject({ maxWait: expect.any(Number), timeout: expect.any(Number) });
    expect(w.world.committed).toEqual(['payment:completePaymentFromCapture', 'inbox:processed']);
  });
  test('a worker that has lost its lease changes NOTHING: the store is never called and nothing is written', async () => {
    const w = makeWorld({ leaseLive: false });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'lease_lost' });
    expect(w.payments.completePaymentFromCapture).not.toHaveBeenCalled();
    expect(w.inbox.writeResult).not.toHaveBeenCalled();
    expect(w.inbox.retryOrFail).not.toHaveBeenCalled();
    expect(w.world.committed).toEqual([]);
  });
  test('a lease that ran out DURING the work (the fenced result writes 0 rows) rolls the payment change back too', async () => {
    const w = makeWorld({ writeCount: 0 });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'lease_lost' });
    expect(w.payments.completePaymentFromCapture).toHaveBeenCalled();
    expect(w.world.committed).toEqual([]); // neither the payment change nor an inbox result survived
  });
  test('a failing store call rolls everything back and records a retry with a short code OUTSIDE the transaction', async () => {
    const w = makeWorld({ storeResult: () => { throw new Error('ER_LOCK_DEADLOCK: secret detail'); } });
    const r = await run(w, claimOf('payment.captured'));
    expect(r).toMatchObject({ status: 'received', code: 'processing_error' });
    expect(JSON.stringify(r)).not.toMatch(/deadlock|secret/i);
    expect(w.world.committed).toEqual([]);
    expect(w.inbox.writeResult).not.toHaveBeenCalled();
    expect(w.inbox.retryOrFail).toHaveBeenCalledWith(w.db, expect.anything(), { code: 'processing_error' }); // the client, not the rolled-back transaction
  });
  test('a failing inbox result write also rolls the payment change back', async () => {
    const w = makeWorld();
    w.inbox.writeResult.mockRejectedValueOnce(new Error('db down'));
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'received', code: 'processing_error' });
    expect(w.world.committed).toEqual([]);
  });
  test('the eighth failed attempt is the final failure (the inbox policy), reported as "failed"', async () => {
    const w = makeWorld({ storeResult: () => { throw new Error('x'); } });
    expect(await run(w, claimOf('payment.captured', {}, { attempts: 8 }))).toMatchObject({ status: 'failed', code: 'processing_error' });
  });
  test('when even the retry cannot be recorded the claim is reported as unrecorded (the lease expires and recovery takes over); nothing is thrown', async () => {
    const w = makeWorld({ storeResult: () => { throw new Error('x'); } });
    w.inbox.retryOrFail.mockRejectedValueOnce(new Error('db down'));
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'unrecorded' });
  });
  test('a retry written after the lease was lost is reported as lease_lost, not as success', async () => {
    const w = makeWorld({ storeResult: () => { throw new Error('x'); } });
    w.inbox.retryOrFail.mockResolvedValueOnce({ status: 'received', delaySeconds: 60, written: 0 });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'lease_lost' });
  });
  test('duplicate delivery: the same event applied twice is a processed no-op the second time', async () => {
    const outcomes = [{ outcome: 'completed', flagged: false }, { outcome: 'duplicate_capture', flagged: false }];
    const w = makeWorld({ storeResult: () => outcomes.shift() });
    expect(await run(w, claimOf('payment.captured'))).toMatchObject({ status: 'processed', outcome: 'completed' });
    expect(await run(w, claimOf('payment.captured', {}, { id: 2 }))).toMatchObject({ status: 'processed', outcome: 'duplicate_capture' });
  });
  test('out-of-order events are each applied by what they say: a failed attempt after a capture is an attempt note, not a failure of the order', async () => {
    const w = makeWorld({ storeResult: { outcome: 'attempt_recorded', flagged: false } });
    expect(await run(w, claimOf('payment.failed'))).toMatchObject({ status: 'processed', outcome: 'attempt_recorded' });
  });
});

describe('processBatch', () => {
  test('recovers expired leases, claims what is due, processes each and tallies; a skipped claim and a failing event do not stop the others', async () => {
    const w = makeWorld();
    w.inbox.findDueIds.mockResolvedValue([1, 2, 3]);
    w.inbox.claim.mockResolvedValueOnce(claimOf('payment.captured', {}, { id: 1 })).mockResolvedValueOnce(null).mockResolvedValueOnce(claimOf('payment.failed', {}, { id: 3 }));
    const outcomes = [{ outcome: 'completed', flagged: false }, () => { throw new Error('boom'); }];
    w.world.storeResult = () => { const next = outcomes.shift(); if (typeof next === 'function') next(); return next; };
    const tally = await processor.processBatch(w.db, { workerId: 'W1', leaseSeconds: 90, env: ENV, deps: w.deps });
    expect(w.inbox.recoverExpiredLeases).toHaveBeenCalledWith(w.db);
    expect(w.inbox.claim).toHaveBeenCalledWith(w.db, { id: 1, workerId: 'W1', leaseSeconds: 90 });
    expect(tally).toMatchObject({ claimed: 2, skipped: 1, processed: 1, received: 1 });
  });
  test('errors of the queue queries themselves propagate to the caller', async () => {
    const w = makeWorld();
    w.inbox.findDueIds.mockRejectedValue(new Error('db down'));
    await expect(processor.processBatch(w.db, { workerId: 'W1', env: ENV, deps: w.deps })).rejects.toThrow('db down');
  });
});

describe('static checks of the source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/modules/payments/razorpay-webhook.processor.js'), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  test('no logging, no network, no raw SQL, no clock, no payment or refund creation, no Bitrix', () => {
    expect(code).not.toMatch(/console\.|logger\.|fetch\(|require\('https?'\)|\$queryRaw|\$executeRaw|new Date|Date\.now|setTimeout|setInterval/);
    expect(code).not.toMatch(/\.create\(|payment\.update|invoice\.|auditLog|appendAuditLog|bitrix/i);
  });
  test('order.paid reaches only the reconciliation operation', () => {
    const block = code.slice(code.indexOf("case 'order.paid'"), code.indexOf('default:'));
    expect(block).toContain('recordOrderPaid');
    expect(block).not.toMatch(/completePaymentFromCapture|completeRefund|failRefund/);
  });
  test('the processor itself schedules nothing: it knows no job, timer or runner; the only registration is the dedicated job file (Step 6)', () => {
    expect(code).not.toMatch(/jobs|setInterval|setTimeout|job-runner/);
    const jobs = fs.readFileSync(path.join(__dirname, '../../src/jobs/index.js'), 'utf8');
    expect(jobs).toContain("require('./razorpay-webhook-inbox.job')");
    expect(jobs).not.toMatch(/webhook.processor/);
  });
  test('nothing is copied into an audit record here: the processor builds no audit data at all', () => {
    expect(code).not.toMatch(/afterData|beforeData|reasonCode/);
  });
});
