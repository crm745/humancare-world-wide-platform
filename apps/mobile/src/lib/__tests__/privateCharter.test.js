/* global describe, it, expect, __dirname */
// The Private Charter request the app builds, checked against the REAL backend validator (run by
// plain Node as the server runs it), plus the mapping of the API's field errors back onto the form.
const { spawnSync } = require('child_process');
const path = require('path');
const {
  PRIVATE_CHARTER_KEY, PRIVATE_CHARTER_SERVICE_TYPE, normalizeServiceKey, isPrivateCharter, buildPrivateCharterPayload,
  contactE164, isPrivateCharterAge, fieldErrorsFromError, clearErrorsForPatch, firstErrorLocation, firstAnchorOnStep, unplacedMessages,
  toCityChoice, API_FIELD_LOCATION,
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
  date: '2099-01-01', care: ['care_icu', 'care_stable'], desc: 'Post-angioplasty', mobility: 'bedridden',
  equipOxygen: true, equipCardiac: false, equipVentilator: false, urgency: 'urgent_24h', files: [], ...over,
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
      'careLevel', 'country', 'description', 'destination', 'equipCardiacMonitor', 'equipOxygen', 'equipVentilator', 'mobility', 'origin',
      'patientAge', 'patientContact', 'patientGender', 'patientName', 'preferredDate', 'serviceKey', 'serviceType', 'urgency',
    ]);
    expect(body).not.toHaveProperty('patientLocation');
    expect(body).not.toHaveProperty('deceasedRelation');
  });

  it('sends the formats that are stored: lower-case gender, E.164 number, ISO country, key list, YYYY-MM-DD', () => {
    expect(wire(draft())).toMatchObject({
      serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Maria Fernandez', patientAge: 61,
      patientGender: 'female', patientContact: '+971501234567', country: 'AE', preferredDate: '2099-01-01',
      careLevel: ['care_icu', 'care_stable'], description: 'Post-angioplasty', mobility: 'bedridden',
      equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false, urgency: 'urgent_24h',
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
      careLevel: 'care_icu,care_stable', description: 'Post-angioplasty', mobility: 'bedridden', urgency: 'urgent_24h',
      equipOxygen: true, equipCardiacMonitor: false, equipVentilator: false,
    });
  });

  it('accepts every care-level choice, mobility, urgency, gender and a missing description', () => {
    const variants = [
      draft({ care: ['care_na'] }), draft({ care: ['care_ambulatory'], mobility: 'walking', urgency: 'planned' }),
      draft({ care: ['care_icu', 'care_stable', 'care_ambulatory'], mobility: 'wheelchair', urgency: 'critical_6h' }),
      draft({ gender: 'Male' }), draft({ gender: 'Other' }), draft({ desc: '' }),
      draft({ equipOxygen: true, equipCardiac: true, equipVentilator: true }),
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
    expect(validateOne(wire(draft({ destCity: { geonameId: 123456789 } }))).fields.destination).toBe('Select a valid city from the list.');
  });

  it('no care level, no mobility, no urgency, a past date, an age over 120', () => {
    const fields = validate([
      wire(draft({ care: [] })), wire(draft({ mobility: '' })), wire(draft({ urgency: '' })), wire(draft({ date: '2001-01-01' })), wire(draft({ age: '121' })),
    ]).map((r) => r.fields);
    expect(fields[0].careLevel).toBe('Select at least one care level.');
    expect(fields[1].mobility).toBe('Mobility is required.');
    expect(fields[2].urgency).toBe('Urgency is required.');
    expect(fields[3].preferredDate).toBe('Preferred date cannot be in the past.');
    expect(fields[4].patientAge).toBe('Age must be a whole number from 1 to 120.');
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
    expect(firstErrorLocation({ urgency: 'm', patientName: 'm' })).toEqual({ step: 1, anchor: 'name' });
    expect(firstErrorLocation({ urgency: 'm', careLevel: 'm' })).toEqual({ step: 2, anchor: 'care' });
    expect(firstErrorLocation({ serviceKey: 'm' })).toEqual({ step: 0, anchor: null });
    expect(firstAnchorOnStep({ preferredDate: 'm', origin: 'm', patientGender: 'm' }, 1)).toBe('age');
    expect(firstAnchorOnStep({ preferredDate: 'm', origin: 'm' }, 1)).toBe('location');
    expect(firstAnchorOnStep({ preferredDate: 'm' }, 2)).toBeNull();
  });

  it('changing a field clears only that field\'s error, and the errors object is never edited in place', () => {
    const errors = { patientContact: 'a', origin: 'b', careLevel: 'c' };
    expect(clearErrorsForPatch(errors, { phone: '5' })).toEqual({ origin: 'b', careLevel: 'c' });
    expect(clearErrorsForPatch(errors, { originCity: MUMBAI, location: MUMBAI.label })).toEqual({ patientContact: 'a', careLevel: 'c' });
    expect(clearErrorsForPatch(errors, { files: [] })).toBe(errors);
    expect(clearErrorsForPatch({ origin: 'b' }, { location: 'x' })).toBeNull();
    expect(clearErrorsForPatch(null, { name: 'x' })).toBeNull();
    expect(errors).toEqual({ patientContact: 'a', origin: 'b', careLevel: 'c' });
  });

  it('the answers are untouched by an error: building the payload again gives the same body', () => {
    const d = draft();
    const before = JSON.stringify(wire(d));
    fieldErrorsFromError(apiError({ origin: 'x' }));
    expect(JSON.stringify(wire(d))).toBe(before);
    expect(d.originCity).toEqual(MUMBAI);
    expect(d.care).toEqual(['care_icu', 'care_stable']);
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
    expect(requestService({ service: 'mortal', mortalTransfer: 'domestic' }, SERVICES).key).toBe('mortal_domestic');
    expect(requestService({ service: 'mortal', mortalTransfer: 'international' }, SERVICES).key).toBe('mortal_international');
  });
});
