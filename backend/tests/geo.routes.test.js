// GET /geo/cities: the type-ahead the request form uses. Real app, real table (humancare_test).
// The routes only need a signed token (requireAuth verifies the JWT), so no account is created.
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { cleanAlternateNames } = require('../src/modules/geo/geonames-format');
const { IDS, ROWS, HISTORICAL_ROW, SUBDIVISION_ROW, ALTERNATE_NAMES } = require('./fixtures/geo-cities');

const patient = jwt.sign({ sub: 4242, role: 'patient' }, process.env.JWT_ACCESS_SECRET);
const corporate = jwt.sign({ sub: 7, role: 'corporate', corporateId: 1 }, process.env.JWT_ACCESS_SECRET);
const get = (url, token = patient) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const DAY = 24 * 60 * 60 * 1000;

const seed = async (verifiedAt = new Date(), rows = [...ROWS, HISTORICAL_ROW, SUBDIVISION_ROW]) => {
  await prisma.geonamesCityName.deleteMany();
  await prisma.geonamesCity.deleteMany();
  await prisma.geonamesCity.createMany({ data: rows.map((row) => ({ ...row, verifiedAt })) });
  // the other names as the importer stores them (same cleaning)
  const names = rows.flatMap((row) => cleanAlternateNames((ALTERNATE_NAMES[row.geonameId] || []).join(','), [row.name, row.asciiName])
    .map((name) => ({ geonameId: row.geonameId, name, population: row.population })));
  if (names.length) await prisma.geonamesCityName.createMany({ data: names });
};

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await prisma.geonamesCityName.deleteMany(); await prisma.geonamesCity.deleteMany(); await prisma.$disconnect(); });

describe('GET /geo/cities: access', () => {
  beforeAll(() => seed());

  it('needs a signed-in patient', async () => {
    expect((await request(app).get('/geo/cities?q=mumbai')).status).toBe(401);
    expect((await get('/geo/cities?q=mumbai', 'not-a-token')).status).toBe(401);
    expect((await get('/geo/cities?q=mumbai', corporate)).status).toBe(403);
  });
});

describe('GET /geo/cities: search', () => {
  beforeAll(() => seed());

  it('returns matching cities with the GeoNames credit', async () => {
    const res = await get('/geo/cities?q=mumbai');
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([{ geonameId: IDS.MUMBAI, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' }]);
    expect(res.body.attribution).toEqual({
      text: 'City data from GeoNames (geonames.org), licensed under CC BY 4.0.',
      url: 'https://www.geonames.org',
      license: 'https://creativecommons.org/licenses/by/4.0/',
    });
  });

  it('finds Zürich from "zurich", trims the query, and never shows the timezone', async () => {
    const res = await get('/geo/cities?q=%20%20zurich%20');
    expect(res.body.cities.map((c) => c.name)).toEqual(['Zürich']);
    expect(JSON.stringify(res.body)).not.toMatch(/timezone|Europe\/Zurich/i);
  });

  it('honours limit', async () => {
    expect((await get('/geo/cities?q=wellington&limit=1')).body.cities).toHaveLength(1);
    expect((await get('/geo/cities?q=wellington&limit=10')).body.cities).toHaveLength(2);
  });

  it('answers an empty list, with the credit, when nothing matches', async () => {
    const res = await get('/geo/cities?q=qqqqqq');
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([]);
    expect(res.body.attribution.url).toBe('https://www.geonames.org');
  });

  it('treats % and _ as plain characters', async () => {
    expect((await get('/geo/cities?q=%25%25')).body.cities).toEqual([]);
    expect((await get('/geo/cities?q=_umbai')).body.cities).toEqual([]);
  });

  it('does not suggest a historical place', async () => {
    expect((await get('/geo/cities?q=pittwater')).body.cities).toEqual([]);
  });

  it('does not suggest a subdivision of a city (PPLX)', async () => {
    expect((await get(`/geo/cities?q=${encodeURIComponent('zürich (kreis')}`)).body.cities).toEqual([]);
    expect((await get('/geo/cities?q=seebach')).body.cities).toEqual([]);
  });
});

describe('GET /geo/cities: other names', () => {
  beforeAll(() => seed());
  const munich = { geonameId: IDS.MUNICH, name: 'Munich', label: 'Munich, Bavaria, Germany', countryCode: 'DE' };

  it.each(['München', 'münchen', 'Munchen', 'Muenchen', 'Monaco di Baviera', 'Мюнхен', '慕尼黑'])('"%s" finds Munich', async (query) => {
    const res = await get(`/geo/cities?q=${encodeURIComponent(query)}`);
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([munich]);
  });

  it('answers with the canonical name, label and id, never the name that was typed', async () => {
    const res = await get(`/geo/cities?q=${encodeURIComponent('Bombay')}`);
    expect(res.body.cities).toEqual([{ geonameId: IDS.MUMBAI, name: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' }]);
    expect(res.text).not.toContain('Bombay');
  });

  it('works in a query with an Arabic name and a nickname', async () => {
    expect((await get(`/geo/cities?q=${encodeURIComponent('دبي')}`)).body.cities.map((c) => c.name)).toEqual(['Dubai']);
    expect((await get('/geo/cities?q=NYC')).body.cities.map((c) => c.name)).toEqual(['New York City']);
  });
});

describe('GET /geo/cities: bad input is a 400 with the field named', () => {
  beforeAll(() => seed());

  it.each([
    ['no q', '/geo/cities', 'q'],
    ['empty q', '/geo/cities?q=', 'q'],
    ['one character', '/geo/cities?q=m', 'q'],
    ['only spaces', '/geo/cities?q=%20%20%20', 'q'],
    ['81 characters', `/geo/cities?q=${'a'.repeat(81)}`, 'q'],
    ['q given twice', '/geo/cities?q=mu&q=bai', 'q'],
    ['a control character', '/geo/cities?q=mum%00bai', 'q'],
    ['a nested q', '/geo/cities?q[a]=mumbai', 'q'],
    ['limit 0', '/geo/cities?q=mumbai&limit=0', 'limit'],
    ['limit 11', '/geo/cities?q=mumbai&limit=11', 'limit'],
    ['limit text', '/geo/cities?q=mumbai&limit=five', 'limit'],
    ['limit decimal', '/geo/cities?q=mumbai&limit=1.5', 'limit'],
  ])('%s', async (_label, url, field) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Please correct the highlighted fields.');
    expect(typeof res.body.fields[field]).toBe('string');
  });

  it('counts characters, not bytes: 2 and 80 characters of another script are fine', async () => {
    expect((await get(`/geo/cities?q=${encodeURIComponent('मुं')}`)).status).toBe(200);
    expect((await get(`/geo/cities?q=${encodeURIComponent('é'.repeat(80))}`)).status).toBe(200);
  });
});

describe('GET /geo/cities: when the city data cannot be trusted it fails closed', () => {
  it('answers 503 "city_data_stale" when the records are older than 180 days', async () => {
    await seed(new Date(Date.now() - 181 * DAY));
    const res = await get('/geo/cities?q=mumbai');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'City verification is temporarily unavailable. Please try again later.', code: 'city_data_stale' });
  });

  it('answers 503 "city_data_not_loaded" when nothing has been imported', async () => {
    await prisma.geonamesCity.deleteMany();
    const res = await get('/geo/cities?q=mumbai');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('city_data_not_loaded');
  });

  it('still answers from records seen 179 days ago', async () => {
    await seed(new Date(Date.now() - 179 * DAY));
    expect((await get('/geo/cities?q=mumbai')).status).toBe(200);
  });
});
