// HTTP layer of the patient's quotation workflow. All rules live in patient-quotations.service.js. Every route is behind requireAuth(['patient']):
// an Admin, a corporate user or a missing token never reaches these, and the service checks that the quotation belongs to the signed-in patient.
const svc = require('./patient-quotations.service');
const invoiceSvc = require('./quotation-invoice.service');

const patient = (req) => ({ userId: req.user.id });
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// A blocked decision answers 409 with a code the app can branch on. The response is never cached.
function sendError(err, res, next) {
  if (err && err.statusCode === 409 && err.publicCode) return res.status(409).json({ error: err.message, code: err.publicCode });
  return next(err);
}

// GET /requests/me/:id/quotation -> { quotation, lastDecision }
async function getMyRequestQuotation(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await svc.getActiveQuotation({ ...patient(req), requestId: req.params.id }));
  } catch (err) { next(err); }
}

// The PDF: authenticated, owned, never cached, never sniffed, sandboxed; sent as a download.
async function downloadQuotationFile(req, res, next) {
  try {
    const { buffer, name } = await svc.resolvePatientQuotationFile({ ...patient(req), quotationId: req.params.id });
    res.set({ 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.set('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(buffer);
  } catch (err) { sendError(err, res, next); }
}

// After a committed acceptance the invoice is ensured in a SEPARATE step. Whatever happens there, the acceptance already stands: the response is still
// 200/201 with the quotation, plus `invoice` = { status: 'ready' | 'pending' } (pending: it is retried by POST /quotations/:id/invoice and by the recovery job).
async function invoiceStateAfterAcceptance(userId, quotationId) {
  try {
    await invoiceSvc.ensureInvoiceForPatient({ userId, quotationId });
    return { status: 'ready' };
  } catch {
    return { status: 'pending' }; // already logged and recorded for Operations by the service
  }
}

async function postAccept(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await svc.acceptQuotation({ ...patient(req), quotationId: req.params.id });
    const invoice = await invoiceStateAfterAcceptance(req.user.id, req.params.id);
    res.status(result.alreadyAccepted ? 200 : 201).json({ ...result, invoice });
  } catch (err) { sendError(err, res, next); }
}

// POST /quotations/:id/invoice: the patient's retry / refresh. Idempotent: 201 when it was created now, 200 when it already existed.
async function postEnsureInvoice(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const { created, invoice } = await invoiceSvc.ensureInvoiceForPatient({ ...patient(req), quotationId: req.params.id });
    res.status(created ? 201 : 200).json({ invoice: { status: 'ready', invoiceNumber: invoice.invoiceNumber } });
  } catch (err) { sendError(err, res, next); }
}

async function postReject(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await svc.rejectQuotation({ ...patient(req), quotationId: req.params.id, reason: body(req).reason });
    res.status(result.alreadyRejected ? 200 : 201).json(result);
  } catch (err) { sendError(err, res, next); }
}

module.exports = { getMyRequestQuotation, downloadQuotationFile, postAccept, postReject, postEnsureInvoice };
