/* global describe, test, expect, __dirname */
// Marine Medical Safety (serviceKey "marine"): the dedicated Step 1 and Step 2, the rules, the payload, the description the server composes and how it is read back, the
// review and details display, and that older (generic) marine requests and every other service are untouched. The payload the app builds is also run through the REAL
// backend validator (no database), so the two sides cannot drift apart.
const fs = require('fs');
const path = require('path');
const {
  MARINE_SERVICE_KEY, MARINE_SERVICE_TYPE, MARINE_SCOPES, CRITICAL_LEVEL_KEYS, MARINE_TEXT, isMarineService, marineText, isValidMarineName, isValidMarineAge, isValidServiceDate,
  cityProblems, cityRef, contactE164, marineStep1Problems, marineStep2Problems, marineOxygenProblem, buildMarinePayload, chosenCriticalLevels, parseMarineDescription, isNewMarineRequest,
  marineFromRequest, freeTextProblem, codePointLength, HISTORY_MAX, NAME_MAX, CITY_MAX,
} = require('../marineMedicalSafety');
const backend = require('../../../../../backend/src/modules/requests/marine-medical-safety.validation');
const { reviewView, fieldsFor } = require('../reviewView');
const { detailsView } = require('../requestDetailsView');
const { draftForService } = require('../requestForm');
const { requestService, HOME_SERVICES, MAX_REPORT_FILES, MAX_REPORT_BYTES } = require('../../data/mock');
const SERVICES = require('../../data/services.json');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const NL = String.fromCharCode(10);
const code = (rel) => read(rel).split(NL).filter((line) => !line.trim().startsWith('//')).join(NL);
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const NOW = new Date(2026, 10, 17, 12, 0, 0); // 17 Nov 2026, the device's own calendar
const MUMBAI = { geonameId: 1, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' };
const CHENNAI = { geonameId: 2, name: 'Chennai', label: 'Chennai, Tamil Nadu, India', countryCode: 'IN' };
const DUBAI = { geonameId: 3, name: 'Dubai', label: 'Dubai, Dubai, United Arab Emirates', countryCode: 'AE' };
const draft = (extra = {}) => ({
  service: 'marine', serviceScope: 'international', name: 'Asha Nair', age: '61', gender: 'Female', country: 'India', countryIso: 'IN', cc: '+91', phoneCountry: 'IN', phone: '98765 43210',
  location: MUMBAI.label, originCity: MUMBAI, dest: DUBAI.label, destCity: DUBAI, date: '', desc: '', marineCare: [], marineOxygen: 'no', oxygenLpm: '', files: [], ...extra,
});
const ids = (list) => list.filter(([, bad]) => bad).map(([id]) => id);

describe('navigation: Marine opens its own workflow, not the generic form', () => {
  test('the tile is still on Home and All Services (same data, same position), and opens the service page', () => {
    expect(HOME_SERVICES.map((s) => s.key)).toEqual(['air', 'tele', 'homecare', 'ground', 'mortal', 'corporate', 'marine', 'medvalue']);
    const grid = read('components/ServiceGrid.js');
    expect(grid).toContain('router.push(`/service/${key}`)');
    expect(read('app/(tabs)/home.js')).toContain('(s.route ? router.push(s.route) : openService(s.key))');
    expect(read('app/all-services.js')).toContain('(s.route ? router.push(s.route) : openService(s.key))');
  });
  test('"Request this service" starts the form for the key marine (the existing service page, unchanged)', () => {
    const page = read('app/service/[key].js');
    expect(page).toContain('resetDraft(key);');
    expect(page).toContain("router.push('/request/step1')");
    expect(requestService({ service: 'marine' }, SERVICES)).toEqual({ title: 'Marine Medical Safety', key: 'marine' });
    expect(isMarineService('marine')).toBe(true);
    expect(isMarineService('medvalue')).toBe(false);
  });
  test('Step 1 and Step 2 are Marine\'s own components for the key marine, placed after Home and Medical Value Travel and before the generic form', () => {
    const s1 = read('app/request/step1.js');
    const s2 = read('app/request/step2.js');
    expect(s1).toContain('if (isMarineService(draft.service)) return <MarineStep1 />;');
    expect(s2).toContain('if (isMarineService(draft.service)) return <MarineStep2 />;');
    expect(s1.indexOf('<MvtStep1 />')).toBeLessThan(s1.indexOf('<MarineStep1 />'));
    expect(s1.indexOf('<MarineStep1 />')).toBeLessThan(s1.indexOf('<GenericStep1 />'));
    expect(s2.indexOf('<MarineStep2 />')).toBeLessThan(s2.indexOf('<GenericStep2 />'));
    expect(s1.match(/isMarineService/g)).toHaveLength(2); // the import and the one routing line
    expect(s2.match(/isMarineService/g)).toHaveLength(2);
  });
  test('the name the app sends is the name the server requires', () => {
    expect(MARINE_SERVICE_TYPE).toBe(backend.MARINE_SERVICE_TYPE);
    expect(MARINE_SERVICE_KEY).toBe(backend.MARINE_SERVICE_KEY);
    expect(SERVICES.marine.title).toBe(MARINE_SERVICE_TYPE);
  });
});

describe('Step 1: Service Scope, patient, country, contact, origin and destination', () => {
  test('the page order, and the labels', () => {
    const step1 = read('components/request/MarineStep1.js');
    expect([...step1.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1])).toEqual(['scope', 'name', 'age', 'country', 'phone', 'location', 'dest']);
    expect(MARINE_TEXT.marine_scope).toBe('Service Scope');
    expect(MARINE_TEXT.marine_origin).toBe('Origin City / Port');
    expect(MARINE_TEXT.marine_destination).toBe('Destination City / Port');
  });
  test('a complete Step 1 has no problem; an empty one lists every required field in page order', () => {
    expect(ids(marineStep1Problems(draft()))).toEqual([]);
    expect(ids(marineStep1Problems({ service: 'marine', cc: '+91', phoneCountry: 'IN', name: '', age: '', gender: '', countryIso: '', phone: '', location: '', dest: '', serviceScope: '' })))
      .toEqual(['scope', 'name', 'age', 'country', 'phone', 'location', 'dest']);
  });
  test.each([
    ['scope', { serviceScope: '' }, ['scope']],
    ['name', { name: '' }, ['name']],
    ['age', { age: '' }, ['age']],
    ['gender', { gender: '' }, ['age']],
    ['country', { country: '', countryIso: '' }, ['country']],
    ['contact number', { phone: '' }, ['phone']],
    ['origin', { location: '', originCity: null }, ['location']],
    ['destination', { dest: '', destCity: null }, ['dest']],
  ])('a missing %s is caught', (_n, extra, expected) => {
    expect(ids(marineStep1Problems(draft(extra)))).toEqual(expected);
  });
  test('Service Scope: Domestic or International, nothing preselected, and the values are the server\'s', () => {
    expect(MARINE_SCOPES).toEqual(['domestic', 'international']);
    expect(Object.keys(backend.SCOPES)).toEqual(MARINE_SCOPES);
    expect(read('state/AppContext.js')).toContain("serviceScope: '', // 'domestic' | 'international' (never preselected)");
    expect(marineText(t, 'marine_scope_domestic')).toBe('Domestic');
    expect(marineText(t, 'marine_scope_international')).toBe('International');
  });
  test('name: 2 to 191 characters with a letter', () => {
    for (const ok of ['Jo', 'Asha Nair', 'A'.repeat(NAME_MAX)]) expect(isValidMarineName(ok)).toBe(true);
    for (const bad of ['', ' ', 'A', ' A ', 'A'.repeat(NAME_MAX + 1), '12345', 'A\nB']) expect(isValidMarineName(bad)).toBe(false);
  });
  test('age: a whole number from 0 to 129', () => {
    for (const ok of ['0', '1', '61', '129', 7]) expect(isValidMarineAge(ok)).toBe(true);
    for (const bad of ['', '130', '-1', '1.5', 'abc', '007', null, undefined]) expect(isValidMarineAge(bad)).toBe(false);
  });
  test('the contact number is sent in E.164', () => {
    expect(contactE164('+91', '98765 43210')).toBe('+919876543210');
    expect(contactE164('+971', '050 123 4567')).toBe('+971501234567');
  });
  test('the country is picked with the existing country picker (no default is applied: Country is required and chosen by the person)', () => {
    const step1 = read('components/request/MarineStep1.js');
    expect(step1).toContain("onPick={(code) => { setPicking(null); updateDraft(pickRequestCountry(draft, code)); }}");
    expect(step1).not.toContain('defaultCountryIso');
  });
});

describe('origin and destination: picked cities follow the scope, typed ones are kept exactly', () => {
  const places = (extra = {}) => cityProblems({ scope: 'international', countryIso: 'IN', location: MUMBAI.label, originCity: MUMBAI, dest: DUBAI.label, destCity: DUBAI, ...extra });
  test('Domestic: both picked cities must be in the selected country', () => {
    expect(places({ scope: 'domestic', destCity: CHENNAI, dest: CHENNAI.label })).toEqual({ location: null, dest: null });
    expect(places({ scope: 'domestic' }).dest).toBe('wrong_country');
    expect(places({ scope: 'domestic', countryIso: 'AE' }).location).toBe('wrong_country');
  });
  test('International: the origin in the selected country, the destination in a different one', () => {
    expect(places()).toEqual({ location: null, dest: null });
    expect(places({ destCity: CHENNAI, dest: CHENNAI.label }).dest).toBe('same_country');
    expect(places({ countryIso: 'AE' }).location).toBe('wrong_country');
  });
  test('typed cities and ports: required, and no country is claimed for them (either scope)', () => {
    for (const scope of ['domestic', 'international']) {
      expect(places({ scope, originCity: null, location: 'Port of Mumbai', destCity: null, dest: 'Port of Dubai' })).toEqual({ location: null, dest: null });
    }
    expect(places({ originCity: null, location: '  ' }).location).toBe('required');
    expect(places({ destCity: null, dest: '' }).dest).toBe('required');
    expect(places({ countryIso: '' })).toEqual({ location: null, dest: null }); // nothing to compare with yet
  });
  test('a picked place is sent as its id, a typed one exactly as typed (spaces and all), without an id', () => {
    expect(cityRef(MUMBAI, MUMBAI.label)).toEqual({ geonameId: 1 });
    expect(cityRef(null, '  Port   of Mumbai (Ballard Pier) ')).toEqual({ text: '  Port   of Mumbai (Ballard Pier) ' });
  });
  test('typed text is limited to one line of 191 characters', () => {
    expect(freeTextProblem('P'.repeat(CITY_MAX), { max: CITY_MAX, oneLine: true })).toBeNull();
    expect(freeTextProblem('P'.repeat(CITY_MAX + 1), { max: CITY_MAX, oneLine: true })).toBe('too_long');
    expect(freeTextProblem('a\nb', { max: CITY_MAX, oneLine: true })).toBe('one_line');
    expect(ids(marineStep1Problems(draft({ originCity: null, location: 'P'.repeat(CITY_MAX + 1) })))).toEqual(['location']);
  });
  test('both fields are the existing searchable CityField with manual input (never "structured"), and typing clears the picked city so no stale id is sent', () => {
    const step1 = read('components/request/MarineStep1.js');
    expect(step1.match(/<CityField/g)).toHaveLength(2);
    expect(step1.match(/structured=\{false\}/g)).toHaveLength(2);
    expect(step1).toContain('onChangeText={(location) => updateDraft({ location, originCity: null })}');
    expect(step1).toContain('onChangeText={(dest) => updateDraft({ dest, destCity: null })}');
    expect(step1).not.toContain('resolveTypedCity'); // a typed place is never silently turned into a verified one
  });
});

describe('Step 2: Date of Service, Medical History, Critical Level, Oxygen, reports', () => {
  test('the page order and the labels', () => {
    const step2 = read('components/request/MarineStep2.js');
    expect([...step2.matchAll(/<Anchor id="(\w+)"/g)].map((m) => m[1])).toEqual(['date', 'history', 'critical', 'oxygen', 'oxygenLpm', 'files']);
    expect(MARINE_TEXT.marine_date).toBe('Date of Service');
    expect(MARINE_TEXT.marine_history).toBe('Medical History');
    expect(MARINE_TEXT.marine_critical).toBe('Critical Level');
  });
  test('nothing the approved list excludes is on the page: no urgency, mobility, emergency contact, vessel, GPS, cardiac monitor or equipment item', () => {
    const src = code('components/request/MarineStep2.js') + code('components/request/MarineStep1.js') + code('lib/marineMedicalSafety.js');
    for (const word of ['urgency', 'mobility', 'emergency', 'vessel', 'Vessel', 'ship', 'gps', 'GPS', 'latitude', 'cardiac', 'Cardiac', 'equipVentilator', 'equipCardiac']) expect(src).not.toContain(word);
  });

  describe('Date of Service: optional, today or later', () => {
    test('empty and blank are fine; today and later are fine; the past and impossible days are not', () => {
      for (const ok of ['', '   ', '2026-11-17', '2026-11-18', '2027-01-01']) expect(isValidServiceDate(ok, NOW)).toBe(true);
      for (const bad of ['2026-11-16', '2000-01-01', '2026-02-30', '17/11/2026', 'today']) expect(isValidServiceDate(bad, NOW)).toBe(false);
      expect(ids(marineStep2Problems(draft({ date: '2026-11-16' }), NOW))).toEqual(['date']);
      expect(ids(marineStep2Problems(draft({ date: '' }), NOW))).toEqual([]);
    });
    test('it is the existing optional, clearable picker, reused unchanged (MvtDateField), with the past disabled', () => {
      expect(read('components/request/MarineStep2.js')).toContain("import { MvtDateField } from './MvtDateField';");
      const field = read('components/request/MvtDateField.js');
      expect(field).toContain('minimumDate={earliest}');
      expect(field).toContain('min={todayString()}');
      expect(field).toContain("onChange('')");
    });
  });

  describe('Medical History: optional, 2,000 characters, kept exactly', () => {
    test('empty and whitespace-only are not sent; meaningful text is sent exactly, with its whitespace and line breaks', () => {
      expect(buildMarinePayload(draft(), NOW)).not.toHaveProperty('medicalHistory');
      expect(buildMarinePayload(draft({ desc: '   \n\t ' }), NOW)).not.toHaveProperty('medicalHistory');
      const text = '  Chest pain.\r\nSecond line third \u{1F600} é  ';
      expect(buildMarinePayload(draft({ desc: text }), NOW).medicalHistory).toBe(text);
    });
    test('2,000 characters are fine, 2,001 are not; an emoji counts as one character', () => {
      expect(freeTextProblem('h'.repeat(HISTORY_MAX), { max: HISTORY_MAX })).toBeNull();
      expect(freeTextProblem('h'.repeat(HISTORY_MAX + 1), { max: HISTORY_MAX })).toBe('too_long');
      expect(freeTextProblem('\u{1F600}'.repeat(HISTORY_MAX), { max: HISTORY_MAX })).toBeNull();
      expect(freeTextProblem('\u{1F600}'.repeat(HISTORY_MAX + 1), { max: HISTORY_MAX })).toBe('too_long');
      expect(ids(marineStep2Problems(draft({ desc: 'h'.repeat(2001) }), NOW))).toEqual(['history']);
      expect(ids(marineStep2Problems(draft({ desc: 'h'.repeat(2000) }), NOW))).toEqual([]);
      expect(freeTextProblem('a\u0000b', { max: HISTORY_MAX })).toBe('characters');
    });
    test('it is the existing Condition & Diagnosis text area (the draft\'s desc), relabelled, with a counter, and not required', () => {
      const step2 = read('components/request/MarineStep2.js');
      expect(step2).toContain('value={draft.desc} onChangeText={(desc) => updateDraft({ desc })}');
      expect(step2).toContain("<FieldHeader title={marineText(t, 'marine_history')} hint=");
      expect(step2).not.toMatch(/<FieldHeader title=\{marineText\(t, 'marine_history'\)\}[^>]*required/);
    });
  });

  describe('Critical Level: optional, several allowed, the four approved keys', () => {
    test('the four options in order, and the keys the server accepts', () => {
      expect(CRITICAL_LEVEL_KEYS).toEqual(['crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo']);
      expect(CRITICAL_LEVEL_KEYS).toEqual(backend.CRITICAL_LEVELS);
      expect(CRITICAL_LEVEL_KEYS.map(t)).toEqual(['ICU', 'Ventilated', 'Tracheostomy', 'ECMO']);
    });
    test('no selection is valid and nothing is sent; one, several and all four are sent as the keys, in the order chosen', () => {
      expect(ids(marineStep2Problems(draft({ marineCare: [] }), NOW))).toEqual([]);
      expect(buildMarinePayload(draft(), NOW)).not.toHaveProperty('careLevel');
      for (const key of CRITICAL_LEVEL_KEYS) expect(buildMarinePayload(draft({ marineCare: [key] }), NOW).careLevel).toBe(key);
      expect(buildMarinePayload(draft({ marineCare: ['crit_ecmo', 'crit_icu'] }), NOW).careLevel).toBe('crit_ecmo,crit_icu');
      expect(buildMarinePayload(draft({ marineCare: ['crit_tracheostomy', 'crit_icu', 'crit_ecmo', 'crit_ventilated'] }), NOW).careLevel).toBe('crit_tracheostomy,crit_icu,crit_ecmo,crit_ventilated');
    });
    test('only the four approved keys, each once, can ever be sent', () => {
      expect(chosenCriticalLevels({ marineCare: ['crit_icu', 'care_icu', 'crit_icu', 'ICU', 'crit_ecmo'] })).toEqual(['crit_icu', 'crit_ecmo']);
      expect(chosenCriticalLevels({ marineCare: null })).toEqual([]);
      expect(chosenCriticalLevels({})).toEqual([]);
    });
    test('"Ventilated" is a Critical Level option, not an equipment item: it is sent in careLevel and never as equipVentilator', () => {
      const body = buildMarinePayload(draft({ marineCare: ['crit_ventilated'] }), NOW);
      expect(body.careLevel).toBe('crit_ventilated');
      expect(body).not.toHaveProperty('equipVentilator');
    });
    test('it is the existing multi-select chips, and a draft key of its own (so another service never inherits Marine\'s keys)', () => {
      const step2 = read('components/request/MarineStep2.js');
      expect(step2).toMatch(/multiple columns=\{2\} label=\{marineText\(t, 'marine_critical'\)\} value=\{draft\.marineCare\}/);
      expect(step2).toContain("options={CRITICAL_LEVEL_KEYS.map((key) => ({ value: key, label: t(key) }))}");
      expect(step2).not.toMatch(/draft\.care\b/);
    });
  });

  describe('Oxygen: not answered, Yes (flow rate required), No (flow rate cleared)', () => {
    test('it starts unanswered and must be answered before the page can continue', () => {
      expect(read('state/AppContext.js')).toContain("marineOxygen: '', // 'yes' | 'no' | '' (not answered yet: it must be answered before sending)");
      expect(marineOxygenProblem(draft({ marineOxygen: '' }))).toBe('unanswered');
      expect(marineOxygenProblem({})).toBe('unanswered');
      expect(marineOxygenProblem(draft({ marineOxygen: 'maybe' }))).toBe('unanswered');
      expect(ids(marineStep2Problems(draft({ marineOxygen: '' }), NOW))).toEqual(['oxygen']);
    });
    test('Yes needs a flow rate; a valid one clears the page', () => {
      expect(marineOxygenProblem(draft({ marineOxygen: 'yes', oxygenLpm: '' }))).toBe('lpm_required');
      expect(marineOxygenProblem(draft({ marineOxygen: 'yes', oxygenLpm: '  ' }))).toBe('lpm_required');
      expect(ids(marineStep2Problems(draft({ marineOxygen: 'yes', oxygenLpm: '' }), NOW))).toEqual(['oxygenLpm']);
      for (const ok of ['0.5', '1', '2.5', '4', '15', '0,5', ' 3 ']) expect({ ok, problem: marineOxygenProblem(draft({ marineOxygen: 'yes', oxygenLpm: ok })) }).toEqual({ ok, problem: null });
    });
    test.each([['0'], ['-1'], ['15.1'], ['16'], ['2.55'], ['abc'], ['1e1'], ['.5'], ['100'], ['1.']])('Yes with the flow rate %p is invalid', (value) => {
      expect(marineOxygenProblem(draft({ marineOxygen: 'yes', oxygenLpm: value }))).toBe('lpm_invalid');
      expect(ids(marineStep2Problems(draft({ marineOxygen: 'yes', oxygenLpm: value }), NOW))).toEqual(['oxygenLpm']);
    });
    test('No needs no flow rate, and a leftover one is never sent', () => {
      expect(marineOxygenProblem(draft({ marineOxygen: 'no', oxygenLpm: '' }))).toBeNull();
      const body = buildMarinePayload(draft({ marineOxygen: 'no', oxygenLpm: '4' }), NOW);
      expect(body.equipOxygen).toBe(false);
      expect(body).not.toHaveProperty('equipOxygenLpm');
    });
    test('Yes sends true and the flow rate as a number; "0,5" from a decimal-comma keyboard becomes 0.5', () => {
      expect(buildMarinePayload(draft({ marineOxygen: 'yes', oxygenLpm: '4' }), NOW)).toMatchObject({ equipOxygen: true, equipOxygenLpm: 4 });
      expect(buildMarinePayload(draft({ marineOxygen: 'yes', oxygenLpm: '0,5' }), NOW)).toMatchObject({ equipOxygen: true, equipOxygenLpm: 0.5 });
    });
    test('the screen hides and clears the flow rate unless Oxygen is Yes, and only asks for it then', () => {
      const step2 = read('components/request/MarineStep2.js');
      expect(step2).toContain("updateDraft(marineOxygen === 'yes' ? { marineOxygen } : { marineOxygen, oxygenLpm: '' })");
      expect(step2).toContain("{draft.marineOxygen === 'yes' && (");
      expect(step2).toContain('keyboardType="decimal-pad" maxLength={4}');
    });
  });

  describe('Medical Reports: optional, the shared tiles with their shared limits', () => {
    test('nothing is required about them', () => {
      expect(ids(marineStep2Problems(draft({ files: [] }), NOW))).toEqual([]);
    });
    test('the shared limits: 10 files, 10 MB each, PDF, JPG, PNG, WEBP, DOC and DOCX', () => {
      expect(MAX_REPORT_FILES).toBe(10);
      expect(MAX_REPORT_BYTES).toBe(10 * 1024 * 1024);
      const fields = read('components/request/fields.js');
      const types = /ALLOWED_MIME_TYPES = \[([\s\S]*?)\];/.exec(fields)[1];
      expect([...types.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ]);
      expect(fields).toContain("toast(t('req_file_type'))");
      expect(fields).toContain("toast(t('req_file_big'))");
      expect(fields).toContain("toast(t('req_file_max')");
    });
    test('Step 2 uses the existing ReportTiles with no limit of its own (removal and the picker are the shared ones)', () => {
      const step2 = read('components/request/MarineStep2.js');
      expect(step2).toContain("<ReportTiles title={t('req_reports')} files={draft.files} onChange={(files) => updateDraft({ files })} />");
      expect(step2).not.toContain('maxFiles');
      expect(step2).not.toContain('multiple=');
      expect(read('components/request/fields.js')).toMatch(/onChange\(files\.filter/);
    });
    test('the files go up one by one after the request is saved, through the same upload call; a refused or unconfirmed file does not undo the request and is listed on the next screen (Phase 5)', () => {
      const review = read('app/request/review.js');
      expect(review).toContain('apiUpload(`/requests/me/${sent.id}/documents`, file, false, onProgress, fieldsFor(file)');
      expect(review).toContain('await sendWithDocuments(buildBody);');
    });
  });
});

describe('what is sent', () => {
  const sent = (extra, now = NOW) => buildMarinePayload(draft(extra), now);
  test('the structured body: exactly the Phase 2 contract fields', () => {
    expect(sent({ date: '2026-12-01', desc: 'Stable.', marineCare: ['crit_icu', 'crit_ecmo'], marineOxygen: 'yes', oxygenLpm: '4' })).toEqual({
      serviceType: 'Marine Medical Safety', serviceKey: 'marine', serviceScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+919876543210', originCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, medicalHistory: 'Stable.', preferredDate: '2026-12-01',
      careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, utcOffsetMinutes: 0 - NOW.getTimezoneOffset(),
    });
  });
  test('the smallest body: required fields and Oxygen No only', () => {
    expect(sent()).toEqual({
      serviceType: 'Marine Medical Safety', serviceKey: 'marine', serviceScope: 'international', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female', country: 'IN',
      patientContact: '+919876543210', originCity: { geonameId: 1 }, destinationCity: { geonameId: 3 }, equipOxygen: false, utcOffsetMinutes: 0 - NOW.getTimezoneOffset(),
    });
  });
  test('never sends an excluded field, or a description, origin or destination of its own', () => {
    const body = sent({ urgency: 'urgent_24h', mobility: 'walking', equipCardiac: true, equipVentilator: true, care: ['care_icu'], desc: 'x', dest: 'Dubai' });
    for (const key of ['urgency', 'mobility', 'equipCardiacMonitor', 'equipVentilator', 'emergencyContact', 'vesselName', 'shipName', 'gpsCoordinates', 'description', 'origin', 'destination', 'patientLocation', 'transferScope', 'details']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(Object.keys(body).every((key) => backend.validateMarineRequest({ [key]: 1 }).error !== `${key} is not accepted for Marine Medical Safety requests`)).toBe(true); // every key sent is one the server allows
  });
  test('typed places are sent exactly as typed, without an id', () => {
    const body = sent({ originCity: null, location: '  Port   of Mumbai ', destCity: null, dest: 'Port of Dubai' });
    expect(body.originCity).toEqual({ text: '  Port   of Mumbai ' });
    expect(body.destinationCity).toEqual({ text: 'Port of Dubai' });
  });
  test('the UTC offset is the device\'s, minutes east of UTC', () => {
    expect(buildMarinePayload(draft(), { getTimezoneOffset: () => -330 }).utcOffsetMinutes).toBe(330);
    expect(buildMarinePayload(draft(), { getTimezoneOffset: () => 300 }).utcOffsetMinutes).toBe(-300);
  });

  describe('the REAL backend validator accepts what the app builds (and maps it as intended)', () => {
    const cities = (b) => ({
      originCity: b.originCity.geonameId ? { 1: MUMBAI, 2: CHENNAI, 3: DUBAI }[b.originCity.geonameId] : undefined,
      destinationCity: b.destinationCity.geonameId ? { 1: MUMBAI, 2: CHENNAI, 3: DUBAI }[b.destinationCity.geonameId] : undefined,
    });
    const real = (extra) => { const b = sent(extra); return backend.validateMarineRequest(b, { now: new Date('2026-11-17T12:00:00Z'), cities: cities(b) }); };
    test.each([
      ['the smallest request', {}],
      ['a full request', { date: '2026-12-01', desc: '  Stable.\r\nSecond line  ', marineCare: ['crit_ecmo', 'crit_icu'], marineOxygen: 'yes', oxygenLpm: '2.5' }],
      ['Domestic with two picked cities', { serviceScope: 'domestic', destCity: CHENNAI, dest: CHENNAI.label }],
      ['typed places', { originCity: null, location: '  Port of Mumbai ', destCity: null, dest: 'Port of Singapore' }],
      ['Oxygen No with a leftover flow rate', { marineOxygen: 'no', oxygenLpm: '4' }],
      ['all four Critical Levels', { marineCare: ['crit_tracheostomy', 'crit_icu', 'crit_ecmo', 'crit_ventilated'] }],
      ['an emoji history', { desc: 'ok \u{1F600}' }],
    ])('%s', (_n, extra) => {
      const { data, error } = real(extra);
      expect(error).toBeUndefined();
      expect(data).toMatchObject({ serviceKey: 'marine', country: 'India', patientContact: '+919876543210' });
    });
    test('the stored description is the one the app reads back, and its history is exactly what was typed', () => {
      const typed = '  Stable.\r\nSecond line  ';
      const { data } = real({ desc: typed, serviceScope: 'domestic', destCity: CHENNAI, dest: CHENNAI.label });
      expect(parseMarineDescription(data.description)).toEqual({ ok: true, history: typed });
      expect(backend.parseMarineDescription(data.description)).toEqual(parseMarineDescription(data.description));
      expect(data.transferScope).toBe('domestic');
    });
    test('Oxygen: Yes stores the number, No stores false and no flow rate', () => {
      expect(real({ marineOxygen: 'yes', oxygenLpm: '4' }).data).toMatchObject({ equipOxygen: true, equipOxygenLpm: 4 });
      expect(real({ marineOxygen: 'no', oxygenLpm: '4' }).data).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
    });
    test('the app\'s scope rules agree with the server\'s on picked cities', () => {
      for (const extra of [{ serviceScope: 'domestic' }, { destCity: CHENNAI, dest: CHENNAI.label }, { country: 'United Arab Emirates', countryIso: 'AE' }]) {
        const b = sent(extra);
        const app = ids(marineStep1Problems(draft(extra))).length > 0;
        const server = !!backend.validateMarineRequest(b, { now: new Date('2026-11-17T12:00:00Z'), cities: cities(b) }).error;
        expect({ extra, app, server }).toEqual({ extra, app: true, server: true });
      }
    });
  });

  test('submitting goes through this builder only for marine, placed after Medical Value Travel and before the generic body', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('isMarineService(d.service) ? buildMarinePayload(d)'); // send() adds the idempotency key (Phase 4); the body is built lazily and sent by sendWithDocuments (Phase 5)
    expect(review.indexOf('buildMvtPayload(d)')).toBeLessThan(review.indexOf('buildMarinePayload(d)'));
    expect(review.indexOf('buildMarinePayload(d)')).toBeLessThan(review.indexOf('patientLocation: d.location,'));
    for (const keep of ['buildMortalPayload(d)', 'buildHomePayload(d)', 'buildMvtPayload(d)', 'buildTelePayload(d)', 'buildPrivateCharterPayload(charterDraft)']) expect(review).toContain(keep);
  });
  test('errors and success are handled by the existing submit code: a server refusal keeps the form and shows the message, success opens the confirmation with the reference', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('const fields = fieldErrorsFromError(err, t);');
    expect(review).toContain('toast(errorText(err, t));');
    expect(review).toContain("navReplace({ pathname: '/request/submitted', params: { id: request.referenceNumber, requestId: request.id, service: serviceTitle } });");
    expect(review).toContain('} finally {');
    expect(review).toContain('setBusy(false);');
  });
});

describe('the words on screen: translations come later, English until then', () => {
  test('every key has an English default shown while no translation exists, and a translation added later under the same key wins', () => {
    for (const key of Object.keys(MARINE_TEXT)) expect(marineText(t, key, { max: 129, country: 'India' })).not.toBe(key);
    expect(marineText(t, 'marine_err_age', { max: 129 })).toBe('Enter an age from 0 to 129.');
    const translated = (key, values) => (key === 'marine_scope' ? 'सेवा का दायरा' : t(key, values));
    expect(marineText(translated, 'marine_scope')).toBe('सेवा का दायरा');
    expect(marineText(translated, 'marine_history')).toBe('Medical History');
  });
  test('no translation file was touched: no marine_ key is in it, and the screens read only keys that already existed', () => {
    expect(JSON.stringify(i18n)).not.toMatch(/"marine_/);
    for (const file of ['components/request/MarineStep1.js', 'components/request/MarineStep2.js']) {
      for (const match of read(file).matchAll(/\bt\('([a-z_0-9]+)'/g)) expect({ file, key: match[1], exists: typeof i18n.EN[match[1]] === 'string' }).toEqual({ file, key: match[1], exists: true });
    }
  });
});

describe('the description the server composes, read back', () => {
  const VECTORS = ['', 'Stable.', 'Marine Medical Safety v1 (history 0)\nMedical History:\nfake', '\nMedical History:\n x \r\n', '\u{1F600}\u{1F468}‍\u{1F469} é 日本語', '   x   ', 'z'.repeat(2000), '\u{1F600}'.repeat(2000)];
  test.each(VECTORS.map((v, i) => [i, v]))('the app reads back exactly what the server composed: %#', (_i, history) => {
    const text = backend.composeMarineDescription({ history });
    expect(parseMarineDescription(text)).toEqual({ ok: true, history });
    expect(backend.parseMarineDescription(text)).toEqual(parseMarineDescription(text));
  });
  const INVALID = [
    'free text', '', 'Marine Medical Safety v1 ()', 'Marine Medical Safety v2 (history 0)', 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology',
    'Marine Medical Safety v1 (history 01)\nMedical History:\nx', 'Marine Medical Safety v1 (history 4001)\nMedical History:\nx', 'Marine Medical Safety v1 (history 0)\n',
    'Marine Medical Safety v1 (history 0)\nextra', 'Marine Medical Safety v1 (history 3)', 'Marine Medical Safety v1 (history 3)\nHistory:\nabc',
    'Marine Medical Safety v1 (history 9)\nMedical History:\nshort', 'Marine Medical Safety v1 (history 2)\nMedical History:\nlonger', 'Marine Medical Safety v1 (history 1)\nMedical History:\n\u{1F600}', null, undefined, 5,
  ];
  test.each(INVALID.map((v, i) => [i, v]))('a description that does not parse is legacy, in the app and on the server alike: %#', (_i, text) => {
    expect(parseMarineDescription(text).ok).toBe(false);
    expect(backend.parseMarineDescription(text).ok).toBe(false);
  });
});

describe('a new request and an older one', () => {
  const NEW = {
    id: 9, referenceNumber: 'REQ-1009', status: 'submitted', serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'Asha Nair', patientAge: 61, patientGender: 'Female',
    country: 'India', patientContact: '+919876543210', origin: MUMBAI.label, destination: DUBAI.label, preferredDate: '2026-12-01T00:00:00.000Z', urgency: null, transferScope: 'international',
    careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4, description: backend.composeMarineDescription({ history: 'Chest pain.' }), createdAt: '2026-11-17T10:00:00.000Z', case: null, requestDocuments: [],
  };
  const OLD = { ...NEW, referenceNumber: 'REQ-901', transferScope: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null, urgency: 'planned', description: 'Engine-room burn.' };
  const rows = (list) => Object.fromEntries(list.map((r) => [r.key, r.value]));

  test('only a request with the key, a real scope and a parsing description is new', () => {
    expect(isNewMarineRequest(NEW)).toBe(true);
    expect(isNewMarineRequest(OLD)).toBe(false);
    expect(isNewMarineRequest({ ...NEW, transferScope: null })).toBe(false);
    expect(isNewMarineRequest({ ...NEW, description: 'Engine-room burn.' })).toBe(false);
    expect(isNewMarineRequest({ ...NEW, serviceKey: 'mortal' })).toBe(false);
    expect(isNewMarineRequest({ ...NEW, serviceKey: 'medvalue' })).toBe(false);
    expect(isNewMarineRequest(null)).toBe(false);
    expect(marineFromRequest(NEW, t)).toEqual({ scope: 'International', history: 'Chest pain.', levels: 'ICU, ECMO', oxygen: 'Oxygen (4 LPM)' });
    expect(marineFromRequest(OLD, t)).toBeNull();
    expect(marineFromRequest({ ...NEW, equipOxygen: false, equipOxygenLpm: null }, t).oxygen).toBe('No');
    expect(marineFromRequest({ ...NEW, equipOxygen: null, equipOxygenLpm: null }, t).oxygen).toBeNull();
  });
  test('Request Details: Service Scope first, the two places, then Date of Service, Critical Level, Oxygen and the Medical History; no urgency', () => {
    const v = detailsView(NEW, t);
    expect(v.patient.fields[0]).toMatchObject({ key: 'scope', label: 'Service Scope', value: 'International' });
    expect(v.trip).toMatchObject({ from: MUMBAI.label, to: DUBAI.label, rows: [] });
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('Chest pain.');
    expect(v.medical.details.map((r) => [r.key, r.label])).toEqual([['serviceDate', 'Date of Service'], ['criticalLevel', 'Critical Level'], ['oxygen', 'Oxygen']]);
    expect(rows(v.medical.details)).toMatchObject({ criticalLevel: 'ICU, ECMO', oxygen: 'Oxygen (4 LPM)' });
    expect(v.medical.urgency).toBeNull();
    expect(v.medical.equipment).toBeNull();
  });
  test('Request Details: rows that were not answered are left out', () => {
    const v = detailsView({ ...NEW, preferredDate: null, careLevel: null, equipOxygen: null, equipOxygenLpm: null, description: backend.composeMarineDescription({}) }, t);
    expect(v.medical.details).toEqual([]);
    expect(v.medical.condition).toBe('');
  });
  test('Request Details: an older request reads exactly as before (Condition & diagnosis, its urgency, no scope)', () => {
    const v = detailsView(OLD, t);
    expect(v.patient.fields.map((f) => f.key)).not.toContain('scope');
    expect(v.medical.conditionLabel).toBe('Condition & diagnosis');
    expect(v.medical.condition).toBe('Engine-room burn.');
    expect(v.medical.details).toEqual([]);
    expect(v.medical.urgency).toBeTruthy();
    expect(v.trip.rows.map((r) => r.key)).toContain('date');
  });
  test('Mortal Remains and Medical Value Travel still show their own scope labels', () => {
    const mortal = detailsView({ ...NEW, serviceKey: 'mortal', serviceType: 'Mortal Remains Transportation', transportMode: 'ground_transportation', transferScope: 'domestic', description: 'Transfer Scope: Domestic\nTransport Mode: Ground Transportation' }, t);
    expect(mortal.patient.fields.find((f) => f.key === 'scope').label).toBe('Transfer Scope');
    const mvt = detailsView({ ...NEW, serviceKey: 'medvalue', serviceType: 'Medical Value Travel', description: 'Medical Value Travel v1 (other 0, history 0)\nSpecialty: Oncology' }, t);
    expect(mvt.patient.fields[0].label).toBe('Treatment scope');
  });
});

describe('the review page', () => {
  const view = (extra = {}) => reviewView(draft({ date: '2026-12-01', desc: 'Chest pain.', marineCare: ['crit_ecmo', 'crit_icu'], marineOxygen: 'yes', oxygenLpm: '4', files: [{ uri: 'file:///x/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1000 }], ...extra }), { key: 'marine', title: 'Marine Medical Safety' }, t);
  test('shows the Service Scope with the patient, the places as the trip, and the date, Critical Level, Oxygen and Medical History as the medical details; no urgency', () => {
    const v = view();
    expect(v.patient.fields.map((f) => f.key)).toEqual(['scope', 'name', 'age', 'gender', 'country', 'contact']);
    expect(v.patient.fields[0]).toMatchObject({ label: 'Service Scope', value: 'International' });
    expect(v.trip).toMatchObject({ from: MUMBAI.label, to: DUBAI.label, rows: [] });
    expect(v.medical.conditionLabel).toBe('Medical History');
    expect(v.medical.condition).toBe('Chest pain.');
    expect(v.medical.details.map((r) => [r.key, r.value])).toEqual([['serviceDate', '01 Dec 2026'], ['criticalLevel', 'ECMO, ICU'], ['oxygen', 'Oxygen (4 LPM)']]);
    expect(v.medical.urgency).toBeNull();
    expect(v.documents).toHaveLength(1);
    expect(v.show).toMatchObject({ patient: true, trip: true, medical: true, documents: true });
  });
  test('Oxygen No shows "No"; with no date, no Critical Level, no history and no reports those rows and sections are simply left out', () => {
    const v = view({ date: '', marineCare: [], desc: '', marineOxygen: 'no', oxygenLpm: '', files: [] });
    expect(v.medical.details.map((r) => [r.key, r.value])).toEqual([['oxygen', 'No']]);
    expect(v.medical.condition).toBe('');
    expect(v.show.documents).toBe(false);
  });
  test('every field the form collects has a place on the page, and no excluded field does', () => {
    const keys = Object.keys(fieldsFor('marine'));
    for (const key of ['serviceScope', 'marineCare', 'marineOxygen', 'oxygenLpm', 'date', 'name', 'country', 'location', 'dest', 'desc', 'files']) expect(keys).toContain(key);
    for (const key of ['urgency', 'mobility', 'care', 'equipOxygen', 'equipCardiac', 'equipVentilator', 'treatmentScope']) expect(keys).not.toContain(key);
  });
});

describe('draft state', () => {
  test('the three Marine fields start empty/unanswered and are cleared when the service is swapped', () => {
    const app = read('state/AppContext.js');
    for (const line of ["serviceScope: '',", 'marineCare: [],', "marineOxygen: '',"]) expect(app).toContain(line);
    const swapped = draftForService({ ...draft(), changingService: true }, 'hospital', { service: 'air' });
    expect(swapped).toMatchObject({ serviceScope: '', marineCare: [], marineOxygen: '', oxygenLpm: '' });
    expect(swapped.name).toBe('Asha Nair'); // the patient is kept, as for every swap
    const into = draftForService({ service: 'hospital', changingService: true, name: 'A', serviceScope: 'domestic', marineCare: ['crit_icu'], marineOxygen: 'yes' }, 'marine', { service: 'air' });
    expect(into).toMatchObject({ serviceScope: '', marineCare: [], marineOxygen: '' });
  });
  test('moving between the steps keeps what was entered: the answers live in the shared draft, not in the screens', () => {
    for (const file of ['components/request/MarineStep1.js', 'components/request/MarineStep2.js']) {
      const src = read(file);
      expect(src).toContain('useApp()');
      expect(src).toContain('updateDraft');
    }
    // the form's own frame (back and forward) is the shared one
    expect(read('components/request/MarineStep1.js')).toContain("onNext={() => router.push('/request/step2')}");
    expect(read('components/request/MarineStep2.js')).toContain("onNext={() => router.push('/request/review')}");
  });
});

describe('Medical History length: the app counts exactly what the server counts', () => {
  // Both sides count UNICODE CODE POINTS (Array.from(text).length), never UTF-16 code units and never "what looks like one character": an ASCII letter and an emoji are
  // one each, a precomposed accent is one, a decomposed accent ("e" + a combining mark) is two, a family emoji (three people joined by zero-width joiners) is five and a
  // flag is two. A line break counts as it is typed ("\n" one, "\r\n" two). The limit is 2,000 code points. The stored description is framed in UTF-16 code units (an emoji
  // is two there), which is why 2,000 emoji (4,000 units) is the largest framing the parser accepts. These tests drive the REAL backend validator with the same text.
  const cp = (...codes) => String.fromCodePoint(...codes);
  const EMOJI = cp(0x1f600);
  const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const FLAG = cp(0x1f1ee, 0x1f1f3);
  const ACCENT = cp(0xe9);
  const DECOMPOSED = `e${cp(0x301)}`;
  const KANJI = cp(0x65e5, 0x672c, 0x8a9e);
  const NOW_UTC = new Date('2026-11-17T12:00:00Z');
  // the real server validator, given the text itself (the app's builder leaves a whitespace-only history out, so the text is set on the body directly to test the limit)
  const serverSays = (history) => backend.validateMarineRequest(
    { ...buildMarinePayload(draft(), NOW), medicalHistory: history }, { now: NOW_UTC, cities: { originCity: MUMBAI, destinationCity: DUBAI } },
  ).error;
  const TOO_LONG = 'medicalHistory can be at most 2000 characters';
  // a mixed, multi-line text built to a chosen length: lines of mixed scripts joined by CRLF, then padded with ASCII to exactly `target` code points
  const mixed = (target) => {
    const block = ['Chest pain since 04:00.', `${EMOJI} ${FAMILY} ${FLAG}`, `${ACCENT}${DECOMPOSED} ${KANJI}`, '  indented line  ', ''].join('\r\n');
    const base = block.repeat(Math.floor(target / Array.from(block).length));
    return base + 'x'.repeat(target - Array.from(base).length);
  };

  test.each([
    ['2,000 ASCII characters', 'a'.repeat(2000), 2000, 2000, false],
    ['2,001 ASCII characters', 'a'.repeat(2001), 2001, 2001, true],
    ['1,000 emoji (2,000 UTF-16 units, 1,000 characters)', EMOJI.repeat(1000), 1000, 2000, false],
    ['1,001 emoji (still only 1,001 characters, so accepted)', EMOJI.repeat(1001), 1001, 2002, false],
    ['2,000 emoji (the largest accepted: 4,000 UTF-16 units)', EMOJI.repeat(2000), 2000, 4000, false],
    ['2,001 emoji', EMOJI.repeat(2001), 2001, 4002, true],
    ['2,000 precomposed accents', ACCENT.repeat(2000), 2000, 2000, false],
    ['2,001 precomposed accents', ACCENT.repeat(2001), 2001, 2001, true],
    ['1,000 decomposed accents (2 code points each = 2,000)', DECOMPOSED.repeat(1000), 2000, 2000, false],
    ['1,001 decomposed accents (2,002 code points)', DECOMPOSED.repeat(1001), 2002, 2002, true],
    ['400 family emoji (5 code points each = 2,000; 8 UTF-16 units each)', FAMILY.repeat(400), 2000, 3200, false],
    ['401 family emoji (2,005 code points)', FAMILY.repeat(401), 2005, 3208, true],
    ['1,000 flags (2 code points each = 2,000)', FLAG.repeat(1000), 2000, 4000, false],
    ['1,001 flags (2,002 code points)', FLAG.repeat(1001), 2002, 4004, true],
    ['1,000 CRLF line breaks (2 characters each = 2,000)', '\r\n'.repeat(1000), 2000, 2000, false],
    ['2,000 LF line breaks', '\n'.repeat(2000), 2000, 2000, false],
    ['2,001 LF line breaks', '\n'.repeat(2001), 2001, 2001, true],
    ['mixed multi-line Unicode of exactly 2,000 characters', mixed(2000), 2000, null, false],
    ['mixed multi-line Unicode of 2,001 characters', mixed(2001), 2001, null, true],
  ])('%s', (_name, text, characters, units, tooLong) => {
    // the length, as the app counts it, is the number of Unicode code points
    expect(codePointLength(text)).toBe(characters);
    expect(Array.from(text)).toHaveLength(characters);
    if (units !== null) expect(text.length).toBe(units); // the UTF-16 length that frames the stored description (documented above)
    // the app and the server agree on this exact text
    const appProblem = freeTextProblem(text, { required: false, max: HISTORY_MAX });
    expect(appProblem).toBe(tooLong ? 'too_long' : null);
    expect(ids(marineStep2Problems(draft({ desc: text }), NOW))).toEqual(tooLong ? ['history'] : []);
    const error = serverSays(text);
    if (tooLong) expect(error).toBe(TOO_LONG);
    else expect(error).toBeUndefined();
  });

  test('the limit is the same number on both sides, and the counter the person sees uses the same count', () => {
    expect(HISTORY_MAX).toBe(2000);
    expect(backend.HISTORY_MAX).toBe(HISTORY_MAX);
    const step2 = read('components/request/MarineStep2.js');
    expect(step2).toContain('hint={`${codePointLength(draft.desc)}/${HISTORY_MAX}`}');
    expect(codePointLength(EMOJI.repeat(1000))).toBe(1000);
  });

  test('an accepted text is stored with its UTF-16 length in the header and read back exactly (also at the 4,000-unit extreme)', () => {
    for (const text of [EMOJI.repeat(2000), mixed(2000), FAMILY.repeat(400), 'a'.repeat(2000)]) {
      const stored = backend.composeMarineDescription({ history: text });
      expect(stored.startsWith(`Marine Medical Safety v1 (history ${text.length})\nMedical History:\n`)).toBe(true);
      expect(parseMarineDescription(stored)).toEqual({ ok: true, history: text });
      expect(backend.parseMarineDescription(stored)).toEqual({ ok: true, history: text });
    }
  });

  test('what is sent is the text exactly, never trimmed, normalised or re-counted (the NFD accents stay two code points)', () => {
    const text = `  ${DECOMPOSED}${ACCENT}\r\n${EMOJI}  `;
    expect(buildMarinePayload(draft({ desc: text }), NOW).medicalHistory).toBe(text);
    expect(Array.from(text)).toHaveLength(2 + 2 + 1 + 2 + 1 + 2);
  });

  test('a character the server cannot save is refused on both sides, whatever the length', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u007fb', 'a\ud83db', 'a\ude00b']) {
      expect(freeTextProblem(bad, { required: false, max: HISTORY_MAX })).toBe('characters');
      expect(serverSays(bad)).toBe('medicalHistory contains characters that cannot be saved');
    }
  });
});

describe('the Marine service page figures', () => {
  test('the page shows no statistics at all (none the official website supports); the description, feature bullets, picture and branding are unchanged', () => {
    const marine = SERVICES.marine;
    expect(marine.stats).toEqual([]); // an empty list, not a missing one: the page draws whatever list the service has
    expect(JSON.stringify(marine.stats)).not.toMatch(/Ports Covered|100\+|Years Experience|21\+|Tele-Medical Advice|24\/7/);
    expect(JSON.stringify(marine)).not.toMatch(/Ports Covered|100\+|Years Experience|21\+/);
    expect(marine.title).toBe('Marine Medical Safety');
    expect(marine.desc).toBe('Medical support for crews and passengers at sea: 24/7 tele-medical guidance for the ship, coordination of port-side care and hospital admission, and medical evacuation when a patient must be brought ashore.');
    expect(marine.features).toEqual([
      '24/7 Tele-Medical Advice for the Vessel', 'Port-Side Ambulance & Hospital Coordination', 'Medical Evacuation & Repatriation', 'Crew Illness & Injury Case Management',
    ]);
    expect(marine.img).toBe('IMG_AIR');
  });
  test('every other service page keeps its figures exactly (none of them lost an entry)', () => {
    for (const [key, entry] of Object.entries(SERVICES)) {
      if (key === 'marine') continue;
      expect({ key, stats: entry.stats.length >= 3 }).toEqual({ key, stats: true });
    }
    expect(SERVICES.medvalue.stats).toHaveLength(3);
  });
  test('the page code that draws the figures is unchanged: it draws whatever the service lists, in a row of equal cards', () => {
    const page = read('app/service/[key].js');
    expect(page).toContain('{content.stats.map((st) => ('); // the same cards, now from the translated content (its English is local.stats)
    expect(page).toContain('className="flex-1 items-center justify-center px-1.5 py-3"');
  });
});

describe('isolation: nothing else was changed to get here', () => {
  test('the new lib imports nothing from another service\'s lib', () => {
    const lib = read('lib/marineMedicalSafety.js');
    const imports = [...lib.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./requestForm', './validators', 'libphonenumber-js']);
  });
  test('the other services\' Step 1 and Step 2 components do not know about Marine', () => {
    for (const file of ['HomeStep1', 'HomeStep2', 'MortalStep1', 'MortalStep2', 'TeleStep1', 'TeleStep2', 'MvtStep1', 'MvtStep2', 'MvtDateField']) {
      expect(read(`components/request/${file}.js`)).not.toMatch(/marineMedicalSafety|Marine/);
    }
  });
  test('the generic Step 1 and Step 2 (hospital, ground, the airlines ...) keep their own forms and routing', () => {
    expect(read('app/request/step1.js')).toContain('function GenericStep1()');
    expect(read('app/request/step2.js')).toContain('function GenericStep2()');
    for (const keep of ['isHomeService', 'isMvtService', 'isMortalService', 'isTeleService']) {
      expect(read('app/request/step1.js') + read('app/request/step2.js')).toContain(keep);
    }
  });
  test('the generic Marine request an older build sends is still what the server expects: the generic path is not required to change', () => {
    expect(backend.isMarineStructuredRequest({ serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai', description: 'x', urgency: 'planned' })).toBe(false);
  });
  test('the Marine service page content is the one that was there (the page, its description and its features)', () => {
    expect(SERVICES.marine.title).toBe('Marine Medical Safety');
    expect(SERVICES.marine.features).toHaveLength(4);
    expect(SERVICES.marine.img).toBe('IMG_AIR');
  });
});
