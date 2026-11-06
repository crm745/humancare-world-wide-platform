// City search and verification against the local GeoNames tables (geonames_cities and
// geonames_city_names), on the test database (humancare_test). Data fixtures:
// tests/fixtures/geo-cities.js.
const { prisma } = require('../src/db/prisma');
const geo = require('../src/modules/geo/geo.service');
const { cleanAlternateNames } = require('../src/modules/geo/geonames-format');
const { IDS, ROWS, HISTORICAL_ROW, SUBDIVISION_ROW, ALTERNATE_NAMES } = require('./fixtures/geo-cities');

// What the importer stores for a city's other names: the same cleaning, so two spellings the
// database treats as one name (München / Munchen) are one row, as in a real import.
const storedNames = (row, names) => cleanAlternateNames((names[row.geonameId] || []).join(','), [row.name, row.asciiName]);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2031, 0, 15, 12, 0, 0);
const savedAge = process.env.GEONAMES_MAX_AGE_DAYS;

// Puts the cities, and the other names of the ones that have some, in the tables.
async function seed({ verifiedAt = new Date(NOW - 10 * DAY), rows = ROWS, names = ALTERNATE_NAMES } = {}) {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  await prisma.geonamesCity.createMany({ data: rows.map((row) => ({ ...row, verifiedAt })) });
  const nameRows = rows.flatMap((row) => storedNames(row, names).map((name) => ({ geonameId: row.geonameId, name, population: row.population })));
  if (nameRows.length) await prisma.geonamesCityName.createMany({ data: nameRows });
}

beforeEach(() => {
  delete process.env.GEONAMES_MAX_AGE_DAYS;
  geo.resetFreshnessReminder();
});
afterAll(async () => {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  if (savedAge === undefined) delete process.env.GEONAMES_MAX_AGE_DAYS; else process.env.GEONAMES_MAX_AGE_DAYS = savedAge;
  await prisma.$disconnect();
});

const names = (cities) => cities.map((city) => city.name);
const search = (query, extra = {}) => geo.searchCities(query, { now: NOW, ...extra });

describe('searchCities', () => {
  beforeAll(() => seed({ rows: [...ROWS, HISTORICAL_ROW, SUBDIVISION_ROW] }));

  it('finds cities by the start of the name, biggest first, as { geonameId, name, label, countryCode }', async () => {
    expect(await search('wellin')).toEqual([
      { geonameId: IDS.WELLINGTON, name: 'Wellington', label: 'Wellington, Wellington Region, New Zealand', countryCode: 'NZ' },
      { geonameId: 4177703, name: 'Wellington', label: 'Wellington, Florida, United States', countryCode: 'US' },
    ]);
  });

  it('ignores case and accents: zurich, ZÜRICH and the plain-ASCII spelling all find Zürich', async () => {
    for (const query of ['zurich', 'ZÜRICH', 'Zürich', 'zuerich', 'zür']) {
      expect(names(await search(query))).toEqual(['Zürich']);
    }
  });

  it('never sends the timezone or any other internal field to the client', async () => {
    const [city] = await search('mumbai');
    expect(Object.keys(city).sort()).toEqual(['countryCode', 'geonameId', 'label', 'name']);
  });

  it('honours the limit, never more than 10', async () => {
    expect(await search('mumb', { limit: 1 })).toHaveLength(1);
    await prisma.geonamesCity.createMany({
      data: Array.from({ length: 15 }, (_, i) => ({ ...ROWS[0], geonameId: 800000 + i, name: `Bulk ${i}`, asciiName: `Bulk ${i}`, verifiedAt: new Date(NOW - DAY) })),
    });
    expect(await search('bulk', { limit: 50 })).toHaveLength(10);
    await prisma.geonamesCity.deleteMany({ where: { geonameId: { gte: 800000, lt: 800100 } } });
  });

  it('keeps tiny places out of very short queries only: "mu" and "mum" skip a town of 1,200, "mumb" finds it', async () => {
    expect(names(await search('mu'))).toEqual(['Mumbai', 'Munich']);
    expect(names(await search('mum'))).toEqual(['Mumbai']);
    expect(names(await search('mumb'))).toEqual(['Mumbai', 'Mumbwa Test']);
  });

  it('matches the typed text literally: % and _ are not wildcards', async () => {
    for (const query of ['%', '%%', 'm%', '_umbai', 'mum_ai', '\\']) {
      expect(await search(query)).toEqual([]);
    }
  });

  it('returns an empty list for a query nothing starts with', async () => {
    expect(await search('qqqqqq')).toEqual([]);
  });

  describe('place classification', () => {
    it('does not suggest a historical place even if one got into the table', async () => {
      expect(await search('pittwater')).toEqual([]);
    });

    it('does not suggest a subdivision (PPLX) of a city even if one got into the table', async () => {
      expect(await search('zürich (kreis')).toEqual([]);
      expect(await search('zuerich (kreis')).toEqual([]);
      expect(names(await search('zürich'))).toEqual(['Zürich']);
    });
  });
});

describe('searching by another name', () => {
  beforeAll(() => seed());

  it.each([
    ['München', 'the local spelling with the umlaut'],
    ['münchen', 'lower case'],
    ['MÜNCHEN', 'upper case'],
    ['Munchen', 'without the umlaut'],
    ['muenchen', 'the transliteration'],
    ['Monaco di', 'the Italian name, part of it'],
    ['Mnichov', 'the Czech name'],
    ['Мюнхен', 'Cyrillic'],
    ['мюн', 'Cyrillic, 3 letters, lower case'],
    ['慕尼黑', 'Chinese'],
  ])('%s (%s) finds Munich', async (query) => {
    const found = await search(query);
    expect(found).toEqual([{ geonameId: IDS.MUNICH, name: 'Munich', label: 'Munich, Bavaria, Germany', countryCode: 'DE' }]);
  });

  it('keeps the canonical name, label and id in the result, never the name that matched', async () => {
    for (const query of ['Bombay', 'मुंबई', 'mumbai']) {
      const [city] = await search(query);
      expect(city).toEqual({ geonameId: IDS.MUMBAI, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' });
    }
    expect(JSON.stringify(await search('Bombay'))).not.toContain('Bombay');
  });

  it('finds a city once when several of its names match', async () => {
    expect(names(await search('mun'))).toEqual(['Munich']);
    expect(await search('Mumbai')).toHaveLength(1);
  });

  it('finds Arabic and nickname spellings', async () => {
    expect(names(await search('دبي'))).toEqual(['Dubai']);
    expect(names(await search('NYC'))).toEqual(['New York City']);
    expect(names(await search('nueva'))).toEqual(['New York City']);
  });

  it('ranks by population across all names, and separates same-named places by id', async () => {
    await prisma.geonamesCityName.create({ data: { geonameId: IDS.MUMBWA, name: 'Munchen Test', population: 1200 } });
    const found = await search('munchen');
    expect(names(found)).toEqual(['Munich', 'Mumbwa Test']);
    await prisma.geonamesCityName.delete({ where: { geonameId_name: { geonameId: IDS.MUMBWA, name: 'Munchen Test' } } });
  });

  it('applies the short-query population floor to other names as well', async () => {
    await prisma.geonamesCityName.create({ data: { geonameId: IDS.MUMBWA, name: 'Zzq Town', population: 1200 } });
    expect(await search('zz')).toEqual([]); // 2 letters: a place of 1,200 is not offered
    expect(names(await search('zzq t'))).toEqual(['Mumbwa Test']); // more letters: it is
    await prisma.geonamesCityName.delete({ where: { geonameId_name: { geonameId: IDS.MUMBWA, name: 'Zzq Town' } } });
  });

  it('matches the typed text literally for other names too', async () => {
    for (const query of ['%', 'M%nchen', '_ombay', 'Bom_ay']) expect(await search(query)).toEqual([]);
  });

  it('goes with the city: deleting a city deletes its other names', async () => {
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBe(storedNames(ROWS.find((r) => r.geonameId === IDS.MUNICH), ALTERNATE_NAMES).length);
    await prisma.geonamesCity.delete({ where: { geonameId: IDS.MUNICH } });
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBe(0);
    expect(await search('München')).toEqual([]);
    await seed();
  });
});

describe('ranking across the three name lists', () => {
  // Four places for the prefix "qq": matched by the name, by the plain-ASCII name, and by another
  // name. The best few overall must come out in population order whichever list they came from.
  const place = (geonameId, name, asciiName, population) => ({ geonameId, name, asciiName, admin1Name: null, countryCode: 'GB', featureCode: 'PPL', population, timezone: 'Europe/London' });
  const rows = [
    place(910001, 'Qqalpha', 'Qqalpha', 100000), // by name
    place(910002, 'Other Town', 'Qqbeta', 300000), // by plain-ASCII name only
    place(910003, 'Different Town', 'Different Town', 200000), // by another name only
    place(910004, 'Qqdelta', 'Qqdelta', 50000), // by name
  ];
  beforeAll(async () => {
    await seed({ rows, names: { 910003: ['Qqgamma'] } });
  });

  it('merges them by population: ascii-name match, other-name match, then name matches', async () => {
    expect(names(await search('qq'))).toEqual(['Other Town', 'Different Town', 'Qqalpha', 'Qqdelta']);
  });

  it('keeps the overall best n when they come from different lists', async () => {
    expect(names(await search('qq', { limit: 1 }))).toEqual(['Other Town']);
    expect(names(await search('qq', { limit: 2 }))).toEqual(['Other Town', 'Different Town']);
    expect(names(await search('qq', { limit: 3 }))).toEqual(['Other Town', 'Different Town', 'Qqalpha']);
  });

  it('orders places of the same population by id, so the result never changes between calls', async () => {
    await prisma.geonamesCity.createMany({ data: [place(910010, 'Tiebreak B', 'Tiebreak B', 777), place(910009, 'Tiebreak A', 'Tiebreak A', 777), place(910011, 'Tiebreak C', 'Tiebreak C', 777)].map((r) => ({ ...r, verifiedAt: new Date(NOW - DAY) })) });
    for (let i = 0; i < 3; i += 1) expect((await search('tiebreak')).map((c) => c.geonameId)).toEqual([910009, 910010, 910011]);
    expect((await search('tiebreak', { limit: 2 })).map((c) => c.geonameId)).toEqual([910009, 910010]);
  });

  it('returns a city once even when its name, ASCII name and another name all match', async () => {
    await prisma.geonamesCityName.create({ data: { geonameId: 910001, name: 'Qqalpha Alt', population: 100000 } });
    expect((await search('qqalpha')).filter((c) => c.geonameId === 910001)).toHaveLength(1);
  });
});

describe('getVerifiedCity', () => {
  beforeAll(() => seed({ rows: [...ROWS, HISTORICAL_ROW, SUBDIVISION_ROW] }));

  it('returns the record with its label and timezone', async () => {
    expect(await geo.getVerifiedCity(IDS.MUMBAI, { now: NOW })).toEqual({
      geonameId: IDS.MUMBAI, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN', timezone: 'Asia/Kolkata',
    });
    expect((await geo.getVerifiedCity(IDS.KIRITIMATI, { now: NOW })).timezone).toBe('Pacific/Kiritimati');
    expect((await geo.getVerifiedCity(IDS.MUNICH, { now: NOW })).label).toBe('Munich, Bavaria, Germany');
  });

  it('builds the label from the name, the region when it adds something, and the country name', async () => {
    expect((await geo.getVerifiedCity(IDS.DUBAI, { now: NOW })).label).toBe('Dubai, United Arab Emirates'); // region = name
    expect((await geo.getVerifiedCity(IDS.AUCKLAND, { now: NOW })).label).toBe('Auckland, New Zealand'); // no region
    expect((await geo.getVerifiedCity(IDS.NEW_YORK, { now: NOW })).label).toBe('New York City, New York, United States');
  });

  it('returns null, not an error, for an id that is not a city here', async () => {
    expect(await geo.getVerifiedCity(IDS.NOT_IN_TABLE, { now: NOW })).toBeNull();
    expect(await geo.getVerifiedCity(1, { now: NOW })).toBeNull();
  });

  it('returns null for a historical place and for a subdivision of a city', async () => {
    expect(await geo.getVerifiedCity(IDS.HISTORICAL, { now: NOW })).toBeNull();
    expect(await geo.getVerifiedCity(IDS.SUBDIVISION, { now: NOW })).toBeNull();
  });
});

describe('record age: refused after 180 days (fail closed)', () => {
  const lookup = (age, extra = 0) => seed({ rows: [ROWS[0]], verifiedAt: new Date(NOW - age * DAY - extra) });
  const expectStale = async (promise) => {
    const error = await promise.catch((err) => err);
    expect(error).toBeInstanceOf(geo.CityDataUnavailableError);
    expect(error).toMatchObject({ statusCode: 503, publicCode: 'city_data_stale', message: 'City verification is temporarily unavailable. Please try again later.' });
    return error;
  };

  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('accepts a record seen 1 day, 89, 90, 100 days and exactly 180 days ago', async () => {
    for (const age of [1, 89, 90, 100, 180]) {
      await lookup(age);
      expect((await geo.getVerifiedCity(IDS.MUMBAI, { now: NOW })).name).toBe('Mumbai');
    }
  });

  it('refuses a record one millisecond past 180 days, and everything older', async () => {
    await lookup(180, 1);
    await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
    await lookup(181);
    await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
    await lookup(400);
    await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
  });

  it('keeps the operator detail out of the public message', async () => {
    await lookup(200);
    const error = await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
    expect(error.message).not.toMatch(/import|geonames_cities|180/);
    expect(error.detail).toMatch(/import-geonames/);
  });

  it('can be made stricter than 180 days, never looser', async () => {
    process.env.GEONAMES_MAX_AGE_DAYS = '30';
    await lookup(29);
    expect((await geo.getVerifiedCity(IDS.MUMBAI, { now: NOW })).name).toBe('Mumbai');
    await lookup(31);
    await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));

    process.env.GEONAMES_MAX_AGE_DAYS = '365';
    await lookup(200);
    await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
  });

  it('ignores a setting that is not a positive whole number', async () => {
    for (const value of ['', 'abc', '0', '-5', '1.5x']) {
      process.env.GEONAMES_MAX_AGE_DAYS = value;
      await lookup(179);
      expect((await geo.getVerifiedCity(IDS.MUMBAI, { now: NOW })).name).toBe('Mumbai');
      await lookup(181);
      await expectStale(geo.getVerifiedCity(IDS.MUMBAI, { now: NOW }));
    }
  });

  it('fails a search that would show an expired record, also when it matched by another name', async () => {
    await seed({ verifiedAt: new Date(NOW - 181 * DAY) });
    await expectStale(search('mumbai'));
    await expectStale(search('München'));
  });

  it('a stale record does not matter for a city that is simply not in the table', async () => {
    await lookup(181);
    expect(await geo.getVerifiedCity(IDS.NOT_IN_TABLE, { now: NOW })).toBeNull();
  });
});

describe('freshness status and the 90-day reminder', () => {
  const at = async (ageDays, extra = 0) => {
    await seed({ rows: [ROWS[0], ROWS[1]], names: {}, verifiedAt: new Date(NOW - ageDays * DAY - extra) });
    return geo.getDatasetStatus({ now: NOW });
  };

  it.each([
    [0, 'ok'], [30, 'ok'], [89, 'ok'],
    [90, 'refresh_due'], [91, 'refresh_due'], [150, 'refresh_due'], [179, 'refresh_due'], [180, 'refresh_due'],
  ])('%s days since the last import is "%s"', async (age, state) => {
    expect((await at(age)).state).toBe(state);
  });

  it('is "ok" one millisecond before 90 days, and "refresh_due" at 90 days; "stale" one millisecond past 180', async () => {
    expect((await at(90, -1)).state).toBe('ok');
    expect((await at(90)).state).toBe('refresh_due');
    expect((await at(180)).state).toBe('refresh_due'); // records are still accepted on day 180
    expect((await at(180, 1)).state).toBe('stale');
    expect((await at(181)).state).toBe('stale');
  });

  it('reports the age, the last import time and the two limits', async () => {
    expect(await at(120)).toEqual({
      state: 'refresh_due', lastImportAt: new Date(NOW - 120 * DAY).toISOString(), ageDays: 120, refreshRecommendedAfterDays: 90, maxAgeDays: 180,
    });
  });

  it('is "empty" when nothing is imported', async () => {
    await prisma.geonamesCityName.deleteMany();
    await prisma.geonamesCity.deleteMany();
    expect(await geo.getDatasetStatus({ now: NOW })).toMatchObject({ state: 'empty', lastImportAt: null, ageDays: null });
  });

  it('dates the data by its NEWEST record: old leftovers of a city that left the file do not make it "old"', async () => {
    await seed({ rows: [ROWS[0]], names: {}, verifiedAt: new Date(NOW - 400 * DAY) });
    await prisma.geonamesCity.create({ data: { ...ROWS[1], verifiedAt: new Date(NOW - 5 * DAY) } });
    const status = await geo.getDatasetStatus({ now: NOW, withCounts: true });
    expect(status).toMatchObject({ state: 'ok', ageDays: 5, cities: 2, citiesPastLimit: 1 });
  });

  it('counts the records and the other names when asked', async () => {
    await seed();
    expect(await geo.getDatasetStatus({ now: NOW, withCounts: true })).toMatchObject({
      cities: ROWS.length, alternateNames: ROWS.reduce((sum, row) => sum + storedNames(row, ALTERNATE_NAMES).length, 0), citiesPastLimit: 0,
    });
  });

  it('tightening the limit moves the reminder earlier: with a 60-day limit it starts at 60 days', async () => {
    process.env.GEONAMES_MAX_AGE_DAYS = '60';
    expect((await at(59)).state).toBe('ok');
    expect((await at(60)).state).toBe('refresh_due');
    expect((await at(61)).state).toBe('stale');
    expect((await geo.getDatasetStatus({ now: NOW })).refreshRecommendedAfterDays).toBe(60);
  });

  describe('the reminder in the log', () => {
    let warn;
    let error;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      error = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('is silent while the data is under 90 days old', async () => {
      await at(89);
      expect((await geo.checkDatasetAge({ now: NOW, force: true })).state).toBe('ok');
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('is a warning from 90 days, saying how old the data is and what to do', async () => {
      await at(95);
      await geo.checkDatasetAge({ now: NOW, force: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/last imported 95 days ago.*every 90 days.*refused after 180 days.*GEONAMES-DATASET/);
      expect(error).not.toHaveBeenCalled();
    });

    it('is an error over 180 days, and when nothing is loaded', async () => {
      await at(181);
      await geo.checkDatasetAge({ now: NOW, force: true });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toMatch(/181 days ago.*180-day limit.*refused \(503\)/);

      geo.resetFreshnessReminder();
      await prisma.geonamesCityName.deleteMany();
      await prisma.geonamesCity.deleteMany();
      await geo.checkDatasetAge({ now: NOW, force: true });
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[1][0]).toMatch(/No city data is loaded/);
    });

    it('is repeated at most once a day, and the age is looked at at most once an hour', async () => {
      await at(100);
      await geo.checkDatasetAge({ now: NOW });
      await geo.checkDatasetAge({ now: NOW + 30 * 60 * 1000 }); // within the hour: not even looked at
      await geo.checkDatasetAge({ now: NOW + 2 * 60 * 60 * 1000 }); // looked at, but warned a moment ago
      expect(warn).toHaveBeenCalledTimes(1);
      await geo.checkDatasetAge({ now: NOW + 25 * 60 * 60 * 1000 }); // a day later: again
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('is triggered by a search and by a lookup, without making them wait', async () => {
      await at(100);
      await search('mumbai');
      await geo.getVerifiedCity(IDS.MUMBAI, { now: NOW });
      await new Promise((resolve) => setTimeout(resolve, 200)); // the check runs on its own
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('never throws, whatever the database does', async () => {
      const spy = jest.spyOn(prisma.geonamesCity, 'findFirst').mockRejectedValue(new Error('database gone'));
      await expect(geo.checkDatasetAge({ now: NOW, force: true })).resolves.toBeNull();
      spy.mockRestore();
    });
  });
});

describe('an empty city table', () => {
  beforeAll(async () => { await prisma.geonamesCityName.deleteMany(); await prisma.geonamesCity.deleteMany(); });

  it('is "not loaded" (503), never "no such city" (400) and never a pass', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const call of [() => geo.getVerifiedCity(IDS.MUMBAI), () => geo.searchCities('mumbai')]) {
      const error = await call().catch((err) => err);
      expect(error).toBeInstanceOf(geo.CityDataUnavailableError);
      expect(error).toMatchObject({ statusCode: 503, publicCode: 'city_data_not_loaded' });
    }
    await expect(geo.resolveCityRefs({ origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI } })).rejects.toMatchObject({ statusCode: 503 });
    jest.restoreAllMocks();
  });
});

describe('resolveCityRefs', () => {
  beforeAll(() => seed({ rows: [...ROWS, HISTORICAL_ROW, SUBDIVISION_ROW] }));

  it('verifies both references', async () => {
    const resolved = await geo.resolveCityRefs({ origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI } }, { now: NOW });
    expect(resolved.origin).toMatchObject({ geonameId: IDS.MUMBAI, timezone: 'Asia/Kolkata' });
    expect(resolved.destination).toMatchObject({ geonameId: IDS.DUBAI, countryCode: 'AE' });
  });

  it('gives null for anything that is not a well-formed reference to an allowed city, and does not even query for it', async () => {
    const spy = jest.spyOn(prisma.geonamesCity, 'findUnique');
    const resolved = await geo.resolveCityRefs({
      origin: { geonameId: '1275339' },
      destination: { geonameId: IDS.MUMBAI, timezone: 'UTC' },
    }, { now: NOW });
    expect(resolved).toEqual({ origin: null, destination: null });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    expect(await geo.resolveCityRefs({ origin: 'Mumbai', destination: { geonameId: IDS.HISTORICAL } }, { now: NOW })).toEqual({ origin: null, destination: null });
    expect(await geo.resolveCityRefs({ origin: { geonameId: IDS.SUBDIVISION }, destination: { geonameId: IDS.MUNICH } }, { now: NOW }))
      .toMatchObject({ origin: null, destination: { name: 'Munich' } });
    expect(await geo.resolveCityRefs({}, { now: NOW })).toEqual({ origin: null, destination: null });
  });
});
