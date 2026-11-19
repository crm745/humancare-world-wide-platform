// Pure shaping of one backend invoice (as returned in request.invoices — see backend patient-invoices.service.js —
// and by GET /invoices/:invoiceId) into what InvoicesSection/InvoiceCard render. Nothing here calls the API, and
// nothing here decides whether a payment may start: `payable` and `payableReason` are taken exactly as the backend
// sent them, never recomputed here.
import { formatMoney } from './money';

const INVOICE_STATUS_KEYS = { issued: 'invoice_status_issued', void: 'invoice_status_void' };

// Derived only for display: a simple, patient-facing summary of where the invoice's payment stands. Distinct from
// `statusKey` (the invoice's own lifecycle: issued / void).
//   paid      the balance is zero
//   pending   a Razorpay payment is already open (hasOpenPayment) and the balance isn't zero yet
//   partial   something has been paid, but not everything, and nothing is open
//   unpaid    nothing has been paid yet
const ZERO_AMOUNT = /^-?0+(\.0+)?$/;
const isZeroAmount = (text) => typeof text === 'string' && ZERO_AMOUNT.test(text.trim());

export function paymentStatusKey(invoice) {
  if (!invoice) return 'payment_status_unpaid';
  if (isZeroAmount(invoice.balance)) return 'payment_status_paid';
  if (invoice.hasOpenPayment) return 'payment_status_pending';
  if (!isZeroAmount(invoice.paid)) return 'payment_status_partial';
  return 'payment_status_unpaid';
}

const PAYABLE_REASON_KEYS = {
  payments_disabled: 'payable_reason_payments_disabled',
  invoice_not_payable: 'payable_reason_invoice_not_payable',
  fully_paid: 'payable_reason_fully_paid',
  quotation_not_active: 'payable_reason_quotation_not_active',
  invoice_overdue: 'payable_reason_invoice_overdue',
  currency_unsupported: 'payable_reason_currency_unsupported',
};

// The i18n key for the backend's `payableReason`, or null when the invoice is payable (nothing to explain) or the
// backend sent no reason at all. An unrecognised reason code still gets a safe, generic explanation rather than
// nothing — a stricter/newer backend code should never silently show no reason.
export function payableReasonKey(invoice) {
  if (!invoice || invoice.payable || !invoice.payableReason) return null;
  return PAYABLE_REASON_KEYS[invoice.payableReason] || 'payable_reason_invoice_not_payable';
}

/** One backend invoice -> { id, invoiceNumber, issueDate, amountDisplay, paidDisplay, balanceDisplay, currency, dueDate, statusKey,
 * paymentStatusKey, payable, payableReasonKey }. `amountDisplay`/`paidDisplay`/`balanceDisplay` are ready to render
 * (currency symbol + grouping, see lib/money.js); `dueDate` stays the raw ISO date (or null) so the caller formats
 * it with the app's own locale, the same as every other date on this screen. */
export function shapeInvoice(invoice) {
  if (!invoice || typeof invoice.id === 'undefined') return null;
  return {
    id: invoice.id,
    // The human invoice number the backend issued (e.g. INV-CASE-4037-V1), or null for an older invoice that has none (the card then falls back to the id).
    invoiceNumber: typeof invoice.invoiceNumber === 'string' && invoice.invoiceNumber ? invoice.invoiceNumber : null,
    issueDate: invoice.issueDate || null,
    amountDisplay: formatMoney(invoice.amount, invoice.currency),
    paidDisplay: formatMoney(invoice.paid, invoice.currency),
    balanceDisplay: formatMoney(invoice.balance, invoice.currency),
    currency: invoice.currency,
    dueDate: invoice.dueDate || null,
    statusKey: INVOICE_STATUS_KEYS[invoice.status] || 'invoice_status_issued',
    paymentStatusKey: paymentStatusKey(invoice),
    payable: invoice.payable === true,
    payableReasonKey: payableReasonKey(invoice),
  };
}

// request.invoices (or any list of backend invoices) -> the shaped list, in the same order; anything not shaped
// into a usable row (shapeInvoice returning null) is dropped rather than rendered as a blank card.
export function shapeInvoices(invoices) {
  return Array.isArray(invoices) ? invoices.map(shapeInvoice).filter(Boolean) : [];
}

// The accepted quotation whose invoice the backend has not created yet (request.invoicePending, with invoicePendingQuotationId), as
// { quotationId }, or null. A request that already shows an invoice for it is never pending.
export function pendingInvoice(request) {
  if (!request || request.invoicePending !== true) return null;
  const quotationId = Number(request.invoicePendingQuotationId);
  return Number.isInteger(quotationId) && quotationId > 0 ? { quotationId } : null;
}
