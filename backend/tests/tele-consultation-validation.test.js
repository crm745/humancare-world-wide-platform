// Teleconsultation (structured format): the validator, with no database. Everything it derives (address fields, description) and every rule it
// enforces. The submission, storage and Bitrix behaviour is in tele-consultation-form.test.js.
const {
  TELE_SERVICE_TYPE, ORIGIN_MAX, isTeleStructuredRequest, isStructuredTeleRow, validateTeleRequest, deriveAddress, shorten, composeDescription, composeLegacyDescription, calendarDate, earliestVisitDay,
} = require('../src/modules/requests/tele-consultation.validation');

const NOW = new Date('2026-11-16T10:00:00.000Z'); // UTC day 2026-11-16
const valid = (extra = {}) => ({
  serviceType: TELE_SERVICE_TYPE,
  serviceKey: 'tele',
  consultationScope: 'international',
  consultationType: 'online',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'India',
  patientContact: '+91 98765 43210',
  currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
  preferredDate: null,
  utcOffsetMinutes: 0,
  ...extra,
});
const check = (body, now = NOW) => validateTeleRequest(body, { now });
const errorOf = (body) => check(body).error;
const length = (text) => Array.from(text).length;

describe('which requests take this path', () => {
  it('only the structured format of the service key "tele"', () => {
    expect(isTeleStructuredRequest(valid())).toBe(true);
    for (const field of ['consultationScope', 'consultationType', 'currentAddress', 'presentMedicalIssue', 'allergyDetails']) {
      expect(isTeleStructuredRequest({ serviceKey: 'tele', [field]: 'x' })).toBe(true);
    }
  });
  it('an older Teleconsultation payload (no structured field) and every other service stay on the original path', () => {
    expect(isTeleStructuredRequest({ serviceKey: 'tele', serviceType: 'Tele Consultation & House Call', patientName: 'A', origin: 'Pune', destination: 'Mumbai', urgency: 'planned' })).toBe(false);
    for (const serviceKey of ['ground', 'privatecharter', 'commercialair_stretcher', 'homecare', undefined]) expect(isTeleStructuredRequest(valid({ serviceKey }))).toBe(false);
    for (const body of [null, undefined, 'x', 5, []]) expect(isTeleStructuredRequest(body)).toBe(false);
  });
  it('a stored request is "structured" when its destination is empty (every older one has a destination)', () => {
    expect(isStructuredTeleRow({ serviceKey: 'tele', destination: '' })).toBe(true);
    expect(isStructuredTeleRow({ serviceKey: 'tele', destination: 'Mumbai' })).toBe(false);
    expect(isStructuredTeleRow({ serviceKey: 'ground', destination: '' })).toBe(false);
    expect(isStructuredTeleRow(null)).toBe(false);
  });
});

// The Scope (Domestic / International) belongs to a House Call only. An Online Consultation has none; the older app builds always sent one for it, which is
// accepted (when it is a real option) and ignored.
describe('the combinations: a House Call has a Scope, an Online Consultation has none', () => {
  const tomorrow = '2026-11-17';
  it.each([
    [undefined, 'online', null, null],
    ['domestic', 'house_call', tomorrow, 'domestic'],
    ['international', 'house_call', tomorrow, 'international'],
    // an older build's Scope for an Online Consultation is ignored
    ['domestic', 'online', null, null],
    ['international', 'online', null, null],
  ])('%s + %s is accepted and stored in its own columns', (scope, type, preferredDate, stored) => {
    const { data, error } = check(valid({ consultationScope: scope, consultationType: type, preferredDate, currentAddress: 'Flat 4B, Rose Villa, Pune' }));
    expect(error).toBeUndefined();
    expect(data.serviceKey).toBe('tele');
    expect(data.serviceType).toBe(TELE_SERVICE_TYPE);
    expect(data.preferredDate).toBe(preferredDate);
    expect(data.consultationType).toBe(type);
    expect(data.transferScope).toBe(stored);
    // the type and the scope are NOT repeated in the description (no note was given, so it is empty)
    expect(data.description).toBe('');
  });
});

describe('what is stored for the patient', () => {
  it('derives every stored field itself, with an empty destination', () => {
    const { data } = check(valid());
    expect(data).toEqual({
      serviceType: TELE_SERVICE_TYPE, serviceKey: 'tele', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', patientContact: '+91 98765 43210', country: 'India',
      origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', patientLocation: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', preferredDate: null,
      consultationType: 'online', transferScope: null, description: '',
    });
  });
  it('does not return urgency, care level, mobility or equipment', () => {
    const { data } = check(valid());
    for (const key of ['urgency', 'careLevel', 'mobility', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator']) expect(data).not.toHaveProperty(key);
  });
  it('trims the name and writes the contact in international form', () => {
    expect(check(valid({ patientName: '  Asha Nair  ', patientContact: '+919876543210' })).data).toMatchObject({ patientName: 'Asha Nair', patientContact: '+91 98765 43210' });
  });
  it('writes the gender in one form whatever the case sent', () => {
    for (const [sent, stored] of [['male', 'Male'], ['FEMALE', 'Female'], ['Other', 'Other']]) expect(check(valid({ patientGender: sent })).data.patientGender).toBe(stored);
  });
});

describe('age: a whole number from 0 to 129, zero included', () => {
  it.each([[0], [1], [61], [129], ['0'], ['129'], [' 7 ']])('accepts %p', (age) => {
    const { data, error } = check(valid({ patientAge: age }));
    expect(error).toBeUndefined();
    expect(data.patientAge).toBe(Number(String(age).trim()));
  });
  it.each([[-1], [130], [1000], [1.5], ['1.5'], [''], ['abc'], [null], [undefined], [true], [[3]], ['-1'], ['0x10']])('refuses %p', (age) => {
    expect(errorOf(valid({ patientAge: age }))).toBe('patientAge must be a whole number from 0 to 129');
  });
});

describe('the other patient fields', () => {
  it.each([[''], ['A'], ['  '], ['1234'], [null], [5], ['Asha\u0007Nair']])('refuses the name %p', (name) => {
    expect(errorOf(valid({ patientName: name }))).toMatch(/^patientName/);
  });
  it.each([[''], ['Mr'], [null], ['Unknown'], [3]])('refuses the gender %p', (gender) => {
    expect(errorOf(valid({ patientGender: gender }))).toBe('patientGender must be Male, Female or Other');
  });
  it.each([[''], ['   '], [null], [undefined], [5]])('refuses the country %p', (country) => {
    expect(errorOf(valid({ country }))).toBe('country is required');
  });
  it('refuses a country longer than 100 characters', () => {
    expect(errorOf(valid({ country: 'x'.repeat(101) }))).toBe('country is required');
  });
  it.each([['9876543210'], ['+91 12345'], ['+999 1'], [''], [null], [91], ['+91 98765 4321O'], ['+1 000 000 0000']])('refuses the contact %p', (contact) => {
    expect(errorOf(valid({ patientContact: contact }))).toBe('patientContact must be a valid phone number with its country code');
  });
  it('takes numbers from other countries', () => {
    expect(check(valid({ patientContact: '+971 50 123 4567' })).data.patientContact).toBe('+971 50 123 4567');
    expect(check(valid({ patientContact: '+44 7911 123456' })).data.patientContact).toBe('+44 7911 123456');
  });
  // (a House Call: the Scope is required there)
  it.each([[undefined], [null], ['both'], ['Domestic'], [1], ['']])('refuses the scope %p for a House Call', (scope) => {
    expect(errorOf(valid({ consultationType: 'house_call', preferredDate: '2026-11-17', consultationScope: scope }))).toBe('consultationScope must be one of: domestic, international');
  });
  it.each([[undefined], [null], ['video'], ['House Call'], ['house-call']])('refuses the type %p', (type) => {
    expect(errorOf(valid({ consultationType: type }))).toBe('consultationType must be one of: online, house_call');
  });
});

describe('the address', () => {
  it('is required, and must not be blank', () => {
    for (const address of [undefined, null, '', '   ', '\n\n \n']) expect(errorOf(valid({ currentAddress: address }))).toBe('currentAddress is required');
  });
  it('must be text without control characters', () => {
    expect(errorOf(valid({ currentAddress: 5 }))).toBe('currentAddress must be text');
    expect(errorOf(valid({ currentAddress: ['Pune'] }))).toBe('currentAddress must be text');
    expect(errorOf(valid({ currentAddress: 'Pune\u0000' }))).toBe('currentAddress contains characters that are not allowed');
  });
  it('trims each line, drops blank lines and joins the rest with ", "', () => {
    const derived = deriveAddress('  Flat 4B, Rose Villa  \n\n   \r\n MG Road \r Pune 411001\n');
    expect(derived.line).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001');
  });
  it('keeps a single-line address exactly as typed, and does not repeat it in the description', () => {
    const { data } = check(valid({ currentAddress: '12 Lake View Road, Pune 411001' }));
    expect(data.origin).toBe('12 Lake View Road, Pune 411001');
    expect(data.description).not.toContain('Current address:');
  });
  it('stores a multi-line address as its one-line form in origin only; the description never holds it', () => {
    const typed = '  Flat 4B, Rose Villa\r\n\r\nMG Road\nPune 411001  ';
    const { data } = check(valid({ currentAddress: typed }));
    expect(data.origin).toBe('Flat 4B, Rose Villa, MG Road, Pune 411001');
    expect(data.patientLocation).toBe(data.origin);
    expect(data.description).toBe('');
    expect(data.description).not.toContain('MG Road');
  });
  it('is accepted up to 2000 characters and refused above', () => {
    expect(check(valid({ currentAddress: 'a'.repeat(2000) })).error).toBeUndefined();
    expect(errorOf(valid({ currentAddress: 'a'.repeat(2001) }))).toBe('currentAddress can be at most 2000 characters');
    // counted in characters, not UTF-16 units: 2000 emoji are accepted
    expect(check(valid({ currentAddress: '😀'.repeat(2000) })).error).toBeUndefined();
    expect(errorOf(valid({ currentAddress: '😀'.repeat(2001) }))).toBe('currentAddress can be at most 2000 characters');
  });
});

describe('the 191-character limit of origin and patient_location', () => {
  it('a 191-character single line is stored whole', () => {
    const line = 'A'.repeat(191);
    const { data } = check(valid({ currentAddress: line }));
    expect(length(data.origin)).toBe(191);
    expect(data.origin).toBe(line);
    expect(data.patientLocation).toBe(line);
    expect(data.description).not.toContain('Current address:');
  });
  it('a 192-character line is shortened to 191 with "…" (the address is not repeated in the description)', () => {
    const line = 'A'.repeat(192);
    const { data } = check(valid({ currentAddress: line }));
    expect(length(data.origin)).toBeLessThanOrEqual(ORIGIN_MAX);
    expect(data.origin.endsWith('…')).toBe(true);
    expect(data.patientLocation).toBe(data.origin);
    expect(data.description).not.toContain('Current address:');
    expect(data.description).not.toContain(line);
  });
  it('is cut at a comma or space when that keeps most of the address', () => {
    const words = Array.from({ length: 40 }, (_, i) => `Building${i}`).join(', '); // long, with commas
    const { line } = deriveAddress(words);
    expect(length(line)).toBeLessThanOrEqual(ORIGIN_MAX);
    expect(line.endsWith('…')).toBe(true);
    const kept = line.slice(0, -1);
    expect(words.startsWith(kept)).toBe(true);
    expect(words.slice(kept.length).startsWith(',')).toBe(true); // cut right before a comma
  });
  it('is cut hard at the limit when there is no boundary to use', () => {
    const { line } = deriveAddress('Z'.repeat(400));
    expect(length(line)).toBe(191);
    expect(line).toBe(`${'Z'.repeat(190)}…`);
  });
  it('never gives back more than the limit, whatever the length', () => {
    for (const size of [150, 190, 191, 192, 193, 250, 1000, 2000]) {
      expect(length(deriveAddress(`Street ${'x'.repeat(size)}`).line)).toBeLessThanOrEqual(ORIGIN_MAX);
    }
  });
  describe('Unicode', () => {
    const boundaries = (text) => {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const set = new Set([0]);
      let at = 0;
      for (const part of seg.segment(text)) { at += part.segment.length; set.add(at); }
      return set;
    };
    it('counts an emoji as one character', () => {
      const text = '😀'.repeat(191);
      expect(shorten(text)).toBe(text);
      expect(length(shorten('😀'.repeat(192)))).toBe(191);
    });
    it('never cuts inside an emoji made of several parts (a family, a flag, a skin tone)', () => {
      const family = '👨‍👩‍👧‍👦'; // seven code points, one character
      const flag = '🇮🇳';
      const tone = '👍🏽';
      for (const unit of [family, flag, tone]) {
        for (let pad = 150; pad <= 190; pad += 1) {
          const text = `${'a'.repeat(pad)}${unit.repeat(8)}`;
          const out = shorten(text);
          expect(length(out)).toBeLessThanOrEqual(ORIGIN_MAX);
          const body = out.endsWith('…') ? out.slice(0, -1) : out;
          expect(text.startsWith(body)).toBe(true);
          expect(boundaries(text).has(body.length)).toBe(true); // the cut is where a character ends
        }
      }
    });
    it('keeps combining marks with their letter', () => {
      const text = `${'a'.repeat(185)}${'é'.normalize('NFD').repeat(10)}`; // e + combining acute, ten times
      const out = shorten(text);
      const body = out.slice(0, -1);
      expect(boundaries(text).has(body.length)).toBe(true);
      expect(length(out)).toBeLessThanOrEqual(ORIGIN_MAX);
    });
    it('stores right-to-left and non-Latin addresses without loss when they fit', () => {
      for (const address of ['شارع الملك فهد، الرياض', 'फ्लैट 4B, रोज़ विला, पुणे', '東京都千代田区 1-1']) {
        expect(check(valid({ currentAddress: address })).data.origin).toBe(address);
      }
    });
  });
});

describe('Present medical issue and Allergic issue', () => {
  it('are optional: left out of the description when absent, null, empty or blank', () => {
    for (const extra of [{}, { presentMedicalIssue: null, allergyDetails: null }, { presentMedicalIssue: '', allergyDetails: '  \n ' }]) {
      const { data } = check(valid({ currentAddress: 'Pune', ...extra }));
      expect(data.description).toBe('');
    }
  });
  it('are stored as labelled sections, in order, with the text as typed (line breaks kept)', () => {
    const { data } = check(valid({ currentAddress: 'Flat 4B\nMG Road', presentMedicalIssue: 'Fever and cough\nfor three days.', allergyDetails: 'Penicillin.' }));
    expect(data.description).toBe([
      'Present medical issue:\nFever and cough\nfor three days.',
      'Allergic issue:\nPenicillin.',
    ].join('\n\n'));
  });
  it('the approved example is produced exactly', () => {
    const { data } = check(valid({
      consultationType: 'house_call', preferredDate: '2026-11-25', currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
      presentMedicalIssue: 'Fever and cough for three days.', allergyDetails: 'Penicillin.',
    }));
    expect(data).toMatchObject({ consultationType: 'house_call', transferScope: 'international' });
    expect(data.description).toBe([
      'Present medical issue:\nFever and cough for three days.',
      'Allergic issue:\nPenicillin.',
    ].join('\n\n'));
  });
  it('accept 2000 characters each, and refuse 2001', () => {
    expect(check(valid({ presentMedicalIssue: 'm'.repeat(2000), allergyDetails: 'a'.repeat(2000) })).error).toBeUndefined();
    expect(errorOf(valid({ presentMedicalIssue: 'm'.repeat(2001) }))).toBe('presentMedicalIssue can be at most 2000 characters');
    expect(errorOf(valid({ allergyDetails: 'a'.repeat(2001) }))).toBe('allergyDetails can be at most 2000 characters');
  });
  it('must be text without control characters', () => {
    expect(errorOf(valid({ presentMedicalIssue: 5 }))).toBe('presentMedicalIssue must be text');
    expect(errorOf(valid({ allergyDetails: { a: 1 } }))).toBe('allergyDetails must be text');
    expect(errorOf(valid({ allergyDetails: 'x\u0000' }))).toBe('allergyDetails contains characters that are not allowed');
  });
});

describe('the visit date: tomorrow or later, by the patient\'s own date', () => {
  // NOW is 2026-11-16 10:00 UTC. On a clock at UTC (offset 0) today is 2026-11-16, so tomorrow is 2026-11-17.
  const house = (preferredDate, extra = {}) => valid({ consultationType: 'house_call', preferredDate, ...extra });
  const TOO_EARLY = 'preferredDate must be tomorrow or later';

  it('yesterday is rejected', () => {
    expect(errorOf(house('2026-11-15'))).toBe(TOO_EARLY);
    expect(errorOf(house('2020-01-01'))).toBe(TOO_EARLY);
  });
  it('today is rejected', () => {
    expect(errorOf(house('2026-11-16'))).toBe(TOO_EARLY);
  });
  it('tomorrow is accepted', () => {
    const { data, error } = check(house('2026-11-17'));
    expect(error).toBeUndefined();
    expect(data.preferredDate).toBe('2026-11-17');
  });
  it.each([['2026-11-18'], ['2026-11-30'], ['2027-02-28'], ['2030-12-31']])('a valid future date (%s) is accepted', (preferredDate) => {
    const { data, error } = check(house(preferredDate));
    expect(error).toBeUndefined();
    expect(data.preferredDate).toBe(preferredDate);
  });
  it('a House Call needs a date', () => {
    for (const preferredDate of [undefined, null]) expect(errorOf(house(preferredDate))).toBe('preferredDate is required for a House Call');
  });
  it.each([['2026-02-30'], ['2026-13-01'], ['25/11/2026'], ['2026-1-5'], ['tomorrow'], [''], ['2026-11-25T10:00:00Z'], [20261125], [true]])('a House Call refuses the date %p', (preferredDate) => {
    expect(errorOf(house(preferredDate))).toBe('preferredDate must be a valid date (YYYY-MM-DD)');
  });
  it('a leap day is a real day, and 29 February of another year is not', () => {
    expect(calendarDate('2028-02-29')).toBe('2028-02-29');
    expect(calendarDate('2027-02-29')).toBeNull();
    expect(check(house('2028-02-29'), new Date('2028-01-10T00:00:00Z')).error).toBeUndefined();
  });

  it('an Online Consultation with a date is rejected, whatever the date', () => {
    for (const date of ['2026-11-17', '2026-11-16', '2026-11-15', '2030-01-01', '', 0, false]) {
      expect(errorOf(valid({ consultationType: 'online', preferredDate: date }))).toBe('preferredDate is only accepted for a House Call');
    }
  });
  it('an Online Consultation with a null date is accepted, and so is one with no date at all', () => {
    expect(check(valid({ consultationType: 'online', preferredDate: null })).data.preferredDate).toBeNull();
    const { preferredDate, ...without } = valid({ consultationType: 'online' });
    expect(preferredDate).toBeNull();
    expect(check(without).data.preferredDate).toBeNull();
  });

  describe('the patient\'s own calendar, from the device\'s UTC offset (the same clock the date picker uses)', () => {
    const at = (instant, offset, preferredDate) => check(house(preferredDate, { utcOffsetMinutes: offset }), new Date(instant));
    it('the same instant is a different "today" in different places, and the answer follows the patient', () => {
      const instant = '2026-11-16T22:00:00.000Z';
      // UTC: it is 22:00 on the 16th, so tomorrow is the 17th
      expect(at(instant, 0, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at(instant, 0, '2026-11-17').error).toBeUndefined();
      // India (+5:30): it is already 03:30 on the 17th, so the 17th is today and the 18th is tomorrow
      expect(at(instant, 330, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at(instant, 330, '2026-11-17').error).toBe(TOO_EARLY);
      expect(at(instant, 330, '2026-11-18').error).toBeUndefined();
      // US Pacific (-8:00): it is 14:00 on the 16th, so tomorrow is the 17th
      expect(at(instant, -480, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at(instant, -480, '2026-11-17').error).toBeUndefined();
    });
    it('a day that is tomorrow for the patient is never refused because of the UTC date', () => {
      // UTC-12 at 11:59 UTC is 23:59 on the 15th there: tomorrow is the 16th, which is already "today" in UTC
      expect(at('2026-11-16T11:59:59.000Z', -720, '2026-11-16').error).toBeUndefined();
      expect(at('2026-11-16T11:59:59.000Z', -720, '2026-11-15').error).toBe(TOO_EARLY);
      // a minute later it is the 16th there, and the 16th is refused
      expect(at('2026-11-16T12:00:00.000Z', -720, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at('2026-11-16T12:00:00.000Z', -720, '2026-11-17').error).toBeUndefined();
    });
    it('the edges of the day on the far side (UTC+14)', () => {
      expect(at('2026-11-16T09:59:59.999Z', 840, '2026-11-17').error).toBeUndefined(); // 23:59:59 on the 16th there
      expect(at('2026-11-16T10:00:00.000Z', 840, '2026-11-17').error).toBe(TOO_EARLY); // midnight: the 17th is today
      expect(at('2026-11-16T10:00:00.000Z', 840, '2026-11-18').error).toBeUndefined();
    });
    it('the edges of the day at UTC', () => {
      expect(at('2026-11-16T00:00:00.000Z', 0, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at('2026-11-16T00:00:00.000Z', 0, '2026-11-17').error).toBeUndefined();
      expect(at('2026-11-16T23:59:59.999Z', 0, '2026-11-16').error).toBe(TOO_EARLY);
      expect(at('2026-11-16T23:59:59.999Z', 0, '2026-11-17').error).toBeUndefined();
    });
    it('month, year and leap-day rollovers', () => {
      expect(earliestVisitDay(new Date('2026-11-30T23:30:00Z'), 0)).toBe('2026-12-01');
      expect(earliestVisitDay(new Date('2026-12-31T23:30:00Z'), 0)).toBe('2027-01-01');
      expect(earliestVisitDay(new Date('2026-12-31T20:00:00Z'), 330)).toBe('2027-01-02'); // already 1 January there
      expect(earliestVisitDay(new Date('2028-02-28T12:00:00Z'), 0)).toBe('2028-02-29');
      expect(earliestVisitDay(new Date('2027-02-28T12:00:00Z'), 0)).toBe('2027-03-01');
    });
    it('earliestVisitDay is tomorrow by the offset, in plain terms', () => {
      const now = new Date('2026-11-16T22:00:00.000Z');
      expect(earliestVisitDay(now, 0)).toBe('2026-11-17');
      expect(earliestVisitDay(now, 330)).toBe('2026-11-18');
      expect(earliestVisitDay(now, -480)).toBe('2026-11-17');
    });
    it('a House Call needs the offset (it is how the patient\'s date is known)', () => {
      const { utcOffsetMinutes, ...without } = house('2026-11-20');
      expect(utcOffsetMinutes).toBe(0);
      expect(check(without).error).toBe('utcOffsetMinutes is required for a House Call (the device\'s minutes east of UTC)');
      expect(errorOf(house('2026-11-20', { utcOffsetMinutes: null }))).toBe('utcOffsetMinutes is required for a House Call (the device\'s minutes east of UTC)');
    });
    it.each([[841], [-721], [1000], [1.5], ['330'], [true], [[0]], [NaN], [Infinity]])('refuses the offset %p', (offset) => {
      expect(errorOf(house('2026-11-20', { utcOffsetMinutes: offset }))).toBe('utcOffsetMinutes must be a whole number of minutes from -720 to 840 (minutes east of UTC)');
    });
    it('accepts every offset that exists, at both ends', () => {
      for (const offset of [-720, -480, 0, 330, 345, 540, 840]) expect(check(house('2030-01-01', { utcOffsetMinutes: offset })).error).toBeUndefined();
    });
    it('an Online Consultation does not need it, but a wrong one is still refused', () => {
      const { utcOffsetMinutes, ...without } = valid({ consultationType: 'online' });
      expect(utcOffsetMinutes).toBe(0);
      expect(check(without).error).toBeUndefined();
      expect(errorOf(valid({ consultationType: 'online', utcOffsetMinutes: 900 }))).toMatch(/^utcOffsetMinutes must be/);
    });
    it('the offset is not stored: it only decides the date', () => {
      expect(check(house('2026-11-20')).data).not.toHaveProperty('utcOffsetMinutes');
    });
  });
});

describe('fields that do not belong to Teleconsultation', () => {
  it.each([
    ['origin', 'Pune'], ['destination', 'Mumbai'], ['description', 'text'], ['urgency', 'planned'], ['careLevel', 'crit_icu'], ['mobility', 'walking'], ['equipOxygen', true],
    ['equipOxygenLpm', 4], ['equipCardiacMonitor', false], ['equipVentilator', false], ['patientLocation', 'Pune'], ['files', []], ['surprise', 1],
  ])('refuses %s', (key, value) => {
    expect(errorOf(valid({ [key]: value }))).toBe(`${key} is not accepted for Teleconsultation requests`);
  });
  it('refuses another service name or key', () => {
    expect(errorOf(valid({ serviceType: 'Teleconsultation' }))).toBe('serviceType must be "Tele Consultation & House Call" for Teleconsultation requests');
    expect(errorOf(valid({ serviceType: undefined }))).toMatch(/^serviceType must be/);
    expect(errorOf(valid({ serviceKey: 'tele_domestic' }))).toBe('serviceKey must be "tele" for Teleconsultation requests');
  });
  it('a body that is not an object is refused', () => {
    expect(validateTeleRequest(null).error).toBe('The request body must be a JSON object.');
    expect(validateTeleRequest([]).error).toBe('The request body must be a JSON object.');
  });
});

describe('the Scope belongs to a House Call only', () => {
  // an Online Consultation as the app sends it now: no Scope unless the test gives one
  const online = (extra = {}) => { const body = valid(); delete body.consultationScope; return { ...body, ...extra }; };
  const house = (extra = {}) => valid({ consultationType: 'house_call', preferredDate: '2026-11-17', ...extra });

  it('an Online Consultation is valid without a Scope, and stores and describes none', () => {
    const { data, error } = check(online());
    expect(error).toBeUndefined();
    expect(data.consultationType).toBe('online');
    expect(data.transferScope).toBeNull();
    expect(data.description).toBe('');
    expect(JSON.stringify(data)).not.toMatch(/domestic|international/i);
    expect(data.preferredDate).toBeNull();
  });
  it('an Online Consultation still needs Country and Contact Number', () => {
    expect(errorOf(online({ country: '' }))).toBe('country is required');
    expect(errorOf(online({ country: undefined }))).toBe('country is required');
    expect(errorOf(online({ patientContact: '' }))).toBe('patientContact must be a valid phone number with its country code');
    expect(errorOf(online({ patientContact: '12345' }))).toBe('patientContact must be a valid phone number with its country code');
  });
  it('an Online Consultation still refuses a visit date, and a scope that is not a real option', () => {
    expect(errorOf(online({ preferredDate: '2026-11-20' }))).toBe('preferredDate is only accepted for a House Call');
    for (const scope of ['both', 'Domestic', '', 5, ['domestic']]) expect(errorOf(online({ consultationScope: scope }))).toBe('consultationScope must be one of: domestic, international');
  });
  it('an Online Consultation keeps the patient rules (name, age, gender, address)', () => {
    expect(errorOf(online({ patientName: 'A' }))).toMatch(/patientName/);
    expect(errorOf(online({ patientAge: 130 }))).toMatch(/patientAge/);
    expect(errorOf(online({ patientGender: 'x' }))).toMatch(/patientGender/);
    expect(errorOf(online({ currentAddress: '' }))).toBe('currentAddress is required');
  });
  it('a House Call needs a Scope, and keeps every date rule and its description', () => {
    expect(check(house({ consultationScope: 'domestic' })).data).toMatchObject({ consultationType: 'house_call', transferScope: 'domestic', description: '' });
    expect(errorOf(house({ consultationScope: undefined }))).toBe('consultationScope must be one of: domestic, international');
    expect(errorOf(house({ preferredDate: undefined }))).toBe('preferredDate is required for a House Call');
    expect(errorOf(house({ preferredDate: '2026-11-16' }))).toBe('preferredDate must be tomorrow or later');
    expect(errorOf(house({ preferredDate: '2020-01-01' }))).toBe('preferredDate must be tomorrow or later');
    expect(errorOf(house({ utcOffsetMinutes: undefined }))).toMatch(/utcOffsetMinutes is required for a House Call/);
    expect(check(house()).data.preferredDate).toBe('2026-11-17');
  });
  it('the consultation type is checked first', () => {
    expect(errorOf(valid({ consultationType: undefined }))).toBe('consultationType must be one of: online, house_call');
    expect(errorOf(valid({ consultationType: 'video', consultationScope: undefined }))).toBe('consultationType must be one of: online, house_call');
  });
});

describe('composeDescription', () => {
  it('holds only the two notes, and never puts a blank section in', () => {
    expect(composeDescription({ issue: '', allergy: '' })).toBe('');
    expect(composeDescription({ issue: '', allergy: 'Dust' })).toBe('Allergic issue:\nDust');
    expect(composeDescription({ issue: 'Fever', allergy: '' })).toBe('Present medical issue:\nFever');
    expect(composeDescription({ issue: 'Fever', allergy: 'Dust' })).toBe('Present medical issue:\nFever\n\nAllergic issue:\nDust');
  });
  it('a new request never repeats the type, the scope or the address in the description', () => {
    const { data } = check(valid({ consultationType: 'house_call', preferredDate: '2026-11-25', currentAddress: 'Flat 4B\nMG Road', presentMedicalIssue: 'Fever', allergyDetails: 'Dust' }));
    for (const text of ['Consultation type', 'Scope', 'Current address', 'House Call', 'Domestic', 'International', 'Flat 4B', 'MG Road']) expect(data.description).not.toContain(text);
  });
  it('composeLegacyDescription still builds the text older requests carry (compatibility fixtures)', () => {
    expect(composeLegacyDescription({ scope: 'domestic', type: 'house_call', address: '', issue: '', allergy: '' })).toBe('Scope: Domestic\nConsultation type: House Call');
    expect(composeLegacyDescription({ scope: null, type: 'online', address: 'A', issue: '', allergy: 'Dust' })).toBe('Consultation type: Online Consultation\n\nCurrent address:\nA\n\nAllergic issue:\nDust');
  });
});
