/* global describe, test, expect, __dirname */
// Mortal Remains Transportation (key "mortal"): the two separate choices (Transfer Scope, Transport Mode: six combinations), the deceased person, the
// dates (by the device's own calendar), the one combined upload section, the review page, the payload the server's validator accepts, My Requests,
// Request Details, Tracking, and older requests. Every other service keeps its form. (The screens are not rendered here: this project's Jest covers lib/
// logic and reads screen source, see jest.config.js; the behaviour on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const M = require('../mortalRemains');
const { draftForService } = require('../requestForm');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { cardView } = require('../myRequestsView');
const { toListItem } = require('../requestShape');
const { trackingItemFromRequest } = require('../trackingItem');
const { requestService } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const server = require('../../../../../backend/src/modules/requests/mortal-remains.validation');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const tIn = (lang) => (key, values) => {
  const text = (i18n[lang] && i18n[lang][key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const t = tIn('EN');
const anchors = (source) => [...source.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1]);
const NOW = new Date(2026, 10, 17, 10, 0, 0); // 17 Nov 2026, local
const wrong = (problems) => problems.filter(([, bad]) => bad).map(([id]) => id);

const draft = (extra = {}) => ({
  service: 'mortal', transferScope: 'international', transportMode: 'private_charter', name: 'Suresh Kale', age: '64', gender: 'Male', relation: 'Brother',
  deathPlace: 'Rashid Hospital, Dubai', deathDate: '2026-11-15', country: 'India', countryIso: 'IN', cc: '+91', phone: '9876543210', phoneCountry: 'IN',
  location: 'Dubai, United Arab Emirates', dest: 'Pune, India', originCity: null, destCity: null, date: '2026-11-20', desc: 'Please arrange a hearse.',
  urgency: 'urgent_24h', files: [], ...extra,
});

describe('identity', () => {
  test('one key and one fixed name; the name equals the bundled service title and the server constant', () => {
    expect(M.MORTAL_SERVICE_KEY).toBe('mortal');
    expect(M.MORTAL_SERVICE_TYPE).toBe('Mortal Remains Transportation');
    expect(SERVICES.mortal.title).toBe(M.MORTAL_SERVICE_TYPE);
    expect(server.MORTAL_SERVICE_TYPE).toBe(M.MORTAL_SERVICE_TYPE);
    expect(server.MORTAL_SERVICE_KEY).toBe(M.MORTAL_SERVICE_KEY);
  });
  test('the request is submitted under that key and name, whatever scope and mode are chosen', () => {
    for (const transferScope of M.MORTAL_SCOPES) for (const transportMode of M.MORTAL_MODES) {
      expect(requestService({ service: 'mortal', transferScope, transportMode }, SERVICES)).toEqual({ title: 'Mortal Remains Transportation', key: 'mortal' });
    }
  });
  test('new and older Mortal Remains requests are both recognised', () => {
    for (const key of ['mortal', 'mortal_domestic', 'mortal_international']) expect(M.isMortalRequestKey(key)).toBe(true);
    for (const key of ['ground', 'mortality', '', undefined]) expect(M.isMortalRequestKey(key)).toBe(false);
    expect(M.isMortalService('mortal')).toBe(true);
    expect(M.isMortalService('mortal_domestic')).toBe(false);
  });
});

describe('the options', () => {
  test('two independent choices with exactly the approved values, six combinations', () => {
    expect(M.MORTAL_SCOPES).toEqual(['domestic', 'international']);
    expect(M.MORTAL_MODES).toEqual(['private_charter', 'commercial_air_cargo', 'ground_transportation']);
    expect(M.MORTAL_SCOPES.length * M.MORTAL_MODES.length).toBe(6);
    expect(Object.keys(server.SCOPES)).toEqual(M.MORTAL_SCOPES);
    expect(Object.keys(server.MODES)).toEqual(M.MORTAL_MODES);
  });
  test('gender and relation options are the existing ones, the same on the server', () => {
    expect(M.MORTAL_GENDERS).toEqual(['Male', 'Female', 'Other']);
    expect(M.MORTAL_RELATIONS).toEqual(['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other']);
    expect(server.RELATIONS).toEqual(M.MORTAL_RELATIONS);
  });
  test('every option reads in all six languages', () => {
    const keys = [...Object.values(M.MORTAL_SCOPE_LABEL_KEYS), ...Object.values(M.MORTAL_MODE_LABEL_KEYS), 'field_mortal_scope', 'field_mortal_mode'];
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of keys) {
      expect({ lang, key, ok: typeof i18n[lang][key] === 'string' && i18n[lang][key].trim().length > 0 }).toEqual({ lang, key, ok: true });
    }
    expect(t('mortal_scope_domestic')).toBe('Domestic');
    expect(t('mortal_mode_commercial_air_cargo')).toBe('Commercial Air Cargo');
  });
});

describe('age', () => {
  test('0 to 129 inclusive, whole numbers only', () => {
    for (const ok of ['0', '1', '64', '129', ' 7 ', 0, 129]) expect(M.isValidMortalAge(ok)).toBe(true);
    for (const bad of ['', '130', '-1', '1.5', 'abc', '1e2', '0000', null, undefined, 130, -1]) expect(M.isValidMortalAge(bad)).toBe(false);
  });
});

describe('dates, by the device\'s own calendar', () => {
  test('a date of death is today or earlier', () => {
    expect(M.isValidDeathDate('2026-11-17', NOW)).toBe(true);
    expect(M.isValidDeathDate('2026-11-16', NOW)).toBe(true);
    expect(M.isValidDeathDate('1999-01-01', NOW)).toBe(true);
    expect(M.isValidDeathDate('2026-11-18', NOW)).toBe(false);
    for (const bad of ['', '2026-02-30', '17/11/2026', 'today', null]) expect(M.isValidDeathDate(bad, NOW)).toBe(false);
  });
  test('a preferred transfer date is today or later (a typed web date in the past is refused too)', () => {
    expect(M.isValidTransferDate('2026-11-17', NOW)).toBe(true);
    expect(M.isValidTransferDate('2027-03-01', NOW)).toBe(true);
    expect(M.isValidTransferDate('2026-11-16', NOW)).toBe(false);
    for (const bad of ['', '2026-02-30', '20/11/2026', null]) expect(M.isValidTransferDate(bad, NOW)).toBe(false);
  });
});

describe('Step 1', () => {
  test('a complete form has no problem', () => {
    expect(wrong(M.mortalStep1Problems(draft(), NOW))).toEqual([]);
  });
  test('neither choice is preselected, and each is required on its own', () => {
    const initial = read('state/AppContext.js');
    expect(initial).toMatch(/transferScope: '',/);
    expect(initial).toMatch(/transportMode: '',/);
    expect(wrong(M.mortalStep1Problems(draft({ transferScope: '' }), NOW))).toEqual(['scope']);
    expect(wrong(M.mortalStep1Problems(draft({ transportMode: '' }), NOW))).toEqual(['mode']);
    expect(wrong(M.mortalStep1Problems(draft({ transferScope: 'both' }), NOW))).toEqual(['scope']);
  });
  test('every required field is checked, in page order (the page scrolls to the first)', () => {
    const empty = draft({ transferScope: '', transportMode: '', name: '', age: '', gender: '', relation: '', deathPlace: '', deathDate: '', country: '', phone: '', location: '', dest: '', date: '' });
    expect(wrong(M.mortalStep1Problems(empty, NOW))).toEqual(['scope', 'mode', 'name', 'age', 'relation', 'deathPlace', 'deathDate', 'country', 'phone', 'location', 'dest', 'date']);
  });
  test('age 0 is accepted, age 130 is not; gender must be one of the three', () => {
    expect(wrong(M.mortalStep1Problems(draft({ age: '0' }), NOW))).toEqual([]);
    expect(wrong(M.mortalStep1Problems(draft({ age: '129' }), NOW))).toEqual([]);
    expect(wrong(M.mortalStep1Problems(draft({ age: '130' }), NOW))).toEqual(['age']);
    expect(wrong(M.mortalStep1Problems(draft({ gender: 'Unknown' }), NOW))).toEqual(['age']);
  });
  test('the contact number needs the right digits for its country code', () => {
    expect(wrong(M.mortalStep1Problems(draft({ phone: '12345' }), NOW))).toEqual(['phone']);
    expect(wrong(M.mortalStep1Problems(draft({ cc: '+971', phone: '501234567', phoneCountry: 'AE' }), NOW))).toEqual([]);
    expect(wrong(M.mortalStep1Problems(draft({ cc: '+971', phone: '9876543210', phoneCountry: 'AE' }), NOW))).toEqual(['phone']);
  });
  test('the dates are judged by the device\'s calendar', () => {
    expect(wrong(M.mortalStep1Problems(draft({ deathDate: '2026-11-18' }), NOW))).toEqual(['deathDate']);
    expect(wrong(M.mortalStep1Problems(draft({ deathDate: '2026-11-17', date: '2026-11-17' }), NOW))).toEqual([]);
    expect(wrong(M.mortalStep1Problems(draft({ date: '2026-11-16' }), NOW))).toEqual(['date']);
  });
  test('the places have the server\'s 191 character limit; a city picked from another country is a problem for the current location only', () => {
    expect(wrong(M.mortalStep1Problems(draft({ deathPlace: 'x'.repeat(191) }), NOW))).toEqual([]);
    expect(wrong(M.mortalStep1Problems(draft({ deathPlace: 'x'.repeat(192) }), NOW))).toEqual(['deathPlace']);
    expect(wrong(M.mortalStep1Problems(draft({ location: 'x'.repeat(192) }), NOW))).toEqual(['location']);
    expect(wrong(M.mortalStep1Problems(draft({ dest: 'x'.repeat(192) }), NOW))).toEqual(['dest']);
    const other = { geonameId: 1, name: 'London', label: 'London, United Kingdom', countryCode: 'GB' };
    expect(wrong(M.mortalStep1Problems(draft({ originCity: other }), NOW))).toEqual(['location']);
    expect(wrong(M.mortalStep1Problems(draft({ destCity: other }), NOW))).toEqual([]);
  });
  test('the page has the approved fields in the approved order, with the two choices first', () => {
    expect(anchors(read('components/request/MortalStep1.js'))).toEqual(['scope', 'mode', 'name', 'age', 'relation', 'deathPlace', 'deathDate', 'country', 'phone', 'location', 'dest', 'date']);
    expect(M.mortalStep1Problems(draft(), NOW).map(([id]) => id)).toEqual(anchors(read('components/request/MortalStep1.js')));
  });
  test('the name field says "Deceased Person\'s Name", in the form and in the language files', () => {
    expect(t('field_deceased_name')).toBe("Deceased Person's Name");
    expect(t('lbl_deceased_name')).toBe("Deceased Person's Name");
    const page = read('components/request/MortalStep1.js');
    expect(page).toContain("t('field_deceased_name')");
    expect(page).not.toContain('Full name of the deceased"');
  });
});

describe('Step 2', () => {
  test('Details are optional (2,000 characters at most), urgency is required', () => {
    expect(wrong(M.mortalStep2Problems(draft()))).toEqual([]);
    expect(wrong(M.mortalStep2Problems(draft({ desc: '' })))).toEqual([]);
    expect(wrong(M.mortalStep2Problems(draft({ desc: 'x'.repeat(2000) })))).toEqual([]);
    expect(wrong(M.mortalStep2Problems(draft({ desc: 'x'.repeat(2001) })))).toEqual(['desc']);
    expect(wrong(M.mortalStep2Problems(draft({ urgency: '' })))).toEqual(['urgency']);
  });
  test('one combined upload section with the exact label, no separate slots, no mandatory certificate', () => {
    const page = read('components/request/MortalStep2.js');
    expect(t('req_death_docs')).toBe('Death Certificate / Additional Supporting Documents');
    expect((page.match(/<ReportTiles/g) || []).length).toBe(1);
    expect(page).toContain("title={t('req_death_docs')}");
    expect(anchors(page)).toEqual(['desc', 'files', 'urgency']);
    // nothing about the files can block Continue
    expect(wrong(M.mortalStep2Problems(draft({ files: [] })))).toEqual([]);
    expect(M.mortalStep2Problems(draft()).map(([id]) => id)).toEqual(['desc', 'urgency']);
  });
  test('the upload tiles take at most 10 files of 10 MB, PDF, JPG, PNG, WEBP, DOC, DOCX (the shared limits)', () => {
    const mock = read('data/mock.js');
    expect(mock).toContain('export const MAX_REPORT_FILES = 10;');
    expect(mock).toContain('export const MAX_REPORT_BYTES = 10 * 1024 * 1024;');
    expect(read('components/request/fields.js')).toContain('maxFiles = MAX_REPORT_FILES');
  });
  test('the label is translated in every language', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      expect({ lang, ok: i18n[lang].req_death_docs.length > 10 && i18n[lang].req_death_docs !== i18n.EN.req_death_docs }).toEqual({ lang, ok: true });
    }
  });
});

describe('the payload', () => {
  const clock = (offset) => ({ getFullYear: () => 2026, getMonth: () => 10, getDate: () => 17, getTimezoneOffset: () => 0 - offset });

  test('the approved example, exactly', () => {
    expect(M.buildMortalPayload(draft({ age: '0' }), clock(330))).toEqual({
      serviceType: 'Mortal Remains Transportation',
      serviceKey: 'mortal',
      transferScope: 'international',
      transportMode: 'private_charter',
      patientName: 'Suresh Kale',
      patientAge: 0,
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
      details: 'Please arrange a hearse.',
    });
  });
  test('all six combinations are sent as two separate fields', () => {
    for (const transferScope of M.MORTAL_SCOPES) for (const transportMode of M.MORTAL_MODES) {
      const body = M.buildMortalPayload(draft({ transferScope, transportMode }), clock(0));
      expect(body).toMatchObject({ serviceKey: 'mortal', transferScope, transportMode });
      expect(server.validateMortalRequest(body, { now: new Date('2026-11-17T12:00:00Z') }).error).toBeUndefined();
    }
  });
  test('Details are left out when empty; no description, patientLocation or patient-transport field is ever sent', () => {
    expect(M.buildMortalPayload(draft({ desc: '' }), clock(0))).not.toHaveProperty('details');
    expect(M.buildMortalPayload(draft({ desc: '   ' }), clock(0))).not.toHaveProperty('details');
    const keys = Object.keys(M.buildMortalPayload(draft(), clock(0)));
    for (const forbidden of ['description', 'patientLocation', 'mobility', 'equipOxygen', 'careLevel', 'files']) expect(keys).not.toContain(forbidden);
    // and only the fields the backend accepts
    expect(keys.every((key) => key === 'serviceType' || server.validateMortalRequest({ [key]: 1 }, {}).error !== `${key} is not accepted for Mortal Remains requests`)).toBe(true);
  });
  test('the offset is minutes EAST of UTC (JavaScript reports it the other way round), and never -0', () => {
    const sent = (jsOffset) => M.buildMortalPayload(draft(), { getFullYear: () => 2026, getMonth: () => 10, getDate: () => 17, getTimezoneOffset: () => jsOffset }).utcOffsetMinutes;
    expect(sent(-330)).toBe(330);
    expect(sent(300)).toBe(-300);
    expect(Object.is(sent(0), 0)).toBe(true);
  });
  test('the offset comes from the same moment as the pickers\' "today" (read when the request is built)', () => {
    expect(M.buildMortalPayload(draft()).utcOffsetMinutes).toBe(0 - new Date().getTimezoneOffset());
    expect(read('lib/mortalRemains.js')).toContain('utcOffsetMinutes: 0 - now.getTimezoneOffset(),');
  });
  test('the server accepts what the phone sends, and the two agree on today in every offset and hour', () => {
    const device = (instant, offset) => {
      const local = new Date(Date.parse(instant) + offset * 60000);
      return { getFullYear: () => local.getUTCFullYear(), getMonth: () => local.getUTCMonth(), getDate: () => local.getUTCDate(), getTimezoneOffset: () => 0 - offset };
    };
    for (const hour of [0, 3, 9, 12, 15, 18, 21, 23]) {
      const instant = `2026-11-17T${String(hour).padStart(2, '0')}:20:00Z`;
      for (const offset of [-720, -480, -210, 0, 330, 345, 540, 840]) {
        const clockNow = device(instant, offset);
        const today = M.todayString(clockNow);
        const tomorrow = M.todayString(device(new Date(Date.parse(instant) + 86400000).toISOString(), offset));
        const yesterday = M.todayString(device(new Date(Date.parse(instant) - 86400000).toISOString(), offset));
        const body = (extra) => M.buildMortalPayload(draft({ deathDate: today, date: today, ...extra }), clockNow);
        const serverSays = (payload) => server.validateMortalRequest(payload, { now: new Date(instant) }).error;
        // today for both dates: the phone accepts it and so does the server
        expect({ instant, offset, phone: wrong(M.mortalStep1Problems(draft({ deathDate: today, date: today }), clockNow)), server: serverSays(body({})) })
          .toEqual({ instant, offset, phone: [], server: undefined });
        // tomorrow as the death date / yesterday as the transfer date: both refuse
        expect({ instant, offset, phone: wrong(M.mortalStep1Problems(draft({ deathDate: tomorrow }), clockNow)), server: Boolean(serverSays(body({ deathDate: tomorrow }))) })
          .toEqual({ instant, offset, phone: ['deathDate'], server: true });
        expect({ instant, offset, phone: wrong(M.mortalStep1Problems(draft({ date: yesterday }), clockNow)), server: Boolean(serverSays(body({ date: yesterday }))) })
          .toEqual({ instant, offset, phone: ['date'], server: true });
      }
    }
  });
});

describe('the draft and the service swap', () => {
  const INITIAL = { service: '', name: '', transferScope: '', transportMode: '', relation: '', deathPlace: '', deathDate: '', date: '', files: [], urgency: '', care: [], mobility: '', equipOxygen: false, equipCardiac: false, equipVentilator: false };
  test('starting a request gives an empty form with neither choice made', () => {
    expect(draftForService({ changingService: false }, 'mortal', INITIAL)).toMatchObject({ service: 'mortal', transferScope: '', transportMode: '' });
  });
  test('swapping from Mortal Remains to another service clears its answers and keeps the shared ones', () => {
    const swapped = draftForService({ ...INITIAL, ...draft(), changingService: true }, 'hospital', INITIAL);
    expect(swapped).toMatchObject({ service: 'hospital', transferScope: '', transportMode: '', relation: '', deathPlace: '', deathDate: '', name: 'Suresh Kale', location: 'Dubai, United Arab Emirates' });
  });
  test('swapping from another service into Mortal Remains starts with neither choice', () => {
    const swapped = draftForService({ ...INITIAL, service: 'hospital', name: 'Asha', changingService: true }, 'mortal', INITIAL);
    expect(swapped).toMatchObject({ service: 'mortal', transferScope: '', transportMode: '', name: 'Asha' });
  });
});

describe('the review page', () => {
  test('shows every item of the approved review, in order, under the approved labels', () => {
    const v = reviewView(draft({ files: [{ uri: 'file:///a.pdf', name: 'certificate.pdf', mimeType: 'application/pdf', size: 1000 }] }), { key: 'mortal', title: 'Mortal Remains Transportation' }, t);
    expect(v.patient.fields.map((f) => [f.key, f.label])).toEqual([
      ['name', "Deceased Person's Name"], ['age', t('rd_age')], ['gender', t('field_gender')], ['relation', t('rd_relation')], ['scope', 'Transfer Scope'],
      ['mode', 'Transport Mode'], ['deathPlace', t('field_place_of_death')], ['country', t('field_country')], ['deathDate', t('field_date_of_death')],
      ['contact', t('rd_contact')],
    ]);
    expect(v.patient.fields.map((f) => f.value)).toEqual(['Suresh Kale', '64', 'Male', 'Brother', 'International', 'Private Charter', 'Rashid Hospital, Dubai', 'India', '15 Nov 2026', '+91 98765 43210']);
    expect({ from: v.trip.from, to: v.trip.to }).toEqual({ from: 'Dubai, United Arab Emirates', to: 'Pune, India' });
    expect(v.trip.rows.map((r) => [r.label, r.value])).toEqual([['Preferred transfer date', '20 Nov 2026']]);
    expect(v.medical.condition).toBe('Please arrange a hearse.');
    expect(v.medical.urgency).toBeTruthy();
    expect(v.documents.map((d) => d.name)).toEqual(['certificate.pdf']);
  });
  test('an age of 0 and an empty Details are handled; a draft without Details has no Details row', () => {
    const v = reviewView(draft({ age: '0', desc: '' }), { key: 'mortal', title: 'Mortal Remains Transportation' }, t);
    expect(v.patient.fields.find((f) => f.key === 'age').value).toBe('0');
    expect(v.medical.condition).toBe('');
  });
  test('every field of the draft that Mortal Remains collects is accounted for', () => {
    const expected = fieldsFor('mortal');
    for (const key of ['transferScope', 'transportMode', 'relation', 'deathPlace', 'deathDate', 'name', 'age', 'gender', 'phone', 'cc', 'country', 'location', 'dest', 'date', 'urgency', 'desc', 'files']) {
      expect({ key, accounted: key in expected }).toEqual({ key, accounted: true });
    }
  });
  test('the submit goes through the Mortal Remains payload; the files that did not upload are listed by name on the next screen (Phase 5)', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('buildMortalPayload(d)');
    expect(review).toContain('await sendWithDocuments(buildBody);');
    expect(read('app/request/submitted.js')).toContain('<UploadStatusList'); // names every file with its state
  });
});

describe('My Requests', () => {
  const api = { id: 5, referenceNumber: 'REQ-1064', serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', status: 'submitted', patientName: 'Suresh Kale', origin: 'Dubai', destination: 'Pune', createdAt: '2026-11-17T08:00:00.000Z' };

  test('the card shows the service name, the Deceased Person\'s Name and the request number', () => {
    const v = cardView(toListItem(api), t);
    expect(v.name).toBe('Mortal Remains Transportation');
    expect(v.person).toEqual({ label: "Deceased Person's Name", name: 'Suresh Kale' });
    expect(v.sub).toMatch(/^REQ-1064/);
    expect(v.label).toContain("Deceased Person's Name: Suresh Kale");
    expect(v.label).toContain('REQ-1064');
  });
  test('an older Mortal Remains request shows the name too', () => {
    const v = cardView(toListItem({ ...api, serviceKey: 'mortal_international', serviceType: 'Mortal Remains Transportation — International', patientName: 'Late Asha' }), t);
    expect(v.person).toEqual({ label: "Deceased Person's Name", name: 'Late Asha' });
  });
  test('no other service\'s card has a person line, and a Mortal Remains card without a name has none either', () => {
    expect(cardView(toListItem({ ...api, serviceKey: 'ground', serviceType: 'Ground Ambulance' }), t).person).toBeNull();
    expect(cardView(toListItem({ ...api, patientName: '' }), t).person).toBeNull();
  });
  test('the card draws the line', () => {
    expect(read('components/requests/RequestCard.js')).toContain('v.person ?');
  });
});

describe('Request Details', () => {
  const stored = {
    id: 5, referenceNumber: 'REQ-1064', status: 'submitted', createdAt: '2026-11-17T08:00:00.000Z', serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal',
    transferScope: 'international', transportMode: 'private_charter', patientName: 'Suresh Kale', patientAge: 0, patientGender: 'Male', deceasedRelation: 'Brother',
    placeOfDeath: 'Rashid Hospital, Dubai', dateOfDeath: '2026-11-15T00:00:00.000Z', country: 'India', origin: 'Dubai', destination: 'Pune', patientContact: '+91 98765 43210',
    preferredDate: '2026-11-20T00:00:00.000Z', urgency: 'urgent_24h',
    description: 'Transfer Scope: International\nTransport Mode: Private Charter\n\nAdditional Details: Please arrange a hearse.',
    case: { id: 9, documents: [{ id: 1, type: 'Supporting Document', name: 'certificate.pdf', fileSizeBytes: 2048, uploadedAt: '2026-11-17T09:00:00.000Z' }] },
  };

  test('Transfer Scope and Transport Mode are separate structured fields, and the header lines are not repeated in Details', () => {
    const v = detailsView(stored, t);
    expect(v.patient.fields.find((f) => f.key === 'name').label).toBe("Deceased Person's Name");
    expect(v.patient.fields.find((f) => f.key === 'scope')).toMatchObject({ label: 'Transfer Scope', value: 'International' });
    expect(v.patient.fields.find((f) => f.key === 'mode')).toMatchObject({ label: 'Transport Mode', value: 'Private Charter' });
    expect(v.medical.condition).toBe('Please arrange a hearse.');
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
    expect(v.patient.fields.find((f) => f.key === 'age').value).toBe('0');
  });
  test('a request with no Details shows no Details text', () => {
    expect(detailsView({ ...stored, description: 'Transfer Scope: Domestic\nTransport Mode: Ground Transportation' }, t).medical.condition).toBe('');
  });
  test('documents are shown as neutral supporting documents; a stored Death Certificate keeps its label', () => {
    const v = detailsView({ ...stored, case: { id: 9, documents: [stored.case.documents[0], { id: 2, type: 'Death Certificate', name: 'old.pdf', fileSizeBytes: 100, uploadedAt: '2026-10-01T00:00:00.000Z' }] } }, t);
    expect(v.documents[0].meta.startsWith('Supporting document')).toBe(true);
    expect(v.documents[1].meta.startsWith('Death certificate')).toBe(true);
  });
  test('an older request (key suffix, no scope or mode columns, plain description) reads as it always did', () => {
    const old = { ...stored, serviceKey: 'mortal_domestic', serviceType: 'Mortal Remains Transportation — Within India', transferScope: null, transportMode: null, description: 'Transfer to the hometown for the last rites' };
    const v = detailsView(old, t);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('scope');
    expect(v.trip.rows.map((r) => [r.label, r.value])).toEqual([['Preferred transfer date', '20 Nov 2026'], ['Transfer type', 'Within India']]);
    expect(v.medical.condition).toBe('Transfer to the hometown for the last rites');
    expect(v.patient.fields.find((f) => f.key === 'name').label).toBe("Deceased Person's Name");
  });
  test('userDetailsOf matches the server\'s helper', () => {
    for (const description of [stored.description, 'Transfer Scope: Domestic\nTransport Mode: Private Charter', 'plain text', 'Transfer Scope: x\nTransport Mode: y\n\nAdditional Details: a\n\nb', '', null, undefined]) {
      expect(M.userDetailsOf(description)).toBe(server.userDetailsOf(description));
    }
  });
});

describe('Tracking', () => {
  test('the row is labelled "Deceased Person\'s Name" for a Mortal Remains request, "Patient" for the others', () => {
    const screen = read('app/tracking.js');
    expect(screen).toContain("t(item.mortal ? 'lbl_deceased_name' : 'lbl_patient')");
    const item = trackingItemFromRequest({ id: 5, referenceNumber: 'REQ-1064', serviceType: 'Mortal Remains Transportation', serviceKey: 'mortal', status: 'submitted', patientName: 'Suresh Kale', patientAge: 64, patientGender: 'Male', createdAt: '2026-11-17T08:00:00.000Z' });
    expect(item.mortal).toBe(true);
    expect(item.patientLabel).toContain('Suresh Kale');
  });
});

describe('translations', () => {
  const NEW_KEYS = [
    'field_mortal_scope', 'field_mortal_mode', 'mortal_scope_domestic', 'mortal_scope_international', 'mortal_mode_private_charter', 'mortal_mode_commercial_air_cargo',
    'mortal_mode_ground_transportation', 'field_deceased_name_placeholder', 'req_death_docs', 'lbl_supporting_document', 'mortal_err_age', 'mortal_err_death_date',
    'mortal_err_transfer_date', 'mortal_err_too_long', 'mortal_upload_failed_files',
  ];
  test('every new string exists in all six languages, and the five others are not just the English text', () => {
    for (const key of NEW_KEYS) {
      expect({ key, en: typeof i18n.EN[key] === 'string' && i18n.EN[key].length > 0 }).toEqual({ key, en: true });
      for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
        expect({ key, lang, ok: typeof i18n[lang][key] === 'string' && i18n[lang][key].trim().length > 0 && i18n[lang][key] !== i18n.EN[key] }).toEqual({ key, lang, ok: true });
      }
    }
  });
  test('placeholders are kept in every language', () => {
    for (const key of ['mortal_err_age', 'mortal_err_too_long']) for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) expect(i18n[lang][key]).toContain('{{max}}');
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) expect(i18n[lang].mortal_upload_failed_files).toContain('{{names}}');
  });
});

describe('other services are untouched', () => {
  test('the generic Step 1 and Step 2 pages only gained the Mortal Remains hand-off', () => {
    const step1 = read('app/request/step1.js');
    const step2 = read('app/request/step2.js');
    expect(step1).toContain('if (isMortalService(draft.service)) return <MortalStep1 />;');
    expect(step2).toContain('if (isMortalService(draft.service)) return <MortalStep2 />;');
    expect(step1).toContain('isTeleService(draft.service) ? <TeleStep1 /> : <GenericStep1 />');
    expect(step2).toContain('isTeleService(draft.service) ? <TeleStep2 /> : <GenericStep2 />');
  });
  test('a Mortal Remains answer never leaks into another service\'s review', () => {
    const v = reviewView(draft({ service: 'hospital' }), { key: 'hospital', title: 'Hospital Assistance' }, t);
    expect(v.patient.fields.map((f) => f.key)).not.toEqual(expect.arrayContaining(['scope', 'mode']));
    expect(v.trip.rows.map((r) => r.key)).toEqual(['date']);
  });
});
