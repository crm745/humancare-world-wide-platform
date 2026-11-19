/* global describe, test, expect */
const i18n = require('../../data/i18n.json');

// The new invoice-display keys (Stage A). Every one of them must exist, as a non-empty string, in all six
// locales — a missing translation silently falls back to the English text (see lib/translate.js), which would
// never be caught by a screen-level check.
const INVOICE_KEYS = [
  'invoices_section_title',
  'lbl_invoice_number', 'lbl_invoice_amount', 'lbl_invoice_paid', 'lbl_invoice_balance', 'lbl_invoice_due_date',
  'lbl_invoice_status', 'lbl_payment_status',
  'invoice_status_issued', 'invoice_status_void',
  'payment_status_paid', 'payment_status_partial', 'payment_status_pending', 'payment_status_unpaid',
  'payable_reason_payments_disabled', 'payable_reason_invoice_not_payable', 'payable_reason_fully_paid',
  'lbl_invoice_issue_date', 'invoice_pending_title', 'invoice_pending_body', 'btn_refresh_invoice',
  'payable_reason_quotation_not_active', 'payable_reason_invoice_overdue', 'payable_reason_currency_unsupported',
];

// Stage B: Pay Now and the payment messages.
const PAYMENT_KEYS = [
  'btn_pay_now', 'btn_check_again', 'payment_working', 'payment_confirming', 'payment_success_full', 'payment_success_partial',
  'payment_cancelled', 'payment_failed', 'payment_uncertain', 'payment_checkout_failed', 'payment_browser_failed',
  'payment_order_closed', 'payment_rate_limited', 'payment_no_open', 'payment_error_generic', 'payment_returning',
];

describe('payment translation keys', () => {
  test('every payment key exists, as non-empty text, in EN, HI, MR, GU, TE and AR', () => {
    for (const code of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of PAYMENT_KEYS) {
        expect(typeof i18n[code][key]).toBe('string');
        expect(i18n[code][key].length).toBeGreaterThan(0);
      }
    }
  });
});

describe('invoice display translation keys', () => {
  test('every invoice key exists, as non-empty text, in EN, HI, MR, GU, TE and AR', () => {
    for (const code of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of INVOICE_KEYS) {
        expect(typeof i18n[code][key]).toBe('string');
        expect(i18n[code][key].length).toBeGreaterThan(0);
      }
    }
  });
});
