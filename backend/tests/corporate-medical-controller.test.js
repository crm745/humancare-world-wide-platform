// Corporate Medical Solutions through the REAL controller (submitRequest, uploadRequestDocument) and the REAL createRequest, with NO database: Prisma is replaced by a
// recorder that keeps what would have been written. Run with a Jest configuration that skips the database setup (the setup in jest.config.js would empty humancare_test).
process.env.BITRIX_SYNC_ENABLED = 'false';
process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW = 'false';

const mockStore = { rows: [], cases: [], events: [], nextCaseId: 0 };
jest.mock('../src/db/prisma', () => {
  const prisma = {
    serviceRequest: {
      create: async ({ data }) => { const row = { id: 100 + mockStore.rows.length, createdAt: new Date('2026-11-18T10:00:00Z'), updatedAt: new Date('2026-11-18T10:00:00Z'), ...data }; mockStore.rows.push(row); return { ...row }; },
      update: async ({ where, data }) => { const row = mockStore.rows.find((r) => r.id === where.id); Object.assign(row, data); return { ...row }; },
      findFirst: async ({ where }) => { const row = mockStore.rows.find((r) => r.id === where.id && r.userId === where.userId); return row ? { ...row, case: mockStore.cases.find((c) => c.serviceRequestId === row.id) || null, requestDocuments: [] } : null; },
    },
    case: {
      create: async ({ data }) => { const row = { id: (mockStore.nextCaseId += 1), ...data }; mockStore.cases.push(row); return { ...row }; },
      update: async ({ where, data }) => { const row = mockStore.cases.find((c) => c.id === where.id); Object.assign(row, data); return { ...row }; },
    },
    caseStageEvent: { create: async ({ data }) => { mockStore.events.push(data); return {}; } },
  };
  // createRequest saves the request, its Case and its first stage event in one transaction: the mock runs the callback on itself (the recorder keeps what each call would have written).
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma };
});

const { submitRequest, uploadRequestDocument } = require('../src/modules/requests/requests.controller');
const { corporateFieldsOf } = require('../src/modules/requests/corporate-medical.validation');

beforeEach(() => { mockStore.rows.length = 0; mockStore.cases.length = 0; mockStore.events.length = 0; mockStore.nextCaseId = 41; });

async function post(body) {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
  await submitRequest({ body, user: { id: 7 } }, res, (err) => { out.err = err; });
  return out;
}
const stored = () => mockStore.rows[mockStore.rows.length - 1];
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const OFFICE = 'Plot 14, Andheri East,\nMumbai, Maharashtra 400069';
const goodBody = (extra = {}) => ({
  serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', companyName: 'Acme Industries', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female',
  programmes: ['nurse', 'doctor', 'events'], anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.',
  patientContact: '+91 98765 43210', preferredDate: inDays(3), utcOffsetMinutes: 0, officeAddress: OFFICE, officeCountry: 'IN', ...extra,
});

describe('submitting a Corporate Medical Solutions request', () => {
  it('saves all eleven fields in their own places', async () => {
    const r = await post(goodBody());
    expect(r.err).toBeUndefined();
    expect(r.status).toBe(201);
    expect(stored()).toMatchObject({
      userId: 7, serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'Asha Nair', patientGender: 'Female', destination: '',
      companyName: 'Acme Industries', employeeCount: 250, selectedProgrammes: ['doctor', 'nurse', 'events'],
      patientContact: '+91 98765 43210', origin: OFFICE, country: 'India',
    });
    expect(stored().preferredDate).toEqual(new Date(`${inDays(3)}T00:00:00.000Z`));
    // the office is not the patient's location, and nothing unrelated is invented
    expect(stored().patientLocation).toBeNull();
    expect(stored().patientAge).toBeNull();
    expect(stored().urgency).toBeNull();
    expect(stored().careLevel).toBeNull();
    expect(corporateFieldsOf(stored())).toMatchObject({ ok: true, anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.' });
  });

  it('the response returns every one of the eleven fields (the programmes as a list of keys, not a JSON string)', async () => {
    const r = await post(goodBody());
    const request = r.body.request;
    expect(request).toMatchObject({
      companyName: 'Acme Industries', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female', selectedProgrammes: ['doctor', 'nurse', 'events'],
      patientContact: '+91 98765 43210', origin: OFFICE, country: 'India',
    });
    expect(new Date(request.preferredDate).toISOString().slice(0, 10)).toBe(inDays(3));
    expect(request).not.toHaveProperty('patientLocation', expect.anything());
    expect(Array.isArray(request.selectedProgrammes)).toBe(true);
    expect(typeof request.description).toBe('string');
    expect(corporateFieldsOf(request)).toMatchObject({ ok: true, anyRequirement: 'Two doctors on site.', specialRequirement: 'Night shift cover.' });
    for (const hidden of ['userId', 'bitrixLeadId', 'bitrixSyncAttempts', 'bitrixLastError']) expect(request).not.toHaveProperty(hidden);
  });

  it('without the two optional requirements, the description is NULL and the response still carries the other five', async () => {
    const r = await post(goodBody({ anyRequirement: undefined, specialRequirement: undefined }));
    expect(r.status).toBe(201);
    expect(stored().description).toBeNull();
    expect(r.body.request).toMatchObject({ companyName: 'Acme Industries', employeeCount: 250, patientName: 'Asha Nair', patientGender: 'Female', selectedProgrammes: ['doctor', 'nurse', 'events'] });
    expect(isNew(r.body.request)).toBe(true);
  });

  it('the structured fields are not repeated in the description', async () => {
    await post(goodBody({ anyRequirement: 'Cover for the plant.', specialRequirement: 'Wheelchair access.' }));
    const text = stored().description;
    expect(text).toContain('Cover for the plant.');
    for (const leaked of ['Acme Industries', '250', 'Asha Nair', 'Female', 'doctor', 'Doctor', 'nurse', 'Nurse', 'events', 'Programmes']) expect(text).not.toContain(leaked);
  });

  it('the reference is the standard REQ-<1000 + request id>, never the Case id, and the Case copies it', async () => {
    const r = await post(goodBody());
    expect(mockStore.cases).toHaveLength(1);
    const kase = mockStore.cases[0];
    expect(stored().id).toBe(100);
    expect(kase.id).toBe(42); // the internal Case id is something else entirely
    expect(stored().referenceNumber).toBe('REQ-1100'); // 1000 + the REQUEST's id (100)
    expect(r.body.request.referenceNumber).toBe('REQ-1100');
    expect(kase.referenceNumber).toBe('REQ-1100');
    expect(JSON.stringify(r.body.request)).not.toContain('1042'); // the Case id (1000 + 42) is not exposed in any form
    expect(r.body.request.referenceNumber).not.toMatch(/^CASE-/);
    expect(mockStore.rows.concat(mockStore.cases).some((row) => String(row.referenceNumber).startsWith('TEMP-'))).toBe(false);
  });

  it('the Case keeps its relationship and copies the applicable fields, with no corporate', async () => {
    await post(goodBody());
    const kase = mockStore.cases[0];
    expect(kase.serviceRequestId).toBe(stored().id);
    expect(kase.corporateId).toBeUndefined(); // an employee's request: the Case has no corporate (NULL in the database)
    expect(kase).toMatchObject({
      patientName: 'Asha Nair', patientGender: 'Female', patientContact: '+91 98765 43210', serviceType: 'Corporate Medical Solutions', origin: OFFICE, destination: '', country: 'India', status: 'submitted',
    });
    expect(mockStore.events).toEqual([{ caseId: kase.id, stage: 'submitted', note: 'Request received from patient app.' }]);
  });

  it('a 2,000-character Office Address is saved whole on the request and its Case; 2,001 is refused and nothing is saved', async () => {
    const exact = 'Z'.repeat(2000);
    expect((await post(goodBody({ officeAddress: exact }))).status).toBe(201);
    expect(stored().origin).toHaveLength(2000);
    expect(mockStore.cases[0].origin).toHaveLength(2000);
    mockStore.rows.length = 0; mockStore.cases.length = 0;
    const tooLong = await post(goodBody({ officeAddress: 'Z'.repeat(2001) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('officeAddress can be at most 2000 characters');
    expect(mockStore.rows).toHaveLength(0);
  });

  it('two requests get two different REQ- references, and the Office Country is independent of the phone\'s country code', async () => {
    await post(goodBody());
    await post(goodBody({ companyName: 'Other Co', patientContact: '+971 50 123 4567', officeCountry: 'IN' }));
    expect(mockStore.rows.map((r) => r.referenceNumber)).toEqual(['REQ-1100', 'REQ-1101']);
    expect(mockStore.rows[1]).toMatchObject({ patientContact: '+971 50 123 4567', country: 'India' }); // a +971 phone, an Indian office
    expect(mockStore.cases.map((c) => c.referenceNumber)).toEqual(['REQ-1100', 'REQ-1101']);
  });

  it('every other service keeps its REQ- reference and its Case copies it', async () => {
    const r = await post({ serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Pune' });
    expect(r.status).toBe(201);
    expect(stored().referenceNumber).toBe('REQ-1100');
    expect(mockStore.cases[0].referenceNumber).toBe('REQ-1100');
    for (const key of ['companyName', 'employeeCount', 'selectedProgrammes']) expect(key in stored()).toBe(false);
  });

  it('an older generic Corporate Medical body is REFUSED (it would skip the phone, date and required-field rules) and nothing is saved (tests/legacy-body-guard.test.js has the full set)', async () => {
    const r = await post({ serviceType: 'Corporate Medical Solutions', serviceKey: 'corporate', patientName: 'John Doe', patientAge: '35', origin: 'Pune', destination: 'Pune', description: 'Annual checkups.' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('app_update_required');
    expect(mockStore.rows).toHaveLength(0);
  });
});

describe('invalid requests are refused and nothing is saved', () => {
  it.each([
    ['no company name', { companyName: undefined }, /companyName/],
    ['a blank company name', { companyName: '   ' }, /companyName is required/],
    ['no employee count', { employeeCount: undefined }, /employeeCount is required/],
    ['a zero employee count', { employeeCount: 0 }, /employeeCount must be a whole number/],
    ['a negative employee count', { employeeCount: -5 }, /employeeCount must be a whole number/],
    ['a fractional employee count', { employeeCount: 2.5 }, /employeeCount must be a whole number/],
    ['a text employee count', { employeeCount: 'many' }, /employeeCount must be a whole number/],
    ['no employee name', { patientName: undefined }, /patientName is required/],
    ['a blank employee name', { patientName: '  ' }, /patientName must be/],
    ['no gender', { patientGender: undefined }, /patientGender must be/],
    ['no programmes', { programmes: [] }, /programmes must list at least one/],
    ['an unknown programme', { programmes: ['dentist'] }, /programmes must only hold/],
    ['a client description', { description: 'x' }, /description is not accepted/],
    ['an origin', { origin: 'Pune' }, /origin is not accepted/],
    ['a client country', { country: 'India' }, /country is not accepted/],
    ['no patient contact', { patientContact: undefined }, /patientContact must be a valid phone number/],
    ['an invalid patient contact', { patientContact: '98765' }, /patientContact must be a valid phone number/],
    ['no preferred date', { preferredDate: undefined }, /preferredDate is required/],
    ['a past preferred date', { preferredDate: inDays(-1) }, /preferredDate cannot be in the past/],
    ['an impossible preferred date', { preferredDate: '2026-02-30' }, /preferredDate must be a valid date/],
    ['no office address', { officeAddress: undefined }, /officeAddress is required/],
    ['a blank office address', { officeAddress: '  \n ' }, /officeAddress is required/],
    ['an office address over 2,000 characters', { officeAddress: 'A'.repeat(2001) }, /officeAddress can be at most 2000 characters/],
    ['no office country', { officeCountry: undefined }, /officeCountry is required/],
    ['an unknown office country code', { officeCountry: 'ZZ' }, /officeCountry must be a two-letter ISO/],
    ['an office country name instead of a code', { officeCountry: 'India' }, /officeCountry must be a two-letter ISO/],
    ['an employee count of 10,001', { employeeCount: 10001 }, /employeeCount must be a whole number from 1 to 10000/],
  ])('%s', async (_name, extra, message) => {
    const r = await post(goodBody(extra));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
    expect(mockStore.rows).toHaveLength(0);
    expect(mockStore.cases).toHaveLength(0);
  });
});

describe('the employee count boundary', () => {
  it('10,000 is saved; 10,001 is refused', async () => {
    expect((await post(goodBody({ employeeCount: 10000 }))).status).toBe(201);
    expect(stored().employeeCount).toBe(10000);
    const before = mockStore.rows.length;
    expect((await post(goodBody({ employeeCount: 10001 }))).status).toBe(400);
    expect(mockStore.rows).toHaveLength(before);
  });
});

describe('documents', () => {
  const upload = async (request) => {
    const out = {};
    const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
    await uploadRequestDocument({ file: { path: '/nonexistent/file.pdf', originalname: 'r.pdf', filename: 'r.pdf', mimetype: 'application/pdf', size: 5 }, user: { id: 7 }, params: { id: request.id }, body: {} }, res, (err) => { out.err = err; });
    return out;
  };
  it('a new-format request takes no documents', async () => {
    const created = await post(goodBody());
    const out = await upload(created.body.request);
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('Document uploads are not available for Corporate Medical Solutions requests.');
  });
});

function isNew(request) {
  return require('../src/modules/requests/corporate-medical.validation').isNewCorporateFormat(request);
}
