import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../../state/AppContext';
import { pendingInvoice, shapeInvoices } from '../../lib/invoiceView';
import { performEnsureInvoice } from '../../lib/invoiceCreation';
import { usePayment } from '../../lib/usePayment';
import { formatDisplayDate } from '../../lib/requestShape';
import { Button, Card, InfoRow, Text } from '../ui';

const INVOICE_STATUS_TONE = {
  invoice_status_issued: 'bg-primary-soft text-primary-dark',
  invoice_status_void: 'bg-cancel-soft text-cancel',
};
const PAYMENT_STATUS_TONE = {
  payment_status_paid: 'bg-success-soft text-success',
  payment_status_partial: 'bg-warning-soft text-warning',
  payment_status_pending: 'bg-warning-soft text-warning',
  payment_status_unpaid: 'bg-cancel-soft text-cancel',
};

function StatusChip({ labelKey, tone }) {
  const { t } = useApp();
  const [bg, fg] = (tone[labelKey] || 'bg-primary-soft text-primary-dark').split(' ');
  return (
    <View className={`rounded-full px-2.5 py-1 ${bg}`}>
      <Text className={`font-inter-black text-[11px] uppercase tracking-wide ${fg}`}>{t(labelKey)}</Text>
    </View>
  );
}

const MESSAGE_TONE = { paid: 'text-success', confirming: 'text-warning', cancelled: 'text-faint', failed: 'text-cancel', uncertain: 'text-warning', error: 'text-cancel' };

// Pay Now and the state of the payment, under one invoice. Pay Now is shown only when the backend says `payable === true`;
// it is disabled while an attempt runs, and hidden while Checkout is waiting for the backend to confirm (paying again then
// could pay twice). "Paid" is shown only after the backend confirms it (see lib/payments.js).
function PaySection({ invoice, raw, requestId, onChanged, t }) {
  const pay = usePayment({ invoice: { id: raw.id, balance: raw.balance }, requestId, onChanged });
  const { phase } = pay;
  const message =
    phase === 'paid' ? t(pay.fullyPaid ? 'payment_success_full' : 'payment_success_partial')
      : phase === 'confirming' ? t('payment_confirming')
      : pay.messageKey ? t(pay.messageKey) : null;
  const showButton = invoice.payable && phase !== 'paid' && phase !== 'confirming';
  if (!message && !showButton && phase !== 'working') return null;
  return (
    <View className="mt-3">
      {phase === 'working' && <Text className="mb-2.5 text-[12.5px] leading-[18px] text-faint">{t('payment_working')}</Text>}
      {!!message && phase !== 'working' && (
        <Text accessibilityLiveRegion="polite" className={`mb-2.5 text-[12.5px] leading-[18px] ${MESSAGE_TONE[phase] || 'text-faint'}`}>{message}</Text>
      )}
      {showButton && <Button title={t('btn_pay_now')} onPress={pay.pay} loading={pay.working} disabled={pay.working} />}
      {phase === 'confirming' && <Button title={t('btn_check_again')} variant="outline" onPress={pay.check} />}
    </View>
  );
}

// One invoice: amount, paid, balance, due date (when the backend has one), the invoice's own status and a
// patient-facing payment status, then Pay Now / the payment's state. A non-payable invoice (payable: false) shows
// the backend's reason as plain text underneath, in the exact words the app gets from `payableReason`.
function InvoiceRow({ invoice, raw, requestId, onChanged, last, t }) {
  return (
    <View className={last ? '' : 'mb-4 border-b border-divider pb-4'}>
      <View className="mb-2.5 flex-row items-center justify-between gap-2">
        <Text className="font-inter-bold text-[13.5px] text-navy">{invoice.invoiceNumber || `${t('lbl_invoice_number')} ${invoice.id}`}</Text>
        <StatusChip labelKey={invoice.statusKey} tone={INVOICE_STATUS_TONE} />
      </View>
      <InfoRow label={t('lbl_invoice_amount')} value={invoice.amountDisplay} />
      <InfoRow label={t('lbl_invoice_paid')} value={invoice.paidDisplay} />
      <InfoRow label={t('lbl_invoice_balance')} value={invoice.balanceDisplay} />
      {!!invoice.issueDate && <InfoRow label={t('lbl_invoice_issue_date')} value={formatDisplayDate(invoice.issueDate)} />}
      {!!invoice.dueDate && <InfoRow label={t('lbl_invoice_due_date')} value={formatDisplayDate(invoice.dueDate)} />}
      <InfoRow last label={t('lbl_payment_status')} valueNode={<StatusChip labelKey={invoice.paymentStatusKey} tone={PAYMENT_STATUS_TONE} />} />
      {!invoice.payable && !!invoice.payableReasonKey && (
        <Text className="mt-2.5 text-[12.5px] leading-[18px] text-faint">{t(invoice.payableReasonKey)}</Text>
      )}
      <PaySection invoice={invoice} raw={raw} requestId={requestId} onChanged={onChanged} t={t} />
    </View>
  );
}

// The invoice of an accepted quotation that the backend has not created yet (request.invoicePending). The acceptance already stands; the backend retries on
// its own, and this asks it once as soon as the card shows and again on Refresh (both idempotent: the backend returns the existing invoice). When the
// backend answers that the invoice exists, the request is reloaded so the real invoice card replaces this one. No payment is offered here.
function PendingInvoice({ quotationId, onChanged, t }) {
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await performEnsureInvoice(quotationId);
    if (alive.current) setBusy(false);
    if (outcome.ready && onChanged) onChanged();
  };
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once per card
  }, []);
  return (
    <View>
      <Text className="font-inter-bold text-[13.5px] text-navy">{t('invoice_pending_title')}</Text>
      <Text accessibilityLiveRegion="polite" className="mb-2.5 mt-1.5 text-[12.5px] leading-[18px] text-faint">{t('invoice_pending_body')}</Text>
      <Button title={t('btn_refresh_invoice')} variant="outline" onPress={check} loading={busy} disabled={busy} />
    </View>
  );
}

// The patient's invoices for this request (request.invoices — already part of GET /requests/me/:id, see
// backend patient-invoices.service.js). Renders nothing for a request with no invoices (most services), unless an accepted quotation is still waiting
// for its invoice (request.invoicePending): then a clear pending state with a refresh.
export default function InvoicesSection({ request, onChanged, className = 'mt-5' }) {
  const { t } = useApp();
  const invoices = shapeInvoices(request?.invoices);
  const pending = invoices.length ? null : pendingInvoice(request);
  if (!invoices.length && !pending) return null;
  if (pending) {
    return (
      <Card className={`p-[18px] ${className}`}>
        <Text className="mb-3.5 font-inter-black text-[14.5px] text-navy">{t('invoices_section_title')}</Text>
        <PendingInvoice quotationId={pending.quotationId} onChanged={onChanged} t={t} />
      </Card>
    );
  }
  return (
    <Card className={`p-[18px] ${className}`}>
      <Text className="mb-3.5 font-inter-black text-[14.5px] text-navy">{t('invoices_section_title')}</Text>
      {invoices.map((invoice, i) => (
        <InvoiceRow key={invoice.id} invoice={invoice} raw={request.invoices.find((x) => x && x.id === invoice.id)} requestId={request.id} onChanged={onChanged} last={i === invoices.length - 1} t={t} />
      ))}
    </Card>
  );
}
