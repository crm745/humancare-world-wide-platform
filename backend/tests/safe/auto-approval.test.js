/* global describe, test, expect, jest, beforeEach */
// Automatic approval of genuine Private Charter requests (src/modules/request-review/auto-approval.js).
// No database, no network: the rules are pure, and the engine runs against a fake Prisma and fake review services.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { autoApprovalConfig, evaluate, createAutoApproval, missingFormFields, verifyStoredDocument } = require('../../src/modules/request-review/auto-approval');
const { approvalBlockers } = jest.requireActual('../../src/modules/request-review/request-review.service');
const { buildFixturePdf } = require('../../src/modules/request-review/e2e-document-verification');
const { validateStructure: realValidateStructure } = require('../../src/storage/structure');

const SHA_A = 'a'.repeat(64);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const SHA_B = 'b'.repeat(64);
const ENV_ON = {
  PRIVATE_CHARTER_AUTO_APPROVE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2030-01-01T00:00:00Z', PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_DEAL_PROFILE: 'actual',
};
const request = (over = {}) => ({
  id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null, documentsRequestReason: null, createdAt: new Date('2030-02-01T00:00:00Z'),
  patientName: 'Asha Rao', patientAge: 54, patientGender: 'female', country: 'IN', patientContact: '+919812345678', preferredDate: new Date('2030-03-05T00:00:00Z'),
  travelType: 'patient_transfer', origin: 'Mumbai, India', destination: 'Dubai, UAE', criticalLevel: 'icu', oxygenRequired: false, oxygenFlowLpm: null, ...over,
});
const doc = (over = {}) => ({
  id: 81, originalName: 'report.pdf', scanStatus: 'clean', reviewStatus: 'pending', sha256: SHA_A, sizeBytes: 1000, mimeType: 'application/pdf', supersededAt: null, documentRequestId: null, ...over,
});
const verdict = (over = {}) => evaluate({ request: request(), documents: [doc()], eventActions: ['request_created', 'document_uploaded', 'scan_clean'], hasCase: false, env: ENV_ON, ...over }, { approvalBlockers });

describe('configuration: off unless explicitly on, with a start time', () => {
  test.each([
    ['nothing set', {}],
    ['switch not exactly true', { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE: 'TRUE' }],
    ['no start time', { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: '' }],
    ['unparseable start time', { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: 'yesterday-ish' }],
    ['review workflow off', { ...ENV_ON, PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }],
    ['content verification not acknowledged', { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: undefined }],
    ['acknowledgement not exactly true', { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'yes' }],
  ])('%s: disabled', (_n, env) => {
    expect(autoApprovalConfig(env).enabled).toBe(false);
  });

  test('switch on with a valid start time: enabled, with the parsed time', () => {
    const config = autoApprovalConfig(ENV_ON);
    expect(config.enabled).toBe(true);
    expect(config.from.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });
});

// ---- the designated E2E test identity ----------------------------------------------------------------------------------------------------
const TEST_MOBILE = '+917000000001'; // a Firebase TEST number shape: never a real patient
const E2E_ENV = {
  PRIVATE_CHARTER_AUTO_APPROVE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2030-01-01T00:00:00Z', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_DEAL_PROFILE: 'actual',
  PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: `${TEST_MOBILE}, +917000000002`,
  DATABASE_URL: 'mysql://user:pw@localhost:3306/humancare_dev', // NOTE: no PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: genuine acceptance stays OFF
};
const e2eVerdict = ({ name = 'E2E-TEST Asha', mobile = TEST_MOBILE, env = E2E_ENV, ...rest } = {}) => evaluate({
  request: request({ patientName: name }), documents: [doc()], eventActions: [], hasCase: false, owner: { mobile }, env, ...rest,
}, { approvalBlockers });

describe('designated E2E test identity: configuration', () => {
  test('off by default, and genuine acceptance is a separate switch', () => {
    expect(autoApprovalConfig({ ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: undefined })).toEqual({ enabled: false, reason: 'unverified_content_not_accepted' });
    expect(autoApprovalConfig({ ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: 'TRUE' })).toEqual({ enabled: false, reason: 'unverified_content_not_accepted' });
  });

  test('valid: enabled for the designated numbers only, WITHOUT enabling the genuine path', () => {
    const config = autoApprovalConfig(E2E_ENV);
    expect(config).toMatchObject({ enabled: true, acceptsGenuine: false });
    expect(config.e2e.enabled).toBe(true);
    expect([...config.e2e.mobiles]).toEqual([TEST_MOBILE, '+917000000002']);
  });

  test.each([
    ['production', { NODE_ENV: 'production' }, 'e2e_refused_in_production'],
    ['a different database', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'e2e_requires_local_dev_database'],
    ['a production-looking database name', { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare' }, 'e2e_requires_local_dev_database'],
    ['a remote host', { DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'e2e_requires_local_dev_database'],
    ['no database url', { DATABASE_URL: undefined }, 'e2e_requires_local_dev_database'],
    ['no designated numbers', { PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: '' }, 'e2e_mobiles_missing'],
    ['a malformed number', { PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: '9876543210' }, 'e2e_mobiles_invalid'],
    ['a wildcard instead of a number', { PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: '+91*' }, 'e2e_mobiles_invalid'],
    ['too many numbers', { PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: '+917000000001,+917000000002,+917000000003,+917000000004,+917000000005,+917000000006' }, 'e2e_mobiles_invalid'],
  ])('requested but refused (and said so, never silently ignored): %s', (_n, override, reason) => {
    expect(autoApprovalConfig({ ...E2E_ENV, ...override })).toEqual({ enabled: false, reason });
  });

  test('when the genuine acceptance is ALSO on, an unusable E2E mode only disables the test path, not the genuine one', () => {
    const config = autoApprovalConfig({ ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true', NODE_ENV: 'production' });
    expect(config).toMatchObject({ enabled: true, acceptsGenuine: true });
    expect(config.e2e.enabled).toBe(false);
  });
});

describe('designated E2E test identity: who may enter', () => {
  test('a marked request owned by a designated number qualifies, with no genuine acceptance configured', () => {
    expect(e2eVerdict()).toMatchObject({ ok: true, e2e: true });
    expect(e2eVerdict({ mobile: '+917000000002' }).ok).toBe(true);
  });

  test.each([
    ['a marked name from a number that is NOT designated', { mobile: '+919812345678' }, 'e2e_identity_not_designated'],
    ['a marked name from an owner with no number', { mobile: null }, 'e2e_identity_not_designated'],
    ['a designated number with an UNMARKED name', { name: 'Asha Rao' }, 'e2e_identity_requires_test_name'],
    ['the marker in the middle of a name, not at the start', { name: 'Asha E2E-TEST' }, 'e2e_identity_requires_test_name'],
    ['a marked name when E2E mode is off', { env: { ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: undefined, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true' } }, 'e2e_mode_off'],
  ])('held: %s', (_n, override, code) => {
    expect(e2eVerdict(override)).toEqual({ ok: false, code });
  });

  test('a genuine (unmarked, non-designated) request is NOT opened by E2E mode: the genuine acceptance is still required', () => {
    expect(e2eVerdict({ name: 'Asha Rao', mobile: '+919812345678' })).toEqual({ ok: false, code: 'unverified_content_not_accepted' });
    // and with the genuine acceptance on, it behaves exactly as before
    const both = { ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true' };
    expect(e2eVerdict({ name: 'Asha Rao', mobile: '+919812345678', env: both })).toMatchObject({ ok: true, e2e: false });
  });

  test('the synthetic orchestrator\'s identity is never admitted here, whatever the E2E mode says, even from a designated number', () => {
    expect(e2eVerdict({ name: 'ZZ-SYNTHETIC Run1' })).toEqual({ ok: false, code: 'synthetic_request' });
    expect(e2eVerdict({ eventActions: ['synthetic_e2e_marked'] })).toEqual({ ok: false, code: 'synthetic_request' });
    expect(e2eVerdict({ name: 'E2E-TEST x', eventActions: ['synthetic_e2e_consumed'] })).toEqual({ ok: false, code: 'synthetic_request' });
  });

  test.each([
    ['the cutoff', { request: request({ patientName: 'E2E-TEST Asha', createdAt: new Date('2029-12-31T00:00:00Z') }) }, 'before_start_time'],
    ['the Bitrix profile', { env: { ...E2E_ENV, BITRIX_DEAL_PROFILE: 'test' } }, 'profile_not_actual'],
    ['the Bitrix profile being unset', { env: { ...E2E_ENV, BITRIX_DEAL_PROFILE: undefined } }, 'profile_not_actual'],
    ['a Bitrix Lead', { request: request({ patientName: 'E2E-TEST Asha', bitrixLeadId: 5 }) }, 'has_bitrix_lead'],
    ['an existing Case', { hasCase: true }, 'case_exists'],
    ['an incomplete form', { request: request({ patientName: 'E2E-TEST Asha', patientAge: null }) }, 'incomplete_form:patientAge'],
    ['an unscanned document', { documents: [doc({ scanStatus: 'pending' })] }, 'document_scan_pending'],
    ['an infected document', { documents: [doc({ scanStatus: 'infected' })] }, 'document_scan_infected'],
    ['a document of a disallowed type', { documents: [doc({ mimeType: 'application/zip' })] }, 'document_type_not_allowed'],
    ['duplicate document content', { documents: [doc({ id: 1 }), doc({ id: 2 })] }, 'duplicate_document_content'],
    ['a required document kind', { env: { ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_REQUIRED_DOCUMENTS: 'medical_report' } }, 'required_document_types_unverifiable'],
    ['a rejection history', { eventActions: ['document_rejected'] }, 'review_history_requires_a_person'],
    ['a request that is not in review', { request: request({ patientName: 'E2E-TEST Asha', reviewStatus: 'approved' }) }, 'not_in_review'],
  ])('every other rule still applies to a designated request: %s', (_n, override, code) => {
    expect(e2eVerdict(override)).toEqual({ ok: false, code });
  });
});

describe('designated E2E test identity: the engine', () => {
  let state; let prisma; let services; let queryResult; let fixture;
  // The designated request's document must be its own fictional fixture (the defaults of request(): name, age 54, female, Mumbai, India / Dubai, UAE).
  beforeAll(async () => {
    fixture = await buildFixturePdf({ patientName: 'E2E-TEST Asha', age: 54, gender: 'female', origin: 'Mumbai, India', destination: 'Dubai, UAE' });
  });
  const build = (env = E2E_ENV) => createAutoApproval({ env, prisma, services, log: { warn: jest.fn() }, readFile: async () => fixture, validateStructure: realValidateStructure });

  beforeEach(() => {
    state = { request: request({ id: 401, userId: 9, patientName: 'E2E-TEST Asha', createdAt: new Date('2030-02-01T00:00:00Z') }), documents: [doc()], created: [], owner: { mobile: TEST_MOBILE } };
    queryResult = [{ db: 'humancare_dev' }];
    prisma = {
      $queryRaw: jest.fn(async () => queryResult),
      user: { findUnique: jest.fn(async () => state.owner) },
      serviceRequest: { findUnique: jest.fn(async () => state.request), findMany: jest.fn(async () => [{ id: 401 }]) },
      requestDocument: { findMany: jest.fn(async () => state.documents) },
      requestEvent: { findMany: jest.fn(async () => []), create: jest.fn(async ({ data }) => { state.created.push(data); return data; }) },
      case: { findUnique: jest.fn(async () => null) },
    };
    services = {
      approvalBlockers,
      reviewDocument: jest.fn(async () => undefined),
      approveRequest: jest.fn(async () => ({ alreadyApproved: false })),
    };
  });

  test('approves the designated request through the EXISTING services as the system; contentVerified is true only because the fixture verifier succeeded', async () => {
    expect(await build().processRequest(401)).toEqual({ outcome: 'approved' });
    expect(services.reviewDocument).toHaveBeenCalledWith({ requestId: 401, documentId: 81, adminId: null, decision: 'approved', actorType: 'system' });
    expect(services.approveRequest).toHaveBeenCalledWith({ requestId: 401, adminId: null, actorType: 'system' });
    expect(state.created[0].detail).toMatchObject({ e2e: true, contentVerified: true, verified: 'e2e_fixture_text_match', fields: ['Patient Name', 'Age', 'Gender', 'Origin', 'Destination'] });
    expect(JSON.stringify(state.created[0].detail)).not.toMatch(/Asha|Mumbai|Dubai/); // names of fields only, never a value
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 9 }, select: { mobile: true } });
  });

  test('refuses unless the live server itself says it is humancare_dev', async () => {
    for (const rows of [[{ db: 'humancare_test' }], [{ db: 'humancare' }], []]) {
      queryResult = rows;
      expect(await build().processRequest(401)).toEqual({ outcome: 'held', code: 'database_not_identified' });
    }
    prisma.$queryRaw.mockRejectedValue(new Error('db'));
    expect(await build().processRequest(401)).toEqual({ outcome: 'held', code: 'database_not_identified' });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('a non-designated owner is held, and the owner number is only read when E2E mode is on', async () => {
    state.owner = { mobile: '+919812345678' };
    expect(await build().processRequest(401)).toEqual({ outcome: 'held', code: 'e2e_identity_not_designated' });
    expect(services.approveRequest).not.toHaveBeenCalled();
    prisma.user.findUnique.mockClear();
    state.request = request({ id: 402, patientName: 'Asha Rao', createdAt: new Date('2030-02-01T00:00:00Z') });
    await build({ ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: undefined, PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT: 'true' }).processRequest(402);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('the existing history stays untouched in E2E mode too: requests 155-157, REQ-1205 and REQ-1206 are older than the cutoff, so nothing is read, reviewed, approved or written', async () => {
    const env = { ...E2E_ENV, PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2026-11-21T12:30:00Z' };
    for (const [id, createdAt] of [[155, '2026-11-15T09:00:00Z'], [156, '2026-11-15T09:30:00Z'], [157, '2026-11-15T10:00:00Z'], [205, '2026-11-21T10:12:54.772Z'], [206, '2026-11-21T10:14:38.521Z']]) {
      state.request = request({ id, patientName: 'E2E-TEST history', createdAt: new Date(createdAt) });
      expect(await build(env).processRequest(id)).toEqual({ outcome: 'held', code: 'before_start_time' });
    }
    expect(services.reviewDocument).not.toHaveBeenCalled();
    expect(services.approveRequest).not.toHaveBeenCalled();
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });
});

describe('no date is hard-coded in the policy', () => {
  test('auto-approval.js holds no date literal and no floor: PRIVATE_CHARTER_AUTO_APPROVE_FROM alone decides', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/modules/request-review/auto-approval.js'), 'utf8');
    expect(source).not.toMatch(/new Date\(\s*['"`]\d{4}-/); // no fixed date
    expect(source).not.toMatch(/HISTORICAL_FLOOR|FLOOR/);
    expect(source).toMatch(/PRIVATE_CHARTER_AUTO_APPROVE_FROM/);
  });
});

describe('eligibility rules', () => {
  test('a complete, clean, post-cutoff Private Charter request qualifies, with its pending document to approve', () => {
    const result = verdict();
    expect(result.ok).toBe(true);
    expect(result.pending.map((d) => d.id)).toEqual([81]);
  });

  test('a document an Admin already approved is accepted and not approved again', () => {
    const result = verdict({ documents: [doc({ reviewStatus: 'approved' })] });
    expect(result).toMatchObject({ ok: true, pending: [] });
  });

  test('a replaced (superseded) document is ignored', () => {
    expect(verdict({ documents: [doc({ id: 80, supersededAt: new Date(), scanStatus: 'infected' }), doc()] }).ok).toBe(true);
  });

  test.each([
    ['disabled', { env: {} }, 'switch_off'],
    ['not Private Charter', { request: request({ serviceKey: 'air' }) }, 'not_private_charter'],
    ['awaiting documents', { request: request({ reviewStatus: 'awaiting_documents' }) }, 'not_in_review'],
    ['changes requested', { request: request({ reviewStatus: 'changes_requested' }) }, 'not_in_review'],
    ['already approved', { request: request({ reviewStatus: 'approved' }) }, 'not_in_review'],
    ['legacy request with no review status', { request: request({ reviewStatus: null }) }, 'not_in_review'],
    ['created BEFORE the start time (historical)', { request: request({ createdAt: new Date('2029-12-31T23:59:59Z') }) }, 'before_start_time'],
    ['synthetic by name', { request: request({ patientName: 'ZZ-SYNTHETIC Test' }) }, 'synthetic_request'],
    ['synthetic by marker event', { eventActions: ['synthetic_e2e_marked'] }, 'synthetic_request'],
    ['wrong Bitrix profile (test pipeline)', { env: { ...ENV_ON, BITRIX_DEAL_PROFILE: 'test' } }, 'profile_not_actual'],
    ['no Bitrix profile', { env: { ...ENV_ON, BITRIX_DEAL_PROFILE: '' } }, 'profile_not_actual'],
    ['has a Bitrix Lead', { request: request({ bitrixLeadId: 99 }) }, 'has_bitrix_lead'],
    ['already has a Case', { hasCase: true }, 'case_exists'],
    ['documents were requested', { request: request({ documentsRequestReason: 'Need ECG' }) }, 'documents_requested'],
    ['a document was rejected before', { eventActions: ['document_rejected'] }, 'review_history_requires_a_person'],
    ['more documents were asked for before', { eventActions: ['documents_requested'] }, 'review_history_requires_a_person'],
    ['no documents', { documents: [] }, 'no_documents'],
    ['only a replaced document', { documents: [doc({ supersededAt: new Date() })] }, 'no_documents'],
    ['scan pending', { documents: [doc({ scanStatus: 'pending' })] }, 'document_scan_pending'],
    ['scan error', { documents: [doc({ scanStatus: 'error' })] }, 'document_scan_error'],
    ['infected', { documents: [doc({ scanStatus: 'infected' })] }, 'document_scan_infected'],
    ['scan failed for good', { documents: [doc({ scanStatus: 'failed' })] }, 'document_scan_failed'],
    ['rejected document', { documents: [doc({ reviewStatus: 'rejected' })] }, 'document_rejected'],
    ['post-approval document request upload', { documents: [doc({ documentRequestId: 4 })] }, 'document_is_post_approval_request'],
    ['no checksum', { documents: [doc({ sha256: null })] }, 'document_checksum_missing'],
    ['bad checksum', { documents: [doc({ sha256: 'xyz' })] }, 'document_checksum_missing'],
    ['empty file', { documents: [doc({ sizeBytes: 0 })] }, 'document_checksum_missing'],
    ['disallowed type', { documents: [doc({ mimeType: 'application/zip' })] }, 'document_type_not_allowed'],
    ['duplicate content', { documents: [doc({ id: 81 }), doc({ id: 82 })] }, 'duplicate_document_content'],
  ])('held for a person: %s', (_n, override, code) => {
    const result = verdict(override);
    expect(result).toEqual({ ok: false, code });
  });

  test('one bad document among good ones holds the whole request', () => {
    expect(verdict({ documents: [doc(), doc({ id: 82, sha256: SHA_B, scanStatus: 'pending' })] })).toEqual({ ok: false, code: 'document_scan_pending' });
  });

  test('an incomplete stored form is held, naming the missing fields', () => {
    expect(verdict({ request: request({ patientAge: null, patientContact: '' }) })).toEqual({ ok: false, code: 'incomplete_form:patientAge+patientContact' });
    expect(missingFormFields(request({ oxygenRequired: true, oxygenFlowLpm: null }))).toEqual(['oxygenFlowLpm']);
    expect(missingFormFields(request({ oxygenRequired: true, oxygenFlowLpm: 4 }))).toEqual([]);
    expect(missingFormFields(request({ oxygenRequired: null }))).toEqual(['oxygenRequired']);
    expect(missingFormFields(request())).toEqual([]);
  });
});

describe('the engine', () => {
  let state; let prisma; let services; let log;
  let files; let structure;
  const build = (env = ENV_ON) => createAutoApproval({ env, prisma, services, log, readFile: files, validateStructure: structure });

  beforeEach(() => {
    state = { request: request(), documents: [doc()], events: [{ action: 'scan_clean' }], caseRecord: null, created: [] };
    log = { warn: jest.fn() };
    files = jest.fn(async () => PDF_BYTES); // what the checksum-verified reader returns
    structure = jest.fn(async () => null); // the existing structure validator: null = acceptable
    prisma = {
      serviceRequest: { findUnique: jest.fn(async () => state.request), findMany: jest.fn(async () => (state.request ? [{ id: state.request.id }] : [])) },
      requestDocument: { findMany: jest.fn(async () => state.documents) },
      requestEvent: { findMany: jest.fn(async () => state.events), create: jest.fn(async ({ data }) => { state.created.push(data); return data; }) },
      case: { findUnique: jest.fn(async () => state.caseRecord) },
    };
    services = {
      approvalBlockers,
      reviewDocument: jest.fn(async ({ documentId }) => { state.documents = state.documents.map((d) => (d.id === documentId ? { ...d, reviewStatus: 'approved' } : d)); }),
      approveRequest: jest.fn(async () => { state.request = { ...state.request, reviewStatus: 'approved' }; return { alreadyApproved: false }; }),
    };
  });

  test('disabled: touches nothing, not even a read', async () => {
    expect(await build({}).processRequest(61)).toEqual({ outcome: 'disabled' });
    expect(prisma.serviceRequest.findUnique).not.toHaveBeenCalled();
    expect(services.reviewDocument).not.toHaveBeenCalled();
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('an eligible request: documents approved, then the request, both by the SYSTEM actor, and one auto_approved event', async () => {
    expect(await build().processRequest(61)).toEqual({ outcome: 'approved' });
    expect(services.reviewDocument).toHaveBeenCalledWith({ requestId: 61, documentId: 81, adminId: null, decision: 'approved', actorType: 'system' });
    expect(services.approveRequest).toHaveBeenCalledWith({ requestId: 61, adminId: null, actorType: 'system' });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ serviceRequestId: 61, action: 'auto_approved', actorType: 'system', actorId: null });
    expect(JSON.stringify(state.created[0])).not.toMatch(/Asha|919812345678/); // no patient data in the audit event
  });

  test('an ineligible request is held: nothing is approved, rejected or written', async () => {
    state.documents = [doc({ scanStatus: 'pending' })];
    expect(await build().processRequest(61)).toEqual({ outcome: 'held', code: 'document_scan_pending' });
    expect(services.reviewDocument).not.toHaveBeenCalled();
    expect(services.approveRequest).not.toHaveBeenCalled();
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });

  test('a historical request (before the start time) is held without any write', async () => {
    state.request = request({ createdAt: new Date('2029-06-01T00:00:00Z') });
    expect(await build().processRequest(61)).toEqual({ outcome: 'held', code: 'before_start_time' });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('idempotent: a request that is already approved writes no second event', async () => {
    services.approveRequest.mockResolvedValue({ alreadyApproved: true });
    expect(await build().processRequest(61)).toEqual({ outcome: 'already_approved' });
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });

  test('a second run after approval holds (not_in_review): no second approval is attempted', async () => {
    const engine = build();
    await engine.processRequest(61);
    services.approveRequest.mockClear();
    expect(await engine.processRequest(61)).toEqual({ outcome: 'held', code: 'not_in_review' });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('another approver deciding a document first (already_decided) is fine', async () => {
    services.reviewDocument.mockRejectedValue(Object.assign(new Error('decided'), { publicCode: 'already_decided' }));
    expect(await build().processRequest(61)).toEqual({ outcome: 'approved' });
  });

  test('an approval blocked inside the service (a person rejected a file meanwhile) leaves the request for review and writes no event', async () => {
    services.approveRequest.mockRejectedValue(Object.assign(new Error('blocked'), { publicCode: 'approval_blocked' }));
    expect(await build().processRequest(61)).toEqual({ outcome: 'held', code: 'approval_blocked', stage: 'request_approval' });
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });

  test('a failing audit event never undoes or fails the approval', async () => {
    prisma.requestEvent.create.mockRejectedValue(new Error('db'));
    expect(await build().processRequest(61)).toEqual({ outcome: 'approved' });
  });

  test('never throws, whatever fails', async () => {
    prisma.serviceRequest.findUnique.mockRejectedValue(new Error('db down'));
    expect(await build().processRequest(61)).toMatchObject({ outcome: 'error' });
  });

  test('a synthetic request is left to the synthetic engine', async () => {
    state.events = [{ action: 'synthetic_e2e_marked' }];
    expect(await build().processRequest(61)).toEqual({ outcome: 'held', code: 'synthetic_request' });
    expect(services.approveRequest).not.toHaveBeenCalled();
  });

  test('the sweep only asks for candidate requests created after the start time with no Case and no Lead, and processes each', async () => {
    const result = await build().sweep();
    expect(prisma.serviceRequest.findMany).toHaveBeenCalledTimes(1);
    const { where, take } = prisma.serviceRequest.findMany.mock.calls[0][0];
    expect(where).toEqual({ serviceKey: 'privatecharter', reviewStatus: 'in_review', createdAt: { gte: new Date('2030-01-01T00:00:00Z') }, bitrixLeadId: null, case: { is: null } });
    expect(take).toBe(20);
    expect(result.processed).toBe(1);
    expect(result.results[0]).toMatchObject({ requestId: 61, outcome: 'approved' });
  });

  // ---- the explicit cutoff: PRIVATE_CHARTER_AUTO_APPROVE_FROM is the only date; no hidden floor in the code ----
  // The real requests that exist today, as they are stored: created before automation goes live.
  const HISTORY = [
    { id: 155, ref: 'REQ-1155', createdAt: '2026-11-15T09:00:00Z' }, { id: 156, ref: 'REQ-1156', createdAt: '2026-11-15T09:30:00Z' }, { id: 157, ref: 'REQ-1157', createdAt: '2026-11-15T10:00:00Z' },
    { id: 205, ref: 'REQ-1205', createdAt: '2026-11-21T10:12:54.772Z' }, { id: 206, ref: 'REQ-1206', createdAt: '2026-11-21T10:14:38.521Z' },
  ];
  const GO_LIVE = { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2026-11-21T12:30:00Z' }; // after the newest existing request
  const everyWriteMock = () => [services.reviewDocument, services.approveRequest, prisma.requestEvent.create];

  test.each(HISTORY)('request $id ($ref), created before the cutoff, is held and nothing about it is modified', async ({ id, createdAt }) => {
    state.request = request({ id, createdAt: new Date(createdAt) });
    expect(await build(GO_LIVE).processRequest(id)).toEqual({ outcome: 'held', code: 'before_start_time' });
    for (const write of everyWriteMock()) expect(write).not.toHaveBeenCalled(); // no review, no approval, no event
    expect(files).not.toHaveBeenCalled(); // not even a stored file is read
    expect(prisma.requestDocument.findMany).toHaveBeenCalled(); // (it was only READ to be judged)
    expect(Object.keys(prisma).every((model) => !Object.keys(prisma[model]).some((m) => /^(update|delete|upsert|updateMany|deleteMany)$/.test(m)))).toBe(true); // the fake database offers no way to change a row
  });

  test('the sweep never even lists them: its query starts at the configured cutoff, nothing earlier', async () => {
    await build(GO_LIVE).sweep();
    expect(prisma.serviceRequest.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date('2026-11-21T12:30:00Z') });
  });

  test('a request created after the cutoff can qualify and is approved by the system', async () => {
    state.request = request({ id: 301, createdAt: new Date('2026-11-21T12:45:00Z') });
    expect(await build(GO_LIVE).processRequest(301)).toEqual({ outcome: 'approved' });
    expect(services.approveRequest).toHaveBeenCalledWith({ requestId: 301, adminId: null, actorType: 'system' });
  });

  test('the cutoff instant itself qualifies; one millisecond before does not', () => {
    const at = verdict({ request: request({ createdAt: new Date('2030-01-01T00:00:00.000Z') }) }); // ENV_ON cutoff is 2030-01-01T00:00:00Z
    const before = verdict({ request: request({ createdAt: new Date('2029-12-31T23:59:59.999Z') }) });
    expect(at.ok).toBe(true);
    expect(before).toEqual({ ok: false, code: 'before_start_time' });
  });

  test('the cutoff is the only date: an early cutoff is honoured exactly as written (there is no hidden floor), and a missing or invalid one disables everything', () => {
    expect(autoApprovalConfig({ ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2020-01-01T00:00:00Z' }).from.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(autoApprovalConfig({ ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: undefined })).toEqual({ enabled: false, reason: 'start_time_missing_or_invalid' });
    expect(autoApprovalConfig({ ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_FROM: 'soon' })).toEqual({ enabled: false, reason: 'start_time_missing_or_invalid' });
  });

  test('the stored bytes are read and verified before anything is approved', async () => {
    await build().processRequest(61);
    expect(files).toHaveBeenCalledTimes(1);
    expect(files.mock.calls[0][0]).toMatchObject({ id: 81, sha256: SHA_A });
    expect(structure).toHaveBeenCalledWith('pdf', PDF_BYTES);
  });

  test.each([
    ['the stored file is missing', async () => { throw Object.assign(new Error('x'), { publicCode: 'file_missing' }); }, null, 'document_unreadable:file_missing'],
    ['the stored file changed since it was scanned', async () => { throw Object.assign(new Error('x'), { publicCode: 'file_changed' }); }, null, 'document_unreadable:file_changed'],
    ['storage is unavailable', async () => { throw Object.assign(new Error('x'), { publicCode: 'storage_unavailable' }); }, null, 'document_unreadable:storage_unavailable'],
    ['the bytes are not a recognised file type', async () => Buffer.from('MZ this is an executable pretending to be a report'), null, 'document_type_unverifiable'],
    ['the bytes are an image but the record says PDF', async () => PNG_BYTES, null, 'document_type_mismatch'],
    ['the structure is invalid', async () => PDF_BYTES, async () => ({ code: 'pdf_active_content', reason: '/JavaScript' }), 'document_structure_invalid:pdf_active_content'],
    ['the structure check itself fails', async () => PDF_BYTES, async () => { throw new Error('parser crashed'); }, 'document_structure_unverifiable'],
  ])('held for a person when %s', async (_n, reader, validator, code) => {
    files.mockImplementation(reader);
    if (validator) structure.mockImplementation(validator);
    expect(await build().processRequest(61)).toEqual({ outcome: 'held', code });
    expect(services.reviewDocument).not.toHaveBeenCalled();
    expect(services.approveRequest).not.toHaveBeenCalled();
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });

  test('a required document KIND cannot be verified by machine, so every request is held', async () => {
    const env = { ...ENV_ON, PRIVATE_CHARTER_AUTO_APPROVE_REQUIRED_DOCUMENTS: 'medical_report, passport' };
    expect(autoApprovalConfig(env).requiredDocuments).toEqual(['medical_report', 'passport']);
    expect(await build(env).processRequest(61)).toEqual({ outcome: 'held', code: 'required_document_types_unverifiable' });
    expect(services.approveRequest).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
  });

  test('the audit event never claims the contents were verified', async () => {
    await build().processRequest(61);
    expect(state.created[0].detail).toMatchObject({ contentVerified: false, verified: 'file_type_and_structure_only', rules: 'v2' });
  });

  test('verifyStoredDocument: a real PDF and a real PNG with matching records pass', async () => {
    const ok = (bytes) => verifyStoredDocument({ mimeType: bytes === PDF_BYTES ? 'application/pdf' : 'image/png' }, { readFile: async () => bytes, validateStructure: async () => null });
    expect(await ok(PDF_BYTES)).toBeNull();
    expect(await ok(PNG_BYTES)).toBeNull();
  });

  test('the sweep does nothing when disabled', async () => {
    expect(await build({}).sweep()).toEqual({ processed: 0, results: [] });
    expect(prisma.serviceRequest.findMany).not.toHaveBeenCalled();
  });
});
