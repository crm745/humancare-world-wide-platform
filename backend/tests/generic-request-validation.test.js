// The generic create path's validator (generic-request.validation.js): what it keeps, refuses and ignores. Pure: no database, no network, no app.
const fs = require('fs');
const path = require('path');
const {
  KEPT_FIELDS, REFUSED_FIELDS, RETIRED_LEGACY_FIELDS, TEXT_MAX, AGE_MAX, DESCRIPTION_MAX_BYTES, validateGenericRequest, unknownFieldsLogLine,
} = require('../src/modules/requests/generic-request.validation');

const body = (extra = {}) => ({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', ...extra });
const run = (extra) => validateGenericRequest(body(extra));
const without = (...keys) => { const b = body(); for (const k of keys) delete b[k]; return b; };
const cp = (...codes) => String.fromCodePoint(...codes);

describe('a body the generic path has always taken', () => {
  test('the smallest body passes, and only the kept keys come back (untouched)', () => {
    const { data, error, unknownFields } = run();
    expect(error).toBeUndefined();
    expect(unknownFields).toEqual([]);
    expect(data).toEqual({ serviceType: 'Hospitalization Assistance', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai', serviceKey: 'hospital', patientAge: null });
  });

  // What the mobile app's generic body sends (apps/mobile/src/app/request/review.js): the golden compatibility set. The values are what the form sends today.
  const MOBILE_BODIES = {
    'Ground Ambulance': { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientAge: '61', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: '2026-12-01', careLevel: 'crit_icu,crit_ecmo', description: 'Needs transport.', equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h' },
    'Commercial Air stretcher': { serviceType: 'Medical Escort (Commercial Airlines) — Stretcher (CAS)', serviceKey: 'commercialair_stretcher', patientName: 'John Doe', patientAge: '61', patientGender: 'Female', patientLocation: 'Mumbai', patientContact: '+971 50 111 2222', origin: 'Mumbai', destination: 'Dubai', country: 'United Arab Emirates', preferredDate: '2026-12-01', careLevel: 'crit_ventilated', equipOxygen: false, equipCardiacMonitor: true, urgency: 'planned' },
    'Hospitalization': { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', patientAge: '40', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Pune', country: 'India', preferredDate: '2026-12-01', description: 'Planned admission.', urgency: 'planned' },
    'Corporate Medical': { serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'John Doe', patientAge: '35', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Pune', description: 'Annual checkups.', urgency: 'planned' },
    'older Marine': { serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', patientAge: '33', patientGender: 'Male', patientLocation: 'Mumbai', patientContact: '+91 98765 43210', origin: 'Mumbai', destination: 'Dubai', country: 'India', description: 'Crew injury.', urgency: 'urgent_24h' },
    'older Medical Value Travel': { serviceType: 'Medical Value Travel', serviceKey: 'medvalue', patientName: 'John Doe', patientAge: '50', patientGender: 'Female', patientLocation: 'Delhi', patientContact: '+91 98765 43210', origin: 'Delhi', destination: 'Singapore', country: 'India', description: 'Heart valve surgery.', urgency: 'planned' },
    'the older "air" key': { serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'John Doe', patientAge: '70', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Mumbai', careLevel: 'ICU / Critical, Ambulatory', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false, urgency: 'critical_6h' },
    'no serviceKey (a very old build)': { serviceType: 'Ground Ambulance', patientName: 'John Doe', origin: 'Pune', destination: 'Mumbai' },
    'an older Teleconsultation body': { serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', patientName: 'John Doe', patientAge: '29', patientGender: 'Female', patientLocation: 'Pune', patientContact: '+91 98765 43210', origin: 'Pune', destination: 'Pune', description: 'Fever.', urgency: 'planned' },
  };
  test.each(Object.entries(MOBILE_BODIES))('%s: accepted, and every key it sends is kept (none ignored, none changed)', (_name, input) => {
    const { data, error, unknownFields } = validateGenericRequest(input);
    expect(error).toBeUndefined();
    expect(unknownFields).toEqual([]);
    for (const [key, value] of Object.entries(input)) {
      if (key === 'patientAge') expect(data.patientAge).toBe(Number(value)); // the existing string-to-number conversion
      else expect({ key, value: data[key] }).toEqual({ key, value });
    }
  });

  test('every key the mobile app\'s generic body builds is a kept key (read from the app\'s source, so a new key there cannot be dropped unnoticed)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../apps/mobile/src/app/request/review.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf("await apiPost('/requests', {\n        serviceType: serviceTitle,");
    const end = source.indexOf('urgency: d.urgency || undefined,', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = source.slice(start, end + 40);
    const keys = new Set([...region.matchAll(/^\s+(?:\.\.\.\(.*?\{ )?(\w+):/gm)].map((m) => m[1]));
    const sent = [...keys];
    expect(sent.length).toBeGreaterThan(12);
    for (const key of sent) expect({ key, kept: KEPT_FIELDS.includes(key) }).toEqual({ key, kept: true });
    for (const key of ['patientName', 'patientAge', 'patientGender', 'patientLocation', 'patientContact', 'origin', 'destination', 'country', 'preferredDate', 'careLevel', 'description', 'urgency']) expect(region).toContain(`${key}:`);
  });

  test('values are stored exactly as sent: no trimming, no case change, no normalisation', () => {
    const { data } = run({ patientName: '  John   Doe ', patientContact: ' +91 98765 43210 ', description: '  line one\r\nline two  ', patientGender: 'female', country: 'india' });
    expect(data).toMatchObject({ patientName: '  John   Doe ', patientContact: ' +91 98765 43210 ', description: '  line one\r\nline two  ', patientGender: 'female', country: 'india' });
  });
});

describe('required text fields: type and size', () => {
  test.each(['serviceType', 'patientName', 'origin', 'destination'])('%s: text of at most 191 characters', (field) => {
    expect(run({ [field]: 'A'.repeat(TEXT_MAX) }).error).toBeUndefined();
    expect(run({ [field]: 'A'.repeat(TEXT_MAX + 1) }).error).toBe(`${field} can be at most ${TEXT_MAX} characters`);
    expect(run({ [field]: cp(0x1f600).repeat(TEXT_MAX) }).error).toBeUndefined(); // counted in characters, as MySQL counts them
    expect(run({ [field]: cp(0x1f600).repeat(TEXT_MAX + 1) }).error).toMatch(/at most 191 characters/);
    for (const bad of [7, true, {}, [], ['x']]) expect(run({ [field]: bad }).error).toBe(`${field} must be text`);
  });
});

describe('optional text fields: type and size, an empty or absent one is fine', () => {
  test.each(['patientGender', 'patientLocation', 'patientContact', 'country'])('%s', (field) => {
    for (const ok of [undefined, null, '', 'x', 'A'.repeat(TEXT_MAX)]) {
      const extra = {}; if (ok !== undefined) extra[field] = ok;
      expect({ field, ok, error: run(extra).error }).toEqual({ field, ok, error: undefined });
    }
    expect(run({ [field]: 'A'.repeat(TEXT_MAX + 1) }).error).toBe(`${field} can be at most ${TEXT_MAX} characters`);
    for (const bad of [7, true, {}, [], ['x']]) expect(run({ [field]: bad }).error).toBe(`${field} must be text`);
  });
  test('serviceKey: text (the controller has already checked it is a known key)', () => {
    expect(run({ serviceKey: undefined }).data).not.toHaveProperty('serviceKey');
    for (const bad of [7, true, {}, []]) expect(run({ serviceKey: bad }).error).toBe('serviceKey must be text');
  });
});

describe('patient age: a whole number from 0 to 129; empty, null or absent is NULL', () => {
  test.each([[0, 0], [1, 1], [61, 61], [129, 129], ['0', 0], ['129', 129], ['61', 61], [' 61 ', 61], ['007', 7], [-0, 0], [12.0, 12]])('accepts %p and stores %p', (value, stored) => {
    expect(run({ patientAge: value }).data.patientAge).toBe(stored);
  });
  test.each([['absent', undefined], ['null', null], ['an empty text', ''], ['a blank text', '   ']])('%s is NULL (an empty text no longer becomes 0)', (_n, value) => {
    const extra = {}; if (value !== undefined) extra.patientAge = value;
    expect(run(extra).data.patientAge).toBeNull();
  });
  test.each([[-1], [130], [1000], [1.5], ['1.5'], ['-1'], ['abc'], ['12abc'], ['1e2'], ['0x10'], ['1,5'], ['1000'], [NaN], [Infinity], [true], [false], [{}], [[]], [[5]], ['  1 2 ']])('refuses %p with a 400', (value) => {
    expect(run({ patientAge: value }).error).toBe('patientAge must be a whole number from 0 to 129');
  });
  test('the maximum is the documented 129', () => {
    expect(AGE_MAX).toBe(129);
  });
});

describe('preferred date', () => {
  test.each([['absent', undefined], ['null', null], ['an empty text', '']])('%s is fine and sends nothing on', (_n, value) => {
    const extra = {}; if (value !== undefined) extra.preferredDate = value;
    const { data, error } = run(extra);
    expect(error).toBeUndefined();
    expect(data).not.toHaveProperty('preferredDate');
  });
  test.each([['2026-12-01'], ['2026-02-28'], ['2028-02-29'], ['2000-01-01'], ['2026-12-01T00:00:00.000Z'], ['2026-12-01T10:30:00+05:30']])('accepts %s, passed on as sent', (value) => {
    expect(run({ preferredDate: value }).data.preferredDate).toBe(value);
  });
  test.each([['2026-02-30'], ['2027-02-29'], ['2026-13-01'], ['2026-00-10'], ['2026-1-5'], ['17/11/2026'], ['abc'], ['2026-12-01 10:00'], ['2026-12-01Tzz'], [20261201], [1700000000000], [true], [{}], [[]]])('refuses %p', (value) => {
    expect(run({ preferredDate: value }).error).toBe('preferredDate must be a valid date (YYYY-MM-DD)');
  });
  test('a past date is still accepted on this path, as before (the structured services check it, this one never did)', () => {
    expect(run({ preferredDate: '2000-01-01' }).error).toBeUndefined();
  });
});

describe('description: at most 65,535 UTF-8 bytes', () => {
  test('the capacity of the TEXT column, no more and no less', () => {
    expect(DESCRIPTION_MAX_BYTES).toBe(65535);
    expect(run({ description: 'a'.repeat(65535) }).error).toBeUndefined();
    expect(run({ description: 'a'.repeat(65536) }).error).toBe('description can be at most 65535 bytes');
  });
  test('counted in BYTES, not characters: a text with few characters but many bytes is refused, one with many characters and few bytes is not', () => {
    const wide = cp(0x20ac).repeat(21845); // 3 bytes each = 65,535
    expect(Buffer.byteLength(wide)).toBe(65535);
    expect(run({ description: wide }).error).toBeUndefined();
    expect(run({ description: `${wide}a` }).error).toMatch(/at most 65535 bytes/);
    const emoji = cp(0x1f600).repeat(16383); // 4 bytes each = 65,532
    expect(run({ description: emoji }).error).toBeUndefined();
    expect(run({ description: `${emoji}${cp(0x1f600)}` }).error).toMatch(/at most 65535 bytes/);
  });
  test('no 2,000-character limit applies', () => {
    expect(run({ description: 'h'.repeat(5000) }).error).toBeUndefined();
  });
  test('absent, null and empty are fine; anything that is not text is refused; the text goes on exactly as sent', () => {
    for (const ok of [undefined, null, '']) {
      const extra = {}; if (ok !== undefined) extra.description = ok;
      expect(run(extra).error).toBeUndefined();
    }
    for (const bad of [7, true, {}, [], ['x']]) expect(run({ description: bad }).error).toBe('description must be text');
    const text = '  a\r\nb c  ';
    expect(run({ description: text }).data.description).toBe(text);
  });
});

describe('care level: text of at most 191 characters, whatever the service', () => {
  test.each([['a label', 'ICU / Critical, Ambulatory'], ['keys', 'crit_icu,crit_ecmo'], ['an empty text', ''], ['191 characters', 'c'.repeat(191)]])('%s is accepted and passed on as sent', (_n, value) => {
    expect(run({ careLevel: value }).data.careLevel).toBe(value);
  });
  test('a longer or non-text value is refused', () => {
    expect(run({ careLevel: 'c'.repeat(192) }).error).toBe('careLevel can be at most 191 characters');
    for (const bad of [7, true, {}, [], ['crit_icu']]) expect(run({ careLevel: bad }).error).toBe('careLevel must be text');
  });
  test('absent and null send nothing on', () => {
    expect(run({ careLevel: null }).data).not.toHaveProperty('careLevel');
    expect(run().data).not.toHaveProperty('careLevel');
  });
});

describe('the medical page fields pass through exactly as the controller validated them', () => {
  test('mobility, the three equipment flags, the flow rate and urgency', () => {
    const { data } = run({ mobility: 'walking', equipOxygen: true, equipOxygenLpm: 2.5, equipCardiacMonitor: false, equipVentilator: false, urgency: 'planned' });
    expect(data).toMatchObject({ mobility: 'walking', equipOxygen: true, equipOxygenLpm: 2.5, equipCardiacMonitor: false, equipVentilator: false, urgency: 'planned' });
  });
  test('absent and null send nothing on', () => {
    const { data } = run({ mobility: null, equipOxygen: null, urgency: null });
    for (const key of ['mobility', 'equipOxygen', 'urgency']) expect(data).not.toHaveProperty(key);
  });
});

describe('another service\'s own columns are refused for every generic service', () => {
  const SERVICE_SHAPES = [
    ['Commercial Air stretcher', { serviceType: 'Medical Escort', serviceKey: 'commercialair_stretcher' }],
    ['Commercial Air wheelchair', { serviceType: 'Medical Escort', serviceKey: 'commercialair_wheelchair' }],
    ['Ground Ambulance', { serviceType: 'Ground Ambulance', serviceKey: 'ground' }],
    ['Hospitalization', { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital' }],
    ['Corporate Medical', { serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate' }],
    ['older Marine', { serviceType: 'Marine Medical Safety', serviceKey: 'marine' }],
    ['older Medical Value Travel', { serviceType: 'Medical Value Travel', serviceKey: 'medvalue' }],
    ['the older "air" key', { serviceType: 'Air Ambulance', serviceKey: 'air' }],
    ['an older Teleconsultation', { serviceType: 'Tele Consultation & House Call', serviceKey: 'tele' }],
    ['no serviceKey', { serviceType: 'Ground Ambulance', serviceKey: undefined }],
  ];
  const VALUES = {
    originGeonameId: 1, originCityName: 'Pune', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata', destinationGeonameId: 2, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    deceasedRelation: 'Brother', placeOfDeath: 'Pune', dateOfDeath: '2026-11-01', transferScope: 'domestic', transportMode: 'ground_transportation', careRequirement: '12_hours', caretakerTypes: 'nurse',
  };
  test('the list is the fourteen keys of the approved plan', () => {
    expect(REFUSED_FIELDS).toHaveLength(14);
    expect(Object.keys(VALUES).sort()).toEqual([...REFUSED_FIELDS].sort());
  });
  describe.each(SERVICE_SHAPES)('%s', (_name, shape) => {
    test.each(Object.entries(VALUES))('%s is refused', (field, value) => {
      const result = validateGenericRequest({ ...body(), ...shape, [field]: value });
      expect(result.error).toBe(`${field} is not accepted for this service`);
      expect(result.data).toBeUndefined();
    });
  });
  test('a null value is treated as absent (nothing is stored, nothing is refused); any other value, even an empty text, is refused', () => {
    for (const field of REFUSED_FIELDS) {
      expect({ field, error: run({ [field]: null }).error }).toEqual({ field, error: undefined });
      expect(run({ [field]: null }).data).not.toHaveProperty(field);
      expect(run({ [field]: '' }).error).toBe(`${field} is not accepted for this service`);
      expect(run({ [field]: 0 }).error).toBe(`${field} is not accepted for this service`);
    }
  });
  test('a refused key never comes back in the data, and the refusal comes before nothing is stored', () => {
    const result = run({ transferScope: 'x'.repeat(50), originGeonameId: 'not a number' });
    expect(result.error).toMatch(/is not accepted for this service/);
    expect(result.data).toBeUndefined();
  });
});

describe('unknown keys: stage 1 (ignored, names reported, never values)', () => {
  test('an unknown key is ignored and its NAME is reported', () => {
    const { data, error, unknownFields } = run({ somethingNew: 'secret value', another: { nested: 'x' } });
    expect(error).toBeUndefined();
    expect(unknownFields).toEqual(['somethingNew', 'another']);
    expect(data).not.toHaveProperty('somethingNew');
    expect(data).not.toHaveProperty('another');
  });
  test('the retired legacy keys (columns that no longer exist) are ignored without a word', () => {
    expect(RETIRED_LEGACY_FIELDS).toEqual(['medicalSummary', 'documentUrl', 'additionalInfo', 'specialRequirements', 'referralSource']);
    const { data, unknownFields } = run({ medicalSummary: 'x', documentUrl: 'y', additionalInfo: 'z', specialRequirements: 'a', referralSource: 'b' });
    expect(unknownFields).toEqual([]);
    for (const key of RETIRED_LEGACY_FIELDS) expect(data).not.toHaveProperty(key);
  });
  test('the keys the structured services use are unknown here (they are ignored, not stored)', () => {
    const { data, unknownFields } = run({ treatmentScope: 'domestic', serviceScope: 'domestic', specialty: 'Oncology', currentCity: { text: 'x' }, homeAddress: 'x', utcOffsetMinutes: 0 });
    expect(unknownFields.sort()).toEqual(['currentCity', 'homeAddress', 'serviceScope', 'specialty', 'treatmentScope', 'utcOffsetMinutes']);
    expect(Object.keys(data).sort()).toEqual(['destination', 'origin', 'patientAge', 'patientName', 'serviceKey', 'serviceType']);
  });
  test('a name that could carry personal data (long, spaces or odd characters) is reported as "[other]"', () => {
    const { unknownFields } = run({ 'John Doe 9876543210': 1, [`x${'y'.repeat(60)}`]: 1, 'a@b.com': 1, ok_name: 1 });
    expect(unknownFields).toEqual(['[other]', '[other]', '[other]', 'ok_name']);
  });
  test('the log line holds only names and a known service key, at most 20 names, and never a value', () => {
    const known = new Set(['hospital', 'ground']);
    const names = Array.from({ length: 30 }, (_v, i) => `field${i}`);
    const line = unknownFieldsLogLine('hospital', names, known);
    expect(line.startsWith('[generic-request] unknown fields ignored (service hospital): field0, field1')).toBe(true);
    expect(line.split(': ')[1].split(', ')).toHaveLength(20);
    expect(unknownFieldsLogLine('John Doe 9876543210', ['a'], known)).toBe('[generic-request] unknown fields ignored (service unknown): a');
    expect(unknownFieldsLogLine(undefined, ['a'], known)).toBe('[generic-request] unknown fields ignored (service none): a');
    expect(unknownFieldsLogLine({}, ['a'], known)).toContain('(service unknown)');
    const { unknownFields } = run({ note: 'my phone is 9876543210' });
    expect(unknownFieldsLogLine('hospital', unknownFields, known)).not.toMatch(/9876543210|my phone/);
  });
});

describe('the body', () => {
  test('must be an object', () => {
    for (const bad of [null, undefined, [], 'x', 5, true]) expect(validateGenericRequest(bad).error).toBe('The request body must be a JSON object.');
  });
  test('it never throws, whatever it is given', () => {
    const weird = [{}, { serviceType: Symbol.iterator }, { serviceType: 'a', patientName: 'a', origin: 'a', destination: 'a', description: Object.create(null) }, JSON.parse('{"__proto__":{"x":1},"serviceType":"a","patientName":"a","origin":"a","destination":"a"}')];
    for (const input of weird) expect(() => validateGenericRequest(input)).not.toThrow();
  });
  test('prototype keys in the body are ignored, not copied', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"serviceType":"a","patientName":"a","origin":"a","destination":"a"}');
    const { data } = validateGenericRequest(input);
    expect(data.polluted).toBeUndefined();
    expect({}.polluted).toBeUndefined();
  });
});

describe('every malformed body is a 400, never a database error', () => {
  const BAD = [
    { patientAge: 'abc' }, { patientAge: -1 }, { patientAge: 1.5 }, { patientAge: 130 }, { patientAge: {} },
    { patientName: {} }, { patientName: 'N'.repeat(192) }, { origin: ['x'] }, { destination: 7 }, { serviceType: {} },
    { patientContact: 'c'.repeat(192) }, { patientGender: 'g'.repeat(192) }, { country: 'c'.repeat(192) }, { patientLocation: 'l'.repeat(192) },
    { preferredDate: 'not a date' }, { preferredDate: '2026-02-30' }, { description: 'd'.repeat(70000) }, { description: {} },
    { careLevel: 'c'.repeat(192) }, { careLevel: {} },
    { originGeonameId: 'x' }, { originGeonameId: 99999999999 }, { transferScope: 'x'.repeat(40) }, { transportMode: 'y'.repeat(60) }, { dateOfDeath: 'nonsense' }, { deceasedRelation: 'r'.repeat(300) },
  ];
  test.each(BAD.map((extra, i) => [i, extra]))('malformed body %#', (_i, extra) => {
    const result = run(extra);
    expect(typeof result.error).toBe('string');
    expect(result.data).toBeUndefined();
  });
});
