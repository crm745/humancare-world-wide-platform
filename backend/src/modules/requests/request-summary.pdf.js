// The request summary PDF ("Download PDF" on the patient's Request Details screen): GET /requests/me/:id/summary.
//
// The content is decided in pdf/summary-model.js (pure, English only, only fields the patient may see) and drawn in pdf/summary-render.js (logo, title, meta panel, sections, documents,
// timeline, page numbers; Noto fonts for every script a patient may type). This file only joins the two and answers the request.
//
// ALWAYS ENGLISH: the PDF does not depend on the app's language. What the patient typed is printed as typed; every label, status and date is English.
// The document is built completely BEFORE anything is sent, so a failure is an ordinary error answer (never a half-sent file), and it is sent with its length.
const { buildSummaryModel, formatDateOnly } = require('./pdf/summary-model');
const { renderSummaryPdf } = require('./pdf/summary-render');

// A file name that is safe in a header and on every file system.
const safeFileName = (reference) => `${String(reference || 'request').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'request'}-summary.pdf`;

// Builds the PDF for `request` (the patient's own request row, as getRequestForUser returns it) and sends it on `res`. Resolves when it has been sent.
async function streamRequestSummaryPdf(res, request) {
  const model = buildSummaryModel(request);
  const pdf = await renderSummaryPdf(model);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(request.referenceNumber)}"`);
  res.setHeader('Content-Length', String(pdf.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(pdf);
}

module.exports = { streamRequestSummaryPdf, formatDateOnly, safeFileName };
