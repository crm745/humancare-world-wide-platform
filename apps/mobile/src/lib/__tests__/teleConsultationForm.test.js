/* global describe, test, expect, __dirname */
// Teleconsultation ("Tele Consultation & House Call", key "tele"): Scope + Consultation Type (four combinations), the patient and a multiline Current
// Address, then the medical details (both notes optional, a Preferred Visit Date for a House Call only, tomorrow or later), the review page, the payload,
// no uploads, and older requests. Every other service keeps its form. (The screens are not rendered here: this project's Jest covers lib/ logic and
// reads screen source, see jest.config.js; the behaviour on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const T = require('../teleConsultation');
const { draftForService } = require('../requestForm');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { cardView } = require('../myRequestsView');
const { trackingItemFromRequest } = require('../trackingItem');
const { buildTrackingDetails } = require('../trackingDetailsView');
const { liveSlugFor, detailContent } = require('../serviceLookup');
const { requestService } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const anchors = (source) => [...source.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
const NOW = new Date(2026, 10, 16, 10, 0, 0); // 16 Nov 2026, local

const draft = (extra = {}) => ({
  service: 'tele', teleScope: 'international', teleType: 'house_call', name: 'Asha Nair', age: '61', gender: 'Female', country: 'India', countryIso: 'IN',
  cc: '+91', phone: '9876543210', phoneCountry: 'IN', address: 'Flat 4B, Rose Villa\nMG Road, Pune 411001', desc: 'Fever and cough for three days.',
  allergies: 'Penicillin.', date: '2026-11-25', files: [], urgency: '', ...extra,
});
const wrong = (problems) => problems.filter(([, bad]) => bad).map(([id]) => id);

describe('identity', () => {
  test('the service key, name and Bitrix-facing title are unchanged; one key serves all four combinations', () => {
    expect(T.TELE_SERVICE_KEY).toBe('tele');
    expect(T.TELE_SERVICE_TYPE).toBe('Tele Consultation & House Call');
    expect(SERVICES.tele.title).toBe(T.TELE_SERVICE_TYPE);
    for (const scope of T.TELE_SCOPES) for (const type of T.TELE_TYPES) {
      expect(requestService({ service: 'tele', teleScope: scope, teleType: type }, SERVICES)).toEqual({ title: 'Tele Consultation & House Call', key: 'tele' });
    }
  });
  test('only the key "tele" is Teleconsultation', () => {
    expect(T.isTeleService('tele')).toBe(true);
    for (const key of ['teleconsultation', 'tele_domestic', 'air', 'ground', 'homecare', 'privatecharter', 'commercialair', undefined]) expect(T.isTeleService(key)).toBe(false);
  });
});

describe('Step 1: Scope and Consultation Type', () => {
  test('the options, exactly, with their words', () => {
    expect(T.TELE_SCOPES).toEqual(['domestic', 'international']);
    expect(T.TELE_TYPES).toEqual(['online', 'house_call']);
    expect(T.TELE_SCOPES.map((k) => t(T.TELE_SCOPE_LABEL_KEYS[k]))).toEqual(['Domestic', 'International']);
    expect(T.TELE_TYPES.map((k) => t(T.TELE_TYPE_LABEL_KEYS[k]))).toEqual(['Online Consultation (Video/Audio)', 'House Call']);
  });
  test('neither is preselected', () => {
    const src = read('state/AppContext.js');
    expect(src).toMatch(/teleScope: '',/);
    expect(src).toMatch(/teleType: '',/);
  });
  // The Consultation Type comes first because the Scope depends on it: a House Call asks the Scope (required), an Online Consultation has none.
  test('the Type is always required; the Scope is required for a House Call only', () => {
    expect(wrong(T.teleStep1Problems(draft({ teleScope: '', teleType: '' })))).toEqual(['type']);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'house_call', teleScope: '' })))).toEqual(['scope']);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'house_call', teleScope: 'both' })))).toEqual(['scope']);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'online', teleScope: '' })))).toEqual([]);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'online', teleScope: undefined })))).toEqual([]);
  });
  test.each([['domestic', 'house_call'], ['international', 'house_call'], ['', 'online'], ['domestic', 'online']])('scope %p + %s: a complete Step 1 has no problem', (scope, type) => {
    expect(wrong(T.teleStep1Problems(draft({ teleScope: scope, teleType: type })))).toEqual([]);
  });
  test('the Scope is asked for a House Call only', () => {
    expect(T.asksScope({ teleType: 'house_call' })).toBe(true);
    for (const teleType of ['online', '', undefined]) expect(T.asksScope({ teleType })).toBe(false);
    expect(T.asksScope(undefined)).toBe(false);
    const page = read('components/request/TeleStep1.js');
    expect(page).toContain('{asksScope(draft) && (');
  });
  test('Country and Contact Number stay required for an Online Consultation', () => {
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'online', teleScope: '', country: '' })))).toEqual(['country']);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'online', teleScope: '', phone: '' })))).toEqual(['phone']);
    expect(wrong(T.teleStep1Problems(draft({ teleType: 'online', teleScope: '', phone: '12345' })))).toEqual(['phone']);
  });
  test('the page: Type, then (House Call only) Scope, Name, Age and Gender, Country, Contact, Current Address, with no trip or date fields', () => {
    const page = read('components/request/TeleStep1.js');
    expect(anchors(page)).toEqual(['type', 'scope', 'name', 'age', 'country', 'phone', 'address']);
    // the problems are listed in page order too, so the page scrolls to the first
    expect(T.teleStep1Problems(draft({ teleType: 'house_call' })).map(([id]) => id)).toEqual(anchors(page));
    expect(page).not.toMatch(/CityField|field_destination|field_location|DateField|field_preferred_date|urgency|ReportTiles|careLevel|CARE_LEVELS|equip/i);
    expect(page).toContain('<ChoiceChips');
  });
  test('choosing an Online Consultation drops a visit date and a Scope picked for a House Call', () => {
    expect(read('components/request/TeleStep1.js')).toContain("updateDraft(teleType === 'online' ? { teleType, date: '', teleScope: '' } : { teleType })");
  });
});

describe('Step 1: the patient', () => {
  test('name, gender, country and contact are required', () => {
    expect(wrong(T.teleStep1Problems(draft({ name: '' })))).toEqual(['name']);
    expect(wrong(T.teleStep1Problems(draft({ name: '1' })))).toEqual(['name']);
    expect(wrong(T.teleStep1Problems(draft({ gender: '' })))).toEqual(['age']);
    expect(wrong(T.teleStep1Problems(draft({ country: '' })))).toEqual(['country']);
    expect(wrong(T.teleStep1Problems(draft({ phone: '' })))).toEqual(['phone']);
  });
  test.each([['0'], ['1'], ['61'], ['129'], [' 7 ']])('age %p is valid', (age) => {
    expect(T.isValidTeleAge(age)).toBe(true);
    expect(wrong(T.teleStep1Problems(draft({ age })))).toEqual([]);
  });
  test.each([[''], ['130'], ['1000'], ['-1'], ['1.5'], ['abc'], ['1e1'], [null], [undefined], ['０']])('age %p is not', (age) => {
    expect(T.isValidTeleAge(age)).toBe(false);
    expect(wrong(T.teleStep1Problems(draft({ age })))).toEqual(['age']);
  });
  test('contact: valid for the country code, refused otherwise', () => {
    expect(wrong(T.teleStep1Problems(draft({ phone: '12345' })))).toEqual(['phone']);
    expect(wrong(T.teleStep1Problems(draft({ phone: 'abc' })))).toEqual(['phone']);
    expect(wrong(T.teleStep1Problems(draft({ cc: '+971', phone: '501234567', phoneCountry: 'AE' })))).toEqual([]);
  });
  test('the contact is sent the way the server stores it (calling code and number, trunk zero dropped)', () => {
    expect(T.contactNumber('+91', '9876543210')).toBe('+91 98765 43210');
    expect(T.contactNumber('+91', '09876543210')).toBe('+91 98765 43210');
    expect(T.contactNumber('+971', '501234567')).toBe('+971 50 123 4567');
  });
});

describe('Step 1: the multiline Current Address', () => {
  test('required for both an Online Consultation and a House Call; blank or only line breaks does not count', () => {
    for (const teleType of ['online', 'house_call']) {
      expect(wrong(T.teleStep1Problems(draft({ teleType, address: '' })))).toEqual(['address']);
      expect(wrong(T.teleStep1Problems(draft({ teleType, address: '  \n \n ' })))).toEqual(['address']);
      expect(wrong(T.teleStep1Problems(draft({ teleType, address: 'Pune' })))).toEqual([]);
    }
  });
  test('multiline: it is a multiline input, kept above the keyboard, with a counter', () => {
    const page = read('components/request/TeleStep1.js');
    expect(page).toMatch(/<MultilineInput\s+multiline/);
    expect(page).toContain('maxLength={ADDRESS_MAX}');
    expect(page).toContain('hint={`${addressLength}/${ADDRESS_MAX}`}');
    expect(read('components/request/MultilineInput.js')).toContain('useFormInput({ multiline: true })');
  });
  test('2,000 characters at most, counted as characters (an emoji is one)', () => {
    expect(T.ADDRESS_MAX).toBe(2000);
    expect(wrong(T.teleStep1Problems(draft({ address: 'a'.repeat(2000) })))).toEqual([]);
    expect(wrong(T.teleStep1Problems(draft({ address: 'a'.repeat(2001) })))).toEqual(['address']);
    expect(wrong(T.teleStep1Problems(draft({ address: '😀'.repeat(2000) })))).toEqual([]);
    expect(wrong(T.teleStep1Problems(draft({ address: '😀'.repeat(2001) })))).toEqual(['address']);
    expect(T.codePointLength('😀')).toBe(1);
    expect(T.codePointLength('👨‍👩‍👧‍👦')).toBe(7); // the server counts characters the same way (and never cuts inside one when it shortens)
    expect(T.codePointLength(null)).toBe(0);
  });
  test('the address is sent once, as typed (the server derives the one-line copy and keeps the original)', () => {
    expect(T.buildTelePayload(draft()).currentAddress).toBe('Flat 4B, Rose Villa\nMG Road, Pune 411001');
  });
});

describe('Step 2', () => {
  const page = read('components/request/TeleStep2.js');
  const code = page.replace(/^\s*\/\/.*$/gm, ''); // the code, without its comments
  test('the page: Present Medical Issue, Allergic Issue, then the visit date for a House Call only', () => {
    expect(anchors(page)).toEqual(['issue', 'allergies', 'visitDate']);
    expect(page).toContain('{houseCall && (');
  });
  test('no urgency, no care level or equipment, no uploads, no mobility', () => {
    expect(code).not.toMatch(/urgency|URGENCY|ReportTiles|req_reports|CARE_LEVELS|equip|mobility|ChoiceChips|files/i);
  });
  test('both notes are optional, 2,000 characters at most, counted as characters', () => {
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', desc: '', allergies: '' }), NOW))).toEqual([]);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', desc: 'x'.repeat(2000), allergies: 'y'.repeat(2000) }), NOW))).toEqual([]);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', desc: 'x'.repeat(2001) }), NOW))).toEqual(['issue']);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', allergies: '😀'.repeat(2001) }), NOW))).toEqual(['allergies']);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', allergies: '😀'.repeat(2000) }), NOW))).toEqual([]);
    expect(T.TEXT_MAX).toBe(2000);
    expect(page).toContain('maxLength={TEXT_MAX}');
  });
  test('the Preferred Visit Date is required for a House Call only', () => {
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'house_call', date: '' }), NOW))).toEqual(['visitDate']);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'online', date: '' }), NOW))).toEqual([]);
    expect(wrong(T.teleStep2Problems(draft({ teleType: 'house_call', date: '2026-11-17' }), NOW))).toEqual([]);
  });
});

describe('the visit date: tomorrow or later, no time', () => {
  test('tomorrow is the earliest day; today and every past day are not valid', () => {
    expect(T.tomorrowString(NOW)).toBe('2026-11-17');
    expect(T.isValidVisitDate('2026-11-17', NOW)).toBe(true);
    expect(T.isValidVisitDate('2026-11-18', NOW)).toBe(true);
    expect(T.isValidVisitDate('2027-06-30', NOW)).toBe(true);
    expect(T.isValidVisitDate('2026-11-16', NOW)).toBe(false);
    expect(T.isValidVisitDate('2026-11-15', NOW)).toBe(false);
    expect(T.isValidVisitDate('2020-01-01', NOW)).toBe(false);
  });
  test('it is the person\'s own calendar day, at any hour (the late evening and the first minute of the day)', () => {
    expect(T.tomorrowString(new Date(2026, 10, 16, 23, 59, 59))).toBe('2026-11-17');
    expect(T.tomorrowString(new Date(2026, 10, 16, 0, 0, 0))).toBe('2026-11-17');
  });
  test('month, year and leap-day edges', () => {
    expect(T.tomorrowString(new Date(2026, 10, 30, 12))).toBe('2026-12-01');
    expect(T.tomorrowString(new Date(2026, 11, 31, 23, 30))).toBe('2027-01-01');
    expect(T.tomorrowString(new Date(2028, 1, 28, 9))).toBe('2028-02-29');
    expect(T.tomorrowString(new Date(2027, 1, 28, 9))).toBe('2027-03-01');
    expect(T.isValidVisitDate('2028-02-29', new Date(2028, 1, 1))).toBe(true);
    expect(T.isValidVisitDate('2027-02-29', new Date(2027, 1, 1))).toBe(false);
  });
  test.each([[''], [null], [undefined], ['tomorrow'], ['2026-13-01'], ['2026-02-30'], ['25/11/2026'], ['2026-1-5'], ['2026-11-25T10:00:00Z']])('%p is not a visit date', (value) => {
    expect(T.isValidVisitDate(value, NOW)).toBe(false);
  });
  test('the picker offers tomorrow onward: native pickers get a minimum of tomorrow, the browser input a min', () => {
    const field = read('components/request/VisitDateField.js');
    expect(field).toContain('const earliest = tomorrowDate();');
    expect(field).toContain('min={tomorrowString()}');
    expect((field.match(/minimumDate=\{earliest\}/g) || []).length).toBe(2); // Android dialog and iOS spinner
    expect(field).toContain('mode="date"'); // a day, no time
    expect(field).not.toMatch(/mode="(time|datetime)"/);
  });
  test('the date helpers round-trip a local day', () => {
    expect(T.dateToString(T.stringToDate('2026-11-25'))).toBe('2026-11-25');
    expect(T.stringToDate('2026-02-30')).toBeNull();
    expect(T.stringToDate('nope')).toBeNull();
  });
});

describe('the submission payload', () => {
  test('the approved example, exactly (plus the device\'s UTC offset, which only decides the visit date)', () => {
    expect(T.buildTelePayload(draft(), { getTimezoneOffset: () => -330 })).toEqual({
      serviceType: 'Tele Consultation & House Call',
      serviceKey: 'tele',
      consultationScope: 'international',
      consultationType: 'house_call',
      patientName: 'Asha Nair',
      patientAge: 61,
      patientGender: 'Female',
      country: 'India',
      patientContact: '+91 98765 43210',
      currentAddress: 'Flat 4B, Rose Villa\nMG Road, Pune 411001',
      preferredDate: '2026-11-25',
      utcOffsetMinutes: 330,
      presentMedicalIssue: 'Fever and cough for three days.',
      allergyDetails: 'Penicillin.',
    });
  });
  test('the offset is minutes EAST of UTC (JavaScript reports it the other way round), and never -0', () => {
    const sent = (jsOffset) => T.buildTelePayload(draft(), { getTimezoneOffset: () => jsOffset }).utcOffsetMinutes;
    expect(sent(-330)).toBe(330); // India
    expect(sent(480)).toBe(-480); // US Pacific
    expect(sent(-840)).toBe(840);
    expect(sent(720)).toBe(-720);
    expect(Object.is(sent(0), 0)).toBe(true); // UTC: +0, not -0
  });
  test('the offset comes from the same clock as the date picker: it is read from the moment the request is built', () => {
    expect(T.buildTelePayload(draft()).utcOffsetMinutes).toBe(0 - new Date().getTimezoneOffset());
    expect(read('lib/teleConsultation.js')).toContain('utcOffsetMinutes: 0 - now.getTimezoneOffset(),');
  });
  test('the phone and the server agree on which day is tomorrow, at any hour and in any time zone', () => {
    const server = require('../../../../../backend/src/modules/requests/tele-consultation.validation');
    // a clock that is `offset` minutes east of UTC at `instant`, as the phone sees it
    const device = (instant, offset) => {
      const local = new Date(Date.parse(instant) + offset * 60000);
      return { getFullYear: () => local.getUTCFullYear(), getMonth: () => local.getUTCMonth(), getDate: () => local.getUTCDate(), getTimezoneOffset: () => 0 - offset };
    };
    for (const instant of ['2026-11-16T00:00:00Z', '2026-11-16T09:59:59Z', '2026-11-16T10:00:00Z', '2026-11-16T11:59:59Z', '2026-11-16T12:00:00Z', '2026-11-16T22:00:00Z', '2026-11-16T23:59:59Z', '2026-12-31T23:30:00Z', '2028-02-28T23:00:00Z']) {
      for (const offset of [-720, -480, -210, 0, 330, 345, 540, 840]) {
        const clock = device(instant, offset);
        const sent = T.buildTelePayload(draft(), clock).utcOffsetMinutes;
        expect({ instant, offset, tomorrow: server.earliestVisitDay(new Date(instant), sent) }).toEqual({ instant, offset, tomorrow: T.tomorrowString(clock) });
      }
    }
  });
  test.each([['domestic'], ['international']])('a House Call (%s) carries both its Scope and its Type', (teleScope) => {
    const payload = T.buildTelePayload(draft({ teleScope, teleType: 'house_call' }));
    expect(payload).toMatchObject({ consultationScope: teleScope, consultationType: 'house_call', serviceKey: 'tele' });
  });
  test.each([[''], ['domestic'], ['international'], [undefined]])('an Online Consultation sends no Scope at all (even if the draft still holds %p)', (teleScope) => {
    const payload = T.buildTelePayload(draft({ teleScope, teleType: 'online' }));
    expect(payload).toMatchObject({ consultationType: 'online', serviceKey: 'tele', serviceType: 'Tele Consultation & House Call' });
    expect(payload).not.toHaveProperty('consultationScope');
    expect(Object.keys(payload)).not.toContain('consultationScope');
    expect(payload.country).toBe('India');
    expect(payload.patientContact).toBe('+91 98765 43210');
  });
  test('what the phone sends, the server accepts: an Online Consultation without Scope and a House Call with one', () => {
    const server = require('../../../../../backend/src/modules/requests/tele-consultation.validation');
    const NOW_SERVER = new Date('2026-11-16T10:00:00.000Z');
    const online = T.buildTelePayload(draft({ teleType: 'online', teleScope: '', date: '' }), { getTimezoneOffset: () => 0 });
    expect(server.validateTeleRequest(online, { now: NOW_SERVER }).error).toBeUndefined();
    const house = T.buildTelePayload(draft({ teleType: 'house_call', teleScope: 'domestic', date: '2026-11-25' }), { getTimezoneOffset: () => 0 });
    expect(server.validateTeleRequest(house, { now: NOW_SERVER }).error).toBeUndefined();
    const houseWithoutScope = T.buildTelePayload(draft({ teleType: 'house_call', teleScope: '', date: '2026-11-25' }), { getTimezoneOffset: () => 0 });
    expect(server.validateTeleRequest(houseWithoutScope, { now: NOW_SERVER }).error).toMatch(/consultationScope/);
  });
  test('an Online Consultation sends a null date, even if a date was left in the draft', () => {
    expect(T.buildTelePayload(draft({ teleType: 'online', date: '2026-11-25' })).preferredDate).toBeNull();
    expect(T.buildTelePayload(draft({ teleType: 'online', date: '' })).preferredDate).toBeNull();
  });
  test('age 0 is sent as the number 0', () => {
    expect(T.buildTelePayload(draft({ age: '0' })).patientAge).toBe(0);
    expect(T.buildTelePayload(draft({ age: ' 07 ' })).patientAge).toBe(7);
  });
  test('the two notes are left out when empty or blank', () => {
    const payload = T.buildTelePayload(draft({ desc: '', allergies: '  \n ' }));
    expect(payload).not.toHaveProperty('presentMedicalIssue');
    expect(payload).not.toHaveProperty('allergyDetails');
  });
  test('nothing that belongs to another service is sent: no origin, destination, description, urgency, care level, equipment, mobility or files', () => {
    const payload = T.buildTelePayload(draft({ urgency: 'planned', files: [{ uri: 'file:///x.pdf' }], care: ['care_icu'], mobility: 'walking', equipOxygen: true, location: 'Pune', dest: 'Mumbai' }));
    for (const key of ['origin', 'destination', 'description', 'urgency', 'careLevel', 'mobility', 'equipOxygen', 'equipOxygenLpm', 'equipCardiacMonitor', 'equipVentilator', 'files', 'patientLocation']) {
      expect(payload).not.toHaveProperty(key);
    }
    // and only the fields the backend accepts
    expect(Object.keys(payload).sort()).toEqual([
      'allergyDetails', 'consultationScope', 'consultationType', 'country', 'currentAddress', 'patientAge', 'patientContact', 'patientGender', 'patientName',
      'preferredDate', 'presentMedicalIssue', 'serviceKey', 'serviceType', 'utcOffsetMinutes',
    ]);
  });
  test('the submit uses it, uploads nothing, and the Private Charter and generic branches are not touched by it', () => {
    const review = read('app/request/review.js');
    const tele = review.slice(review.indexOf('if (isTeleService(d.service)) {'), review.indexOf('if (isPrivateCharter(d.service)) {'));
    expect(tele).toContain('guardedSend(buildTelePayload(d))'); // send() adds the idempotency key (Phase 4)
    expect(tele).not.toMatch(/apiUpload|runSubmission|files/);
    const charter = review.slice(review.indexOf('if (isPrivateCharter(d.service)) {'), review.indexOf('// Every other service keeps the body it has always sent.'));
    expect(charter).not.toMatch(/isTeleService|buildTelePayload/);
  });
});

describe('the review page', () => {
  const svc = { key: 'tele', title: 'Tele Consultation & House Call' };
  test('a House Call shows Type, Scope, every patient detail and the complete address', () => {
    const v = reviewView(draft(), svc, t);
    expect(v.patient.fields.map((f) => [f.key, f.value])).toEqual([
      ['type', 'House Call'], ['scope', 'International'], ['name', 'Asha Nair'], ['age', '61'], ['gender', 'Female'], ['country', 'India'],
      ['contact', '+91 98765 43210'], ['address', 'Flat 4B, Rose Villa\nMG Road, Pune 411001'],
    ]);
  });
  test('an Online Consultation shows no Scope (not even one left over in the draft), and still shows Country and Contact', () => {
    for (const teleScope of ['', 'domestic']) {
      const v = reviewView(draft({ teleType: 'online', teleScope, date: '' }), svc, t);
      expect(v.patient.fields.map((f) => [f.key, f.value])).toEqual([
        ['type', 'Online Consultation (Video/Audio)'], ['name', 'Asha Nair'], ['age', '61'], ['gender', 'Female'], ['country', 'India'],
        ['contact', '+91 98765 43210'], ['address', 'Flat 4B, Rose Villa\nMG Road, Pune 411001'],
      ]);
    }
  });
  test('what is shown is what is sent (name, age, contact and address match the payload)', () => {
    const d = draft({ age: '061', phone: '09876543210' });
    const v = reviewView(d, svc, t);
    const payload = T.buildTelePayload(d);
    const value = (key) => v.patient.fields.find((f) => f.key === key).value;
    expect(value('name')).toBe(payload.patientName);
    expect(value('age')).toBe(String(payload.patientAge));
    expect(value('contact')).toBe(payload.patientContact);
    expect(value('address')).toBe(payload.currentAddress);
  });
  test('the medical details: the issue and the allergies when entered, the visit date for a House Call', () => {
    const v = reviewView(draft(), svc, t);
    expect(v.medical.conditionLabel).toBe('Present medical issue');
    expect(v.medical.condition).toBe('Fever and cough for three days.');
    expect(v.medical.details.map((r) => [r.key, r.label, r.value])).toEqual([['allergies', 'Any allergic issue?', 'Penicillin.'], ['visitDate', 'Preferred visit date', '25 Nov 2026']]);
    expect(v.show).toMatchObject({ patient: true, trip: false, medical: true, documents: false });
  });
  test('an Online Consultation has no visit date; empty notes are not drawn', () => {
    const v = reviewView(draft({ teleType: 'online', date: '2026-11-25', desc: '', allergies: '' }), svc, t);
    expect(v.medical.details).toEqual([]);
    expect(v.medical.condition).toBe('');
    expect(v.show.medical).toBe(false);
    expect(v.patient.fields.find((f) => f.key === 'type').value).toBe('Online Consultation (Video/Audio)');
  });
  test('only the allergies when only they were entered', () => {
    const v = reviewView(draft({ teleType: 'online', desc: '', allergies: 'Dust' }), svc, t);
    expect(v.medical.details.map((r) => r.key)).toEqual(['allergies']);
    expect(v.show.medical).toBe(true);
  });
  test('no trip or destination, no urgency, no transport rows, no documents (even if files were left in the draft)', () => {
    const v = reviewView(draft({ urgency: 'critical_6h', files: [{ uri: 'file:///x.pdf', name: 'x.pdf' }], care: ['care_icu'], mobility: 'walking', equipOxygen: true, location: 'Pune', dest: 'Mumbai' }), svc, t);
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
    expect(v.show.trip).toBe(false);
    expect(v.medical.urgency).toBeNull();
    expect(v.medical.care).toEqual([]);
    expect(v.medical.mobility).toBe('');
    expect(v.medical.equipment).toBeNull();
    expect(v.documents).toEqual([]);
    expect(v.show.documents).toBe(false);
  });
  test('the fields the form collects: no trip, urgency or files; its own answers are shown', () => {
    const fields = fieldsFor('tele');
    for (const gone of ['location', 'dest', 'urgency', 'files']) expect(fields).not.toHaveProperty(gone);
    expect(fields).toMatchObject({ teleScope: 'patient', teleType: 'patient', address: 'patient', allergies: 'medical', desc: 'medical', date: 'medical' });
  });
  test('other services review exactly as before', () => {
    const v = reviewView(draft({ service: 'ground' }), { key: 'ground', title: 'Ground Ambulance' }, t);
    expect(v.trip.from).toBe('');
    expect(v.medical.details).toEqual([]);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('scope');
  });
});

describe('no uploads, and leaving or entering Teleconsultation', () => {
  const INITIAL = { service: 'air', files: [], urgency: '', date: '', teleScope: '', teleType: '', address: '', allergies: '' };
  test('Step 2 has no upload section (the shared one is not used), and the submit uploads nothing', () => {
    expect(read('components/request/TeleStep2.js').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/ReportTiles|apiUpload/);
    expect(read('app/request/step2.js')).toContain('return isTeleService(draft.service) ? <TeleStep2 /> : <GenericStep2 />;');
  });
  test('entering Teleconsultation from another service drops files, urgency and the other service\'s date, and keeps the patient', () => {
    const swapped = draftForService({ ...INITIAL, changingService: true, service: 'ground', name: 'Asha', files: [{ uri: 'file:///x.pdf' }], urgency: 'planned', date: '2026-11-20', address: '' }, 'tele', INITIAL);
    expect(swapped).toMatchObject({ service: 'tele', name: 'Asha', files: [], urgency: '', date: '' });
  });
  test('leaving Teleconsultation clears every Tele-only answer and its visit date, and keeps the patient', () => {
    const swapped = draftForService({
      ...INITIAL, changingService: true, service: 'tele', name: 'Asha', age: '61', teleScope: 'domestic', teleType: 'house_call', address: 'Pune', allergies: 'Dust', desc: 'Cough', date: '2026-11-25',
    }, 'ground', INITIAL);
    expect(swapped).toMatchObject({ service: 'ground', teleScope: '', teleType: '', address: '', allergies: '', date: '', name: 'Asha', age: '61', desc: 'Cough' });
  });
  test('starting a request fresh gives an empty Teleconsultation form', () => {
    expect(draftForService({ ...INITIAL, name: 'Old', changingService: false }, 'tele', INITIAL)).toEqual({ ...INITIAL, service: 'tele' });
  });
  test('between two other services nothing about Teleconsultation is touched', () => {
    const swapped = draftForService({ ...INITIAL, changingService: true, service: 'ground', date: '2026-11-20', files: [{ uri: 'x' }], urgency: 'planned' }, 'privatecharter', INITIAL);
    expect(swapped).toMatchObject({ date: '2026-11-20', files: [{ uri: 'x' }], urgency: 'planned' });
  });
});

describe('Request Details, My Requests, tracking and Share', () => {
  const NEW = {
    id: 7, referenceNumber: 'REQ-1007', status: 'submitted', serviceType: 'Tele Consultation & House Call', serviceKey: 'tele', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
    patientContact: '+91 98765 43210', country: 'India', origin: 'Flat 4B, Rose Villa, MG Road, Pune 411001', destination: '', preferredDate: '2026-11-25T00:00:00.000Z', urgency: null,
    description: 'Scope: International\nConsultation type: House Call\n\nCurrent address:\nFlat 4B, Rose Villa\nMG Road, Pune 411001\n\nPresent medical issue:\nFever.', createdAt: '2026-11-16T09:30:00.000Z',
  };
  const OLD = { ...NEW, id: 3, referenceNumber: 'REQ-1003', origin: 'Pune', destination: 'Mumbai', urgency: 'planned', description: 'Cough and fever.', preferredDate: '2026-11-20T00:00:00.000Z' };

  test('a new request is told apart by its empty destination; an older one has a destination', () => {
    expect(T.isNewTeleRequest(NEW)).toBe(true);
    expect(T.isNewTeleRequest(OLD)).toBe(false);
    expect(T.isNewTeleRequest({ ...NEW, serviceKey: 'ground' })).toBe(false);
    expect(T.isNewTeleRequest({ ...NEW, destination: '   ' })).toBe(true);
    expect(T.isNewTeleRequest(null)).toBe(false);
  });
  test('Request Details of a new request: the address, no Trip, no urgency, the consultation details, the visit date', () => {
    const v = detailsView(NEW, t);
    expect(v.trip).toEqual({ from: '', to: '', rows: [] });
    expect(v.patient.fields.find((f) => f.key === 'address')).toMatchObject({ label: 'Current address', value: 'Flat 4B, Rose Villa, MG Road, Pune 411001' });
    expect(v.medical.urgency).toBeNull();
    expect(v.medical.conditionLabel).toBe('Consultation details');
    expect(v.medical.condition).toBe(NEW.description); // the complete address is in it, whenever it was shortened or had line breaks
    expect(v.medical.details.map((r) => [r.label, r.value])).toEqual([['Preferred visit date', '25 Nov 2026']]);
  });
  test('Request Details of an Online Consultation (no date) has no visit-date line', () => {
    expect(detailsView({ ...NEW, preferredDate: null }, t).medical.details).toEqual([]);
  });
  test('Request Details of an older request reads exactly as it did: Trip, urgency, "Condition & diagnosis", the date of service', () => {
    const v = detailsView(OLD, t);
    expect(v.trip.from).toBe('Pune');
    expect(v.trip.to).toBe('Mumbai');
    expect(v.trip.rows.map((r) => [r.key, r.value])).toEqual([['date', '20 Nov 2026']]);
    expect(v.medical.urgency).toBeTruthy();
    expect(v.medical.conditionLabel).toBe('Condition & diagnosis');
    expect(v.medical.details).toEqual([]);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('address');
  });
  test('Share is gone from Request Details, and with it the helper that only it used', () => {
    expect(T.shareRouteLine).toBeUndefined();
    expect(read('app/request-details.js')).not.toMatch(/shareRouteLine|Share\.share|Share2/);
  });
  test('My Requests: a new request\'s card has no route; an older one keeps it', () => {
    const base = { id: 'REQ-1', serviceKey: 'tele', serviceType: NEW.serviceType, status: 'submitted', rawStatus: 'submitted', display: '16 Nov 2026' };
    expect(cardView({ ...base, origin: NEW.origin, destination: '' }, t).route).toBeNull();
    expect(cardView({ ...base, origin: 'Pune', destination: 'Mumbai' }, t).route).toEqual({ from: 'Pune', to: 'Mumbai' });
    expect(cardView({ ...base, origin: NEW.origin, destination: '' }, t).label).not.toContain('Rose Villa');
  });
  test('Tracking: a new request shows its address and no destination; an older one keeps From and To; no route is drawn for a new one', () => {
    expect(trackingItemFromRequest({ ...NEW, case: null }).teleConsultation).toBe(true);
    expect(trackingItemFromRequest({ ...OLD, case: null }).teleConsultation).toBe(false);
    expect(buildTrackingDetails({ ...NEW, case: null }, t)).toMatchObject({ from: '', to: '', hasRoute: false });
    expect(buildTrackingDetails({ ...OLD, case: null }, t)).toMatchObject({ from: 'Pune', to: 'Mumbai', hasRoute: true });
    const screen = read('app/tracking.js');
    expect(screen).toContain('item.teleConsultation ? (');
    expect(screen).toContain("label={t('field_current_address')} value={item.origin}");
    expect(screen).toContain("label={t('lbl_to')} value={item.destination}");
  });
});

describe('the catalog lookup', () => {
  test('Teleconsultation asks the catalog by its own slug; every other key is asked as before', () => {
    expect(liveSlugFor('tele')).toBe('teleconsultation');
    for (const key of ['air', 'ground', 'homecare', 'hospital', 'mortal', 'privatecharter', 'commercialair', 'marine', 'medvalue', 'corporate']) expect(liveSlugFor(key)).toBe(key);
    expect(liveSlugFor('toString')).toBe('toString'); // no inherited keys
  });
  test('the page asks the mapped slug', () => {
    expect(read('app/service/[key].js')).toContain('apiGet(`/services/${liveSlugFor(key)}`)');
  });
  test('the title stays "Tele Consultation & House Call" whatever the catalog says; the description and what we provide may come from it', () => {
    const local = SERVICES.tele;
    const live = { name: 'Teleconsultation', description: 'Connect with a doctor remotely.', provides: ['24/7 Availability', 'Licensed Doctors'] };
    expect(detailContent(local, live, 'tele')).toEqual({ title: 'Tele Consultation & House Call', desc: 'Connect with a doctor remotely.', features: ['24/7 Availability', 'Licensed Doctors'] });
    expect(detailContent(local, null, 'tele')).toEqual({ title: local.title, desc: local.desc, features: local.features });
    expect(detailContent(local, { name: 'X', description: '', provides: [] }, 'tele')).toEqual({ title: local.title, desc: local.desc, features: local.features });
  });
  test('every other service merges the catalog over its bundled content exactly as before, title included', () => {
    const local = SERVICES.ground;
    const live = { name: 'Ground Ambulance (live)', description: 'live text', provides: ['a'] };
    expect(detailContent(local, live, 'ground')).toEqual({ title: 'Ground Ambulance (live)', desc: 'live text', features: ['a'] });
    expect(detailContent(local, null, 'ground')).toEqual({ title: local.title, desc: local.desc, features: local.features });
  });
});

describe('the words', () => {
  test('exist in English (the other languages fall back to it like their other newer keys)', () => {
    for (const key of [
      'field_consult_scope', 'tele_scope_domestic', 'tele_scope_international', 'field_consult_type', 'tele_type_online', 'tele_type_house_call', 'field_current_address',
      'field_current_address_placeholder', 'field_present_issue', 'field_present_issue_placeholder', 'field_allergy', 'field_allergy_placeholder', 'field_visit_date',
      'rd_consultation_details', 'tele_err_too_long', 'tele_err_visit_date',
    ]) expect(i18n.EN[key]).toBeTruthy();
    expect(i18n.EN.tele_err_too_long).toContain('{{max}}');
  });
});

describe('isolation', () => {
  test('Step 1 and Step 2 of every other service are the same pages as before, behind a small wrapper', () => {
    const step1 = read('app/request/step1.js');
    expect(step1).toContain('function GenericStep1() {');
    expect(step1).toContain('return isTeleService(draft.service) ? <TeleStep1 /> : <GenericStep1 />;');
    expect(anchors(step1)).toEqual(['name', 'age', 'relation', 'deathPlace', 'deathDate', 'country', 'location', 'dest', 'phone', 'date', 'mortalTransfer']);
    expect(anchors(read('app/request/step2.js'))).toEqual(['desc', 'travel', 'care', 'mobility', 'equipment', 'oxygenLpm', 'files', 'urgency']);
  });
  test('the shared date field is left as it is (the visit date has its own)', () => {
    expect(read('app/request/step1.js')).toContain('const limits = past ? { maximumDate: TODAY } : { minimumDate: TODAY };');
  });
});
