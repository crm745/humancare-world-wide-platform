/* global describe, test, expect, __dirname */
// Corporate Medical Solutions, patient side: the form's rules, the body it sends (checked against the REAL backend validator), how a stored request is read back, and how it
// is shown on the review step, My Requests, Request Details and Tracking. Older Corporate Medical requests keep their generic display.
const fs = require('fs');
const path = require('path');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const lib = require('../corporateMedical');
const backend = require('../../../../../backend/src/modules/requests/corporate-medical.validation');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { toListItem } = require('../requestShape');
const { cardView } = require('../myRequestsView');
const { trackingItemFromRequest } = require('../trackingItem');
const { buildTrackingDetails } = require('../trackingDetailsView');
const { draftForService } = require('../requestForm');

const {
  PROGRAMME_KEYS, PROGRAMME_LABELS, GENDERS, COMPANY_MAX, EMPLOYEES_MAX, TEXT_MAX, companyProblem, employeeCountProblem, parseEmployeeCount, requirementProblem,
  corporateStep1Problems, corporateStep2Problems, buildCorporatePayload, parseCorporateDescription, corporateFieldsOf, isNewCorporateRequest, corporateFromRequest, programmeNames,
} = lib;

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};

// A day in the future, as the date picker writes it (the device's own calendar).
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const OFFICE = 'Plot 14, Andheri East,\nMumbai, Maharashtra 400069';
const DRAFT = {
  service: 'corporate', name: 'Asha Nair', gender: 'Female', corpCompany: 'Acme Industries Pvt Ltd', corpEmployees: '250', corpProgrammes: ['events', 'doctor'],
  corpAny: 'Two doctors on site.', corpSpecial: 'Night shift cover.',
  cc: '+91', phone: '9876543210', phoneCountry: 'IN', date: day(5), corpOfficeAddress: OFFICE, corpOfficeCountry: 'United Arab Emirates', corpOfficeCountryIso: 'AE',
};
// A request as saved NOW: all eleven fields (REQ- reference; the office is in origin / country).
const STORED = {
  id: 55, referenceNumber: 'REQ-1055', serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', status: 'submitted', patientName: 'Asha Nair', patientGender: 'Female',
  patientAge: null, patientContact: '+91 98765 43210', country: 'United Arab Emirates', origin: OFFICE, destination: '', preferredDate: '2026-12-01T00:00:00.000Z', urgency: null, careLevel: null,
  createdAt: '2026-11-18T10:00:00.000Z', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, selectedProgrammes: ['doctor', 'events'], case: null,
  description: backend.composeCorporateDescription({ any: 'Two doctors on site.', special: 'Night shift cover.' }),
};
// A request saved before the four office / contact fields existed: the first seven only, with the CASE- reference it was given then.
const EARLIER = { ...STORED, referenceNumber: 'CASE-1042', patientContact: null, country: null, origin: '', preferredDate: null };
const OLD = { ...STORED, referenceNumber: 'REQ-1010', origin: 'Pune', destination: 'Pune', companyName: null, employeeCount: null, selectedProgrammes: null, description: 'Annual checkups for 200 staff.', urgency: 'planned' };

describe('the contract with the server', () => {
  test('the seven programmes, their English names, the genders and the limits are the backend\'s', () => {
    expect(PROGRAMME_KEYS).toEqual(backend.PROGRAMME_KEYS);
    expect(PROGRAMME_KEYS).toHaveLength(7);
    expect(PROGRAMME_LABELS).toEqual(backend.PROGRAMMES);
    expect(GENDERS).toEqual(['Male', 'Female', 'Other']);
    expect([COMPANY_MAX, EMPLOYEES_MAX, TEXT_MAX]).toEqual([backend.COMPANY_MAX, backend.EMPLOYEES_MAX, backend.TEXT_MAX]);
    expect([lib.EMPLOYEES_MIN, EMPLOYEES_MAX, lib.STORED_EMPLOYEES_MAX]).toEqual([1, 10000, backend.STORED_EMPLOYEES_MAX]);
    expect(lib.CORPORATE_SERVICE_TYPE).toBe(backend.CORPORATE_SERVICE_TYPE);
    expect(lib.CORPORATE_SERVICE_KEY).toBe(backend.CORPORATE_SERVICE_KEY);
    expect(require('../../data/services.json').corporate.title).toBe(lib.CORPORATE_SERVICE_TYPE);
  });
  test('the description parser reads exactly what the server composes (and refuses what the server refuses)', () => {
    const vectors = [{ any: 'A' }, { special: 'B' }, { any: 'A\r\nB', special: ' C ' }, { any: '\u{1F600} café' }, { any: 'z'.repeat(2000), special: 'y'.repeat(2000) },
      { any: 'Corporate Medical Solutions v1 (any 1, special 1)\nAny Requirement:\nx' }];
    for (const parts of vectors) {
      const text = backend.composeCorporateDescription(parts);
      expect(parseCorporateDescription(text)).toEqual(backend.parseCorporateDescription(text));
      expect(parseCorporateDescription(text)).toEqual({ ok: true, any: parts.any || '', special: parts.special || '' });
    }
    for (const bad of ['free text', 'Corporate Medical Solutions v1 (any 0, special 0)', 'Corporate Medical Solutions v1 (any 5, special 0)\nAny Requirement:\nx', 5, {}]) {
      expect(parseCorporateDescription(bad).ok).toBe(false);
      expect(backend.parseCorporateDescription(bad).ok).toBe(false);
    }
    for (const empty of [null, undefined, '']) expect(parseCorporateDescription(empty)).toEqual({ ok: true, any: '', special: '' });
  });
});

describe('the eleven fields: what is required', () => {
  const wrong = (d) => corporateStep1Problems(d).filter(([, bad]) => bad).map(([id]) => id);
  test('a complete draft has nothing wrong; the two requirements are optional', () => {
    expect(wrong(DRAFT)).toEqual([]);
    expect(corporateStep2Problems(DRAFT).filter(([, bad]) => bad)).toEqual([]);
    expect(corporateStep2Problems({ ...DRAFT, corpAny: '', corpSpecial: '' }).filter(([, bad]) => bad)).toEqual([]);
    expect(wrong({ ...DRAFT, corpAny: undefined, corpSpecial: undefined })).toEqual([]);
  });
  test('each required field is checked on its own, in page order', () => {
    expect(wrong({ ...DRAFT, corpCompany: '' })).toEqual(['company']);
    expect(wrong({ ...DRAFT, corpEmployees: '' })).toEqual(['employees']);
    expect(wrong({ ...DRAFT, name: '' })).toEqual(['name']);
    expect(wrong({ ...DRAFT, gender: '' })).toEqual(['gender']);
    expect(wrong({ ...DRAFT, phone: '' })).toEqual(['phone']);
    expect(wrong({ ...DRAFT, corpProgrammes: [] })).toEqual(['programmes']);
    expect(wrong({ ...DRAFT, date: '' })).toEqual(['date']);
    expect(wrong({ ...DRAFT, corpOfficeAddress: '' })).toEqual(['address']);
    expect(wrong({ ...DRAFT, corpOfficeCountryIso: '', corpOfficeCountry: '' })).toEqual(['country']);
    expect(wrong({ service: 'corporate', name: '', gender: '', corpCompany: '', corpEmployees: '', corpProgrammes: [], phone: '', cc: '+91', date: '', corpOfficeAddress: '', corpOfficeCountryIso: '' }))
      .toEqual(['company', 'employees', 'name', 'gender', 'phone', 'programmes', 'date', 'address', 'country']);
  });
  test('No. of Employees and Name of Employee are separate: neither satisfies the other', () => {
    expect(wrong({ ...DRAFT, name: '', corpEmployees: '250' })).toEqual(['name']);
    expect(wrong({ ...DRAFT, name: '250', corpEmployees: '' })).toEqual(['employees', 'name']);
    expect(wrong({ ...DRAFT, corpEmployees: 'Asha Nair' })).toEqual(['employees']);
  });
  test('Patient Contact: a number valid for the selected country code (the usual phone rule)', () => {
    expect(wrong({ ...DRAFT, phone: '98765 43210' })).toEqual([]);
    for (const bad of ['', '123', 'abc', '00000']) expect(wrong({ ...DRAFT, phone: bad })).toEqual(['phone']);
    expect(wrong({ ...DRAFT, cc: '+971', phone: '501234567' })).toEqual([]); // another country's code, with its own number
    expect(wrong({ ...DRAFT, cc: '+971', phone: '9876543210' })).toEqual(['phone']); // an Indian number is not valid under +971
  });
  test('Preferred Date: today and later days; yesterday, a past day, an impossible or empty date are refused (Home Healthcare\'s rule)', () => {
    const { isValidServiceDate } = lib;
    const now = new Date(2026, 10, 18, 9, 30); // 18 Nov 2026, local
    for (const ok of ['2026-11-18', '2026-11-19', '2027-01-01']) expect({ ok, valid: isValidServiceDate(ok, now) }).toEqual({ ok, valid: true });
    for (const bad of ['2026-11-17', '2020-01-01', '2026-02-30', '2026-13-01', '18/11/2026', '', null, undefined]) expect({ bad, valid: isValidServiceDate(bad, now) }).toEqual({ bad, valid: false });
    expect(wrong({ ...DRAFT, date: day(0) })).toEqual([]); // today
    expect(wrong({ ...DRAFT, date: day(-1) })).toEqual(['date']);
  });
  test('Office Address: required, any lines, at most 2,000 characters, refused (never cut) above that', () => {
    const { officeAddressProblem, ADDRESS_MAX } = lib;
    expect(ADDRESS_MAX).toBe(2000);
    expect(officeAddressProblem(OFFICE)).toBeNull();
    expect(officeAddressProblem('A'.repeat(2000))).toBeNull();
    expect(officeAddressProblem('\u{1F3E2}'.repeat(2000))).toBeNull(); // characters, not UTF-16 units
    expect(officeAddressProblem('A'.repeat(2001))).toBe('too_long');
    for (const empty of ['', '   ', '\n\n', null, undefined]) expect(officeAddressProblem(empty)).toBe('required');
    expect(officeAddressProblem('a\u0000b')).toBe('characters');
    expect(wrong({ ...DRAFT, corpOfficeAddress: 'A'.repeat(2001) })).toEqual(['address']);
  });
  test('Office Country: a country from the list, chosen on its own; the phone\'s country code neither sets nor satisfies it', () => {
    const { isValidOfficeCountry } = lib;
    for (const ok of ['IN', 'AE', 'GB', 'US']) expect(isValidOfficeCountry(ok)).toBe(true);
    for (const bad of ['', 'ZZ', 'XX', 'India', 'IND', 'in', null, undefined, 91]) expect({ bad, valid: isValidOfficeCountry(bad) }).toEqual({ bad, valid: false });
    // an Indian phone code, no office country chosen: the country is still missing
    expect(wrong({ ...DRAFT, cc: '+91', phoneCountry: 'IN', corpOfficeCountryIso: '', corpOfficeCountry: '' })).toEqual(['country']);
    // a +971 phone with an Indian office is fine, and so is the reverse
    expect(wrong({ ...DRAFT, cc: '+971', phone: '501234567', phoneCountry: 'AE', corpOfficeCountryIso: 'IN', corpOfficeCountry: 'India' })).toEqual([]);
  });
  test('Company Name: not blank, one line, at most 191 characters', () => {
    expect(companyProblem('Acme')).toBeNull();
    expect(companyProblem('x'.repeat(COMPANY_MAX))).toBeNull();
    expect(companyProblem('')).toBe('required');
    expect(companyProblem('   ')).toBe('required');
    expect(companyProblem(null)).toBe('required');
    expect(companyProblem('x'.repeat(COMPANY_MAX + 1))).toBe('too_long');
    expect(companyProblem('a\nb')).toBe('characters');
    expect(companyProblem('a\u0000b')).toBe('characters');
    expect(companyProblem('a b')).toBe('characters');
  });
  test.each([['1', null], ['250', null], [' 40 ', null], ['9999', null], ['10000', null], ['10001', 'invalid'], ['20000', 'invalid'], ['', 'required'], ['   ', 'required'], [null, 'required'], ['0', 'invalid'], ['-5', 'invalid'], ['1.5', 'invalid'],
    ['1,000', 'invalid'], ['ten', 'invalid'], ['12abc', 'invalid'], ['1000000', 'invalid'], ['1000001', 'invalid'], ['99999999', 'invalid'], ['٣', 'invalid']])('No. of Employees %p -> %p', (value, problem) => {
    expect(employeeCountProblem(value)).toBe(problem);
    expect(parseEmployeeCount(value)).toBe(problem === null ? Number(String(value).trim()) : null);
  });
  test('the requirements keep every character but the ones that cannot be saved; at most 2,000', () => {
    expect(requirementProblem('')).toBeNull();
    expect(requirementProblem(null)).toBeNull();
    expect(requirementProblem('a\nb\tc')).toBeNull();
    expect(requirementProblem('\u{1F600}'.repeat(TEXT_MAX))).toBeNull();
    expect(requirementProblem('a'.repeat(TEXT_MAX + 1))).toBe('too_long');
    expect(requirementProblem('a\u0000b')).toBe('characters');
    expect(corporateStep2Problems({ corpAny: 'a'.repeat(TEXT_MAX + 1), corpSpecial: '' }).filter(([, bad]) => bad).map(([id]) => id)).toEqual(['any']);
    expect(corporateStep2Problems({ corpAny: '', corpSpecial: 'a\u0000' }).filter(([, bad]) => bad).map(([id]) => id)).toEqual(['special']);
  });
});

describe('what is sent', () => {
  test('exactly the fields the server accepts, accepted by the real backend validator', () => {
    const payload = buildCorporatePayload(DRAFT);
    expect(Object.keys(payload).sort()).toEqual([
      'anyRequirement', 'companyName', 'employeeCount', 'officeAddress', 'officeCountry', 'patientContact', 'patientGender', 'patientName', 'preferredDate', 'programmes', 'serviceKey', 'serviceType',
      'specialRequirement', 'utcOffsetMinutes',
    ]);
    expect(payload).toEqual({
      serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female',
      patientContact: '+91 98765 43210', preferredDate: day(5), utcOffsetMinutes: 0 - new Date().getTimezoneOffset(), officeAddress: OFFICE, officeCountry: 'AE',
      programmes: ['doctor', 'events'], anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.',
    });
    expect(typeof payload.employeeCount).toBe('number');
    const { data, error } = backend.validateCorporateRequest(payload);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female', selectedProgrammes: ['doctor', 'events'],
      patientContact: '+91 98765 43210', origin: OFFICE, country: 'United Arab Emirates', destination: '',
    });
    expect(data.preferredDate).toBe(day(5));
  });
  test('the phone number and the Office Country are separate in the body: the office country is the picked ISO code whatever the phone code is', () => {
    const a = buildCorporatePayload({ ...DRAFT, cc: '+971', phone: '501234567', phoneCountry: 'AE', corpOfficeCountryIso: 'IN', corpOfficeCountry: 'India' });
    expect([a.patientContact, a.officeCountry]).toEqual(['+971 50 123 4567', 'IN']);
    expect(backend.validateCorporateRequest(a).data).toMatchObject({ patientContact: '+971 50 123 4567', country: 'India' });
    const b = buildCorporatePayload({ ...DRAFT, cc: '+91', phone: '9876543210', phoneCountry: 'IN', corpOfficeCountryIso: 'GB', corpOfficeCountry: 'United Kingdom' });
    expect([b.patientContact, b.officeCountry]).toEqual(['+91 98765 43210', 'GB']);
    expect(backend.validateCorporateRequest(b).data.country).toBe('United Kingdom');
  });
  test('the Office Address goes exactly as typed (never trimmed or cut), up to 2,000 characters', () => {
    const typed = '  Plot 14\r\n  Andheri East  ';
    expect(buildCorporatePayload({ ...DRAFT, corpOfficeAddress: typed }).officeAddress).toBe(typed);
    const longest = 'A'.repeat(2000);
    const body = buildCorporatePayload({ ...DRAFT, corpOfficeAddress: longest });
    expect(body.officeAddress).toHaveLength(2000);
    expect(backend.validateCorporateRequest(body).data.origin).toHaveLength(2000);
  });
  test('the contact formatter and the date rule agree with Home Healthcare\'s (these are copies, kept in step)', () => {
    const home = require('../homeHealthcare');
    for (const [cc, number] of [['+91', '9876543210'], ['+91', '09876543210'], ['+971', '501234567'], ['+44', '7911123456'], ['+1', '2025550123'], ['+91', '12'], ['', '']]) {
      expect({ cc, number, same: lib.contactNumber(cc, number) }).toEqual({ cc, number, same: home.contactNumber(cc, number) });
    }
    const now = new Date(2026, 10, 18, 9, 30);
    for (const value of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-02-30', '', 'x', null]) expect({ value, same: lib.isValidServiceDate(value, now) }).toEqual({ value, same: home.isValidServiceDate(value, now) });
  });
  test('the programmes go as keys in the list\'s order, whatever order they were tapped in; every combination is accepted by the server', () => {
    expect(buildCorporatePayload({ ...DRAFT, corpProgrammes: ['events', 'pre_employment_health_checkup', 'doctor'] }).programmes).toEqual(['doctor', 'events', 'pre_employment_health_checkup']);
    expect(buildCorporatePayload({ ...DRAFT, corpProgrammes: PROGRAMME_KEYS.slice().reverse() }).programmes).toEqual(PROGRAMME_KEYS);
    for (const key of PROGRAMME_KEYS) expect(backend.validateCorporateRequest(buildCorporatePayload({ ...DRAFT, corpProgrammes: [key] })).error).toBeUndefined();
    // a key the form does not know is dropped, never sent
    expect(buildCorporatePayload({ ...DRAFT, corpProgrammes: ['doctor', 'dentist'] }).programmes).toEqual(['doctor']);
  });
  test('an empty requirement is left out; the text is otherwise sent exactly as typed', () => {
    const none = buildCorporatePayload({ ...DRAFT, corpAny: '', corpSpecial: '   \n ' });
    expect(none).not.toHaveProperty('anyRequirement');
    expect(none).not.toHaveProperty('specialRequirement');
    const typed = '  two\r\nlines  ';
    expect(buildCorporatePayload({ ...DRAFT, corpAny: typed }).anyRequirement).toBe(typed);
  });
  test('the company and the employee are trimmed; nothing the form does not collect is sent', () => {
    const payload = buildCorporatePayload({ ...DRAFT, corpCompany: '  Acme  ', name: ' Asha Nair ', age: '40', phone: '9876543210', country: 'India', location: 'Pune', dest: 'Pune', urgency: 'planned', desc: 'x', files: [{ uri: 'u' }] });
    expect(payload.companyName).toBe('Acme');
    expect(payload.patientName).toBe('Asha Nair');
    // (the patient's own country, the trip and the other services' fields are never sent; the office is sent only as officeAddress / officeCountry)
    for (const key of ['patientAge', 'country', 'origin', 'destination', 'patientLocation', 'urgency', 'description', 'careLevel', 'mobility']) expect(payload).not.toHaveProperty(key);
    expect(payload.officeAddress).toBe(OFFICE);
  });
});

describe('reading a stored request', () => {
  test('a new-format request: the eleven fields come back individually', () => {
    expect(corporateFieldsOf(STORED)).toEqual({
      ok: true, companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, programmes: ['doctor', 'events'], anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.',
      patientContact: '+91 98765 43210', preferredDate: '2026-12-01T00:00:00.000Z', officeAddress: OFFICE, officeCountry: 'United Arab Emirates',
    });
    expect(isNewCorporateRequest(STORED)).toBe(true);
    expect(corporateFieldsOf({ ...STORED, description: null })).toMatchObject({ ok: true, anyRequirement: '', specialRequirement: '' });
    // the same answer as the server's reader
    expect(corporateFieldsOf(STORED)).toEqual(backend.corporateFieldsOf(STORED));
  });
  test('every older Corporate Medical request is not new, here and on the server', () => {
    for (const old of [OLD, { serviceKey: 'corporate' }, { ...STORED, companyName: null }, { ...STORED, employeeCount: null }, { ...STORED, selectedProgrammes: null }, { ...STORED, selectedProgrammes: '["doctor"]' },
      { ...STORED, selectedProgrammes: [] }, { ...STORED, selectedProgrammes: ['dentist'] }, { ...STORED, employeeCount: '250' }, { ...STORED, description: 'free text' }, { ...STORED, serviceKey: 'homecare' }, null]) {
      expect(isNewCorporateRequest(old)).toBe(false);
      expect(backend.isNewCorporateFormat(old)).toBe(false);
    }
  });
  test('the programmes are shown by name, one by one, never as a JSON string', () => {
    expect(programmeNames(['doctor', 'acls_bls_training', 'pre_employment_health_checkup'], t)).toEqual(['Doctor', 'ACLS & BLS training', 'Pre-employment health checkup']);
    expect(programmeNames('["doctor","nurse"]', t)).toEqual([]);
    expect(programmeNames(['doctor', 'dentist'], t)).toEqual(['Doctor']);
    const shown = corporateFromRequest(STORED, t);
    expect(shown).toEqual({
      company: 'Acme Industries Pvt Ltd', employees: '250', programmes: ['Doctor', 'Events'], anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.',
      patientContact: '+91 98765 43210', preferredDate: '2026-12-01T00:00:00.000Z', officeAddress: OFFICE, officeCountry: 'United Arab Emirates',
    });
    expect(corporateFromRequest(OLD, t)).toBeNull();
  });
  test('a request saved before the four fields existed is still new format (CASE- reference and all), with nothing invented', () => {
    expect(isNewCorporateRequest(EARLIER)).toBe(true);
    expect(backend.isNewCorporateFormat(EARLIER)).toBe(true);
    expect(corporateFromRequest(EARLIER, t)).toMatchObject({ company: 'Acme Industries Pvt Ltd', patientContact: '', preferredDate: null, officeAddress: '', officeCountry: '' });
    expect(corporateFieldsOf(EARLIER)).toEqual(backend.corporateFieldsOf(EARLIER));
  });
});

describe('the review step', () => {
  const v = reviewView(DRAFT, { key: 'corporate', title: 'Corporate Medical Solutions' }, t);
  test('Patient shows the company, the employees, the Name of Employee, the Gender, the Patient Contact, the Preferred Date, the Office Address and the Office Country, each on its own', () => {
    const shownDate = require('../requestDetailsView').formatDateOnly(DRAFT.date);
    expect(v.patient.fields.map((f) => [f.key, f.label, f.value])).toEqual([
      ['company', 'Company Name', 'Acme Industries Pvt Ltd'], ['employees', 'No. of Employees', '250'], ['name', 'Name of Employee', 'Asha Nair'], ['gender', 'Gender', 'Female'],
      ['contact', 'Patient Contact', '+91 98765 43210'], ['serviceDate', 'Preferred Date', shownDate], ['officeAddress', 'Office Address', OFFICE], ['officeCountry', 'Office Country', 'United Arab Emirates'],
    ]);
    expect(v.patient.fields.map((f) => f.label)).not.toContain('Country'); // never labelled as the patient's country
  });
  test('the Office Address keeps its line breaks on the review step and is not drawn as a route', () => {
    expect(v.patient.fields.find((f) => f.key === 'officeAddress').value).toContain('\n');
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
  });
  test('the medical section shows the programmes by name (in the list\'s order) and the two requirements as typed', () => {
    expect(v.medical.details.map((f) => [f.key, f.label, f.value])).toEqual([
      ['programmes', 'Programmes', 'Doctor, Events'], ['anyRequirement', 'Any Requirement', 'Two doctors on site.'], ['specialRequirement', 'Special Requirement', 'Night shift cover.'],
    ]);
    expect(v.medical.details[0].value).not.toMatch(/[[\]"]/);
  });
  test('no trip, urgency, condition text or documents; an empty requirement is not drawn', () => {
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
    expect(v.medical.urgency).toBeNull();
    expect(v.medical.condition).toBe('');
    expect(v.show).toEqual({ patient: true, trip: false, medical: true, documents: false });
    const withFiles = reviewView({ ...DRAFT, files: [{ uri: 'file:///a.pdf', name: 'a.pdf' }], urgency: 'planned', desc: 'old text' }, { key: 'corporate', title: 'Corporate Medical Solutions' }, t);
    expect(withFiles.documents).toEqual([]);
    expect(withFiles.medical.urgency).toBeNull();
    const bare = reviewView({ ...DRAFT, corpAny: '', corpSpecial: '  ' }, { key: 'corporate', title: 'Corporate Medical Solutions' }, t);
    expect(bare.medical.details.map((f) => f.key)).toEqual(['programmes']);
  });
  test('fieldsFor lists exactly the fields this form collects', () => {
    expect(Object.keys(fieldsFor('corporate')).sort()).toEqual([
      'cc', 'corpAny', 'corpCompany', 'corpEmployees', 'corpOfficeAddress', 'corpOfficeCountry', 'corpProgrammes', 'corpSpecial', 'date', 'gender', 'name', 'phone',
    ]);
  });
});

describe('Request Details', () => {
  test('a new-format request shows all eleven fields, with no route, urgency or documents', () => {
    const view = detailsView(STORED, t);
    expect(view.header.reference).toBe('REQ-1055');
    const rows = Object.fromEntries(view.patient.fields.map((f) => [f.key, f.value]));
    expect(rows).toMatchObject({
      company: 'Acme Industries Pvt Ltd', employees: '250', name: 'Asha Nair', gender: 'Female', contact: '+91 98765 43210', serviceDate: '01 Dec 2026', officeAddress: OFFICE, officeCountry: 'United Arab Emirates',
    });
    expect(view.patient.fields.find((f) => f.key === 'name').label).toBe('Name of Employee');
    expect(view.patient.fields.find((f) => f.key === 'contact').label).toBe('Patient Contact');
    expect(view.patient.fields.find((f) => f.key === 'serviceDate').label).toBe('Preferred Date');
    expect(view.patient.fields.find((f) => f.key === 'officeAddress').label).toBe('Office Address');
    expect(view.patient.fields.find((f) => f.key === 'officeCountry').label).toBe('Office Country');
    expect(view.patient.fields.map((f) => f.key)).not.toContain('country'); // the generic patient-country row is never drawn for it
    const medical = Object.fromEntries(view.medical.details.map((f) => [f.key, f.value]));
    expect(medical).toEqual({ programmes: 'Doctor, Events', anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.' });
    expect(view.medical.condition).toBe('');
    expect(view.medical.urgency).toBeNull();
    expect(view.trip).toEqual({ from: '', to: '', rows: [] });
    expect(view.showDocuments).toBe(false);
    expect(JSON.stringify(view)).not.toContain('selectedProgrammes');
    expect(JSON.stringify(view.medical.details)).not.toMatch(/\[\\?"/);
  });
  test('a request saved before the four fields existed shows its seven, and none of the four (nothing invented)', () => {
    const view = detailsView(EARLIER, t);
    expect(view.header.reference).toBe('CASE-1042'); // never renumbered
    const keys = view.patient.fields.map((f) => f.key);
    for (const gone of ['contact', 'serviceDate', 'officeAddress', 'officeCountry', 'country']) expect(keys).not.toContain(gone);
    expect(keys).toEqual(expect.arrayContaining(['company', 'employees', 'name', 'gender']));
    expect(view.trip).toEqual({ from: '', to: '', rows: [] });
  });
  test('without the two requirements only the programmes row is in the medical section', () => {
    const view = detailsView({ ...STORED, description: null }, t);
    expect(view.medical.details.map((f) => f.key)).toEqual(['programmes']);
  });
  test('an older Corporate Medical request keeps the generic display: its trip, urgency, description and documents area', () => {
    const view = detailsView(OLD, t);
    expect(view.patient.fields.map((f) => f.key)).not.toContain('company');
    expect(view.patient.fields.find((f) => f.key === 'name').label).toBe('Name');
    expect(view.trip.from).toBe('Pune');
    expect(view.medical.condition).toBe('Annual checkups for 200 staff.');
    expect(view.medical.details).toEqual([]);
    expect(view.showDocuments).toBe(true);
  });
});

describe('My Requests and Tracking', () => {
  test('the list card of a new-format request names the company and draws no route; an older one is as it was', () => {
    const card = cardView(toListItem(STORED), t);
    expect(card.person).toEqual({ label: 'Company Name', name: 'Acme Industries Pvt Ltd' });
    expect(card.route).toBeNull();
    expect(card.sub).toContain('REQ-1055');
    expect(card.name).toBe('Corporate Medical Solutions');
    expect(toListItem(STORED).origin).toBe(OFFICE); // the Office Address is in origin, and is still not drawn as a route (card.route is null above)
    const old = cardView(toListItem(OLD), t);
    expect(old.person).toBeNull();
    expect(old.route).toEqual({ from: 'Pune', to: 'Pune' });
    expect(toListItem(OLD)).not.toHaveProperty('corporateCompany');
    expect(toListItem({ ...STORED, serviceKey: 'hospital' })).not.toHaveProperty('corporateCompany');
  });
  test('the tracking item carries the company, the count and the programme keys; an older request has none', () => {
    expect(trackingItemFromRequest(STORED).corporate).toEqual({
      company: 'Acme Industries Pvt Ltd', employees: 250, programmes: ['doctor', 'events'], officeAddress: OFFICE, officeCountry: 'United Arab Emirates', preferredDate: '2026-12-01T00:00:00.000Z',
    });
    expect(trackingItemFromRequest(STORED).referenceNumber).toBe('REQ-1055');
    expect(trackingItemFromRequest(OLD).corporate).toBeNull();
  });
  test('a request saved before the four fields existed: its card draws no route and its tracking item has no office fields', () => {
    const card = cardView(toListItem(EARLIER), t);
    expect(card.route).toBeNull();
    expect(card.sub).toContain('CASE-1042');
    expect(trackingItemFromRequest(EARLIER).corporate).toMatchObject({ officeAddress: '', officeCountry: '', preferredDate: null });
    expect(buildTrackingDetails({ ...EARLIER, case: null }, t).hasRoute).toBe(false);
  });
  test('the tracking details have the REQ reference and no route; the stage and notification behaviour is the one every patient request uses', () => {
    const request = { ...STORED, case: { id: 41, status: 'in_progress', stageEvents: [{ id: 1, stage: 'submitted', occurredAt: '2026-11-18T10:00:00.000Z' }, { id: 2, stage: 'in_progress', occurredAt: '2026-11-19T10:00:00.000Z' }] }, status: 'in_progress' };
    const details = buildTrackingDetails(request, t);
    expect(details.reference).toBe('REQ-1055');
    expect(details.hasRoute).toBe(false);
    expect(details.from).toBe('');
    expect(details.to).toBe('');
    expect(details.serviceKey).toBe('corporate');
    expect(details.cancelled).toBe(false);
  });
  test('the Tracking screen says Company, No. of Employees and Programmes for a new-format request, and From / To for every other', () => {
    const screen = read('app/tracking.js');
    expect(screen).toContain('item.corporate ? (');
    expect(screen).toContain("corporateText(t, 'corp_company')");
    expect(screen).toContain("corporateText(t, 'corp_employees')");
    expect(screen).toContain("corporateText(t, 'corp_programmes')");
    expect(screen).toContain("programmeNames(item.corporate.programmes, t).join(', ')");
    expect(screen).toContain("corporateText(t, 'corp_preferred_date')");
    expect(screen).toContain("corporateText(t, 'corp_office_address')");
    expect(screen).toContain("corporateText(t, 'corp_office_country')");
    expect(screen).toContain("t('lbl_from')");
  });
});

describe('the form screens', () => {
  test('Step 1 and Step 2 are Corporate Medical Solutions\' own, chosen by the service key', () => {
    expect(read('app/request/step1.js')).toContain('if (isCorporateService(draft.service)) return <CorporateStep1 />;');
    expect(read('app/request/step2.js')).toContain('if (isCorporateService(draft.service)) return <CorporateStep2 />;');
  });
  test('Step 1 asks the nine required fields, Step 2 the two optional ones; neither asks for documents or urgency', () => {
    const one = read('components/request/CorporateStep1.js');
    for (const id of ['company', 'employees', 'name', 'gender', 'phone', 'programmes', 'date', 'address', 'country']) expect(one).toContain(`<Anchor id="${id}">`);
    for (const key of ['corpCompany', 'corpEmployees', 'corpProgrammes', 'draft.name', 'draft.gender', 'draft.phone', 'draft.cc', 'draft.date', 'corpOfficeAddress', 'corpOfficeCountry', 'corpOfficeCountryIso']) expect(one).toContain(key);
    expect(one).toContain('<HomeDateField'); // Home Healthcare's date picker (today or later)
    expect(one).toContain('pickRequestPhoneCountry(draft, code)'); // the usual international phone input and code picker
    expect(one).toContain('<MultilineInput'); // the Office Address is multiline
    // the office country has its own picker and its own draft keys: the phone's picker only changes the dialling code, and neither touches the patient-country keys
    expect(one).toContain('updateDraft({ corpOfficeCountryIso: code, corpOfficeCountry: nameOf(code) })');
    expect(one).not.toContain('pickRequestCountry'); // (the patient-country helper)
    expect(one).not.toMatch(/draft\.country\b|draft\.countryIso|countryIso: /); // never the patient-country fields
    expect(one).toContain('multiple columns={2}'); // the programmes are a multi-select
    expect(one).toContain('PROGRAMME_KEYS.map');
    expect(one).toContain("replace(/[^0-9]/g, '')"); // the count takes digits only
    const two = read('components/request/CorporateStep2.js');
    for (const id of ['any', 'special']) expect(two).toContain(`id="${id}"`);
    for (const key of ['corpAny', 'corpSpecial']) expect(two).toContain(key);
    for (const source of [one, two]) for (const word of ['ReportTiles', 'draft.files', 'draft.urgency', 'URGENCY_OPTIONS', 'CityField']) expect(source).not.toContain(word);
    expect(two).not.toContain('DateField');
  });
  test('Submit sends the structured body, with no upload', () => {
    const review = read('app/request/review.js');
    const start = review.indexOf('if (isCorporateService(d.service)) {');
    const branch = review.slice(start, review.indexOf('if (isPrivateCharter(d.service)) {'));
    expect(branch).toContain("apiPost('/requests', buildCorporatePayload(d))");
    expect(branch).not.toContain('apiUpload');
  });
  test('the draft has the new keys, and changing service clears them / clears what Corporate Medical does not take', () => {
    const initial = { service: 'air', files: [], urgency: '', date: '', corpCompany: '', corpEmployees: '', corpProgrammes: [], corpAny: '', corpSpecial: '', corpOfficeAddress: '', corpOfficeCountry: '', corpOfficeCountryIso: '' };
    expect(read('state/AppContext.js')).toMatch(/corpCompany: '',[\s\S]*corpEmployees: '',[\s\S]*corpProgrammes: \[\],[\s\S]*corpAny: '',[\s\S]*corpSpecial: '',[\s\S]*corpOfficeAddress: '',[\s\S]*corpOfficeCountry: '',[\s\S]*corpOfficeCountryIso: ''/);
    const into = draftForService({ ...initial, service: 'hospital', changingService: true, files: [{ uri: 'f' }], urgency: 'planned', date: '2026-12-01' }, 'corporate', initial);
    expect(into).toMatchObject({ service: 'corporate', files: [], urgency: '', date: '' });
    const away = draftForService({ ...initial, ...DRAFT, changingService: true }, 'hospital', initial);
    expect(away).toMatchObject({ corpCompany: '', corpEmployees: '', corpProgrammes: [], corpAny: '', corpSpecial: '', corpOfficeAddress: '', corpOfficeCountry: '', corpOfficeCountryIso: '' });
  });
  test('no translation file is touched: every new word has an English default here', () => {
    for (const key of Object.keys(lib.CORPORATE_TEXT)) expect(i18n.EN[key]).toBeUndefined();
    expect(lib.corporateText(t, 'corp_company')).toBe('Company Name');
    expect(lib.corporateText(t, 'corp_err_employees', { min: 1, max: 10000 })).toBe('Enter a whole number from 1 to 10000.');
    // the app's own translation wins when one is added later
    expect(lib.corporateText((key) => (key === 'corp_company' ? 'Nom de la société' : key), 'corp_company')).toBe('Nom de la société');
    expect(lib.programmeName('doctor', (key) => (key === 'corp_programme_doctor' ? 'Médecin' : key))).toBe('Médecin');
  });
});
