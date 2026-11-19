/* global describe, test, expect, jest, beforeEach, __dirname */
// Inline city suggestions on the request form (Current Location, Destination).
const fs = require('fs');
const path = require('path');
const {
  CITY_CACHE_MAX, CITY_CACHE_TTL_MS, clearCitySearchCache, matchTypedCity, normaliseCityText, resolveTypedCity, searchCitiesCached,
} = require('../citySearch');
const { revealDelta } = require('../keyboardLayout');
const { buildPrivateCharterPayload, toCityChoice } = require('../privateCharter');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const city = (id, name, label, countryCode = 'IN') => ({ geonameId: id, name, label, countryCode });
const PUNE = city(1, 'Pune', 'Pune, Maharashtra, India');
const MUMBAI = city(2, 'Mumbai', 'Mumbai, Maharashtra, India');
const SPRINGFIELD_US = city(3, 'Springfield', 'Springfield, Illinois, United States', 'US');
const SPRINGFIELD_UK = city(4, 'Springfield', 'Springfield, Fife, United Kingdom', 'GB');
const answer = (cities) => ({ cities, attribution: { text: 'GeoNames', url: 'https://www.geonames.org', license: 'x' } });

beforeEach(() => clearCitySearchCache());

describe('the search is shared, and never asked twice for the same text', () => {
  test('below two letters nothing is asked', async () => {
    const fetcher = jest.fn();
    expect((await searchCitiesCached(fetcher, 'm')).cities).toEqual([]);
    expect((await searchCitiesCached(fetcher, '  ')).cities).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('the same text (any case, accents, spacing) is one request, for both fields', async () => {
    const fetcher = jest.fn(async () => ({ cities: [PUNE] }));
    const [a, b] = await Promise.all([searchCitiesCached(fetcher, 'Pune'), searchCitiesCached(fetcher, ' pune ')]); // at the same moment
    const c = await searchCitiesCached(fetcher, 'PUNE'); // later, from memory
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a.cities).toEqual([PUNE]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
  test('different text is a different request', async () => {
    const fetcher = jest.fn(async () => ({ cities: [] }));
    await searchCitiesCached(fetcher, 'mum');
    await searchCitiesCached(fetcher, 'mumb');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test('an answer is remembered for five minutes, then asked again', async () => {
    const fetcher = jest.fn(async () => ({ cities: [PUNE] }));
    expect(CITY_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    await searchCitiesCached(fetcher, 'pune', {}, 1000);
    await searchCitiesCached(fetcher, 'pune', {}, 1000 + CITY_CACHE_TTL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await searchCitiesCached(fetcher, 'pune', {}, 1000 + CITY_CACHE_TTL_MS + 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test('a failure is not remembered (the next try asks again)', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { status: 400 })).mockResolvedValue({ cities: [PUNE] });
    await expect(searchCitiesCached(fetcher, 'pune', { retries: 0 })).rejects.toBeTruthy();
    await expect(searchCitiesCached(fetcher, 'pune', { retries: 0 })).resolves.toMatchObject({ cities: [PUNE] });
  });
  test('the memory is bounded', async () => {
    expect(CITY_CACHE_MAX).toBe(40);
    const fetcher = jest.fn(async () => ({ cities: [] }));
    for (let i = 0; i < CITY_CACHE_MAX + 5; i += 1) await searchCitiesCached(fetcher, `ab${i}`);
    fetcher.mockClear();
    await searchCitiesCached(fetcher, 'ab0'); // the oldest was dropped
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('a city typed by hand and never picked', () => {
  test('normalising ignores case, accents and spacing', () => {
    expect(normaliseCityText('  São  Paulo ')).toBe('sao paulo');
  });
  test('exactly one city of that name is that city; the text is not changed by this', () => {
    expect(matchTypedCity('pune', [PUNE, MUMBAI])).toBe(PUNE);
    expect(matchTypedCity('  PUNE ', [PUNE])).toBe(PUNE);
    expect(matchTypedCity('Pune, Maharashtra, India', [PUNE])).toBe(PUNE);
  });
  test('several cities of that name, none, or part of a name: nothing is guessed', () => {
    expect(matchTypedCity('Springfield', [SPRINGFIELD_US, SPRINGFIELD_UK])).toBe(null);
    expect(matchTypedCity('Pun', [PUNE])).toBe(null);
    expect(matchTypedCity('Delhi', [PUNE, MUMBAI])).toBe(null);
    expect(matchTypedCity('', [PUNE])).toBe(null);
    expect(matchTypedCity('Pune', undefined)).toBe(null);
  });
  test('resolving asks the existing search, and a failed search is just "not found"', async () => {
    expect(await resolveTypedCity(jest.fn(async () => ({ cities: [PUNE, MUMBAI] })), 'Pune')).toBe(PUNE);
    clearCitySearchCache();
    expect(await resolveTypedCity(jest.fn(async () => { throw Object.assign(new Error('x'), { status: 503 }); }), 'Pune', { retries: 0 })).toBe(null);
    expect(await resolveTypedCity(jest.fn(), 'P')).toBe(null);
  });
});

describe('the request payload is unchanged', () => {
  const draft = (extra) => ({ name: 'N K', age: '54', gender: 'Male', cc: '+91', phone: '9876543210', countryIso: 'IN', date: '2026-12-01', location: 'x', dest: 'y', ...extra });
  test('Private Charter still sends each city as { geonameId } alone, whether it was picked or matched from typed text', () => {
    const picked = toCityChoice(PUNE);
    const body = buildPrivateCharterPayload(draft({ originCity: picked, destCity: toCityChoice(MUMBAI), location: 'Pune' }));
    expect(body.origin).toEqual({ geonameId: 1 });
    expect(body.destination).toEqual({ geonameId: 2 });
    expect(body).not.toHaveProperty('patientLocation');
  });
  test('a city that was never matched is left out, so the backend refuses it (the form stops it first)', () => {
    const body = buildPrivateCharterPayload(draft({ originCity: null, destCity: null, location: 'Pune', dest: 'Dubai' }));
    expect(body.origin).toBeUndefined();
    expect(body.destination).toBeUndefined();
  });
  test('the payload builders and the review step were not touched', () => {
    const review = read('app/request/review.js');
    expect(review).toContain('origin: d.location,');
    expect(review).toContain('destination: d.dest,');
    expect(review).toContain('patientLocation: d.location,');
  });
});

describe('the open list is brought above the keyboard', () => {
  test('0 when it already fits; otherwise how far to scroll', () => {
    expect(revealDelta({ top: 300, height: 100, windowHeight: 800, keyboardHeight: 0 })).toBe(0);
    expect(revealDelta({ top: 500, height: 200, windowHeight: 800, keyboardHeight: 300 })).toBe(224); // 700 - (800 - 300 - 24)
    expect(revealDelta({ top: 500, height: 200, windowHeight: 800, keyboardHeight: 300, footerHeight: 84 })).toBe(308);
    expect(revealDelta({ top: 100, height: 50, windowHeight: 800, keyboardHeight: 300 })).toBe(0);
  });
});

describe('CityField: inline, never a modal', () => {
  const field = read('components/request/CityField.js');
  const step1 = read('app/request/step1.js');
  test('no modal, no overlay: the list is part of the form, directly under the field', () => {
    expect(field).not.toMatch(/Modal|statusBarTranslucent|position: 'absolute'/);
    expect(field.indexOf('<Input')).toBeLessThan(field.indexOf('{visible ? ('));
    expect(field).toContain('rounded-xl border border-line bg-white');
  });
  test('the person types in the field itself, and the text is kept as typed', () => {
    expect(field).toContain('value={value} onChangeText={onType}');
    expect(field).toContain('onChangeText(text);');
    expect(field).not.toContain('onChangeText(city'); // typing never swaps the text for a suggestion
  });
  test('searches from two letters, after a short pause, without repeating a search', () => {
    expect(field).toContain('searchableQuery(text)');
    expect(field).toContain('setTimeout(() => run(text), SEARCH_DEBOUNCE_MS)');
    expect(field).toContain('searchCitiesCached(apiGet, query)');
    expect(field).toContain('if (shown.current === key) return;');
    expect(read('lib/citySearch.js')).toContain('export const CITY_QUERY_MIN = 2;');
  });
  test('opens when the field is focused (with two letters typed), closes when it loses focus, and a tap on a suggestion is not lost', () => {
    expect(field).toContain('const onFocus = () => {');
    expect(field).toContain('if (searchableQuery(value)) run(value);');
    expect(field).toContain('if (pressing.current) return;');
    expect(field).toContain('onPressIn={() => { pressing.current = true; }}');
  });
  test('a suggestion fills the field and closes the list', () => {
    expect(field).toContain('onSelect(choice);');
    expect(field).toContain('setOpen(false);');
  });
  test('loading, empty, error with Retry, a height limit with scrolling, and the GeoNames credit', () => {
    expect(field).toContain('Searching…');
    expect(field).toContain('No matching city${inCountry}.');
    expect(field).toContain('Retry city search');
    expect(field).toContain('maxHeight: listMax');
    expect(field).toContain('nestedScrollEnabled');
    expect(field).toContain('attribution.text');
  });
  test('a long name wraps instead of overflowing', () => {
    expect(field).toContain('style={WRAP}');
  });
  test('the open list is scrolled into view above the keyboard', () => {
    expect(field).toContain('reveal(box)');
    expect(read('components/keyboard/index.js')).toContain('<RevealContext.Provider value={reveal}>');
  });
  test('the two fields are independent: each has its own text and its own city in the draft', () => {
    // typing makes a place manual (the verified city is dropped), tapping a suggestion keeps the verified city: for EVERY service, so the country can be checked
    expect(step1).toContain('updateDraft({ location, originCity: null })');
    expect(step1).toContain('updateDraft({ dest, destCity: null })');
    expect(step1).toContain('updateDraft({ originCity: city, location: city.label })');
    expect(step1).toContain('updateDraft({ destCity: city, dest: city.label })');
    expect(step1.match(/<CityField/g)).toHaveLength(2);
  });
  test('Continue matches a typed city to the verified list first (Private Charter only), and never guesses', () => {
    expect(step1).toContain('const prepare = charter ? async () => {');
    expect(step1).toContain('resolveTypedCity(apiGet, draft.location, undefined, draft.countryIso)');
    expect(step1).toContain('resolveTypedCity(apiGet, draft.dest)'); // the Destination may be in any country: matched among all verified cities
    expect(step1).toContain('prepare={prepare}');
    expect(step1).toContain("const firstError = (patch) => problemsFor(patch ? { ...draft, ...patch } : draft)");
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toContain('patch = await prepare();');
    expect(frame).toContain('firstError?.(patch)');
  });
  test('the validation itself is as it was: Private Charter needs a verified city, other services need some text', () => {
    // now judged by lib/locationRules.js (see locationRules.test.js): Private Charter needs a verified city, other services need some text
    expect(step1).toContain("['location', locationProblems(d, charter).location !== null],");
    expect(step1).toContain("['dest', locationProblems(d, charter).dest !== null],");
  });
});
