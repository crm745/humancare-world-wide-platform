/* global describe, it, expect, jest, __dirname */
const { spawnSync } = require('child_process');
const path = require('path');
const {
  searchCities, searchableQuery, citySearchPath, describeCityError, isRetryable, GEONAMES_ATTRIBUTION_FALLBACK, CITY_RESULT_LIMIT,
} = require('../citySearch');

const backendDir = path.resolve(__dirname, '..', '..', '..', '..', '..', 'backend');
const noSleep = () => Promise.resolve();
const httpError = (status, data = {}) => Object.assign(new Error('x'), { status, data });
const MUMBAI = { geonameId: 1275339, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' };
const ATTRIBUTION = { text: 'City data from GeoNames (geonames.org), licensed under CC BY 4.0.', url: 'https://www.geonames.org', license: 'https://creativecommons.org/licenses/by/4.0/' };

describe('the query', () => {
  it('is searched from 2 to 80 characters, trimmed', () => {
    expect(searchableQuery('m')).toBeNull();
    expect(searchableQuery('  ')).toBeNull();
    expect(searchableQuery(' mu ')).toBe('mu');
    expect(searchableQuery('x'.repeat(80))).toHaveLength(80);
    expect(searchableQuery('x'.repeat(81))).toBeNull();
    expect(searchableQuery(null)).toBeNull();
  });

  it('is encoded into the path with the backend\'s result limit', () => {
    expect(citySearchPath('São Paulo & co')).toBe(`/geo/cities?q=${encodeURIComponent('São Paulo & co')}&limit=${CITY_RESULT_LIMIT}`);
    expect(CITY_RESULT_LIMIT).toBeLessThanOrEqual(20);
  });
});

describe('searchCities', () => {
  it('returns the cities and the attribution the server sent', async () => {
    const fetcher = jest.fn().mockResolvedValue({ cities: [MUMBAI], attribution: ATTRIBUTION });
    const result = await searchCities(fetcher, 'mumb', { sleep: noSleep });
    expect(result.cities).toEqual([MUMBAI]);
    expect(result.attribution).toEqual(ATTRIBUTION);
    expect(fetcher).toHaveBeenCalledWith('/geo/cities?q=mumb&limit=10');
  });

  it('does not call the server for text that is too short', async () => {
    const fetcher = jest.fn();
    expect(await searchCities(fetcher, 'm', { sleep: noSleep })).toEqual({ cities: [], attribution: GEONAMES_ATTRIBUTION_FALLBACK });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shows no result it cannot send back: a city needs a whole-number geonameId and a label', async () => {
    const fetcher = jest.fn().mockResolvedValue({ cities: [MUMBAI, { geonameId: '5', label: 'x' }, { geonameId: 7 }, null, { geonameId: 8, label: '' }] });
    expect((await searchCities(fetcher, 'mu', { sleep: noSleep })).cities).toEqual([MUMBAI]);
    expect((await searchCities(jest.fn().mockResolvedValue({}), 'mu', { sleep: noSleep })).cities).toEqual([]);
  });

  it('always has an attribution to show, even if the answer leaves it out', async () => {
    const result = await searchCities(jest.fn().mockResolvedValue({ cities: [MUMBAI] }), 'mu', { sleep: noSleep });
    expect(result.attribution).toEqual(GEONAMES_ATTRIBUTION_FALLBACK);
  });

  it('the fallback attribution is the backend\'s own credit', () => {
    const out = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/modules/geo/geonames-format').GEONAMES_ATTRIBUTION))"], { cwd: backendDir, encoding: 'utf8' });
    expect(JSON.parse(out.stdout)).toEqual(GEONAMES_ATTRIBUTION_FALLBACK);
  });
});

describe('failures and retry', () => {
  it('retries once after a network failure and then succeeds', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce({ cities: [MUMBAI] });
    const sleep = jest.fn().mockResolvedValue();
    const result = await searchCities(fetcher, 'mumb', { sleep });
    expect(result.cities).toEqual([MUMBAI]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a server failure (500, 503) once, then gives up with the error', async () => {
    for (const status of [500, 503]) {
      const fetcher = jest.fn().mockRejectedValue(httpError(status));
      await expect(searchCities(fetcher, 'mumb', { sleep: noSleep })).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('does not retry what would only be refused again (400, 401, 429)', async () => {
    for (const status of [400, 401, 429]) {
      const fetcher = jest.fn().mockRejectedValue(httpError(status));
      await expect(searchCities(fetcher, 'mumb', { sleep: noSleep })).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('a person pressing Retry searches again and gets the answer', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce({ cities: [MUMBAI] });
    await expect(searchCities(fetcher, 'mumb', { sleep: noSleep })).rejects.toMatchObject({ status: 429 });
    expect((await searchCities(fetcher, 'mumb', { sleep: noSleep })).cities).toEqual([MUMBAI]);
  });

  it('retries can be turned off', async () => {
    const fetcher = jest.fn().mockRejectedValue(httpError(503));
    await expect(searchCities(fetcher, 'mumb', { retries: 0, sleep: noSleep })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('classifies what is worth retrying', () => {
    expect(isRetryable(new TypeError('Network request failed'))).toBe(true);
    expect(isRetryable(httpError(502))).toBe(true);
    expect(isRetryable(httpError(404))).toBe(false);
    expect(isRetryable(httpError(429))).toBe(false);
  });

  it('says what went wrong in words, and whether Retry could help', () => {
    expect(describeCityError(httpError(400, { fields: { q: 'Enter between 2 and 80 characters.' } }))).toEqual({ kind: 'invalid', retry: false, message: 'Enter between 2 and 80 characters.' });
    expect(describeCityError(httpError(429))).toMatchObject({ kind: 'busy', retry: true });
    expect(describeCityError(httpError(503))).toMatchObject({ kind: 'unavailable', retry: true });
    expect(describeCityError(httpError(500))).toMatchObject({ kind: 'failed', retry: true });
    expect(describeCityError(new TypeError('Network request failed'))).toMatchObject({ kind: 'network', retry: true });
    expect(describeCityError(undefined)).toMatchObject({ kind: 'network', retry: true });
    for (const err of [httpError(429), httpError(503), httpError(500), new TypeError('x')]) expect(describeCityError(err).message).not.toMatch(/Error|undefined|TypeError/);
  });
});
