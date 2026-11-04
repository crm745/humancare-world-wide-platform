const PDFDocument = require('pdfkit');
const { MOBILITY_LABEL, URGENCY_LABEL, EQUIPMENT } = require('../../common/constants/request.constants');

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
  const day = (value) => (value ? new Date(value).toDateString() : null);
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
  row(doc, 'Care level:', request.careLevel);
  row(doc, 'Patient mobility:', MOBILITY_LABEL[request.mobility]);
  row(doc, 'Required on board:', EQUIPMENT.filter(([field]) => request[field] === true).map(([, label]) => label).join(', '));
  if (request.specialRequirements) row(doc, 'Special Requirements:', request.specialRequirements);

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

module.exports = { streamRequestSummaryPdf };
