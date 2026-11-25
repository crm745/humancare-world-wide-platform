// Medical Value Travel (serviceKey "medvalue"), structured format: the validator, the description format and the structured-request detection.
// Pure: no database, no network, no app. (The API behaviour is in medical-value-travel-request.test.js, which needs the test database.)
const fs = require('fs');
const path = require('path');
const {
  SPECIALTIES, OTHER_SPECIALTY, SCOPES, isMvtStructuredRequest, isNewMvtFormat, mvtFieldsOf, cityRefOf, validateMvtRequest, composeMvtDescription, parseMvtDescription,
} = require('../src/modules/requests/medical-value-travel.validation');

const NOW = new Date('2026-11-17T12:00:00Z');
const city = (geonameId, countryCode, name = 'Somewhere') => ({ geonameId, name, label: `${name}, Region, ${countryCode}`, countryCode, timezone: 'Asia/Kolkata' });
const PUNE = city(1, 'IN', 'Pune');
const MUMBAI = city(2, 'IN', 'Mumbai');
const DUBAI = city(3, 'AE', 'Dubai');
const body = (extra = {}) => ({
  serviceType: 'Medical Value Travel',
  serviceKey: 'medvalue',
  treatmentScope: 'international',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'IN',
  patientContact: '+91 98765 43210',
  currentCity: { geonameId: 1 },
  destinationCity: { geonameId: 3 },
  specialty: 'Oncology',
  ...extra,
});
// The server's lookups of the picked cities (what getVerifiedCity returns): by default the two in body(); `options.cities` overrides them one by one.
const run = (extra, options = {}) => validateMvtRequest(body(extra), { now: NOW, ...options, cities: { currentCity: PUNE, destinationCity: DUBAI, ...(options.cities || {}) } });
const without = (...keys) => { const b = body(); for (const k of keys) delete b[k]; return b; };

describe('the approved specialty list', () => {
  const APPROVED = [
    'Cardiology and Cardiac Surgery', 'Oncology', 'Orthopedics and Joint Replacement', 'Neurology and Neurosurgery', 'Transplant (Kidney, Liver, Bone Marrow)',
    'Gastroenterology', 'Urology', 'Nephrology', 'Gynecology and IVF', 'Pediatrics', 'Ophthalmology', 'ENT', 'Dermatology', 'Dental', 'Bariatric and Weight Loss',
    'Spine', 'Pulmonology', 'Endocrinology', 'Plastic and Cosmetic Surgery', 'General Surgery', 'Internal Medicine', 'Rehabilitation and Physiotherapy',
    'Ayurveda and Wellness', 'Other',
  ];
  it('is exactly the 24 approved labels, in order, with Other last', () => {
    expect(SPECIALTIES).toEqual(APPROVED);
    expect(SPECIALTIES[SPECIALTIES.length - 1]).toBe(OTHER_SPECIALTY);
  });
  it('is the same list the mobile app holds', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../apps/mobile/src/lib/medicalValueTravel.js'), 'utf8');
    const block = /export const MVT_SPECIALTIES = \[([\s\S]*?)\];/.exec(source)[1];
    const mobile = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    expect(mobile).toEqual(SPECIALTIES);
  });
});

describe('a valid request', () => {
  it('maps to the columns: scope in transfer_scope, specialty in specialty, the country NAME, E.164, no urgency, nothing structured in the description', () => {
    const { data, error } = run();
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      serviceType: 'Medical Value Travel', serviceKey: 'medvalue', transferScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
      country: 'India', patientContact: '+919876543210', origin: PUNE.label, patientLocation: PUNE.label, destination: DUBAI.label, preferredDate: null,
      originGeonameId: 1, originCityName: 'Pune', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata',
      destinationGeonameId: 3, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    });
    expect(data).not.toHaveProperty('urgency');
    expect(data).not.toHaveProperty('mobility');
    expect(data).toMatchObject({ specialty: 'Oncology', otherSpecialty: null });
    // no Medical History was typed, so the description is empty; the specialty and the scope are never in it
    expect(data.description).toBe('');
  });
  it('accepts a lower-case country code and either gender case', () => {
    const { data } = run({ country: 'in', patientGender: 'female' });
    expect(data.country).toBe('India');
    expect(data.patientGender).toBe('Female');
  });
});

describe('required fields', () => {
  it.each([
    ['treatmentScope', /treatmentScope must be one of/], ['patientName', /patientName is required/], ['patientAge', /patientAge must be/], ['patientGender', /patientGender must be/],
    ['country', /country must be/], ['patientContact', /patientContact must be/], ['currentCity', /currentCity must be a city/], ['destinationCity', /destinationCity must be a city/],
    ['specialty', /specialty must be one of/],
  ])('refuses a request without %s', (field, message) => {
    const result = validateMvtRequest(without(field), { now: NOW, cities: { currentCity: PUNE, destinationCity: DUBAI } });
    expect(result.error).toMatch(message);
  });
  it('does not require a date, a Medical History or a report', () => {
    expect(run().error).toBeUndefined();
  });
  it.each([['urgency', 'urgent_24h'], ['description', 'x'], ['mobility', 'walking'], ['equipOxygen', true], ['equipOxygenLpm', 4], ['careLevel', 'crit_icu'], ['origin', 'Pune'], ['destination', 'Dubai'], ['patientLocation', 'Pune'], ['transferScope', 'domestic']])('refuses the field %s, which this service does not collect', (field, value) => {
    expect(run({ [field]: value }).error).toBe(`${field} is not accepted for Medical Value Travel requests`);
  });
  it('refuses another service key or name', () => {
    expect(run({ serviceKey: 'hospital' }).error).toMatch(/serviceKey must be "medvalue"/);
    expect(run({ serviceType: 'Medical Value Travel Plus' }).error).toMatch(/serviceType must be/);
  });
});

describe('patient fields', () => {
  it('Treatment Scope is one of Domestic and International', () => {
    expect(Object.keys(SCOPES)).toEqual(['domestic', 'international']);
    for (const bad of ['Domestic', 'both', '', 7, null]) expect(run({ treatmentScope: bad }).error).toMatch(/treatmentScope must be one of/);
  });
  it('Name: 2 to 191 characters with a letter', () => {
    expect(run({ patientName: 'A'.repeat(191) }).error).toBeUndefined();
    expect(run({ patientName: 'A'.repeat(192) }).error).toMatch(/patientName must be 2 to 191/);
    expect(run({ patientName: '12345' }).error).toMatch(/include a letter/);
    expect(run({ patientName: 'A\nB' }).error).toMatch(/not allowed/);
  });
  it('Age: a whole number from 0 to 129', () => {
    for (const ok of [0, 1, 129, '0', '129']) expect(run({ patientAge: ok }).data.patientAge).toBe(Number(ok));
    for (const bad of [-1, 130, 1.5, '1.5', 'abc', '', null, '007', true]) expect(run({ patientAge: bad }).error).toMatch(/patientAge must be a whole number from 0 to 129/);
  });
  it('Gender: Male, Female or Other', () => {
    for (const bad of ['', 'x', 7, null]) expect(run({ patientGender: bad }).error).toMatch(/patientGender/);
    expect(run({ patientGender: 'Other' }).data.patientGender).toBe('Other');
  });
  it('Country: an ISO code, stored as the name', () => {
    expect(run({ country: 'AE', currentCity: { text: 'Dubai' }, destinationCity: { text: 'Mumbai' } }).data.country).toBe('United Arab Emirates');
    for (const bad of ['India', 'XX', 'I', '', 7, null]) expect(run({ country: bad }).error).toMatch(/country must be a two-letter ISO/);
  });
  it('Contact: country code + number, stored in E.164', () => {
    expect(run({ patientContact: '+971 50 123 4567' }).data.patientContact).toBe('+971501234567');
    expect(run({ patientContact: '+919876543210' }).data.patientContact).toBe('+919876543210');
    for (const bad of ['9876543210', '+91 123', '', 'abc', null, '+0000']) expect(run({ patientContact: bad }).error).toMatch(/patientContact must be a valid phone/);
  });
});

describe('cities and the scope rules', () => {
  it('Current City must be in the selected country (a picked city)', () => {
    expect(run({ country: 'AE' }).error).toBe('currentCity must be in the selected country');
  });
  it('Domestic: the destination must be in the selected country too', () => {
    expect(run({ treatmentScope: 'domestic' }).error).toBe('destinationCity must be in the selected country for a Domestic request');
    const ok = run({ treatmentScope: 'domestic', destinationCity: { geonameId: 2 } }, { cities: { destinationCity: MUMBAI } });
    expect(ok.error).toBeUndefined();
    expect(ok.data.transferScope).toBe('domestic');
  });
  it('International: the destination must be in a different country', () => {
    expect(run({ destinationCity: { geonameId: 2 } }, { cities: { destinationCity: MUMBAI } }).error).toBe('destinationCity must be in a different country for an International request');
    expect(run().error).toBeUndefined();
  });
  it('a picked city the server could not verify is refused', () => {
    expect(run({}, { cities: { destinationCity: null } }).error).toMatch(/destinationCity is not a valid city/);
    expect(run({}, { cities: { currentCity: city(9, 'IN') } }).error).toMatch(/currentCity is not a valid city/);
  });
  it('a typed city is kept exactly as typed, its GeoNames columns stay empty, and no country rule is claimed for it', () => {
    const typed = '  Pune   (near Hinjewadi)  ';
    const { data, error } = run({ currentCity: { text: typed }, destinationCity: { text: 'Dubaï' } }, { cities: {} });
    expect(error).toBeUndefined();
    expect(data.origin).toBe(typed);
    expect(data.patientLocation).toBe(typed);
    expect(data.destination).toBe('Dubaï');
    for (const key of ['originGeonameId', 'originCityName', 'originCountryCode', 'originTimezone', 'destinationGeonameId', 'destinationCityName', 'destinationCountryCode']) {
      expect(data).not.toHaveProperty(key);
    }
  });
  it('a typed destination is accepted for either scope (its country cannot be verified), and so is a typed current city', () => {
    for (const treatmentScope of ['domestic', 'international']) {
      expect(run({ treatmentScope, destinationCity: { text: 'Some Town' } }, { cities: { currentCity: PUNE } }).error).toBeUndefined();
    }
  });
  it('one picked and one typed city: each is handled on its own', () => {
    const { data } = run({ destinationCity: { text: 'Bangkok' } }, { cities: { currentCity: PUNE } });
    expect(data.originGeonameId).toBe(1);
    expect(data).not.toHaveProperty('destinationGeonameId');
    expect(data.destination).toBe('Bangkok');
  });
  it('a typed city: required, one line, at most 191 characters', () => {
    expect(run({ currentCity: { text: '' } }, { cities: {} }).error).toMatch(/currentCity is required/);
    expect(run({ currentCity: { text: '   ' } }, { cities: {} }).error).toMatch(/currentCity is required/);
    expect(run({ currentCity: { text: 'A\nB' } }, { cities: {} }).error).toMatch(/single line/);
    expect(run({ currentCity: { text: 'C'.repeat(191) } }, { cities: {} }).error).toBeUndefined();
    expect(run({ currentCity: { text: 'C'.repeat(192) } }, { cities: {} }).error).toMatch(/at most 191/);
    expect(run({ currentCity: { text: 5 } }, { cities: {} }).error).toMatch(/currentCity is required|must be text/);
  });
  it.each([['a string', 'Pune'], ['an empty object', {}], ['two keys', { geonameId: 1, text: 'x' }], ['a name', { name: 'Pune' }], ['a zero id', { geonameId: 0 }], ['a text id', { geonameId: '1' }], ['a float id', { geonameId: 1.5 }], ['a list', [1]]])('refuses a city given as %s', (_n, value) => {
    expect(run({ currentCity: value }, { cities: {} }).error).toMatch(/currentCity/);
  });
  it('cityRefOf tells a picked city from a typed one', () => {
    expect(cityRefOf({ geonameId: 5 })).toEqual({ id: 5 });
    expect(cityRefOf({ text: 'Pune' })).toEqual({ text: 'Pune' });
    expect(cityRefOf('Pune').problem).toBeDefined();
  });
});

describe('Preferred Treatment Date (optional, today or later, by the patient\'s own calendar)', () => {
  it.each([['missing', undefined], ['null', null], ['empty', '']])('%s is fine and stores nothing', (_n, value) => {
    const extra = {}; if (value !== undefined) extra.preferredDate = value;
    expect(run(extra).data.preferredDate).toBeNull();
  });
  it('today and a later day are accepted', () => {
    expect(run({ preferredDate: '2026-11-17', utcOffsetMinutes: 0 }).data.preferredDate).toBe('2026-11-17');
    expect(run({ preferredDate: '2026-12-31', utcOffsetMinutes: 0 }).data.preferredDate).toBe('2026-12-31');
  });
  it('yesterday and an impossible day are refused', () => {
    expect(run({ preferredDate: '2026-11-16', utcOffsetMinutes: 0 }).error).toBe('preferredDate cannot be in the past');
    expect(run({ preferredDate: '2026-02-30', utcOffsetMinutes: 0 }).error).toMatch(/valid date/);
    expect(run({ preferredDate: '17/11/2026', utcOffsetMinutes: 0 }).error).toMatch(/valid date/);
    expect(run({ preferredDate: 20261117, utcOffsetMinutes: 0 }).error).toMatch(/valid date/);
  });
  it('"today" is the patient\'s own: 2026-11-18 is today in UTC+14 when it is still the 17th in UTC, and 2026-11-17 is already past for them', () => {
    const lateUtc = new Date('2026-11-17T22:00:00Z'); // 2026-11-18 12:00 at UTC+14
    expect(run({ preferredDate: '2026-11-18', utcOffsetMinutes: 840 }, { now: lateUtc }).error).toBeUndefined();
    expect(run({ preferredDate: '2026-11-17', utcOffsetMinutes: 840 }, { now: lateUtc }).error).toBe('preferredDate cannot be in the past');
    expect(run({ preferredDate: '2026-11-17', utcOffsetMinutes: 0 }, { now: lateUtc }).error).toBeUndefined();
  });
  it('a date needs the device offset, and the offset must be sane', () => {
    expect(run({ preferredDate: '2026-12-01' }).error).toMatch(/utcOffsetMinutes is required with preferredDate/);
    for (const bad of [841, -721, 1.5, '0']) expect(run({ preferredDate: '2026-12-01', utcOffsetMinutes: bad }).error).toMatch(/utcOffsetMinutes must be/);
  });
});

describe('Specialty, Other and Medical History', () => {
  it('every approved specialty is accepted, and only those', () => {
    for (const specialty of SPECIALTIES.filter((s) => s !== OTHER_SPECIALTY)) {
      const { data } = run({ specialty });
      expect(data).toMatchObject({ specialty, otherSpecialty: null });
      expect(data.description).not.toContain(specialty);
    }
    for (const bad of ['Cardiology', 'oncology', 'ONCOLOGY', '', 7, null, ['Oncology']]) expect(run({ specialty: bad }).error).toBe('specialty must be one of the listed specialties');
  });
  it('Other needs its text (at most 191 characters, one line); another specialty refuses it', () => {
    expect(run({ specialty: 'Other' }).error).toMatch(/otherSpecialty is required/);
    expect(run({ specialty: 'Other', otherSpecialty: '   ' }).error).toMatch(/otherSpecialty is required/);
    expect(run({ specialty: 'Other', otherSpecialty: 'S'.repeat(191) }).error).toBeUndefined();
    expect(run({ specialty: 'Other', otherSpecialty: 'S'.repeat(192) }).error).toMatch(/at most 191/);
    expect(run({ specialty: 'Other', otherSpecialty: 'a\nb' }).error).toMatch(/single line/);
    expect(run({ otherSpecialty: 'Sports medicine' }).error).toBe('otherSpecialty is only accepted when the specialty is Other');
    const other = run({ specialty: 'Other', otherSpecialty: 'Sports medicine', medicalHistory: 'Knee pain.' }).data;
    expect(other).toMatchObject({ specialty: 'Other', otherSpecialty: 'Sports medicine', description: 'Knee pain.' });
    expect(other.description).not.toContain('Sports medicine');
  });
  it('Medical History is optional, kept exactly, at most 2,000 characters; whitespace-only counts as none', () => {
    const history = '  Knee pain.\r\nSecond line\twith tab  ';
    const { data } = run({ medicalHistory: history });
    // the description IS the Medical History, exactly as typed
    expect(data.description).toBe(history);
    expect(mvtFieldsOf({ serviceKey: 'medvalue', transferScope: 'international', ...data })).toEqual({ ok: true, specialty: 'Oncology', other: '', history });
    expect(run({ medicalHistory: 'h'.repeat(2000) }).error).toBeUndefined();
    expect(run({ medicalHistory: 'h'.repeat(2001) }).error).toMatch(/at most 2000/);
    expect(run({ medicalHistory: '😀'.repeat(2000) }).error).toBeUndefined(); // counted in characters, not code units
    expect(run({ medicalHistory: '   \n ' }).data.description).toBe('');
    expect(run({ medicalHistory: 'x\u0000y' }).error).toMatch(/cannot be saved/);
    expect(run({ medicalHistory: 7 }).error).toMatch(/medicalHistory must be text/);
  });
});

describe('requests saved before the specialty columns (compatibility)', () => {
  const v1 = composeMvtDescription({ specialty: 'Other', other: 'Sports medicine', history: 'Knee pain.' });
  it('a v1 description with no specialty column is still read', () => {
    expect(mvtFieldsOf({ serviceKey: 'medvalue', transferScope: 'domestic', description: v1 })).toEqual({ ok: true, specialty: 'Other', other: 'Sports medicine', history: 'Knee pain.' });
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: 'domestic', specialty: null, otherSpecialty: null, description: v1 })).toBe(true);
  });
  it('the column wins: a Medical History that looks like the v1 format is just the history', () => {
    const fake = composeMvtDescription({ specialty: 'Dental', history: 'fake' });
    expect(mvtFieldsOf({ serviceKey: 'medvalue', transferScope: 'domestic', specialty: 'Oncology', otherSpecialty: null, description: fake }))
      .toEqual({ ok: true, specialty: 'Oncology', other: '', history: fake });
  });
  it('a column row needs a real scope, a listed specialty, and Other text exactly when the specialty is Other', () => {
    const row = { serviceKey: 'medvalue', transferScope: 'domestic', specialty: 'Oncology', otherSpecialty: null, description: null };
    expect(mvtFieldsOf(row)).toEqual({ ok: true, specialty: 'Oncology', other: '', history: '' });
    expect(isNewMvtFormat({ ...row, transferScope: null })).toBe(false);
    expect(isNewMvtFormat({ ...row, specialty: 'Cardiology' })).toBe(false);
    expect(isNewMvtFormat({ ...row, specialty: 'Other' })).toBe(false);
    expect(isNewMvtFormat({ ...row, specialty: 'Other', otherSpecialty: 'Sleep medicine' })).toBe(true);
    expect(isNewMvtFormat({ ...row, otherSpecialty: 'Sleep medicine' })).toBe(false);
    expect(isNewMvtFormat({ ...row, serviceKey: 'mortal' })).toBe(false);
  });
});

describe('the description format (legacy v1)', () => {
  const cases = [
    ['a listed specialty, no history', { specialty: 'Oncology' }],
    ['a listed specialty with a history', { specialty: 'Urology', history: 'Stones.' }],
    ['Other with its text', { specialty: 'Other', other: 'Sports medicine' }],
    ['Other and a history', { specialty: 'Other', other: 'Sleep medicine', history: 'Insomnia for years.' }],
    ['a history that looks like the format itself', { specialty: 'Oncology', history: 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Dental\nMedical History:\nfake' }],
    ['a history that holds the section labels', { specialty: 'Other', other: 'Other Specialty:', history: '\nMedical History:\nSpecialty: ENT\nOther Specialty:\nx\n' }],
    ['emoji and combining marks', { specialty: 'Other', other: 'Café 😀 é', history: '😀👨‍👩‍👧\n\r\n日本語 العربية' }],
    ['a history of exactly 2,000 characters', { specialty: 'Spine', history: 'z'.repeat(2000) }],
  ];
  it.each(cases)('round-trips exactly: %s', (_n, parts) => {
    const text = composeMvtDescription({ specialty: parts.specialty, other: parts.other || '', history: parts.history || '' });
    expect(parseMvtDescription(text)).toEqual({ ok: true, specialty: parts.specialty, other: parts.other || '', history: parts.history || '' });
  });
  it('has the documented shape', () => {
    expect(composeMvtDescription({ specialty: 'Other', other: 'Sports medicine', history: 'Knee pain.' }))
      .toBe('Medical Value Travel v1 (other 15, history 10)\nSpecialty: Other\nOther Specialty:\nSports medicine\nMedical History:\nKnee pain.');
  });
  it.each([
    ['plain old free text', 'Needs a knee replacement abroad.'],
    ['an empty text', ''],
    ['null', null],
    ['a header only', 'Medical Value Travel v1 (other 0, history 0)'],
    ['an unknown version', 'Medical Value Travel v2 (other 0, history 0)\nSpecialty: Oncology'],
    ['a missing specialty line', 'Medical Value Travel v1 (other 0, history 0)\nOncology'],
    ['an empty specialty', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: '],
    ['trailing text', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology\nextra'],
    ['a history shorter than its count', 'Medical Value Travel v1 (other 0, history 9)\nSpecialty: Oncology\nMedical History:\nshort'],
    ['a history longer than its count', 'Medical Value Travel v1 (other 0, history 2)\nSpecialty: Oncology\nMedical History:\nlonger'],
    ['a history count with no history section', 'Medical Value Travel v1 (other 0, history 3)\nSpecialty: Oncology'],
    ['Other without its text', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Other'],
    ['Other text count on a listed specialty', 'Medical Value Travel v1 (other 3, history 0)\nSpecialty: Oncology\nOther Specialty:\nabc'],
    ['a leading zero in a count', 'Medical Value Travel v1 (other 00, history 0)\nSpecialty: Oncology'],
    ['a count past the limit', 'Medical Value Travel v1 (other 0, history 4001)\nSpecialty: Oncology'],
    ['a Windows line break after the header', 'Medical Value Travel v1 (other 0, history 0)\r\nSpecialty: Oncology'],
    ['a frame cutting an emoji in two', 'Medical Value Travel v1 (other 0, history 1)\nSpecialty: Oncology\nMedical History:\n😀'],
  ])('is not valid (so it falls back to the generic display): %s', (_n, text) => {
    expect(parseMvtDescription(text).ok).toBe(false);
  });
  it('the parser never throws, whatever it is given', () => {
    for (const odd of [undefined, 5, {}, [], 'Medical Value Travel v1 (other 9999999999999999999, history 0)\nx', '\n\n\n']) expect(() => parseMvtDescription(odd)).not.toThrow();
  });
});

describe('what counts as a new-format request', () => {
  const GOOD = 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology';
  it('structured detection looks at the fields only a new app sends, for the key medvalue', () => {
    expect(isMvtStructuredRequest(body())).toBe(true);
    for (const marker of ['treatmentScope', 'specialty', 'otherSpecialty', 'medicalHistory', 'currentCity', 'destinationCity']) {
      expect(isMvtStructuredRequest({ serviceKey: 'medvalue', serviceType: 'Medical Value Travel', [marker]: 'x' })).toBe(true);
    }
    // the generic body an older build sends: no marker, so the generic rules apply
    expect(isMvtStructuredRequest({ serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'A', origin: 'Pune', destination: 'Dubai', description: 'x', urgency: 'planned' })).toBe(false);
    expect(isMvtStructuredRequest({ serviceKey: 'hospital', specialty: 'Oncology' })).toBe(false);
    expect(isMvtStructuredRequest({ serviceKey: 'mortal', treatmentScope: 'domestic' })).toBe(false);
    expect(isMvtStructuredRequest(null)).toBe(false);
    expect(isMvtStructuredRequest([])).toBe(false);
  });
  it('a stored request is new format only with the key, a real scope AND a description that parses', () => {
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: 'domestic', description: GOOD })).toBe(true);
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: 'international', description: GOOD })).toBe(true);
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: null, description: GOOD })).toBe(false); // legacy row
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: 'domestic', description: 'free text' })).toBe(false);
    expect(isNewMvtFormat({ serviceKey: 'medvalue', transferScope: 'private_charter', description: GOOD })).toBe(false);
    expect(isNewMvtFormat({ serviceKey: 'mortal', transferScope: 'domestic', description: GOOD })).toBe(false); // Mortal Remains keeps its own meaning
    expect(isNewMvtFormat({ serviceKey: 'hospital', transferScope: 'domestic', description: GOOD })).toBe(false);
    expect(isNewMvtFormat(null)).toBe(false);
  });
});

describe('the body', () => {
  it('must be an object', () => {
    for (const odd of [null, [], 'x', 5]) expect(validateMvtRequest(odd).error).toBe('The request body must be a JSON object.');
  });
});
