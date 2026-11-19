const PDFDocument = require('pdfkit');
const { MOBILITY_LABEL, URGENCY_LABEL, EQUIPMENT } = require('../../common/constants/request.constants');
const { careLevelText } = require('../../common/utils/care-level');
const { BRAND_PRIMARY } = require('../../common/constants/brand');
const { SCOPES, MODES, userDetailsOf } = require('./mortal-remains.validation');
const { HOURS, CARETAKERS, parseHomeDescription, isNewHomeFormat } = require('./home-healthcare.validation');
const { SCOPES: MVT_SCOPES, mvtFieldsOf, isNewMvtFormat, OTHER_SPECIALTY } = require('./medical-value-travel.validation');
const { SCOPES: TELE_SCOPES, TYPES: TELE_TYPES } = require('./tele-consultation.validation');
const { PROGRAMMES: CORPORATE_PROGRAMMES, corporateFieldsOf, isNewCorporateFormat } = require('./corporate-medical.validation');
const { SCOPES: MARINE_SCOPES, parseMarineDescription, isNewMarineFormat } = require('./marine-medical-safety.validation');

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
// Home Healthcare (new format): the answered care selections come from their columns; the exact address and Medical History from the parsed description.
function homeRows(doc, request) {
  const parsed = parseHomeDescription(request.description);
  const caretakers = String(request.caretakerTypes || '').split(',').map((key) => CARETAKERS[key]).filter(Boolean).join(', ');
  const oxygen = request.equipOxygen === true ? `Yes${request.equipOxygenLpm != null ? ` (${request.equipOxygenLpm} LPM)` : ''}` : request.equipOxygen === false ? 'No' : null;
  row(doc, 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter(Boolean).join(' / '));
  row(doc, 'Service:', request.serviceType);
  row(doc, 'Home address:', parsed.address);
  row(doc, 'Service Date:', request.preferredDate ? formatDateOnly(request.preferredDate) : null);
  row(doc, 'Nurse / Caretaker:', caretakers);
  row(doc, 'Care Requirement:', HOURS[request.careRequirement]);
  row(doc, 'Care Level:', request.careLevel);
  row(doc, 'Oxygen:', oxygen);
  row(doc, 'Medical History:', parsed.history);
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
}

// Medical Value Travel (new format): the scope is its own column (shown as "Treatment scope"); the specialty and the Medical History come from the parsed description.
function mvtRows(doc, request) {
  const parsed = mvtFieldsOf(request); // the columns, or the v1 description of a request made before them
  const specialty = parsed.specialty === OTHER_SPECIALTY ? `Other (${parsed.other})` : parsed.specialty;
  row(doc, 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter((v) => v !== null && v !== undefined && v !== '').join(' / '));
  row(doc, 'Service:', request.serviceType);
  row(doc, 'Treatment scope:', MVT_SCOPES[request.transferScope]);
  row(doc, 'Specialty:', specialty);
  row(doc, 'Current city:', request.origin);
  row(doc, 'Destination city:', request.destination);
  row(doc, 'Preferred treatment date:', request.preferredDate ? formatDateOnly(request.preferredDate) : null);
  row(doc, 'Medical History:', parsed.history);
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
}

// Corporate Medical Solutions (employee-submitted, structured): the company, the employee count, the employee and gender, the programmes (one name each, comma-
// separated) and the two optional requirements. No From / To, no urgency.
function corporateRows(doc, request) {
  const parsed = corporateFieldsOf(request);
  row(doc, 'Company Name:', parsed.companyName);
  row(doc, 'No. of Employees:', parsed.employeeCount);
  row(doc, 'Name of Employee:', request.patientName);
  row(doc, 'Gender:', request.patientGender);
  // Patient Contact, Preferred Date, Office Address and Office Country: only when the request has them (one saved before they existed prints without them). The Office Country is
  // the company office's country, labelled as such (the country column means the patient's country on other services).
  row(doc, 'Patient Contact:', parsed.patientContact);
  row(doc, 'Preferred Date:', parsed.preferredDate ? formatDateOnly(parsed.preferredDate) : null);
  row(doc, 'Office Address:', parsed.officeAddress);
  row(doc, 'Office Country:', parsed.officeCountry);
  row(doc, 'Service:', request.serviceType);
  row(doc, 'Programmes:', parsed.programmes.map((key) => CORPORATE_PROGRAMMES[key]).join(', '));
  row(doc, 'Any Requirement:', parsed.anyRequirement);
  row(doc, 'Special Requirement:', parsed.specialRequirement);
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
}

// Teleconsultation (a request with the consultation_type column): the type and, for a House Call, the scope are their own columns; the address is the origin column; the
// description holds the two notes ("Present medical issue" / "Allergic issue" sections), printed as they are.
function teleRows(doc, request) {
  row(doc, 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter((v) => v !== null && v !== undefined && v !== '').join(' / '));
  row(doc, 'Service:', request.serviceType);
  row(doc, 'Consultation type:', TELE_TYPES[request.consultationType]);
  row(doc, 'Scope:', TELE_SCOPES[request.transferScope]);
  row(doc, 'Current address:', request.origin);
  row(doc, 'Visit date:', request.preferredDate ? formatDateOnly(request.preferredDate) : null);
  row(doc, 'Medical details:', request.description);
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
}

// Marine Medical Safety (new format): the scope is its own column (shown as "Service scope"); the Medical History comes from the parsed description; the Critical
// Level (keys read as English names) and Oxygen (with its flow rate) from their columns. Oxygen is left out when it was not answered.
function marineRows(doc, request) {
  const parsed = parseMarineDescription(request.description);
  const oxygen = request.equipOxygen === true
    ? `Yes${request.equipOxygenLpm !== null && request.equipOxygenLpm !== undefined ? ` (${request.equipOxygenLpm} LPM)` : ''}`
    : request.equipOxygen === false ? 'No' : null;
  row(doc, 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter((v) => v !== null && v !== undefined && v !== '').join(' / '));
  row(doc, 'Service:', request.serviceType);
  row(doc, 'Service scope:', MARINE_SCOPES[request.transferScope]);
  row(doc, 'Origin:', request.origin);
  row(doc, 'Destination:', request.destination);
  row(doc, 'Date of service:', request.preferredDate ? formatDateOnly(request.preferredDate) : null);
  row(doc, 'Critical level:', careLevelText(request.careLevel));
  row(doc, 'Oxygen:', oxygen);
  row(doc, 'Medical History:', parsed.history);
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
}

//the function for requesting summary pdf
function streamRequestSummaryPdf(res, request) {
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${request.referenceNumber}-summary.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).fillColor(BRAND_PRIMARY).text('HumanCare World Wide');
  doc.fontSize(10).fillColor('#5B6B84').text('Global Medical Assistance Company');
  doc.moveDown(1.5);

  doc.fontSize(14).fillColor('#0D2340').text(`Request Summary — ${request.referenceNumber}`);
  doc.fontSize(9).fillColor('#97A4B8').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  // A NEW-format Home Healthcare request (key homecare and a complete v1 description) has its own layout: no From / To, no urgency. Anything else,
  // including a Home Healthcare request without the marker, is printed exactly as before.
  if (isNewHomeFormat(request)) {
    homeRows(doc, request);
  } else if (isNewMvtFormat(request)) {
    mvtRows(doc, request);
  } else if (isNewMarineFormat(request)) {
    marineRows(doc, request);
  } else if (isNewCorporateFormat(request)) {
    corporateRows(doc, request);
  } else if (request.serviceKey === 'tele' &&Object.hasOwn(TELE_TYPES, request.consultationType || '')) {
    teleRows(doc, request);
  } else {
  // Mortal Remains: the name on the request is the deceased's.
  const mortal = /^mortal(_|$)/.test(request.serviceKey || '');
  const day = (value) => (value ? formatDateOnly(value) : null);
  row(doc, mortal ? "Deceased Person's Name:" : 'Patient Name:', request.patientName);
  row(doc, 'Age / Gender:', [request.patientAge, request.patientGender].filter(Boolean).join(' / '));
  row(doc, 'Relation to the deceased:', request.deceasedRelation);
  row(doc, 'Place of death:', request.placeOfDeath);
  row(doc, 'Date of death:', day(request.dateOfDeath));
  row(doc, 'Service:', request.serviceType);
  // Mortal Remains: the scope and mode have their own columns (a request made before them has none).
  row(doc, 'Transfer scope:', SCOPES[request.transferScope]);
  row(doc, 'Transport mode:', MODES[request.transportMode]);
  // Commercial Air: Stretcher or Wheelchair (it is the end of the service key).
  const travel = /^commercialair_(stretcher|wheelchair)$/.exec(request.serviceKey || '');
  row(doc, 'Travel type:', travel ? travel[1].charAt(0).toUpperCase() + travel[1].slice(1) : null);
  row(doc, 'From:', request.origin);
  row(doc, 'To:', request.destination);
  row(doc, mortal ? 'Preferred transfer date:' : 'Date Of Service:', day(request.preferredDate));
  row(doc, 'Status:', request.status);
  row(doc, 'Submitted:', new Date(request.createdAt).toLocaleString());
  row(doc, 'Urgency:', URGENCY_LABEL[request.urgency]);
  // Mortal Remains: only the user's own Details; the composed scope and mode lines are printed as the two rows above.
  const details = mortal ? userDetailsOf(request.description) : request.description;
  if (details) row(doc, mortal ? 'Details:' : 'Condition & diagnosis:', details);
  // Keys read as English labels; so do the older translated labels, which the PDF's built-in font
  // cannot draw (Hindi, Marathi, Gujarati, Telugu and Arabic printed as garbage or not at all).
  row(doc, 'Care level:', careLevelText(request.careLevel, { translateLegacy: true }));
  row(doc, 'Patient mobility:', MOBILITY_LABEL[request.mobility]);
  // Commercial Air: the oxygen flow rate follows "Oxygen" ("Oxygen (4 LPM)"); other services have none.
  const onBoard = EQUIPMENT.filter(([field]) => request[field] === true)
    .map(([field, label]) => (field === 'equipOxygen' && request.equipOxygenLpm != null ? `${label} (${request.equipOxygenLpm} LPM)` : label));
  row(doc, 'Required on board:', onBoard.join(', '));
  }

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
