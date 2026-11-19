/* global describe, test, expect, jest */
// Razorpay payment store: lookups, invoice-first locking, guarded completion / late capture / duplicates, refunds on EXISTING rows, the audit allow-list,
// rollback and database errors. No database and no network: an in-memory fake whose transactions roll back on a throw and which records every lock.
const store = require('../../src/modules/payments/razorpay-payment.store');
const { appendAuditLog, ALLOWED_DATA_KEYS } = require('../../src/common/audit/business-audit');
const fs = require('fs');
const path = require('path');

const T = new Date('2026-11-20T10:00:00.000Z');
const clone = (v) => structuredClone(v);
const unique = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

const inv = (over = {}) => ({ id: 1, caseId: 10, source: 'quotation', status: 'issued', amount: '1500.000', currency: 'INR', dueDate: null, quotationId: 5, allowPartialPayment: false, ...over });
const pay = (over = {}) => ({
  id: 100, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'payment', refundOfPaymentId: null, amount: '1500.000', status: 'pending', method: 'razorpay',
  externalReference: null, transactedAt: null, razorpayOrderId: 'order_ABC1', ...over,
});
const refundRow = (over = {}) => ({
  id: 200, invoiceId: 1, caseId: 10, currency: 'INR', kind: 'refund', refundOfPaymentId: 100, amount: '500.000', status: 'pending', method: 'razorpay',
  externalReference: 'rfnd_R1', transactedAt: null, razorpayOrderId: null, ...over,
});
const done = (over = {}) => pay({ status: 'completed', externalReference: 'pay_P1', transactedAt: T, ...over });

function matches(row, where = {}) {
  for (const [k, expected] of Object.entries(where)) {
    if (k === 'OR') { if (!expected.some((w) => matches(row, w))) return false; continue; }
    const actual = row[k];
    if (expected === null) { if (actual != null) return false; continue; }
    if (expected && typeof expected === 'object' && !isDate(expected)) { if ('not' in expected) { if (actual === expected.not || (expected.not === null && actual == null)) return false; continue; } return false; }
    if (actual !== expected) return false;
  }
  return true;
}

function makeDb({ invoices = [inv()], payments = [], failOn = null, onPaymentLock = null } = {}) {
  const state = { invoices: new Map(invoices.map((i) => [i.id, i])), payments: clone(payments), audits: [], locks: [], reads: [] };
  let txId = 0;
  let inTx = 0;
  const api = (s) => ({
    state: s,
    // Lock statements ("SELECT id FROM ... FOR UPDATE") are recorded; current reads ("SELECT <columns> ... FOR UPDATE") are answered from the CURRENT state.
    $queryRaw: jest.fn(async (strings, ...values) => {
      if (failOn === 'lock') throw new Error('lock failed');
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      if (!/FOR UPDATE$/.test(sql)) throw new Error(`a raw read without FOR UPDATE: ${sql}`);
      const table = /FROM (\w+)/.exec(sql)[1];
      if (/^SELECT id FROM/.test(sql)) {
        s.locks.push({ table, id: values[0], tx: inTx });
        if (table === 'payments' && onPaymentLock) onPaymentLock(s, values[0]); // a concurrent change that lands just before the lock is granted
        return [];
      }
      s.reads.push({ table, tx: inTx });
      if (failOn === 'read') throw new Error('db down');
      if (table === 'invoices') { const i = s.invoices.get(values[0]); return i ? [clone(i)] : []; }
      if (/WHERE id = \?/.test(sql)) return clone(s.payments.filter((p) => p.id === values[0]));
      if (/WHERE invoice_id/.test(sql)) return clone(s.payments.filter((p) => p.invoiceId === values[0] && p.status === 'completed').sort((a, b) => a.id - b.id));
      if (/refund_of_payment_id/.test(sql)) return clone(s.payments.filter((p) => p.kind === 'refund' && p.refundOfPaymentId === values[0] && p.status === 'completed'));
      throw new Error(`unexpected raw read: ${sql}`);
    }),
    invoice: { findUnique: jest.fn(async ({ where }) => clone(s.invoices.get(where.id)) || null) },
    payment: {
      findUnique: jest.fn(async ({ where }) => {
        if (failOn === 'read') throw new Error('db down');
        return clone(s.payments.find((p) => (where.id !== undefined ? p.id === where.id : p.razorpayOrderId === where.razorpayOrderId))) || null;
      }),
      findMany: jest.fn(async ({ where, take }) => clone(s.payments.filter((p) => matches(p, where)).sort((a, b) => a.id - b.id).slice(0, take || 1000))),
      updateMany: jest.fn(async ({ where, data }) => {
        if (failOn === 'update') throw new Error('update failed');
        const rows = s.payments.filter((p) => matches(p, where));
        for (const row of rows) {
          if (data.externalReference && s.payments.some((p) => p !== row && p.invoiceId === row.invoiceId && p.kind === row.kind && p.externalReference === data.externalReference)) throw unique();
          Object.assign(row, data);
        }
        return { count: rows.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }) => {
        if (failOn === 'audit') throw new Error('audit failed');
        if (data.idempotencyKey && s.audits.some((a) => a.entityType === data.entityType && a.entityId === data.entityId && a.idempotencyKey === data.idempotencyKey)) throw unique();
        s.audits.push(clone(data));
        return {};
      }),
    },
  });
  const db = {
    ...api(state),
    txCount: 0,
    async $transaction(fn) {
      const snapshot = clone({ payments: state.payments, audits: state.audits, locks: state.locks, reads: state.reads });
      db.txCount += 1; txId += 1; inTx = txId;
      try { return await fn(api(state)); } catch (err) { Object.assign(state, clone(snapshot)); throw err; } finally { inTx = 0; }
    },
  };
  return db;
}

const capture = (over = {}) => ({ razorpayOrderId: 'order_ABC1', razorpayPaymentId: 'pay_P1', amountMinor: 150000, currency: 'INR', transactedAt: T, eventType: 'payment.captured', ...over });
const refundEv = (over = {}) => ({ razorpayRefundId: 'rfnd_R1', razorpayPaymentId: 'pay_P1', amountMinor: 50000, currency: 'INR', transactedAt: T, eventType: 'refund.processed', ...over });
const actions = (db) => db.state.audits.map((a) => `${a.action}:${a.reasonCode}`);
const rowOf = (db, id) => db.state.payments.find((p) => p.id === id);

describe('lookups', () => {
  test('finds a payment by Razorpay order id, and null for an unknown one', async () => {
    const db = makeDb({ payments: [pay()] });
    expect((await store.findPaymentByOrderId(db, 'order_ABC1')).id).toBe(100);
    expect(await store.findPaymentByOrderId(db, 'order_NOPE')).toBeNull();
  });
  test('finds an existing refund by its Razorpay refund id; none and ambiguous are distinguished', async () => {
    const db = makeDb({ payments: [done(), refundRow()] });
    expect(await store.findRefundByExternalReference(db, 'rfnd_R1')).toMatchObject({ outcome: 'found', refund: { id: 200 } });
    expect(await store.findRefundByExternalReference(db, 'rfnd_X')).toEqual({ outcome: 'none', refund: null });
    const two = makeDb({ invoices: [inv(), inv({ id: 2 })], payments: [refundRow(), refundRow({ id: 201, invoiceId: 2 })] });
    expect(await store.findRefundByExternalReference(two, 'rfnd_R1')).toEqual({ outcome: 'ambiguous', refund: null });
  });
  test('returns the original payment of a refund and the invoice context', async () => {
    const db = makeDb({ payments: [done(), refundRow()] });
    expect((await store.findOriginalPaymentOfRefund(db, refundRow())).id).toBe(100);
    expect(await store.findOriginalPaymentOfRefund(db, { refundOfPaymentId: null })).toBeNull();
    expect((await store.loadInvoiceContext(db, 1)).currency).toBe('INR');
  });
  test('completed totals count completed payments only; refunds are reported but never subtracted', async () => {
    const db = makeDb({ payments: [done({ id: 100, amount: '1000.000' }), done({ id: 101, amount: '250.500', externalReference: 'pay_P2' }), pay({ id: 102, razorpayOrderId: 'order_Z', amount: '999.000' }), refundRow({ status: 'completed', transactedAt: T, amount: '300.000' })] });
    const totals = await store.completedTotals(db, 1);
    expect(totals).toMatchObject({ paid: 1250500n, refunded: 300000n, paymentCount: 2 });
    expect(await store.completedRefundTotalOf(db, 100)).toBe(300000n);
  });
  test('ids are validated before any query', async () => {
    const db = makeDb();
    expect(() => store.findPaymentByOrderId(db, 'x; DROP')).toThrow(RangeError);
    await expect(store.findRefundByExternalReference(db, 'order_1')).rejects.toThrow(RangeError);
    await expect(store.completedTotals(db, 0)).rejects.toThrow(RangeError);
    expect(db.payment.findUnique).not.toHaveBeenCalled();
  });
});

describe('overpayment', () => {
  test('is exact, uses completed payments only, and is zero at or below the invoice amount', () => {
    expect(store.overpaymentOf('1500.000', 1500000n)).toMatchObject({ overpaid: 0n });
    expect(store.overpaymentOf('1500.000', 1000000n).overpaid).toBe(0n);
    expect(store.overpaymentOf('1500.000', 1500001n).overpaid).toBe(1n);
  });
  test('calculateInvoiceOverpayment ignores pending/failed rows and refunds', async () => {
    const db = makeDb({ payments: [done({ amount: '1500.000' }), done({ id: 101, amount: '100.000', externalReference: 'pay_P2', razorpayOrderId: 'order_B' }), pay({ id: 102, razorpayOrderId: 'order_C', status: 'failed' }), refundRow({ status: 'completed', transactedAt: T, amount: '1500.000' })] });
    expect(await store.calculateInvoiceOverpayment(db, 1)).toMatchObject({ overpaid: 100000n });
    expect(await store.calculateInvoiceOverpayment(db, 99)).toBeNull();
  });
});

describe('completing a pending payment: invoice-first locking and guarded update', () => {
  test('locks the INVOICE, then the PAYMENT, inside one transaction, and completes with the validated time', async () => {
    const db = makeDb({ payments: [pay()] });
    const r = await store.completePaymentFromCapture(db, capture());
    expect(r).toMatchObject({ outcome: 'completed', paymentId: 100, flagged: false });
    expect(db.state.locks).toEqual([{ table: 'invoices', id: 1, tx: 1 }, { table: 'payments', id: 100, tx: 1 }]);
    expect(rowOf(db, 100)).toMatchObject({ status: 'completed', externalReference: 'pay_P1', transactedAt: T });
    expect(actions(db)).toEqual(['payment.completed:webhook_capture']);
  });
  test('the decision uses the RE-READ row: a payment completed by someone else just before the lock is granted is a duplicate, not completed again', async () => {
    const db = makeDb({
      payments: [pay()],
      onPaymentLock: (s, id) => { Object.assign(s.payments.find((p) => p.id === id), { status: 'completed', externalReference: 'pay_P1', transactedAt: T }); },
    });
    expect((await store.completePaymentFromCapture(db, capture())).outcome).toBe('duplicate_capture');
    expect(rowOf(db, 100).transactedAt.getTime()).toBe(T.getTime());
  });
  test('works inside a caller\'s transaction too (no second transaction is opened)', async () => {
    const db = makeDb({ payments: [pay()] });
    await db.$transaction(async (tx) => { await store.completePaymentFromCapture(tx, capture()); });
    expect(db.txCount).toBe(1);
  });
  test('an unknown order writes nothing and flags nothing (another environment must not raise alerts)', async () => {
    const db = makeDb({ payments: [pay()] });
    expect(await store.completePaymentFromCapture(db, capture({ razorpayOrderId: 'order_OTHER' }))).toMatchObject({ outcome: 'unknown_order', flagged: false });
    expect(db.state.audits).toEqual([]);
    expect(db.state.locks).toEqual([]);
  });
  test('amount mismatch: not completed, flagged with expected and received amounts', async () => {
    const db = makeDb({ payments: [pay()] });
    expect(await store.completePaymentFromCapture(db, capture({ amountMinor: 100000 }))).toMatchObject({ outcome: 'amount_mismatch', flagged: true });
    expect(rowOf(db, 100).status).toBe('pending');
    expect(db.state.audits[0]).toMatchObject({ action: 'payment.reconciliation_required', reasonCode: 'amount_mismatch', afterData: { expectedAmount: '1500.00', receivedAmount: '1000.00', reconciliationRequired: true } });
  });
  test('currency mismatch: not completed, flagged', async () => {
    const db = makeDb({ payments: [pay()] });
    expect((await store.completePaymentFromCapture(db, capture({ currency: 'USD' }))).outcome).toBe('currency_mismatch');
    expect(rowOf(db, 100).status).toBe('pending');
    expect(db.state.audits[0].afterData).toMatchObject({ currency: 'INR', receivedCurrency: 'USD' });
  });
  test('a refund row or a missing amount never completes as a payment', async () => {
    const db = makeDb({ payments: [pay({ kind: 'refund' })] });
    expect((await store.completePaymentFromCapture(db, capture())).outcome).toBe('not_a_payment');
    expect(() => store.completePaymentFromCapture(db, capture({ amountMinor: 1.5 }))).toThrow(RangeError);
  });
  test('a non-issued invoice still records the money, and flags it', async () => {
    const db = makeDb({ invoices: [inv({ status: 'void' })], payments: [pay()] });
    expect(await store.completePaymentFromCapture(db, capture())).toMatchObject({ outcome: 'completed', flagged: true });
    expect(actions(db)).toContain('payment.reconciliation_required:invoice_not_issued');
  });
});

describe('transaction time (D3) at the store boundary', () => {
  test.each([['missing', undefined], ['null', null], ['invalid date', new Date('nope')], ['bad string', 'yesterday'], ['too old', new Date(0)], ['too far ahead', new Date('2200-01-01T00:00:00Z')], ['a number', 1700000000]])(
    '%s -> quarantined: nothing completed, flagged invalid_transaction_time',
    async (_label, value) => {
      const db = makeDb({ payments: [pay()] });
      const r = await store.completePaymentFromCapture(db, capture({ transactedAt: value }));
      expect(r).toMatchObject({ outcome: 'quarantined', flagged: true });
      expect(rowOf(db, 100)).toMatchObject({ status: 'pending', transactedAt: null });
      expect(actions(db)).toEqual(['payment.reconciliation_required:invalid_transaction_time']);
    },
  );
  test('a strict ISO string is accepted; the application clock is never substituted', async () => {
    const db = makeDb({ payments: [pay()] });
    await store.completePaymentFromCapture(db, capture({ transactedAt: '2026-11-20T10:00:00.000Z' }));
    expect(rowOf(db, 100).transactedAt.getTime()).toBe(T.getTime());
    expect(store.validTransactionTime(undefined)).toBeNull();
  });
  test('a refund completion without a valid time is quarantined too, but a refund FAILURE does not need one', async () => {
    const a = makeDb({ payments: [done(), refundRow()] });
    expect((await store.completeRefund(a, refundEv({ transactedAt: null }))).outcome).toBe('quarantined');
    expect(rowOf(a, 200).status).toBe('pending');
    const b = makeDb({ payments: [done(), refundRow()] });
    expect((await store.failRefund(b, refundEv({ transactedAt: null, eventType: 'refund.failed' }))).outcome).toBe('failed');
  });
});

describe('late capture (D1)', () => {
  test.each(['failed', 'cancelled'])('a verified capture on a %s payment completes it, flags Operations, and does not touch the invoice', async (status) => {
    const db = makeDb({ payments: [pay({ status })] });
    const r = await store.completePaymentFromCapture(db, capture());
    expect(r).toMatchObject({ outcome: 'late_capture', flagged: true });
    expect(rowOf(db, 100)).toMatchObject({ status: 'completed', externalReference: 'pay_P1', transactedAt: T });
    expect(actions(db)).toEqual(['payment.late_capture_completed:late_capture', 'payment.reconciliation_required:late_capture']);
    expect(db.state.audits[1].afterData).toMatchObject({ lateCapture: true, previousStatus: status, reconciliationRequired: true });
    expect(db.state.invoices.get(1).status).toBe('issued'); // never reopened, no order created (no gateway here at all)
  });
  test('a late capture that pushes completed payments over the invoice also flags the overpayment', async () => {
    const db = makeDb({ payments: [pay({ status: 'failed' }), done({ id: 101, razorpayOrderId: 'order_B', externalReference: 'pay_P9' })] });
    const r = await store.completePaymentFromCapture(db, capture());
    expect(r).toMatchObject({ outcome: 'late_capture', overpaid: '1500.00' });
    expect(actions(db)).toContain('payment.reconciliation_required:overpayment');
  });
  test('an existing reference on the failed row that differs is preserved and flagged, not overwritten', async () => {
    const db = makeDb({ payments: [pay({ status: 'failed', externalReference: 'pay_OLD' })] });
    expect((await store.completePaymentFromCapture(db, capture())).outcome).toBe('different_payment_id');
    expect(rowOf(db, 100)).toMatchObject({ status: 'failed', externalReference: 'pay_OLD' });
  });
});

describe('duplicate capture and a different payment id', () => {
  test('the same gateway payment id on a completed payment is a no-op with a once-only note', async () => {
    const db = makeDb({ payments: [done()] });
    expect(await store.completePaymentFromCapture(db, capture())).toMatchObject({ outcome: 'duplicate_capture', flagged: false });
    expect(await store.completePaymentFromCapture(db, capture())).toMatchObject({ outcome: 'duplicate_capture' });
    expect(rowOf(db, 100)).toMatchObject({ status: 'completed', externalReference: 'pay_P1', transactedAt: T });
    expect(actions(db)).toEqual(['payment.duplicate_capture:duplicate_capture']); // once, despite two deliveries
  });
  test('a DIFFERENT payment id on a completed payment never overwrites the evidence and is flagged with both ids', async () => {
    const db = makeDb({ payments: [done()] });
    const r = await store.completePaymentFromCapture(db, capture({ razorpayPaymentId: 'pay_P2' }));
    expect(r).toMatchObject({ outcome: 'different_payment_id', flagged: true });
    expect(rowOf(db, 100)).toMatchObject({ externalReference: 'pay_P1', transactedAt: T });
    expect(db.state.audits[0].afterData).toMatchObject({ razorpayPaymentId: 'pay_P2', existingRazorpayPaymentId: 'pay_P1' });
  });
  test('the gateway id already on another payment of the invoice (unique key) is flagged, nothing written', async () => {
    const db = makeDb({ payments: [pay(), done({ id: 101, razorpayOrderId: 'order_B' })] });
    expect((await store.completePaymentFromCapture(db, capture())).outcome).toBe('reference_conflict');
    expect(rowOf(db, 100).status).toBe('pending');
  });
});

describe('overpayment on completion', () => {
  test('a completion that makes completed payments exceed the invoice is kept and flagged with exact amounts', async () => {
    const db = makeDb({ payments: [pay({ amount: '700.000' }), done({ id: 101, amount: '1000.000', razorpayOrderId: 'order_B', externalReference: 'pay_P0' })] });
    const r = await store.completePaymentFromCapture(db, capture({ amountMinor: 70000 }));
    expect(r).toMatchObject({ outcome: 'completed', flagged: true, overpaid: '200.00' });
    expect(rowOf(db, 100).status).toBe('completed');
    expect(db.state.audits.find((a) => a.reasonCode === 'overpayment').afterData).toMatchObject({ overpayment: true, expectedAmount: '1500.00', receivedAmount: '1700.00' });
  });
  test('an exact full payment is not an overpayment', async () => {
    const db = makeDb({ payments: [pay()] });
    expect((await store.completePaymentFromCapture(db, capture())).overpaid).toBeUndefined();
  });
});

describe('refunds: existing rows only', () => {
  test('completes an eligible pending refund; locks invoice first then both payments in ascending id; the invoice is untouched', async () => {
    const db = makeDb({ payments: [done(), refundRow()] });
    const r = await store.completeRefund(db, refundEv());
    expect(r).toMatchObject({ outcome: 'completed', refundId: 200, paymentId: 100 });
    expect(rowOf(db, 200)).toMatchObject({ status: 'completed', transactedAt: T });
    expect(db.state.locks.map((l) => `${l.table}:${l.id}`)).toEqual(['invoices:1', 'payments:100', 'payments:200']);
    expect(db.state.invoices.get(1).status).toBe('issued');
    expect(await store.completedTotals(db, 1)).toMatchObject({ paid: 1500000n }); // the balance is not reopened
    expect(actions(db)).toEqual(['payment.refund_completed:webhook_refund']);
  });
  test('marks a pending refund failed', async () => {
    const db = makeDb({ payments: [done(), refundRow()] });
    expect(await store.failRefund(db, refundEv({ eventType: 'refund.failed' }))).toMatchObject({ outcome: 'failed' });
    expect(rowOf(db, 200)).toMatchObject({ status: 'failed', transactedAt: null });
    expect(actions(db)).toEqual(['payment.refund_failed:webhook_refund']);
  });
  test('never creates a refund row from an event', async () => {
    const db = makeDb({ payments: [done()] });
    await store.completeRefund(db, refundEv());
    expect(db.state.payments).toHaveLength(1);
    expect(Object.keys(db.payment)).not.toContain('create');
  });
  test('an unknown refund whose original payment is known is flagged on that payment; unknown on both sides is silent', async () => {
    const known = makeDb({ payments: [done()] });
    expect(await store.completeRefund(known, refundEv())).toMatchObject({ outcome: 'unknown_refund', paymentId: 100, flagged: true });
    expect(known.state.audits[0]).toMatchObject({ action: 'payment.reconciliation_required', reasonCode: 'unknown_refund', afterData: { razorpayRefundId: 'rfnd_R1', refundInconsistency: true, reconciliationRequired: true } });
    expect(known.state.locks.map((l) => l.table)).toEqual(['invoices', 'payments']);
    const none = makeDb({ payments: [] });
    expect(await store.completeRefund(none, refundEv())).toMatchObject({ outcome: 'unknown_refund', flagged: false });
    expect(none.state.audits).toEqual([]);
  });
  test('an ambiguous refund reference is flagged, never guessed', async () => {
    const db = makeDb({ invoices: [inv(), inv({ id: 2 })], payments: [done(), refundRow(), refundRow({ id: 201, invoiceId: 2, refundOfPaymentId: null })] });
    expect((await store.completeRefund(db, refundEv())).outcome).toBe('ambiguous_refund');
    expect(rowOf(db, 200).status).toBe('pending');
  });
  test.each([
    ['original not completed', [pay(), refundRow()], refundEv(), 'original_not_completed'],
    ['original payment id differs', [done({ externalReference: 'pay_OTHER' }), refundRow()], refundEv(), 'payment_id_mismatch'],
    ['currency differs', [done(), refundRow()], refundEv({ currency: 'USD' }), 'currency_mismatch'],
    ['amount differs', [done(), refundRow()], refundEv({ amountMinor: 40000 }), 'amount_mismatch'],
  ])('%s -> flagged, refund unchanged', async (_l, payments, ev, outcome) => {
    const db = makeDb({ payments });
    expect(await store.completeRefund(db, ev)).toMatchObject({ outcome, flagged: true });
    expect(rowOf(db, 200).status).toBe('pending');
    expect(db.state.audits[0].afterData).toMatchObject({ refundInconsistency: true, reconciliationRequired: true });
  });
  test('cumulative refunds can never exceed the original payment: exactly the remaining amount is allowed, one thousandth more is refused', async () => {
    const ok = makeDb({ payments: [done(), refundRow({ id: 201, externalReference: 'rfnd_PRIOR', status: 'completed', transactedAt: T, amount: '1000.000' }), refundRow()] });
    expect((await store.completeRefund(ok, refundEv())).outcome).toBe('completed'); // 1000 + 500 = 1500
    const over = makeDb({ payments: [done(), refundRow({ id: 201, externalReference: 'rfnd_PRIOR', status: 'completed', transactedAt: T, amount: '1000.001' }), refundRow()] });
    const r = await store.completeRefund(over, refundEv());
    expect(r).toMatchObject({ outcome: 'refund_exceeds_payment', flagged: true });
    expect(rowOf(over, 200).status).toBe('pending');
    expect(over.state.audits[0].afterData).toMatchObject({ expectedAmount: '1500.00', receivedAmount: '1500.001' });
  });
  test('a pending/failed prior refund does not count towards the cumulative total', async () => {
    const db = makeDb({ payments: [done(), refundRow({ id: 201, externalReference: 'rfnd_P', status: 'failed', amount: '1500.000' }), refundRow()] });
    expect((await store.completeRefund(db, refundEv())).outcome).toBe('completed');
  });
  test('the same result twice is a no-op; the opposite result on a closed refund is a flagged conflict, never applied', async () => {
    const db = makeDb({ payments: [done(), refundRow({ status: 'completed', transactedAt: T })] });
    expect((await store.completeRefund(db, refundEv())).outcome).toBe('already_completed');
    expect(await store.failRefund(db, refundEv({ eventType: 'refund.failed' }))).toMatchObject({ outcome: 'state_conflict', flagged: true });
    expect(rowOf(db, 200).status).toBe('completed');
    const failed = makeDb({ payments: [done(), refundRow({ status: 'failed' })] });
    expect((await store.failRefund(failed, refundEv())).outcome).toBe('already_failed');
    expect((await store.completeRefund(failed, refundEv())).outcome).toBe('state_conflict');
  });
  test('arguments are validated', () => {
    const db = makeDb();
    expect(() => store.completeRefund(db, refundEv({ razorpayRefundId: 'refund_1' }))).toThrow(RangeError);
    expect(() => store.completeRefund(db, refundEv({ amountMinor: 0 }))).toThrow(RangeError);
    expect(() => store.settleRefund).not.toThrow();
  });
});

describe('a failed payment attempt (payment.failed)', () => {
  const failed = (over = {}) => ({ razorpayOrderId: 'order_ABC1', razorpayPaymentId: 'pay_F1', amountMinor: 150000, currency: 'INR', eventType: 'payment.failed', ...over });
  test('keeps the payment pending, writes no reference, changes nothing on the invoice, and records one audit note; locks invoice first', async () => {
    const db = makeDb({ payments: [pay()] });
    expect(await store.recordPaymentAttemptFailed(db, failed())).toMatchObject({ outcome: 'attempt_recorded', flagged: false, paymentId: 100 });
    expect(rowOf(db, 100)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(db.state.invoices.get(1).status).toBe('issued');
    expect(actions(db)).toEqual(['payment.attempt_failed:gateway_attempt_failed']);
    expect(db.state.audits[0].afterData).toMatchObject({ razorpayPaymentId: 'pay_F1', razorpayOrderId: 'order_ABC1', eventType: 'payment.failed', status: 'pending' });
    expect(db.state.locks.map((l) => `${l.table}:${l.id}`)).toEqual(['invoices:1', 'payments:100']);
    expect(db.payment.updateMany).not.toHaveBeenCalled();
  });
  test('several attempts under one order are each recorded once; the same attempt delivered twice is one note', async () => {
    const db = makeDb({ payments: [pay()] });
    await store.recordPaymentAttemptFailed(db, failed({ razorpayPaymentId: 'pay_F1' }));
    await store.recordPaymentAttemptFailed(db, failed({ razorpayPaymentId: 'pay_F2' }));
    await store.recordPaymentAttemptFailed(db, failed({ razorpayPaymentId: 'pay_F2' }));
    expect(actions(db)).toHaveLength(2);
    expect(rowOf(db, 100).status).toBe('pending');
  });
  test('a failed attempt that arrives AFTER the successful capture leaves the completed payment and its evidence alone', async () => {
    const db = makeDb({ payments: [done()] });
    expect((await store.recordPaymentAttemptFailed(db, failed())).outcome).toBe('attempt_recorded');
    expect(rowOf(db, 100)).toMatchObject({ status: 'completed', externalReference: 'pay_P1' });
    expect(db.state.audits[0].afterData.status).toBe('completed');
  });
  test('an unknown order writes nothing; a wrong currency or amount is flagged and nothing is recorded as an attempt', async () => {
    const db = makeDb({ payments: [pay()] });
    expect(await store.recordPaymentAttemptFailed(db, failed({ razorpayOrderId: 'order_OTHER' }))).toMatchObject({ outcome: 'unknown_order', flagged: false });
    expect(db.state.audits).toEqual([]);
    expect((await store.recordPaymentAttemptFailed(db, failed({ currency: 'USD' }))).outcome).toBe('currency_mismatch');
    expect((await store.recordPaymentAttemptFailed(db, failed({ amountMinor: 1 }))).outcome).toBe('amount_mismatch');
    expect(actions(db)).toEqual(['payment.reconciliation_required:currency_mismatch', 'payment.reconciliation_required:amount_mismatch']);
  });
});

describe('order.paid: reconciliation only', () => {
  const paid = (over = {}) => ({ razorpayOrderId: 'order_ABC1', amountMinor: 150000, eventType: 'order.paid', ...over });
  test('on a completed payment with the matching amount it writes one evidence note and changes nothing', async () => {
    const db = makeDb({ payments: [done()] });
    expect(await store.recordOrderPaid(db, paid())).toMatchObject({ outcome: 'order_paid_recorded', flagged: false });
    expect(await store.recordOrderPaid(db, paid())).toMatchObject({ outcome: 'order_paid_recorded' });
    expect(actions(db)).toEqual(['payment.order_paid_observed:order_paid_event']); // once-only
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(rowOf(db, 100)).toMatchObject({ status: 'completed', externalReference: 'pay_P1' });
  });
  test('NEVER completes a payment: a pending one stays pending (waiting while not final, flagged on the final attempt)', async () => {
    const db = makeDb({ payments: [pay()] });
    expect(await store.recordOrderPaid(db, paid(), { final: false })).toMatchObject({ outcome: 'order_paid_pending_capture', flagged: false });
    expect(db.state.audits).toEqual([]);
    expect(await store.recordOrderPaid(db, paid(), { final: true })).toMatchObject({ outcome: 'order_paid_unreconciled', flagged: true });
    expect(rowOf(db, 100)).toMatchObject({ status: 'pending', externalReference: null, transactedAt: null });
    expect(db.payment.updateMany).not.toHaveBeenCalled();
    expect(actions(db)).toEqual(['payment.reconciliation_required:order_paid_not_completed']);
  });
  test('an amount that differs from the completed payment is flagged; an unknown order is silent', async () => {
    const db = makeDb({ payments: [done()] });
    expect((await store.recordOrderPaid(db, paid({ amountMinor: 100000 }))).outcome).toBe('order_paid_amount_mismatch');
    expect(db.state.audits[0].afterData).toMatchObject({ expectedAmount: '1500.00', receivedAmount: '1000.00' });
    expect(await store.recordOrderPaid(makeDb({ payments: [done()] }), paid({ razorpayOrderId: 'order_NOPE' }))).toMatchObject({ outcome: 'unknown_order', flagged: false });
  });
  test('locks the invoice before the payment', async () => {
    const db = makeDb({ payments: [done()] });
    await store.recordOrderPaid(db, paid());
    expect(db.state.locks.map((l) => l.table)).toEqual(['invoices', 'payments']);
  });
});

describe('refunds that may still be on their way (options.final = false)', () => {
  test('a refund row that does not exist yet: nothing is locked, written or flagged while waiting; on the final attempt it is flagged as before', async () => {
    const db = makeDb({ payments: [done()] });
    expect(await store.completeRefund(db, refundEv(), { final: false })).toMatchObject({ outcome: 'unknown_refund', flagged: false });
    expect(db.state.locks).toEqual([]);
    expect(db.state.audits).toEqual([]);
    expect(await store.completeRefund(db, refundEv(), { final: true })).toMatchObject({ outcome: 'unknown_refund', flagged: true });
    expect(db.state.payments).toHaveLength(1); // never a refund row created
  });
  test('the row appears between attempts: the later attempt completes it', async () => {
    const db = makeDb({ payments: [done()] });
    await store.completeRefund(db, refundEv(), { final: false });
    db.state.payments.push(refundRow());
    expect((await store.completeRefund(db, refundEv(), { final: false })).outcome).toBe('completed');
  });
  test('an original that is not completed yet waits without a flag, and is flagged on the final attempt', async () => {
    const db = makeDb({ payments: [pay(), refundRow()] });
    expect(await store.completeRefund(db, refundEv(), { final: false })).toMatchObject({ outcome: 'original_not_completed', flagged: false });
    expect(db.state.audits).toEqual([]);
    expect(await store.completeRefund(db, refundEv())).toMatchObject({ outcome: 'original_not_completed', flagged: true });
  });
  test('an ambiguous reference is never waited for', async () => {
    const db = makeDb({ invoices: [inv(), inv({ id: 2 })], payments: [done(), refundRow(), refundRow({ id: 201, invoiceId: 2, refundOfPaymentId: null })] });
    expect((await store.completeRefund(db, refundEv(), { final: false })).outcome).toBe('ambiguous_refund');
  });
});

describe('audit allow-list', () => {
  test('the new keys are allow-listed and a key that is not allow-listed is refused', async () => {
    for (const key of ['razorpayPaymentId', 'razorpayRefundId', 'eventType', 'expectedAmount', 'receivedAmount', 'lateCapture', 'duplicateCapture', 'overpayment', 'refundInconsistency', 'reconciliationRequired']) expect(ALLOWED_DATA_KEYS.has(key)).toBe(true);
    const db = makeDb();
    const entry = { entityType: 'payment', entityId: '1', action: 'x', actorType: 'system', source: 's' };
    for (const key of ['signature', 'rawBody', 'body', 'cardNumber', 'vpa', 'upi', 'errorDescription', 'email', 'phone', 'secret']) {
      expect(() => appendAuditLog(db, { ...entry, afterData: { [key]: 'x' } })).toThrow(/may not contain/);
    }
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  test('values are short text, number, boolean or null: an object or a long text is refused', () => {
    const db = makeDb();
    const entry = { entityType: 'payment', entityId: '1', action: 'x', actorType: 'system', source: 's' };
    expect(() => appendAuditLog(db, { ...entry, afterData: { eventType: { a: 1 } } })).toThrow();
    expect(() => appendAuditLog(db, { ...entry, afterData: { eventType: 'x'.repeat(201) } })).toThrow();
  });
  test('every audit entry the store writes uses only allow-listed keys, codes and the system actor', async () => {
    const db = makeDb({ payments: [pay({ status: 'failed' }), done({ id: 101, razorpayOrderId: 'order_B', externalReference: 'pay_P9' }), refundRow({ id: 300, invoiceId: 1, refundOfPaymentId: 101, externalReference: 'rfnd_Z' })], invoices: [inv({ status: 'void' })] });
    await store.completePaymentFromCapture(db, capture());
    await store.completeRefund(db, refundEv({ razorpayRefundId: 'rfnd_Z', razorpayPaymentId: 'pay_P9' }));
    expect(db.state.audits.length).toBeGreaterThan(3);
    for (const a of db.state.audits) {
      expect(a).toMatchObject({ actorType: 'system', source: 'razorpay_webhook', entityType: 'payment' });
      for (const key of Object.keys(a.afterData)) expect(ALLOWED_DATA_KEYS.has(key)).toBe(true);
      expect(JSON.stringify(a)).not.toMatch(/signature|secret|body|description|vpa|card/i);
    }
  });
  test('an audit entry is once-only: a repeat is a no-op, not an error', async () => {
    const db = makeDb({ payments: [pay({ status: 'failed' })] });
    await store.completePaymentFromCapture(db, capture());
    const before = db.state.audits.length;
    await store.completePaymentFromCapture(db, capture()); // now a duplicate capture (one new once-only note)
    await store.completePaymentFromCapture(db, capture());
    expect(db.state.audits.length).toBe(before + 1);
  });
});

describe('rollback and database errors', () => {
  test.each(['audit', 'update', 'lock'])('a failing %s rolls the whole transaction back and the error propagates', async (failOn) => {
    const db = makeDb({ payments: [pay()], failOn });
    await expect(store.completePaymentFromCapture(db, capture())).rejects.toThrow(/failed/);
    expect(rowOf(db, 100)).toMatchObject({ status: 'pending', externalReference: null });
    expect(db.state.audits).toEqual([]);
  });
  test('a failing audit write rolls back a refund update', async () => {
    const db = makeDb({ payments: [done(), refundRow()], failOn: 'audit' });
    await expect(store.completeRefund(db, refundEv())).rejects.toThrow('audit failed');
    expect(rowOf(db, 200).status).toBe('pending');
  });
  test('a failing lookup propagates and nothing is reported as applied', async () => {
    const db = makeDb({ failOn: 'read' });
    await expect(store.completePaymentFromCapture(db, capture())).rejects.toThrow('db down');
  });
  test('a non-unique audit error is never swallowed as "already recorded"', async () => {
    const db = makeDb({ payments: [pay()], failOn: 'audit' });
    await expect(store.completePaymentFromCapture(db, capture())).rejects.toThrow('audit failed');
  });
});

describe('static checks of the source', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/modules/payments/razorpay-payment.store.js'), 'utf8');
  test('creates no payment, no refund and no invoice change; no logging, no network, no application clock, no raw SQL of its own', () => {
    expect(source).not.toMatch(/payment\.create|\.create\(|invoice\.update|\.delete\(|deleteMany|\$executeRaw/);
    expect(source).not.toMatch(/console\.|fetch\(|require\('https?'\)|new Date\(\)|Date\.now/);
  });
  test('every raw statement is a SELECT ... FOR UPDATE current read (a plain read after the locks would see the transaction snapshot)', () => {
    const statements = [...source.matchAll(/\$queryRaw`([^`]*)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(statements.length).toBe(4); // payment, invoice, completed rows of an invoice, completed refunds of a payment
    for (const sql of statements) expect(sql).toMatch(/^SELECT .* FOR UPDATE$/);
  });
  test('the decision reads after the locks are current reads, never the transaction snapshot', async () => {
    const db = makeDb({ payments: [pay()] });
    await store.completePaymentFromCapture(db, capture());
    expect(db.state.reads.map((r) => r.table)).toEqual(['payments', 'invoices', 'payments']); // payment, invoice, completed totals
    const b = makeDb({ payments: [done(), refundRow()] });
    await store.completeRefund(b, refundEv());
    expect(b.state.reads.map((r) => r.table)).toEqual(['payments', 'payments', 'payments']); // refund, original, completed refunds
  });
  test('every guarded operation locks the invoice before any payment (static order)', () => {
    for (const fn of ['completePaymentFromCapture', 'settleRefund', 'flagUnknownRefund']) {
      const body = source.slice(source.indexOf(`function ${fn}`));
      const upTo = body.slice(0, body.indexOf('\n}\n'));
      expect(upTo.indexOf('lockInvoice(')).toBeGreaterThan(-1);
      expect(upTo.indexOf('lockInvoice(')).toBeLessThan(upTo.indexOf('lockPayment('));
    }
  });
  test('the Bitrix and inbox stores are not imported', () => {
    expect(source.replace(/\/\/.*$/gm, '')).not.toMatch(/require\([^)]*(bitrix|inbox)/);
  });
});
