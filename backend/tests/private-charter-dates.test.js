// Private Charter end to end against the test database (humancare_test): verified cities and the
// preferred date as a calendar day, from the request body to the DATE column, the API responses,
// the Case, the Bitrix lead and the PDF. The timezone-sensitive parts run in child processes with
// a real TZ (Jest cannot change the timezone from inside a test: see helpers/in-timezone.js).
// Same stand-ins as requests.test.js: no real OTP delivery and no real Bitrix call in tests.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient } = require('./helpers');
const { inTimeZone } = require('./helpers/in-timezone');
const { pdfLines, valueAfter } = require('./helpers/pdf-text');
const { buildLeadFields, leadInputFromRequest } = require('../src/modules/bitrix/bitrix-lead');
const { todayInTimeZone } = require('../src/common/utils/local-date');
const { IDS, ROWS } = require('./fixtures/geo-cities');

const DAY = 24 * 60 * 60 * 1000;
const addDays = (isoDay, days) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const inDays = (days) => addDays(todayInTimeZone('UTC'), days);

let patient;
beforeAll(async () => {
  await prisma.geonamesCity.deleteMany();
  await prisma.geonamesCity.createMany({ data: ROWS.map((row) => ({ ...row, verifiedAt: new Date() })) });
  patient = await createPatient();
});
afterAll(async () => {
  await prisma.geonamesCity.deleteMany();
  await prisma.$disconnect();
});

const body = (overrides = {}) => ({
  serviceKey: 'privatecharter',
  patientName: 'Maria Fernandez',
  patientAge: 47,
  patientGender: 'female',
  country: 'AE',
  origin: { geonameId: IDS.MUMBAI },
  destination: { geonameId: IDS.DUBAI },
  patientContact: '+971501234567',
  preferredDate: inDays(5),
  careLevel: ['care_icu'],
  mobility: 'bedridden',
  urgency: 'urgent_24h',
  ...overrides,
});
const post = (payload) => request(app).post('/requests').set('Authorization', `Bearer ${patient.token}`).send(payload);
const get = (url) => request(app).get(url).set('Authorization', `Bearer ${patient.token}`);
const rawDay = async (id) => (await prisma.$queryRawUnsafe('SELECT DATE_FORMAT(preferred_date, "%Y-%m-%d") AS day FROM service_requests WHERE id = ?', id))[0].day;

describe('a valid Private Charter request', () => {
  let created;
  const date = inDays(5);
  beforeAll(async () => { created = await post(body({ preferredDate: date })); });

  it('is saved (201) with the verified cities, not what the client could say', async () => {
    expect(created.status).toBe(201);
    expect(created.body.request).toMatchObject({
      serviceType: 'Private Charter Air Ambulance Service',
      serviceKey: 'privatecharter',
      origin: 'Mumbai, Maharashtra, India',
      originCityName: 'Mumbai',
      originCountryCode: 'IN',
      destination: 'Dubai, United Arab Emirates',
      destinationCityName: 'Dubai',
      destinationCountryCode: 'AE',
      country: 'AE',
    });
    const saved = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id } });
    expect(saved).toMatchObject({ originGeonameId: IDS.MUMBAI, originTimezone: 'Asia/Kolkata', destinationGeonameId: IDS.DUBAI, destinationCountryCode: 'AE' });
  });

  it('keeps the preferred date as that calendar day in the DATE column', async () => {
    expect(await rawDay(created.body.request.id)).toBe(date);
  });

  it('answers the preferred date in the same ISO midnight-UTC form as before, everywhere a request is returned', async () => {
    const iso = `${date}T00:00:00.000Z`;
    expect(created.body.request.preferredDate).toBe(iso);
    expect((await get(`/requests/me/${created.body.request.id}`)).body.request.preferredDate).toBe(iso);
    const list = (await get('/requests/me')).body.requests.find((r) => r.id === created.body.request.id);
    expect(list.preferredDate).toBe(iso);
  });

  it('creates the Case and its first stage event, with the readable city labels', async () => {
    const saved = await prisma.case.findUnique({ where: { serviceRequestId: created.body.request.id }, include: { stageEvents: true } });
    expect(saved).toMatchObject({ origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', urgency: 'urgent' });
    expect(saved.stageEvents.map((e) => e.stage)).toEqual(['submitted']);
  });

  it('puts the readable cities and the same day on the Bitrix lead', async () => {
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id } });
    const fields = buildLeadFields(leadInputFromRequest(row, { name: 'Test Patient', mobile: '+919000000000', email: 'a@example.com' }));
    expect(fields.TITLE).toBe('Mumbai, Maharashtra, India to Dubai, United Arab Emirates');
    expect(fields.UF_CRM_1768812307305).toBe('Mumbai, Maharashtra, India'); // Pickup City
    expect(fields.UF_CRM_1768812329423).toBe('Dubai, United Arab Emirates'); // Drop City
    expect(fields.UF_CRM_1775637683789).toBe(date); // Date Of Service
  });

  it('prints that day, and those cities, in the downloadable PDF summary', async () => {
    const res = await get(`/requests/me/${created.body.request.id}/summary`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    const lines = pdfLines(res.body);
    const [y, m, d] = date.split('-').map(Number);
    const expected = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${String(d).padStart(2, '0')} ${y}`;
    expect(valueAfter(lines, 'Date Of Service:')).toBe(expected);
    expect(valueAfter(lines, 'From:')).toBe('Mumbai, Maharashtra, India');
    expect(valueAfter(lines, 'To:')).toBe('Dubai, United Arab Emirates');
  });
});

describe('the calendar day never shifts, whatever timezone the server runs in', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Asia/Kolkata'])(
    'server in %s: write, read back, serialise',
    (zone) => {
      const day = inDays(9);
      const out = inTimeZone(
        zone,
        "require('./tests/helpers/date-roundtrip').main().then((r) => console.log(JSON.stringify(r)))",
        [String(patient.user.id), day],
      );
      if (zone !== 'UTC') expect(out.offsetMinutes).not.toBe(0); // the child really is in another zone
      expect(out.sqlDay).toBe(day);
      expect(out.sqlText).toBe(day); // a DATE column holds no time at all
      expect(out.readBack).toBe(`${day}T00:00:00.000Z`);
      expect(out.json).toBe(`${day}T00:00:00.000Z`);
      expect(out.utcDay).toBe(day);
      expect(out.returnedFromCreate).toBe(`${day}T00:00:00.000Z`);
    },
  );

  it('a year end and a leap day survive as well', () => {
    for (const day of ['2031-12-31', '2032-02-29', '2032-01-01']) {
      const out = inTimeZone('Pacific/Pago_Pago', "require('./tests/helpers/date-roundtrip').main().then((r) => console.log(JSON.stringify(r)))", [String(patient.user.id), day]);
      expect(out.sqlDay).toBe(day);
      expect(out.readBack).toBe(`${day}T00:00:00.000Z`);
    }
  });
});

describe("no past date, judged in the origin city's timezone, through the real API", () => {
  const cases = [
    ['Auckland', IDS.AUCKLAND, 'Pacific/Auckland'],
    ['Pago Pago', IDS.PAGO_PAGO, 'Pacific/Pago_Pago'],
    ['Kiritimati', IDS.KIRITIMATI, 'Pacific/Kiritimati'],
    ['Los Angeles', IDS.LOS_ANGELES, 'America/Los_Angeles'],
    ['Mumbai', IDS.MUMBAI, 'Asia/Kolkata'],
  ];

  it.each(cases)('origin %s: its own today is accepted, its own yesterday is refused', async (_name, id, zone) => {
    const today = todayInTimeZone(zone);
    const ok = await post(body({ origin: { geonameId: id }, preferredDate: today }));
    expect(ok.status).toBe(201);
    expect(await rawDay(ok.body.request.id)).toBe(today);

    const before = await prisma.serviceRequest.count();
    const past = await post(body({ origin: { geonameId: id }, preferredDate: addDays(today, -1) }));
    expect(past.status).toBe(400);
    expect(past.body.fields.preferredDate).toMatch(/past/);
    expect(await prisma.serviceRequest.count()).toBe(before);
  });
});

describe('refused and unavailable requests save nothing', () => {
  it('writes no request, case or event for an invalid city', async () => {
    const counts = async () => [await prisma.serviceRequest.count(), await prisma.case.count(), await prisma.caseStageEvent.count()];
    const before = await counts();
    for (const origin of ['Mumbai', { geonameId: IDS.NOT_IN_TABLE }, { geonameId: IDS.HISTORICAL }, { geonameId: IDS.MUMBAI, name: 'Mumbai' }]) {
      expect((await post(body({ origin }))).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  });

  it('answers 503 and saves nothing when the city records are older than 180 days', async () => {
    await prisma.geonamesCity.updateMany({ data: { verifiedAt: new Date(Date.now() - 181 * DAY) } });
    const before = await prisma.serviceRequest.count();
    const res = await post(body());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('city_data_stale');
    expect(await prisma.serviceRequest.count()).toBe(before);
    await prisma.geonamesCity.updateMany({ data: { verifiedAt: new Date() } });
    expect((await post(body())).status).toBe(201);
  });

  it('answers 503 and saves nothing when no city data has been imported', async () => {
    await prisma.geonamesCity.deleteMany();
    const before = await prisma.serviceRequest.count();
    const res = await post(body());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('city_data_not_loaded');
    expect(await prisma.serviceRequest.count()).toBe(before);
    await prisma.geonamesCity.createMany({ data: ROWS.map((row) => ({ ...row, verifiedAt: new Date() })) });
  });
});

describe('other services keep their behaviour', () => {
  const ground = (extra = {}) => ({ serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'J Smith', origin: 'Pune', destination: 'Mumbai', ...extra });

  it('still takes plain-text cities and stores no city metadata', async () => {
    const res = await post(ground({ preferredDate: inDays(4) }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ origin: 'Pune', destination: 'Mumbai', originCityName: null, originCountryCode: null });
    const stored = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(stored).toMatchObject({ originGeonameId: null, originCityName: null, originCountryCode: null, originTimezone: null, destinationGeonameId: null });
  });

  it('stores a plain YYYY-MM-DD preferred date as that day and returns the same ISO form as before', async () => {
    const day = inDays(6);
    const res = await post(ground({ preferredDate: day }));
    expect(await rawDay(res.body.request.id)).toBe(day);
    expect(res.body.request.preferredDate).toBe(`${day}T00:00:00.000Z`);
  });

  it('still allows a request without a preferred date', async () => {
    const res = await post(ground());
    expect(res.status).toBe(201);
    expect(res.body.request.preferredDate).toBeNull();
  });

  it('reduces a full timestamp from an older client to its UTC day (the time of day is not kept)', async () => {
    const res = await post(ground({ preferredDate: '2031-05-05T22:30:00.000Z' }));
    expect(await rawDay(res.body.request.id)).toBe('2031-05-05');
  });
});
