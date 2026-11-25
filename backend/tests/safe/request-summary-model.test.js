/* global describe, test, expect */
// The content of the request summary PDF, service by service (pdf/summary-model.js): readable English labels, correctly formatted values, the right rows for each of the eight services, missing
// fields handled, what the patient typed kept exactly, and nothing internal ever read. Pure: no PDF library, no database, no network. Requests are synthetic and shaped as the database stores them.
const { buildSummaryModel, formatDateOnly, formatMoment, statusLabelOf, TEXT_LIMIT } = require('../../src/modules/requests/pdf/summary-model');
const { canonical, NOW, SECRETS, SECRET_TEXTS, EIGHT, services, wrap } = require('./helpers/summary-fixtures');

const all = services();
const build = (key, extra = {}) => buildSummaryModel({ ...all[key], ...extra }, { now: new Date('2026-11-23T14:05:00.000Z') });
const rowsOf = (model) => Object.fromEntries(model.sections.flatMap((s) => s.rows).map((r) => [r.label, r.value]));
const labelsOf = (model) => model.sections.flatMap((s) => s.rows).map((r) => r.label);

describe('the header and the meta data (every service)', () => {
  test.each(Object.entries(EIGHT))('%s: Request ID, service, status, generated and submitted dates, in English and in UTC', (_name, key) => {
    const model = build(key);
    expect(model.reference).toBe('REQ-1042');
    expect(model.serviceName).toBe(canonical(all[key].serviceType));
    expect(model.statusKey).toBe('in_progress');
    expect(model.statusLabel).toBe('In progress'); // a word, not the stored key
    expect(model.generatedAt).toBe('23 Nov 2026, 14:05 UTC');
    expect(model.submittedAt).toBe('20 Nov 2026, 09:15 UTC');
  });
  test.each([['submitted', 'Submitted'], ['scheduled', 'Scheduled'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['on_hold_for_review', 'On hold for review'], [undefined, 'Submitted'], [null, 'Submitted'], ['', 'Submitted']])('status %j reads %j', (status, label) => {
    expect(statusLabelOf(status)).toBe(label);
  });
  test('a date and a moment are always English and fixed (UTC), so every server prints the same text', () => {
    expect(formatDateOnly('2026-11-10T00:00:00.000Z')).toBe('Tue Nov 10 2026');
    expect(formatMoment('2026-01-02T03:04:00.000Z')).toBe('02 Jan 2026, 03:04 UTC');
    for (const bad of [null, undefined, '', 'not a date']) { expect(formatDateOnly(bad)).toBeNull(); expect(formatMoment(bad)).toBeNull(); }
  });
});

describe('the sections and rows of each of the eight services', () => {
  test('Air Ambulance - Private Charter: patient, service (date, urgency), details (from, to, condition, care level, mobility, oxygen)', () => {
    const rows = rowsOf(build('privatecharter'));
    expect(rows).toMatchObject({
      'Patient Name:': 'Maria Fernandez', 'Age / Gender:': '61 / Female', 'Contact Number:': '+971 50 123 4567', 'Country:': 'United Arab Emirates', // the two-letter code is written as the name
      'Service:': 'Private Charter Air Ambulance Service', 'Date Of Service:': 'Sat Dec 05 2026', 'Urgency:': 'Urgent (24h)',
      'From:': 'Mumbai, Maharashtra, India', 'To:': 'Dubai, United Arab Emirates', 'Condition & diagnosis:': 'Post-surgical patient, needs ICU level transfer with a physician on board.',
      'Care level:': 'ICU / Critical', 'Patient mobility:': 'Bedridden', 'Required on board:': 'Oxygen (4 LPM)',
    });
  });
  test('Air Ambulance - Commercial Air: the travel type (Stretcher), the critical level and what is needed on board', () => {
    const rows = rowsOf(build('commercialair'));
    expect(rows).toMatchObject({ 'Travel type:': 'Stretcher', 'From:': 'Mumbai', 'To:': 'Dubai', 'Date Of Service:': 'Tue Dec 01 2026', 'Urgency:': 'Planned', 'Required on board:': 'Oxygen (3 LPM), Cardiac monitor' });
    expect(rows['Care level:']).toBeTruthy();
    expect(rows['Care level:']).not.toMatch(/crit_/); // a stored key is never printed as a key
  });
  test('Ground Ambulance: from, to, the present medical issue, care level and oxygen', () => {
    const rows = rowsOf(build('ground'));
    expect(rows).toMatchObject({ 'Patient Name:': 'Ravi Kumar', 'From:': 'Flat 4B, Rose Villa, Pune', 'To:': 'Ruby Hall Clinic, Pune', 'Condition & diagnosis:': 'Present medical issue: chest pain since morning.', 'Urgency:': 'Critical (within 6h)' });
    expect(rows['Required on board:']).toBe('Oxygen (3 LPM)');
    expect(rows['Care level:']).not.toMatch(/crit_/);
  });
  test('Teleconsultation: type, scope, visit date, address and the two medical notes; no From / To, no urgency', () => {
    const model = build('tele');
    const rows = rowsOf(model);
    expect(rows).toMatchObject({ 'Consultation type:': 'House Call', 'Scope:': 'Domestic', 'Visit date:': 'Tue Dec 01 2026', 'Current address:': 'Flat 4B, Rose Villa, MG Road, Pune' }); // the one-line copy the request stores
    expect(rows['Medical details:']).toContain('Fever and cough for three days.');
    expect(rows['Medical details:']).toContain('Penicillin.');
    expect(labelsOf(model)).not.toContain('From:');
    expect(labelsOf(model)).not.toContain('Urgency:');
    expect(model.documents).toBeNull(); // Teleconsultation takes no documents: no section
  });
  test('Home Healthcare: address, caretaker, hours, care level, oxygen and medical history; the stored description markers are not printed', () => {
    const model = build('homecare');
    expect(rowsOf(model)).toMatchObject({ 'Service Date:': 'Tue Dec 01 2026', 'Home address:': 'Flat 4B, Rose Villa\nMG Road, Pune 411001', 'Nurse / Caretaker:': 'Nurse', 'Care Requirement:': '12 Hours', 'Care Level:': 'Full ICU', 'Oxygen:': 'Yes (3 LPM)', 'Medical History:': 'Diabetes and hypertension.' });
    expect(JSON.stringify(model)).not.toMatch(/Home Healthcare v1|address \d+, history/);
    expect(labelsOf(model)).not.toContain('From:');
  });
  test('Mortal Remains: the name is the deceased\'s, with relation, place and date of death, scope, mode and the details', () => {
    const rows = rowsOf(build('mortal'));
    expect(rows).toMatchObject({
      "Deceased Person's Name:": 'Suresh Kale', 'Relation to the deceased:': 'Brother', 'Place of death:': 'Rashid Hospital, Dubai', 'Date of death:': 'Sun Nov 15 2026', 'Transfer scope:': 'International',
      'From:': 'Dubai, United Arab Emirates', 'To:': 'Pune, India', 'Preferred transfer date:': 'Fri Nov 20 2026', 'Urgency:': 'Urgent (24h)', 'Details:': 'Family travels along.',
    });
    expect(rows['Transport mode:']).toBeTruthy();
    expect(rows['Patient Name:']).toBeUndefined();
  });
  test('Corporate Medical Solutions (patient-facing): company, employees, programmes, office and the requirements; no documents section', () => {
    const model = build('corporate');
    expect(rowsOf(model)).toMatchObject({
      'Name of Employee:': 'Asha Nair', 'Gender:': 'Female', 'Patient Contact:': '+91 98765 43210', 'Company Name:': 'Acme Industries Pvt Ltd', 'No. of Employees:': '250', 'Preferred Date:': 'Tue Dec 01 2026',
      'Office Address:': 'Plot 14, Andheri East,\nMumbai 400069', 'Office Country:': 'India', 'Any Requirement:': 'Annual checkups.', 'Special Requirement:': 'Weekend slots.',
    });
    expect(rowsOf(model)['Programmes:']).toMatch(/Doctor/);
    expect(model.documents).toBeNull();
  });
  test('Marine Medical Safety: scope, origin, destination, date, critical level, oxygen and medical history', () => {
    expect(rowsOf(build('marine'))).toMatchObject({
      'Service scope:': 'International', 'Origin:': 'Port of Mumbai', 'Destination:': 'Port of Singapore', 'Date of service:': 'Thu Dec 10 2026', 'Oxygen:': 'Yes (4 LPM)', 'Medical History:': 'Crew member with a deck injury.',
    });
    expect(rowsOf(build('marine'))['Critical level:']).toBeTruthy();
  });
  test('Medical Value Travel: scope, specialty, cities, treatment date and medical history', () => {
    expect(rowsOf(build('medvalue'))).toMatchObject({
      'Treatment scope:': 'International', 'Specialty:': 'Oncology', 'Current city:': 'Hyderabad', 'Destination city:': 'Singapore', 'Preferred treatment date:': 'Thu Dec 10 2026',
      'Medical History:': 'Needs a second opinion on the treatment plan.',
    });
  });
  test('the sections come in the same order for every service, and empty ones are left out', () => {
    for (const key of Object.values(EIGHT)) {
      const titles = build(key).sections.map((s) => s.title);
      expect(titles).toEqual(['Patient Information', 'Service Information', 'Request Details'].filter((t) => titles.includes(t)));
      for (const section of build(key).sections) expect(section.rows.length).toBeGreaterThan(0);
    }
  });
});

describe('English only: every label, status, date and unit is English whatever the patient typed', () => {
  test.each(Object.entries(EIGHT))('%s: every label is plain English text (no other script)', (_name, key) => {
    const model = build(key);
    for (const label of [...labelsOf(model), ...model.sections.map((s) => s.title), model.statusLabel, model.generatedAt, model.submittedAt]) {
      expect(label).toMatch(/^[\x20-\x7e]+$/); // printable ASCII only
    }
  });
  test('what the patient typed is kept EXACTLY, in any script, and never translated', () => {
    const typed = {
      patientName: 'आशा नायर', origin: 'అనిల్ ఇల్లు, హైదరాబాద్', destination: 'દર્દી હોસ્પિટલ, અમદાવાદ', description: 'يعاني المريض من ألم في الصدر\nمنذ الصباح — chest pain 🙂',
    };
    const rows = rowsOf(build('ground', typed));
    expect(rows['Patient Name:']).toBe('आशा नायर');
    expect(rows['From:']).toBe('అనిల్ ఇల్లు, హైదరాబాద్');
    expect(rows['To:']).toBe('દર્દી હોસ્પિટલ, અમદાવાદ');
    expect(rows['Condition & diagnosis:']).toBe('يعاني المريض من ألم في الصدر\nمنذ الصباح — chest pain 🙂');
    expect(labelsOf(build('ground', typed))).toContain('Patient Name:'); // the label stays English
  });
  test('a patient\'s own English-looking words are not "fixed" either (no trimming of the middle, no case change)', () => {
    expect(rowsOf(build('ground', { patientName: 'mc  donald  O\'neil' }))['Patient Name:']).toBe("mc  donald  O'neil");
  });
});

describe('missing fields', () => {
  test('a request with almost nothing still gives a document: the name row says "Not provided", and empty rows and sections are left out', () => {
    const model = buildSummaryModel({ referenceNumber: 'REQ-1', serviceType: 'Marine Medical Safety', status: 'submitted', createdAt: '2026-11-20T09:15:00.000Z' }, { now: NOW });
    expect(model.sections.map((s) => s.title)).toEqual(['Patient Information', 'Service Information']);
    expect(rowsOf(model)['Patient Name:']).toBe('Not provided');
    expect(rowsOf(model)['Service:']).toBe('Marine Medical Safety');
    expect(model.documents).toEqual([]);
    expect(model.timeline).toEqual([]);
  });
  test('no dates, no case, no document lists, unknown status, nulls everywhere: no throw, no "undefined", no "null", no 1970', () => {
    const model = buildSummaryModel({ referenceNumber: null, serviceType: null, status: 'weird_status', createdAt: null, patientName: null, origin: undefined, case: null, requestDocuments: null }, { now: NOW });
    const text = JSON.stringify(model);
    expect(text).not.toMatch(/undefined|1970/);
    expect(model.reference).toBe('Request');
    expect(model.statusLabel).toBe('Weird status');
    expect(model.submittedAt).toBeNull();
    expect(model.serviceName).toBe('Humancare World Wide service request');
  });
  test('rows with an empty or blank value are dropped, a zero is kept (age 0, 0 LPM)', () => {
    const rows = rowsOf(build('ground', { patientAge: 0, patientGender: '', description: '   ', careLevel: null, equipOxygenLpm: 0, equipOxygen: true }));
    expect(rows['Age / Gender:']).toBe('0');
    expect(rows['Condition & diagnosis:']).toBeUndefined();
    expect(rows['Care level:']).toBeUndefined();
    expect(rows['Required on board:']).toBe('Oxygen (0 LPM)');
  });
  test('an older request in the generic layout (a stored care level label, no service key) still prints', () => {
    const rows = rowsOf(buildSummaryModel({ referenceNumber: 'REQ-9', serviceType: 'Ground Ambulance', status: 'completed', createdAt: '2026-11-20T09:15:00.000Z', patientName: 'Old Patient', origin: 'Pune', destination: 'Mumbai', careLevel: 'ICU / Critical, Ambulatory' }, { now: NOW }));
    expect(rows['Care level:']).toBe('ICU / Critical, Ambulatory');
  });
});

describe('long text', () => {
  test('a text of any length up to the limit is kept whole; a longer one is cut with a note (the PDF stays a sensible size)', () => {
    const long = 'word '.repeat(3000).trim();
    expect(rowsOf(build('ground', { description: long }))['Condition & diagnosis:']).toBe(long);
    const huge = 'x'.repeat(TEXT_LIMIT + 5000);
    const cut = rowsOf(build('ground', { description: huge }))['Condition & diagnosis:'];
    expect(cut.length).toBeLessThan(TEXT_LIMIT + 40);
    expect(cut.endsWith('(text shortened)')).toBe(true);
  });
  test('control characters and bidirectional overrides are removed, line breaks and normal text kept', () => {
    const rows = rowsOf(build('ground', { description: 'a\u0000b\u0007c‮d⁦e﻿f\r\nline2\tx' }));
    expect(rows['Condition & diagnosis:']).toBe('abcdef\nline2 x');
  });
});

describe('uploaded documents: names only', () => {
  test('every document is listed with its name, type, size and date, in upload order', () => {
    const model = build('ground');
    expect(model.documents).toEqual([
      { name: 'discharge-summary.pdf', meta: 'Medical Report  ·  469 KB  ·  Uploaded Fri Nov 20 2026' },
      { name: 'ct-scan.jpg', meta: 'Medical Report  ·  2.3 MB  ·  Uploaded Fri Nov 20 2026' },
    ]);
  });
  test('documents of the review workflow (Private Charter) are listed by their name; a replaced one is not', () => {
    const model = build('privatecharter', {
      case: null,
      requestDocuments: [
        { originalName: 'passport.pdf', sizeBytes: 2048, uploadedAt: '2026-11-20T09:20:00.000Z', supersededAt: null, storageKey: SECRETS.storageKey, sha256: SECRETS.sha256 },
        { originalName: 'old-version.pdf', sizeBytes: 2048, uploadedAt: '2026-11-20T09:10:00.000Z', supersededAt: '2026-11-20T09:20:00.000Z' },
      ],
    });
    expect(model.documents.map((d) => d.name)).toEqual(['passport.pdf']);
  });
  test('no document, a nameless one and a hostile name', () => {
    expect(build('ground', { case: { documents: [], stageEvents: [] } }).documents).toEqual([]);
    expect(build('ground', { case: { documents: [{ name: '', type: null, fileSizeBytes: null, uploadedAt: null }], stageEvents: [] } }).documents).toEqual([{ name: 'Document', meta: '' }]);
    const hostile = build('ground', { case: { documents: [{ name: 'evil‮fdp.exe\u0000', type: 'Medical Report', fileSizeBytes: 10, uploadedAt: null }], stageEvents: [] } });
    expect(hostile.documents[0].name).toBe('evilfdp.exe');
  });
  test('a long list is kept in full up to 100 documents', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ name: `report-${i}.pdf`, type: 'Medical Report', fileSizeBytes: 1000, uploadedAt: '2026-11-20T09:20:00.000Z' }));
    expect(build('ground', { case: { documents: many, stageEvents: [] } }).documents).toHaveLength(100);
  });
  test('Teleconsultation and Corporate Medical Solutions have no documents section; the others show an empty list as "none yet"', () => {
    expect(build('tele').documents).toBeNull();
    expect(build('corporate').documents).toBeNull();
    for (const key of ['ground', 'privatecharter', 'homecare', 'mortal', 'marine', 'medvalue', 'commercialair']) expect(build(key, { case: { documents: [], stageEvents: [] }, requestDocuments: [] }).documents).toEqual([]);
  });
});

describe('the timeline', () => {
  test('events are listed with English stage names and the staff note, in the order they happened', () => {
    expect(build('ground').timeline).toEqual([
      { when: '20 Nov 2026, 09:15 UTC', stage: 'Request submitted', note: 'Request received from patient app.' },
      { when: '21 Nov 2026, 08:00 UTC', stage: 'In progress', note: null },
    ]);
  });
  test('an unknown stage is made readable; no events and no case give an empty timeline', () => {
    expect(build('ground', { case: { documents: [], stageEvents: [{ stage: 'awaiting_vendor_quote', note: '', occurredAt: '2026-11-21T08:00:00.000Z' }] } }).timeline[0].stage).toBe('Awaiting vendor quote');
    expect(build('ground', { case: null }).timeline).toEqual([]);
  });
});

describe('authorized data only: nothing internal is read, so nothing internal can be printed', () => {
  test.each(Object.entries(EIGHT))('%s: no internal id, CRM field, private path, checksum, scan detail or request key appears anywhere in the model', (_name, key) => {
    const text = JSON.stringify(build(key));
    for (const secret of SECRET_TEXTS) expect({ key, secret, found: text.includes(secret) }).toEqual({ key, secret, found: false });
    expect(text).not.toMatch(/bitrix|token|password|storageKey|fileUrl|sha256|scanDetail|clientRequestId|userId/i);
  });
  test('the model has only the documented keys', () => {
    expect(Object.keys(build('ground')).sort()).toEqual(['documents', 'generatedAt', 'reference', 'sections', 'serviceName', 'statusKey', 'statusLabel', 'submittedAt', 'timeline']);
    for (const doc of build('ground').documents) expect(Object.keys(doc).sort()).toEqual(['meta', 'name']);
  });
  test('the request row passed in is not changed', () => {
    const request = wrap({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'X', origin: 'A', destination: 'B' });
    const before = JSON.stringify(request);
    buildSummaryModel(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});

describe('the service is named once (never "Medical Escort (Commercial Airlines) — Stretcher (CAS)")', () => {
  test.each(Object.entries(EIGHT))('%s: one canonical Service value, no variant or wrapper in it', (_name, key) => {
    const model = build(key);
    const value = rowsOf(model)['Service:'];
    expect(value).toBe(canonical(all[key].serviceType));
    expect(value).not.toMatch(/ — /);
    expect(value).not.toMatch(/^Medical Escort/);
    expect(model.serviceName).toBe(value);
  });
  test('Commercial Airlines: the name is "Commercial Airlines" and the travel type has its own row', () => {
    const model = build('commercialair');
    expect(rowsOf(model)['Service:']).toBe('Commercial Airlines');
    expect(rowsOf(model)['Travel type:']).toBe('Stretcher');
  });
});
