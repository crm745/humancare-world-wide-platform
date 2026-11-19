/* global describe, test, expect */
const { shapeInvoice, shapeInvoices, paymentStatusKey, payableReasonKey, pendingInvoice } = require('../invoiceView');

const base = {
  id: 761, status: 'issued', amount: '1500.00', currency: 'INR', dueDate: '2026-12-01',
  paid: '1500.00', balance: '0.00', payable: false, payableReason: 'fully_paid', hasOpenPayment: false, payments: [],
};

describe('shapeInvoice', () => {
  test('shapes a fully paid invoice (matches Invoice 761 in humancare_test)', () => {
    const shaped = shapeInvoice(base);
    expect(shaped).toEqual({
      id: 761,
      invoiceNumber: null,
      issueDate: null,
      amountDisplay: '₹1,500.00',
      paidDisplay: '₹1,500.00',
      balanceDisplay: '₹0.00',
      currency: 'INR',
      dueDate: '2026-12-01',
      statusKey: 'invoice_status_issued',
      paymentStatusKey: 'payment_status_paid',
      payable: false,
      payableReasonKey: 'payable_reason_fully_paid',
    });
  });
  test('a void invoice maps to invoice_status_void', () => {
    expect(shapeInvoice({ ...base, status: 'void' }).statusKey).toBe('invoice_status_void');
  });
  test('an unrecognised invoice status falls back to invoice_status_issued', () => {
    expect(shapeInvoice({ ...base, status: 'draft' }).statusKey).toBe('invoice_status_issued');
  });
  test('a missing due date stays null (the caller omits the row)', () => {
    expect(shapeInvoice({ ...base, dueDate: null }).dueDate).toBeNull();
  });
  test('null/invalid input is shaped to null, not thrown', () => {
    expect(shapeInvoice(null)).toBeNull();
    expect(shapeInvoice({})).toBeNull();
  });
});

describe('paymentStatusKey', () => {
  test('a zero balance is paid, even with hasOpenPayment left over from the gateway', () => {
    expect(paymentStatusKey({ balance: '0.00', paid: '1500.00', hasOpenPayment: false })).toBe('payment_status_paid');
  });
  test('an open payment with a remaining balance is pending', () => {
    expect(paymentStatusKey({ balance: '500.00', paid: '1000.00', hasOpenPayment: true })).toBe('payment_status_pending');
  });
  test('something paid, nothing open, balance remaining is partial', () => {
    expect(paymentStatusKey({ balance: '500.00', paid: '1000.00', hasOpenPayment: false })).toBe('payment_status_partial');
  });
  test('nothing paid and nothing open is unpaid', () => {
    expect(paymentStatusKey({ balance: '1500.00', paid: '0.00', hasOpenPayment: false })).toBe('payment_status_unpaid');
  });
});

describe('payableReasonKey', () => {
  test('null when the invoice is payable', () => {
    expect(payableReasonKey({ payable: true, payableReason: null })).toBeNull();
  });
  test('maps every backend reason code to its translation key', () => {
    const reasons = ['payments_disabled', 'invoice_not_payable', 'fully_paid', 'quotation_not_active', 'invoice_overdue', 'currency_unsupported'];
    for (const reason of reasons) {
      expect(payableReasonKey({ payable: false, payableReason: reason })).toBe(`payable_reason_${reason}`);
    }
  });
  test('an unrecognised reason code still gets a safe generic key, never null', () => {
    expect(payableReasonKey({ payable: false, payableReason: 'some_future_reason' })).toBe('payable_reason_invoice_not_payable');
  });
});

describe('shapeInvoices', () => {
  test('shapes every invoice in order and drops anything unusable', () => {
    const shaped = shapeInvoices([base, { ...base, id: 762, status: 'void' }, null, {}]);
    expect(shaped.map((i) => i.id)).toEqual([761, 762]);
  });
  test('a missing or non-array input is an empty list, never a throw', () => {
    expect(shapeInvoices(undefined)).toEqual([]);
    expect(shapeInvoices(null)).toEqual([]);
  });
});

describe('invoice number, issue date and the pending state (Phase 4)', () => {
  test('the invoice number and issue date the backend sent are kept; the internal id is only a fallback', () => {
    const shaped = shapeInvoice({ ...base, invoiceNumber: 'INV-CASE-4037-V1', issueDate: '2030-01-02', quotationVersion: 1, status: 'issued', balance: '1500.00', paid: '0.00', payable: false, payableReason: 'payments_disabled' });
    expect(shaped).toMatchObject({ invoiceNumber: 'INV-CASE-4037-V1', issueDate: '2030-01-02', statusKey: 'invoice_status_issued', paymentStatusKey: 'payment_status_unpaid' });
    expect(shapeInvoice({ ...base, invoiceNumber: '' }).invoiceNumber).toBeNull();
  });
  test('no Pay Now is implied: payable comes only from the backend', () => {
    expect(shapeInvoice({ ...base, invoiceNumber: 'INV-1', payable: false, payableReason: 'payments_disabled', balance: '1500.00', paid: '0.00' }).payable).toBe(false);
  });
  test('pendingInvoice needs invoicePending === true and a valid quotation id', () => {
    expect(pendingInvoice({ invoicePending: true, invoicePendingQuotationId: 9 })).toEqual({ quotationId: 9 });
    expect(pendingInvoice({ invoicePending: false, invoicePendingQuotationId: 9 })).toBeNull();
    expect(pendingInvoice({ invoicePending: true })).toBeNull();
    expect(pendingInvoice({ invoicePending: true, invoicePendingQuotationId: 'x' })).toBeNull();
    expect(pendingInvoice(null)).toBeNull();
  });
});
