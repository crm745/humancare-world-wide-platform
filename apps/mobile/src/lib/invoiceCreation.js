// The invoice of an ACCEPTED quotation (backend modules/quotations/quotation-invoice.service.js). The backend creates it right after the acceptance
// and again from a recovery job; this is the patient's own retry / refresh. Idempotent on the server: it returns the existing invoice and never
// changes the decision. Nothing here starts or completes a payment.
import { apiPost } from './api';

/** POST /quotations/:id/invoice. Resolves { invoice: { status: 'ready', invoiceNumber } }. */
export const ensureInvoice = (quotationId) => apiPost(`/quotations/${encodeURIComponent(String(quotationId))}/invoice`, {});

/** The retry as { ok: true, ready } or { ok: false, ready: false }; never throws. `ready`: the backend now has the invoice (the screen reloads to show it). */
export async function performEnsureInvoice(quotationId) {
  try {
    const result = await ensureInvoice(quotationId);
    return { ok: true, ready: Boolean(result && result.invoice && result.invoice.status === 'ready') };
  } catch {
    return { ok: false, ready: false };
  }
}
