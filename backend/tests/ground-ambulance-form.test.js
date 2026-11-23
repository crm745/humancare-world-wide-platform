// Ground Ambulance (serviceKey "ground"): the Present Medical Issue (description) is mandatory; care level = the four critical-level keys (multi-select, optional,
// stored as keys), Required on board = Oxygen only, the oxygen flow rate (LPM) required with Oxygen. Cardiac monitor and Ventilator are refused; Patient mobility
// is no longer asked, and a value an older build still sends is accepted but never stored.
// Older Ground requests keep their values and their display. Every other service, Commercial Air and Private Charter keep their rules.
// Needs the test database, like requests.test.js.
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
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { buildLeadFields, leadInputFromRequest } = require('../src/modules/bitrix/bitrix-lead');
const { isGroundKey, usesCriticalLevelPage, isCommercialAirKey, COMMERCIAL_AIR_CARE_LEVEL_KEYS } = require('../src/common/constants/request.constants');

afterAll(async () => {
  await prisma.$disconnect();
});

const body = (extra = {}) => ({
  serviceType: 'Ground Ambulance',
  serviceKey: 'ground',
  patientName: 'Asha Nair',
  patientAge: 61,
  patientGender: 'Female',
  origin: 'Pune, India',
  destination: 'Mumbai, India',
  patientContact: '+91 98765 43210',
  preferredDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), // Ground / Commercial Air need a contact number and a day that is not past (transport-request.validation.js)
  description: 'Post-surgical patient, needs ICU transfer.',
  urgency: 'urgent_24h',
  ...extra,
});
const post = (token, payload) => request(app).post('/requests').set('Authorization', `Bearer ${token}`).send(payload);
const mine = async (token) => (await request(app).get('/requests/me').set('Authorization', `Bearer ${token}`)).body.requests;

describe('which services the Ground rules cover', () => {
  it('only the key "ground" (not Private Charter, not the older air key, not Commercial Air by this predicate)', () => {
    expect(isGroundKey('ground')).toBe(true);
    for (const key of ['privatecharter', 'air', 'commercialair_stretcher', 'hospital', undefined, null, '']) expect(isGroundKey(key)).toBe(false);
    expect(usesCriticalLevelPage('ground')).toBe(true);
    expect(usesCriticalLevelPage('commercialair_wheelchair')).toBe(true);
    for (const key of ['privatecharter', 'air', 'hospital', 'tele', 'mortal_domestic']) expect(usesCriticalLevelPage(key)).toBe(false);
    expect(isCommercialAirKey('ground')).toBe(false);
  });
});

describe('POST /requests: Ground care level', () => {
  it.each(COMMERCIAL_AIR_CARE_LEVEL_KEYS)('saves %s as the key and returns it everywhere', async (level) => {
    const { token } = await createPatient();
    const res = await post(token, body({ careLevel: level }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe(level);
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.careLevel).toBe(level);
    expect((await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } })).careLevel).toBe(level);
  });

  it('is multi-select: several together, in the order chosen', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ careLevel: 'crit_tracheostomy,crit_icu,crit_ecmo,crit_ventilated' }));
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBe('crit_tracheostomy,crit_icu,crit_ecmo,crit_ventilated');
  });

  it('is optional', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    expect(res.status).toBe(201);
    expect(res.body.request.careLevel).toBeNull();
  });

  it.each([
    ['an original care level key', 'care_icu'],
    ['an original label', 'ICU / Critical'],
    ['a translated label', 'ICU / गंभीर'],
    ['Stable / Monitored', 'care_stable'],
    ['free text', 'critical'],
    ['a good one and a bad one', 'crit_icu,care_na'],
    ['a repeated option', 'crit_icu,crit_icu'],
    ['an empty text', ''],
    ['the wrong case', 'Crit_Icu'],
    ['a list', ['crit_icu']],
    ['a number', 7],
  ])('refuses %s, with the existing { error } format, and saves nothing', async (_name, value) => {
    const { token } = await createPatient();
    const res = await post(token, body({ careLevel: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid careLevel/);
    expect(await mine(token)).toHaveLength(0);
  });
});

describe('POST /requests: Required on board is Oxygen only', () => {
  it('refuses the Cardiac monitor and the Ventilator as equipment', async () => {
    const { token } = await createPatient();
    const cardiac = await post(token, body({ equipCardiacMonitor: true }));
    expect(cardiac.status).toBe(400);
    expect(cardiac.body.error).toBe('equipCardiacMonitor is not accepted for Ground Ambulance requests (Required on board is Oxygen only)');
    const vent = await post(token, body({ equipVentilator: true }));
    expect(vent.status).toBe(400);
    expect(vent.body.error).toBe('equipVentilator is not accepted for Ground Ambulance requests (Ventilated is a care level)');
    for (const field of ['equipCardiacMonitor', 'equipVentilator']) {
      const odd = await post(token, body({ [field]: 'true' }));
      expect(odd.status).toBe(400);
      expect(odd.body.error).toBe(`${field} must be true or false`);
    }
    expect(await mine(token)).toHaveLength(0);
  });

  it('tolerates false for both (older builds always send them) but never stores them', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipCardiacMonitor: false, equipVentilator: false }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ equipCardiacMonitor: null, equipVentilator: null });
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row).toMatchObject({ equipCardiacMonitor: null, equipVentilator: null });
  });

  it('Patient mobility is not required; an older build that still sends it is accepted but it is never stored', async () => {
    const { token } = await createPatient();
    const fresh = await post(token, body());
    expect(fresh.status).toBe(201);
    expect(fresh.body.request.mobility).toBeNull();
    const old = await post(token, body({ mobility: 'walking' }));
    expect(old.status).toBe(201);
    expect(old.body.request.mobility).toBeNull();
    expect((await prisma.serviceRequest.findUnique({ where: { id: old.body.request.id } })).mobility).toBeNull();
  });

  it('still refuses an invalid mobility value, as before', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ mobility: 'flying' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Invalid mobility/);
  });
});

describe('POST /requests: Present Medical Issue is mandatory', () => {
  const MESSAGE = 'description (the Present Medical Issue) is required for Ground Ambulance requests';

  it.each([['missing', undefined], ['null', null], ['an empty text', ''], ['only spaces', '   \n '], ['a number', 7], ['a list', ['x']]])('refuses it %s, and saves nothing', async (_n, value) => {
    const { token } = await createPatient();
    const payload = body();
    if (value === undefined) delete payload.description; else payload.description = value;
    const res = await post(token, payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(MESSAGE);
    expect(await mine(token)).toHaveLength(0);
  });

  it('saves a valid one as typed, returns it everywhere, and keeps it in the database', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ description: 'Acute MI, post-angioplasty. Stable on oxygen.' }));
    expect(res.status).toBe(201);
    expect(res.body.request.description).toBe('Acute MI, post-angioplasty. Stable on oxygen.');
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request.description).toBe('Acute MI, post-angioplasty. Stable on oxygen.');
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row.description).toBe('Acute MI, post-angioplasty. Stable on oxygen.');
    expect(valueAfter(await renderPdfLines(row), 'Condition & diagnosis:')).toBe('Acute MI, post-angioplasty. Stable on oxygen.');
  });

  it('is required for the key "ground" alone: another service still takes a request without one', async () => {
    const { token } = await createPatient();
    const payload = body({ serviceKey: 'hospital', serviceType: 'Hospitalization Assistance' });
    delete payload.description;
    expect((await post(token, payload)).status).toBe(201);
  });
});

describe('POST /requests: Ground oxygen flow rate', () => {
  it('saves Oxygen with its flow rate, returns it, and keeps it in the database', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipOxygen: true, equipOxygenLpm: 4, careLevel: 'crit_icu' }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ equipOxygen: true, equipOxygenLpm: 4, careLevel: 'crit_icu' });
    const one = await request(app).get(`/requests/me/${res.body.request.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.body.request).toMatchObject({ equipOxygen: true, equipOxygenLpm: 4 });
    expect((await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } })).equipOxygenLpm).toBe(4);
    expect((await mine(token))[0].equipOxygenLpm).toBe(4);
  });

  it('keeps one decimal (2.5)', async () => {
    const { token } = await createPatient();
    expect((await post(token, body({ equipOxygen: true, equipOxygenLpm: 2.5 }))).body.request.equipOxygenLpm).toBe(2.5);
  });

  it('refuses Oxygen without a flow rate', async () => {
    const { token } = await createPatient();
    for (const extra of [{ equipOxygen: true }, { equipOxygen: true, equipOxygenLpm: null }]) {
      const res = await post(token, body(extra));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('equipOxygenLpm is required when Oxygen is selected');
    }
  });

  it.each([[0], [-1], [16], [15.1], [2.55], ['4'], [true], ['abc'], [[4]]])('refuses the flow rate %p', async (value) => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipOxygen: true, equipOxygenLpm: value }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/equipOxygenLpm/);
    expect(await mine(token)).toHaveLength(0);
  });

  it.each([['Oxygen off', { equipOxygen: false, equipOxygenLpm: 4 }], ['Oxygen not sent', { equipOxygenLpm: 4 }]])('refuses a flow rate when %s', async (_n, extra) => {
    const { token } = await createPatient();
    const res = await post(token, body(extra));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only accepted when Oxygen is selected/);
  });

  it('takes Oxygen off with no flow rate, and returns none', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ equipOxygen: false }));
    expect(res.status).toBe(201);
    expect(res.body.request).not.toHaveProperty('equipOxygenLpm');
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    expect(row).toMatchObject({ equipOxygen: false, equipOxygenLpm: null });
  });
});

describe('Ground: reports and a full request', () => {
  it('the shared upload rules apply to Ground: a file type that is not allowed is refused, and the request keeps its place', async () => {
    const { token } = await createPatient();
    const res = await post(token, body());
    const bad = await request(app)
      .post(`/requests/me/${res.body.request.id}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('bad'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unsupported file type/);
    expect((await mine(token))).toHaveLength(1);
  });

  it('a complete new Ground request saves, and its medical report upload still works', async () => {
    const { token } = await createPatient();
    const res = await post(token, body({ description: 'Needs monitoring.', careLevel: 'crit_ventilated,crit_icu', equipOxygen: true, equipOxygenLpm: 3, urgency: 'critical_6h' }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ serviceKey: 'ground', description: 'Needs monitoring.', careLevel: 'crit_ventilated,crit_icu', equipOxygen: true, equipOxygenLpm: 3, urgency: 'critical_6h' });
    expect(res.body.request.referenceNumber).toMatch(/^REQ-\d+$/);
    const upload = await request(app)
      .post(`/requests/me/${res.body.request.id}/documents`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4 fake pdf content'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(upload.body.document.name).toBe('report.pdf');
  });

  it('the lead comment and the PDF read the keys as English names (care levels are no longer stored as translated labels)', async () => {
    const { token, user } = await createPatient();
    const res = await post(token, body({ careLevel: 'crit_icu,crit_ecmo', equipOxygen: true, equipOxygenLpm: 4 }));
    const row = await prisma.serviceRequest.findUnique({ where: { id: res.body.request.id } });
    const comments = buildLeadFields(leadInputFromRequest(row, user)).COMMENTS;
    expect(comments).toContain('Care level: ICU, ECMO');
    expect(comments).toContain('On board: Oxygen');
    const lines = await renderPdfLines(row);
    expect(valueAfter(lines, 'Care level:')).toBe('ICU, ECMO');
    expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen (4 LPM)');
  });
});

describe('historical Ground requests', () => {
  it('an older request (labels, mobility, Cardiac monitor, Ventilator, no flow rate) is still returned and printed exactly as it was', async () => {
    const { token, user } = await createPatient();
    const old = await prisma.serviceRequest.create({
      data: {
        userId: user.id, serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'Old Patient', patientAge: 70, patientGender: 'Male',
        origin: 'Pune', destination: 'Mumbai', careLevel: 'ICU / Critical, Ambulatory', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: true,
        equipVentilator: true, urgency: 'urgent_24h', referenceNumber: `TEST-GROUND-${Date.now()}`, status: 'submitted',
      },
    });
    const one = await request(app).get(`/requests/me/${old.id}`).set('Authorization', `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect(one.body.request).toMatchObject({ careLevel: 'ICU / Critical, Ambulatory', mobility: 'bedridden', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: true });
    expect(one.body.request).not.toHaveProperty('equipOxygenLpm');
    expect((await mine(token)).map((r) => r.id)).toContain(old.id);
    const lines = await renderPdfLines(old);
    expect(valueAfter(lines, 'Care level:')).toBe('ICU / Critical, Ambulatory');
    expect(valueAfter(lines, 'Required on board:')).toBe('Oxygen, Cardiac monitor, Ventilator');
    expect(valueAfter(lines, 'Patient mobility:')).toBe('Bedridden');
  });
});

describe('other services and Private Charter are unaffected', () => {
  const air = (extra = {}) => ({ serviceType: 'Air Ambulance', serviceKey: 'air', patientName: 'Asha Nair', origin: 'Pune', destination: 'Mumbai', ...extra });

  it('the older air key keeps the original care levels (labels), mobility, and all three equipment items, with no flow rate', async () => {
    const { token } = await createPatient();
    const res = await post(token, air({ careLevel: 'ICU / Critical', mobility: 'wheelchair', equipOxygen: true, equipCardiacMonitor: true, equipVentilator: true }));
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ careLevel: 'ICU / Critical', mobility: 'wheelchair', equipCardiacMonitor: true, equipVentilator: true });
    expect((await post(token, air({ equipOxygen: true, equipOxygenLpm: 4 }))).status).toBe(400);
  });

  it('Commercial Air keeps its own rules (Cardiac monitor allowed, Ventilator refused)', async () => {
    const { token } = await createPatient();
    const ok = await post(token, { ...air(), serviceType: 'Medical Escort (Commercial Airlines)', serviceKey: 'commercialair_stretcher', equipCardiacMonitor: true });
    expect(ok.status).toBe(201);
    const refused = await post(token, { ...air(), serviceKey: 'commercialair_stretcher', equipVentilator: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('equipVentilator is not accepted for Commercial Air requests (Ventilated is a care level)');
  });

  // (Home Healthcare is not in this list any more: it has its own validator, which refuses these fields with its own message; see home-healthcare-validation.test.js.)
  it.each([['hospital'], ['tele'], ['marine'], ['medvalue']])('%s still refuses equipment, mobility and a flow rate, and takes free-text care', async (key) => {
    const { token } = await createPatient();
    expect((await post(token, air({ serviceKey: key, equipOxygen: false }))).status).toBe(400);
    expect((await post(token, air({ serviceKey: key, equipOxygenLpm: 4 }))).body.error).toBe('equipOxygenLpm is only accepted for Commercial Air and Ground Ambulance requests');
    expect((await post(token, air({ serviceKey: key, careLevel: 'anything typed' }))).status).toBe(201);
  });

  it('Private Charter still has its own validator: it refuses the Ground and Commercial Air fields', async () => {
    const { token } = await createPatient();
    const res = await post(token, { serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Asha Nair', careLevel: ['crit_icu'], equipOxygenLpm: 4 });
    expect(res.status).toBe(400);
    expect(res.body.fields.careLevel).toMatch(/Care level must be a list of: care_icu, care_stable, care_ambulatory, care_na/);
    expect(res.body.fields.equipOxygenLpm).toBe('This field is not accepted for Private Charter requests.');
  });
});
