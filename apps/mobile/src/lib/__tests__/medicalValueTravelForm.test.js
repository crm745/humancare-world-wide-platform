/* global describe, test, expect, __dirname */
// Medical Value Travel (serviceKey "medvalue"): the dedicated Step 1 and Step 2, the rules, the payload, the description the server composes and how it is
// read back, the review and details display, and that older (generic) medvalue requests and every other service are untouched.
const fs = require('fs');
const path = require('path');
const {
  MVT_SPECIALTIES, MVT_SCOPES, MVT_OTHER_SPECIALTY, MVT_TEXT, isMvtService, mvtText, isValidMvtName, isValidMvtAge, defaultCountryIso, isValidTreatmentDate, cityProblems,
  mvtStep1Problems, mvtStep2Problems, buildMvtPayload, contactE164, cityRef, parseMvtDescription, isNewMvtRequest, mvtFromRequest, freeTextProblem, HISTORY_MAX, OTHER_MAX, CITY_MAX,
} = require('../medicalValueTravel');
const backend = require('../../../../../backend/src/modules/requests/medical-value-travel.validation');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { draftForService } = require('../requestForm');
const { requestService } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const NL = String.fromCharCode(10);
const NOW = new Date(2026, 10, 17, 12, 0, 0); // 17 Nov 2026, the device's own calendar
const PUNE = { geonameId: 1, name: 'Pune', label: 'Pune, Maharashtra, India', countryCode: 'IN' };
const MUMBAI = { geonameId: 2, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' };
const DUBAI = { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE' };
const draft = (extra = {}) => ({
  service: 'medvalue', treatmentScope: 'international', name: 'Asha Nair', age: '61', gender: 'Female', country: 'India', countryIso: 'IN', cc: '+91', phoneCountry: 'IN', phone: '98765 43210',
  location: PUNE.label, originCity: PUNE, dest: DUBAI.label, destCity: DUBAI, date: '', specialty: 'Oncology', otherSpecialty: '', desc: '', files: [], ...extra,
});

describe('the specialty list', () => {
  test('is the approved 24, in order, Other last, and is the list the server holds', () => {
    expect(MVT_SPECIALTIES).toHaveLength(24);
    expect(MVT_SPECIALTIES[0]).toBe('Cardiology and Cardiac Surgery');
    expect(MVT_SPECIALTIES[22]).toBe('Ayurveda and Wellness');
    expect(MVT_SPECIALTIES[23]).toBe(MVT_OTHER_SPECIALTY);
    expect(MVT_SPECIALTIES).toEqual(backend.SPECIALTIES);
    expect(new Set(MVT_SPECIALTIES).size).toBe(24);
  });
  test('is long enough for the shared Select to offer its search box', () => {
    const widgets = read('components/widgets.js');
    const from = Number(/const SEARCH_FROM = (\d+);/.exec(widgets)[1]);
    expect(MVT_SPECIALTIES.length).toBeGreaterThan(from);
  });
  test('the two scopes', () => {
    expect(MVT_SCOPES).toEqual(['domestic', 'international']);
    expect(Object.keys(backend.SCOPES)).toEqual(MVT_SCOPES);
  });
});

describe('the service itself', () => {
  test('the key and the name are the existing ones', () => {
    expect(isMvtService('medvalue')).toBe(true);
    expect(isMvtService('hospital')).toBe(false);
    expect(SERVICES.medvalue.title).toBe('Medical Value Travel');
    expect(requestService({ service: 'medvalue' }, SERVICES)).toEqual({ title: 'Medical Value Travel', key: 'medvalue' });
  });
  test('the name the app sends is the name the server requires', () => {
    expect(buildMvtPayload(draft(), NOW).serviceType).toBe(backend.MVT_SERVICE_TYPE);
    expect(buildMvtPayload(draft(), NOW).serviceKey).toBe(backend.MVT_SERVICE_KEY);
  });
});

describe('the patient fields', () => {
  test('name: 2 to 191 characters with a letter', () => {
    expect(isValidMvtName('Asha Nair')).toBe(true);
    expect(isValidMvtName('A'.repeat(191))).toBe(true);
    for (const bad of ['', ' ', 'A', 'A'.repeat(192), '12345', 'A\nB']) expect(isValidMvtName(bad)).toBe(false);
  });
  test('age: a whole number from 0 to 129', () => {
    for (const ok of ['0', '1', '61', '129', 7]) expect(isValidMvtAge(ok)).toBe(true);
    for (const bad of ['', '130', '-1', '1.5', 'abc', '007', null, undefined]) expect(isValidMvtAge(bad)).toBe(false);
  });
  test('the contact number is sent in E.164', () => {
    expect(contactE164('+91', '98765 43210')).toBe('+919876543210');
    expect(contactE164('+971', '050 123 4567')).toBe('+971501234567'); // the trunk zero is dropped by the country's own rules
  });
});

describe('the Country starts from the account, and can be changed', () => {
  test('Nationality first, then the phone country; nothing when neither is known', () => {
    expect(defaultCountryIso({ nationality: 'AE', phoneCountry: 'IN' })).toBe('AE');
    expect(defaultCountryIso({ nationality: '', phoneCountry: 'GB' })).toBe('GB');
    expect(defaultCountryIso({ nationality: 'ae' })).toBe('AE');
    expect(defaultCountryIso({ nationality: '', phoneCountry: '' })).toBe('');
    expect(defaultCountryIso({})).toBe('');
    expect(defaultCountryIso(null)).toBe('');
    expect(defaultCountryIso({ nationality: 'XX', phoneCountry: 'IN' })).toBe('IN'); // an unknown code is not a country
  });
  test('Step 1 applies it once, only while no country is chosen, through the existing country picker rule', () => {
    const step1 = read('components/request/MvtStep1.js');
    expect(step1).toContain('defaultCountryIso(profile)');
    expect(step1).toContain('if (draft.countryIso) return;');
    expect(step1).toContain('pickRequestCountry(draft, iso)');
    expect(step1).toContain("onPick={(code) => { setPicking(null); updateDraft(pickRequestCountry(draft, code)); }}"); // the person can change it
    expect(read('lib/requestForm.js')).toContain('export function pickRequestCountry');
  });
});

describe('the cities and the scope', () => {
  const places = (extra = {}) => cityProblems({ scope: 'international', countryIso: 'IN', location: PUNE.label, originCity: PUNE, dest: DUBAI.label, destCity: DUBAI, ...extra });
  test('picked cities: the Current City is in the country; a Domestic destination too; an International one is not', () => {
    expect(places()).toEqual({ location: null, dest: null });
    expect(places({ countryIso: 'AE' }).location).toBe('wrong_country');
    expect(places({ scope: 'domestic' }).dest).toBe('wrong_country');
    expect(places({ scope: 'domestic', destCity: MUMBAI, dest: MUMBAI.label })).toEqual({ location: null, dest: null });
    expect(places({ destCity: MUMBAI, dest: MUMBAI.label }).dest).toBe('same_country');
  });
  test('typed cities: required, and nothing is claimed about their country', () => {
    expect(places({ originCity: null, location: 'Hinjewadi', destCity: null, dest: 'Atlantis', countryIso: 'AE' })).toEqual({ location: null, dest: null });
    expect(places({ originCity: null, location: '  ' }).location).toBe('required');
    expect(places({ destCity: null, dest: '' }).dest).toBe('required');
  });
  test('with no country chosen nothing is compared yet', () => {
    expect(places({ countryIso: '' })).toEqual({ location: null, dest: null });
  });
  test('a picked city is sent as its id, a typed one exactly as typed', () => {
    expect(cityRef(PUNE, PUNE.label)).toEqual({ geonameId: 1 });
    expect(cityRef(null, '  Hinjewadi  (Phase 2) ')).toEqual({ text: '  Hinjewadi  (Phase 2) ' });
  });
  test('both city fields are the existing searchable CityField, with manual input (never "structured")', () => {
    const step1 = read('components/request/MvtStep1.js');
    expect((step1.match(/<CityField/g) || [])).toHaveLength(2);
    expect((step1.match(/structured=\{false\}/g) || [])).toHaveLength(2);
    expect(step1).toContain('onChangeText={(location) => updateDraft({ location, originCity: null })}');
    expect(step1).toContain('onChangeText={(dest) => updateDraft({ dest, destCity: null })}');
    expect(step1).not.toContain('resolveTypedCity'); // a typed city is never silently turned into a verified one
  });
});

describe('what is wrong, in page order', () => {
  const ids = (list) => list.filter(([, bad]) => bad).map(([id]) => id);
  test('a complete Step 1 has no problem; an empty one lists every required field in page order', () => {
    expect(ids(mvtStep1Problems(draft()))).toEqual([]);
    expect(ids(mvtStep1Problems({ service: 'medvalue', cc: '+91', phoneCountry: 'IN', name: '', age: '', gender: '', countryIso: '', phone: '', location: '', dest: '', treatmentScope: '' })))
      .toEqual(['scope', 'name', 'age', 'country', 'phone', 'location', 'dest']);
  });
  test('Step 1 problems: gender, a wrong-country picked city', () => {
    expect(ids(mvtStep1Problems(draft({ gender: '' })))).toEqual(['age']);
    expect(ids(mvtStep1Problems(draft({ treatmentScope: 'domestic' })))).toEqual(['dest']);
  });
  test('Step 2: only the specialty is required; the date, the Other text (when Other) and the history are judged when given', () => {
    expect(ids(mvtStep2Problems(draft(), NOW))).toEqual([]);
    expect(ids(mvtStep2Problems(draft({ specialty: '' }), NOW))).toEqual(['specialty']);
    expect(ids(mvtStep2Problems(draft({ specialty: 'Other' }), NOW))).toEqual(['otherSpecialty']);
    expect(ids(mvtStep2Problems(draft({ specialty: 'Other', otherSpecialty: 'Sports medicine' }), NOW))).toEqual([]);
    expect(ids(mvtStep2Problems(draft({ date: '2026-11-16' }), NOW))).toEqual(['date']);
    expect(ids(mvtStep2Problems(draft({ desc: 'h'.repeat(2001) }), NOW))).toEqual(['history']);
    expect(ids(mvtStep2Problems(draft({ specialty: 'Cardiology' }), NOW))).toEqual(['specialty']); // not one of the listed ones
  });
  test('the Preferred Treatment Date is optional, and today or later', () => {
    expect(isValidTreatmentDate('', NOW)).toBe(true);
    expect(isValidTreatmentDate('   ', NOW)).toBe(true);
    expect(isValidTreatmentDate('2026-11-17', NOW)).toBe(true);
    expect(isValidTreatmentDate('2026-11-18', NOW)).toBe(true);
    expect(isValidTreatmentDate('2027-01-01', NOW)).toBe(true);
    expect(isValidTreatmentDate('2026-11-16', NOW)).toBe(false);
    expect(isValidTreatmentDate('2026-02-30', NOW)).toBe(false);
    expect(isValidTreatmentDate('17/11/2026', NOW)).toBe(false);
  });
  test('free text limits count characters: Other 191, Medical History 2,000, a city 191', () => {
    expect(freeTextProblem('h'.repeat(HISTORY_MAX), { max: HISTORY_MAX })).toBeNull();
    expect(freeTextProblem('h'.repeat(HISTORY_MAX + 1), { max: HISTORY_MAX })).toBe('too_long');
    expect(freeTextProblem('\u{1F600}'.repeat(HISTORY_MAX), { max: HISTORY_MAX })).toBeNull();
    expect(freeTextProblem('x'.repeat(OTHER_MAX + 1), { required: true, max: OTHER_MAX, oneLine: true })).toBe('too_long');
    expect(freeTextProblem('a\nb', { max: CITY_MAX, oneLine: true })).toBe('one_line');
    expect(freeTextProblem('a\u0000b', { max: HISTORY_MAX })).toBe('characters');
    expect(freeTextProblem('   ', { required: true, max: OTHER_MAX })).toBe('required');
  });
});

describe('what is sent', () => {
  const sent = (extra, now = NOW) => buildMvtPayload(draft(extra), now);
  test('the structured body: scope, patient, ISO country, E.164 contact, the two cities, the specialty and the UTC offset', () => {
    expect(sent()).toEqual({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', treatmentScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      country: 'IN', patientContact: '+919876543210', currentCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, specialty: 'Oncology',
      utcOffsetMinutes: 0 - NOW.getTimezoneOffset(),
    });
  });
  test('never sends what this service does not collect', () => {
    const body = sent({ urgency: 'urgent_24h', mobility: 'walking', equipOxygen: true, oxygenLpm: '4', care: ['crit_icu'], date: '2026-12-01', desc: 'x' });
    for (const key of ['urgency', 'mobility', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator', 'careLevel', 'description', 'origin', 'destination', 'patientLocation', 'transferScope', 'details']) {
      expect(body).not.toHaveProperty(key);
    }
  });
  test('typed cities are sent exactly as typed, without an id', () => {
    const body = sent({ originCity: null, location: '  Hinjewadi   Phase 2 ', destCity: null, dest: 'Chennai' });
    expect(body.currentCity).toEqual({ text: '  Hinjewadi   Phase 2 ' });
    expect(body.destinationCity).toEqual({ text: 'Chennai' });
  });
  test('Other sends its text; any other specialty sends none, even if some was left in the draft', () => {
    expect(sent({ specialty: 'Other', otherSpecialty: 'Sports medicine' })).toMatchObject({ specialty: 'Other', otherSpecialty: 'Sports medicine' });
    expect(sent({ specialty: 'Urology', otherSpecialty: 'left over' })).not.toHaveProperty('otherSpecialty');
  });
  test('the Medical History and the date go only when entered; the history is sent exactly as typed', () => {
    expect(sent()).not.toHaveProperty('medicalHistory');
    expect(sent()).not.toHaveProperty('preferredDate');
    expect(sent({ desc: '   \n ', date: '  ' })).not.toHaveProperty('medicalHistory');
    expect(sent({ desc: '  Knee pain.\r\nSecond line  ', date: '2026-12-01' })).toMatchObject({ medicalHistory: '  Knee pain.\r\nSecond line  ', preferredDate: '2026-12-01' });
  });
  test('the UTC offset is the device\'s, minutes east of UTC', () => {
    expect(buildMvtPayload(draft(), { getTimezoneOffset: () => -330 }).utcOffsetMinutes).toBe(330);
    expect(buildMvtPayload(draft(), { getTimezoneOffset: () => 300 }).utcOffsetMinutes).toBe(-300);
  });
  test('submitting goes through this builder only for medvalue; every other branch of the submit is the same', () => {
    const review = read('app/request/review.js');
    expect(review).toContain("isMvtService(d.service) ? await apiPost('/requests', buildMvtPayload(d))");
    expect(review.indexOf('buildHomePayload(d)')).toBeLessThan(review.indexOf('buildMvtPayload(d)'));
    expect(review.indexOf('buildMvtPayload(d)')).toBeLessThan(review.indexOf('patientLocation: d.location,')); // before the generic body
    expect(review).toContain('buildMortalPayload(d)');
    expect(review).toContain('buildTelePayload(d)');
    expect(review).toContain('buildPrivateCharterPayload(d)');
  });
});

describe('the words on screen: translations come later, English until then', () => {
  test('every key has an English default that is shown while no translation exists', () => {
    for (const key of Object.keys(MVT_TEXT)) expect(mvtText(t, key, { max: 129, country: 'India' })).not.toBe(key);
    expect(mvtText(t, 'mvt_err_age', { max: 129 })).toBe('Enter an age from 0 to 129.');
    expect(mvtText(t, 'mvt_err_current_country', { country: 'India' })).toBe('This city is not in India. Pick a city in India, or change the country.');
  });
  test('a translation, once added under the same key, wins', () => {
    const translated = (key, values) => (key === 'mvt_specialty' ? 'विशेषज्ञता' : t(key, values));
    expect(mvtText(translated, 'mvt_specialty')).toBe('विशेषज्ञता');
    expect(mvtText(translated, 'mvt_history')).toBe('Medical History');
  });
  test('no translation file was needed: none of these keys is in i18n.json yet (they are added in the translation phase)', () => {
    for (const key of Object.keys(MVT_TEXT)) expect(Object.prototype.hasOwnProperty.call(i18n.EN, key)).toBe(false);
  });
});

describe('the description the server composes, read back', () => {
  const VECTORS = [
    { specialty: 'Oncology', other: '', history: '' },
    { specialty: 'Urology', other: '', history: 'Stones.' },
    { specialty: 'Other', other: 'Sports medicine', history: '' },
    { specialty: 'Other', other: 'Sleep medicine', history: 'Insomnia for years.' },
    { specialty: 'Oncology', other: '', history: 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Dental\nMedical History:\nfake' },
    { specialty: 'Other', other: 'Other Specialty:', history: '\nMedical History:\nSpecialty: ENT\nOther Specialty:\nx\n' },
    { specialty: 'Other', other: 'Café \u{1F600} é', history: '\u{1F600}\n\r\n日本語 العربية' },
    { specialty: 'Spine', other: '', history: 'z'.repeat(2000) },
  ];
  test.each(VECTORS)('the app reads back exactly what the server composed: %#', (parts) => {
    const text = backend.composeMvtDescription(parts);
    expect(parseMvtDescription(text)).toEqual({ ok: true, ...parts });
    expect(backend.parseMvtDescription(text)).toEqual(parseMvtDescription(text));
  });
  const INVALID = [
    'free text', '', 'Medical Value Travel v1 (other 0, history 0)', 'Medical Value Travel v2 (other 0, history 0)\nSpecialty: Oncology',
    'Medical Value Travel v1 (other 0, history 0)\nOncology', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: ', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology\nextra',
    'Medical Value Travel v1 (other 0, history 9)\nSpecialty: Oncology\nMedical History:\nshort', 'Medical Value Travel v1 (other 0, history 3)\nSpecialty: Oncology',
    'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Other', 'Medical Value Travel v1 (other 3, history 0)\nSpecialty: Oncology\nOther Specialty:\nabc',
    'Medical Value Travel v1 (other 00, history 0)\nSpecialty: Oncology', 'Medical Value Travel v1 (other 0, history 4001)\nSpecialty: Oncology',
    'Medical Value Travel v1 (other 0, history 1)\nSpecialty: Oncology\nMedical History:\n\u{1F600}', null, undefined, 5,
  ];
  test.each(INVALID.map((text, i) => [i, text]))('a description that does not parse is legacy, in the app and on the server alike: %#', (_i, text) => {
    expect(parseMvtDescription(text).ok).toBe(false);
    expect(backend.parseMvtDescription(text).ok).toBe(false);
  });
});

describe('a new request and an older one', () => {
  const NEW = {
    id: 7, referenceNumber: 'REQ-1007', status: 'submitted', serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
    country: 'India', patientContact: '+919876543210', origin: PUNE.label, destination: DUBAI.label, preferredDate: '2026-12-01T00:00:00.000Z', urgency: null, transferScope: 'international',
    description: 'Medical Value Travel v1 (other 15, history 10)\nSpecialty: Other\nOther Specialty:\nSports medicine\nMedical History:\nKnee pain.', createdAt: '2026-11-17T10:00:00.000Z', case: null, requestDocuments: [],
  };
  const OLD = { ...NEW, referenceNumber: 'REQ-900', transferScope: null, urgency: 'planned', description: 'Heart valve surgery.' };
  const rows = (list) => Object.fromEntries(list.map((r) => [r.key, r.value]));

  test('only a request with the key, a real scope and a parsing description is new', () => {
    expect(isNewMvtRequest(NEW)).toBe(true);
    expect(isNewMvtRequest(OLD)).toBe(false);
    expect(isNewMvtRequest({ ...NEW, transferScope: null })).toBe(false);
    expect(isNewMvtRequest({ ...NEW, description: 'Knee replacement' })).toBe(false);
    expect(isNewMvtRequest({ ...NEW, serviceKey: 'mortal' })).toBe(false); // Mortal Remains keeps its own meaning of the column
    expect(isNewMvtRequest({ ...NEW, serviceKey: 'hospital' })).toBe(false);
    expect(isNewMvtRequest(null)).toBe(false);
    expect(mvtFromRequest(NEW, t)).toEqual({ scope: 'International', specialty: 'Other: Sports medicine', history: 'Knee pain.' });
    expect(mvtFromRequest(OLD, t)).toBeNull();
  });

  test('a request with the specialty columns (no v1 text) is new; the description is its Medical History; the column rules match the server', () => {
    const column = { ...NEW, specialty: 'Other', otherSpecialty: 'Sports medicine', description: 'Knee pain.' };
    expect(isNewMvtRequest(column)).toBe(true);
    expect(mvtFromRequest(column, t)).toEqual({ scope: 'International', specialty: 'Other: Sports medicine', history: 'Knee pain.' });
    expect(mvtFromRequest({ ...column, specialty: 'Oncology', otherSpecialty: null, description: null }, t)).toEqual({ scope: 'International', specialty: 'Oncology', history: '' });
    // the column wins over a Medical History that looks like the v1 text
    expect(mvtFromRequest({ ...column, specialty: 'Oncology', otherSpecialty: null, description: NEW.description }, t).history).toBe(NEW.description);
    for (const bad of [{ specialty: 'Cardiology' }, { specialty: 'Other', otherSpecialty: null }, { specialty: 'Oncology', otherSpecialty: 'x' }, { transferScope: null }, { serviceKey: 'mortal' }]) {
      const row = { ...column, ...bad };
      expect(isNewMvtRequest(row)).toBe(false);
      expect(backend.isNewMvtFormat(row)).toBe(false);
    }
    expect(backend.isNewMvtFormat(column)).toBe(true);
    expect(backend.mvtFieldsOf(column)).toEqual({ ok: true, specialty: 'Other', other: 'Sports medicine', history: 'Knee pain.' });
  });
  test('Request Details: the new request shows Treatment scope, the cities, the Specialty, the date and the Medical History; no urgency', () => {
    const v = detailsView(NEW, t);
    expect(rows(v.patient.fields)).toMatchObject({ scope: 'International', name: 'Asha Nair' });
    expect(v.patient.fields[0]).toMatchObject({ key: 'scope', label: 'Treatment scope' });
    expect(v.trip).toMatchObject({ from: PUNE.label, to: DUBAI.label, rows: [] });
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('Knee pain.');
    expect(rows(v.medical.details).specialty).toBe('Other: Sports medicine');
    expect(v.medical.details.find((r) => r.key === 'treatmentDate').label).toBe('Preferred treatment date');
    expect(v.medical.urgency).toBeNull();
    expect(v.medical.care).toEqual([]);
    expect(v.medical.mobility).toBe('');
    expect(v.medical.equipment).toBeNull();
  });
  test('Request Details: an older request reads exactly as before (Condition & diagnosis, its urgency, no scope or specialty)', () => {
    const v = detailsView(OLD, t);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('scope');
    expect(v.medical.conditionLabel).toBe('Condition & diagnosis');
    expect(v.medical.condition).toBe('Heart valve surgery.');
    expect(v.medical.details).toEqual([]);
    expect(v.medical.urgency).toBeTruthy();
    expect(v.trip.rows.map((r) => r.key)).toContain('date');
  });
  test('a Domestic request says Domestic', () => {
    expect(mvtFromRequest({ ...NEW, transferScope: 'domestic' }, t).scope).toBe('Domestic');
  });
  test('Mortal Remains still shows its own Transfer Scope and not this one', () => {
    const mortal = detailsView({ ...NEW, serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', transportMode: 'ground_transportation', transferScope: 'domestic', description: 'Transfer Scope: Domestic\nTransport Mode: Ground Transportation' }, t);
    expect(mortal.patient.fields.find((f) => f.key === 'scope').label).toBe('Transfer Scope');
  });
});

describe('the review page', () => {
  const view = (extra = {}) => reviewView(draft({ date: '2026-12-01', desc: 'Knee pain.', specialty: 'Other', otherSpecialty: 'Sports medicine', files: [{ uri: 'file:///x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1000 }], ...extra }), { key: 'medvalue', title: 'Medical Value Travel' }, t);
  test('shows the scope with the patient, the two cities as the trip, and the specialty, date and Medical History as the medical details; no urgency', () => {
    const v = view();
    expect(v.patient.fields.map((f) => f.key)).toEqual(['scope', 'name', 'age', 'gender', 'country', 'contact']);
    expect(v.patient.fields[0]).toMatchObject({ label: 'Treatment scope', value: 'International' });
    expect(v.trip).toMatchObject({ from: PUNE.label, to: DUBAI.label, rows: [] });
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('Knee pain.');
    expect(v.medical.details.map((r) => [r.key, r.value])).toEqual([['specialty', 'Other: Sports medicine'], ['treatmentDate', '01 Dec 2026']]);
    expect(v.medical.urgency).toBeNull();
    expect(v.documents).toHaveLength(1);
    expect(v.show).toMatchObject({ patient: true, trip: true, medical: true, documents: true });
  });
  test('with no date, no history and no reports those rows and sections are simply left out', () => {
    const v = view({ date: '', desc: '', files: [], specialty: 'Oncology', otherSpecialty: '' });
    expect(v.medical.details.map((r) => r.key)).toEqual(['specialty']);
    expect(v.medical.condition).toBe('');
    expect(v.show.documents).toBe(false);
  });
  test('every field the form collects has a place on the page', () => {
    const keys = Object.keys(fieldsFor('medvalue'));
    for (const key of ['treatmentScope', 'specialty', 'otherSpecialty', 'date', 'name', 'country', 'location', 'dest', 'desc', 'files']) expect(keys).toContain(key);
    for (const key of ['urgency', 'mobility', 'care', 'equipOxygen']) expect(keys).not.toContain(key);
  });
});

describe('the forms', () => {
  const step1 = read('components/request/MvtStep1.js');
  const step2 = read('components/request/MvtStep2.js');
  test('Step 1 and Step 2 are used for medvalue only', () => {
    expect(read('app/request/step1.js')).toContain('if (isMvtService(draft.service)) return <MvtStep1 />;');
    expect(read('app/request/step2.js')).toContain('if (isMvtService(draft.service)) return <MvtStep2 />;');
  });
  test('Step 1 order: scope, name, age and gender, country, contact, the two cities (the treatment is Step 2)', () => {
    const anchors = [...step1.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
    expect(anchors).toEqual(['scope', 'name', 'age', 'country', 'phone', 'location', 'dest']);
  });
  test('Step 2 order: the date, the specialty, the Other text (only for Other), the Medical History, the reports; nothing transport-related and no urgency', () => {
    const anchors = [...step2.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
    expect(anchors).toEqual(['date', 'specialty', 'otherSpecialty', 'history', 'files']);
    const code = step2.split(NL).filter((line) => !line.trim().startsWith('//')).join(NL); // (the comments may name what is not asked)
    for (const word of ['urgency', 'oxygen', 'Oxygen', 'mobility', 'care', 'LPM', 'equip']) expect(code).not.toContain(word);
    expect(step2).toContain('{isOther && (');
  });
  test('the specialty is the existing searchable Select, single choice; leaving Other clears its text', () => {
    expect(step2).toContain('options={MVT_SPECIALTIES}');
    expect(step2).toContain("import { Select } from '../widgets';");
    expect(step2).toContain('updateDraft(specialty === MVT_OTHER_SPECIALTY ? { specialty } : { specialty, otherSpecialty: \'\' })');
  });
  test('the reports are the existing shared tiles, untouched limits', () => {
    expect(step2).toContain("<ReportTiles title={t('req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />");
    expect(step2).not.toContain('maxFiles');
    expect(step2).not.toContain('multiple=');
  });
  test('the Medical History is the description, with a counter, and is not required', () => {
    expect(step2).toContain('value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}');
    expect(step2).toContain('<FieldHeader title={mvtText(t, \'mvt_history\')} hint=');
    expect(step2).not.toMatch(/<FieldHeader title=\{mvtText\(t, 'mvt_history'\)\}[^>]*required/);
  });
  test('required marks: scope, name, age, gender, country, contact, both cities, specialty; not the date, the history or the reports', () => {
    expect((step1.match(/<FieldLabel required>/g) || []).length).toBeGreaterThanOrEqual(4); // (name and age are `Field required`)
    expect(step1).toContain('required label={mvtText(t, \'mvt_current_city\')}');
    expect(step1).toContain('required label={mvtText(t, \'mvt_destination_city\')}');
    expect(step2).toContain('<FieldLabel required>{mvtText(t, \'mvt_specialty\')}</FieldLabel>');
    const dateField = read('components/request/MvtDateField.js');
    expect(dateField).not.toContain('required');
    expect(dateField).toContain('minimumDate={earliest}');
    expect(dateField).toContain('min={todayString()}');
    expect(dateField).toContain("onChange('')"); // a set date can be cleared
  });
});

describe('draft state', () => {
  const app = read('state/AppContext.js');
  test('the three new fields start empty and are cleared when the service is swapped', () => {
    for (const line of ["treatmentScope: '',", "specialty: '',", "otherSpecialty: '',"]) expect(app).toContain(line);
    const swapped = draftForService({ ...draft(), changingService: true }, 'hospital', { service: 'air' });
    expect(swapped).toMatchObject({ treatmentScope: '', specialty: '', otherSpecialty: '' });
    expect(swapped.name).toBe('Asha Nair'); // the patient is kept, as for every swap
    const into = draftForService({ service: 'hospital', changingService: true, name: 'A', treatmentScope: 'domestic' }, 'medvalue', { service: 'air' });
    expect(into.treatmentScope).toBe('');
  });
});

describe('isolation: nothing else was changed to get here', () => {
  test('the new lib imports nothing from another service\'s lib', () => {
    const lib = read('lib/medicalValueTravel.js');
    const imports = [...lib.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./phoneCountry', './validators', 'libphonenumber-js']);
  });
  test('the other services\' Step 1 and Step 2 components do not know about it', () => {
    for (const file of ['HomeStep1', 'HomeStep2', 'MortalStep1', 'MortalStep2', 'TeleStep1', 'TeleStep2']) {
      expect(read(`components/request/${file}.js`)).not.toMatch(/medicalValueTravel|Mvt/);
    }
  });
  test('the generic Step 1 and Step 2 (hospital, marine, ground, the airlines ...) keep their own forms', () => {
    const s1 = read('app/request/step1.js');
    const s2 = read('app/request/step2.js');
    expect(s1).toContain('function GenericStep1()');
    expect(s2).toContain('function GenericStep2()');
    expect(s1.match(/isMvtService/g)).toHaveLength(2); // the import and the one routing line
    expect(s2.match(/isMvtService/g)).toHaveLength(2);
  });
  test('the translation file was not touched by this work (no MVT key in it)', () => {
    expect(JSON.stringify(i18n)).not.toMatch(/"mvt_/);
  });
  test('the service page content (services.json) is the one that was there', () => {
    expect(SERVICES.medvalue.title).toBe('Medical Value Travel');
    expect(SERVICES.medvalue.features).toHaveLength(4);
  });
});
