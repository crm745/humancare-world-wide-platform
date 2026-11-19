// POST /invoices/:invoiceId/payment-orders. All rules live in payment-orders.service.js. Errors are thrown with a fixed message and a
// public code and answered by the global error handler (app.js), which never sends an internal detail. The response is never cached.
const { createPaymentOrder, fail } = require('./payment-orders.service');
const { getInvoiceForPatient } = require('./patient-invoices.service');

// True when the request actually carries a body (Content-Length above zero, or a chunked transfer).
const hasRequestBody = (req) => Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined;

async function postPaymentOrder(req, res) {
  res.set('Cache-Control', 'no-store'); // also on errors
  // Express leaves req.body undefined when it did not PARSE the body (a content type other than JSON). That must never be read as an
  // empty request, which means "full payment": a client that meant a partial amount would be charged the whole balance. An
  // intentionally empty request (no body at all) still defaults to full payment.
  if (req.body === undefined && hasRequestBody(req)) throw fail('request_invalid');
  const result = await createPaymentOrder({
    userId: Number(req.user.id),
    invoiceId: req.params.invoiceId,
    idempotencyKey: req.get('Idempotency-Key'),
    body: req.body,
  });
  if (result.outcome === 'uncertain') {
    // Razorpay may or may not have created the order yet. The same request, retried with the same Idempotency-Key, resolves it.
    return res.status(202).json({ code: 'gateway_uncertain', error: result.message, paymentId: result.paymentId, invoiceId: result.invoiceId });
  }
  return res.status(result.created ? 201 : 200).json(result.payload);
}

// GET /invoices/:invoiceId : the patient's own invoice and the status of its payments (what the app polls after Checkout). Read only.
async function getInvoice(req, res) {
  res.set('Cache-Control', 'no-store');
  const invoice = await getInvoiceForPatient({ userId: Number(req.user.id), invoiceId: req.params.invoiceId });
  return res.status(200).json({ invoice });
}

module.exports = { postPaymentOrder, getInvoice };
