// The revised Private Charter form: Travel Type, Critical Level, Oxygen Required (+ flow rate in LPM), Medical History.
// Pure: no database, no network (see jest.safe.config.js). Covers the validator, what is stored for a request, and what a patient's
// phone is sent back; the old fields are refused, never silently dropped.
const { validatePrivateCharterRequest } = require('../../src/modules/requests/private-charter.validation');
const { requestRecordData } = require('../../src/modules/requests/request-record');
const { toPatientRequest, REQUEST_FIELDS } = require('../../src/modules/requests/request-response');
const { readCityRef } = require('../../src/modules/geo/city-ref');
const {
  TRAVEL_TYPES, CRITICAL_LEVELS, criticalLevelList, criticalLevelColumn, criticalLevelText, CRITICAL_LEVEL_COLUMN_MAX,
} = require('../../src/common/constants/request.constants');

const CITIES = {
  origin: { geonameId: 1275339, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata' },
  destination: { geonameId: 292223, name: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE', timezone: 'Asia/Dubai' },
};
const valid = (over = {}) => ({
  serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service',
  patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567', country: 'AE',
  origin: { geonameId: 1275339 }, destination: { geonameId: 292223 }, preferredDate: '2099-01-01',
  travelType: 'patient_transfer', description: 'Post-angioplasty', criticalLevel: ['icu'], oxygenRequired: true, oxygenFlowLpm: 4, ...over,
});
const run = (body) => validatePrivateCharterRequest(body, { cities: CITIES });

describe('a valid revised request', () => {
  it('is accepted and keeps exactly the new fields', () => {
    const { fields, data, legacy } = run(valid());
    expect(fields).toEqual({});
    expect(legacy).toEqual([]);
    expect(data).toMatchObject({
      travelType: 'patient_transfer', description: 'Post-angioplasty', criticalLevel: ['icu'], oxygenRequired: true, oxygenFlowLpm: 4,
    });
    for (const gone of ['careLevel', 'mobility', 'urgency', 'equipOxygen', 'equipCardiacMonitor', 'equipVentilator']) expect(data).not.toHaveProperty(gone);
  });

  it.each(TRAVEL_TYPES)('accepts travel type %s', (travelType) => {
    expect(run(valid({ travelType })).data.travelType).toBe(travelType);
  });

  it.each(CRITICAL_LEVELS)('accepts critical level %s', (level) => {
    expect(run(valid({ criticalLevel: [level] })).data.criticalLevel).toEqual([level]);
  });

  it('the medical history is optional', () => {
    const { fields, data } = run(valid({ description: undefined }));
    expect(fields).toEqual({});
    expect(data.description).toBeUndefined();
    expect(run(valid({ description: '   ' })).data.description).toBeUndefined();
  });

  it('the allowed values are exactly the ones on the form', () => {
    expect(TRAVEL_TYPES).toEqual(['patient_transfer', 'organ_transfer']);
    expect(CRITICAL_LEVELS).toEqual(['icu', 'ventilated', 'tracheostomy', 'ecmo']);
  });
});

describe('Travel Type', () => {
  it.each([undefined, null, ''])('is required (%p)', (travelType) => {
    expect(run(valid({ travelType })).fields.travelType).toBe('Travel type is required.');
  });
  it.each(['cargo', 'Patient Transfer', 'PATIENT_TRANSFER', 1, true, [], ['patient_transfer'], {}])('refuses %p', (travelType) => {
    expect(run(valid({ travelType })).fields.travelType).toMatch(/Travel type must be one of/);
  });
});

describe('Critical Level (multi-select)', () => {
  it.each([undefined, null, '', []])('needs at least one choice (%p)', (criticalLevel) => {
    expect(run(valid({ criticalLevel })).fields.criticalLevel).toBe('Select at least one critical level.');
  });
  it.each(['icu', 'ICU', 1, true, {}])('must be a list: refuses %p', (criticalLevel) => {
    expect(run(valid({ criticalLevel })).fields.criticalLevel).toBe('Critical level must be a list of one or more choices.');
  });
  it.each([['stable'], ['ICU'], ['care_icu'], [1], [null], [['icu']], [{}], ['icu', 'stable'], ['icu', '']])('refuses an invalid value in the list: %j', (...levels) => {
    expect(run(valid({ criticalLevel: levels })).fields.criticalLevel).toMatch(/must only contain/);
  });
  it.each([['icu', 'icu'], ['ecmo', 'icu', 'ecmo'], ['icu', 'ventilated', 'tracheostomy', 'ecmo', 'ecmo']])('refuses a repeated choice: %j', (...levels) => {
    expect(run(valid({ criticalLevel: levels })).fields.criticalLevel).toMatch(/repeat|at most/);
  });
  it('accepts any combination of the four and returns it in the order of the form', () => {
    for (let mask = 1; mask < 16; mask += 1) {
      const chosen = CRITICAL_LEVELS.filter((_, i) => mask & (1 << i));
      const { fields, data } = run(valid({ criticalLevel: [...chosen].reverse() }));
      expect(fields).toEqual({});
      expect(data.criticalLevel).toEqual(chosen);
    }
  });
  it('the stored column holds every combination, and values stored before the multi-select still read', () => {
    expect(criticalLevelColumn(['ecmo', 'icu'])).toBe('icu,ecmo');
    expect(criticalLevelColumn(CRITICAL_LEVELS).length).toBeLessThanOrEqual(CRITICAL_LEVEL_COLUMN_MAX);
    expect(criticalLevelColumn([])).toBeNull();
    expect(criticalLevelColumn(null)).toBeNull();
    expect(criticalLevelList('icu')).toEqual(['icu']); // a single key stored earlier: a list of one
    expect(criticalLevelList('ecmo,icu')).toEqual(['icu', 'ecmo']);
    expect(criticalLevelList('icu,unknown, ecmo')).toEqual(['icu', 'ecmo']);
    expect(criticalLevelList(null)).toEqual([]);
    expect(criticalLevelText('icu,ecmo')).toBe('ICU, ECMO');
    expect(criticalLevelText('icu')).toBe('ICU');
  });
});

describe('Origin City and Destination City: GeoNames selection or manual entry', () => {
  it('a GeoNames selection keeps the id, the verified name, country and timezone', () => {
    const { fields, data } = run(valid());
    expect(fields).toEqual({});
    expect(data).toMatchObject({
      origin: 'Mumbai, Maharashtra, India', originGeonameId: 1275339, originCityName: 'Mumbai', originCountryCode: 'IN', originTimezone: 'Asia/Kolkata',
      destination: 'Dubai, United Arab Emirates', destinationGeonameId: 292223, destinationCityName: 'Dubai', destinationCountryCode: 'AE',
    });
  });

  it('a typed origin takes the request country as its context; no GeoNames id, the name cleaned', () => {
    const { fields, data } = run(valid({ origin: { name: '  Smallville   North ' } }));
    expect(fields).toEqual({});
    expect(data.origin).toBe('Smallville North, United Arab Emirates'); // the request's country (AE) is the context
    expect(data.originCityName).toBe('Smallville North');
    expect(data.originCountryCode).toBe('AE');
    expect(data).not.toHaveProperty('originGeonameId'); // never invented
    expect(data).not.toHaveProperty('originTimezone');
  });
  it('a typed destination does not borrow the request country (it may be anywhere); it keeps one only if given', () => {
    const plain = run(valid({ destination: { name: '  Karachi ' } }));
    expect(plain.fields).toEqual({});
    expect(plain.data).toMatchObject({ destination: 'Karachi', destinationCityName: 'Karachi', destinationCountryCode: null });
    expect(plain.data).not.toHaveProperty('destinationGeonameId');
    const withCountry = run(valid({ destination: { name: 'Karachi', countryCode: 'PK' } }));
    expect(withCountry.data).toMatchObject({ destination: 'Karachi, Pakistan', destinationCountryCode: 'PK' });
  });
  it('a manual city may name its own country; it wins over the request country', () => {
    const { fields, data } = run(valid({ origin: { name: 'Springfield', countryCode: 'US' } }));
    expect(fields).toEqual({});
    expect(data).toMatchObject({ origin: 'Springfield, United States', originCityName: 'Springfield', originCountryCode: 'US' });
    expect(data).not.toHaveProperty('originGeonameId');
  });
  it('a manual city has no country when the request has none (the country error is reported on its own field)', () => {
    const { fields, data } = run(valid({ country: undefined, origin: { name: 'Springfield' } }));
    expect(fields.country).toBe('Country is required.');
    expect(fields.origin).toBeUndefined();
    expect(data.origin).toBe('Springfield');
  });
  it('one city may be picked and the other typed', () => {
    const { fields, data } = run(valid({ destination: { name: 'Qasr Town', countryCode: 'AE' } }));
    expect(fields).toEqual({});
    expect(data.originGeonameId).toBe(1275339);
    expect(data).not.toHaveProperty('destinationGeonameId');
    expect(data.destinationCityName).toBe('Qasr Town');
    expect(data.destinationCountryCode).toBe('AE');
  });
  it('is not rejected for being absent from GeoNames: a manual city needs no verified record at all', () => {
    expect(validatePrivateCharterRequest(valid({ origin: { name: 'Nowhereville' }, destination: { name: 'Elsewhere' } }), { cities: {} }).fields).toEqual({});
  });
  it.each(['origin', 'destination'])('refuses a malformed manual city for %s', (field) => {
    const bad = [
      [{ name: '' }, /City name must be/], [{ name: ' ' }, /City name must be/], [{ name: 'A' }, /City name must be/], [{ name: 'x'.repeat(101) }, /City name must be/],
      [{ name: '12345' }, /City name must be/], [{ name: '<script>alert(1)</script>' }, /City name must be/], [{ name: 'Town\u0000' }, /City name must be/], [{ name: 'Town\nName?' }, /City name must be/],
      [{ name: 5 }, /must be text/], [{ name: null }, /must be text/], [{ name: ['Town'] }, /must be text/], [{ name: {} }, /must be text/],
      [{ name: 'Town', countryCode: 'uae' }, /countryCode/], [{ name: 'Town', countryCode: 'U' }, /countryCode/], [{ name: 'Town', countryCode: 7 }, /countryCode/],
      [{ name: 'Town', geonameId: 5 }, /never a geonameId/], [{ name: 'Town', timezone: 'UTC' }, /only a name/], [{ countryCode: 'AE' }, /must be text/],
      [{ geonameId: 5, countryCode: 'AE' }, /never a geonameId/],
    ];
    for (const [value, message] of bad) {
      const { fields } = run(valid({ [field]: value }));
      expect(fields[field]).toMatch(message);
    }
  });
  it('a manual name keeps accents, other scripts, apostrophes, hyphens and brackets, and is length-limited by characters', () => {
    for (const name of ['Zürich', "St. John's", 'Saint-Étienne', 'München (Bayern)', '東京', 'القاهرة', 'Kuala Lumpur 2', 'A'.repeat(100), '🙂'.repeat(0) + 'Ab']) {
      const { fields, data } = run(valid({ destination: { name } }));
      expect(fields).toEqual({});
      expect(data.destinationCityName).toBe(name);
    }
  });
  it('the readable label stays within the stored column even for the longest name and country', () => {
    const { data } = run(valid({ origin: { name: 'A'.repeat(100), countryCode: 'GS' } }));
    expect(data.origin.length).toBeLessThanOrEqual(255);
  });
  it('a malformed or unknown GeoNames reference still gets the old errors, now pointing at manual entry', () => {
    expect(run(valid({ origin: { geonameId: 5 } })).fields.origin).toBe('Select a valid city from the list, or enter the city name.');
    expect(run(valid({ origin: 'Mumbai' })).fields.origin).toBe('Select a city from the list, or enter the city name.');
    expect(run(valid({ origin: { geonameId: '1275339' } })).fields.origin).toMatch(/positive whole number/);
    expect(run(valid({ origin: undefined })).fields.origin).toBe('Origin city is required.');
    expect(run(valid({ destination: '' })).fields.destination).toBe('Destination city is required.');
  });
  it('readCityRef tells a picked city from a typed one', () => {
    expect(readCityRef({ geonameId: 12 })).toEqual({ id: 12 });
    expect(readCityRef({ name: ' Ab  Cd ' })).toEqual({ manual: { name: 'Ab Cd', countryCode: null } });
    expect(readCityRef({ name: 'Ab', countryCode: null })).toEqual({ manual: { name: 'Ab', countryCode: null } });
    expect(readCityRef({ name: 'Ab', countryCode: 'IN' })).toEqual({ manual: { name: 'Ab', countryCode: 'IN' } });
    expect(readCityRef({}).problem).toBeTruthy();
    expect(readCityRef(null).problem).toBeTruthy();
  });

  describe('the preferred date with a manual origin (no timezone to judge it by)', () => {
    const NOW = Date.UTC(2030, 5, 15, 12, 0, 0); // 2030-06-15 12:00 UTC
    const manual = (preferredDate) => validatePrivateCharterRequest(valid({ origin: { name: 'Smallville' }, preferredDate }), { cities: CITIES, now: NOW });
    it('accepts today and anything later in the westernmost timezone, refuses earlier days', () => {
      expect(manual('2030-06-15').fields).toEqual({});
      expect(manual('2030-06-14').fields.preferredDate).toBe('Preferred date cannot be in the past.'); // it is already the 15th even in UTC-12
    });
  });
});

describe('Oxygen Required and Oxygen Flow Rate (LPM)', () => {
  it.each([undefined, null])('Oxygen Required must be answered (%p)', (oxygenRequired) => {
    expect(run(valid({ oxygenRequired })).fields.oxygenRequired).toBe('Oxygen required is required.');
  });
  it.each(['yes', 'true', 1, 0, '', []])('Oxygen Required must be a real boolean: refuses %p', (oxygenRequired) => {
    expect(run(valid({ oxygenRequired })).fields.oxygenRequired).toBe('Oxygen required must be true or false.');
  });

  it('Yes needs a flow rate', () => {
    for (const oxygenFlowLpm of [undefined, null, '']) {
      expect(run(valid({ oxygenFlowLpm })).fields.oxygenFlowLpm).toBe('Oxygen flow rate (LPM) is required when oxygen is required.');
    }
  });
  it.each([1, 4, 15, 60, '4', '60'])('Yes accepts a whole flow rate of %p, stored as a number', (oxygenFlowLpm) => {
    const { fields, data } = run(valid({ oxygenFlowLpm }));
    expect(fields).toEqual({});
    expect(data.oxygenFlowLpm).toBe(Number(oxygenFlowLpm));
  });
  it.each([0, -1, 61, 100, 2.5, '0', '61', '2.5', '4 ', 'abc', true, [], {}, NaN, Infinity])('Yes refuses a flow rate of %p', (oxygenFlowLpm) => {
    const { fields, data } = run(valid({ oxygenFlowLpm }));
    expect(fields.oxygenFlowLpm).toBeTruthy();
    expect(data.oxygenFlowLpm).toBeUndefined();
  });

  it('No needs no flow rate and stores none', () => {
    const { fields, data } = run(valid({ oxygenRequired: false, oxygenFlowLpm: undefined }));
    expect(fields).toEqual({});
    expect(data.oxygenRequired).toBe(false);
    expect(data).not.toHaveProperty('oxygenFlowLpm');
    expect(run(valid({ oxygenRequired: false, oxygenFlowLpm: null })).fields).toEqual({});
    expect(run(valid({ oxygenRequired: false, oxygenFlowLpm: '' })).fields).toEqual({});
  });
  it('No with a flow rate is a contradiction: refused, not dropped', () => {
    const { fields, data } = run(valid({ oxygenRequired: false, oxygenFlowLpm: 4 }));
    expect(fields.oxygenFlowLpm).toBe('Oxygen flow rate must not be sent when oxygen is not required.');
    expect(data).not.toHaveProperty('oxygenFlowLpm');
  });
});

describe('the removed fields', () => {
  it.each([
    ['careLevel', ['care_icu']], ['careLevel', 'ICU / Critical'], ['mobility', ['walking']], ['mobility', 'walking'], ['urgency', 'planned'],
    ['equipOxygen', true], ['equipCardiacMonitor', false], ['equipVentilator', true],
  ])('%s is refused, not silently dropped', (field, value) => {
    expect(run(valid({ [field]: value })).fields[field]).toBeTruthy();
  });
  it('an old-app request (care level, mobility, equipment, urgency, no travel type) is refused with every reason at once', () => {
    const old = {
      serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567', country: 'AE',
      origin: { geonameId: 1275339 }, destination: { geonameId: 292223 }, preferredDate: '2099-01-01',
      careLevel: ['care_icu'], mobility: ['bedridden'], equipOxygen: true, urgency: 'critical_6h',
    };
    const { fields } = run(old);
    for (const field of ['careLevel', 'mobility', 'equipOxygen', 'urgency', 'travelType', 'criticalLevel', 'oxygenRequired']) expect(fields[field]).toBeTruthy();
  });
});

describe('fields that stay as they were', () => {
  it('patient name, age, gender, cities, contact and date are still validated', () => {
    expect(run(valid({ patientName: '' })).fields.patientName).toBe('Patient name is required.');
    expect(run(valid({ patientAge: 0 })).fields.patientAge).toBeTruthy();
    expect(run(valid({ patientGender: 'x' })).fields.patientGender).toBeTruthy();
    expect(run(valid({ origin: undefined })).fields.origin).toBe('Origin city is required.');
    expect(run(valid({ destination: undefined })).fields.destination).toBe('Destination city is required.');
    expect(run(valid({ preferredDate: '2001-01-01' })).fields.preferredDate).toBe('Preferred date cannot be in the past.');
  });
});

describe('what is stored and what the patient is sent', () => {
  it('stores the four new columns for a revised request, and null for the older ones', () => {
    const record = requestRecordData(7, run(valid({ criticalLevel: ['ecmo', 'icu'] })).data);
    expect(record.criticalLevel).toBe('icu,ecmo'); // several choices: one column, keys joined by commas
    expect(record).toMatchObject({
      travelType: 'patient_transfer', criticalLevel: 'icu,ecmo', oxygenRequired: true, oxygenFlowLpm: 4, description: 'Post-angioplasty',
      careLevel: null, mobility: null, urgency: null, equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null,
    });
  });
  it('stores oxygenRequired false with no flow rate', () => {
    const record = requestRecordData(7, run(valid({ oxygenRequired: false, oxygenFlowLpm: undefined })).data);
    expect(record.oxygenRequired).toBe(false);
    expect(record.oxygenFlowLpm).toBeNull();
  });
  it('a request of another service stores null for all four', () => {
    const record = requestRecordData(7, { serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'J', origin: 'a', destination: 'b', mobility: 'walking', careLevel: 'care_icu' });
    expect(record).toMatchObject({ travelType: null, criticalLevel: null, oxygenRequired: null, oxygenFlowLpm: null, mobility: 'walking', careLevel: 'care_icu' });
  });
  it('the patient is sent the new fields, and the older ones still for requests that have them', () => {
    for (const field of ['travelType', 'criticalLevel', 'oxygenRequired', 'oxygenFlowLpm', 'careLevel', 'mobility', 'urgency', 'equipOxygen']) expect(REQUEST_FIELDS).toContain(field);
    const sent = toPatientRequest({ id: 1, travelType: 'organ_transfer', criticalLevel: 'ecmo', oxygenRequired: false, oxygenFlowLpm: null, careLevel: 'care_icu', userId: 9 });
    expect(sent).toMatchObject({ travelType: 'organ_transfer', criticalLevel: ['ecmo'], oxygenRequired: false, oxygenFlowLpm: null, careLevel: 'care_icu' });
    // Critical Level always goes out as a list: several choices, and a request that has none (an older one) stays null.
    expect(toPatientRequest({ id: 1, criticalLevel: 'ecmo,icu' }).criticalLevel).toEqual(['icu', 'ecmo']);
    expect(toPatientRequest({ id: 1, criticalLevel: null }).criticalLevel).toBeNull();
    expect(toPatientRequest({ id: 1, careLevel: 'care_icu' })).not.toHaveProperty('criticalLevel');
    expect(sent).not.toHaveProperty('userId');
  });
});
