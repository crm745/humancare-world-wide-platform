/* global describe, test, expect, __dirname */
// Request Details: the Documents area (heading, empty message, list, document history, upload) is not drawn for a Teleconsultation made in the new
// format (serviceKey "tele", empty destination: it takes no documents). An older Teleconsultation keeps its Documents, and its files still open;
// every other service is as it was. (The screen is not rendered here: this project's Jest covers lib/ logic and reads screen source.)
const fs = require('fs');
const path = require('path');
const { detailsView, documentRows } = require('../requestDetailsView');
const { isNewTeleRequest } = require('../teleConsultation');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};

const base = {
  id: 7, referenceNumber: 'REQ-1007', status: 'submitted', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', patientContact: '+91 98765 43210', country: 'India',
  createdAt: '2026-11-16T09:30:00.000Z', preferredDate: null, urgency: null, description: 'Scope: Domestic\nConsultation type: Online Consultation',
};
const NEW_ONLINE = { ...base, serviceKey: 'tele', serviceType: 'Tele Consultation & House Call', origin: 'Flat 4B, Rose Villa, Pune', destination: '', case: { status: 'submitted', documents: [] } };
const NEW_HOUSE_CALL = { ...NEW_ONLINE, id: 8, preferredDate: '2026-11-25T00:00:00.000Z', description: 'Scope: Domestic\nConsultation type: House Call' };
const doc = (extra = {}) => ({ id: 31, type: 'Medical Report', name: 'discharge-summary.pdf', fileSizeBytes: 1258291, uploadedAt: '2026-11-10T08:00:00.000Z', ...extra });
const OLD_WITH_DOCS = {
  ...base, id: 3, referenceNumber: 'REQ-1003', serviceKey: 'tele', serviceType: 'Tele Consultation & House Call', origin: 'Pune', destination: 'Mumbai', urgency: 'planned', description: 'Cough and fever.',
  case: { status: 'submitted', stageEvents: [], documents: [doc(), doc({ id: 32, name: 'ecg.png', fileSizeBytes: 655360 })] },
};
const OLD_NO_DOCS = { ...OLD_WITH_DOCS, id: 4, case: { status: 'submitted', stageEvents: [], documents: [] } };

describe('a new-format Teleconsultation: no Documents area at all', () => {
  test.each([['an Online Consultation', NEW_ONLINE], ['a House Call', NEW_HOUSE_CALL]])('%s: showDocuments is false', (_name, request) => {
    expect(isNewTeleRequest(request)).toBe(true);
    expect(detailsView(request, t).showDocuments).toBe(false);
  });
  test('even with nothing to list, there is no heading and no "no documents" message to show (the flag, not the list, decides)', () => {
    const view = detailsView(NEW_ONLINE, t);
    expect(view.documents).toEqual([]);
    expect(view.showDocuments).toBe(false);
  });
  test('the screen draws the heading, the empty message, the list, the history and the upload ONLY inside the flag', () => {
    const screen = read('app/request-details.js');
    const open = screen.indexOf('{view.showDocuments ? (');
    const close = screen.indexOf(') : null}', open);
    expect(open).toBeGreaterThan(-1);
    const inside = screen.slice(open, close);
    for (const piece of ["t('rd_documents_n', { n: docs.length })", "t('rd_no_documents')", '<DocumentRow', '<DocumentHistory', '<AdditionalDocuments']) {
      expect(inside).toContain(piece);
      // and nowhere outside the gate
      expect(screen.slice(0, open) + screen.slice(close)).not.toContain(piece);
    }
  });
  test('nothing else on the page changes for it: the patient card, the consultation details and the status are still built', () => {
    const view = detailsView(NEW_HOUSE_CALL, t);
    expect(view.patient.fields.find((f) => f.key === 'address')).toBeTruthy();
    expect(view.medical.conditionLabel).toBe('Consultation details');
    expect(view.medical.details.map((r) => r.key)).toEqual(['visitDate']);
    expect(view.trip).toEqual({ from: '', to: '', rows: [] });
  });
});

describe('an older Teleconsultation keeps its Documents, and its files still open', () => {
  test('with documents: the section is shown and every file is a row that opens', () => {
    expect(isNewTeleRequest(OLD_WITH_DOCS)).toBe(false);
    const view = detailsView(OLD_WITH_DOCS, t);
    expect(view.showDocuments).toBe(true);
    expect(view.documents.map((d) => d.name)).toEqual(['discharge-summary.pdf', 'ecg.png']);
    expect(view.documents.every((d) => d.openable === true)).toBe(true);
    expect(view.documents[0].meta).toContain('PDF');
    expect(view.documents[1].isImage).toBe(true);
  });
  test('without documents: it still shows its empty Documents section, as before', () => {
    const view = detailsView(OLD_NO_DOCS, t);
    expect(view.showDocuments).toBe(true);
    expect(view.documents).toEqual([]);
  });
  test('the rows are exactly what documentRows has always produced for it', () => {
    expect(detailsView(OLD_WITH_DOCS, t).documents).toEqual(documentRows(OLD_WITH_DOCS, t));
  });
  test('the rest of an older request reads as before (Trip, urgency, "Condition & diagnosis")', () => {
    const view = detailsView(OLD_WITH_DOCS, t);
    expect(view.trip.from).toBe('Pune');
    expect(view.trip.to).toBe('Mumbai');
    expect(view.medical.urgency).toBeTruthy();
    expect(view.medical.conditionLabel).toBe('Condition & diagnosis');
  });
});

describe('every other service is as it was', () => {
  const other = (serviceKey, serviceType, extra = {}) => ({
    ...base, serviceKey, serviceType, origin: 'Pune', destination: 'Mumbai', urgency: 'planned', case: { status: 'submitted', stageEvents: [], documents: [doc()] }, ...extra,
  });
  test.each([
    ['ground', 'Ground Ambulance'], ['commercialair_stretcher', 'Medical Escort (Commercial Airlines) — Stretcher (CAS)'], ['commercialair_wheelchair', 'Medical Escort (Commercial Airlines) — Wheelchair (CAW)'],
    ['homecare', 'Home Healthcare Services'], ['hospital', 'Hospitalization Assistance'], ['marine', 'Marine Medical Safety'], ['medvalue', 'Medical Value Travel'], ['air', 'Air Ambulance'],
  ])('%s keeps its Documents, with its files', (key, type) => {
    const view = detailsView(other(key, type), t);
    expect(view.showDocuments).toBe(true);
    expect(view.documents.map((d) => d.name)).toEqual(['discharge-summary.pdf']);
    expect(view.documents[0].openable).toBe(true);
  });
  test('they show the Documents section even when they have no documents', () => {
    expect(detailsView(other('ground', 'Ground Ambulance', { case: { status: 'submitted', stageEvents: [], documents: [] } }), t).showDocuments).toBe(true);
  });
  test('Mortal Remains keeps its Documents (the death certificate)', () => {
    const view = detailsView(other('mortal_domestic', 'Mortal Remains — Within India', { case: { status: 'submitted', stageEvents: [], documents: [doc({ type: 'Death Certificate', name: 'certificate.pdf' })] } }), t);
    expect(view.showDocuments).toBe(true);
    expect(view.documents[0].type).toBe('Death certificate');
  });
  test('Private Charter (the review workflow) keeps its Documents, its history and its upload, which are display-only rows', () => {
    const charter = { ...base, serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', origin: 'Mumbai', destination: 'Dubai', reviewStatus: 'awaiting_documents', requestDocuments: [], case: null };
    const view = detailsView(charter, t);
    expect(view.showDocuments).toBe(true);
    expect(view.documents).toEqual([]);
  });
  test('a key that merely starts with "tele" is not a Teleconsultation', () => {
    expect(detailsView(other('teleprompter', 'Other', { destination: '' }), t).showDocuments).toBe(true);
    expect(isNewTeleRequest({ serviceKey: 'ground', destination: '' })).toBe(false);
  });
});

describe('isolation', () => {
  test('the document components and the upload rules are not touched: only the screen\'s use of them is gated', () => {
    const screen = read('app/request-details.js');
    expect(screen).toContain("import { openDocumentPreview } from");
    expect(screen).toContain('onOpen={() => openDocumentPreview(router.push, doc)}');
    expect(screen).toContain('<AdditionalDocuments request={request} onUploaded={reload} />');
    // the gate is the flag the pure view computes, and the flag is false only for a new-format Teleconsultation
    expect(read('lib/requestDetailsView.js')).toContain('showDocuments: !tele && !corporate,');
    expect(read('lib/requestDetailsView.js')).toContain('const tele = isNewTeleRequest(request);');
  });
});
