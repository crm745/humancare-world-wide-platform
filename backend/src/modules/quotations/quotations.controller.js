// HTTP layer of the Operations quotation management. All rules live in quotations.service.js. Mounted on the Admin router, so every route is behind
// requireAdminAuth(['admin']): an Admin or a Superadmin session, nothing else (a patient, a corporate user or a missing token never reaches these).
const svc = require('./quotations.service');
const invoiceSvc = require('./quotation-invoice.service');

const actor = (req) => ({ adminId: req.user.id, adminRole: req.user.adminRole });
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// Blocked actions answer 409 with the code and what blocks them (the Portal shows these, never a guess).
function sendError(err, res, next) {
  if (err && err.statusCode === 409 && err.publicCode) {
    return res.status(409).json({ error: err.message, code: err.publicCode, ...(err.blockers ? { blockers: err.blockers } : {}), ...(err.currentRevision != null ? { currentRevision: err.currentRevision } : {}) });
  }
  return next(err);
}

async function getCaseQuotations(req, res, next) {
  try { res.json(await svc.listCaseQuotations({ caseId: req.params.id })); } catch (err) { next(err); }
}
async function getQuotation(req, res, next) {
  try { res.json({ quotation: await svc.getQuotation({ quotationId: req.params.id }) }); } catch (err) { next(err); }
}

// The PDF: never cached, never sniffed, sandboxed. `?disposition=inline` lets the Portal open it for viewing; the default is a download.
async function downloadQuotationFile(req, res, next) {
  try {
    const { buffer, name } = await svc.resolveQuotationFile({ quotationId: req.params.id, ...actor(req) });
    res.set({ 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.set('Content-Disposition', `${req.query.disposition === 'inline' ? 'inline' : 'attachment'}; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(buffer);
  } catch (err) { sendError(err, res, next); }
}

async function postConfirm(req, res, next) {
  try {
    const result = await svc.confirmQuotation({ quotationId: req.params.id, revision: body(req).revision, ...actor(req) });
    res.status(result.alreadyConfirmed ? 200 : 201).json(result);
  } catch (err) { sendError(err, res, next); }
}
async function postPublish(req, res, next) {
  try {
    const result = await svc.publishQuotation({ quotationId: req.params.id, revision: body(req).revision, validUntil: body(req).validUntil, ...actor(req) });
    res.status(result.alreadyPublished ? 200 : 201).json(result);
  } catch (err) { sendError(err, res, next); }
}
async function postWithdraw(req, res, next) {
  try {
    const result = await svc.withdrawQuotation({ quotationId: req.params.id, revision: body(req).revision, reason: body(req).reason, ...actor(req) });
    res.status(result.alreadyWithdrawn ? 200 : 201).json(result);
  } catch (err) { sendError(err, res, next); }
}
async function postNewVersion(req, res, next) {
  try { res.status(201).json(await svc.createNewVersion({ quotationId: req.params.id, revision: body(req).revision, ...actor(req) })); } catch (err) { sendError(err, res, next); }
}

// Phase 4 (invoice). Operations: accepted quotations that still have no invoice (a creation failure not yet retried), a manual retry, and the Admin
// authorization of a partial payment (records this Admin and the time). All idempotent.
async function getAwaitingInvoice(req, res, next) {
  try { res.set('Cache-Control', 'no-store'); res.json({ quotations: await invoiceSvc.listAcceptedWithoutInvoice() }); } catch (err) { next(err); }
}
async function postEnsureInvoice(req, res, next) {
  try {
    const { created, invoice } = await invoiceSvc.ensureInvoiceForQuotation({ quotationId: req.params.id });
    res.status(created ? 201 : 200).json({ created, invoice });
  } catch (err) { sendError(err, res, next); }
}
async function postPartialPayment(req, res, next) {
  try {
    const result = await invoiceSvc.authorizePartialPayment({ invoiceId: req.params.id, ...actor(req) });
    res.status(result.alreadyAuthorized ? 200 : 201).json(result);
  } catch (err) { sendError(err, res, next); }
}

module.exports = { getAwaitingInvoice, postEnsureInvoice, postPartialPayment, getCaseQuotations, getQuotation, downloadQuotationFile, postConfirm, postPublish, postWithdraw, postNewVersion };
