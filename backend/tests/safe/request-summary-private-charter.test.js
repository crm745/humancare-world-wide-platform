/* global describe, test, expect, jest */
// The request summary PDF for a PRIVATE CHARTER request made with the revised form (pdf/summary-model.js, drawn by pdf/summary-render.js, sent by request-summary.pdf.js): Travel type,
// Critical Level (a list, in the form's own order) and Oxygen Required (with its flow rate only for Yes). Older Private Charter rows (care level, mobility, urgency) and every other service are
// shown as they always were. The model is the pure function that decides WHAT the patient sees; one test also runs the real renderer and the real streaming function. No database, no network.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { buildSummaryModel } = require('../../src/modules/requests/pdf/summary-model');
const { renderSummaryPdf } = require('../../src/modules/requests/pdf/summary-render');
const { streamRequestSummaryPdf } = require('../../src/modules/requests/request-summary.pdf');

const BASE = {
  id: 7, serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', referenceNumber: 'REQ-1007', status: 'submitted', createdAt: new Date('2026-11-20T08:00:00Z'),
  patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567', country: 'AE', origin: 'Mumbai, India', destination: 'Dubai, United Arab Emirates',
  preferredDate: new Date('2026-12-01T00:00:00Z'), description: 'Post-angioplasty, stable.',
};
const NEW_FORM = { ...BASE, travelType: 'organ_transfer', criticalLevel: 'icu,ecmo', oxygenRequired: true, oxygenFlowLpm: 4 };

// label -> value, per section title, for the whole model
function rowsOf(request) {
  const model = buildSummaryModel(request);
  const bySection = {};
  const flat = {};
  for (const section of model.sections) {
    bySection[section.title] = Object.fromEntries(section.rows.map((r) => [r.label, r.value]));
    for (const r of section.rows) flat[r.label] = r.value;
  }
  return { model, bySection, flat, labels: model.sections.flatMap((s) => s.rows.map((r) => r.label)) };
}

describe('the revised Private Charter form in the PDF model', () => {
  test('Travel type, Critical level and Oxygen required are printed, in the right sections', () => {
    const { bySection, flat } = rowsOf(NEW_FORM);
    expect(flat['Travel type:']).toBe('Organ Transfer');
    expect(flat['Critical level:']).toBe('ICU, ECMO');
    expect(flat['Oxygen required:']).toBe('Yes, 4 LPM');
    const titles = Object.keys(bySection);
    expect(bySection[titles.find((t) => /service/i.test(t))]['Travel type:']).toBe('Organ Transfer'); // with the service information
    expect(bySection[titles.find((t) => /request details|medical/i.test(t))]['Critical level:']).toBe('ICU, ECMO'); // with the medical details
  });

  test.each([
    ['patient_transfer', 'Patient Transfer'],
    ['organ_transfer', 'Organ Transfer'],
  ])('travel type %s reads %s; an unknown one is left out, never printed raw', (key, label) => {
    expect(rowsOf({ ...NEW_FORM, travelType: key }).flat['Travel type:']).toBe(label);
    expect(rowsOf({ ...NEW_FORM, travelType: 'something_else' }).labels).not.toContain('Travel type:');
    expect(JSON.stringify(rowsOf({ ...NEW_FORM, travelType: 'something_else' }).model)).not.toContain('something_else');
  });

  test('critical levels follow the form\'s own order whatever order they were stored in; unknown keys are dropped; none left means no row', () => {
    expect(rowsOf({ ...NEW_FORM, criticalLevel: 'ecmo,icu' }).flat['Critical level:']).toBe('ICU, ECMO');
    expect(rowsOf({ ...NEW_FORM, criticalLevel: 'ventilated,tracheostomy,ecmo,icu' }).flat['Critical level:']).toBe('ICU, Ventilated, Tracheostomy, ECMO');
    expect(rowsOf({ ...NEW_FORM, criticalLevel: 'bogus,icu,<script>' }).flat['Critical level:']).toBe('ICU');
    expect(rowsOf({ ...NEW_FORM, criticalLevel: ['icu', 'ecmo'] }).flat['Critical level:']).toBe('ICU, ECMO'); // an API list as well as the stored text
    for (const none of ['', null, undefined, 'bogus']) expect(rowsOf({ ...NEW_FORM, criticalLevel: none }).labels).not.toContain('Critical level:');
  });

  test('oxygen: Yes shows its flow rate, Yes without one is just Yes, No never shows a rate (even a stale one), and an unanswered question prints nothing', () => {
    expect(rowsOf({ ...NEW_FORM, oxygenRequired: true, oxygenFlowLpm: 12 }).flat['Oxygen required:']).toBe('Yes, 12 LPM');
    expect(rowsOf({ ...NEW_FORM, oxygenRequired: true, oxygenFlowLpm: null }).flat['Oxygen required:']).toBe('Yes');
    expect(rowsOf({ ...NEW_FORM, oxygenRequired: false, oxygenFlowLpm: null }).flat['Oxygen required:']).toBe('No');
    expect(rowsOf({ ...NEW_FORM, oxygenRequired: false, oxygenFlowLpm: 4 }).flat['Oxygen required:']).toBe('No'); // a stale rate is not shown with No
    for (const unanswered of [null, undefined]) expect(rowsOf({ ...NEW_FORM, oxygenRequired: unanswered }).labels).not.toContain('Oxygen required:');
  });

  test('the revised form asks no care level, mobility, on-board equipment or urgency, so none is printed for it', () => {
    const { labels } = rowsOf(NEW_FORM);
    for (const gone of ['Care level:', 'Patient mobility:', 'Required on board:', 'Urgency:']) expect(labels).not.toContain(gone);
  });

  test('the patient\'s own words (Medical History) and the usual patient and trip facts are still there', () => {
    const { flat } = rowsOf(NEW_FORM);
    expect(flat['Patient Name:']).toBe('Maria Fernandez');
    expect(flat['From:']).toBe('Mumbai, India');
    expect(flat['To:']).toBe('Dubai, United Arab Emirates');
    expect(Object.values(flat)).toContain('Post-angioplasty, stable.');
  });

  test('nothing internal comes with it: the model carries only the printed text, never the raw stored keys', () => {
    const text = JSON.stringify(buildSummaryModel(NEW_FORM));
    for (const raw of ['organ_transfer', 'icu,ecmo', 'criticalLevel', 'oxygenRequired', 'oxygenFlowLpm', 'travelType']) expect(text).not.toContain(raw);
  });
});

describe('older Private Charter rows and other services are shown as before', () => {
  test('a Private Charter row saved before the revision keeps its care level, mobility (a list) and urgency, and shows no new rows', () => {
    const { flat, labels } = rowsOf({ ...BASE, careLevel: 'care_icu,care_stable', mobility: 'bedridden,wheelchair', urgency: 'planned', equipOxygen: true, equipOxygenLpm: 4 });
    expect(flat['Care level:']).toBe('ICU / Critical, Stable / Monitored');
    expect(flat['Patient mobility:']).toBe('Bedridden, Wheelchair');
    expect(flat['Urgency:']).toBe('Planned');
    expect(flat['Required on board:']).toBe('Oxygen (4 LPM)');
    for (const added of ['Travel type:', 'Critical level:', 'Oxygen required:']) expect(labels).not.toContain(added);
  });

  test('a single stored mobility still reads as before, and an unknown one is not printed', () => {
    expect(rowsOf({ ...BASE, mobility: 'wheelchair' }).flat['Patient mobility:']).toBe('Wheelchair');
    expect(rowsOf({ ...BASE, mobility: 'flying' }).labels).not.toContain('Patient mobility:');
  });

  test('Ground Ambulance and Commercial Air print what they always printed, with none of the revised-form rows', () => {
    const ground = rowsOf({ ...BASE, serviceKey: 'ground', serviceType: 'Ground Ambulance', careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 6, urgency: 'urgent_24h' });
    expect(ground.flat['Required on board:']).toBe('Oxygen (6 LPM)');
    expect(ground.flat['Urgency:']).toBe('Urgent (24h)');
    for (const added of ['Critical level:', 'Oxygen required:']) expect(ground.labels).not.toContain(added);
    const air = rowsOf({ ...BASE, serviceKey: 'commercialair_stretcher', serviceType: 'Commercial Airline Medical Escort', careLevel: 'crit_icu', urgency: 'planned' });
    expect(air.flat['Travel type:']).toBe('Stretcher'); // Commercial Air's own travel type, from its service key, is not replaced by the revised form's
    expect(air.labels).not.toContain('Oxygen required:');
  });
});

describe('the real renderer and the real streaming function', () => {
  test('a revised-form request renders to a real PDF (the new rows do not break the drawing, in any of the combinations)', async () => {
    for (const request of [NEW_FORM, { ...NEW_FORM, oxygenRequired: false }, { ...NEW_FORM, oxygenRequired: null, criticalLevel: null }, { ...BASE, careLevel: 'care_icu', mobility: 'bedridden' }]) {
      const pdf = await renderSummaryPdf(buildSummaryModel(request));
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1500);
    }
  }, 60000);

  test('the download answers as a PDF attachment named after the Request ID, built completely before anything is sent', async () => {
    const headers = {};
    const sent = [];
    const res = { setHeader: (k, v) => { headers[k] = v; }, end: (body) => sent.push(body) };
    await streamRequestSummaryPdf(res, NEW_FORM);
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toBe('attachment; filename="REQ-1007-summary.pdf"');
    expect(headers['Content-Length']).toBe(String(sent[0].length));
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(sent).toHaveLength(1);
    expect(sent[0].subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60000);
});
