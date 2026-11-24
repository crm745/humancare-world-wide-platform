/* global describe, test, expect, __dirname */
// Private Charter: how Critical Level (several choices) and the Origin City / Destination City labels read on the review step and the
// request details, that the city field offers the explicit "Use ..." option, and that a manual city is held to the same country rule.
const fs = require('fs');
const path = require('path');
const { reviewView } = require('../reviewView');
const { detailsView, criticalLevelLabel } = require('../requestDetailsView');
const { locationProblem, locationProblems } = require('../locationRules');
const { toManualCity, toCityChoice } = require('../privateCharter');

const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const t = (key, values) => {
  const text = (i18n.EN && i18n.EN[key]) || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};

describe('Critical Level on screen', () => {
  test('several choices read as one line, in the order of the form, in the app language', () => {
    expect(criticalLevelLabel(['ecmo', 'icu'], t)).toBe('ICU, ECMO');
    expect(criticalLevelLabel('ecmo,icu,ventilated', t)).toBe('ICU, Ventilated, ECMO');
    expect(criticalLevelLabel(['icu', 'ventilated', 'tracheostomy', 'ecmo'], t)).toBe('ICU, Ventilated, Tracheostomy, ECMO');
  });
  test('a value stored before the multi-select (one key) and a value we do not know still read', () => {
    expect(criticalLevelLabel('icu', t)).toBe('ICU');
    expect(criticalLevelLabel(['icu', 'legacy thing'], t)).toBe('ICU, legacy thing');
    expect(criticalLevelLabel(null, t)).toBe('');
    expect(criticalLevelLabel(undefined, t)).toBe('');
    expect(criticalLevelLabel([], t)).toBe('');
  });
  test('the review step and the request details show every choice', () => {
    const review = reviewView({ service: 'privatecharter', criticalLevel: ['icu', 'ecmo'], oxygenRequired: false }, { key: 'privatecharter', title: 'Private Charter' }, t);
    expect(review.medical.criticalLevel).toBe('ICU, ECMO');
    const details = detailsView({ serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', criticalLevel: ['icu', 'ecmo'], oxygenRequired: false }, t);
    expect(details.medical.criticalLevel).toBe('ICU, ECMO');
    const stored = detailsView({ serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', criticalLevel: 'icu' }, t);
    expect(stored.medical.criticalLevel).toBe('ICU');
  });
});

describe('Origin City / Destination City labels', () => {
  test('Private Charter says Origin City and Destination City; other services keep From and To', () => {
    expect(t('field_origin_city')).toBe('Origin City');
    expect(t('field_destination_city')).toBe('Destination City');
    const charterReview = reviewView({ service: 'privatecharter', location: 'Pune', dest: 'Dubai' }, { key: 'privatecharter', title: 'x' }, t);
    expect(charterReview.trip.charter).toBe(true);
    const groundReview = reviewView({ service: 'ground', location: 'Pune', dest: 'Dubai' }, { key: 'ground', title: 'x' }, t);
    expect(groundReview.trip.charter).toBe(false);
    const charterDetails = detailsView({ serviceKey: 'privatecharter', origin: 'Pune', destination: 'Dubai' }, t);
    expect(charterDetails.trip.charter).toBe(true);
    expect(detailsView({ serviceKey: 'ground', origin: 'Pune', destination: 'Dubai' }, t).trip.charter).toBe(false);
  });
  test('the screens use the new labels for Private Charter only', () => {
    expect(read('components/request/DetailsBlocks.js')).toContain("t(trip.charter ? 'field_origin_city' : 'lbl_from')");
    expect(read('components/request/DetailsBlocks.js')).toContain("t(trip.charter ? 'field_destination_city' : 'lbl_to')");
    expect(read('app/request/step1.js')).toContain("t(charter ? 'field_origin_city' : 'field_location')");
    expect(read('app/request/step1.js')).toContain("t(charter ? 'field_destination_city' : 'field_destination')");
    expect(read('components/tracking/PrivateCharterTracking.js')).toContain("t('field_origin_city')");
    expect(i18n.EN.field_location).toBe('Current location'); // the other services are untouched
    expect(i18n.EN.field_destination).toBe('Destination');
  });
});

describe('the "Use ..." option (a city GeoNames does not have)', () => {
  test('the city field offers it for typed text with no chosen city, and says when a city was entered by hand', () => {
    const src = read('components/request/CityField.js');
    expect(src).toContain('onManual');
    expect(src).toContain("t('city_use_typed', { city: value.trim() })");
    expect(src).toContain("t('city_manual_note')");
    expect(src).toMatch(/canUseTyped = structured && !!onManual && !city && state !== 'loading' && isManualCityName\(value\)/);
    expect(t('city_use_typed', { city: 'Smallville' })).toBe('Use “Smallville”');
  });
  test('both cities of the form wire it, keeping the country context for the origin only', () => {
    const src = read('app/request/step1.js');
    expect(src).toContain('toManualCity(text, draft.countryIso)');
    expect(src).toContain('toManualCity(text, null)');
  });
  test('a manual city counts as chosen: the rule asks for a pick only while nothing is chosen', () => {
    const manual = toManualCity('Smallville', 'IN');
    expect(locationProblem({ text: 'Smallville', city: null, countryIso: 'IN', structured: true })).toBe('pick_city');
    expect(locationProblem({ text: 'Smallville', city: manual, countryIso: 'IN', structured: true })).toBe(null);
    expect(locationProblem({ text: 'Karachi', city: toManualCity('Karachi', null), countryIso: 'IN', structured: true, checkCountry: false })).toBe(null);
  });
  test('a manual origin carries the form country, so the country rule still holds for a picked city', () => {
    const dubai = toCityChoice({ geonameId: 292223, name: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' });
    expect(locationProblems({ countryIso: 'IN', location: 'Smallville', originCity: toManualCity('Smallville', 'IN'), dest: dubai.label, destCity: dubai }, true)).toEqual({ location: null, dest: null });
    expect(locationProblems({ countryIso: 'IN', location: dubai.label, originCity: dubai, dest: '', destCity: null }, true)).toEqual({ location: 'wrong_country', dest: 'required' });
  });
});
