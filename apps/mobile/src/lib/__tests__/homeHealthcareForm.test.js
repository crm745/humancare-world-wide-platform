/* global describe, test, expect, __dirname */
// Home Healthcare Services (key "homecare"): Step 1 (patient, Complete Home Address, Service Date), Step 2 (optional care selections, Medical History,
// optional Medical Reports), the review, the payload the server's validator accepts, the strict description parser (against the same golden vectors as the
// backend parser), the new-format discriminator, and the six display surfaces for new and legacy requests. Every other service keeps its form. (The screens
// are not rendered here: this project's Jest covers lib/ logic and reads screen source, see jest.config.js; the behaviour on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const H = require('../homeHealthcare');
const { draftForService } = require('../requestForm');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { cardView } = require('../myRequestsView');
const { toListItem } = require('../requestShape');
const { trackingItemFromRequest } = require('../trackingItem');
const { buildTrackingDetails } = require('../trackingDetailsView');
const { requestService } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const server = require('../../../../../backend/src/modules/requests/home-healthcare.validation');
const vectors = require('../../../../../backend/tests/fixtures/home-healthcare-vectors.json');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
// The source without its comments: the checks below are about what the code does, not what its comments say.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const tIn = (lang) => (key, values) => {
  const text = (i18n[lang] && i18n[lang][key]) || (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const t = tIn('EN');
const anchors = (source) => [...source.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
const wrong = (problems) => problems.filter(([, bad]) => bad).map(([id]) => id);
const NOW = new Date(2026, 10, 17, 10, 0, 0); // 17 Nov 2026, local
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';

const draft = (extra = {}) => ({
  service: 'homecare', name: 'Asha Nair', age: '61', gender: 'Female', country: 'India', countryIso: 'IN', cc: '+91', phone: '9876543210', phoneCountry: 'IN',
  homeAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', date: '2026-11-20', homeCaretakers: [], homeCareHours: '', homeCareLevel: '', homeOxygen: '', oxygenLpm: '',
  desc: '', files: [], ...extra,
});
const clock = (offset) => ({ getFullYear: () => 2026, getMonth: () => 10, getDate: () => 17, getTimezoneOffset: () => 0 - offset });

describe('identity', () => {
  test('the key, the fixed name (equal to the bundled title and to the server constant) and the submitted key and name', () => {
    expect(H.HOME_SERVICE_KEY).toBe('homecare');
    expect(H.HOME_SERVICE_TYPE).toBe('Home Healthcare Services');
    expect(SERVICES.homecare.title).toBe(H.HOME_SERVICE_TYPE);
    expect(server.HOME_SERVICE_TYPE).toBe(H.HOME_SERVICE_TYPE);
    expect(requestService({ service: 'homecare' }, SERVICES)).toEqual({ title: 'Home Healthcare Services', key: 'homecare' });
    expect(H.isHomeService('homecare')).toBe(true);
    for (const key of ['tele', 'mortal', 'ground', 'homecare_x', '', undefined]) expect(H.isHomeService(key)).toBe(false);
  });
  test('the options are exactly the approved ones, and the same on the server', () => {
    expect(H.CARETAKER_KEYS).toEqual(['nurse', 'caretaker']);
    expect(H.HOURS_KEYS).toEqual(['12_hours', '24_hours']);
    expect(H.LEVEL_KEYS).toEqual(['full_icu', 'semi_icu']);
    expect(Object.keys(server.CARETAKERS)).toEqual(H.CARETAKER_KEYS);
    expect(Object.keys(server.HOURS)).toEqual(H.HOURS_KEYS);
    expect(Object.keys(server.LEVELS)).toEqual(H.LEVEL_KEYS);
    expect(H.LEVEL_KEYS.map((key) => H.LEVEL_STORED[key])).toEqual(H.LEVEL_KEYS.map((key) => server.LEVELS[key]));
    expect(H.GENDERS).toEqual(['Male', 'Female', 'Other']);
    expect(H.TEXT_MAX).toBe(server.TEXT_MAX);
    expect(H.FRAME_MAX).toBe(server.FRAME_MAX);
  });
});

describe('Step 1: the patient, the address and the Service Date', () => {
  test('a complete Step 1 has no problem', () => {
    expect(wrong(H.homeStep1Problems(draft(), NOW))).toEqual([]);
  });
  test('every required field is checked, in page order (the page scrolls to the first)', () => {
    const empty = draft({ name: '', age: '', gender: '', country: '', phone: '', homeAddress: '', date: '' });
    expect(wrong(H.homeStep1Problems(empty, NOW))).toEqual(['name', 'age', 'country', 'phone', 'address', 'date']);
    expect(H.homeStep1Problems(draft(), NOW).map(([id]) => id)).toEqual(anchors(read('components/request/HomeStep1.js')));
  });
  test('age: required, a whole number from 1 to 129 only', () => {
    for (const ok of ['1', '61', '129', ' 7 ']) expect(H.isValidHomeAge(ok)).toBe(true);
    for (const bad of ['', '0', '130', '-1', '1.5', 'abc', '1e2', '061', '0000', null, undefined, 0, 130]) expect(H.isValidHomeAge(bad)).toBe(false);
    expect(wrong(H.homeStep1Problems(draft({ age: '0' }), NOW))).toEqual(['age']);
    expect(wrong(H.homeStep1Problems(draft({ age: '' }), NOW))).toEqual(['age']);
    expect(wrong(H.homeStep1Problems(draft({ gender: 'Unknown' }), NOW))).toEqual(['age']);
  });
  test('the contact number needs the right digits for its country code', () => {
    expect(wrong(H.homeStep1Problems(draft({ phone: '12345' }), NOW))).toEqual(['phone']);
    expect(wrong(H.homeStep1Problems(draft({ cc: '+971', phone: '501234567', phoneCountry: 'AE' }), NOW))).toEqual([]);
  });
  test('the Service Date is today or later by the device\'s calendar; a past day, a typed web value and an impossible day are refused', () => {
    expect(H.isValidServiceDate('2026-11-17', NOW)).toBe(true);
    expect(H.isValidServiceDate('2027-03-01', NOW)).toBe(true);
    for (const bad of ['2026-11-16', '', '2026-02-30', '20/11/2026', 'today', null]) expect(H.isValidServiceDate(bad, NOW)).toBe(false);
    expect(wrong(H.homeStep1Problems(draft({ date: '2026-11-16' }), NOW))).toEqual(['date']);
  });
  test('the Complete Home Address: required (judged on a trimmed copy), at most 2,000 code points, no unsavable characters', () => {
    for (const bad of ['', '   ', '\n\t \n']) expect(wrong(H.homeStep1Problems(draft({ homeAddress: bad }), NOW))).toEqual(['address']);
    expect(wrong(H.homeStep1Problems(draft({ homeAddress: '  Pune  ' }), NOW))).toEqual([]);
    expect(wrong(H.homeStep1Problems(draft({ homeAddress: '\u{1F600}'.repeat(2000) }), NOW))).toEqual([]);
    expect(wrong(H.homeStep1Problems(draft({ homeAddress: '\u{1F600}'.repeat(2001) }), NOW))).toEqual(['address']);
    expect(wrong(H.homeStep1Problems(draft({ homeAddress: 'a\u0000b' }), NOW))).toEqual(['address']);
    expect(wrong(H.homeStep1Problems(draft({ homeAddress: 'a\uD83Db' }), NOW))).toEqual(['address']);
  });
  test('the page has the approved fields in order, and no Current Location, Destination or Urgency', () => {
    const page = read('components/request/HomeStep1.js');
    expect(anchors(page)).toEqual(['name', 'age', 'country', 'phone', 'address', 'date']);
    const source = code('components/request/HomeStep1.js');
    expect(source).not.toMatch(/CityField|field_destination|field_location|urgency|field_mortal|[^e]DateField/);
    expect(page).toContain("t('field_home_address')");
    expect(page).toContain("t('field_service_date')");
  });
});

describe('free text: exactly the character rules of the server', () => {
  test('every control character except TAB, LF and CR is refused; so are NUL and unpaired surrogates; everything else is accepted', () => {
    for (let code = 0; code <= 0x9f; code += 1) {
      const text = `a${String.fromCharCode(code)}b`;
      expect({ code, mobile: H.hasDisallowedControl(text), server: server.hasDisallowedControl(text) }).toEqual({ code, mobile: server.hasDisallowedControl(text), server: server.hasDisallowedControl(text) });
    }
    for (const code of [9, 10, 13]) expect(H.hasDisallowedControl(`a${String.fromCharCode(code)}b`)).toBe(false);
    for (const code of [0, 7, 8, 11, 12, 14, 31, 127, 128, 159]) expect(H.hasDisallowedControl(`a${String.fromCharCode(code)}b`)).toBe(true);
    for (const text of ['a b c', 'a b　c', 'a​b‍c', family, 'café', 'مرحبا', 'తెలుగు', '�', '￿']) {
      expect(H.freeTextProblem(text, { required: true })).toBeNull();
    }
    for (const bad of ['\uD83D', '\uDE00', 'a\uD83Db', 'x\uD83D😀']) {
      expect(H.hasUnpairedSurrogate(bad)).toBe(true);
      expect(H.freeTextProblem(bad, { required: false })).toBe('characters');
      expect(server.hasUnpairedSurrogate(bad)).toBe(true);
    }
    expect(H.hasUnpairedSurrogate('\u{1F600}')).toBe(false);
  });
  test('the patient-facing limit counts code points; the framing counts UTF-16 code units', () => {
    expect(H.codePointLength('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2);
    expect(H.codePointLength(family)).toBe(5);
    expect(family.length).toBe(8);
    expect(H.freeTextProblem('\u{1F600}'.repeat(2000), { required: false })).toBeNull();
    expect(H.freeTextProblem('\u{1F600}'.repeat(2001), { required: false })).toBe('too_long');
    expect(H.freeTextProblem('', { required: true })).toBe('required');
    expect(H.freeTextProblem('   ', { required: true })).toBe('required');
    expect(H.freeTextProblem('   ', { required: false })).toBeNull();
  });
});

describe('Step 2: every care selection is optional', () => {
  test('a form with nothing answered has no problem; Medical History and reports are optional', () => {
    expect(wrong(H.homeStep2Problems(draft()))).toEqual([]);
    expect(wrong(H.homeStep2Problems(draft({ desc: '' })))).toEqual([]);
    expect(wrong(H.homeStep2Problems(draft({ files: [] })))).toEqual([]);
  });
  test('the flow rate is required only when Oxygen is Yes', () => {
    expect(wrong(H.homeStep2Problems(draft({ homeOxygen: 'yes', oxygenLpm: '' })))).toEqual(['oxygenLpm']);
    expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: '' }))).toBe('required');
    expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: '  ' }))).toBe('required');
    expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: '16' }))).toBe('invalid');
    expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: '0' }))).toBe('invalid');
    expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: '2.55' }))).toBe('invalid');
    for (const lpm of ['4', '2.5', '0.5', '15', '2,5']) expect(H.homeOxygenProblem(draft({ homeOxygen: 'yes', oxygenLpm: lpm }))).toBeNull();
    for (const homeOxygen of ['no', '', undefined]) {
      expect(H.homeOxygenProblem(draft({ homeOxygen, oxygenLpm: '' }))).toBeNull();
      expect(wrong(H.homeStep2Problems(draft({ homeOxygen, oxygenLpm: '' })))).toEqual([]);
    }
    expect(H.OXYGEN_LPM_MAX).toBe(15);
  });
  test('Medical History: at most 2,000 code points and no unsavable characters', () => {
    expect(wrong(H.homeStep2Problems(draft({ desc: 'x'.repeat(2000) })))).toEqual([]);
    expect(wrong(H.homeStep2Problems(draft({ desc: 'x'.repeat(2001) })))).toEqual(['history']);
    expect(wrong(H.homeStep2Problems(draft({ desc: 'a\u0007b' })))).toEqual(['history']);
  });
  test('the page: the four care selections, then Medical History, then the reports; no urgency, no transport fields', () => {
    const page = read('components/request/HomeStep2.js');
    expect(anchors(page)).toEqual(['caretaker', 'hours', 'level', 'oxygen', 'oxygenLpm', 'history', 'files']);
    expect(code('components/request/HomeStep2.js')).not.toMatch(/req_urgency|URGENCY|mobility|crit_|care_icu|CARE_LEVELS|equipCardiac|equipVentilator|Shift|Duration/i);
    // the four care selections carry no "required" marker
    for (const id of ['caretaker', 'hours', 'level', 'oxygen']) expect(page).toMatch(new RegExp(`<Anchor id="${id}">\\s*<FieldHeader title=\\{t\\('[a-z_]+'\\)\\} />`));
    // Care Requirement, Care Level and Oxygen can be cleared; Nurse / Caretaker is a multi-select
    expect(page).toMatch(/clearable columns=\{2\} label=\{t\('field_care_requirement'\)\}/);
    expect(page).toMatch(/clearable columns=\{2\} label=\{t\('field_home_care_level'\)\}/);
    expect(page).toMatch(/multiple columns=\{2\} label=\{t\('field_caretaker'\)\}/);
    expect(page).toContain("title={t('req_medical_history')}");
    expect(page).toContain('<ReportTiles');
    expect((page.match(/<ReportTiles/g) || []).length).toBe(1);
    // the flow rate is only drawn (and only cleared by anything else) while Oxygen is Yes
    expect(page).toContain("{draft.homeOxygen === 'yes' && (");
    expect(page).toContain("homeOxygen === 'yes' ? { homeOxygen } : { homeOxygen, oxygenLpm: '' }");
  });
  test('the shared upload limits apply: 10 files of 10 MB', () => {
    const mock = read('data/mock.js');
    expect(mock).toContain('export const MAX_REPORT_FILES = 10;');
    expect(mock).toContain('export const MAX_REPORT_BYTES = 10 * 1024 * 1024;');
    expect(read('components/request/fields.js')).toContain('maxFiles = MAX_REPORT_FILES');
  });
});

describe('the payload', () => {
  test('the approved example, exactly', () => {
    const d = draft({
      homeCaretakers: ['nurse', 'caretaker'], homeCareHours: '12_hours', homeCareLevel: 'full_icu', homeOxygen: 'yes', oxygenLpm: '4', desc: 'Post-operative, needs wound care.',
    });
    expect(H.buildHomePayload(d, clock(330))).toEqual({
      serviceType: 'Home Healthcare Services',
      serviceKey: 'homecare',
      patientName: 'Asha Nair',
      patientAge: 61,
      patientGender: 'Female',
      country: 'India',
      patientContact: '+91 98765 43210',
      homeAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
      preferredDate: '2026-11-20',
      utcOffsetMinutes: 330,
      caretakerTypes: ['nurse', 'caretaker'],
      careRequirement: '12_hours',
      careLevel: 'full_icu',
      equipOxygen: true,
      equipOxygenLpm: 4,
      medicalHistory: 'Post-operative, needs wound care.',
    });
  });
  test('unanswered selections are left out; Oxygen No sends false and no flow rate; Oxygen Yes sends the number', () => {
    const none = H.buildHomePayload(draft(), clock(0));
    for (const key of ['caretakerTypes', 'careRequirement', 'careLevel', 'equipOxygen', 'equipOxygenLpm', 'medicalHistory']) expect(none).not.toHaveProperty(key);
    expect(H.buildHomePayload(draft({ homeOxygen: 'no', oxygenLpm: '9' }), clock(0))).toMatchObject({ equipOxygen: false });
    expect(H.buildHomePayload(draft({ homeOxygen: 'no', oxygenLpm: '9' }), clock(0))).not.toHaveProperty('equipOxygenLpm');
    expect(H.buildHomePayload(draft({ homeOxygen: 'yes', oxygenLpm: '2,5' }), clock(0))).toMatchObject({ equipOxygen: true, equipOxygenLpm: 2.5 });
    expect(H.buildHomePayload(draft({ homeCaretakers: ['caretaker'] }), clock(0)).caretakerTypes).toEqual(['caretaker']);
    expect(H.buildHomePayload(draft({ homeCaretakers: ['caretaker', 'nurse'] }), clock(0)).caretakerTypes).toEqual(['nurse', 'caretaker']);
  });
  test('the address and Medical History are sent exactly as typed (never trimmed); a whitespace-only history is not sent', () => {
    const typed = '  a\r\n b\t\u{1F600} ';
    const payload = H.buildHomePayload(draft({ homeAddress: typed, desc: typed }), clock(0));
    expect(payload.homeAddress).toBe(typed);
    expect(payload.medicalHistory).toBe(typed);
    expect(H.buildHomePayload(draft({ desc: '  \n ' }), clock(0))).not.toHaveProperty('medicalHistory');
  });
  test('no description, origin, destination, urgency, location or transport field is ever sent', () => {
    const keys = Object.keys(H.buildHomePayload(draft({ homeCaretakers: ['nurse'], homeCareHours: '24_hours', homeCareLevel: 'semi_icu', homeOxygen: 'yes', oxygenLpm: '4', desc: 'x' }), clock(0)));
    for (const forbidden of ['description', 'origin', 'destination', 'patientLocation', 'urgency', 'mobility', 'equipCardiacMonitor', 'equipVentilator', 'files', 'careLevelKeys']) expect(keys).not.toContain(forbidden);
  });
  test('the offset is minutes EAST of UTC, never -0, and read from the moment the request is built', () => {
    const sent = (jsOffset) => H.buildHomePayload(draft(), { getTimezoneOffset: () => jsOffset }).utcOffsetMinutes;
    expect(sent(-330)).toBe(330);
    expect(sent(300)).toBe(-300);
    expect(Object.is(sent(0), 0)).toBe(true);
    expect(H.buildHomePayload(draft()).utcOffsetMinutes).toBe(0 - new Date().getTimezoneOffset());
    expect(read('lib/homeHealthcare.js')).toContain('utcOffsetMinutes: 0 - now.getTimezoneOffset(),');
  });
  test('the server accepts what the phone sends, for every combination of the care selections', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    let combos = 0;
    for (const homeCaretakers of [[], ['nurse'], ['caretaker'], ['nurse', 'caretaker']]) {
      for (const homeCareHours of ['', '12_hours', '24_hours']) {
        for (const homeCareLevel of ['', 'full_icu', 'semi_icu']) {
          for (const [homeOxygen, oxygenLpm] of [['', ''], ['no', ''], ['yes', '4'], ['yes', '2.5']]) {
            const payload = H.buildHomePayload(draft({ homeCaretakers, homeCareHours, homeCareLevel, homeOxygen, oxygenLpm, desc: combos % 2 ? 'History' : '' }), clock(0));
            const { error, data } = server.validateHomeRequest(payload, { now });
            expect({ combo: combos, error }).toEqual({ combo: combos, error: undefined });
            // and the new-format description the server composes is parsed by BOTH parsers to the same text
            expect(H.parseHomeDescription(data.description).ok).toBe(true);
            combos += 1;
          }
        }
      }
    }
    expect(combos).toBe(4 * 3 * 3 * 4);
  });
  test('the phone and the server agree on the Service Date at every offset and hour', () => {
    const device = (instant, offset) => {
      const local = new Date(Date.parse(instant) + offset * 60000);
      return { getFullYear: () => local.getUTCFullYear(), getMonth: () => local.getUTCMonth(), getDate: () => local.getUTCDate(), getTimezoneOffset: () => 0 - offset };
    };
    for (const hour of [0, 3, 9, 12, 15, 18, 21, 23]) {
      const instant = `2026-11-17T${String(hour).padStart(2, '0')}:20:00Z`;
      for (const offset of [-720, -480, -210, 0, 330, 345, 540, 840]) {
        const phone = device(instant, offset);
        const today = H.todayString(phone);
        const yesterday = H.todayString(device(new Date(Date.parse(instant) - 86400000).toISOString(), offset));
        const asked = (date) => ({
          phone: wrong(H.homeStep1Problems(draft({ date }), phone)), server: server.validateHomeRequest(H.buildHomePayload(draft({ date }), phone), { now: new Date(instant) }).error,
        });
        expect({ instant, offset, ...asked(today) }).toEqual({ instant, offset, phone: [], server: undefined });
        expect({ instant, offset, phone: asked(yesterday).phone, server: Boolean(asked(yesterday).server) }).toEqual({ instant, offset, phone: ['date'], server: true });
      }
    }
  });
});

describe('the description parser: golden vectors shared with the backend', () => {
  test.each(vectors.valid.map((v) => [v.name, v]))('%s: recovered exactly, identical to the backend parser', (_name, vector) => {
    const parsed = H.parseHomeDescription(vector.description);
    expect(parsed).toEqual({ ok: true, address: vector.address, history: vector.history, care: vector.care });
    expect(parsed).toEqual(server.parseHomeDescription(vector.description));
  });
  test.each(vectors.invalid.map((v) => [v.name, v]))('%s: refused by both parsers, never thrown', (_name, vector) => {
    expect(H.parseHomeDescription(vector.text)).toEqual({ ok: false });
    expect(server.parseHomeDescription(vector.text)).toEqual({ ok: false });
    expect(H.isNewHomeRequest({ serviceKey: 'homecare', description: vector.text })).toBe(false);
  });
  test('the parsers agree on random corruptions of valid documents', () => {
    let seed = 987654;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 1500; i += 1) {
      const doc = vectors.valid[Math.floor(random() * vectors.valid.length)].description;
      if (doc.length > 600) continue;
      const at = Math.floor(random() * doc.length);
      const mutated = [doc.slice(0, at), doc.slice(at + 1), doc.slice(0, at) + 'x' + doc.slice(at), doc.slice(0, at) + doc.slice(at + 1) + 'y'][Math.floor(random() * 4)];
      expect(H.parseHomeDescription(mutated)).toEqual(server.parseHomeDescription(mutated));
    }
  });
});

describe('new and legacy requests', () => {
  const description = server.composeHomeDescription({ care: { caretakerTypes: ['nurse', 'caretaker'], careRequirement: '12_hours', careLevel: 'full_icu', equipOxygen: true, equipOxygenLpm: 4 }, address: 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n', history: '  Post-op.\n\nNeeds wound care \u{1F3E5} ' });
  const NEW = {
    id: 11, referenceNumber: 'REQ-1011', status: 'submitted', createdAt: '2026-11-17T09:00:00.000Z', serviceType: 'Home Healthcare Services', serviceKey: 'homecare', patientName: 'Asha Nair',
    patientAge: 61, patientGender: 'Female', country: 'India', patientContact: '+91 98765 43210', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', patientLocation: 'Flat 4B, Rose Villa, MG Road, Pune 411001',
    destination: '', preferredDate: '2026-11-20T00:00:00.000Z', urgency: null, careRequirement: '12_hours', caretakerTypes: 'nurse,caretaker', careLevel: 'Full ICU', equipOxygen: true, equipOxygenLpm: 4,
    description, case: { id: 5, documents: [{ id: 1, type: 'Medical Report', name: 'discharge.pdf', fileSizeBytes: 2048, uploadedAt: '2026-11-17T09:30:00.000Z' }], stageEvents: [] },
  };
  const LEGACY = {
    ...NEW, id: 3, referenceNumber: 'REQ-1003', origin: 'Pune', patientLocation: 'Pune', destination: 'Mumbai', urgency: 'planned', description: 'Needs a nurse for post-surgery care.',
    careRequirement: null, caretakerTypes: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null,
  };

  test('new-format means the key homecare AND a complete valid v1 description; the destination is never consulted', () => {
    expect(H.isNewHomeRequest(NEW)).toBe(true);
    expect(H.isNewHomeRequest({ ...NEW, destination: 'Mumbai' })).toBe(true);
    expect(H.isNewHomeRequest(LEGACY)).toBe(false);
    expect(H.isNewHomeRequest({ ...LEGACY, destination: '' })).toBe(false);
    expect(H.isNewHomeRequest({ ...NEW, serviceKey: 'ground' })).toBe(false);
    expect(H.isNewHomeRequest({ ...NEW, description: description.slice(0, -2) })).toBe(false);
    expect(H.isNewHomeRequest({ ...NEW, description: null })).toBe(false);
    expect(H.isNewHomeRequest({ ...NEW, description: 'Home Healthcare v1 is what I need' })).toBe(false);
    expect(H.isNewHomeRequest(null)).toBe(false);
    expect(H.isNewHomeRequest(undefined)).toBe(false);
    expect(code('lib/homeHealthcare.js')).not.toMatch(/destination/);
  });

  test('Review: the patient, the exact address, the Service Date, only the answered care rows, and Medical History; no trip, no urgency', () => {
    const d = draft({
      homeAddress: 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n', homeCaretakers: ['nurse', 'caretaker'], homeCareHours: '12_hours', homeCareLevel: 'full_icu', homeOxygen: 'yes', oxygenLpm: '4',
      desc: '  Post-op.\n\nNeeds wound care ', files: [{ uri: 'file:///x/discharge.pdf', name: 'discharge.pdf', mimeType: 'application/pdf', size: 2048 }],
    });
    const v = reviewView(d, { key: 'homecare', title: 'Home Healthcare Services' }, t);
    expect(v.patient.titleKey).toBe('rd_patient');
    expect(v.patient.fields.map((f) => [f.key, f.value])).toEqual([
      ['name', 'Asha Nair'], ['age', '61'], ['gender', 'Female'], ['country', 'India'], ['contact', '+91 98765 43210'],
      ['address', 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n'], ['serviceDate', '20 Nov 2026'],
    ]);
    expect(v.patient.fields.find((f) => f.key === 'address').label).toBe('Complete Home Address');
    expect(v.patient.fields.find((f) => f.key === 'serviceDate').label).toBe('Service Date');
    expect(v.medical.details.map((r) => [r.key, r.label, r.value])).toEqual([
      ['caretaker', 'Nurse / Caretaker', 'Nurse, Caretaker'], ['hours', 'Care Requirement', '12 Hours'], ['careLevel', 'Care Level', 'Full ICU'], ['oxygen', 'Oxygen', 'Oxygen (4 LPM)'],
    ]);
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('  Post-op.\n\nNeeds wound care ');
    expect(v.medical.urgency).toBeNull();
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
    expect(v.show).toMatchObject({ patient: true, trip: false, medical: true, documents: true });
    expect(v.documents.map((x) => x.name)).toEqual(['discharge.pdf']);
  });
  test('Review: nothing answered shows no care rows; Oxygen No shows "No"; Medical History and reports are left out when empty', () => {
    const v = reviewView(draft(), { key: 'homecare', title: 'Home Healthcare Services' }, t);
    expect(v.medical.details).toEqual([]);
    expect(v.medical.condition).toBe('');
    expect(v.show).toMatchObject({ trip: false, medical: false, documents: false });
    expect(reviewView(draft({ homeOxygen: 'no' }), { key: 'homecare', title: 'x' }, t).medical.details.map((r) => [r.key, r.value])).toEqual([['oxygen', 'No']]);
    expect(reviewView(draft({ desc: '   ' }), { key: 'homecare', title: 'x' }, t).medical.condition).toBe('');
  });
  test('every field of the draft that Home Healthcare collects is accounted for, and the transport ones are not', () => {
    const fields = fieldsFor('homecare');
    for (const key of ['homeAddress', 'homeCaretakers', 'homeCareHours', 'homeCareLevel', 'homeOxygen', 'oxygenLpm', 'date', 'desc', 'files', 'name', 'age', 'gender', 'phone', 'cc', 'country']) {
      expect({ key, accounted: key in fields }).toEqual({ key, accounted: true });
    }
    for (const gone of ['location', 'dest', 'urgency']) expect(fields).not.toHaveProperty(gone);
  });

  test('Request Details: a new request shows the exact address, the Service Date, the care rows from the columns and Medical History from the parsed description; no trip, no urgency', () => {
    const v = detailsView(NEW, t);
    expect(v.patient.fields.find((f) => f.key === 'address')).toMatchObject({ label: 'Complete Home Address', value: 'Flat 4B, Rose Villa  \r\nMG Road, Pune 411001\n', full: true });
    expect(v.patient.fields.find((f) => f.key === 'serviceDate')).toMatchObject({ label: 'Service Date', value: '20 Nov 2026' });
    expect(v.medical.details.map((r) => [r.key, r.value])).toEqual([['caretaker', 'Nurse, Caretaker'], ['hours', '12 Hours'], ['careLevel', 'Full ICU'], ['oxygen', 'Oxygen (4 LPM)']]);
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('  Post-op.\n\nNeeds wound care \u{1F3E5} ');
    expect(v.medical.urgency).toBeNull();
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
    expect(v.showDocuments).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/Home Healthcare v1|address \d+, history/);
  });
  test('Request Details: a request with nothing answered shows neither care rows nor Medical History', () => {
    const bare = { ...NEW, careRequirement: null, caretakerTypes: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null, description: server.composeHomeDescription({ care: {}, address: 'Pune', history: '' }) };
    const v = detailsView(bare, t);
    expect(v.medical.details).toEqual([]);
    expect(v.medical.condition).toBe('');
    expect(detailsView({ ...bare, equipOxygen: false }, t).medical.details.map((r) => [r.key, r.value])).toEqual([['oxygen', 'No']]);
  });
  test('Request Details: a legacy request keeps its trip, urgency and "Condition & diagnosis" exactly as before', () => {
    const v = detailsView(LEGACY, t);
    expect(v.trip.from).toBe('Pune');
    expect(v.trip.to).toBe('Mumbai');
    expect(v.medical.conditionLabel).toBe('Condition & diagnosis');
    expect(v.medical.condition).toBe('Needs a nurse for post-surgery care.');
    expect(v.medical.urgency).toBeTruthy();
    expect(v.patient.fields.map((f) => f.key)).not.toContain('address');
    // and the same for a request whose v1 text is corrupted: legacy, never partial
    const corrupted = detailsView({ ...NEW, description: description.slice(0, -3) }, t);
    expect(corrupted.medical.conditionLabel).toBe('Condition & diagnosis');
    expect(corrupted.patient.fields.map((f) => f.key)).not.toContain('serviceDate');
  });

  test('My Requests: a new request\'s card has no route; a legacy one keeps it; no other service\'s item changes', () => {
    const newItem = toListItem(NEW);
    expect(newItem.homeFormat).toBe(true);
    expect(toListItem(LEGACY).homeFormat).toBe(false);
    expect(toListItem({ ...NEW, serviceKey: 'ground', serviceType: 'Ground Ambulance' })).not.toHaveProperty('homeFormat');
    expect(toListItem({ ...NEW, serviceKey: 'tele', serviceType: 'Tele Consultation & House Call' })).not.toHaveProperty('homeFormat');
    expect(cardView(newItem, t).route).toBeNull();
    expect(cardView(newItem, t).label).not.toContain('Rose Villa');
    expect(cardView(toListItem(LEGACY), t).route).toEqual({ from: 'Pune', to: 'Mumbai' });
    expect(cardView(newItem, t).name).toBe('Home Healthcare Services');
    expect(cardView(newItem, t).sub).toMatch(/^REQ-1011/);
  });
  test('Tracking: a new request is flagged, shows its home address and no route; a legacy one keeps From and To', () => {
    expect(trackingItemFromRequest({ ...NEW, case: null }).homeHealthcare).toBe(true);
    expect(trackingItemFromRequest({ ...LEGACY, case: null }).homeHealthcare).toBe(false);
    expect(buildTrackingDetails({ ...NEW, case: null }, t)).toMatchObject({ from: '', to: '', hasRoute: false });
    expect(buildTrackingDetails({ ...LEGACY, case: null }, t)).toMatchObject({ from: 'Pune', to: 'Mumbai', hasRoute: true });
    const screen = read('app/tracking.js');
    expect(screen).toContain('item.homeHealthcare ? (');
    expect(screen).toContain("label={t('field_home_address')} value={item.origin}");
    expect(screen).toContain("label={t('lbl_to')} value={item.destination}");
  });
  test('Share is gone from Request Details, and with it the helper that only it used', () => {
    expect(H.homeShareLine).toBeUndefined();
    expect(read('app/request-details.js')).not.toMatch(/homeShareLine|isNewHomeRequest|Share\.share|Share2/);
  });
  test('the care rows read in the app\'s language', () => {
    const hi = tIn('HI');
    const care = H.homeCareFromRequest(NEW, hi);
    expect(care.caretakers).toBe(`${i18n.HI.caretaker_nurse}, ${i18n.HI.caretaker_caretaker}`);
    expect(care.hours).toBe(i18n.HI.care_hours_12);
    expect(care.level).toBe(i18n.HI.home_level_full_icu);
    expect(care.oxygen).toBe(i18n.HI.home_oxygen_lpm_value.replace('{{n}}', '4'));
    expect(H.homeCareFromRequest({ equipOxygen: false }, t).oxygen).toBe('No');
    expect(H.homeCareFromRequest({}, t)).toEqual({ caretakers: null, hours: null, level: null, oxygen: null });
  });
});

describe('the draft, the submit and the service swap', () => {
  const INITIAL = { service: '', name: '', date: '', desc: '', files: [], oxygenLpm: '', homeAddress: '', homeCaretakers: [], homeCareHours: '', homeCareLevel: '', homeOxygen: '', urgency: '', care: [], mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false };
  test('starting a request gives an empty form: no care selection preselected', () => {
    expect(draftForService({ changingService: false }, 'homecare', INITIAL)).toMatchObject({ service: 'homecare', homeAddress: '', homeCaretakers: [], homeCareHours: '', homeCareLevel: '', homeOxygen: '' });
    const src = read('state/AppContext.js');
    for (const key of ['homeAddress', 'homeCaretakers', 'homeCareHours', 'homeCareLevel', 'homeOxygen']) expect(src).toContain(`${key}:`);
  });
  test('swapping away from Home Healthcare clears its answers and keeps the shared ones', () => {
    const swapped = draftForService({ ...INITIAL, ...draft({ homeCaretakers: ['nurse'], homeCareHours: '24_hours', homeCareLevel: 'semi_icu', homeOxygen: 'yes', oxygenLpm: '4' }), changingService: true }, 'hospital', INITIAL);
    expect(swapped).toMatchObject({ service: 'hospital', homeAddress: '', homeCaretakers: [], homeCareHours: '', homeCareLevel: '', homeOxygen: '', oxygenLpm: '', name: 'Asha Nair' });
  });
  test('the submit goes through the Home Healthcare payload, and the reports upload like any other service\'s', () => {
    const review = read('app/request/review.js');
    expect(review).toContain("isHomeService(d.service) ? await apiPost('/requests', buildHomePayload(d))");
    expect(review).toContain("await apiUpload(`/requests/me/${request.id}/documents`");
    expect(read('lib/privateCharter.js')).not.toMatch(/homecare/);
  });
  test('the wrappers hand off only "homecare"; every other service keeps its page', () => {
    const step1 = read('app/request/step1.js');
    const step2 = read('app/request/step2.js');
    expect(step1).toContain('if (isHomeService(draft.service)) return <HomeStep1 />;');
    expect(step2).toContain('if (isHomeService(draft.service)) return <HomeStep2 />;');
    expect(step1).toContain('if (isMortalService(draft.service)) return <MortalStep1 />;');
    expect(step1).toContain('isTeleService(draft.service) ? <TeleStep1 /> : <GenericStep1 />');
    expect(step2).toContain('isTeleService(draft.service) ? <TeleStep2 /> : <GenericStep2 />');
  });
  test('Home Healthcare is isolated: it imports nothing from the Teleconsultation or Mortal Remains libraries', () => {
    for (const file of ['lib/homeHealthcare.js', 'components/request/HomeStep1.js', 'components/request/HomeStep2.js', 'components/request/HomeDateField.js']) {
      expect({ file, imports: /from '[^']*(teleConsultation|mortalRemains|TeleStep|MortalStep|VisitDateField|MortalDateField)[^']*'/.test(read(file)) }).toEqual({ file, imports: false });
    }
    expect(read('../../../backend/src/modules/requests/home-healthcare.validation.js')).not.toMatch(/require\('\.\/(tele-consultation|mortal-remains)/);
  });
});

describe('translations: all six languages', () => {
  const NEW_KEYS = [
    'field_home_address', 'field_home_address_placeholder', 'field_service_date', 'req_medical_history', 'req_medical_history_placeholder', 'field_caretaker', 'caretaker_nurse', 'caretaker_caretaker',
    'field_care_requirement', 'care_hours_12', 'care_hours_24', 'field_home_care_level', 'home_level_full_icu', 'home_level_semi_icu', 'answer_yes', 'answer_no', 'home_err_age', 'home_err_service_date',
    'home_err_too_long', 'home_err_text_chars', 'home_oxygen_lpm', 'home_oxygen_lpm_placeholder', 'home_oxygen_lpm_required', 'home_oxygen_lpm_invalid', 'home_oxygen_lpm_value',
  ];
  test('every new string exists in all six languages, and the five others are real translations (not the English text)', () => {
    for (const key of NEW_KEYS) {
      expect({ key, en: typeof i18n.EN[key] === 'string' && i18n.EN[key].length > 0 }).toEqual({ key, en: true });
      for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
        expect({ key, lang, ok: typeof i18n[lang][key] === 'string' && i18n[lang][key].trim().length > 0 && i18n[lang][key] !== i18n.EN[key] }).toEqual({ key, lang, ok: true });
      }
    }
  });
  test('placeholders are kept in every language', () => {
    const placeholders = { home_err_age: ['{{min}}', '{{max}}'], home_err_too_long: ['{{max}}'], home_oxygen_lpm_invalid: ['{{max}}'], home_oxygen_lpm_value: ['{{n}}'] };
    for (const [key, tokens] of Object.entries(placeholders)) for (const lang of LANGS) for (const token of tokens) expect({ key, lang, has: i18n[lang][key].includes(token) }).toEqual({ key, lang, has: true });
  });
  test('the approved wording in English', () => {
    expect(i18n.EN.field_home_address).toBe('Complete Home Address');
    expect(i18n.EN.field_service_date).toBe('Service Date');
    expect(i18n.EN.req_medical_history).toBe('Medical History');
    expect(i18n.EN.field_caretaker).toBe('Nurse / Caretaker');
    expect([i18n.EN.caretaker_nurse, i18n.EN.caretaker_caretaker]).toEqual(['Nurse', 'Caretaker']);
    expect([i18n.EN.care_hours_12, i18n.EN.care_hours_24]).toEqual(['12 Hours', '24 Hours']);
    expect([i18n.EN.home_level_full_icu, i18n.EN.home_level_semi_icu]).toEqual(['Full ICU', 'Semi ICU']);
    expect(i18n.EN.field_care_requirement).toBe('Care Requirement');
    expect(i18n.EN.field_home_care_level).toBe('Care Level');
  });
});

describe('other services are untouched', () => {
  test('a Home Healthcare answer never leaks into another service\'s review', () => {
    const v = reviewView(draft({ service: 'hospital', homeCaretakers: ['nurse'], homeOxygen: 'yes' }), { key: 'hospital', title: 'Hospital Assistance' }, t);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('serviceDate');
    expect(v.medical.details).toEqual([]);
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
  });
  test('the generic requests, tele and mortal keep their own cards, details and tracking', () => {
    const ground = { id: 'REQ-1', serviceKey: 'ground', serviceType: 'Ground Ambulance', status: 'submitted', rawStatus: 'submitted', display: '17 Nov 2026', origin: 'Pune', destination: 'Mumbai' };
    expect(cardView(ground, t).route).toEqual({ from: 'Pune', to: 'Mumbai' });
    expect(trackingItemFromRequest({ id: 1, referenceNumber: 'REQ-1', serviceType: 'Ground Ambulance', serviceKey: 'ground', status: 'submitted', patientName: 'A', origin: 'Pune', destination: 'Mumbai', case: null }).homeHealthcare).toBe(false);
  });
});
