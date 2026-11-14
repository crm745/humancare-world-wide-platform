// City search for the Private Charter form: GET /geo/cities, with retry and failure wording.
// Pure: the caller passes the function that makes the request (apiGet), so this runs in tests.

export const CITY_QUERY_MIN = 2;
export const CITY_QUERY_MAX = 80;
// Asked for the most the backend gives (its limit is 10): the backend cannot filter by country, so a field held to a country filters what comes back.
export const CITY_RESULT_LIMIT = 10;
export const SEARCH_DEBOUNCE_MS = 300;

// Shown until the first answer arrives, and if an answer ever leaves it out. Same words as the
// backend's GEONAMES_ATTRIBUTION (a test keeps them equal); the data is CC BY 4.0, so it must be
// credited wherever the results are shown.
export const GEONAMES_ATTRIBUTION_FALLBACK = {
  text: 'City data from GeoNames (geonames.org), licensed under CC BY 4.0.',
  url: 'https://www.geonames.org',
  license: 'https://creativecommons.org/licenses/by/4.0/',
};

// What has been typed, ready to search; null when it is too short or too long to be searched.
export function searchableQuery(text) {
  const query = String(text || '').trim();
  const length = Array.from(query).length;
  return length >= CITY_QUERY_MIN && length <= CITY_QUERY_MAX ? query : null;
}

export const citySearchPath = (query) => `/geo/cities?q=${encodeURIComponent(query)}&limit=${CITY_RESULT_LIMIT}`;

// One failed search, in words, and whether pressing Retry could help.
export function describeCityError(err) {
  const status = err && err.status;
  if (status === 400) return { kind: 'invalid', retry: false, message: (err.data && err.data.fields && err.data.fields.q) || 'Enter the first letters of a city.' };
  if (status === 429) return { kind: 'busy', retry: true, message: 'Too many searches. Wait a moment, then try again.' };
  if (status === 503) return { kind: 'unavailable', retry: true, message: 'City search is temporarily unavailable. Try again in a moment.' };
  if (status) return { kind: 'failed', retry: true, message: 'City search failed. Please try again.' };
  return { kind: 'network', retry: true, message: 'Could not reach the server. Check your connection and try again.' };
}

// Worth one automatic second try: no answer at all (network) or a server-side failure. Never a
// refused query (4xx), which would only be refused again.
export const isRetryable = (err) => !err || !err.status || err.status >= 500;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Searches for cities. Resolves { cities, attribution }; throws the last error after the retries.
// `fetcher(path)` -> the parsed response body. `sleep` is injectable for tests.
export async function searchCities(fetcher, text, { retries = 1, delayMs = 400, sleep = wait } = {}) {
  const query = searchableQuery(text);
  if (!query) return { cities: [], attribution: GEONAMES_ATTRIBUTION_FALLBACK };
  let attempt = 0;
  for (;;) {
    try {
      const data = await fetcher(citySearchPath(query));
      const cities = Array.isArray(data && data.cities)
        ? data.cities.filter((c) => c && Number.isInteger(c.geonameId) && typeof c.label === 'string' && c.label)
        : [];
      const attribution = data && data.attribution && typeof data.attribution.text === 'string' ? data.attribution : GEONAMES_ATTRIBUTION_FALLBACK;
      return { cities, attribution };
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

// ---- inline suggestions ---------------------------------------------------------------------------------------------------------
// The same search as above, shared by every city field on the form: one request for the same text, whichever field asks (and while
// it is still on its way), and a short memory of recent answers so typing, deleting and typing again never asks twice.
export const CITY_CACHE_TTL_MS = 5 * 60 * 1000;
export const CITY_CACHE_MAX = 40;
const answers = new Map(); // normalised query -> { at, value }
const inFlight = new Map(); // normalised query -> Promise

export const normaliseCityText = (text) => String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
export const clearCitySearchCache = () => { answers.clear(); inFlight.clear(); };

// -> { cities, attribution } like searchCities. `now` is injectable for tests.
export function searchCitiesCached(fetcher, text, options = {}, now = Date.now()) {
  const query = searchableQuery(text);
  if (!query) return Promise.resolve({ cities: [], attribution: GEONAMES_ATTRIBUTION_FALLBACK });
  const key = normaliseCityText(query);
  const hit = answers.get(key);
  if (hit && now - hit.at < CITY_CACHE_TTL_MS) return Promise.resolve(hit.value);
  if (inFlight.has(key)) return inFlight.get(key);
  const request = searchCities(fetcher, query, options)
    .then((value) => {
      answers.set(key, { at: now, value });
      if (answers.size > CITY_CACHE_MAX) answers.delete(answers.keys().next().value); // the oldest goes
      return value;
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, request);
  return request;
}

// What the person typed, if it names exactly ONE of the suggestions (its city name, the first part of its label, or the whole label equals the text,
// ignoring case, accents and spaces). "Pune" with one Pune in the list is that city; "Springfield" with several is not guessed.
// With `countryIso`, only the cities of that country count (an exact ISO code match): "Springfield" with the US selected is the US one.
export function matchTypedCity(text, cities, countryIso) {
  const wanted = normaliseCityText(text);
  if (!wanted || !Array.isArray(cities)) return null;
  const code = String(countryIso == null ? '' : countryIso).trim().toUpperCase();
  const pool = code ? cities.filter((c) => String(c.countryCode || '').toUpperCase() === code) : cities;
  const same = pool.filter((c) => normaliseCityText(c.name) === wanted || normaliseCityText(String(c.label || '').split(',')[0]) === wanted || normaliseCityText(c.label) === wanted);
  return same.length === 1 ? same[0] : null;
}

// For the Continue button: a city typed by hand and never picked. Resolves the one verified city it names, or null (nothing found, several
// found, or the search failed: the person is then asked to pick a suggestion).
export async function resolveTypedCity(fetcher, text, options, countryIso) {
  try {
    const { cities } = await searchCitiesCached(fetcher, text, options);
    return matchTypedCity(text, cities, countryIso);
  } catch {
    return null;
  }
}
