// Home Healthcare Services (key "homecare"): the pure validation rules (no database, no network), the exact text-preservation policy, the character rules,
// the v1 description composer and its strict parser (against the golden vectors the mobile parser is tested with too), the one-line address copy, the
// new-format discriminator, and the summary PDF. The end-to-end behaviour (HTTP, storage, the Case, uploads) is in home-healthcare-request.test.js and the
// Bitrix lead text in home-healthcare-bitrix.test.js.
const vectors = require('./fixtures/home-healthcare-vectors.json');
const {
  HOME_SERVICE_TYPE, TEXT_MAX, FRAME_MAX, ONE_LINE_MAX, validateHomeRequest, composeHomeDescription, parseHomeDescription, isNewHomeFormat, hasDisallowedControl,
  hasUnpairedSurrogate, oneLineAddress, shortenLine, patientToday, calendarDate,
} = require('../src/modules/requests/home-healthcare.validation');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');

const NOW = new Date('2026-11-17T12:00:00.000Z'); // UTC day 2026-11-17
const base = (extra = {}) => ({
  serviceType: HOME_SERVICE_TYPE,
  serviceKey: 'homecare',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  country: 'India',
  patientContact: '+91 98765 43210',
  homeAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
  preferredDate: '2026-11-20',
  utcOffsetMinutes: 330,
  ...extra,
});
const check = (extra, now = NOW) => validateHomeRequest(base(extra), { now });
const errorOf = (extra) => check(extra).error;
const without = (field) => { const body = base(); delete body[field]; return validateHomeRequest(body, { now: NOW }); };
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';

describe('a valid request', () => {
  it('needs only the required fields; every care selection and Medical History are optional', () => {
    const { data, error } = check({});
    expect(error).toBeUndefined();
    expect(data).toEqual({
      serviceType: HOME_SERVICE_TYPE, serviceKey: 'homecare', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', patientContact: '+91 98765 43210', country: 'India',
      origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', patientLocation: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', preferredDate: '2026-11-20',
      careRequirement: null, caretakerTypes: null, careLevel: null,
      description: 'Home Healthcare v1 (address 40, history 0)\nComplete home address:\nFlat 4B, Rose Villa\nMG Road, Pune 411001',
    });
    expect(data).not.toHaveProperty('equipOxygen');
    expect(data).not.toHaveProperty('equipOxygenLpm');
    expect(data).not.toHaveProperty('urgency');
  });

  it('stores every answered care selection in its own column and NOT in the description', () => {
    const { data, error } = check({
      caretakerTypes: ['caretaker', 'nurse'], careRequirement: '24_hours', careLevel: 'semi_icu', equipOxygen: true, equipOxygenLpm: 2.5, medicalHistory: 'Post-op.',
    });
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ caretakerTypes: 'nurse,caretaker', careRequirement: '24_hours', careLevel: 'Semi ICU', equipOxygen: true, equipOxygenLpm: 2.5 });
    expect(data.description).toBe([
      'Home Healthcare v1 (address 40, history 8)',
      'Complete home address:', 'Flat 4B, Rose Villa', 'MG Road, Pune 411001', 'Medical History:', 'Post-op.',
    ].join('\n'));
    for (const text of ['Nurse', 'Caretaker', 'Care Requirement', 'Care Level', 'Semi ICU', '24 Hours', 'Oxygen', 'LPM']) expect(data.description).not.toContain(text);
    expect(parseHomeDescription(data.description)).toMatchObject({ ok: true, address: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', history: 'Post-op.', care: {} });
  });

  it('Oxygen No is stored as false, with no flow rate; unanswered stores nothing', () => {
    const no = check({ equipOxygen: false }).data;
    expect(no.equipOxygen).toBe(false);
    expect(no).not.toHaveProperty('equipOxygenLpm');
    expect(no.description).not.toContain('Oxygen');
    const none = check({}).data;
    expect(none).not.toHaveProperty('equipOxygen');
    expect(none.description).not.toContain('Oxygen');
  });

  it('the flow rate is normalised to one decimal, so its text is always what the parser expects', () => {
    const { data } = check({ equipOxygen: true, equipOxygenLpm: 0.30000000000000004 });
    expect(data.equipOxygenLpm).toBe(0.3);
    expect(data.description).not.toContain('LPM');
    expect(parseHomeDescription(data.description).ok).toBe(true);
  });
});

describe('required and optional fields', () => {
  it.each(['patientName', 'patientAge', 'patientGender', 'country', 'patientContact', 'homeAddress', 'preferredDate', 'utcOffsetMinutes'])('%s is required', (field) => {
    expect(without(field).error).toBeTruthy();
  });
  it.each(['caretakerTypes', 'careRequirement', 'careLevel', 'equipOxygen', 'medicalHistory'])('%s is optional (absent, null, and where it makes sense empty)', (field) => {
    expect(check({ [field]: undefined }).error).toBeUndefined();
    expect(check({ [field]: null }).error).toBeUndefined();
  });
  it('empty selections count as not answered', () => {
    expect(check({ caretakerTypes: [] }).data.caretakerTypes).toBeNull();
    expect(check({ medicalHistory: '' }).data.description).toMatch(/history 0\)/);
    expect(check({ medicalHistory: '   \n\t ' }).data.description).toMatch(/history 0\)/);
  });
  it('refuses a body that is not an object, the wrong key and the wrong name', () => {
    for (const bad of [null, undefined, 'x', 5, []]) expect(validateHomeRequest(bad, { now: NOW }).error).toBeTruthy();
    expect(errorOf({ serviceKey: 'tele' })).toMatch(/serviceKey/);
    expect(errorOf({ serviceType: 'Home Healthcare' })).toMatch(/serviceType/);
    expect(errorOf({ serviceType: undefined })).toMatch(/serviceType/);
  });
  it.each(['description', 'origin', 'destination', 'patientLocation', 'urgency', 'mobility', 'equipCardiacMonitor', 'equipVentilator', 'careLevelKeys', 'transferScope', 'userId', 'status', 'documents'])(
    'refuses the field %s (the older generic body, and anything the format does not carry)', (field) => {
      expect(errorOf({ [field]: 'x' })).toBe(`${field} is not accepted for Home Healthcare requests`);
    },
  );
  it('refuses the whole older generic Home Healthcare body', () => {
    const old = { serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'John Doe', origin: 'Pune', destination: 'Pune', description: 'Needs a nurse', urgency: 'planned' };
    expect(validateHomeRequest(old, { now: NOW }).error).toMatch(/is not accepted for Home Healthcare requests/);
  });
});

describe('the patient', () => {
  it('needs a name of 2 to 100 characters with a letter, on one line', () => {
    for (const patientName of ['A', '12345', '   ', 'Name\nSecond', 'Name\tTab', 'x'.repeat(101), 5, undefined, 'Na me']) expect(errorOf({ patientName })).toMatch(/patientName/);
    expect(check({ patientName: 'x'.repeat(100) }).error).toBeUndefined();
    expect(check({ patientName: '  Asha Nair  ' }).data.patientName).toBe('Asha Nair');
  });

  it('accepts ages 1 to 129 only, as a number or a plain digit string', () => {
    for (const patientAge of [1, 61, 129, '1', '129', ' 61 ']) expect(check({ patientAge }).error).toBeUndefined();
    expect(check({ patientAge: '061' }).error).toMatch(/patientAge/);
    for (const patientAge of [0, '0', 130, '130', -1, 1.5, '1.5', 'abc', '', null, undefined, '1e2', 1000, [], NaN]) expect(errorOf({ patientAge })).toBe('patientAge must be a whole number from 1 to 129');
  });

  it('needs Male, Female or Other', () => {
    expect(check({ patientGender: 'male' }).data.patientGender).toBe('Male');
    expect(check({ patientGender: 'OTHER' }).data.patientGender).toBe('Other');
    for (const patientGender of ['', 'M', 'Unknown', undefined, 1]) expect(errorOf({ patientGender })).toMatch(/patientGender/);
  });

  it('needs a country, one line, at most 100 characters', () => {
    for (const country of ['', '  ', undefined, 5, 'x'.repeat(101), 'In\ndia']) expect(errorOf({ country })).toBe('country is required');
    expect(check({ country: 'x'.repeat(100) }).error).toBeUndefined();
  });

  it('needs a valid contact number with its country code, and stores it in international form', () => {
    expect(check({ patientContact: '+919876543210' }).data.patientContact).toBe('+91 98765 43210');
    expect(check({ patientContact: '+971501234567' }).error).toBeUndefined();
    for (const patientContact of ['9876543210', '+91 12345', '+999 123', 'abc', '', null, undefined, 9876543210]) expect(errorOf({ patientContact })).toMatch(/patientContact/);
  });
});

describe('the Service Date, by the patient\'s own calendar', () => {
  it('calendarDate accepts only real days', () => {
    expect(calendarDate('2026-02-28')).toBe('2026-02-28');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '20261117', '', 'tomorrow', '2026-11-17T00:00:00Z']) expect(calendarDate(bad)).toBeNull();
  });
  it('works out the patient\'s today from the offset', () => {
    expect(patientToday(NOW, 0)).toBe('2026-11-17');
    expect(patientToday(new Date('2026-11-17T20:00:00Z'), 330)).toBe('2026-11-18');
    expect(patientToday(new Date('2026-11-17T03:00:00Z'), -300)).toBe('2026-11-16');
  });
  it('accepts today and any future day, and refuses a past day', () => {
    expect(check({ preferredDate: '2026-11-17', utcOffsetMinutes: 0 }).error).toBeUndefined();
    expect(check({ preferredDate: '2027-05-01' }).error).toBeUndefined();
    expect(errorOf({ preferredDate: '2026-11-16', utcOffsetMinutes: 0 })).toBe('preferredDate cannot be in the past');
  });
  it('refuses a missing, malformed or impossible date', () => {
    expect(without('preferredDate').error).toMatch(/preferredDate/);
    for (const bad of ['2026-02-30', '17/11/2026', '', 5, null]) expect(errorOf({ preferredDate: bad })).toMatch(/preferredDate/);
  });
  it('needs a valid UTC offset', () => {
    expect(without('utcOffsetMinutes').error).toMatch(/utcOffsetMinutes/);
    for (const utcOffsetMinutes of [-721, 841, 1.5, '330', null, NaN]) expect(errorOf({ utcOffsetMinutes })).toMatch(/utcOffsetMinutes/);
    for (const utcOffsetMinutes of [-720, 0, 330, 840]) expect(check({ utcOffsetMinutes }).error).toBeUndefined();
  });
  it('agrees with the device at every offset and every hour: today and tomorrow are accepted, yesterday is refused', () => {
    for (const utcOffsetMinutes of [-720, -300, 0, 60, 330, 345, 540, 765, 840]) {
      for (let hour = 0; hour < 24; hour += 1) {
        const now = new Date(Date.UTC(2026, 10, 17, hour, 15));
        const today = new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10);
        const shift = (days) => new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
        const result = (preferredDate) => validateHomeRequest(base({ preferredDate, utcOffsetMinutes }), { now }).error;
        expect(result(today)).toBeUndefined();
        expect(result(shift(1))).toBeUndefined();
        expect(result(shift(-1))).toBe('preferredDate cannot be in the past');
      }
    }
  });
});

describe('the care selections', () => {
  it('Nurse and Caretaker are the only options: each, both, in any order, never twice', () => {
    expect(check({ caretakerTypes: ['nurse'] }).data.caretakerTypes).toBe('nurse');
    expect(check({ caretakerTypes: ['caretaker'] }).data.caretakerTypes).toBe('caretaker');
    expect(check({ caretakerTypes: ['caretaker', 'nurse'] }).data.caretakerTypes).toBe('nurse,caretaker');
    for (const caretakerTypes of [['doctor'], ['nurse', 'nurse'], ['Nurse'], 'nurse', [1], [null], ['nurse', 'doctor'], {}]) {
      expect(errorOf({ caretakerTypes })).toMatch(/caretakerTypes/);
    }
  });
  it('Care Requirement is exactly one of 12 Hours or 24 Hours', () => {
    expect(check({ careRequirement: '12_hours' }).data.careRequirement).toBe('12_hours');
    expect(check({ careRequirement: '24_hours' }).data.careRequirement).toBe('24_hours');
    for (const careRequirement of ['', '36_hours', '12 Hours', ['12_hours'], 12, '__proto__', 'constructor']) expect(errorOf({ careRequirement })).toMatch(/careRequirement/);
  });
  it('Care Level is exactly one of Full ICU or Semi ICU', () => {
    expect(check({ careLevel: 'full_icu' }).data.careLevel).toBe('Full ICU');
    expect(check({ careLevel: 'semi_icu' }).data.careLevel).toBe('Semi ICU');
    for (const careLevel of ['', 'icu', 'Full ICU', ['full_icu'], 1, 'toString']) expect(errorOf({ careLevel })).toMatch(/careLevel/);
  });
  it('Oxygen is a boolean; the flow rate is required when Yes and refused when No or unanswered', () => {
    expect(errorOf({ equipOxygen: true })).toBe('equipOxygenLpm is required when Oxygen is Yes');
    expect(errorOf({ equipOxygen: true, equipOxygenLpm: null })).toBe('equipOxygenLpm is required when Oxygen is Yes');
    expect(errorOf({ equipOxygen: false, equipOxygenLpm: 4 })).toBe('equipOxygenLpm is only accepted when Oxygen is Yes');
    expect(errorOf({ equipOxygenLpm: 4 })).toBe('equipOxygenLpm is only accepted when Oxygen is Yes');
    for (const equipOxygen of ['yes', 'true', 1, 0, []]) expect(errorOf({ equipOxygen })).toBe('equipOxygen must be true or false');
  });
  it('the flow rate is above 0 and at most 15, with at most one decimal, and a JSON number', () => {
    for (const equipOxygenLpm of [0.5, 1, 4, 2.5, 15]) expect(check({ equipOxygen: true, equipOxygenLpm }).error).toBeUndefined();
    for (const equipOxygenLpm of [0, -1, 15.1, 16, 2.55, '4', NaN, Infinity]) expect(errorOf({ equipOxygen: true, equipOxygenLpm })).toMatch(/equipOxygenLpm/);
  });
});

describe('the character rules: only what cannot be stored faithfully is refused', () => {
  const fields = [['homeAddress', 'Pune'], ['medicalHistory', 'Post-op']];
  it('refuses every control character except TAB, LF and CR, in both free-text fields', () => {
    const refused = [];
    const accepted = [];
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code >= 0x20 && code < 0x7f) continue;
      (code === 9 || code === 10 || code === 13 ? accepted : refused).push(code);
    }
    for (const [field, text] of fields) {
      for (const code of refused) expect({ field, code, error: errorOf({ [field]: `${text}${String.fromCharCode(code)}${text}` }) }).toEqual({ field, code, error: `${field} contains characters that cannot be saved` });
      for (const code of accepted) expect({ field, code, error: errorOf({ [field]: `${text}${String.fromCharCode(code)}${text}` }) }).toEqual({ field, code, error: undefined });
    }
  });
  it('refuses NUL and unpaired surrogates', () => {
    for (const [field] of fields) {
      for (const bad of ['a\u0000b', 'a\uD83Db', 'a\uDE00b', '\uD83D', '\uDE00', 'x\uD83D😀']) expect(errorOf({ [field]: bad })).toBe(`${field} contains characters that cannot be saved`);
    }
  });
  it('accepts everything else exactly as typed: separators, zero-width and format characters, emoji, ZWJ sequences, combining marks, every script', () => {
    const samples = ['a b c', 'a b　c', 'a​b‍c‎', '\u{1F3E5}', family, 'café', 'café', 'مرحبا', 'שלום', 'తెలుగు', 'नमस्ते', '�', '￿', 'a\tb', 'a\r\nb\rc\nd'];
    for (const [field] of fields) for (const text of samples) expect({ field, text, error: errorOf({ [field]: text }) }).toEqual({ field, text, error: undefined });
  });
  it('the helpers agree', () => {
    expect(hasDisallowedControl('a\u0007b')).toBe(true);
    expect(hasDisallowedControl('a\tb\r\n')).toBe(false);
    expect(hasUnpairedSurrogate('\uD83D')).toBe(true);
    expect(hasUnpairedSurrogate('\u{1F600}')).toBe(false);
  });
});

describe('the address and Medical History are kept exactly as typed', () => {
  const stored = (extra) => {
    const { data, error } = check(extra);
    expect(error).toBeUndefined();
    const parsed = parseHomeDescription(data.description);
    expect(parsed.ok).toBe(true);
    return parsed;
  };
  it.each([
    ['leading and trailing spaces', '   padded   '], ['trailing newlines', 'text\n\n\n'], ['CRLF', 'line1\r\nline2\r\n'], ['a lone CR', 'a\rb'], ['blank lines', 'a\n\n\nb'],
    ['Unicode separators', 'a b c'], ['no-break and ideographic spaces', 'a b　c'], ['zero-width characters', 'a​b‍c'], ['emoji', '\u{1F3E5}\u{1F3E5}'],
    ['a ZWJ family emoji', family], ['precomposed accents', 'café'], ['decomposed accents', 'café'], ['Arabic', 'مرحبا abc'],
    ['Telugu', 'తెలుగు'], ['tabs', 'a\tb'], ['text that looks like the format', 'Medical History:\nx\nComplete home address:\ny\nHome Healthcare v1 (address 1, history 1)\nOxygen: Yes (99 LPM)'],
  ])('%s', (_name, text) => {
    const parsed = stored({ homeAddress: text, medicalHistory: text });
    expect(parsed.address).toBe(text);
    expect(parsed.history).toBe(text);
    expect(Buffer.compare(Buffer.from(parsed.address, 'utf8'), Buffer.from(text, 'utf8'))).toBe(0);
  });
  it('precomposed and decomposed accents stay two different strings (no Unicode normalisation)', () => {
    expect(stored({ homeAddress: 'café' }).address).not.toBe(stored({ homeAddress: 'café' }).address);
  });
  it('whitespace-only Medical History is "not entered"; a history with surrounding whitespace is kept untrimmed; the address is judged on a trimmed copy but kept untrimmed', () => {
    expect(stored({ medicalHistory: ' \n ' }).history).toBe('');
    expect(stored({ medicalHistory: '  keep me  \n' }).history).toBe('  keep me  \n');
    expect(errorOf({ homeAddress: ' \n\t ' })).toBe('homeAddress is required');
    expect(stored({ homeAddress: '  Pune  ' }).address).toBe('  Pune  ');
  });
  it('the limit is 2,000 code points (an emoji counts as one) while the framing counts UTF-16 code units', () => {
    expect(TEXT_MAX).toBe(2000);
    expect(FRAME_MAX).toBe(4000);
    const atLimit = '\u{1F600}'.repeat(2000);
    expect(atLimit.length).toBe(4000);
    const parsed = stored({ homeAddress: atLimit, medicalHistory: atLimit });
    expect(parsed.address).toBe(atLimit);
    expect(check({ homeAddress: atLimit }).data.description.startsWith('Home Healthcare v1 (address 4000, history 0)\n')).toBe(true);
    expect(errorOf({ homeAddress: '\u{1F600}'.repeat(2001) })).toBe('homeAddress can be at most 2000 characters');
    expect(errorOf({ medicalHistory: 'x'.repeat(2001) })).toBe('medicalHistory can be at most 2000 characters');
    expect(check({ homeAddress: 'x'.repeat(2000), medicalHistory: 'y'.repeat(2000) }).error).toBeUndefined();
    expect(errorOf({ homeAddress: 5 })).toBe('homeAddress is required');
    expect(errorOf({ medicalHistory: 5 })).toBe('medicalHistory must be text');
  });
  it('a free-text value is never altered by validation', () => {
    const typed = '  a\r\n b\t\u{1F600} ';
    expect(check({ homeAddress: typed, medicalHistory: typed }).data.description.endsWith(`Medical History:\n${typed}`)).toBe(true);
  });
});

describe('the one-line address copy (origin and patient_location)', () => {
  it('trims every line, drops blank lines and joins with ", " (the exact address is in the description)', () => {
    expect(oneLineAddress('  Flat 4B  \r\n\r\n MG Road Pune 411001\n')).toBe('Flat 4B, MG Road, Pune 411001');
    expect(oneLineAddress('Pune')).toBe('Pune');
  });
  it('is at most 191 characters, cut on a character boundary at a comma or space, ending with an ellipsis', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Street${i}`).join(', ');
    const line = oneLineAddress(long);
    expect(Array.from(line).length).toBeLessThanOrEqual(ONE_LINE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect(line.endsWith(', …')).toBe(false);
    expect(long.startsWith(line.slice(0, -1))).toBe(true);
  });
  it('never splits an emoji sequence or a letter with its accents, and counts code points', () => {
    const emoji = oneLineAddress(`${'a'.repeat(185)}${family}${family}`);
    expect(Array.from(emoji).length).toBeLessThanOrEqual(ONE_LINE_MAX);
    expect(hasUnpairedSurrogate(emoji)).toBe(false);
    expect(emoji.includes('‍…')).toBe(false);
    const accents = shortenLine(`${'é'.repeat(200)}`);
    expect(accents.endsWith('́…') || accents.endsWith('e…')).toBe(true);
    expect(accents.startsWith('é')).toBe(true);
    expect(Array.from(check({ homeAddress: '\u{1F600}'.repeat(2000) }).data.origin).length).toBeLessThanOrEqual(ONE_LINE_MAX);
  });
});

describe('the description parser: golden vectors', () => {
  it.each(vectors.valid.map((v) => [v.name, v]))('accepts and recovers %s', (_name, vector) => {
    const parsed = parseHomeDescription(vector.description);
    expect(parsed.ok).toBe(true);
    expect(parsed.address).toBe(vector.address);
    expect(parsed.history).toBe(vector.history);
    expect(parsed.care).toEqual(vector.care);
    expect(composeHomeDescription({ care: {}, address: vector.address, history: vector.history }).startsWith(`Home Healthcare v1 (address ${vector.address.length}, history ${vector.history.length})`)).toBe(true);
  });
  it.each(vectors.invalid.map((v) => [v.name, v]))('refuses %s, without throwing and without a partial result', (_name, vector) => {
    const parsed = parseHomeDescription(vector.text);
    expect(parsed).toEqual({ ok: false });
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: vector.text })).toBe(false);
  });
});

describe('the description parser: properties', () => {
  const care = { caretakerTypes: ['nurse', 'caretaker'], careRequirement: '12_hours', careLevel: 'full_icu', equipOxygen: true, equipOxygenLpm: 4 };
  it('round-trips random text built from marker fragments, separators and emoji', () => {
    const pool = ['\n', '\r\n', ' ', ' ', ' ', 'Medical History:', 'Complete home address:', 'Home Healthcare v1 (address 3, history 2)', 'Oxygen: Yes (5 LPM)', 'a', '\u{1F600}', '́', '\t', ':', family];
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 3000; i += 1) {
      const pick = () => Array.from({ length: Math.floor(random() * 8) }, () => pool[Math.floor(random() * pool.length)]).join('');
      const address = pick() || 'a';
      const history = pick();
      const parsed = parseHomeDescription(composeHomeDescription({ care: random() < 0.5 ? care : {}, address, history }));
      expect({ ok: parsed.ok, same: parsed.address === address && parsed.history === history }).toEqual({ ok: true, same: true });
    }
  });
  it('never throws, whatever it is given', () => {
    for (const value of [undefined, null, 0, 7, true, {}, [], () => {}, Symbol('x'), 'x'.repeat(100000), '\uD83D', '\n'.repeat(1000), 'Home Healthcare v1 (address 1, history 0)\n'.repeat(500)]) {
      expect(() => parseHomeDescription(value)).not.toThrow();
      expect(parseHomeDescription(value).ok).toBe(false);
    }
  });
  it('every truncation of a valid document is refused', () => {
    const doc = composeHomeDescription({ care, address: 'Flat 4B\r\nMG Road  ', history: 'Medical History:\nfake  \n' });
    for (let i = 0; i < doc.length; i += 1) expect(parseHomeDescription(doc.slice(0, i)).ok).toBe(false);
    expect(parseHomeDescription(doc).ok).toBe(true);
  });
});

describe('new-format detection', () => {
  const doc = composeHomeDescription({ care: {}, address: 'Pune', history: '' });
  it('needs the key homecare AND a complete valid description', () => {
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: doc })).toBe(true);
    expect(isNewHomeFormat({ serviceKey: 'ground', description: doc })).toBe(false);
    expect(isNewHomeFormat({ serviceKey: 'tele', description: doc })).toBe(false);
    expect(isNewHomeFormat({ serviceKey: 'mortal', description: doc })).toBe(false);
    expect(isNewHomeFormat({ description: doc })).toBe(false);
    expect(isNewHomeFormat(null)).toBe(false);
    expect(isNewHomeFormat(undefined)).toBe(false);
  });
  it('an older Home Healthcare request, one with plain text, no description or an empty destination alone is legacy', () => {
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: 'Needs a nurse', origin: 'Pune', destination: 'Mumbai' })).toBe(false);
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: null, destination: '' })).toBe(false);
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: '', destination: '' })).toBe(false);
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: 'Home Healthcare v1 is what I need', destination: '' })).toBe(false);
  });
  it('the destination is never consulted: a new request is new whatever its destination says', () => {
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: doc, destination: 'Mumbai' })).toBe(true);
    expect(isNewHomeFormat({ serviceKey: 'homecare', description: doc, destination: '' })).toBe(true);
  });
});

describe('the summary PDF', () => {
  const stored = (extra = {}) => ({
    referenceNumber: 'REQ-1100', serviceKey: 'homecare', serviceType: HOME_SERVICE_TYPE, status: 'submitted', createdAt: new Date('2026-11-17T08:00:00Z'), patientName: 'Asha Nair', patientAge: 61,
    patientGender: 'Female', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', preferredDate: new Date('2026-11-20T00:00:00Z'), urgency: null,
    careRequirement: '12_hours', caretakerTypes: 'nurse,caretaker', careLevel: 'Full ICU', equipOxygen: true, equipOxygenLpm: 4,
    description: composeHomeDescription({ care: { caretakerTypes: ['nurse', 'caretaker'], careRequirement: '12_hours', careLevel: 'full_icu', equipOxygen: true, equipOxygenLpm: 4 }, address: 'Flat 4B, Rose Villa', history: 'Post-op, needs wound care.' }),
    ...extra,
  });
  it('prints the new layout: the exact address, the Service Date, the answered care rows and Medical History; no From, To, urgency or "on board"', async () => {
    const lines = await renderPdfLines(stored());
    expect(valueAfter(lines, 'Patient Name:')).toBe('Asha Nair');
    expect(valueAfter(lines, 'Service:')).toBe('Home Healthcare Services');
    expect(valueAfter(lines, 'Home address:')).toBe('Flat 4B, Rose Villa');
    expect(valueAfter(lines, 'Service Date:')).toBe('Fri Nov 20 2026');
    expect(valueAfter(lines, 'Nurse / Caretaker:')).toBe('Nurse, Caretaker');
    expect(valueAfter(lines, 'Care Requirement:')).toBe('12 Hours');
    expect(valueAfter(lines, 'Care Level:')).toBe('Full ICU');
    expect(valueAfter(lines, 'Oxygen:')).toBe('Yes (4 LPM)');
    expect(valueAfter(lines, 'Medical History:')).toBe('Post-op, needs wound care.');
    for (const label of ['From:', 'To:', 'Urgency:', 'Required on board:', 'Condition & diagnosis:', 'Care level:', 'Date Of Service:']) expect(lines).not.toContain(label);
    expect(lines.join('\n')).not.toMatch(/Home Healthcare v1|address \d+, history/);
  });
  it('leaves out what was not answered', async () => {
    const lines = await renderPdfLines(stored({ careRequirement: null, caretakerTypes: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null, description: composeHomeDescription({ care: {}, address: 'Pune', history: '' }) }));
    expect(valueAfter(lines, 'Home address:')).toBe('Pune');
    for (const label of ['Nurse / Caretaker:', 'Care Requirement:', 'Care Level:', 'Oxygen:', 'Medical History:']) expect(lines).not.toContain(label);
    const no = await renderPdfLines(stored({ equipOxygen: false, equipOxygenLpm: null }));
    expect(valueAfter(no, 'Oxygen:')).toBe('No');
  });
  it('renders unusual characters without error', async () => {
    const address = `Flat \u{1F3E5} 4B\r\n\tMG Road مرحبا తెలుగు ${family} café x`;
    await expect(renderPdfLines(stored({ description: composeHomeDescription({ care: {}, address, history: `\u{1F600} ${address}` }) }))).resolves.toEqual(expect.any(Array));
    await expect(renderPdfLines(stored({ description: composeHomeDescription({ care: {}, address: '\u{1F600}'.repeat(2000), history: '\u{1F600}'.repeat(2000) }) }))).resolves.toEqual(expect.any(Array));
  });
  it('a legacy Home Healthcare request (plain description, a destination) is printed exactly as before', async () => {
    const legacy = { ...stored(), description: 'Needs a nurse for post-surgery care.', destination: 'Mumbai', origin: 'Pune', urgency: 'planned', careRequirement: null, caretakerTypes: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null };
    const lines = await renderPdfLines(legacy);
    expect(valueAfter(lines, 'From:')).toBe('Pune');
    expect(valueAfter(lines, 'To:')).toBe('Mumbai');
    expect(valueAfter(lines, 'Condition & diagnosis:')).toBe('Needs a nurse for post-surgery care.');
    expect(valueAfter(lines, 'Urgency:')).toBe('Planned');
    expect(lines).not.toContain('Home address:');
  });
  it('a request with a corrupted v1 text falls back to the legacy layout', async () => {
    const good = stored().description;
    const lines = await renderPdfLines(stored({ description: good.slice(0, good.length - 3) }));
    expect(lines).toContain('From:');
    expect(lines).not.toContain('Home address:');
  });
});
