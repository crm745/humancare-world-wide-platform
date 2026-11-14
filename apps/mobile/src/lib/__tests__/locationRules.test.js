/* global describe, test, expect, __dirname */
// Current Location / Destination: typed places are accepted where the backend takes text, a verified city must belong to the selected country,
// and Private Charter still needs a verified city. Pure rules plus source checks; no real GeoNames data and no device.
const fs = require('fs');
const path = require('path');
const {
  cityInCountry, hasText, locationProblem, locationProblems, suggestionsFor,
} = require('../locationRules');
const { matchTypedCity } = require('../citySearch');
const { buildPrivateCharterPayload, toCityChoice } = require('../privateCharter');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');

const PUNE = { geonameId: 1259229, name: 'Pune', label: 'Pune, Maharashtra, India', countryCode: 'IN' };
const MUMBAI = { geonameId: 1275339, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' };
const TIRANA = { geonameId: 3183875, name: 'Tirana', label: 'Tirana, Albania', countryCode: 'AL' };
const BEIJING = { geonameId: 1816670, name: 'Beijing', label: 'Beijing, China', countryCode: 'CN' };
const SPRINGFIELD_US = { geonameId: 4409896, name: 'Springfield', label: 'Springfield, Missouri, United States', countryCode: 'US' };
const SPRINGFIELD_GB = { geonameId: 2638419, name: 'Springfield', label: 'Springfield, Fife, United Kingdom', countryCode: 'GB' };

describe('Bug 1: a place typed by hand is accepted where the backend takes text', () => {
  test.each([
    ['Current Location', { text: 'nahurad', city: null, countryIso: 'AL' }],
    ['Destination', { text: 'punes', city: null, countryIso: 'AL' }],
  ])('%s: typed text, no suggestion picked, is acceptable for every service except Private Charter', (_f, input) => {
    expect(locationProblem(input)).toBe(null);
  });
  test('the example of the report: Albania, "nahurad" and "punes", both typed', () => {
    expect(locationProblems({ countryIso: 'AL', location: 'nahurad', originCity: null, dest: 'punes', destCity: null }, false)).toEqual({ location: null, dest: null });
  });
  test('the text may have spaces and punctuation, and is judged only for being empty', () => {
    ['  New  York, NY  ', "Cox's Bazar", 'St. John\'s (north)', 'Pune '].forEach((text) => expect(locationProblem({ text, city: null, countryIso: 'IN' })).toBe(null));
    expect(hasText(' x ')).toBe(true);
  });
  test('an empty required location is rejected, whitespace only too, for each field on its own', () => {
    expect(locationProblem({ text: '', city: null })).toBe('required');
    expect(locationProblem({ text: '   ', city: null })).toBe('required');
    expect(locationProblem({ text: undefined, city: null })).toBe('required');
    expect(locationProblems({ countryIso: 'IN', location: 'Pune', originCity: null, dest: '', destCity: null }, false)).toEqual({ location: null, dest: 'required' });
    expect(locationProblems({ countryIso: 'IN', location: '', originCity: null, dest: 'Mumbai', destCity: null }, false)).toEqual({ location: 'required', dest: null });
  });
  test('the form keeps the text exactly as typed: nothing is trimmed, replaced or swapped for a city', () => {
    const step1 = read('app/request/step1.js');
    expect(step1).toContain('onChangeText={(location) => updateDraft({ location, originCity: null })}');
    expect(step1).toContain('onChangeText={(dest) => updateDraft({ dest, destCity: null })}');
    expect(step1).not.toMatch(/updateDraft\(\{ location: [^}]*trim\(/);
    const field = read('components/request/CityField.js');
    expect(field).toContain('onChangeText(text);');
    expect(field).not.toContain('onChangeText(city');
  });
  test('a typed place is never a verified city: no identifier is invented for it', () => {
    const payload = buildPrivateCharterPayload({ name: 'N K', age: '54', gender: 'Male', cc: '+91', phone: '9876543210', countryIso: 'IN', location: 'nahurad', originCity: null, dest: 'punes', destCity: null, date: '2026-12-01' });
    expect(payload.origin).toBeUndefined();
    expect(payload.destination).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('geonameId');
  });
});

describe('Private Charter still needs a verified city (the backend takes { geonameId } only)', () => {
  test('typed text is not enough: it is told to pick a suggestion; nothing typed is rejected for being empty', () => {
    expect(locationProblem({ text: 'nahurad', city: null, countryIso: 'AL', structured: true })).toBe('pick_city');
    expect(locationProblem({ text: '', city: null, countryIso: 'AL', structured: true })).toBe('required');
    expect(locationProblem({ text: 'Tirana, Albania', city: TIRANA, countryIso: 'AL', structured: true })).toBe(null);
    expect(locationProblems({ countryIso: 'AL', location: 'nahurad', originCity: null, dest: 'punes', destCity: null }, true)).toEqual({ location: 'pick_city', dest: 'pick_city' });
  });
  test('a verified city is sent as { geonameId } alone, exactly as before', () => {
    const body = buildPrivateCharterPayload({ name: 'N K', age: '54', gender: 'Male', cc: '+91', phone: '9876543210', countryIso: 'IN', originCity: toCityChoice(PUNE), destCity: toCityChoice(MUMBAI), location: PUNE.label, dest: MUMBAI.label, date: '2026-12-01' });
    expect(body.origin).toEqual({ geonameId: 1259229 });
    expect(body.destination).toEqual({ geonameId: 1275339 });
  });
  test('the message says what is needed and why', () => {
    expect(read('app/request/step1.js')).toContain("const CHOOSE_CITY = 'Pick a city from the suggestions: Private Charter needs a verified city.';");
  });
});

// The approved policy: ONLY the Current Location must belong to the selected Country; the Destination may be in any country.
const DUBAI = { geonameId: 292223, name: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' };
const LONDON = { geonameId: 2643743, name: 'London', label: 'London, England, United Kingdom', countryCode: 'GB' };
const SINGAPORE = { geonameId: 1880252, name: 'Singapore', label: 'Singapore, Singapore', countryCode: 'SG' };
const draftOf = (countryIso, originCity, destCity) => ({
  countryIso, location: originCity ? originCity.label : '', originCity, dest: destCity ? destCity.label : '', destCity,
});

describe('Current Location: a verified city must belong to the selected country (ISO code against ISO code)', () => {
  test('1. India + Mumbai is accepted', () => {
    expect(locationProblem({ text: MUMBAI.label, city: MUMBAI, countryIso: 'IN' })).toBe(null);
    expect(locationProblems(draftOf('IN', MUMBAI, null), true).location).toBe(null);
  });
  test('2. China + Pune is rejected (every service)', () => {
    expect(locationProblem({ text: PUNE.label, city: PUNE, countryIso: 'CN' })).toBe('wrong_country');
    expect(locationProblem({ text: PUNE.label, city: PUNE, countryIso: 'CN', structured: true })).toBe('wrong_country');
    expect(locationProblems(draftOf('CN', PUNE, null), true).location).toBe('wrong_country');
    expect(locationProblems(draftOf('CN', PUNE, null), false).location).toBe('wrong_country');
  });
  test('Albania + an Albanian city is accepted, a Chinese one is not', () => {
    expect(locationProblem({ text: TIRANA.label, city: TIRANA, countryIso: 'AL' })).toBe(null);
    expect(locationProblem({ text: BEIJING.label, city: BEIJING, countryIso: 'AL' })).toBe('wrong_country');
  });
  test('6. the country changes from India to China: Mumbai stops being valid as Current Location; back to India: valid again', () => {
    expect(locationProblems(draftOf('IN', MUMBAI, null), true).location).toBe(null);
    expect(locationProblems(draftOf('CN', MUMBAI, null), true).location).toBe('wrong_country');
    expect(locationProblems(draftOf('IN', MUMBAI, null), true).location).toBe(null);
  });
  test('10. a typed Current Location has no country to check: it is accepted, and kept, when the country changes', () => {
    const draft = (countryIso) => ({ countryIso, location: 'Pune', originCity: null, dest: 'Mumbai', destCity: null });
    expect(locationProblems(draft('IN'), false)).toEqual({ location: null, dest: null });
    expect(locationProblems(draft('CN'), false)).toEqual({ location: null, dest: null });
  });
  test('the comparison is an exact code match: never a name, never a substring, never an approximate match', () => {
    expect(cityInCountry({ countryCode: 'IN' }, 'I')).toBe(false);
    expect(cityInCountry({ countryCode: 'IN' }, 'INDIA')).toBe(false);
    expect(cityInCountry({ countryCode: 'IN' }, 'India')).toBe(false);
    expect(cityInCountry({ countryCode: 'ID' }, 'IN')).toBe(false); // Indonesia is not India
    expect(cityInCountry({ countryCode: 'IN' }, 'IN')).toBe(true);
    expect(cityInCountry({ countryCode: 'in' }, ' IN ')).toBe(true); // the same code, however it is written
    const src = read('lib/locationRules.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(/\.includes\(|indexOf\(|startsWith\(|localeCompare|match\(/);
  });
  test('with no country chosen yet there is nothing to compare (the Country field itself is required and is asked first)', () => {
    expect(locationProblem({ text: PUNE.label, city: PUNE, countryIso: '' })).toBe(null);
    expect(cityInCountry(PUNE, undefined)).toBe(true);
  });
});

describe('Destination: any country (international transfers), and only the Current Location is country-restricted', () => {
  test.each([['Dubai (UAE)', DUBAI], ['London (UK)', LONDON], ['Singapore', SINGAPORE]])('3-5. India + Mumbai + a destination in %s is accepted', (_n, destination) => {
    expect(locationProblems(draftOf('IN', MUMBAI, destination), true)).toEqual({ location: null, dest: null });
    expect(locationProblems(draftOf('IN', MUMBAI, destination), false)).toEqual({ location: null, dest: null });
  });
  test('a destination in the patient\'s own country is accepted too (a domestic transfer)', () => {
    expect(locationProblems(draftOf('IN', MUMBAI, PUNE), true)).toEqual({ location: null, dest: null });
  });
  test('7. changing the Country does not invalidate an international Destination (only the Current Location is judged by it)', () => {
    expect(locationProblems(draftOf('IN', MUMBAI, DUBAI), true)).toEqual({ location: null, dest: null });
    expect(locationProblems(draftOf('CN', MUMBAI, DUBAI), true)).toEqual({ location: 'wrong_country', dest: null });
    expect(locationProblems(draftOf('AE', MUMBAI, DUBAI), true)).toEqual({ location: 'wrong_country', dest: null });
    expect(locationProblems(draftOf('IN', MUMBAI, DUBAI), true)).toEqual({ location: null, dest: null });
  });
  test('9. the two fields are judged independently', () => {
    expect(locationProblems(draftOf('IN', BEIJING, MUMBAI), true)).toEqual({ location: 'wrong_country', dest: null });
    expect(locationProblems(draftOf('IN', PUNE, BEIJING), true)).toEqual({ location: null, dest: null }); // a Chinese destination is allowed
    expect(locationProblems({ countryIso: 'IN', location: 'Pune', originCity: null, dest: '', destCity: null }, false)).toEqual({ location: null, dest: 'required' });
    expect(locationProblems({ countryIso: 'IN', location: '', originCity: null, dest: DUBAI.label, destCity: DUBAI }, false)).toEqual({ location: 'required', dest: null });
  });
  test('only the Current Location is country-restricted: the Destination is never compared with the Country, anywhere in the code', () => {
    const rules = read('lib/locationRules.js');
    expect(rules).toContain('structured: charter, checkCountry: false }),');
    expect(rules).not.toContain('DESTINATION_MUST_MATCH_COUNTRY');
    const step1 = read('app/request/step1.js');
    expect(step1).not.toContain('DESTINATION_MUST_MATCH_COUNTRY');
    const destField = step1.slice(step1.indexOf('<Anchor id="dest">'), step1.indexOf('<Anchor id="phone">'));
    expect(destField).not.toMatch(/restrictToCountry|countryIso|countryName/); // its suggestions are not filtered by the Country either
    const originField = step1.slice(step1.indexOf('<Anchor id="location">'), step1.indexOf('<Anchor id="dest">'));
    expect(originField).toContain('countryIso={draft.countryIso} countryName={draft.country} restrictToCountry');
  });
  test('12. an empty Destination is still rejected, and for Private Charter typed text is not enough', () => {
    expect(locationProblem({ text: '', city: null, checkCountry: false })).toBe('required');
    expect(locationProblem({ text: '   ', city: null, checkCountry: false, structured: true })).toBe('required');
    expect(locationProblem({ text: 'Dubai', city: null, checkCountry: false, structured: true })).toBe('pick_city');
  });
});

describe('8. the destination keeps its OWN country and identifier (it is never given the patient\'s country)', () => {
  test('a selected destination is stored whole: geonameId, name, label and its own countryCode', () => {
    const choice = toCityChoice(DUBAI);
    expect(choice).toEqual({ geonameId: 292223, name: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' });
    expect(read('app/request/step1.js')).toContain('onSelect={(city) => updateDraft({ destCity: city, dest: city.label })}');
  });
  test('changing the patient\'s Country changes only the country fields: the destination (and the origin city) are not touched', () => {
    const { pickRequestCountry } = require('../requestForm');
    const draft = { country: 'India', countryIso: 'IN', phoneCountry: 'IN', cc: '+91', ccEdited: false, phone: '9876543210', originCity: MUMBAI, destCity: DUBAI, dest: DUBAI.label, location: MUMBAI.label };
    const patch = pickRequestCountry(draft, 'CN');
    expect(Object.keys(patch).sort()).toEqual(['cc', 'ccEdited', 'country', 'countryIso', 'phoneCountry']);
    expect(patch).not.toHaveProperty('destCity');
    expect(patch).not.toHaveProperty('dest');
    expect({ ...draft, ...patch }.destCity.countryCode).toBe('AE');
  });
  test('Private Charter sends the destination as its own { geonameId }, and the patient\'s country separately (the backend reads the destination\'s country from the verified city)', () => {
    const body = buildPrivateCharterPayload({ ...draftOf('IN', MUMBAI, DUBAI), name: 'N K', age: '54', gender: 'Male', cc: '+91', phone: '9876543210', date: '2026-12-01' });
    expect(body.origin).toEqual({ geonameId: 1275339 });
    expect(body.destination).toEqual({ geonameId: 292223 }); // Dubai's own id, not an Indian city, and no country attached
    expect(body.country).toBe('IN'); // the patient's country
    expect(JSON.stringify(body.destination)).not.toMatch(/IN|countryCode|country/);
  });
  test('the other services send the destination as the text it carries (it names its own country), and the patient\'s country in its own field', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('destination: d.dest,');
    expect(review).toContain('country: d.country || undefined,');
    expect(DUBAI.label).toContain('United Arab Emirates');
  });
  test('a destination in another country is still the destination of the request (international transfers: Mortal Remains too)', () => {
    const review = read('app/request/review.js');
    const body = review.slice(review.indexOf("apiPost('/requests', {"), review.indexOf('// The request is saved, so a file that fails'));
    expect(body).toContain('origin: d.location,');
    expect(body).toContain('destination: d.dest,');
    expect(body).toContain('...(mortal ? { deceasedRelation: d.relation, placeOfDeath: d.deathPlace, dateOfDeath: d.deathDate } : {}),');
  });
});

describe('the suggestions follow the country', () => {
  const list = [PUNE, BEIJING, TIRANA, MUMBAI];
  test('a field held to the country lists only that country\'s cities (so a city of another country cannot be picked)', () => {
    expect(suggestionsFor(list, { countryIso: 'IN', restrict: true })).toEqual([PUNE, MUMBAI]);
    expect(suggestionsFor(list, { countryIso: 'CN', restrict: true })).toEqual([BEIJING]);
    expect(suggestionsFor([PUNE], { countryIso: 'CN', restrict: true })).toEqual([]); // China + "Pune": nothing to pick
  });
  test('not held to the country, or no country yet: everything', () => {
    expect(suggestionsFor(list, { countryIso: 'IN', restrict: false })).toEqual(list);
    expect(suggestionsFor(list, { countryIso: '', restrict: true })).toEqual(list);
    expect(suggestionsFor(undefined, { countryIso: 'IN', restrict: true })).toEqual([]);
  });
  test('the field filters and says which country was searched', () => {
    const field = read('components/request/CityField.js');
    expect(field).toContain('suggestionsFor(cities, { countryIso, restrict: restrictToCountry, max: 10 })');
    expect(field).toContain('`No matching city${inCountry}.');
    const step1 = read('app/request/step1.js');
    expect(step1).toContain('countryIso={draft.countryIso} countryName={draft.country} restrictToCountry\n'); // the Current Location only
  });
  test('Continue\'s match of a typed city only considers the selected country (never "Pune" for China, and Springfield means the one of the country)', () => {
    const cities = [SPRINGFIELD_US, SPRINGFIELD_GB, PUNE];
    expect(matchTypedCity('Springfield', cities)).toBe(null); // two: not guessed
    expect(matchTypedCity('Springfield', cities, 'US')).toBe(SPRINGFIELD_US);
    expect(matchTypedCity('Springfield', cities, 'GB')).toBe(SPRINGFIELD_GB);
    expect(matchTypedCity('Pune', cities, 'IN')).toBe(PUNE);
    expect(matchTypedCity('Pune', cities, 'CN')).toBe(null);
  });
});

describe('what the person is told, and when', () => {
  const step1 = read('app/request/step1.js');
  test('a city from another country is said at once (it is a conflict), naming the country; the other messages wait for Continue', () => {
    expect(step1).toContain("if (problem === 'wrong_country') return `This city is not in ${draft.country}. Pick a city in ${draft.country}, or change the country.`;");
    expect(step1).toContain('if (problem && !attempted) return undefined;');
  });
  test('Continue is blocked by a wrong-country city, like any other wrong field', () => {
    expect(step1).toContain("['location', locationProblems(d, charter).location !== null],");
    expect(step1).toContain("['dest', locationProblems(d, charter).dest !== null],");
  });
  test('a tapped suggestion keeps its verified city for EVERY service (so the country can be checked); typing drops it', () => {
    expect(step1).toContain('onSelect={(city) => updateDraft({ originCity: city, location: city.label })}');
    expect(step1).toContain('onSelect={(city) => updateDraft({ destCity: city, dest: city.label })}');
  });
});

describe('the payloads: unchanged for every service', () => {
  test('services with plain text send the typed text as it always did (origin, destination and patientLocation)', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('patientLocation: d.location,');
    expect(review).toContain('origin: d.location,');
    expect(review).toContain('destination: d.dest,');
  });
  test('the verified city kept for the country check is not sent by those services', () => {
    const review = read('app/request/review.js');
    const body = review.slice(review.indexOf("apiPost('/requests', {"), review.indexOf('// The request is saved, so a file that fails'));
    expect(body).not.toMatch(/originCity|destCity|geonameId/);
  });
});
