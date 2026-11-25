// Mortal Remains: the pure validation rules (no database, no network), the description the backend composes for Bitrix's Requirement line, and the
// file-signature check used on its uploads. The end-to-end behaviour (storing, the Case, uploads, downloads) is in mortal-remains-request.test.js.
const {
  validateMortalRequest, composeDescription, userDetailsOf, patientToday, calendarDate, SCOPES, MODES, RELATIONS,
} = require('../src/modules/requests/mortal-remains.validation');
const { detectFileKind, contentMatchesDeclared } = require('../src/common/utils/file-signature');

// 12:00 UTC on 2026-11-17. For a device at UTC+05:30 it is 17:30 the same day.
const NOW = new Date('2026-11-17T12:00:00Z');
const base = (extra = {}) => ({
  serviceType: 'Mortal Remains Transportation',
  serviceKey: 'mortal',
  transferScope: 'international',
  transportMode: 'private_charter',
  patientName: 'Suresh Kale',
  patientAge: 64,
  patientGender: 'Male',
  deceasedRelation: 'Brother',
  placeOfDeath: 'Rashid Hospital, Dubai',
  dateOfDeath: '2026-11-15',
  country: 'India',
  origin: 'Dubai, United Arab Emirates',
  destination: 'Pune, India',
  patientContact: '+91 98765 43210',
  preferredDate: '2026-11-20',
  urgency: 'urgent_24h',
  utcOffsetMinutes: 330,
  ...extra,
});
const check = (extra, now = NOW) => validateMortalRequest(base(extra), { now });
const without = (field) => { const body = base(); delete body[field]; return validateMortalRequest(body, { now: NOW }); };

describe('a valid request', () => {
  it('returns the data to store, with the fixed service type and the derived fields', () => {
    const { data, error } = check({});
    expect(error).toBeUndefined();
    expect(data).toMatchObject({
      serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', transferScope: 'international', transportMode: 'private_charter',
      patientName: 'Suresh Kale', patientAge: 64, patientGender: 'Male', deceasedRelation: 'Brother', placeOfDeath: 'Rashid Hospital, Dubai',
      dateOfDeath: '2026-11-15', country: 'India', origin: 'Dubai, United Arab Emirates', patientLocation: 'Dubai, United Arab Emirates',
      destination: 'Pune, India', patientContact: '+91 98765 43210', preferredDate: '2026-11-20', urgency: 'urgent_24h',
    });
  });

  it('accepts all six scope and mode combinations', () => {
    for (const transferScope of Object.keys(SCOPES)) {
      for (const transportMode of Object.keys(MODES)) {
        const { data, error } = check({ transferScope, transportMode });
        expect(error).toBeUndefined();
        expect(data).toMatchObject({ transferScope, transportMode });
        expect(data.description).toBe(`Transfer Scope: ${SCOPES[transferScope]}\nTransport Mode: ${MODES[transportMode]}`);
      }
    }
  });

  it('accepts every relation, and the three genders in any letter case', () => {
    for (const deceasedRelation of RELATIONS) expect(check({ deceasedRelation }).error).toBeUndefined();
    expect(check({ patientGender: 'female' }).data.patientGender).toBe('Female');
    expect(check({ patientGender: 'OTHER' }).data.patientGender).toBe('Other');
  });
});

describe('scope and mode', () => {
  it.each([undefined, null, '', 'both', 'Domestic', 'DOMESTIC', 'within_india', ['domestic'], 1])('refuses the scope %p', (transferScope) => {
    expect(check({ transferScope }).error).toMatch(/transferScope/);
  });
  it.each([undefined, null, '', 'air', 'Private Charter', 'private-charter', ['private_charter'], 1])('refuses the mode %p', (transportMode) => {
    expect(check({ transportMode }).error).toMatch(/transportMode/);
  });
  it('does not take a prototype key as a value', () => {
    expect(check({ transferScope: 'constructor' }).error).toMatch(/transferScope/);
    expect(check({ transportMode: '__proto__' }).error).toMatch(/transportMode/);
  });
});

describe('service identity and unexpected fields', () => {
  it('needs the key "mortal" and the fixed name', () => {
    expect(check({ serviceKey: 'mortal_domestic' }).error).toMatch(/serviceKey/);
    expect(check({ serviceKey: 'mortal_international' }).error).toMatch(/serviceKey/);
    expect(check({ serviceType: 'Mortal Remains Transportation — International' }).error).toMatch(/serviceType/);
    expect(check({ serviceType: undefined }).error).toMatch(/serviceType/);
  });

  it.each(['description', 'patientLocation', 'mobility', 'equipOxygen', 'equipOxygenLpm', 'careLevel', 'documents', 'bitrixLeadId', 'userId', 'status'])(
    'refuses the field %s', (field) => {
      expect(check({ [field]: 'x' }).error).toBe(`${field} is not accepted for Mortal Remains requests`);
    },
  );

  it('refuses a body that is not an object', () => {
    for (const bad of [null, undefined, 'x', 5, []]) expect(validateMortalRequest(bad, { now: NOW }).error).toBeTruthy();
  });
});

describe('the deceased', () => {
  it('needs a name of 2 to 100 characters with a letter, on one line', () => {
    expect(without('patientName').error).toMatch(/patientName/);
    for (const patientName of ['A', '12345', '   ', 'Name\nSecond', 'x'.repeat(101), 5]) expect(check({ patientName }).error).toMatch(/patientName/);
    expect(check({ patientName: 'x'.repeat(100) }).error).toBeUndefined();
    expect(check({ patientName: '  Suresh Kale  ' }).data.patientName).toBe('Suresh Kale');
  });

  it('accepts age 0 and 129, refuses 130 and anything that is not a whole number', () => {
    expect(check({ patientAge: 0 }).data.patientAge).toBe(0);
    expect(check({ patientAge: '0' }).data.patientAge).toBe(0);
    expect(check({ patientAge: 129 }).data.patientAge).toBe(129);
    for (const patientAge of [130, -1, 1.5, '1.5', 'abc', '', null, undefined, '1e2', 1000]) expect(check({ patientAge }).error).toMatch(/patientAge/);
  });

  it('needs Male, Female or Other', () => {
    for (const patientGender of ['', 'M', 'Unknown', undefined, 1]) expect(check({ patientGender }).error).toMatch(/patientGender/);
  });

  it('needs one of the nine relations', () => {
    for (const deceasedRelation of ['', 'Uncle', 'father', undefined, 1]) expect(check({ deceasedRelation }).error).toMatch(/deceasedRelation/);
  });
});

describe('places and length limits (the columns are VARCHAR(191))', () => {
  it.each(['placeOfDeath', 'origin', 'destination'])('%s is required, at most 191 characters, one line', (field) => {
    expect(without(field).error).toMatch(new RegExp(field));
    expect(check({ [field]: '   ' }).error).toMatch(new RegExp(field));
    expect(check({ [field]: 'a'.repeat(191) }).error).toBeUndefined();
    expect(check({ [field]: 'a'.repeat(192) }).error).toBe(`${field} can be at most 191 characters`);
    expect(check({ [field]: 'a\nb' }).error).toMatch(new RegExp(field));
  });

  it('counts an emoji as one character, as MySQL does', () => {
    expect(check({ placeOfDeath: '\u{1F3E5}'.repeat(191) }).error).toBeUndefined();
    expect(check({ placeOfDeath: '\u{1F3E5}'.repeat(192) }).error).toMatch(/placeOfDeath/);
  });

  it('needs a country of at most 100 characters', () => {
    expect(without('country').error).toMatch(/country/);
    expect(check({ country: 'x'.repeat(101) }).error).toMatch(/country/);
  });

  it('copies the current location to the patient location', () => {
    expect(check({ origin: '  Dubai  ' }).data).toMatchObject({ origin: 'Dubai', patientLocation: 'Dubai' });
  });
});

describe('contact number', () => {
  it('needs a valid number with its country code, and stores it in international form', () => {
    expect(check({ patientContact: '+919876543210' }).data.patientContact).toBe('+91 98765 43210');
    expect(check({ patientContact: '+971501234567' }).error).toBeUndefined();
    for (const patientContact of ['9876543210', '+91 12345', '+999 123', 'abc', '', null, undefined, 9876543210]) {
      expect(check({ patientContact }).error).toMatch(/patientContact/);
    }
  });
});

describe('urgency and details', () => {
  it('requires one of the existing urgencies', () => {
    for (const urgency of ['critical_6h', 'urgent_24h', 'planned']) expect(check({ urgency }).data.urgency).toBe(urgency);
    for (const urgency of ['', 'asap', undefined, null, 1]) expect(check({ urgency }).error).toMatch(/urgency/);
  });

  it('takes optional Details and composes the labelled description', () => {
    expect(check({}).data.description).toBe('Transfer Scope: International\nTransport Mode: Private Charter');
    expect(check({ details: '' }).data.description).toBe('Transfer Scope: International\nTransport Mode: Private Charter');
    expect(check({ details: '  Please arrange a hearse.\r\nCall first.  ' }).data.description)
      .toBe('Transfer Scope: International\nTransport Mode: Private Charter\n\nAdditional Details: Please arrange a hearse.\nCall first.');
  });

  it('limits Details to 2,000 characters and refuses non-text and control characters', () => {
    expect(check({ details: 'a'.repeat(2000) }).error).toBeUndefined();
    expect(check({ details: 'a'.repeat(2001) }).error).toBe('details can be at most 2000 characters');
    expect(check({ details: 5 }).error).toMatch(/details/);
    expect(check({ details: 'bad\u0000text' }).error).toMatch(/details/);
  });
});

describe('dates, by the patient\'s own calendar', () => {
  it('calendarDate accepts only real days', () => {
    expect(calendarDate('2026-02-28')).toBe('2026-02-28');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '20261117', '', 'tomorrow', '2026-11-17T00:00:00Z']) expect(calendarDate(bad)).toBeNull();
  });

  it('works out the patient\'s today from the offset', () => {
    expect(patientToday(NOW, 0)).toBe('2026-11-17');
    expect(patientToday(new Date('2026-11-17T20:00:00Z'), 330)).toBe('2026-11-18'); // 01:30 the next day in India
    expect(patientToday(new Date('2026-11-17T03:00:00Z'), -300)).toBe('2026-11-16'); // 22:00 the day before in New York
  });

  it('accepts a date of death of today or earlier and refuses a future one', () => {
    expect(check({ dateOfDeath: '2026-11-17' }).error).toBeUndefined();
    expect(check({ dateOfDeath: '2020-01-01' }).error).toBeUndefined();
    expect(check({ dateOfDeath: '2026-11-18' }).error).toBe('dateOfDeath cannot be in the future');
    expect(check({ dateOfDeath: '2027-01-01' }).error).toMatch(/future/);
  });

  it('accepts a transfer date of today or later and refuses a past one', () => {
    expect(check({ preferredDate: '2026-11-17' }).error).toBeUndefined();
    expect(check({ preferredDate: '2027-05-01' }).error).toBeUndefined();
    expect(check({ preferredDate: '2026-11-16' }).error).toBe('preferredDate cannot be in the past');
  });

  it('refuses a missing, malformed or impossible date', () => {
    for (const field of ['dateOfDeath', 'preferredDate']) {
      expect(without(field).error).toMatch(new RegExp(field));
      for (const bad of ['2026-02-30', '17/11/2026', '', 5, null]) expect(check({ [field]: bad }).error).toMatch(new RegExp(field));
    }
  });

  it('needs a valid UTC offset', () => {
    expect(without('utcOffsetMinutes').error).toMatch(/utcOffsetMinutes/);
    for (const utcOffsetMinutes of [-721, 841, 1.5, '330', null, NaN]) expect(check({ utcOffsetMinutes }).error).toMatch(/utcOffsetMinutes/);
    for (const utcOffsetMinutes of [-720, 0, 330, 840]) expect(check({ utcOffsetMinutes }).error).toBeUndefined();
  });

  // The server clock and the device clock must give the same answer for every offset and every hour: today is accepted, tomorrow (for the
  // patient) as a death date and yesterday (for the patient) as a transfer date are refused.
  it('agrees with the device at every UTC offset and every hour', () => {
    const offsets = [-720, -300, 0, 60, 330, 345, 540, 765, 840];
    for (const utcOffsetMinutes of offsets) {
      for (let hour = 0; hour < 24; hour += 1) {
        const now = new Date(Date.UTC(2026, 10, 17, hour, 15));
        const today = new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10); // the device's own date
        const next = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
        const previous = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
        const result = (extra) => validateMortalRequest(base({ utcOffsetMinutes, ...extra }), { now });
        expect(result({ dateOfDeath: today, preferredDate: today }).error).toBeUndefined();
        expect(result({ dateOfDeath: next, preferredDate: today }).error).toMatch(/dateOfDeath/);
        expect(result({ dateOfDeath: today, preferredDate: previous }).error).toMatch(/preferredDate/);
        expect(result({ dateOfDeath: previous, preferredDate: next }).error).toBeUndefined();
      }
    }
  });
});

describe('the description header', () => {
  it('composeDescription and userDetailsOf round-trip', () => {
    const description = composeDescription({ scope: 'domestic', mode: 'ground_transportation', details: 'Line one\n\nLine two' });
    expect(description).toBe('Transfer Scope: Domestic\nTransport Mode: Ground Transportation\n\nAdditional Details: Line one\n\nLine two');
    expect(userDetailsOf(description)).toBe('Line one\n\nLine two');
  });

  it('returns nothing when there are no Details, and an older description untouched', () => {
    expect(userDetailsOf(composeDescription({ scope: 'domestic', mode: 'private_charter', details: '' }))).toBe('');
    expect(userDetailsOf('Transfer to the hometown for the last rites')).toBe('Transfer to the hometown for the last rites');
    expect(userDetailsOf(null)).toBe('');
    expect(userDetailsOf(undefined)).toBe('');
  });
});

describe('file signatures', () => {
  const bytes = (...values) => Buffer.from([...values, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const samples = {
    pdf: Buffer.from('%PDF-1.4 test'),
    jpeg: bytes(0xff, 0xd8, 0xff, 0xe0),
    png: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]),
    doc: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
    docx: bytes(0x50, 0x4b, 0x03, 0x04),
  };

  it('recognises every allowed kind', () => {
    for (const [kind, buffer] of Object.entries(samples)) expect(detectFileKind(buffer)).toBe(kind);
  });

  it('refuses anything else, including an empty or short file', () => {
    expect(detectFileKind(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileKind(Buffer.from('MZ\u0090\u0000'))).toBeNull();
    expect(detectFileKind(Buffer.alloc(0))).toBeNull();
    expect(detectFileKind(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectFileKind(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVE')]))).toBeNull();
    expect(detectFileKind('not a buffer')).toBeNull();
  });

  it('needs the content, the declared type and the extension to agree', () => {
    expect(contentMatchesDeclared(samples.pdf, 'application/pdf', 'certificate.pdf')).toBe(true);
    expect(contentMatchesDeclared(samples.pdf, 'application/pdf', 'CERTIFICATE.PDF')).toBe(true);
    expect(contentMatchesDeclared(samples.jpeg, 'image/jpeg', 'photo.jpeg')).toBe(true);
    expect(contentMatchesDeclared(samples.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx')).toBe(true);
    // a PDF named .jpg, a script that claims to be a PDF, a PDF declared as an image
    expect(contentMatchesDeclared(samples.pdf, 'application/pdf', 'certificate.jpg')).toBe(false);
    expect(contentMatchesDeclared(Buffer.from('<script>'), 'application/pdf', 'x.pdf')).toBe(false);
    expect(contentMatchesDeclared(samples.pdf, 'image/png', 'x.pdf')).toBe(false);
    expect(contentMatchesDeclared(samples.png, 'image/png', 'no-extension')).toBe(false);
  });
});
