// The GeoNames importer: which dump lines become cities, what is kept as their other names, and that
// importing (and re-importing) the file leaves the tables right. The dump fixture
// (tests/fixtures/geonames-sample.txt) is real rows from the official cities15000 file (Munich with
// its full list of other names) plus synthetic ones (ids from 900000000 up) for every kind of row
// that must be skipped. Runs on the test database (humancare_test).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prisma } = require('../src/db/prisma');
const { importDump, looksLikeDump, DEFAULT_ALT_MIN_POPULATION } = require('../src/modules/geo/geonames-import');
const {
  parseGeonamesLine, parseAdmin1Names, cleanAlternateNames, isAcceptablePlace, EXCLUDED_FEATURE_CODES, HISTORICAL_FEATURE_CODES,
  SUBDIVISION_FEATURE_CODES, MAX_INT, MAX_ALTERNATE_NAMES, GEONAMES_ATTRIBUTION,
} = require('../src/modules/geo/geonames-format');
const { IDS } = require('./fixtures/geo-cities');

const FIXTURE = path.join(__dirname, 'fixtures', 'geonames-sample.txt');
const ADMIN1 = path.join(__dirname, 'fixtures', 'geonames-admin1.txt');
const lines = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean);
const lineFor = (id) => lines.find((line) => line.startsWith(`${id}\t`));
const admin1 = parseAdmin1Names(fs.readFileSync(ADMIN1, 'utf8'));
const withColumns = (line, changes) => {
  const columns = line.split('\t');
  for (const [index, value] of Object.entries(changes)) columns[index] = value;
  return columns.join('\t');
};

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geonames-test-')); });
afterAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
});

describe('which lines become cities', () => {
  it('keeps a populated place with its names, country, region, population and timezone', () => {
    expect(parseGeonamesLine(lineFor(IDS.MUMBAI), admin1)).toEqual({
      row: {
        geonameId: 1275339, name: 'Mumbai', asciiName: 'Mumbai', admin1Name: 'Maharashtra',
        countryCode: 'IN', featureCode: 'PPLA', population: 12691836, timezone: 'Asia/Kolkata', alternateNames: [],
      },
    });
  });

  it('keeps non-ASCII names as they are, with the plain-ASCII spelling alongside', () => {
    const { row } = parseGeonamesLine(lineFor(IDS.ZURICH), admin1);
    expect(row).toMatchObject({ name: 'Zürich', asciiName: 'Zuerich', admin1Name: 'Zurich', timezone: 'Europe/Zurich' });
  });

  it('has no region name when the region file is not given or has no entry', () => {
    expect(parseGeonamesLine(lineFor(IDS.MUMBAI)).row.admin1Name).toBeNull();
    expect(parseGeonamesLine(lineFor(IDS.KIRITIMATI), admin1).row.admin1Name).toBeNull();
  });

  it.each([
    [IDS.HISTORICAL, 'historical-or-abandoned'], // real PPLH
    [900000006, 'historical-or-abandoned'], // PPLQ abandoned
    [900000007, 'historical-or-abandoned'], // PPLW destroyed
    [900000008, 'historical-or-abandoned'], // PPLCH historical capital
    [IDS.SUBDIVISION, 'subdivision'], // real PPLX: Zürich (Kreis 11) / Seebach
    [900000005, 'not-a-populated-place'], // feature class T
    [900000003, 'no-timezone'],
    [900000004, 'unknown-timezone'],
    [900000009, 'bad-country'],
  ])('skips %s (%s)', (id, reason) => {
    expect(parseGeonamesLine(lineFor(id), admin1)).toEqual({ skip: reason });
  });

  it.each(['', 'not-a-number\tBroken Row', 'x\ty', '0\ta\ta\t\t0\t0\tP\tPPL\tGB\t\t\t\t\t\t0\t\t\tEurope/London\t2024-01-01'])('skips a malformed line: %j', (line) => {
    expect(parseGeonamesLine(line)).toEqual({ skip: 'malformed' });
  });

  it('caps a population that does not fit the INT column, and treats a missing one as 0', () => {
    const base = lineFor(IDS.MUMBAI);
    expect(parseGeonamesLine(withColumns(base, { 14: '99999999999' })).row.population).toBe(MAX_INT);
    expect(parseGeonamesLine(withColumns(base, { 14: '' })).row.population).toBe(0);
    expect(parseGeonamesLine(withColumns(base, { 14: '-7' })).row.population).toBe(0);
  });

  it('carries the CC BY credit', () => {
    expect(GEONAMES_ATTRIBUTION).toMatchObject({ url: 'https://www.geonames.org', license: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(GEONAMES_ATTRIBUTION.text).toMatch(/GeoNames.*CC BY 4\.0/);
  });
});

describe('place classification', () => {
  it('leaves out historical, abandoned and destroyed places AND subdivisions of a city (PPLX), and nothing else that is populated', () => {
    expect([...HISTORICAL_FEATURE_CODES].sort()).toEqual(['PPLCH', 'PPLH', 'PPLQ', 'PPLW']);
    expect([...SUBDIVISION_FEATURE_CODES]).toEqual(['PPLX']);
    expect([...EXCLUDED_FEATURE_CODES].sort()).toEqual(['PPLCH', 'PPLH', 'PPLQ', 'PPLW', 'PPLX']);
  });

  it.each(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLCD', 'PPLF', 'PPLG', 'PPLL', 'PPLR', 'PPLS'])(
    'keeps %s: a city, town, village or locality',
    (code) => { expect(isAcceptablePlace('P', code)).toBe(true); },
  );

  it.each(['PPLX', 'PPLH', 'PPLCH', 'PPLQ', 'PPLW', ''])('refuses %s', (code) => {
    expect(isAcceptablePlace('P', code)).toBe(false);
  });

  it('refuses everything that is not a populated place', () => {
    expect(isAcceptablePlace('A', 'ADM1')).toBe(false);
    expect(isAcceptablePlace('T', 'MT')).toBe(false);
    expect(isAcceptablePlace('S', 'AIRP')).toBe(false);
  });

  it('parses a PPLX line as a subdivision whatever else is right about it', () => {
    const line = withColumns(lineFor(IDS.MUMBAI), { 7: 'PPLX' });
    expect(parseGeonamesLine(line, admin1)).toEqual({ skip: 'subdivision' });
  });

  it('keeps the cities and towns a subdivision belongs to', () => {
    expect(parseGeonamesLine(lineFor(IDS.ZURICH), admin1).row.featureCode).toBe('PPLA');
    expect(parseGeonamesLine(lineFor(IDS.NEW_YORK), admin1).row.featureCode).toBe('PPL');
  });
});

describe('the other names of a city', () => {
  it('keeps the translations, local spellings and old names of Munich, and not its own names', () => {
    const { row } = parseGeonamesLine(lineFor(IDS.MUNICH), admin1);
    expect(row).toMatchObject({ name: 'Munich', asciiName: 'Munich', admin1Name: 'Bavaria' });
    for (const name of ['Muenchen', 'Monaco di Baviera', 'Mnichov', 'Monachium']) expect(row.alternateNames).toContain(name);
    expect(row.alternateNames.filter((name) => ['München', 'Munchen'].includes(name))).toHaveLength(1); // one spelling, see below
    expect(row.alternateNames).not.toContain('Munich');
    expect(row.alternateNames.length).toBeGreaterThan(40);
    expect(row.alternateNames.length).toBeLessThanOrEqual(MAX_ALTERNATE_NAMES);
  });

  it('does not store two spellings the database treats as one: München and Munchen are one name (the first in the file is kept)', () => {
    const { alternateNames } = parseGeonamesLine(lineFor(IDS.MUNICH), admin1).row;
    expect(alternateNames.filter((name) => ['München', 'Munchen'].includes(name))).toHaveLength(1);
    expect(alternateNames).toContain('Muenchen'); // a different spelling, not just an accent: kept
  });

  it.each([
    ['links', 'http://en.wikipedia.org/wiki/Munich,https://x.org,www.example.com', []],
    ['Wikidata ids', 'Q1726,Q5', []],
    ['only digits and punctuation', '80331,80-331,1.5,+49', []],
    ['one character', 'M,Ä', []],
    ['empty parts', ',,  ,', []],
    ['a name longer than 200 characters', 'x'.repeat(201), []],
  ])('drops %s', (_label, raw, expected) => {
    expect(cleanAlternateNames(raw, ['Munich', 'Munich'])).toEqual(expected);
  });

  it('keeps nicknames, short names, airport codes written as names, and names in any script', () => {
    expect(cleanAlternateNames('NYC,Big Apple,Нью-Йорк,纽约,نيويورك,ニューヨーク,Nueva York', ['New York City', 'New York City']))
      .toEqual(['NYC', 'Big Apple', 'Нью-Йорк', '纽约', 'نيويورك', 'ニューヨーク', 'Nueva York']);
  });

  it('drops repeats, also ones that differ only in case or accents, and the place\'s own names', () => {
    expect(cleanAlternateNames('Zürich,zurich,ZURICH,Zuerich,Zurigo,zurigo', ['Zürich', 'Zuerich'])).toEqual(['Zurigo']);
  });

  it('trims, and normalises composed and decomposed accents to one form', () => {
    const decomposed = 'München'; // u + combining diaeresis
    expect(cleanAlternateNames(`  ${decomposed}  `, ['Munich', 'Munich'])).toEqual(['München']);
  });

  it(`stops at ${MAX_ALTERNATE_NAMES} names per place`, () => {
    const raw = Array.from({ length: 400 }, (_, i) => `Name${i}x`).join(',');
    expect(cleanAlternateNames(raw, ['A', 'A'])).toHaveLength(MAX_ALTERNATE_NAMES);
  });

  it('handles an empty column', () => {
    expect(cleanAlternateNames('', ['A', 'A'])).toEqual([]);
    expect(cleanAlternateNames(undefined, ['A', 'A'])).toEqual([]);
  });
});

describe('importing a file', () => {
  const at = (iso) => new Date(iso);

  it('loads the right cities and counts everything it skipped', async () => {
    const stats = await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1, now: at('2031-01-01T00:00:00Z') });
    expect(stats).toMatchObject({
      linesRead: 19, accepted: 9, written: 9, removedExcluded: 0, admin1NamesLoaded: 7, dryRun: false,
      skipped: { 'historical-or-abandoned': 4, subdivision: 1, 'not-a-populated-place': 1, 'no-timezone': 1, 'unknown-timezone': 1, 'bad-country': 1, malformed: 1 },
    });
    const cities = await prisma.geonamesCity.findMany({ orderBy: { geonameId: 'asc' } });
    expect(cities.map((c) => c.geonameId)).toEqual([292223, 1275339, 2179537, 2657896, 2867714, 5128581, 5368361, 900000001, 900000002]);
    expect(cities.every((c) => c.verifiedAt.toISOString() === '2031-01-01T00:00:00.000Z')).toBe(true);
    for (const excluded of [IDS.HISTORICAL, 900000006, 900000007, 900000008, IDS.SUBDIVISION]) {
      expect(await prisma.geonamesCity.findUnique({ where: { geonameId: excluded } })).toBeNull();
    }
  });

  it('stores Unicode names and the region name exactly', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    expect(await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.ZURICH } })).toMatchObject({
      name: 'Zürich', asciiName: 'Zuerich', admin1Name: 'Zurich', countryCode: 'CH', featureCode: 'PPLA', timezone: 'Europe/Zurich', population: 415367,
    });
  });

  it('stores the other names of a city, found by any of them, under the canonical city', async () => {
    const stats = await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    const stored = await prisma.geonamesCityName.findMany({ where: { geonameId: IDS.MUNICH }, select: { name: true, population: true } });
    expect(stored.length).toBeGreaterThan(40);
    expect(stored.map((n) => n.name)).toEqual(expect.arrayContaining(['Muenchen', 'Monaco di Baviera', 'Mnichov']));
    // whichever of München / Munchen was stored, both are found, because the table ignores accents
    for (const spelling of ['München', 'Munchen']) {
      expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH, name: { equals: spelling } } })).toBe(1);
    }
    expect(stored.every((n) => n.population === 1505005)).toBe(true);
    expect(stats.alternateNamesWritten).toBe(await prisma.geonamesCityName.count());
    expect(stats.alternateNames).toBe(stats.alternateNamesWritten);
  });

  it('works in many small batches just the same', async () => {
    const stats = await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1, batchSize: 3 });
    expect(stats.written).toBe(9);
    expect(await prisma.geonamesCity.count()).toBe(9);
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBeGreaterThan(40);
  });

  it('writes nothing in a dry run, and still reports the counts', async () => {
    const stats = await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1, dryRun: true });
    expect(stats).toMatchObject({ accepted: 9, written: 0, alternateNamesWritten: 0, dryRun: true });
    expect(stats.alternateNames).toBeGreaterThan(40);
    expect(await prisma.geonamesCity.count()).toBe(0);
    expect(await prisma.geonamesCityName.count()).toBe(0);
  });

  it('can be run again: records are updated, not duplicated, and get the new verified_at', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1, now: at('2031-01-01T00:00:00Z') });
    const namesBefore = await prisma.geonamesCityName.count();
    const second = path.join(tmp, 'second.txt');
    fs.writeFileSync(second, lines.map((line) => (line.startsWith(`${IDS.MUMBAI}\t`) ? withColumns(line, { 14: '13000000', 17: 'Asia/Calcutta' }) : line)).join('\n'));
    const stats = await importDump({ prisma, file: second, admin1File: ADMIN1, now: at('2031-03-01T00:00:00Z') });
    expect(stats.written).toBe(9);
    expect(await prisma.geonamesCity.count()).toBe(9);
    expect(await prisma.geonamesCityName.count()).toBe(namesBefore); // replaced, not doubled
    expect(await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.MUMBAI } })).toMatchObject({
      population: 13000000, timezone: 'Asia/Calcutta', verifiedAt: at('2031-03-01T00:00:00Z'),
    });
  });

  it('replaces the other names with the ones in the new file: a name GeoNames dropped stops matching', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH, name: 'Mnichov' } })).toBe(1);
    const second = path.join(tmp, 'fewer-names.txt');
    fs.writeFileSync(second, lines.map((line) => (line.startsWith(`${IDS.MUNICH}\t`) ? withColumns(line, { 3: 'München,Minga' }) : line)).join('\n'));
    await importDump({ prisma, file: second, admin1File: ADMIN1 });
    expect((await prisma.geonamesCityName.findMany({ where: { geonameId: IDS.MUNICH } })).map((n) => n.name).sort()).toEqual(['Minga', 'München']);
  });

  it('removes a city the dump now lists as historical, with its other names, straight away', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBeGreaterThan(0);
    const second = path.join(tmp, 'munich-gone.txt');
    fs.writeFileSync(second, lines.map((line) => (line.startsWith(`${IDS.MUNICH}\t`) ? withColumns(line, { 7: 'PPLH' }) : line)).join('\n'));
    const stats = await importDump({ prisma, file: second, admin1File: ADMIN1 });
    expect(stats.removedExcluded).toBeGreaterThanOrEqual(1);
    expect(await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.MUNICH } })).toBeNull();
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBe(0);
    expect(await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.MUMBAI } })).not.toBeNull();
  });

  it('removes a place that earlier imports kept but the dump now classes as a subdivision (PPLX)', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    // an older import (before PPLX was left out) had stored it:
    await prisma.geonamesCity.create({ data: { geonameId: IDS.SUBDIVISION, name: 'Zürich (Kreis 11) / Seebach', asciiName: 'Zuerich (Kreis 11) / Seebach', countryCode: 'CH', featureCode: 'PPLX', timezone: 'Europe/Zurich', verifiedAt: new Date() } });
    await prisma.geonamesCityName.create({ data: { geonameId: IDS.SUBDIVISION, name: 'Seebach', population: 0 } });
    const stats = await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1 });
    expect(stats.removedExcluded).toBe(1);
    expect(await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.SUBDIVISION } })).toBeNull();
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.SUBDIVISION } })).toBe(0);
  });

  it('leaves a city that is missing from a newer file alone, with its old verified_at, so it ages out', async () => {
    await importDump({ prisma, file: FIXTURE, admin1File: ADMIN1, now: at('2031-01-01T00:00:00Z') });
    const partial = path.join(tmp, 'partial.txt');
    fs.writeFileSync(partial, [lineFor(IDS.MUMBAI)].join('\n'));
    await importDump({ prisma, file: partial, now: at('2031-06-01T00:00:00Z') });
    expect(await prisma.geonamesCity.count()).toBe(9);
    expect((await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.MUMBAI } })).verifiedAt).toEqual(at('2031-06-01T00:00:00Z'));
    expect((await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.DUBAI } })).verifiedAt).toEqual(at('2031-01-01T00:00:00Z'));
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBeGreaterThan(0); // untouched
  });

  describe('which places keep their other names', () => {
    const smallTown = (population) => withColumns(lineFor(IDS.MUNICH), { 0: '900000020', 1: 'Smalltown', 2: 'Smalltown', 3: 'Kleinstadt,Petite Ville', 14: String(population) });
    const file = (population) => {
      const f = path.join(tmp, `small-${population}.txt`);
      fs.writeFileSync(f, `${smallTown(population)}\n`);
      return f;
    };

    it(`defaults to places with a known population (at least ${DEFAULT_ALT_MIN_POPULATION})`, async () => {
      expect(DEFAULT_ALT_MIN_POPULATION).toBe(1);
      await importDump({ prisma, file: file(0) });
      expect(await prisma.geonamesCity.findUnique({ where: { geonameId: 900000020 } })).not.toBeNull(); // the city itself is always kept
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(0);
      await importDump({ prisma, file: file(1) });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(2);
    });

    it('keeps every place\'s names with altMinPopulation 0, and only bigger places with a higher floor', async () => {
      await importDump({ prisma, file: file(0), altMinPopulation: 0 });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(2);
      await prisma.geonamesCityName.deleteMany();
      await importDump({ prisma, file: file(500), altMinPopulation: 1000 });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(0);
      await importDump({ prisma, file: file(1000), altMinPopulation: 1000 });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(2);
    });

    it('drops the names of a place that falls under the floor on a later import', async () => {
      await importDump({ prisma, file: file(5000), altMinPopulation: 1000 });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(2);
      await importDump({ prisma, file: file(10), altMinPopulation: 1000 });
      expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000020 } })).toBe(0);
    });
  });

  it('does not fail on two names the database treats as one (ß and ss)', async () => {
    const f = path.join(tmp, 'sharp-s.txt');
    fs.writeFileSync(f, `${withColumns(lineFor(IDS.MUNICH), { 0: '900000021', 1: 'Streetville', 2: 'Streetville', 3: 'Straße,Strasse,Gasse' })}\n`);
    const stats = await importDump({ prisma, file: f });
    expect(stats.written).toBe(1);
    expect(await prisma.geonamesCityName.count({ where: { geonameId: 900000021 } })).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['an HTML error page saved as .txt', '<html><body>404 Not Found</body></html>\n<p>nothing here</p>\n'],
    ['a CSV', 'id,name,country\n1,Mumbai,IN\n'],
    ['an empty file', ''],
  ])('refuses %s before touching the table', async (_label, content) => {
    const file = path.join(tmp, 'not-a-dump.txt');
    fs.writeFileSync(file, content);
    await prisma.geonamesCity.create({ data: { geonameId: 1, name: 'Keep', asciiName: 'Keep', countryCode: 'GB', featureCode: 'PPL', timezone: 'Europe/London', verifiedAt: new Date() } });
    await expect(importDump({ prisma, file })).rejects.toThrow(/does not look like a GeoNames dump/);
    expect(await looksLikeDump(file)).toBe(false);
    expect(await prisma.geonamesCity.count()).toBe(1);
  });

  it('reads the Windows line endings of a dump saved on Windows', async () => {
    const file = path.join(tmp, 'crlf.txt');
    fs.writeFileSync(file, `${lineFor(IDS.MUMBAI)}\r\n${lineFor(IDS.DUBAI)}\r\n`);
    expect((await importDump({ prisma, file })).written).toBe(2);
    expect((await prisma.geonamesCity.findUnique({ where: { geonameId: IDS.DUBAI } })).timezone).toBe('Asia/Dubai');
  });
});

describe('scripts/import-geonames.js', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/import-geonames.js', ...args], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
  });

  it('needs --file', () => {
    const result = run('--env-file', '.env.test');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage/);
  });

  it('refuses to write unless --confirm-database names the target database', async () => {
    const result = run('--file', FIXTURE, '--env-file', '.env.test', '--confirm-database', 'some_other_db');
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Target: database "humancare_test"/);
    expect(result.stderr).toMatch(/Refusing to write/);
    expect(await prisma.geonamesCity.count()).toBe(0);
    expect(run('--file', FIXTURE, '--env-file', '.env.test').status).toBe(2); // no confirmation at all
    expect(await prisma.geonamesCity.count()).toBe(0);
  });

  it('prints the target and never the password', () => {
    const result = run('--file', FIXTURE, '--env-file', '.env.test', '--dry-run');
    expect(result.status).toBe(0);
    const password = new URL(require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env.test'))).DATABASE_URL).password;
    expect(password.length).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).not.toContain(password);
  });

  it('a dry run needs no confirmation and writes nothing', async () => {
    const result = run('--file', FIXTURE, '--admin1', ADMIN1, '--env-file', '.env.test', '--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DRY RUN/);
    expect(await prisma.geonamesCity.count()).toBe(0);
  });

  it('imports when the database is confirmed, and reports what the tables hold', async () => {
    const result = run('--file', FIXTURE, '--admin1', ADMIN1, '--env-file', '.env.test', '--confirm-database', 'humancare_test');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/geonames_cities now holds 9 records and geonames_city_names \d+/);
    expect(await prisma.geonamesCity.count()).toBe(9);
    expect(await prisma.geonamesCityName.count({ where: { geonameId: IDS.MUNICH } })).toBeGreaterThan(40);
  });

  it('takes --alt-min-population, and refuses a value that is not a whole number', async () => {
    const all = run('--file', FIXTURE, '--admin1', ADMIN1, '--env-file', '.env.test', '--dry-run', '--alt-min-population', '0');
    expect(all.status).toBe(0);
    expect(all.stdout).toMatch(/"altMinPopulation": 0/);
    const none = run('--file', FIXTURE, '--env-file', '.env.test', '--dry-run', '--alt-min-population', '99999999');
    expect(none.stdout).toMatch(/"alternateNames": 0/);
    for (const bad of ['abc', '-1', '1.5', '']) {
      const result = run('--file', FIXTURE, '--env-file', '.env.test', '--dry-run', '--alt-min-population', bad);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/whole number/);
    }
  });

  it('exits with an error for a file that is not a dump', () => {
    const file = path.join(tmp, 'bad.txt');
    fs.writeFileSync(file, 'nope\n');
    const result = run('--file', file, '--env-file', '.env.test', '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not look like a GeoNames dump/);
  });
});

describe('the region file', () => {
  it('maps "CC.code" to the ASCII region name and ignores blank or short lines', () => {
    const names = parseAdmin1Names('IN.16\tMaharashtra\tMaharashtra\t1264418\n\nBROKEN\nUS.NY\tNew York\tNew York\t5128638\r\n');
    expect(names.get('IN.16')).toBe('Maharashtra');
    expect(names.get('US.NY')).toBe('New York');
    expect(names.size).toBe(2);
  });
});
