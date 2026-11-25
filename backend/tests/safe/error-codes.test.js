/* global describe, test, expect, jest, beforeEach, afterEach, afterAll */
// M1: stable error codes on every patient request / document-upload refusal, so the mobile app can show them in EN, HI, MR, GU, TE and AR. The English text, the HTTP status and every existing key must be
// unchanged; only code / field / params / fieldCodes are added. Covers the classifier, the router middleware over the REAL app and controller, the upload refusals, and the list of codes the mobile app
// translates (apps/mobile/src/data/serverErrorKeys.json). No database, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-error-codes-'));
const mockFile = { current: null };
jest.mock('../../src/db/prisma', () => ({ prisma: require('./fake-auth-prisma').createFakePrisma() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));
jest.mock('../../src/modules/geo/geo.service', () => ({ resolveCityRefs: jest.fn(), getVerifiedCity: jest.fn() }));
// The upload middleware is replaced by one that "receives" the file the test prepared (so the real controller runs on a real file).
jest.mock('../../src/middleware/upload.middleware', () => {
  const pass = () => (_req, _res, next) => next();
  const inject = () => (req, _res, next) => { if (mockFile.current) req.file = mockFile.current; next(); };
  return { UPLOAD_DIR: mockDir, upload: { single: inject, array: pass, fields: pass, any: pass, none: pass }, uploadPatient: { single: inject, array: pass, fields: pass, any: pass, none: pass } };
});
jest.mock('../../src/modules/requests/requests.service', () => ({
  createRequest: jest.fn(async (userId, data) => ({ id: 1, userId, ...data, referenceNumber: 'REQ-1001', status: 'submitted', createdAt: new Date(), case: null })),
  findRequestByClientRequestId: jest.fn(async () => null),
  getRequestForUser: jest.fn(async (userId, id) => {
    const state = global.__errorCodesState;
    const request = state && state.requests.get(Number(id));
    if (!request || request.userId !== userId) { const err = new Error('Request not found'); err.statusCode = 404; throw err; }
    return request;
  }),
  listRequestsForUser: jest.fn(), listDocumentsForUser: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const { prisma } = require('../../src/db/prisma');
const { app } = require('../../src/app');
const S = require('../../src/modules/auth/session.service');
const { startSession } = require('../../src/modules/auth/auth.service');
const { CODES, CODE_SET, classifyMessage, withErrorCode, attachErrorCodes } = require('../../src/common/errors/error-codes');

const REPO = path.join(__dirname, '..', '..', '..');
const MOBILE = path.join(REPO, 'apps', 'mobile', 'src');
const SERVER_KEYS = JSON.parse(fs.readFileSync(path.join(MOBILE, 'data', 'serverErrorKeys.json'), 'utf8'));
const I18N = JSON.parse(fs.readFileSync(path.join(MOBILE, 'data', 'i18n.json'), 'utf8'));
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

describe('classifyMessage: the code is picked from the SHAPE of the message', () => {
  const CASES = [
    ['patientName is required', 'required', 'patientName'],
    ['Patient name is required.', 'required', undefined],
    ['Missing required field(s): destination', 'required', 'destination'],
    ['description (the Present Medical Issue) is required for Ground Ambulance requests', 'required', 'description'],
    ['preferredDate is required for a House Call', 'required', 'preferredDate'],
    ['patientContact must be a valid phone number with its country code', 'phone_invalid', 'patientContact'],
    ['preferredDate cannot be in the past', 'date_past', 'preferredDate'],
    ['Preferred date cannot be in the past.', 'date_past'],
    ['preferredDate must be tomorrow or later', 'date_tomorrow', 'preferredDate'],
    ['dateOfDeath cannot be in the future', 'date_future', 'dateOfDeath'],
    ['preferredDate must be a valid date (YYYY-MM-DD)', 'date_invalid', 'preferredDate'],
    ['Preferred date must be a valid date in the form YYYY-MM-DD.', 'date_invalid'],
    ['origin can be at most 191 characters', 'text_too_long', 'origin', { max: 191 }],
    ['description can be at most 65535 bytes', 'text_too_long', 'description', { max: 65535 }],
    ['Medical description must be at most 2000 characters.', 'text_too_long', undefined, { max: 2000 }],
    ['patientAge must be a whole number from 0 to 129', 'number_range', 'patientAge', { min: 0, max: 129 }],
    ['Age must be a whole number from 1 to 120.', 'number_range', undefined, { min: 1, max: 120 }],
    ['utcOffsetMinutes must be a whole number of minutes from -840 to 840 (minutes east of UTC)', 'number_range', 'utcOffsetMinutes', { min: -840, max: 840 }],
    ['patientName must be 2 to 60 characters and include a letter', 'name_invalid', 'patientName'],
    ['originCity must be in the selected country', 'city_invalid', 'originCity'],
    ['origin is not a valid city: select one from the list or type it', 'city_invalid', 'origin'],
    ['patientName contains characters that are not allowed', 'chars_invalid', 'patientName'],
    ['details contains characters that cannot be saved', 'chars_invalid', 'details'],
    ['Medical description contains an invalid character.', 'chars_invalid'],
    ['description must be text', 'value_invalid', 'description'],
    ['companyName must be a single line', 'value_invalid', 'companyName'],
    ['equipOxygen must be true or false', 'value_invalid', 'equipOxygen'],
    ['mobility is only accepted for air and ground ambulance requests', 'not_accepted', 'mobility'],
    ['equipCardiacMonitor is not accepted for Ground Ambulance requests (Required on board is Oxygen only)', 'not_accepted', 'equipCardiacMonitor'],
    ['originGeonameId is not accepted for this service', 'not_accepted'],
    ['patientGender must be Male, Female or Other', 'choice_invalid', 'patientGender'],
    ['Invalid urgency. Use one of: urgent_24h, planned', 'choice_invalid'],
    ['programmes must list at least one programme', 'choice_invalid', 'programmes'],
    ['equipOxygenLpm is required when Oxygen is selected', 'oxygen_rate_required', 'equipOxygenLpm'],
    ['equipOxygenLpm must be greater than 0 and at most 15 LPM.', 'oxygen_rate_range', 'equipOxygenLpm', { max: 15 }],
    ['equipOxygenLpm can have at most one decimal place.', 'oxygen_rate_invalid', 'equipOxygenLpm'],
    ['equipOxygenLpm must be a number (litres per minute).', 'oxygen_rate_invalid', 'equipOxygenLpm'],
    ['Travel type is required: serviceKey must be commercialair_stretcher or commercialair_wheelchair', 'travel_type_required'],
    ['Unknown serviceKey', 'service_invalid'],
    ['serviceKey must be "tele" for Teleconsultation requests', 'service_invalid', 'serviceKey'],
    ['clientRequestId must be a UUID.', 'id_invalid', 'clientRequestId'],
    ['clientUploadId must be a UUID.', 'id_invalid', 'clientUploadId'],
    ['The request body must be a JSON object.', 'body_invalid'],
    ['Request not found', 'not_found'],
    ['This request has no case yet.', 'no_case_yet'],
    ['Document uploads are not available for Teleconsultation requests.', 'uploads_not_available'],
    ['file is required', 'file_required', 'file'],
    ['The uploaded file could not be read.', 'file_unreadable'],
    ['Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', 'file_type_unsupported'],
    ['File too large', 'file_too_large'],
    ['The file content does not match its type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', 'file_type_mismatch'],
    ['The uploaded file is empty.', 'file_empty'],
    ['A request can hold at most 30 documents.', 'too_many_documents', undefined, { max: 30 }],
    ['A Mortal Remains request can have at most 10 documents.', 'too_many_documents', undefined, { max: 10 }],
    ['Unexpected field', 'file_upload_invalid'],
    ['country must be a two-letter ISO 3166-1 country code, for example "IN"', 'choice_invalid', 'country'],
    ['Something nobody has ever written', 'validation_failed'],
  ];
  // every row padded to four entries (a shorter row would hand Jest's done callback to the test as its last argument)
  test.each(CASES.map(([message, code, field, params]) => [message, code, field, params]))('%s', (message, code, field, params) => {
    const out = classifyMessage(message);
    expect(out.code).toBe(code);
    expect(out.field).toBe(field);
    expect(out.params).toEqual(params);
  });
  test('only known field names are reported, never arbitrary text from the start of a message', () => {
    expect(classifyMessage('Please correct the highlighted fields.').field).toBeUndefined();
    expect(classifyMessage('evil<script> is required').field).toBeUndefined();
    expect(classifyMessage('__proto__ is required').field).toBeUndefined();
  });
  test('non-text input falls to validation_failed and never throws', () => {
    for (const value of [undefined, null, 5, {}, [], '']) expect(classifyMessage(value).code).toBe('validation_failed');
  });
  test('params hold only numbers taken from the message (never a patient value)', () => {
    for (const [message] of CASES) { const { params } = classifyMessage(message); for (const value of Object.values(params || {})) expect(typeof value).toBe('number'); }
  });
});

describe('every message the validators can write gets a specific code (a guard for new messages)', () => {
  // Extract the string literals of the patient validators, put a number where ${...} was, and classify them: none may fall through to the catch-all, except the few that are not refusals of a field.
  const FILES = ['private-charter', 'generic-request', 'home-healthcare', 'mortal-remains', 'medical-value-travel', 'marine-medical-safety', 'corporate-medical', 'tele-consultation', 'transport-request', 'legacy-body-guard', 'upload-policy']
    .map((name) => path.join(__dirname, '..', '..', 'src', 'modules', 'requests', `${name}.validation.js`.replace('legacy-body-guard.validation.js', 'legacy-body-guard.js').replace('upload-policy.validation.js', 'upload-policy.js')));
  const SHAPES = /\bis required\b|must be|cannot be|can be at most|not accepted|only accepted|contains characters|must include|must hold|Invalid |Missing required|is not a valid|must list|must not repeat|cannot repeat/;
  const ALLOWED_CATCH_ALL = [
    /^Please correct the highlighted fields\.?$/, /^This field is not accepted/, /^Deceased details are not accepted/, /Location is not accepted for Private Charter/, /^This must be true or false/,
    /^The request body must be/, /Present Medical Issue/, /^This version of the app/, /^You are /, /^You have /, /^A .* request must use the current request form/,
  ];
  const messages = new Set();
  for (const file of FILES) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/`([^`\n]{8,260})`|'((?:[^'\\\n]|\\.){8,260})'|"([^"\n]{8,260})"/g)) {
      const text = (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/g, '7').replace(/\\'/g, "'");
      if (SHAPES.test(text) && /\s/.test(text) && !/^\s*(\/\/|\*)/.test(text)) messages.add(text);
    }
  }
  test('found a meaningful number of messages (the extraction itself works)', () => { expect(messages.size).toBeGreaterThan(80); });
  test('none of them is the generic catch-all', () => {
    const generic = [...messages].filter((m) => classifyMessage(m).code === 'validation_failed' && !ALLOWED_CATCH_ALL.some((rule) => rule.test(m)));
    expect(generic).toEqual([]);
  });
});

describe('withErrorCode keeps everything the answer had', () => {
  test('adds code, field and params; the text and the other keys are untouched', () => {
    const body = { error: 'patientAge must be a whole number from 0 to 129', extra: 1 };
    const out = withErrorCode(body);
    expect(out).toEqual({ error: body.error, extra: 1, code: 'number_range', field: 'patientAge', params: { min: 0, max: 129 } });
    expect(body).toEqual({ error: 'patientAge must be a whole number from 0 to 129', extra: 1 }); // the input is not mutated
  });
  test('an answer that already has a code keeps it (and gets params when its message has the numbers)', () => {
    expect(withErrorCode({ error: 'A request can hold at most 30 documents.', code: 'too_many_documents' })).toEqual({ error: 'A request can hold at most 30 documents.', code: 'too_many_documents', params: { max: 30 } });
    expect(withErrorCode({ error: 'whatever', code: 'rate_limited' })).toEqual({ error: 'whatever', code: 'rate_limited' });
    expect(withErrorCode({ error: 'The file content does not match its type.', code: 'file_type_mismatch' }).code).toBe('file_type_mismatch');
  });
  test('a `fields` object gets a code for each field, and the fields themselves are unchanged', () => {
    const body = { error: 'Please correct the highlighted fields.', fields: { patientName: 'Patient name is required.', preferredDate: 'Preferred date cannot be in the past.', age: 'Age must be a whole number from 1 to 120.' } };
    const out = withErrorCode(body);
    expect(out.fields).toEqual(body.fields);
    expect(out.fieldCodes).toEqual({ patientName: { code: 'required' }, preferredDate: { code: 'date_past' }, age: { code: 'number_range', params: { min: 1, max: 120 } } });
  });
  test('bodies without an error text are returned as they are', () => {
    for (const value of [null, undefined, 'text', 5, [], { ok: true }, { error: 5 }]) expect(withErrorCode(value)).toBe(value);
  });
  test('non-400 refusals get a code only when the message is recognised, never the catch-all', () => {
    expect(withErrorCode({ error: 'Something odd' }, 409)).toEqual({ error: 'Something odd' });
    expect(withErrorCode({ error: 'Request not found' }, 404).code).toBe('not_found');
    expect(withErrorCode({ error: 'Something odd' }, 400).code).toBe('validation_failed');
  });
  test('the registry is frozen, unique and complete', () => {
    expect(Object.isFrozen(CODES)).toBe(true);
    expect(new Set(CODES).size).toBe(CODES.length);
    expect(CODE_SET.has('required')).toBe(true);
  });
});

describe('the middleware decorates the right statuses only', () => {
  const miniApp = (status, body) => { const a = express(); a.use(attachErrorCodes); a.get('/x', (_req, res) => res.status(status).json(body)); return a; };
  test.each([[400], [404], [409], [413], [422], [429]])('%i is decorated', async (status) => {
    const res = await request(miniApp(status, { error: 'patientName is required' })).get('/x');
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: 'patientName is required', code: 'required', field: 'patientName' });
  });
  test.each([[200], [201], [401], [403], [500], [503]])('%i is NOT touched', async (status) => {
    const body = { error: 'patientName is required' };
    const res = await request(miniApp(status, body)).get('/x');
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
  });
  test('res.send(object) is decorated as well (the rate limiter answers that way)', async () => {
    const a = express(); a.use(attachErrorCodes); a.get('/x', (_req, res) => res.status(429).send({ error: 'slow down', code: 'rate_limited' }));
    expect((await request(a).get('/x')).body).toEqual({ error: 'slow down', code: 'rate_limited' });
  });
});

// ---- the real app: submit and upload refusals -------------------------------------------------------------------------------------------------------------------------------------------
const MIN = 60 * 1000;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let token;
const day = (n) => new Date(Date.now() + n * 24 * 60 * MIN).toISOString().slice(0, 10);
const ground = (extra = {}) => ({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'John Doe', patientContact: '+91 9876543210', origin: 'Pune', destination: 'Mumbai', preferredDate: day(5), description: 'Needs transport.', ...extra });
const submit = (body) => request(app).post('/requests').set(auth(token)).send(body);
const makeFile = ({ name = 'report.pdf', content = PDF, mimetype = 'application/pdf' } = {}) => { const p = path.join(mockDir, `${Math.random().toString(36).slice(2)}-${name}`); fs.writeFileSync(p, content); return { path: p, filename: path.basename(p), originalname: name, mimetype, size: content.length }; };
const upload = (id = 1) => request(app).post(`/requests/me/${id}/documents`).set(auth(token)).send({});

beforeEach(async () => {
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789';
  delete process.env.RATE_LIMIT_ENFORCE_IN_TEST;
  prisma.__store.users = [{ id: 7, tokenVersion: 0, isVerified: true, deletedAt: null }];
  prisma.__store.sessions = [];
  prisma.document = { count: async () => 0, findFirst: async () => null, findMany: async () => [] }; // the original upload path counts a request's documents first
  global.__errorCodesState = { requests: new Map([[1, { id: 1, userId: 7, serviceKey: 'ground', status: 'submitted', reviewStatus: null, destination: 'Mumbai', case: null, requestDocuments: [] }]]) };
  mockFile.current = null;
  token = (await startSession({ claims: { sub: 7, role: 'patient', tv: 0 }, subjectType: S.SUBJECTS.PATIENT, subjectId: 7 })).token;
});
afterEach(() => { delete process.env.JWT_REFRESH_SECRET; delete process.env.JWT_ACCESS_SECRET; });
afterAll(() => { fs.rmSync(mockDir, { recursive: true, force: true }); delete global.__errorCodesState; });

describe('POST /requests refusals carry codes; text and status are unchanged', () => {
  test.each([
    ['a bad phone number', { patientContact: '123' }, 'patientContact must be a valid phone number with its country code', 'phone_invalid', 'patientContact'],
    ['a past date', { preferredDate: '2001-01-01' }, 'preferredDate cannot be in the past', 'date_past', 'preferredDate'],
    ['a missing date', { preferredDate: undefined }, 'preferredDate is required', 'required', 'preferredDate'],
    ['a blank origin', { origin: '   ' }, 'origin is required', 'required', 'origin'],
    ['an impossible date', { preferredDate: '2026-02-30' }, 'preferredDate must be a valid date (YYYY-MM-DD)', 'date_invalid', 'preferredDate'],
    ['a name without a letter', { patientName: '12345' }, 'patientName must include a letter', 'name_invalid', 'patientName'],
    ['control characters', { origin: 'Pu\u0000ne' }, 'origin contains characters that are not allowed', 'chars_invalid', 'origin'],
    ['a missing Present Medical Issue', { description: '' }, 'description (the Present Medical Issue) is required for Ground Ambulance requests', 'required', 'description'],
  ])('%s', async (_label, extra, error, code, field) => {
    const res = await submit(ground(extra));
    expect(res.status).toBe(400); // the status is unchanged
    expect(res.body.error).toBe(error); // and so is the English text
    expect(res.body.code).toBe(code);
    expect(res.body.field).toBe(field);
  });
  test('the old generic body of a strict service keeps its own explicit code', async () => {
    const res = await submit({ serviceType: 'Marine Medical Safety', serviceKey: 'marine', patientName: 'John Doe', origin: 'Mumbai', destination: 'Dubai' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('app_update_required');
    expect(res.body.error).toMatch(/update the app/i);
  });
  test('a malformed id and a non-object body', async () => {
    const id = await submit(ground({ clientRequestId: 'nope' }));
    expect(id.status).toBe(400);
    expect(id.body.fields.clientRequestId).toBe('clientRequestId must be a UUID.'); // existing shape kept
    expect(id.body.fieldCodes.clientRequestId.code).toBe('id_invalid'); // and now a code for it
    const bare = await request(app).post('/requests').set(auth(token)).set('Content-Type', 'application/json').send('[]');
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('body_invalid');
  });
  test('a valid submission is untouched (no code fields on a success)', async () => {
    const res = await submit(ground());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['request']);
  });
  test('a sign-in problem (401) is never given a validation code', async () => {
    const res = await request(app).post('/requests').send(ground());
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });
  test('nothing the patient typed is ever copied into the code fields', async () => {
    const secret = 'Zephyrina-Quillfeather-98765';
    const res = await submit(ground({ patientName: secret, patientContact: secret, origin: secret.repeat(20) }));
    expect(res.status).toBe(400);
    const extras = JSON.stringify({ code: res.body.code, field: res.body.field, params: res.body.params, fieldCodes: res.body.fieldCodes });
    expect(extras).not.toContain('Zephyrina');
    expect(extras).not.toContain('98765');
  });
});

describe('document upload refusals carry codes', () => {
  test.each([
    ['a file whose content is not its type', { content: Buffer.from('<html></html>') }, 400, 'file_type_mismatch'],
    ['an empty file', { content: Buffer.alloc(0) }, 400, 'file_empty'],
  ])('%s', async (_label, spec, status, code) => {
    global.__errorCodesState.requests.set(1, { id: 1, userId: 7, serviceKey: 'ground', status: 'submitted', reviewStatus: null, destination: 'Mumbai', case: { id: 10, status: 'submitted' }, requestDocuments: [] });
    mockFile.current = makeFile(spec);
    const res = await upload();
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
  });
  test('a closed request', async () => {
    global.__errorCodesState.requests.set(1, { id: 1, userId: 7, serviceKey: 'ground', status: 'completed', reviewStatus: null, destination: 'Mumbai', case: { id: 10, status: 'completed' }, requestDocuments: [] });
    mockFile.current = makeFile();
    const res = await upload();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('request_closed');
  });
  test('another patient\'s request and a request that has no case', async () => {
    mockFile.current = makeFile();
    const stranger = await upload(99);
    expect(stranger.status).toBe(404);
    expect(stranger.body).toMatchObject({ error: 'Request not found', code: 'not_found' });
    mockFile.current = makeFile();
    const noCase = await upload(1);
    expect(noCase.status).toBe(409);
    expect(noCase.body.code).toBe('no_case_yet');
  });
  test('no file at all, and Teleconsultation (no documents)', async () => {
    const none = await upload();
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({ error: 'file is required', code: 'file_required' });
    global.__errorCodesState.requests.set(1, { id: 1, userId: 7, serviceKey: 'tele', status: 'submitted', reviewStatus: null, destination: '', case: { id: 10, status: 'submitted' }, requestDocuments: [] });
    mockFile.current = makeFile();
    const tele = await upload();
    expect(tele.status).toBe(400);
    expect(tele.body.code).toBe('uploads_not_available');
  });
});

describe('the list of codes and what the mobile app translates', () => {
  test('every code the backend can send has a mobile entry, and the mobile list has no codes the backend does not know', () => {
    const mobile = Object.keys(SERVER_KEYS);
    // codes the backend sends from other places and that the app does not translate yet are fine; what must hold is that every CLASSIFIER / policy code is covered
    const mustTranslate = CODES.filter((c) => c !== 'file_upload_invalid' || true);
    expect(mustTranslate.filter((c) => !mobile.includes(c))).toEqual([]);
    expect(mobile.filter((c) => !CODE_SET.has(c))).toEqual([]);
  });
  test('every mobile dictionary key exists in all six languages, with the same placeholders', () => {
    for (const [code, entry] of Object.entries(SERVER_KEYS)) {
      const placeholders = (text) => (text.match(/\{[a-z]+\}/g) || []).sort().join(',');
      const english = I18N.EN[entry.key];
      expect({ code, key: entry.key, exists: typeof english }).toEqual({ code, key: entry.key, exists: 'string' });
      for (const lang of LANGS) {
        expect({ code, lang, text: typeof I18N[lang][entry.key] }).toEqual({ code, lang, text: 'string' });
        expect({ code, lang, p: placeholders(I18N[lang][entry.key]) }).toEqual({ code, lang, p: placeholders(english) });
      }
      for (const [placeholder, source] of Object.entries(entry.params || {})) {
        expect(I18N.EN[entry.key]).toContain(`{${placeholder}}`);
        expect(['max', 'min']).toContain(source);
      }
    }
  });
  test('the dedicated srv_* texts are real translations, not copies of the English', () => {
    const keys = Object.keys(I18N.EN).filter((k) => k.startsWith('srv_'));
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const key of keys) for (const lang of LANGS.filter((l) => l !== 'EN')) expect({ key, lang, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ key, lang, same: false });
  });
});

describe('the upload-list message table of the mobile app matches the words the backend really sends', () => {
  const MESSAGES = JSON.parse(fs.readFileSync(path.join(MOBILE, 'data', 'serverErrorMessages.json'), 'utf8'));
  const policy = require('../../src/modules/requests/upload-policy');
  const emptyFile = path.join(mockDir, 'empty.bin');
  const mismatchFile = path.join(mockDir, 'mismatch.bin');
  fs.writeFileSync(emptyFile, Buffer.alloc(0));
  fs.writeFileSync(mismatchFile, Buffer.from('<html></html>'));
  const scanSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'documents', 'legacy-scan.js'), 'utf8');
  const limiterSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'common', 'middleware', 'rate-limit.middleware.js'), 'utf8');
  const actual = async () => [
    policy.closedRequestProblem({ status: 'completed' }).body.error,
    policy.closedRequestProblem({ status: 'cancelled' }).body.error,
    policy.fileCountProblem(30, 'ground').body.error,
    policy.fileCountProblem(10, 'mortal').body.error,
    (await policy.fileContentProblem({ path: emptyFile, size: 0, mimetype: 'application/pdf', originalname: 'a.pdf' })).body.error,
    (await policy.fileContentProblem({ path: mismatchFile, size: 13, mimetype: 'application/pdf', originalname: 'a.pdf' })).body.error,
    (await policy.fileContentProblem({ path: mismatchFile, size: policy.MAX_FILE_BYTES + 1, mimetype: 'application/pdf', originalname: 'a.pdf' })).body.error,
    (await policy.fileContentProblem({ path: path.join(mockDir, 'does-not-exist'), size: 5, mimetype: 'application/pdf', originalname: 'a.pdf' })).body.error,
    'Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.', 'File too large', 'file is required', 'Request not found', 'This request has no case yet.',
    'Document uploads are not available for Teleconsultation requests.', 'That upload id was already used for a different file.', 'This request has been approved. Please contact HumanCare to add more documents.',
  ];
  test('every message the policy and the scan layer write is recognised by exactly the pattern for its code', async () => {
    const texts = [...(await actual())];
    for (const literal of ['This file was blocked because it may contain a virus. It was not saved.', 'We could not scan this file for viruses right now, so it was not saved. Please try again in a moment.']) {
      expect(scanSource).toContain(literal); // the string really is in the backend source
      texts.push(literal);
    }
    for (const literal of ['You are uploading files too quickly. Please wait a few minutes and try again.', 'You have reached the daily limit for uploads. Please try again tomorrow or contact HumanCare.']) {
      expect(limiterSource).toContain(literal);
      texts.push(literal);
    }
    for (const text of texts) {
      const hits = MESSAGES.filter((item) => new RegExp(item.pattern).test(text));
      expect({ text, hits: hits.length }).toEqual({ text, hits: 1 }); // recognised, and by one pattern only
    }
  });
  test('the pattern\'s code is the code the backend gives that message (the classifier or the explicit code agree)', async () => {
    const pairs = [
      [policy.closedRequestProblem({ status: 'completed' }).body, 'request_closed'],
      [policy.fileCountProblem(30, 'ground').body, 'too_many_documents'],
      [(await policy.fileContentProblem({ path: mismatchFile, size: 13, mimetype: 'application/pdf', originalname: 'a.pdf' })).body, 'file_type_mismatch'],
      [(await policy.fileContentProblem({ path: emptyFile, size: 0, mimetype: 'application/pdf', originalname: 'a.pdf' })).body, 'file_empty'],
    ];
    for (const [body, code] of pairs) {
      expect(body.code).toBe(code);
      expect(MESSAGES.find((item) => new RegExp(item.pattern).test(body.error)).code).toBe(code);
    }
  });
  test('every code in the table is a known code, and the numbers are extracted in the right order', () => {
    for (const item of MESSAGES) expect(CODE_SET.has(item.code)).toBe(true);
    const documents = MESSAGES.find((item) => item.code === 'too_many_documents');
    expect(new RegExp(documents.pattern).exec('A request can hold at most 30 documents.')[1]).toBe('30');
    expect(new RegExp(documents.pattern).exec('A Mortal Remains request can have at most 10 documents.')[1]).toBe('10');
  });
});
