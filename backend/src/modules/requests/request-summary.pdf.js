const PDFDocument = require('pdfkit');
const { MOBILITY_LABEL, URGENCY_LABEL, EQUIPMENT } = require('../../common/constants/request.constants');
const { careLevelText } = require('../../common/utils/care-level');

// A date-only value (a preferred date, a date of death) is stored as that calendar day at 00:00 UTC.
// Read it in UTC: toDateString() uses the server's own timezone, so on a server west of UTC it
// printed the day before. Same layout as before ("Tue Nov 10 2026").
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${day} ${date.getUTCFullYear()}`;
}

function row(doc, label, value) {
  if (value === null || value === undefined || value === '') return;
  doc.fontSize(11).fillColor('#5B6B84').text(label, { continued: true });
  doc.fillColor('#0D2340').text(`  ${value}`);
}
//the function for requesting summary pdf
function streamRequestSummaryPdf(res, request) {
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${request.referenceNumber}-summary.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).fillColor('#1A73E8').text('HumanCare World Wide');
  doc.fontSize(10).fillColor('#5B6B84').text('Global Medical Assistance Company');
  doc.moveDown(1.5);

  doc.fontSize(14).fillColor('#0D2340').text(`Request Summary — ${request.referenceNumber}`);
  doc.fontSize(9).fillColor('#97A4B8').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  // Mortal Remains: the name on the request is the deceased's.
  const mortal = /^mortal(_|$)/.test(request.serviceKey || '');
  const day = (value) => (value ? formatDateOnly(value) : null);
  row(doc, mortal ? 'Deceased Name:' : 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter(Boolean).join(' / '));
  row(doc, 'Relation to the deceased:', request.deceasedRelation);
  row(doc, 'Place of death:', request.placeOfDeath);
  row(doc, 'Date of death:', day(request.dateOfDeath));
  row(doc, 'Service:', request.serviceType);
  row(doc, 'From:', request.origin);
  row(doc, 'To:', request.destination);
  row(doc, mortal ? 'Preferred transfer date:' : 'Date Of Service:', day(request.preferredDate));
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
  row(doc, 'Urgency:', URGENCY_LABEL[request.urgency]);
  if (request.description) row(doc, mortal ? 'Details:' : 'Condition & diagnosis:', request.description);
  // Keys read as English labels; so do the older translated labels, which the PDF's built-in font
  // cannot draw (Hindi, Marathi, Gujarati, Telugu and Arabic printed as garbage or not at all).
  row(doc, 'Care level:', careLevelText(request.careLevel, { translateLegacy: true }));
  row(doc, 'Patient mobility:', MOBILITY_LABEL[request.mobility]);
  row(doc, 'Required on board:', EQUIPMENT.filter(([field]) => request[field] === true).map(([, label]) => label).join(', '));

  const stageEvents = request.case && request.case.stageEvents;
  if (stageEvents && stageEvents.length) {
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#0D2340').text('Timeline');
    doc.moveDown(0.3);
    stageEvents.forEach((ev) => {
      doc.fontSize(10).fillColor('#5B6B84').text(`${new Date(ev.occurredAt).toLocaleString()}  —  `, { continued: true });
      doc.fillColor('#0D2340').text(`${ev.stage}${ev.note ? '  (' + ev.note + ')' : ''}`);
    });
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#97A4B8').text('"Your Care, Our Responsibility" — humancareworldwide.com');

  doc.end();
}

module.exports = { streamRequestSummaryPdf, formatDateOnly };
