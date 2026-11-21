/* global describe, test, expect, __dirname */
// The New Request review step (step 3): empty fields and sections are hidden, every collected field is shown, "Show more" only for long text,
// each Edit / Change goes to the right step, and Submit sends exactly what it sent before.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isEmptyValue, hasValue } = require('../emptyValue');
const { reviewView, fieldsFor, FORM_FIELDS, NOT_SHOWN } = require('../reviewView');
const { needsClamp } = require('../requestDetailsView');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};

// A full draft, with a recognisable value in every field.
const FULL = {
  service: 'air', name: 'Ananya Sharma', age: '34', gender: 'Female', cc: '+91', phone: '9876543210', country: 'India',
  location: 'City General Hospital, Andheri West, Mumbai, Maharashtra, India', dest: 'Sunrise Heart Institute, Baner, Pune, Maharashtra, India',
  date: '2026-11-15', urgency: 'urgent_24h', desc: 'Post-operative cardiac patient needing monitoring during the transfer.',
  care: ['care_stable'], mobility: 'wheelchair', equipOxygen: true, oxygenLpm: '4', equipCardiac: true, equipVentilator: false,
  airlineMode: 'stretcher', mortalTransfer: 'domestic', transferScope: 'domestic', transportMode: 'private_charter', relation: 'Father', deathPlace: 'Sunrise Heart Institute, Pune', deathDate: '2026-10-01',
  teleScope: 'international', teleType: 'house_call', address: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', allergies: 'Penicillin.',
  homeAddress: 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n', homeCaretakers: ['nurse', 'caretaker'], homeCareHours: '12_hours', homeCareLevel: 'full_icu', homeOxygen: 'yes',
  treatmentScope: 'international', specialty: 'Other', otherSpecialty: 'Sports medicine',
  serviceScope: 'international', marineCare: ['crit_icu', 'crit_ecmo'], marineOxygen: 'yes',
  corpCompany: 'Acme Industries Pvt Ltd', corpEmployees: '250', corpProgrammes: ['events', 'doctor'], corpAny: 'Two doctors on site.', corpSpecial: 'Night shift cover.',
  corpOfficeAddress: 'Plot 14, Andheri East,\nMumbai 400069', corpOfficeCountry: 'United Arab Emirates', corpOfficeCountryIso: 'AE',
  files: [
    { uri: 'file:///x/discharge-summary.pdf', name: 'discharge-summary.pdf', mimeType: 'application/pdf', size: 1258291 },
    { uri: 'file:///x/ecg.png', name: 'ecg.png', mimeType: 'image/png', size: 655360 },
  ],
};
const svc = (key, title = 'Service') => ({ key, title });

describe('one rule for "nothing to show"', () => {
  test('empty: null, undefined, blank, whitespace, "null", "undefined", a lone dash, an empty list', () => {
    [null, undefined, '', '   ', '\n', 'null', 'undefined', '—', ' — ', [], [''], [null, ' '], ['—']].forEach((v) => expect(isEmptyValue(v)).toBe(true));
  });
  test('not empty: real text, 0 (an age of 0), false, a list with something in it', () => {
    ['Pune', 0, '0', false, true, ['a'], [0], 'None-of-the-above'].forEach((v) => expect(isEmptyValue(v)).toBe(false));
    expect(hasValue(0)).toBe(true);
    expect(hasValue('')).toBe(false);
  });
  test('Request Details uses the same rule (textOf)', () => {
    const details = read('lib/requestDetailsView.js');
    expect(details).toContain("import { isEmptyValue } from './emptyValue';");
    expect(details).toContain("return isEmptyValue(value) ? '' : String(value).trim();");
  });
});

describe('everything filled in', () => {
  const v = reviewView(FULL, svc('privatecharter', 'Private Charter Air Ambulance Service'), t);
  test('the service card: the Home icon key and the name in the app\'s language (written once)', () => {
    expect(v.service).toEqual({ key: 'privatecharter', name: 'Private Charter Air Ambulance Service' });
  });
  test('Patient: name full width, then age and gender as SEPARATE fields, contact number, country', () => {
    expect(v.patient.titleKey).toBe('rd_patient');
    expect(v.patient.fields.map((f) => [f.key, f.value, !!f.full])).toEqual([
      ['name', 'Ananya Sharma', true], ['age', '34', false], ['gender', 'Female', false], ['contact', '+91 98765 43210', false], ['country', 'India', false],
    ]);
  });
  test('Trip: From, To, and the date written like "15 Nov 2026", not "2026-11-15"', () => {
    expect(v.trip.from).toBe(FULL.location);
    expect(v.trip.to).toBe(FULL.dest);
    expect(v.trip.rows).toEqual([{ key: 'date', label: 'Date of service', value: '15 Nov 2026', full: false }]);
  });
  test('Medical: urgency chip, condition, care level, mobility, and only the equipment that is on', () => {
    expect(v.medical.urgency).toMatchObject({ bg: '#FDF0DA', fg: '#8F4C08' });
    expect(v.medical.condition).toBe(FULL.desc);
    expect(v.medical.care).toEqual(['Stable / Monitored']);
    expect(v.medical.mobility).toBe('Wheelchair');
    expect(v.medical.equipment).toEqual({ items: ['Oxygen', 'Cardiac monitor'], none: false });
  });
  test('Documents: one row per file, "Medical report · PDF · 1.2 MB", an image gets the image look, no row is tappable', () => {
    expect(v.documents).toHaveLength(2);
    expect(v.documents[0]).toMatchObject({ name: 'discharge-summary.pdf', meta: 'Medical report · PDF · 1.2 MB', isImage: false, openable: false });
    expect(v.documents[1]).toMatchObject({ name: 'ecg.png', meta: 'Medical report · PNG · 640 KB', isImage: true, openable: false });
  });
  test('all four sections show', () => {
    expect(v.show).toEqual({ patient: true, trip: true, medical: true, documents: true });
  });
});

describe('empty fields and empty sections are hidden', () => {
  const base = { ...FULL, files: [] };
  test('no value is ever "—", "None", "N/A" or "Not provided"', () => {
    const v = reviewView({ ...FULL, age: '', gender: '', country: '—', desc: '   ', mobility: '', care: [], urgency: '' }, svc('privatecharter'), t);
    const text = JSON.stringify(v);
    ['"—"', 'N/A', 'Not provided', 'Not attached'].forEach((bad) => expect(text).not.toContain(bad));
    expect(v.patient.fields.map((f) => f.key)).toEqual(['name', 'contact']);
    expect(v.medical.condition).toBe('');
    expect(v.medical.care).toEqual([]);
    expect(v.medical.mobility).toBe('');
    expect(v.medical.urgency).toBe(null);
  });
  test('the label goes with the value: a hidden field has no row at all', () => {
    const v = reviewView({ ...base, phone: '  ' }, svc('privatecharter'), t);
    expect(v.patient.fields.find((f) => f.key === 'contact')).toBeUndefined();
  });
  test('Required on board: only the items that are on; none on hides the whole row', () => {
    expect(reviewView({ ...base, equipOxygen: false, equipCardiac: true }, svc('air'), t).medical.equipment).toEqual({ items: ['Cardiac monitor'], none: false });
    expect(reviewView({ ...base, equipOxygen: false, equipCardiac: false, equipVentilator: false }, svc('air'), t).medical.equipment).toBe(null);
  });
  test('a real value that looks empty is NOT hidden: age 0', () => {
    expect(reviewView({ ...base, age: '0' }, svc('ground'), t).patient.fields.find((f) => f.key === 'age')).toMatchObject({ value: '0' });
  });
  test('a whole section is hidden when everything in it is empty', () => {
    const v = reviewView({ ...base, location: '', dest: '', date: '', urgency: '', desc: '', care: [], mobility: '', equipOxygen: false, equipCardiac: false }, svc('ground'), t);
    expect(v.show.trip).toBe(false);
    expect(v.show.medical).toBe(false);
    expect(v.show.documents).toBe(false);
    expect(v.show.patient).toBe(true);
  });
  test('no files, no Documents section', () => {
    expect(reviewView(base, svc('ground'), t).show.documents).toBe(false);
  });
  test('only a destination is still a Trip (and the route shows only that end)', () => {
    const v = reviewView({ ...base, location: '', date: '' }, svc('ground'), t);
    expect(v.show.trip).toBe(true);
    expect(v.trip.from).toBe('');
    expect(v.trip.to).toBe(FULL.dest);
  });
  test('the service card is always there, whatever else is empty', () => {
    const v = reviewView({ service: 'ground' }, svc('ground', 'Ground Ambulance'), t);
    expect(v.service.name).toBeTruthy();
    expect(v.show).toEqual({ patient: false, trip: false, medical: false, documents: false });
  });
});

describe('"Show more" only for long text', () => {
  test('the same rule as Request Details: more than four lines', () => {
    expect(needsClamp(21 * 4)).toBe(false);
    expect(needsClamp(21 * 4 + 2)).toBe(true);
  });
  test('the review step draws the condition with the shared Condition block (4 lines, Show more / Show less)', () => {
    const blocks = read('components/request/DetailsBlocks.js');
    expect(blocks).toContain('numberOfLines={open ? undefined : 4}');
    expect(blocks).toContain("t(open ? 'rd_show_less' : 'rd_show_more')");
    expect(blocks).toContain('{long ? (');
    expect(blocks).toContain('<Condition key="c" text={medical.condition} t={t} />');
  });
});

describe('every service shows every field its form collects', () => {
  const KEYS = Object.keys(SERVICES);
  const draftKeys = (() => {
    const src = read('state/AppContext.js');
    const body = src.slice(src.indexOf('export const INITIAL_DRAFT = {'), src.indexOf('\n};', src.indexOf('export const INITIAL_DRAFT = {')));
    return [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  })();

  test('every key of the form\'s draft is either shown somewhere or is bookkeeping (nothing collected is left off)', () => {
    const known = new Set([
      ...Object.keys(FORM_FIELDS.always), ...Object.keys(FORM_FIELDS.transport), ...Object.keys(FORM_FIELDS.commercialair), ...Object.keys(FORM_FIELDS.mortal), ...Object.keys(FORM_FIELDS.tele), ...Object.keys(FORM_FIELDS.home), ...Object.keys(FORM_FIELDS.mvt), ...Object.keys(FORM_FIELDS.marine), ...Object.keys(FORM_FIELDS.corporate), ...NOT_SHOWN,
    ]);
    expect(draftKeys.length).toBeGreaterThan(25);
    expect(draftKeys.filter((k) => !known.has(k))).toEqual([]);
  });

  const SHOWN = {
    name: (v) => v.patient.fields.some((f) => f.key === 'name' && f.value === FULL.name),
    age: (v) => v.patient.fields.some((f) => f.key === 'age' && f.value === FULL.age),
    gender: (v) => v.patient.fields.some((f) => f.key === 'gender' && f.value === 'Female'),
    phone: (v) => v.patient.fields.some((f) => f.key === 'contact' && f.value === '+91 98765 43210'),
    cc: (v) => v.patient.fields.some((f) => f.key === 'contact' && f.value.startsWith('+91')),
    country: (v) => v.patient.fields.some((f) => f.key === 'country' && f.value === 'India'),
    location: (v) => v.trip.from === FULL.location,
    dest: (v) => v.trip.to === FULL.dest,
    // the date of service is on the Trip; for Teleconsultation (a House Call's Preferred Visit Date) it is with the medical details
    date: (v) => v.trip.rows.some((r) => r.key === 'date' && r.value === '15 Nov 2026') || v.medical.details.some((r) => r.key === 'visitDate' && r.value === '15 Nov 2026')
      || v.patient.fields.some((f) => f.key === 'serviceDate' && f.value === '15 Nov 2026')
      || v.medical.details.some((r) => r.key === 'treatmentDate' && r.value === '15 Nov 2026') // Medical Value Travel's Preferred Treatment Date
      || v.medical.details.some((r) => r.key === 'serviceDate' && r.value === '15 Nov 2026'), // Marine Medical Safety's Date of Service
    homeAddress: (v) => v.patient.fields.some((f) => f.key === 'address' && f.value === FULL.homeAddress),
    homeCaretakers: (v) => v.medical.details.some((r) => r.key === 'caretaker' && r.value === 'Nurse, Caretaker'),
    homeCareHours: (v) => v.medical.details.some((r) => r.key === 'hours' && r.value === '12 Hours'),
    homeCareLevel: (v) => v.medical.details.some((r) => r.key === 'careLevel' && r.value === 'Full ICU'),
    homeOxygen: (v) => v.medical.details.some((r) => r.key === 'oxygen' && r.value.includes('4 LPM')),
    teleScope: (v) => v.patient.fields.some((f) => f.key === 'scope' && f.value === 'International'),
    // Medical Value Travel: the Treatment Scope is a patient detail; the Specialty (and the Other text) a medical one
    treatmentScope: (v) => v.patient.fields.some((f) => f.key === 'scope' && f.value === 'International'),
    specialty: (v) => v.medical.details.some((r) => r.key === 'specialty' && r.value === 'Other: Sports medicine'),
    otherSpecialty: (v) => v.medical.details.some((r) => r.key === 'specialty' && r.value.includes('Sports medicine')),
    // Marine Medical Safety: the Service Scope is a patient detail; the Critical Level and the Oxygen answer are medical ones
    serviceScope: (v) => v.patient.fields.some((f) => f.key === 'scope' && f.value === 'International'),
    marineCare: (v) => v.medical.details.some((r) => r.key === 'criticalLevel' && r.value === 'ICU, ECMO'),
    marineOxygen: (v) => v.medical.details.some((r) => r.key === 'oxygen' && r.value.includes('4 LPM')),
    teleType: (v) => v.patient.fields.some((f) => f.key === 'type' && f.value === 'House Call'),
    address: (v) => v.patient.fields.some((f) => f.key === 'address' && f.value === FULL.address),
    allergies: (v) => v.medical.details.some((r) => r.key === 'allergies' && r.value === 'Penicillin.'),
    urgency: (v) => !!v.medical.urgency,
    desc: (v) => v.medical.condition === FULL.desc,
    files: (v) => v.documents.length === 2,
    care: (v) => v.medical.care.length === 1,
    mobility: (v) => v.medical.mobility === 'Wheelchair',
    equipOxygen: (v) => !!v.medical.equipment && v.medical.equipment.items.some((item) => item.startsWith('Oxygen')),
    oxygenLpm: (v) => (!!v.medical.equipment && v.medical.equipment.items.includes('Oxygen (4 LPM)')) || v.medical.details.some((r) => r.key === 'oxygen' && r.value === 'Oxygen (4 LPM)'),
    equipCardiac: (v) => !!v.medical.equipment && v.medical.equipment.items.includes('Cardiac monitor'),
    equipVentilator: () => true, // false in FULL (see below: checked with a draft that has it on)
    airlineMode: (v) => v.medical.travel === 'Stretcher', // Travel type is in the Medical details (it was on the Trip)
    transferScope: (v) => v.patient.fields.some((f) => f.key === 'scope' && f.value === 'Domestic'),
    transportMode: (v) => v.patient.fields.some((f) => f.key === 'mode' && f.value === 'Private Charter'),
    relation: (v) => v.patient.fields.some((f) => f.key === 'relation'),
    deathPlace: (v) => v.patient.fields.some((f) => f.key === 'deathPlace' && f.value === FULL.deathPlace),
    deathDate: (v) => v.patient.fields.some((f) => f.key === 'deathDate' && f.value === '01 Oct 2026'),
    // Corporate Medical Solutions: the company and the employee count are patient details; the programmes and the two requirements are medical ones
    corpCompany: (v) => v.patient.fields.some((f) => f.key === 'company' && f.value === 'Acme Industries Pvt Ltd'),
    corpEmployees: (v) => v.patient.fields.some((f) => f.key === 'employees' && f.value === '250'),
    corpProgrammes: (v) => v.medical.details.some((r) => r.key === 'programmes' && r.value === 'Doctor, Events'),
    corpAny: (v) => v.medical.details.some((r) => r.key === 'anyRequirement' && r.value === 'Two doctors on site.'),
    corpSpecial: (v) => v.medical.details.some((r) => r.key === 'specialRequirement' && r.value === 'Night shift cover.'),
    corpOfficeAddress: (v) => v.patient.fields.some((f) => f.key === 'officeAddress' && f.value === 'Plot 14, Andheri East,\nMumbai 400069'),
    corpOfficeCountry: (v) => v.patient.fields.some((f) => f.key === 'officeCountry' && f.value === 'United Arab Emirates'),
  };

  KEYS.forEach((key) => {
    test(`${key}: every field it collects is on the page`, () => {
      // the service key the form sends: the sub-type is part of it for Commercial Airlines and Mortal Remains
      const full = key === 'commercialair' ? 'commercialair_stretcher' : key === 'mortal' ? 'mortal' : key;
      const v = reviewView({ ...FULL, equipVentilator: true }, svc(full), t);
      const expected = fieldsFor(full);
      Object.keys(expected).forEach((field) => {
        expect({ service: key, field, shown: SHOWN[field](v) }).toEqual({ service: key, field, shown: true });
      });
    });
  });

  test('a field of another service is not drawn (no care level on a hospital request, no death fields on an ambulance)', () => {
    const hospital = reviewView(FULL, svc('hospital'), t);
    expect(hospital.medical.care).toEqual([]);
    expect(hospital.medical.mobility).toBe('');
    expect(hospital.medical.equipment).toBe(null);
    expect(hospital.trip.rows.map((r) => r.key)).toEqual(['date']);
    expect(hospital.patient.fields.map((f) => f.key)).not.toContain('relation');
  });

  test('Mortal Remains: the deceased\'s details, the Transfer Scope and Transport Mode, "Details", and the documents are neutral supporting documents', () => {
    const v = reviewView(FULL, svc('mortal'), t);
    expect(v.patient.titleKey).toBe('rd_deceased');
    expect(v.patient.fields.find((f) => f.key === 'name').label).toBe("Deceased Person's Name");
    // the approved review order: name, age, gender, relationship, scope, mode, place of death, country, date of death, contact
    expect(v.patient.fields.map((f) => f.key)).toEqual(['name', 'age', 'gender', 'relation', 'scope', 'mode', 'deathPlace', 'country', 'deathDate', 'contact']);
    expect(v.patient.fields.find((f) => f.key === 'scope')).toMatchObject({ label: 'Transfer Scope', value: 'Domestic' });
    expect(v.patient.fields.find((f) => f.key === 'mode')).toMatchObject({ label: 'Transport Mode', value: 'Private Charter' });
    expect(v.medical.conditionLabel).toBe('Details');
    expect(v.medical.urgency).toBeTruthy();
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
    expect(v.trip.rows.find((r) => r.key === 'date').label).toBe('Preferred transfer date');
    // one combined upload section: the app cannot tell the certificate from the other files, so none is called a Death certificate
    expect(v.documents[0].meta.startsWith('Supporting document')).toBe(true);
    expect(v.documents[0].meta.startsWith('Death certificate')).toBe(false);
  });
  test('Mortal Remains: age 0 is shown (it is a valid age for the deceased)', () => {
    const v = reviewView({ ...FULL, age: '0' }, svc('mortal'), t);
    expect(v.patient.fields.find((f) => f.key === 'age').value).toBe('0');
  });

  test('Commercial Airlines: the travel type', () => {
    const v = reviewView(FULL, svc('commercialair_stretcher'), t);
    expect(v.medical.travel).toBe('Stretcher');
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']); // no longer on the Trip
  });
});

describe('long values wrap and never run off the screen', () => {
  test('the blocks wrap every value; only a file name is one line with an ellipsis', () => {
    const blocks = read('components/request/DetailsBlocks.js');
    const parts = read('components/request/DetailsParts.js');
    expect(parts).toContain("overflowWrap: 'anywhere', wordBreak: 'break-word'");
    expect(blocks).toContain('numberOfLines={1} ellipsizeMode="tail"');
    const long = 'x'.repeat(1000);
    const v = reviewView({ ...FULL, name: long, desc: long, location: long, dest: long, files: [{ uri: 'u', name: `${long}.pdf`, size: 10 }] }, svc('ground'), t);
    expect(v.patient.fields[0].value).toBe(long);
    expect(v.medical.condition).toHaveLength(1000);
  });
});

describe('Edit and Change go to the right step; Submit is unchanged', () => {
  const review = read('app/request/review.js');
  test('Patient and Trip edit step 1; Medical and Documents edit step 2; Change picks another service', () => {
    expect(review).toMatch(/editAccessibilityLabel=\{t\('rv_edit_patient'\)\} onEdit=\{\(\) => goToStep\(1\)\}/);
    expect(review).toMatch(/editAccessibilityLabel=\{t\('rv_edit_trip'\)\} onEdit=\{\(\) => goToStep\(1\)\}/);
    expect(review).toMatch(/editAccessibilityLabel=\{t\('rv_edit_medical'\)\} onEdit=\{\(\) => goToStep\(2\)\}/);
    expect(review).toMatch(/editAccessibilityLabel=\{t\('rv_edit_documents'\)\} onEdit=\{\(\) => goToStep\(2\)\}/);
    expect(review).toContain("changeAccessibilityLabel={t('rv_change_service')} onChange={changeService}");
    expect(review).toContain("updateDraft({ changingService: true });\n    router.push('/all-services');");
  });
  test('the old "Service" section with its "Service" row is gone', () => {
    expect(review).not.toContain("t('lbl_service')");
    expect(review).not.toContain('function Section');
  });
  test('changeService and submit (the payloads, uploads, validation and error handling) are byte-for-byte what they were', () => {
    const a = review.indexOf('  const changeService = () => {');
    const b = review.indexOf('  // While files upload');
    // Re-recorded for Commercial Air, Ground Ambulance and Teleconsultation: the only changes to this block are the `equipOxygenLpm`, `careLevel`, `mobility`,
    // `equipCardiacMonitor` and `equipVentilator` lines in the "every other service" body (checked in commercialAirOxygen / CareLevel / Form.test.js and
    // groundAmbulanceForm.test.js), and the Teleconsultation branch added before the Private Charter one (checked in teleConsultationForm.test.js).
    // Re-recorded again for Mortal Remains: the only changes to this block are (1) the Mortal Remains body, sent through buildMortalPayload (lib/mortalRemains.js,
    // checked in mortalRemainsForm.test.js) instead of the generic body (which keeps its own lines, minus its deceased fields), and (2) the failed-upload message,
    // which names the files for Mortal Remains. Every other service's body, the Teleconsultation branch and the Private Charter branch are untouched.
    // Re-recorded once more for Home Healthcare: the only change to this block is one extra branch, `isHomeService(d.service) ? await apiPost('/requests', buildHomePayload(d))`,
    // between the Mortal Remains body and the generic body (checked in homeHealthcareForm.test.js). The generic body itself, the Teleconsultation branch and the Private
    // Charter branch are untouched.
    // Re-recorded once more for Medical Value Travel: the only change to this block is one extra branch, `isMvtService(d.service) ? await apiPost('/requests', buildMvtPayload(d))`,
    // between the Home Healthcare body and the generic body (checked in medicalValueTravelForm.test.js). The generic body (which an older `medvalue` request still
    // uses on the server), the Home Healthcare and Mortal Remains branches, the Teleconsultation branch and the Private Charter branch are untouched.
    // Re-recorded once more for Marine Medical Safety: the only change to this block is one extra branch, `isMarineService(d.service) ? await apiPost('/requests', buildMarinePayload(d))`,
    // between the Medical Value Travel body and the generic body (checked in marineMedicalSafetyForm.test.js). The generic body (which an older `marine` request still uses on the
    // server), the Medical Value Travel, Home Healthcare and Mortal Remains branches, the Teleconsultation branch and the Private Charter branch are untouched.
    // Re-recorded once more for Corporate Medical Solutions: the only change to this block is one extra branch before the Private Charter one,
    // `if (isCorporateService(d.service)) { ... await apiPost('/requests', buildCorporatePayload(d)) ... }` (checked in corporateMedicalForm.test.js). Every other branch is untouched.
    // The Private Charter branch itself is untouched.
    // Re-recorded for Phase 4 (idempotent submission): every send now goes through `send(...)`, which adds the submission's idempotency key (lib/requestSubmission.js) and confirms
    // the key once the server has saved the request; the catch starts with the unknown-outcome check (an answer that never arrived is not shown as a failure); the
    // "Check status" function sits before the upload label. The payload builders, the generic body, the uploads and the field-error handling are untouched
    // (requestIdempotency.test.js checks all of this).
    // Re-recorded again for the Phase 4 follow-up (recovery safety): a retry sends the ORIGINAL payload, so `send` passes `sendOriginal`; the catch tells an edited form (nothing sent)
    // apart from an unconfirmed outcome and a confirmed refusal; and the explicit choices (send the original again, submit the changes as a new request, keep the original) sit next to
    // "Check status". The payload builders and every service's body are untouched.
    // Re-recorded for the simplified offline experience: the recovery cards and their handlers (Check status, send the original, keep the original, submit changes) are gone from submit();
    // a lost answer is one short message and the same Submit button is the retry (same key, original payload). The payload builders and every other line are as before.
    // Re-recorded for Phase 5: submit() now sends every service's documents through sendWithDocuments (runSubmission with per-file upload ids, a Cancel button, and unknown outcomes kept apart
    // from refusals); the payload builders themselves, and every other line of the block, are as before (uploadRecovery.test.js).
    // Re-recorded for the new network design: a lost or already-sent answer sets a notice (setNotice) shown above the button instead of a toast (components/network/StatusNotice.js).
    // Re-recorded for the offline fixes: a Private Charter place typed offline is matched to the verified city list, online, before anything is sent (charterDraft; lib/citySearch.js resolveCharterCities).
    // Re-recorded for the restart-protection fix: guardedSend (lib/submissionGate.js) asks the server about an unresolved earlier submission before any send, send() passes the service, and a blocked or lost answer sets the Try again label (submissionRestart.test.js).
    // Re-recorded for the Phase 4 final safety fix: a refusal of a LATER attempt (session expired or unverified, a 4xx) while an earlier attempt is unconfirmed no longer ends the
    // pending state: Review tells the person about the refusal and keeps the unconfirmed card (requestUnknownState.test.js).
    // Re-recorded for the localization pass: the one toast of this block ("Upload at least one document ...") now reads t('req_err_need_doc') and the error toast reads errorText(err, t) (lib/errorText.js: the app's own errors in the person's language); nothing else in the block changed.
    expect(crypto.createHash('sha256').update(review.slice(a, b)).digest('hex')).toBe('fdef15532305a357509e29b0c36452f133c851e60872cdf1d9ff967b2ff9a8eb');
  });
  test('the payload bodies are still there', () => {
    expect(review).toContain('buildPrivateCharterPayload(charterDraft)');
    expect(review).toContain("patientLocation: d.location,");
    // (Mortal Remains' own body, lib/mortalRemains.js buildMortalPayload, replaced the generic body's deceased fields)
    expect(review).toContain('buildMortalPayload(d)');
  });
});

describe('the pieces', () => {
  const parts = read('components/request/ReviewParts.js');
  test('Edit / Change pill: 32 px, fully rounded, primarySoft and primary, a pencil, touch area of at least 44 px', () => {
    expect(parts).toContain('height: 32');
    expect(parts).toContain('borderRadius: 16, backgroundColor: COLORS.primarySoft');
    expect(parts).toContain('color: COLORS.primary');
    expect(parts).toContain('<Pencil size={14}');
    expect(parts).toContain('hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}');
  });
  test('the service card: 52 px icon tile, "Selected service", the name 17/800 wrapping, the Change pill', () => {
    expect(parts).toContain('width: 52, height: 52, borderRadius: 16');
    expect(parts).toContain('<ServiceIcon serviceKey={serviceKey}');
    expect(parts).toContain('fontFamily: FONT[800], fontSize: 17');
    expect(parts).toContain('<Card big padding={16}>');
    expect(parts).not.toContain('numberOfLines');
  });
  test('the heading: 12/800 uppercase #5B6B84 with its Edit pill on the right', () => {
    expect(parts).toContain("letterSpacing: 0.96, textTransform: 'uppercase', color: C.muted");
    expect(parts).toContain('justifyContent: \'space-between\'');
  });
  test('the document row: one line with an ellipsis, a chevron only when it opens, primarySoft / #E0F5F4 tiles', () => {
    const blocks = read('components/request/DetailsBlocks.js');
    expect(blocks).toContain("backgroundColor: doc.isImage ? '#E0F5F4' : COLORS.primarySoft");
    expect(blocks).toContain('{doc.openable && !offline ? <ChevronRight size={20}');
    expect(blocks).toContain('if (!doc.openable) return <View style={box}>{body}</View>;');
  });
  test('the care level and mobility sit side by side on the review page', () => {
    expect(read('components/request/DetailsBlocks.js')).toContain("rows.push(['pair', null,");
    expect(read('app/request/review.js')).toContain('<MedicalCard medical={view.medical} t={t} pair />');
  });
  test('Submit is a 52 px, radius-16 button', () => {
    expect(read('app/request/review.js')).toContain('buttonClassName="min-h-[52px] rounded-2xl"');
  });
});

describe('words, in all six languages', () => {
  const KEYS = ['rv_intro', 'rv_selected_service', 'rv_change_service', 'rv_edit_patient', 'rv_edit_trip', 'rv_edit_medical', 'rv_edit_documents'];
  test('every new key is in every language', () => {
    const langs = Object.keys(i18n);
    expect(langs).toHaveLength(6);
    KEYS.forEach((k) => langs.forEach((l) => expect(typeof i18n[l][k]).toBe('string')));
    KEYS.forEach((k) => langs.forEach((l) => expect(i18n[l][k].length).toBeGreaterThan(0)));
    expect(i18n.EN.rv_intro).toBe('Please check the details before submitting. Tap Edit to change anything.');
  });
});

describe('Edit and Change are translated, and labels are in sentence case', () => {
  const OTHERS = ['HI', 'MR', 'GU', 'TE', 'AR'];
  test('Edit and Change are not English in the other five languages, and are the same words the rest of the app already uses', () => {
    OTHERS.forEach((l) => {
      expect(i18n[l].req_edit).not.toBe('Edit');
      expect(i18n[l].req_change).not.toBe('Change');
      expect(i18n[l].req_edit).toBe(i18n[l].pd_edit);
      expect(i18n[l].req_change).toBe(i18n[l].cta_change);
    });
  });
  test('the intro sentence names the button by its translated word', () => {
    OTHERS.forEach((l) => {
      expect(i18n[l].rv_intro).toContain(i18n[l].req_edit);
      expect(i18n[l].rv_intro).not.toContain('Edit');
    });
  });
  test('English labels are sentence case, like "Patient mobility" and "Date of service"', () => {
    expect(i18n.EN.field_care_level).toBe('Care level');
    expect(i18n.EN.lbl_medical_report).toBe('Medical report');
    expect(i18n.EN.lbl_death_certificate).toBe('Death certificate');
    expect(i18n.EN.field_contact_number).toBe('Contact number');
    expect(i18n.EN.lbl_deceased_name).toBe("Deceased Person's Name"); // the approved wording (a proper name, not sentence case)
    expect(i18n.EN.field_location).toBe('Current location');
    expect(i18n.EN.field_preferred_date).toBe('Date of service');
    expect(i18n.EN.field_relation).toBe('Your relation to the deceased');
  });
  test('"Not Applicable" is left alone: the backend stores and compares that exact text', () => {
    expect(i18n.EN.care_na).toBe('Not Applicable');
  });
});

describe('Mortal Remains: shown in all five languages, stored values untouched', () => {
  const MORTAL_KEYS = [
    'lbl_deceased_name', 'field_deceased_name', 'field_relation', 'lbl_relation', 'field_place_of_death', 'field_date_of_death', 'field_mortal_transfer',
    'field_transfer_date', 'lbl_death_certificate', 'field_upload_death_cert', 'step1_heading_mortal', 'field_deceased_age', 'lbl_deceased',
    'req_details', 'req_details_placeholder', 'req_documents',
  ];
  const OTHERS = ['HI', 'MR', 'GU', 'TE', 'AR'];
  test('every Mortal Remains label has its own text in every language (not English, not blank)', () => {
    MORTAL_KEYS.forEach((k) => OTHERS.forEach((l) => {
      expect({ k, l, ok: typeof i18n[l][k] === 'string' && i18n[l][k].trim().length > 0 && i18n[l][k] !== i18n.EN[k] }).toEqual({ k, l, ok: true });
    }));
  });
  test('the answer options (relation, transfer type) already have a translation in every language', () => {
    ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'].forEach((r) => OTHERS.forEach((l) => {
      expect(i18n[l][`rd_rel_${r.toLowerCase()}`]).toBeTruthy();
      expect(i18n[l][`rd_rel_${r.toLowerCase()}`]).not.toBe(i18n.EN[`rd_rel_${r.toLowerCase()}`]);
    }));
    ['domestic', 'international'].forEach((m) => OTHERS.forEach((l) => expect(i18n[l][`rd_transfer_${m}`]).not.toBe(i18n.EN[`rd_transfer_${m}`])));
  });
  test('the form shows the translated option but keeps the stored English value (labels only)', () => {
    const step1 = read('app/request/step1.js');
    expect(step1).toContain('options={DECEASED_RELATIONS} labels={RELATION_LABELS(t)}');
    expect(step1).toContain('options={MORTAL_TRANSFERS} labels={TRANSFER_LABELS(t)}');
    expect(step1).toContain("t(`rd_rel_${r.toLowerCase()}`)");
    expect(step1).toContain("t(`rd_transfer_${m}`)");
    const mock = read('data/mock.js');
    expect(mock).toContain("export const DECEASED_RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];");
    expect(mock).toContain("export const MORTAL_TRANSFERS = ['domestic', 'international'];");
    expect(mock).toContain("export const MORTAL_TRANSFER_LABELS = { domestic: 'Within India', international: 'International' };");
  });
  test('the English text the backend stores or compares is not changed: the English "Not Applicable" and the document types', () => {
    expect(i18n.EN.care_na).toBe('Not Applicable');
    expect(read('lib/requestDetailsView.js')).toContain("if (v === 'Death Certificate') return t('lbl_death_certificate');");
  });
});

describe('right-to-left: text is aligned to the start of the app\'s direction', () => {
  test('the shared blocks use AlignedText for labels and values (an English value sits under its Arabic label)', () => {
    const parts = read('components/request/DetailsParts.js');
    const blocks = read('components/request/DetailsBlocks.js');
    expect(parts).toContain("{ textAlign: isRTL ? 'right' : 'left' }");
    expect(parts).toContain('export function AlignedText(');
    expect(parts.match(/<AlignedText/g).length).toBeGreaterThanOrEqual(2);
    expect(blocks.match(/<AlignedText/g).length).toBeGreaterThanOrEqual(7);
  });
  test('a long service card never breaks a word: the row wraps', () => {
    expect(read('components/request/ReviewParts.js')).toContain("flexDirection: 'row', flexWrap: 'wrap'");
  });
});
