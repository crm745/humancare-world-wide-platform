/* global describe, test, expect, jest, beforeAll, beforeEach, afterEach */
// Content verification of the designated E2E test document: the generator, the verifier (positive and negative), the fixture CLI, and the engine
// integration (contentVerified is true only from a real verifier result; genuine and synthetic requests are untouched).
// No database, no network, no .env: PDFs are built in memory and the CLI writes into a temporary folder.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { buildFixturePdf, verifyE2EFixture, extractFixtureLines, BANNER, FIELDS, FixtureError } = require('../../src/modules/request-review/e2e-document-verification');
const { createAutoApproval } = require('../../src/modules/request-review/auto-approval');
const { approvalBlockers } = jest.requireActual('../../src/modules/request-review/request-review.service');
const { detectFileType } = require('../../src/modules/documents/file-type');
const { validateStructure } = require('../../src/storage/structure');
const cli = require('../../scripts/e2e-fixture-pdf');

const REQUEST = {
  patientName: 'E2E-TEST Asha Rao 0412', patientAge: 54, patientGender: 'female', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
  originCityName: 'Mumbai', destinationCityName: 'Dubai',
};
const GOOD = { patientName: REQUEST.patientName, age: 54, gender: 'female', origin: 'Mumbai', destination: 'Dubai' };

// A PDF with exactly these lines, drawn like the fixture (so negative cases differ from it in ONE respect only).
async function pdfOf(lines, { pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage([480, 260]);
    let y = 220;
    if (p === 0) for (const line of lines) { page.drawText(line, { x: 30, y, size: 11, font }); y -= 20; }
  }
  return Buffer.from(await doc.save());
}
const goodLines = (over = {}) => [BANNER, `Patient Name: ${over.name ?? REQUEST.patientName}`, `Age: ${over.age ?? 54}`, `Gender: ${over.gender ?? 'female'}`, `Origin: ${over.origin ?? 'Mumbai'}`, `Destination: ${over.destination ?? 'Dubai'}`];
const verify = (bytes, request = REQUEST, type = 'pdf') => verifyE2EFixture({ bytes, type, request });

let fixture;
beforeAll(async () => { fixture = await buildFixturePdf(GOOD); });

describe('the generator', () => {
  test('builds a one-page PDF that the EXISTING upload checks accept: real type from its bytes, and the structure validator', async () => {
    expect(detectFileType(fixture)).toBe('pdf');
    expect(await validateStructure('pdf', fixture)).toBeNull();
    expect(fixture.length).toBeLessThan(10 * 1024);
  });

  test('the text is not readable from the raw bytes (it is compressed), so reading it back is a real extraction', () => {
    expect(fixture.includes(Buffer.from('Asha Rao'))).toBe(false);
  });

  test('carries exactly the banner and the five labelled lines, in order', async () => {
    expect(await extractFixtureLines(fixture)).toEqual([BANNER, 'Patient Name: E2E-TEST Asha Rao 0412', 'Age: 54', 'Gender: female', 'Origin: Mumbai', 'Destination: Dubai']);
    expect(FIELDS).toEqual(['Patient Name', 'Age', 'Gender', 'Origin', 'Destination']);
  });

  test.each([
    ['a name without the test marker', { ...GOOD, patientName: 'Asha Rao' }, 'fixture_name_not_marked'],
    ['a marker that is not at the start', { ...GOOD, patientName: 'Asha E2E-TEST' }, 'fixture_name_not_marked'],
    ['no name', { ...GOOD, patientName: '' }, 'fixture_value_missing:Patient Name'],
    ['a non-ASCII value (it could not be read back exactly)', { ...GOOD, origin: 'Mumbai é' }, 'fixture_value_invalid:Origin'],
    ['a line break in a value', { ...GOOD, destination: 'Dubai\nAge: 3' }, 'fixture_value_invalid:Destination'],
    ['a value with surrounding spaces', { ...GOOD, origin: ' Mumbai' }, 'fixture_value_invalid:Origin'],
    ['age 0', { ...GOOD, age: 0 }, 'fixture_value_invalid:Age'],
    ['age 121', { ...GOOD, age: 121 }, 'fixture_value_invalid:Age'],
    ['a fractional age', { ...GOOD, age: '5.5' }, 'fixture_value_invalid:Age'],
    ['an unknown gender', { ...GOOD, gender: 'unknown' }, 'fixture_value_invalid:Gender'],
    ['a missing destination', { ...GOOD, destination: undefined }, 'fixture_value_missing:Destination'],
    ['an over-long value', { ...GOOD, origin: 'x'.repeat(101) }, 'fixture_value_invalid:Origin'],
  ])('refuses to build: %s', async (_n, input, code) => {
    await expect(buildFixturePdf(input)).rejects.toMatchObject({ name: 'FixtureError', code });
  });
});

describe('the verifier: a matching fixture', () => {
  test('verifies, naming the five fields and nothing else (never a value)', async () => {
    const result = await verify(fixture);
    expect(result).toEqual({ verified: true, fields: ['Patient Name', 'Age', 'Gender', 'Origin', 'Destination'] });
    expect(JSON.stringify(result)).not.toMatch(/Asha|Mumbai|Dubai|54/);
  });

  test('Origin / Destination may carry the stored location text OR the stored city name (both are request values)', async () => {
    const full = await buildFixturePdf({ ...GOOD, origin: REQUEST.origin, destination: REQUEST.destination });
    expect((await verify(full)).verified).toBe(true);
    expect((await verify(fixture)).verified).toBe(true);
  });

  test('works when the request has no stored city names (only the location text)', async () => {
    const request = { ...REQUEST, originCityName: null, destinationCityName: undefined };
    expect((await verify(await buildFixturePdf({ ...GOOD, origin: REQUEST.origin, destination: REQUEST.destination }), request)).verified).toBe(true);
    expect(await verify(fixture, request)).toEqual({ verified: false, code: 'fixture_field_mismatch:Origin' }); // a city that is not a stored value
  });
});

describe('the verifier: every field must match the stored request', () => {
  test.each([
    ['Patient Name', { name: 'E2E-TEST Someone Else 0412' }],
    ['Age', { age: 55 }],
    ['Gender', { gender: 'male' }],
    ['Origin', { origin: 'Delhi' }],
    ['Destination', { destination: 'London' }],
  ])('a different %s is NOT verified', async (label, over) => {
    expect(await verify(await pdfOf(goodLines(over)))).toEqual({ verified: false, code: `fixture_field_mismatch:${label}` });
  });

  test('a fixture built for another run (another name token) does not verify this request', async () => {
    const other = await buildFixturePdf({ ...GOOD, patientName: 'E2E-TEST Asha Rao 0413' });
    expect(await verify(other)).toEqual({ verified: false, code: 'fixture_field_mismatch:Patient Name' });
  });

  test('matching is exact: case, spacing and partial values do not pass', async () => {
    expect((await verify(await pdfOf(goodLines({ origin: 'mumbai' })))).verified).toBe(false);
    expect((await verify(await pdfOf(goodLines({ origin: 'Mumbai ' })))).verified).toBe(false);
    expect((await verify(await pdfOf(goodLines({ name: 'E2E-TEST Asha Rao' })))).verified).toBe(false);
    expect((await verify(fixture, { ...REQUEST, patientAge: 540 })).verified).toBe(false);
  });

  test('the request side is what is compared: change the stored request and the same file no longer verifies', async () => {
    for (const [field, value, label] of [['patientAge', 40, 'Age'], ['patientGender', 'male', 'Gender'], ['patientName', 'E2E-TEST Other 1', 'Patient Name']]) {
      expect(await verify(fixture, { ...REQUEST, [field]: value })).toEqual({ verified: false, code: `fixture_field_mismatch:${label}` });
    }
  });
});

describe('the verifier: anything that is not exactly the fixture is NOT verified', () => {
  test.each([
    ['a missing banner', async () => pdfOf(goodLines().slice(1)), 'fixture_banner_missing'],
    ['a different banner', async () => pdfOf(['MEDICAL REPORT', ...goodLines().slice(1)]), 'fixture_banner_missing'],
    ['a repeated banner', async () => pdfOf([BANNER, ...goodLines()]), 'fixture_banner_missing'],
    ['a missing field', async () => pdfOf(goodLines().filter((l) => !l.startsWith('Gender'))), 'fixture_field_missing:Gender'],
    ['a duplicated field (an ambiguous document)', async () => pdfOf([...goodLines(), 'Age: 54']), 'fixture_field_duplicated:Age'],
    ['a duplicated field with a different value', async () => pdfOf([...goodLines(), 'Age: 12']), 'fixture_field_duplicated:Age'],
    ['an extra line of other content (this is not a general report)', async () => pdfOf([...goodLines(), 'Diagnosis: something real']), 'fixture_unexpected_content'],
    ['an extra unlabelled line', async () => pdfOf([...goodLines(), 'free text']), 'fixture_unexpected_content'],
    ['a blank PDF', async () => pdfOf([]), 'fixture_banner_missing'],
    ['two pages', async () => pdfOf(goodLines(), { pages: 2 }), 'fixture_unreadable'],
    ['bytes that are not a PDF', async () => Buffer.from('%PDF-1.7 this is not really a pdf, just text pretending to be one'), 'fixture_unreadable'],
    ['a truncated PDF', async () => fixture.subarray(0, Math.floor(fixture.length / 2)), 'fixture_unreadable'],
    ['an empty buffer', async () => Buffer.alloc(0), 'fixture_unreadable'],
    ['an oversize file', async () => Buffer.concat([fixture, Buffer.alloc(210 * 1024)]), 'fixture_unreadable'],
  ])('%s', async (_n, make, code) => {
    expect(await verify(await make())).toEqual({ verified: false, code });
  });

  test('a file that is not a PDF can never verify: an image, whatever it contains', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    expect(await verify(png, REQUEST, 'png')).toEqual({ verified: false, code: 'fixture_not_pdf' });
    expect(await verify(fixture, REQUEST, 'jpeg')).toEqual({ verified: false, code: 'fixture_not_pdf' }); // the declared REAL type decides, not the bytes alone
    expect(await verifyE2EFixture({ bytes: fixture, request: REQUEST })).toEqual({ verified: false, code: 'fixture_not_pdf' }); // no declared type at all
  });

  test('a PDF with text the extractor cannot read (an ordinary report is not the fixture) is NOT verified, never assumed', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]); // no text at all: stands for a scan, an image-only or outline-text PDF
    expect(await verify(Buffer.from(await doc.save()))).toEqual({ verified: false, code: 'fixture_banner_missing' });
  });

  test('missing inputs are not verified, and the verifier never throws', async () => {
    expect(await verify(fixture, null)).toEqual({ verified: false, code: 'fixture_request_missing' });
    expect(await verifyE2EFixture()).toEqual({ verified: false, code: 'fixture_not_pdf' });
    expect(await verifyE2EFixture({ bytes: 'not a buffer', type: 'pdf', request: REQUEST })).toEqual({ verified: false, code: 'fixture_unreadable' });
  });
});

describe('the fixture CLI', () => {
  let folder;
  const out = { log: jest.fn(), errorLog: jest.fn() };
  beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fixture-test-')); out.log.mockClear(); out.errorLog.mockClear(); });
  afterEach(() => { fs.rmSync(folder, { recursive: true, force: true }); });
  const argv = (extra = []) => ['--name', REQUEST.patientName, '--age', '54', '--gender', 'female', '--origin', 'Mumbai', '--destination', 'Dubai', '--out', folder, ...extra];

  test('writes ONE PDF that verifies against the matching request, and prints only the file path', async () => {
    expect(await cli.run(argv(), out)).toBe(0);
    const [printed] = out.log.mock.calls[0];
    expect(path.dirname(printed)).toBe(folder);
    expect(fs.readdirSync(folder)).toHaveLength(1);
    expect(out.log).toHaveBeenCalledTimes(1);
    expect(out.log.mock.calls[0]).toHaveLength(1); // the output is the path and nothing else: no age, gender, origin or destination is printed
    expect(printed).not.toMatch(/Mumbai|Dubai|female/i);
    const bytes = fs.readFileSync(printed);
    expect((await verify(bytes)).verified).toBe(true);
    expect(detectFileType(bytes)).toBe('pdf');
  });

  test('refuses a name without the test marker, writing nothing', async () => {
    expect(await cli.run(argv().map((x) => (x === REQUEST.patientName ? 'Asha Rao' : x)), out)).toBe(2);
    expect(out.errorLog).toHaveBeenCalledWith(expect.stringContaining('fixture_name_not_marked'));
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  test('never overwrites an existing file', async () => {
    expect(await cli.run(argv(), out)).toBe(0);
    expect(await cli.run(argv(), out)).toBe(2);
    expect(out.errorLog).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(fs.readdirSync(folder)).toHaveLength(1);
  });

  test('rejects unknown options and missing values', async () => {
    expect(await cli.run(argv(['--force', 'yes']), out)).toBe(2);
    expect(await cli.run(['--name'], out)).toBe(2);
    expect(await cli.run(['--name', '--age'], out)).toBe(2);
  });

  test('opens no database, reads no .env and makes no network call (by construction), and is wired into the package scripts', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../scripts/e2e-fixture-pdf.js'), 'utf8');
    expect(source).not.toMatch(/dotenv|prisma|fetch\(|https?:\/\/|require\('(net|http|https|child_process)'\)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.scripts['e2e:fixture-pdf']).toBe('node scripts/e2e-fixture-pdf.js');
  });
});

// ---- the engine: contentVerified only from a real verification result ------------------------------------------------------------------------
const FROM = '2030-01-01T00:00:00Z';
const E2E_ENV = {
  PRIVATE_CHARTER_AUTO_APPROVE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_FROM: FROM, PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_DEAL_PROFILE: 'actual',
  PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: '+917000000001', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev',
};
const SHA = 'a'.repeat(64);

describe('engine integration', () => {
  let state; let prisma; let services; let files;
  const requestRow = (over = {}) => ({
    id: 501, userId: 9, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null, documentsRequestReason: null, createdAt: new Date('2030-02-01T00:00:00Z'),
    patientAge: 54, patientGender: 'female', country: 'IN', patientContact: '+919812345678', preferredDate: new Date('2030-03-05T00:00:00Z'), travelType: 'patient_transfer',
    criticalLevel: 'icu', oxygenRequired: false, oxygenFlowLpm: null, ...REQUEST, ...over,
  });
  const documentRow = { id: 81, scanStatus: 'clean', reviewStatus: 'pending', sha256: SHA, sizeBytes: 1000, mimeType: 'application/pdf', supersededAt: null, documentRequestId: null, originalName: 'r.pdf' };
  const build = ({ env = E2E_ENV, verifyFixture } = {}) => createAutoApproval({ env, prisma, services, log: { warn: jest.fn() }, readFile: async () => files.current, validateStructure, ...(verifyFixture && { verifyFixture }) });

  beforeEach(() => {
    state = { request: requestRow(), documents: [documentRow], owner: { mobile: '+917000000001' }, created: [] };
    files = { current: fixture };
    prisma = {
      $queryRaw: jest.fn(async () => [{ db: 'humancare_dev' }]),
      user: { findUnique: jest.fn(async () => state.owner) },
      serviceRequest: { findUnique: jest.fn(async () => state.request) },
      requestDocument: { findMany: jest.fn(async () => state.documents) },
      requestEvent: { findMany: jest.fn(async () => []), create: jest.fn(async ({ data }) => { state.created.push(data); return data; }) },
      case: { findUnique: jest.fn(async () => null) },
    };
    services = { approvalBlockers, reviewDocument: jest.fn(async () => undefined), approveRequest: jest.fn(async () => ({ alreadyApproved: false })) };
  });

  test('POSITIVE: the matching fixture is approved by the system and recorded as content-verified, with the field names only', async () => {
    expect(await build().processRequest(501)).toEqual({ outcome: 'approved' });
    expect(services.reviewDocument).toHaveBeenCalledWith({ requestId: 501, documentId: 81, adminId: null, decision: 'approved', actorType: 'system' });
    expect(services.approveRequest).toHaveBeenCalledWith({ requestId: 501, adminId: null, actorType: 'system' });
    expect(state.created[0]).toMatchObject({ action: 'auto_approved', actorType: 'system' });
    expect(state.created[0].detail).toMatchObject({ e2e: true, contentVerified: true, verified: 'e2e_fixture_text_match', fields: FIELDS });
    expect(JSON.stringify(state.created[0].detail)).not.toMatch(/Asha|Mumbai|Dubai/);
  });

  test.each([
    ['another patient\'s fixture (wrong name token)', async () => buildFixturePdf({ ...GOOD, patientName: 'E2E-TEST Asha Rao 9999' }), 'fixture_field_mismatch:Patient Name'],
    ['the right name but a different age', async () => buildFixturePdf({ ...GOOD, age: 60 }), 'fixture_field_mismatch:Age'],
    ['a different origin', async () => buildFixturePdf({ ...GOOD, origin: 'Pune' }), 'fixture_field_mismatch:Origin'],
    ['an ordinary PDF with no fixture text', async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return Buffer.from(await d.save()); }, 'fixture_banner_missing'],
    ['a fixture carrying extra content', async () => pdfOf([...goodLines(), 'Diagnosis: x']), 'fixture_unexpected_content'],
  ])('NEGATIVE: %s holds the request for a person; nothing is reviewed, approved or recorded', async (_n, make, code) => {
    files.current = await make();
    expect(await build().processRequest(501)).toEqual({ outcome: 'held', code: `e2e_document_content_unverified:${code}` });
    expect(services.reviewDocument).not.toHaveBeenCalled();
    expect(services.approveRequest).not.toHaveBeenCalled();
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });

  test('NEGATIVE: every current document must be a verified fixture, not just one', async () => {
    const second = { ...documentRow, id: 82, sha256: 'b'.repeat(64) };
    state.documents = [documentRow, second];
    let reads = 0;
    const engine = createAutoApproval({ env: E2E_ENV, prisma, services, log: { warn: jest.fn() }, validateStructure, readFile: async () => { reads += 1; return reads === 1 ? fixture : pdfOf(goodLines({ age: 99 })); } });
    expect(await engine.processRequest(501)).toEqual({ outcome: 'held', code: 'e2e_document_content_unverified:fixture_field_mismatch:Age' });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('NEGATIVE: the existing file checks still come first (a bad structure or a wrong declared type never reaches the content check)', async () => {
    const verifyFixture = jest.fn();
    files.current = Buffer.from('%PDF-1.7 not a real pdf at all, only text pretending to be one');
    expect((await build({ verifyFixture }).processRequest(501)).code).toMatch(/^document_structure_invalid:/);
    state.documents = [{ ...documentRow, mimeType: 'image/png' }];
    files.current = fixture;
    expect(await build({ verifyFixture }).processRequest(501)).toEqual({ outcome: 'held', code: 'document_type_mismatch' });
    expect(verifyFixture).not.toHaveBeenCalled();
  });

  test.each([
    ['verified: false', { verified: false, code: 'x' }, 'e2e_document_content_unverified:x'],
    ['no result at all', undefined, 'e2e_document_content_unverified:unknown'],
    ['a truthy value that is not true', { verified: 'yes' }, 'e2e_document_content_unverified:unknown'],
    ['verified: 1', { verified: 1 }, 'e2e_document_content_unverified:unknown'],
  ])('contentVerified is never inferred: a verifier result of %s holds the request', async (_n, result, code) => {
    expect(await build({ verifyFixture: async () => result }).processRequest(501)).toEqual({ outcome: 'held', code });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('a GENUINE request never reaches the verifier, never gets contentVerified: true, and still needs its own acceptance', async () => {
    const verifyFixture = jest.fn(async () => ({ verified: true, fields: FIELDS }));
    state.request = requestRow({ patientName: 'Asha Rao' });
    state.owner = { mobile: '+919812345678' };
    files.current = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
    const genuineEnv = { ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true' };
    const engine = createAutoApproval({ env: genuineEnv, prisma, services, log: { warn: jest.fn() }, readFile: async () => files.current, validateStructure: async () => null, verifyFixture });
    expect(await engine.processRequest(501)).toEqual({ outcome: 'approved' });
    expect(verifyFixture).not.toHaveBeenCalled();
    expect(state.created[0].detail).toMatchObject({ contentVerified: false, verified: 'file_type_and_structure_only' });
    expect(state.created[0].detail.e2e).toBeUndefined();
    // without the genuine acceptance it is held, exactly as before
    state.created.length = 0;
    expect(await build({ verifyFixture }).processRequest(501)).toEqual({ outcome: 'held', code: 'unverified_content_not_accepted' });
  });

  test('the synthetic orchestrator\'s identity is still never approved here, and never verified', async () => {
    const verifyFixture = jest.fn();
    state.request = requestRow({ patientName: 'ZZ-SYNTHETIC Run 1' });
    expect(await build({ verifyFixture }).processRequest(501)).toEqual({ outcome: 'held', code: 'synthetic_request' });
    expect(verifyFixture).not.toHaveBeenCalled();
  });

  test('the source never sets contentVerified to a literal true: it is derived from the verifier results only', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/request-review/auto-approval.js'), 'utf8');
    expect(source).not.toMatch(/contentVerified\s*[:=]\s*true/);
    expect(source).toMatch(/contentResults\.every\(\(r\) => r\.verified === true\)/);
  });
});
