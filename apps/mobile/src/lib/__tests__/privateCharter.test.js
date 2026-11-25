/* global describe, it, expect, __dirname */
// The Private Charter request the app builds, checked against the REAL backend validator (run by
// plain Node as the server runs it), plus the mapping of the API's field errors back onto the form.
const { spawnSync } = require('child_process');
const path = require('path');
const {
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE, normalizeServiceKey, isPrivateCharter, buildPrivateCharterPayload,
  contactE164, isPrivateCharterAge, fieldErrorsFromError, clearErrorsForPatch, firstErrorLocation, firstAnchorOnStep, unplacedMessages,
  toCityChoice, API_FIELD_LOCATION, toManualCity, isManualCity, isManualCityName, cityRef, orderedCriticalLevels, toggleCriticalLevel,
} = require('../privateCharter');
const { COUNTRIES } = require('../../data/countryList');
const SERVICES = require('../../data/services.json');

const backendDir = path.resolve(__dirname, '..', '..', '..', '..', '..', 'backend');

// Runs the backend validator on each body. The cities are looked up from the backend's own test
// fixtures by geonameId, standing for the server's GeoNames table.
function validate(bodies) {
  const script = `
    const { validatePrivateCharterRequest } = require('./src/modules/requests/private-charter.validation');
    const { ROWS } = require('./tests/fixtures/geo-cities');
    const city = (id) => { const c = ROWS.find((r) => r.geonameId === id); return c && { geonameId: c.geonameId, name: c.name, label: c.name, countryCode: c.countryCode, timezone: c.timezone }; };
    const bodies = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    console.log(JSON.stringify(bodies.map((b) => {
      const ref = (v) => (v && typeof v === 'object' ? city(v.geonameId) : undefined);
      const { fields, data, legacy } = validatePrivateCharterRequest(b, { cities: { origin: ref(b.origin), destination: ref(b.destination) } });
      return { fields, data, legacy };
    })));`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: backendDir, encoding: 'utf8', input: JSON.stringify(bodies), maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`backend validator failed to run: ${out.stderr}`);
  return JSON.parse(out.stdout);
}
const validateOne = (body) => validate([body])[0];

const MUMBAI = { geonameId: 1275339, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' };
const DUBAI = { geonameId: 292223, name: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' };
const draft = (over = {}) => ({
  service: 'privatecharter', name: 'Maria Fernandez', age: '61', gender: 'Female', location: MUMBAI.label, originCity: MUMBAI,
  dest: DUBAI.label, destCity: DUBAI, country: 'United Arab Emirates', countryIso: 'AE', cc: '+971', phoneCountry: 'AE', phone: '50 123 4567',
  date: '2099-01-01', travelType: 'patient_transfer', desc: 'Post-angioplasty', criticalLevel: ['icu'],
  oxygenRequired: true, oxygenFlowLpm: '4', files: [], ...over,
});
const wire = (d) => JSON.parse(JSON.stringify(buildPrivateCharterPayload(d))); // what actually goes over the network

describe('service key', () => {
  it('sends the generic "air" service as privatecharter, never as air', () => {
    expect(normalizeServiceKey('air')).toBe('privatecharter');
    expect(isPrivateCharter('air')).toBe(true);
    expect(isPrivateCharter('privatecharter')).toBe(true);
    expect(buildPrivateCharterPayload(draft({ service: 'air' })).serviceKey).toBe('privatecharter');
  });

  it('sends the service name the backend expects, the same as the one the app shows', () => {
    expect(PRIVATE_CHARTER_KEY).toBe('privatecharter');
    expect(SERVICES.privatecharter.title).toBe(PRIVATE_CHARTER_SERVICE_TYPE);
    const { PRIVATE_CHARTER_SERVICE_TYPE: backendName } = JSON.parse(spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/common/constants/request.constants')))"], { cwd: backendDir, encoding: 'utf8' }).stdout);
    expect(backendName).toBe(PRIVATE_CHARTER_SERVICE_TYPE);
  });

  it('leaves every other service as it was', () => {
    for (const key of ['commercialair', 'ground', 'hospital', 'homecare', 'tele', 'mortal', 'escort', 'corporate']) {
      expect(normalizeServiceKey(key)).toBe(key);
      expect(isPrivateCharter(key)).toBe(false);
    }
  });
});

describe('the Private Charter payload', () => {
  it('has exactly the fields the backend allows, and no patientLocation', () => {
    const body = wire(draft());
    expect(Object.keys(body).sort()).toEqual([
      'country', 'criticalLevel', 'description', 'destination', 'origin', 'oxygenFlowLpm', 'oxygenRequired',
      'patientAge', 'patientContact', 'patientGender', 'patientName', 'preferredDate', 'serviceKey', 'serviceType', 'travelType',
    ]);
    // The removed fields are never sent.
    for (const gone of ['careLevel', 'mobility', 'urgency', 'equipOxygen', 'equipCardiacMonitor', 'equipVentilator']) expect(body).not.toHaveProperty(gone);
    expect(body).not.toHaveProperty('patientLocation');
    expect(body).not.toHaveProperty('deceasedRelation');
  });

  it('sends the formats that are stored: lower-case gender, E.164 number, ISO country, key lists, YYYY-MM-DD', () => {
    expect(wire(draft())).toMatchObject({
      serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Maria Fernandez', patientAge: 61,
      patientGender: 'female', patientContact: '+971501234567', country: 'AE', preferredDate: '2099-01-01',
      travelType: 'patient_transfer', description: 'Post-angioplasty', criticalLevel: ['icu'], oxygenRequired: true, oxygenFlowLpm: 4,
    });
  });

  it('sends each city as { geonameId } and nothing else', () => {
    const body = wire(draft());
    expect(body.origin).toEqual({ geonameId: 1275339 });
    expect(body.destination).toEqual({ geonameId: 292223 });
  });

  it('is accepted by the backend validator, stored as intended, with no legacy format used', () => {
    const { fields, data, legacy } = validateOne(wire(draft()));
    expect(fields).toEqual({});
    expect(legacy).toEqual([]);
    expect(data).toMatchObject({
      serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
      country: 'AE', origin: MUMBAI.name, originGeonameId: 1275339, destinationGeonameId: 292223, preferredDate: '2099-01-01',
      travelType: 'patient_transfer', description: 'Post-angioplasty', criticalLevel: ['icu'], oxygenRequired: true, oxygenFlowLpm: 4,
    });
  });

  it('accepts every travel type, critical level, gender, oxygen answer and a missing medical history', () => {
    const variants = [
      draft({ travelType: 'organ_transfer' }), draft({ criticalLevel: ['ventilated'] }), draft({ criticalLevel: ['tracheostomy'] }), draft({ criticalLevel: ['ecmo'] }), draft({ criticalLevel: ['ecmo', 'icu'] }),
      draft({ gender: 'Male' }), draft({ gender: 'Other' }), draft({ desc: '' }),
      draft({ oxygenRequired: false, oxygenFlowLpm: '' }), draft({ oxygenFlowLpm: '1' }), draft({ oxygenFlowLpm: '60' }),
    ];
    for (const result of validate(variants.map(wire))) {
      expect(result.fields).toEqual({});
      expect(result.legacy).toEqual([]);
    }
  });
});

describe('ISO country codes', () => {
  it('sends the code, not the name', () => {
    expect(wire(draft({ country: 'India', countryIso: 'IN' })).country).toBe('IN');
    expect(wire(draft({ country: 'United Kingdom', countryIso: 'GB' })).country).toBe('GB');
  });

  it('leaves the country out when none is picked, so the backend reports it missing', () => {
    expect(wire(draft({ country: '', countryIso: '' }))).not.toHaveProperty('country');
    expect(validateOne(wire(draft({ country: '', countryIso: '' }))).fields.country).toBe('Country is required.');
  });

  it('every country the app can pick is accepted by the backend', () => {
    const results = validate(COUNTRIES.map((c) => wire(draft({ country: c.name, countryIso: c.code }))));
    const refused = results.map((r, i) => (r.fields.country ? COUNTRIES[i].code : null)).filter(Boolean);
    expect(refused).toEqual([]);
  });

  it('a country name is refused by the backend (so it must never be sent)', () => {
    expect(validateOne({ ...wire(draft()), country: 'India' }).fields.country).toMatch(/ISO 3166-1/);
  });
});

describe('contact number', () => {
  it('is sent in E.164 whatever spacing the person typed', () => {
    for (const typed of ['50 123 4567', '501234567', '050-123-4567', '(50) 123 4567']) {
      expect(contactE164('+971', typed)).toBe('+971501234567');
    }
    expect(wire(draft({ cc: '+91', phone: '98765 43210' })).patientContact).toBe('+919876543210');
  });

  it('the backend accepts it as it is (no legacy reformatting)', () => {
    const result = validateOne(wire(draft({ cc: '+91', phone: '98765 43210' })));
    expect(result.fields).toEqual({});
    expect(result.data.patientContact).toBe('+919876543210');
    expect(result.legacy).toEqual([]);
  });

  it('a number that is not valid is not turned into one', () => {
    expect(contactE164('+971', '12')).toBeNull();
    expect(validateOne(wire(draft({ phone: '12' }))).fields.patientContact).toBeTruthy();
  });
});

describe('missing or invalid data is refused by the backend, not hidden by the app', () => {
  it('no origin city: the origin is left out and reported', () => {
    const body = wire(draft({ originCity: null, location: 'Mumbai' }));
    expect(body).not.toHaveProperty('origin');
    expect(validateOne(body).fields.origin).toBe('Origin city is required.');
  });

  it('no destination city: the destination is left out and reported', () => {
    const body = wire(draft({ destCity: null }));
    expect(body).not.toHaveProperty('destination');
    expect(validateOne(body).fields.destination).toBe('Destination city is required.');
  });

  it('a free-text place is never sent as a city', () => {
    const body = wire(draft({ originCity: null, location: 'Mumbai, India' }));
    expect(JSON.stringify(body)).not.toContain('Mumbai');
  });

  it('a city the server does not know is refused', () => {
    expect(validateOne(wire(draft({ destCity: { geonameId: 123456789 } }))).fields.destination).toBe('Select a valid city from the list, or enter the city name.');
  });

  it('Oxygen No sends no flow rate, even if one was typed before', () => {
    const body = wire(draft({ oxygenRequired: false, oxygenFlowLpm: '8' }));
    expect(body.oxygenRequired).toBe(false);
    expect(body).not.toHaveProperty('oxygenFlowLpm');
    expect(validateOne(body).fields).toEqual({});
  });

  it('Oxygen Yes needs a whole flow rate from 1 to 60; the server refuses anything else', () => {
    const bodies = [wire(draft({ oxygenFlowLpm: '' })), { ...wire(draft()), oxygenFlowLpm: 0 }, { ...wire(draft()), oxygenFlowLpm: 61 }, { ...wire(draft()), oxygenFlowLpm: 2.5 }];
    for (const r of validate(bodies)) expect(r.fields.oxygenFlowLpm).toBeTruthy();
    expect(validateOne({ ...wire(draft({ oxygenRequired: false })), oxygenFlowLpm: 3 }).fields.oxygenFlowLpm).toMatch(/must not be sent/);
  });

  it('the removed fields are refused by the server, not silently dropped', () => {
    const fields = validateOne({ ...wire(draft()), careLevel: ['care_icu'], mobility: ['walking'], urgency: 'planned', equipOxygen: true }).fields;
    for (const gone of ['careLevel', 'mobility', 'urgency', 'equipOxygen']) expect(fields[gone]).toBeTruthy();
  });

  it('no travel type, no critical level, no oxygen answer, a past date, an age over 120', () => {
    const fields = validate([
      wire(draft({ travelType: '' })), wire(draft({ criticalLevel: [] })), wire(draft({ oxygenRequired: null })), wire(draft({ date: '2001-01-01' })), wire(draft({ age: '121' })),
    ]).map((r) => r.fields);
    expect(fields[0].travelType).toBe('Travel type is required.');
    expect(fields[1].criticalLevel).toBe('Select at least one critical level.');
    expect(fields[2].oxygenRequired).toBe('Oxygen required is required.');
    expect(fields[3].preferredDate).toBe('Preferred date cannot be in the past.');
    expect(fields[4].patientAge).toBeTruthy();
  });

  it('an unknown travel type or critical level is refused', () => {
    const r = validateOne({ ...wire(draft()), travelType: 'cargo', criticalLevel: ['stable'] }).fields;
    expect(r.travelType).toMatch(/must be one of/);
    expect(r.criticalLevel).toMatch(/must only contain/);
  });

  it('the form applies the same age limit before sending', () => {
    expect(isPrivateCharterAge('120')).toBe(true);
    expect(isPrivateCharterAge('121')).toBe(false);
    expect(isPrivateCharterAge('0')).toBe(false);
    expect(isPrivateCharterAge('')).toBe(false);
    expect(isPrivateCharterAge('6.5')).toBe(false);
  });

  it('toCityChoice keeps only what the server returned for the city', () => {
    expect(toCityChoice({ geonameId: 1, name: 'A', label: 'A, B', countryCode: 'XX', extra: 'no' })).toEqual({ geonameId: 1, name: 'A', label: 'A, B', countryCode: 'XX' });
  });
});

describe('API validation errors go back onto the form', () => {
  const apiError = (fields, status = 400) => Object.assign(new Error('Please correct the highlighted fields.'), { status, data: { error: 'Please correct the highlighted fields.', fields } });

  it('reads the fields of a 400, and nothing else', () => {
    expect(fieldErrorsFromError(apiError({ patientAge: 'Age is required.', country: 'Country is required.' }))).toEqual({ patientAge: 'Age is required.', country: 'Country is required.' });
    expect(fieldErrorsFromError(apiError({ origin: 'x' }, 500))).toBeNull();
    expect(fieldErrorsFromError(apiError({}))).toBeNull();
    expect(fieldErrorsFromError(new Error('network'))).toBeNull();
    expect(fieldErrorsFromError(Object.assign(new Error('x'), { status: 400, data: { error: 'Missing required field(s): origin' } }))).toBeNull();
    expect(fieldErrorsFromError(apiError({ origin: 5, destination: 'ok' }))).toEqual({ destination: 'ok' });
  });

  it('every field the validator can report is either placed on the form or reported as unplaced', () => {
    const { fields } = validateOne({ serviceType: 'wrong', patientLocation: 'x', surprise: 1 });
    const keys = Object.keys(fields);
    expect(keys).toEqual(expect.arrayContaining(['serviceType', 'patientLocation', 'surprise', 'patientName', 'origin']));
    for (const key of keys) {
      if (!API_FIELD_LOCATION[key]) expect(unplacedMessages({ [key]: 'm' })).toEqual(['m']);
    }
    // Every field the form can send has a place on the form.
    const sent = Object.keys(wire(draft())).filter((k) => !['serviceKey', 'serviceType'].includes(k));
    for (const key of sent) expect(API_FIELD_LOCATION).toHaveProperty(key);
  });

  it('takes the person to the earliest step with an error and its first field', () => {
    expect(firstErrorLocation({ oxygenRequired: 'm', patientName: 'm' })).toEqual({ step: 1, anchor: 'name' });
    expect(firstErrorLocation({ oxygenRequired: 'm', criticalLevel: 'm' })).toEqual({ step: 2, anchor: 'critical' });
    expect(firstErrorLocation({ travelType: 'm', criticalLevel: 'm' })).toEqual({ step: 1, anchor: 'travelType' });
    expect(firstErrorLocation({ serviceKey: 'm' })).toEqual({ step: 0, anchor: null });
    expect(firstAnchorOnStep({ preferredDate: 'm', origin: 'm', patientGender: 'm' }, 1)).toBe('age');
    expect(firstAnchorOnStep({ preferredDate: 'm', origin: 'm' }, 1)).toBe('location');
    expect(firstAnchorOnStep({ preferredDate: 'm' }, 2)).toBeNull();
  });

  it('changing a field clears only that field\'s error, and the errors object is never edited in place', () => {
    const errors = { patientContact: 'a', origin: 'b', criticalLevel: 'c' };
    expect(clearErrorsForPatch(errors, { phone: '5' })).toEqual({ origin: 'b', criticalLevel: 'c' });
    expect(clearErrorsForPatch(errors, { originCity: MUMBAI, location: MUMBAI.label })).toEqual({ patientContact: 'a', criticalLevel: 'c' });
    expect(clearErrorsForPatch(errors, { files: [] })).toBe(errors);
    expect(clearErrorsForPatch({ origin: 'b' }, { location: 'x' })).toBeNull();
    expect(clearErrorsForPatch(null, { name: 'x' })).toBeNull();
    expect(errors).toEqual({ patientContact: 'a', origin: 'b', criticalLevel: 'c' });
  });

  it('the answers are untouched by an error: building the payload again gives the same body', () => {
    const d = draft();
    const before = JSON.stringify(wire(d));
    fieldErrorsFromError(apiError({ origin: 'x' }));
    expect(JSON.stringify(wire(d))).toBe(before);
    expect(d.originCity).toEqual(MUMBAI);
    expect(d.criticalLevel).toEqual(['icu']);
  });
});

describe('Critical Level: multi-select', () => {
  it('tapping selects, tapping again deselects, and the list stays in the order of the form', () => {
    let list = [];
    list = toggleCriticalLevel(list, 'ecmo');
    expect(list).toEqual(['ecmo']);
    list = toggleCriticalLevel(list, 'icu');
    expect(list).toEqual(['icu', 'ecmo']);
    list = toggleCriticalLevel(list, 'tracheostomy');
    expect(list).toEqual(['icu', 'tracheostomy', 'ecmo']);
    list = toggleCriticalLevel(list, 'icu'); // deselected
    expect(list).toEqual(['tracheostomy', 'ecmo']);
    list = toggleCriticalLevel(toggleCriticalLevel(list, 'ecmo'), 'tracheostomy');
    expect(list).toEqual([]);
  });
  it('an older draft holding one key, or junk, is read as a clean list', () => {
    expect(orderedCriticalLevels('icu')).toEqual(['icu']);
    expect(orderedCriticalLevels('')).toEqual([]);
    expect(orderedCriticalLevels(undefined)).toEqual([]);
    expect(orderedCriticalLevels(['ecmo', 'ecmo', 'bogus', 'icu'])).toEqual(['icu', 'ecmo']);
  });
  it('is sent as an array and accepted by the backend for every combination of the four', () => {
    const bodies = [];
    for (let mask = 1; mask < 16; mask += 1) bodies.push(wire(draft({ criticalLevel: ['icu', 'ventilated', 'tracheostomy', 'ecmo'].filter((_, i) => mask & (1 << i)) })));
    for (const [i, result] of validate(bodies).entries()) {
      expect(Array.isArray(bodies[i].criticalLevel)).toBe(true);
      expect(result.fields).toEqual({});
      expect(result.data.criticalLevel).toEqual(bodies[i].criticalLevel);
    }
  });
  it('nothing chosen is sent as an empty list, which the backend refuses', () => {
    const body = wire(draft({ criticalLevel: [] }));
    expect(body.criticalLevel).toEqual([]);
    expect(validateOne(body).fields.criticalLevel).toBe('Select at least one critical level.');
  });
  it('a repeated or unknown key is cleaned before sending; the backend refuses them if one still arrives', () => {
    expect(wire(draft({ criticalLevel: ['ecmo', 'ecmo', 'bogus'] })).criticalLevel).toEqual(['ecmo']);
    expect(validateOne({ ...wire(draft()), criticalLevel: ['icu', 'icu'] }).fields.criticalLevel).toMatch(/repeat/);
    expect(validateOne({ ...wire(draft()), criticalLevel: 'icu' }).fields.criticalLevel).toMatch(/list/);
  });
});

describe('Origin City / Destination City: a GeoNames city or one entered by hand', () => {
  it('a manual city has no geonameId, keeps what was typed (cleaned) and the country context', () => {
    expect(toManualCity('  Smallville   North ', 'ae')).toEqual({ manual: true, name: 'Smallville North', label: 'Smallville North', countryCode: 'AE' });
    expect(toManualCity('Karachi', null)).toEqual({ manual: true, name: 'Karachi', label: 'Karachi', countryCode: null });
    expect(isManualCity(toManualCity('Karachi'))).toBe(true);
    expect(isManualCity(MUMBAI)).toBe(false);
    expect(toManualCity('Karachi')).not.toHaveProperty('geonameId');
  });
  it('is sent as { name, countryCode? }, a picked city as { geonameId }; nothing chosen sends nothing', () => {
    expect(cityRef(MUMBAI)).toEqual({ geonameId: 1275339 });
    expect(cityRef(toManualCity('Smallville', 'AE'))).toEqual({ name: 'Smallville', countryCode: 'AE' });
    expect(cityRef(toManualCity('Karachi', null))).toEqual({ name: 'Karachi' });
    expect(cityRef(null)).toBeUndefined();
    const body = wire(draft({ originCity: toManualCity('Smallville', 'IN'), destCity: DUBAI }));
    expect(body.origin).toEqual({ name: 'Smallville', countryCode: 'IN' });
    expect(body.destination).toEqual({ geonameId: 292223 });
  });
  it('the backend accepts a manual Origin City, a manual Destination City, or both, and stores no GeoNames id for them', () => {
    const [origin, destination, both] = validate([
      wire(draft({ originCity: toManualCity('Smallville', 'IN') })),
      wire(draft({ destCity: toManualCity('Karachi', null) })),
      wire(draft({ originCity: toManualCity('Smallville', 'IN'), destCity: toManualCity('Karachi', 'PK') })),
    ]);
    for (const r of [origin, destination, both]) expect(r.fields).toEqual({});
    expect(origin.data).toMatchObject({ origin: 'Smallville, India', originCityName: 'Smallville', originCountryCode: 'IN' });
    expect(origin.data).not.toHaveProperty('originGeonameId');
    expect(origin.data.destinationGeonameId).toBe(292223); // the picked one keeps its id
    expect(destination.data).toMatchObject({ destination: 'Karachi', destinationCityName: 'Karachi', destinationCountryCode: null });
    expect(destination.data).not.toHaveProperty('destinationGeonameId');
    expect(both.data).toMatchObject({ destination: 'Karachi, Pakistan', destinationCountryCode: 'PK' });
  });
  it('a city GeoNames does not know can be typed; text typed but not chosen is still never sent', () => {
    expect(JSON.stringify(wire(draft({ originCity: null, location: 'Nowhereville' })))).not.toContain('Nowhereville');
    expect(validateOne(wire(draft({ destCity: toManualCity('Nowhereville', null) }))).fields).toEqual({});
  });
  it('the form checks a manual name with the same rule as the backend', () => {
    for (const ok of ['Zürich', "St. John's", 'Saint-Étienne', '東京', 'Ab', 'A'.repeat(100)]) expect(isManualCityName(ok)).toBe(true);
    for (const bad of ['', ' ', 'A', '12345', '<b>x</b>', 'A'.repeat(101), 'Town?', null, undefined]) expect(isManualCityName(bad)).toBe(false);
  });
});

describe('requestService (the service name and key a request is sent under)', () => {
  const { requestService } = require('../../data/mock');

  it('the default "air" draft and the Private Charter tile are both sent as privatecharter, under the backend\'s name', () => {
    for (const service of ['air', 'privatecharter']) {
      expect(requestService({ service }, SERVICES)).toEqual({ title: 'Private Charter Air Ambulance Service', key: 'privatecharter' });
    }
  });

  it('every other service keeps the name and key it always had', () => {
    expect(requestService({ service: 'ground' }, SERVICES)).toEqual({ title: SERVICES.ground.title, key: 'ground' });
    expect(requestService({ service: 'hospital' }, SERVICES)).toEqual({ title: SERVICES.hospital.title, key: 'hospital' });
    expect(requestService({ service: 'commercialair', airlineMode: 'stretcher' }, SERVICES).key).toBe('commercialair_stretcher');
    expect(requestService({ service: 'commercialair', airlineMode: '' }, SERVICES).key).toBe('commercialair');
    // Mortal Remains is one service now ("mortal"): its scope and mode are their own fields, not a key suffix.
    expect(requestService({ service: 'mortal', mortalTransfer: 'domestic' }, SERVICES).key).toBe('mortal');
    expect(requestService({ service: 'mortal', transferScope: 'international', transportMode: 'private_charter' }, SERVICES)).toEqual({ title: SERVICES.mortal.title, key: 'mortal' });
  });
});
