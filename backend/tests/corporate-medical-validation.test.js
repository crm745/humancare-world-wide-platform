// Corporate Medical Solutions (serviceKey "corporate"), structured patient-side format: the validator, the description format, the stored-row reader and the
// PDF layout, all with no database.
const {
  CORPORATE_SERVICE_KEY, CORPORATE_SERVICE_TYPE, PROGRAMMES, PROGRAMME_KEYS, COMPANY_MAX, EMPLOYEES_MIN, EMPLOYEES_MAX, STORED_EMPLOYEES_MAX, TEXT_MAX, ADDRESS_MAX,
  isCorporateStructuredRequest, validateCorporateRequest, composeCorporateDescription, parseCorporateDescription, corporateFieldsOf, isNewCorporateFormat,
} = require('../src/modules/requests/corporate-medical.validation');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');

// A fixed "now" (UTC 2026-11-18 12:00) so the date rules are exact; the dates below are relative to it.
const NOW = new Date('2026-11-18T12:00:00.000Z');
const OFFICE = 'Plot 14, Andheri East,\nMumbai, Maharashtra 400069';
const body = (extra = {}) => ({
  serviceType: CORPORATE_SERVICE_TYPE, serviceKey: CORPORATE_SERVICE_KEY, companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair',
  patientGender: 'Female', programmes: ['doctor', 'nurse'], patientContact: '+91 98765 43210', preferredDate: '2026-12-01', utcOffsetMinutes: 0, officeAddress: OFFICE, officeCountry: 'IN', ...extra,
});
const run = (extra) => validateCorporateRequest(body(extra), { now: NOW });
const errorOf = (extra) => run(extra).error;

describe('the eleven fields', () => {
  it('a body with the nine required fields is valid; the two requirements are optional', () => {
    const { data, error } = run();
    expect(error).toBeUndefined();
    expect(data).toEqual({
      serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'Asha Nair', patientGender: 'Female', patientContact: '+91 98765 43210', preferredDate: '2026-12-01',
      origin: OFFICE, destination: '', country: 'India', companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, selectedProgrammes: ['doctor', 'nurse'], description: '',
    });
    expect(data).not.toHaveProperty('patientLocation'); // the office is not the patient's location
  });
  it('all seven fields together: each lands in its own place and the requirements are the description', () => {
    const { data } = run({ anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.' });
    expect(data).toMatchObject({ companyName: 'Acme Industries Pvt Ltd', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female', selectedProgrammes: ['doctor', 'nurse'] });
    expect(parseCorporateDescription(data.description)).toEqual({ ok: true, any: 'Two doctors on site.', special: 'Night shift cover.' });
  });
  it('No. of Employees and Name of Employee are separate: neither can stand in for the other', () => {
    expect(errorOf({ patientName: undefined })).toBe('patientName is required');
    expect(errorOf({ employeeCount: undefined })).toBe('employeeCount is required');
    expect(errorOf({ patientName: '250' })).toMatch(/patientName must be/); // a number is not a name (no letter)
    expect(run({ patientName: 'Ravi 5' }).data.employeeCount).toBe(250); // a name never changes the count
  });
  it.each(['companyName', 'employeeCount', 'patientName', 'patientGender', 'programmes', 'patientContact', 'preferredDate', 'officeAddress', 'officeCountry'])('%s is required', (field) => {
    expect(errorOf({ [field]: undefined })).toMatch(new RegExp(`${field}`));
    expect(errorOf({ [field]: null })).toMatch(new RegExp(`${field}`));
  });
});

describe('Company Name', () => {
  it('is trimmed, one line, at most 191 characters', () => {
    expect(run({ companyName: '  Acme  ' }).data.companyName).toBe('Acme');
    expect(errorOf({ companyName: '   ' })).toBe('companyName is required');
    expect(errorOf({ companyName: 'A\nB' })).toBe('companyName must be a single line');
    expect(errorOf({ companyName: 'x'.repeat(COMPANY_MAX + 1) })).toMatch(/at most 191/);
    expect(run({ companyName: 'x'.repeat(COMPANY_MAX) }).error).toBeUndefined();
    expect(errorOf({ companyName: 'a\u0000b' })).toMatch(/cannot be saved/);
    expect(errorOf({ companyName: 42 })).toBe('companyName is required');
  });
});

describe('No. of Employees', () => {
  it('the approved range is 1 to 10,000', () => {
    expect([EMPLOYEES_MIN, EMPLOYEES_MAX]).toEqual([1, 10000]);
  });
  it.each([1, 2, 250, 9999, 10000])('%s is accepted', (n) => expect(run({ employeeCount: n }).data.employeeCount).toBe(n));
  it('a text of digits is accepted and stored as a number', () => {
    expect(run({ employeeCount: ' 40 ' }).data.employeeCount).toBe(40);
    expect(run({ employeeCount: '10000' }).data.employeeCount).toBe(10000);
  });
  it.each([0, -1, 1.5, 10001, 10002, 100000, 1000000, NaN, Infinity, '', 'abc', '12abc', '1.5', '-3', '0', '10001', '1000000', '10000000', true, [5], {}])('%p is refused as a count', (n) => {
    expect(errorOf({ employeeCount: n })).toBe('employeeCount must be a whole number from 1 to 10000');
  });
  it('a missing count is "required"', () => {
    expect(errorOf({ employeeCount: undefined })).toBe('employeeCount is required');
    expect(errorOf({ employeeCount: null })).toBe('employeeCount is required');
  });
});

describe('Name of Employee', () => {
  it('is required, trimmed, 2 to 100 characters with a letter, one line', () => {
    expect(run({ patientName: '  Ravi Kumar ' }).data.patientName).toBe('Ravi Kumar');
    for (const bad of ['', '  ', 'A', '12345', 'x'.repeat(101), 'A\nB', 'a\u0000b', 7, null]) expect(errorOf({ patientName: bad })).toMatch(/patientName/);
    expect(run({ patientName: 'x'.repeat(100) }).error).toBeUndefined();
  });
});

describe('Gender (the approved options)', () => {
  it.each([['Male', 'Male'], ['female', 'Female'], [' Other ', 'Other']])('%s is accepted as %s', (sent, stored) => expect(run({ patientGender: sent }).data.patientGender).toBe(stored));
  it('anything else is refused', () => {
    for (const bad of ['', 'M', 'Prefer not to say', 'unknown', 5, ['Male']]) expect(errorOf({ patientGender: bad })).toBe('patientGender must be Male, Female or Other');
  });
});

describe('Programmes', () => {
  it('there are exactly the seven approved options, in order', () => {
    expect(PROGRAMME_KEYS).toEqual(['doctor', 'nurse', 'medical_room_management', 'first_aid_training', 'acls_bls_training', 'events', 'pre_employment_health_checkup']);
    expect(Object.values(PROGRAMMES)).toEqual([
      'Doctor', 'Nurse', 'Medical room management', 'First aid training', 'ACLS & BLS training', 'Events', 'Pre-employment health checkup',
    ]);
  });
  it('every single programme is accepted', () => {
    for (const key of PROGRAMME_KEYS) expect(run({ programmes: [key] }).data.selectedProgrammes).toEqual([key]);
  });
  it('several programmes are stored as an array of keys, in the canonical order whatever order was sent', () => {
    expect(run({ programmes: ['events', 'doctor', 'acls_bls_training'] }).data.selectedProgrammes).toEqual(['doctor', 'acls_bls_training', 'events']);
    expect(run({ programmes: PROGRAMME_KEYS.slice().reverse() }).data.selectedProgrammes).toEqual(PROGRAMME_KEYS);
  });
  it('none, a repeat, an unknown key, a label instead of a key and a non-array are refused', () => {
    expect(errorOf({ programmes: [] })).toBe('programmes must list at least one programme');
    expect(errorOf({ programmes: 'doctor' })).toBe('programmes must list at least one programme');
    expect(errorOf({ programmes: ['doctor', 'doctor'] })).toBe('programmes must not repeat a programme');
    for (const bad of [['dentist'], ['Doctor'], ['Medical room management'], [1], [null], ['doctor', 7]]) expect(errorOf({ programmes: bad })).toMatch(/programmes must only hold/);
  });
});

describe('Any Requirement and Special Requirement', () => {
  it('are optional: absent, null, empty and blank leave the description empty', () => {
    for (const extra of [{}, { anyRequirement: null, specialRequirement: null }, { anyRequirement: '', specialRequirement: '' }, { anyRequirement: '  \n ', specialRequirement: '\t' }]) {
      expect(run(extra).data.description).toBe('');
    }
  });
  it('each is kept exactly as typed, up to 2,000 characters (counted in characters, not UTF-16 units)', () => {
    const typed = '  First line\r\nSecond\twith tab  ';
    expect(parseCorporateDescription(run({ anyRequirement: typed }).data.description)).toEqual({ ok: true, any: typed, special: '' });
    expect(parseCorporateDescription(run({ specialRequirement: typed }).data.description)).toEqual({ ok: true, any: '', special: typed });
    expect(run({ anyRequirement: 'a'.repeat(TEXT_MAX), specialRequirement: 'b'.repeat(TEXT_MAX) }).error).toBeUndefined();
    expect(errorOf({ anyRequirement: 'a'.repeat(TEXT_MAX + 1) })).toMatch(/anyRequirement can be at most 2000/);
    expect(errorOf({ specialRequirement: 'b'.repeat(TEXT_MAX + 1) })).toMatch(/specialRequirement can be at most 2000/);
    expect(run({ anyRequirement: '\u{1F600}'.repeat(TEXT_MAX) }).error).toBeUndefined();
    expect(errorOf({ anyRequirement: 'x\u0000y' })).toMatch(/cannot be saved/);
    expect(errorOf({ specialRequirement: 7 })).toMatch(/must be text/);
  });
});

describe('what the body may carry', () => {
  it('a client description, origin, destination, age, contact, urgency or any other key is refused', () => {
    for (const [key, value] of [['description', 'x'], ['origin', 'Pune'], ['destination', 'Pune'], ['patientAge', 40], ['country', 'India'], ['patientLocation', 'Pune'], ['originCityName', 'Pune'], ['urgency', 'planned'],
      ['careLevel', 'crit_icu'], ['mobility', 'walking'], ['companyNam', 'x'], ['specialty', 'Oncology'], ['transferScope', 'domestic']]) {
      expect(errorOf({ [key]: value })).toBe(`${key} is not accepted for Corporate Medical Solutions requests`);
    }
  });
  it('the service key and type must be the approved ones', () => {
    expect(errorOf({ serviceKey: 'homecare' })).toMatch(/serviceKey must be "corporate"/);
    expect(errorOf({ serviceType: 'Corporate' })).toMatch(/serviceType must be "Corporate Medical Solutions"/);
    for (const odd of [null, [], 'x', 5]) expect(validateCorporateRequest(odd).error).toBe('The request body must be a JSON object.');
  });
  it('structured detection: only the key corporate AND one of the new fields; an older generic body is not structured', () => {
    expect(isCorporateStructuredRequest(body())).toBe(true);
    for (const field of ['companyName', 'employeeCount', 'programmes', 'anyRequirement', 'specialRequirement']) expect(isCorporateStructuredRequest({ serviceKey: 'corporate', [field]: 'x' })).toBe(true);
    expect(isCorporateStructuredRequest({ serviceKey: 'corporate', serviceType: 'Corporate Medical Solutions', patientName: 'A', origin: 'Pune', destination: 'Pune', description: 'x' })).toBe(false);
    for (const serviceKey of ['homecare', 'hospital', undefined]) expect(isCorporateStructuredRequest(body({ serviceKey }))).toBe(false);
    for (const odd of [null, undefined, 'x', 5, []]) expect(isCorporateStructuredRequest(odd)).toBe(false);
  });
});

describe('the description format', () => {
  it.each([
    ['any only', { any: 'Two doctors.' }], ['special only', { special: 'Night shift.' }], ['both', { any: 'A', special: 'B' }],
    ['text that looks like the format', { any: 'Corporate Medical Solutions v1 (any 1, special 1)\nAny Requirement:\nx', special: '\nSpecial Requirement:\nfake' }],
    ['emoji and combining marks', { any: 'Café \u{1F600} \u{1F468}‍\u{1F469}‍\u{1F467}', special: '日本語 العربية\r\n' }],
    ['exactly 2,000 characters each', { any: 'z'.repeat(2000), special: 'y'.repeat(2000) }],
  ])('%s round-trips exactly', (_name, parts) => {
    const text = composeCorporateDescription(parts);
    expect(parseCorporateDescription(text)).toEqual({ ok: true, any: parts.any || '', special: parts.special || '' });
  });
  it('is empty when nothing was typed, and an empty or missing description reads as no requirements', () => {
    expect(composeCorporateDescription({})).toBe('');
    for (const empty of [null, undefined, '']) expect(parseCorporateDescription(empty)).toEqual({ ok: true, any: '', special: '' });
  });
  it('the exact text of the example', () => {
    expect(composeCorporateDescription({ any: 'Two doctors.', special: 'Night shift.' }))
      .toBe('Corporate Medical Solutions v1 (any 12, special 12)\nAny Requirement:\nTwo doctors.\nSpecial Requirement:\nNight shift.');
  });
  it.each([
    ['a different version', 'Corporate Medical Solutions v2 (any 1, special 0)\nAny Requirement:\nx'],
    ['both lengths zero', 'Corporate Medical Solutions v1 (any 0, special 0)'],
    ['a length that is too short (text left over)', 'Corporate Medical Solutions v1 (any 1, special 0)\nAny Requirement:\nxy'],
    ['a length that is too long', 'Corporate Medical Solutions v1 (any 9, special 0)\nAny Requirement:\nxy'],
    ['a missing label', 'Corporate Medical Solutions v1 (any 1, special 0)\nx'],
    ['a wrong label', 'Corporate Medical Solutions v1 (any 1, special 0)\nSpecial Requirement:\nx'],
    ['a leading zero', 'Corporate Medical Solutions v1 (any 01, special 0)\nAny Requirement:\nx'],
    ['a length above the limit', 'Corporate Medical Solutions v1 (any 4001, special 0)\nAny Requirement:\nx'],
    ['free text', 'Annual checkups.'],
    ['a header with no body', 'Corporate Medical Solutions v1 (any 1, special 0)'],
  ])('%s is invalid', (_name, text) => expect(parseCorporateDescription(text).ok).toBe(false));
  it('never throws on odd input', () => {
    for (const odd of [5, {}, [], 'Corporate Medical Solutions v1 (any 9999999999999999999, special 0)\nx', '\n\n\n']) expect(() => parseCorporateDescription(odd)).not.toThrow();
    expect(parseCorporateDescription(5).ok).toBe(false);
  });
});

describe('reading a stored request (compatibility)', () => {
  const NEW = { serviceKey: 'corporate', companyName: 'Acme', employeeCount: 12, selectedProgrammes: ['doctor', 'events'], description: null };
  it('a request with the columns is new format; its requirements come from the description', () => {
    // (a request saved before the four office / contact fields existed: they read as empty, nothing is invented)
    expect(corporateFieldsOf(NEW)).toEqual({
      ok: true, companyName: 'Acme', employeeCount: 12, programmes: ['doctor', 'events'], anyRequirement: '', specialRequirement: '', patientContact: '', preferredDate: null, officeAddress: '', officeCountry: '',
    });
    const withText = { ...NEW, description: composeCorporateDescription({ any: 'A', special: 'B' }) };
    expect(corporateFieldsOf(withText)).toMatchObject({ ok: true, anyRequirement: 'A', specialRequirement: 'B' });
    expect(isNewCorporateFormat(withText)).toBe(true);
  });
  it('a row saved under the first version\'s larger maximum is still read (nothing stored is hidden); a new request above 10,000 is refused', () => {
    expect(isNewCorporateFormat({ ...NEW, employeeCount: 20000 })).toBe(true);
    expect(isNewCorporateFormat({ ...NEW, employeeCount: STORED_EMPLOYEES_MAX })).toBe(true);
    expect(isNewCorporateFormat({ ...NEW, employeeCount: STORED_EMPLOYEES_MAX + 1 })).toBe(false);
    expect(validateCorporateRequest(body({ employeeCount: 20000 })).error).toBe('employeeCount must be a whole number from 1 to 10000');
  });
  it('every older Corporate Medical request (free-text description, none of the columns) is legacy', () => {
    for (const old of [
      { serviceKey: 'corporate', description: 'Annual checkups for 200 staff.', origin: 'Pune', destination: 'Pune' },
      { serviceKey: 'corporate', companyName: null, employeeCount: null, selectedProgrammes: null, description: null },
      { serviceKey: 'corporate' },
    ]) expect(isNewCorporateFormat(old)).toBe(false);
  });
  it('a row with a column missing or invalid, or free text in the description, is not new format', () => {
    for (const bad of [
      { companyName: '' }, { companyName: '  ' }, { companyName: null }, { employeeCount: 0 }, { employeeCount: -2 }, { employeeCount: 1.5 }, { employeeCount: '12' }, { employeeCount: null },
      { selectedProgrammes: null }, { selectedProgrammes: [] }, { selectedProgrammes: '["doctor"]' }, { selectedProgrammes: ['dentist'] }, { selectedProgrammes: ['doctor', 'doctor'] },
      { selectedProgrammes: { 0: 'doctor' } }, { description: 'Annual checkups.' }, { serviceKey: 'homecare' }, { serviceKey: 'mortal' },
    ]) expect(isNewCorporateFormat({ ...NEW, ...bad })).toBe(false);
    expect(isNewCorporateFormat(null)).toBe(false);
  });
});

describe('the PDF summary', () => {
  const base = { id: 1, referenceNumber: 'REQ-1005', status: 'submitted', patientName: 'Asha Nair', patientGender: 'Female', createdAt: new Date('2026-11-18T10:00:00Z'), urgency: null };
  it('a new-format request prints the eleven fields and no route (the office address is not a "From")', async () => {
    const lines = await renderPdfLines({
      ...base, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', origin: 'Plot 14, Andheri East, Mumbai', destination: '', country: 'India', patientContact: '+91 98765 43210',
      preferredDate: new Date('2026-12-01T00:00:00.000Z'), companyName: 'Acme Industries', employeeCount: 250,
      selectedProgrammes: ['doctor', 'acls_bls_training'], description: composeCorporateDescription({ any: 'Two doctors.', special: 'Night shift.' }),
    });
    expect(valueAfter(lines, 'Patient Contact:')).toBe('+91 98765 43210');
    expect(valueAfter(lines, 'Preferred Date:')).toBe('Tue Dec 01 2026');
    expect(valueAfter(lines, 'Office Address:')).toBe('Plot 14, Andheri East, Mumbai');
    expect(valueAfter(lines, 'Office Country:')).toBe('India');
    expect(valueAfter(lines, 'Country:')).toBeUndefined(); // never labelled as the patient's country
    expect(valueAfter(lines, 'Company Name:')).toBe('Acme Industries');
    expect(valueAfter(lines, 'No. of Employees:')).toBe('250');
    expect(valueAfter(lines, 'Name of Employee:')).toBe('Asha Nair');
    expect(valueAfter(lines, 'Gender:')).toBe('Female');
    expect(valueAfter(lines, 'Programmes:')).toBe('Doctor, ACLS & BLS training');
    expect(valueAfter(lines, 'Any Requirement:')).toBe('Two doctors.');
    expect(valueAfter(lines, 'Special Requirement:')).toBe('Night shift.');
    expect(valueAfter(lines, 'From:')).toBeUndefined();
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBeUndefined();
  });
  it('a request saved before the four fields existed prints the seven, without them', async () => {
    const lines = await renderPdfLines({ ...base, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', origin: '', destination: '', companyName: 'Acme', employeeCount: 12, selectedProgrammes: ['doctor'], description: null });
    expect(valueAfter(lines, 'Company Name:')).toBe('Acme');
    for (const label of ['Patient Contact:', 'Preferred Date:', 'Office Address:', 'Office Country:']) expect({ label, value: valueAfter(lines, label) }).toEqual({ label, value: undefined });
  });
  it('an older Corporate Medical request is printed the generic way', async () => {
    const lines = await renderPdfLines({ ...base, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', origin: 'Pune', destination: 'Pune', description: 'Annual checkups.' });
    expect(valueAfter(lines, 'Company Name:')).toBeUndefined();
    expect(valueAfter(lines, 'From:')).toBe('Pune');
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Annual checkups.');
  });
});

describe('Patient Contact (the same rule and stored form as Home Healthcare)', () => {
  it('a valid international number is stored in international form', () => {
    expect(run({ patientContact: '+919876543210' }).data.patientContact).toBe('+91 98765 43210');
    expect(run({ patientContact: ' +91 98765 43210 ' }).data.patientContact).toBe('+91 98765 43210');
    expect(run({ patientContact: '+971 50 123 4567' }).data.patientContact).toBe('+971 50 123 4567');
    expect(run({ patientContact: '+44 7911 123456' }).data.patientContact).toBe('+44 7911 123456');
  });
  it.each(['', '   ', '9876543210', '98765 43210', '+91', '+91 12345', '+999 123456', 'abc', '+91 98765 4321O', '++919876543210', 42, [], {}, true])('%p is refused', (value) => {
    expect(errorOf({ patientContact: value })).toBe('patientContact must be a valid phone number with its country code');
  });
  it('a missing contact is refused too', () => {
    expect(errorOf({ patientContact: undefined })).toBe('patientContact must be a valid phone number with its country code');
    expect(errorOf({ patientContact: null })).toBe('patientContact must be a valid phone number with its country code');
  });
  it('the phone\'s country code never decides the Office Country: any pairing is accepted and each is stored as given', () => {
    const uae = run({ patientContact: '+971 50 123 4567', officeCountry: 'IN' }).data;
    expect([uae.patientContact, uae.country]).toEqual(['+971 50 123 4567', 'India']);
    const india = run({ patientContact: '+91 98765 43210', officeCountry: 'AE' }).data;
    expect([india.patientContact, india.country]).toEqual(['+91 98765 43210', 'United Arab Emirates']);
  });
});

describe('Preferred Date (today or later, by the patient\'s own calendar)', () => {
  it('today and later days are accepted, and stored as the same "YYYY-MM-DD"', () => {
    for (const day of ['2026-11-18', '2026-11-19', '2026-12-01', '2027-01-01', '2030-02-28']) expect({ day, stored: run({ preferredDate: day }).data.preferredDate }).toEqual({ day, stored: day });
  });
  it('yesterday and every past day are refused', () => {
    for (const day of ['2026-11-17', '2026-01-01', '2020-02-29', '1999-12-31']) expect({ day, error: errorOf({ preferredDate: day }) }).toEqual({ day, error: 'preferredDate cannot be in the past' });
  });
  it('today is judged by the patient\'s own clock (utcOffsetMinutes, minutes east of UTC), as Home Healthcare does', () => {
    // 2026-11-18 12:00 UTC: it is 17:30 on the 18th in India, 07:00 on the 18th in New York, but already 02:00 on the 19th in Auckland-ish (+840)
    expect(run({ preferredDate: '2026-11-18', utcOffsetMinutes: 330 }).error).toBeUndefined();
    expect(run({ preferredDate: '2026-11-18', utcOffsetMinutes: -300 }).error).toBeUndefined();
    expect(errorOf({ preferredDate: '2026-11-18', utcOffsetMinutes: 840 })).toBe('preferredDate cannot be in the past'); // there it is already the 19th
    expect(run({ preferredDate: '2026-11-19', utcOffsetMinutes: 840 }).error).toBeUndefined();
    const lateEvening = new Date('2026-11-18T22:00:00.000Z'); // 03:30 on the 19th in India
    expect(validateCorporateRequest(body({ preferredDate: '2026-11-18', utcOffsetMinutes: 330 }), { now: lateEvening }).error).toBe('preferredDate cannot be in the past');
    expect(validateCorporateRequest(body({ preferredDate: '2026-11-19', utcOffsetMinutes: 330 }), { now: lateEvening }).error).toBeUndefined();
  });
  it('a missing, malformed or impossible date is refused', () => {
    expect(errorOf({ preferredDate: undefined })).toBe('preferredDate is required');
    expect(errorOf({ preferredDate: null })).toBe('preferredDate is required');
    for (const bad of ['', '2026-13-01', '2026-02-30', '2026-12-1', '01-12-2026', '2026/12/01', '2026-12-01T00:00:00Z', 'tomorrow', 20261201, [], {}, true]) {
      expect({ bad, error: errorOf({ preferredDate: bad }) }).toEqual({ bad, error: 'preferredDate must be a valid date (YYYY-MM-DD)' });
    }
  });
  it('the UTC offset is required, a whole number, and one that exists', () => {
    for (const bad of [undefined, null, '0', 1.5, -721, 841, NaN, []]) expect({ bad, error: errorOf({ utcOffsetMinutes: bad }) }).toEqual({ bad, error: expect.stringMatching(/^utcOffsetMinutes is required/) });
    for (const ok of [-720, 0, 330, 840]) expect(run({ utcOffsetMinutes: ok, preferredDate: '2027-01-01' }).error).toBeUndefined();
  });
});

describe('Office Address (up to 2,000 characters, in origin, never cut)', () => {
  it('is stored as typed, line breaks kept, only the ends trimmed', () => {
    expect(run({ officeAddress: '  Plot 14\r\nAndheri East\n  ' }).data.origin).toBe('Plot 14\r\nAndheri East');
    expect(run({ officeAddress: OFFICE }).data.origin).toBe(OFFICE);
  });
  it('2,000 characters are accepted and kept whole; 2,001 are refused, never shortened', () => {
    const exact = 'A'.repeat(ADDRESS_MAX);
    expect(ADDRESS_MAX).toBe(2000);
    expect(run({ officeAddress: exact }).data.origin).toBe(exact);
    expect(run({ officeAddress: exact }).data.origin).toHaveLength(2000);
    expect(errorOf({ officeAddress: 'A'.repeat(ADDRESS_MAX + 1) })).toBe('officeAddress can be at most 2000 characters');
    expect(errorOf({ officeAddress: 'A'.repeat(5000) })).toBe('officeAddress can be at most 2000 characters');
  });
  it('is counted in characters, not UTF-16 units (an emoji is one)', () => {
    expect(run({ officeAddress: '\u{1F3E2}'.repeat(2000) }).error).toBeUndefined();
    expect(errorOf({ officeAddress: '\u{1F3E2}'.repeat(2001) })).toBe('officeAddress can be at most 2000 characters');
  });
  it('is required (blank counts as missing), and refuses characters that cannot be saved', () => {
    for (const bad of [undefined, null, '', '   ', '\n\n']) expect({ bad, error: errorOf({ officeAddress: bad }) }).toEqual({ bad, error: 'officeAddress is required' });
    expect(errorOf({ officeAddress: 'a\u0000b' })).toBe('officeAddress contains characters that cannot be saved');
    expect(errorOf({ officeAddress: 42 })).toBe('officeAddress is required');
  });
  it('is not the patient\'s location: patient_location and the destination are never set from it', () => {
    const { data } = run();
    expect(data).not.toHaveProperty('patientLocation');
    expect(data.destination).toBe('');
  });
});

describe('Office Country (an ISO code, stored as the country name)', () => {
  it.each([['IN', 'India'], ['in', 'India'], [' ae ', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['US', 'United States'], ['SG', 'Singapore']])('%p is stored as %p', (code, name) => {
    expect(run({ officeCountry: code }).data.country).toBe(name);
  });
  it('the ISO code must be real: a name, a wrong-length code or an unknown code is refused', () => {
    for (const bad of ['India', 'IND', 'I', 'ZZ', 'XX', 'QQ', '91', '', '  ', 'IN,AE', 42, ['IN'], {}]) {
      expect({ bad, error: errorOf({ officeCountry: bad }) }).toEqual({ bad, error: expect.stringMatching(/^officeCountry (must be a two-letter ISO 3166-1 country code|is required)/) });
    }
    expect(errorOf({ officeCountry: undefined })).toBe('officeCountry is required');
    expect(errorOf({ officeCountry: null })).toBe('officeCountry is required');
  });
  it('a client-sent country (the patient\'s country field) is refused: only officeCountry exists', () => {
    expect(errorOf({ country: 'India' })).toBe('country is not accepted for Corporate Medical Solutions requests');
  });
});

describe('the seven existing fields are intact', () => {
  it('every earlier rule still holds with the new fields present', () => {
    expect(errorOf({ companyName: '' })).toBe('companyName is required');
    expect(errorOf({ employeeCount: 0 })).toBe('employeeCount must be a whole number from 1 to 10000');
    expect(run({ employeeCount: 10000 }).data.employeeCount).toBe(10000);
    expect(errorOf({ employeeCount: 10001 })).toBe('employeeCount must be a whole number from 1 to 10000');
    expect(errorOf({ patientName: ' ' })).toMatch(/patientName must be/);
    expect(errorOf({ patientGender: 'x' })).toBe('patientGender must be Male, Female or Other');
    expect(errorOf({ programmes: [] })).toBe('programmes must list at least one programme');
    expect(run({ anyRequirement: 'a', specialRequirement: 'b' }).data.description).not.toBe('');
  });
  it('a request saved before the four fields existed is still read as new format (nothing is invented for it)', () => {
    const before = { serviceKey: 'corporate', companyName: 'Acme', employeeCount: 12, selectedProgrammes: ['doctor'], description: null, origin: '', country: null, patientContact: null, preferredDate: null };
    expect(isNewCorporateFormat(before)).toBe(true);
    expect(corporateFieldsOf(before)).toMatchObject({ ok: true, patientContact: '', preferredDate: null, officeAddress: '', officeCountry: '' });
  });
  it('a request with the four fields reads them back, labelled as the office\'s', () => {
    const now = { serviceKey: 'corporate', companyName: 'Acme', employeeCount: 12, selectedProgrammes: ['doctor'], description: null, origin: OFFICE, country: 'India', patientContact: '+91 98765 43210', preferredDate: new Date('2026-12-01T00:00:00.000Z') };
    expect(corporateFieldsOf(now)).toMatchObject({ ok: true, officeAddress: OFFICE, officeCountry: 'India', patientContact: '+91 98765 43210' });
    expect(corporateFieldsOf(now).preferredDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
