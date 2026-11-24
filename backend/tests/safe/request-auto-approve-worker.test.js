/* global describe, test, expect, jest, beforeEach */
// The one-time recovery runner for REQ-1210 (src/request-auto-approve-worker.js). The existing auto-approval rules (autoApprovalConfig, evaluate, inspectStoredDocument,
// approvalBlockers) are the REAL ones; the stored file, the fixture check and the approval itself are injected. The fake Prisma has READ methods only, so a write by the
// runner would throw. No database, no network, no Bitrix, no worker.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() }));

const fs = require('fs');
const path = require('path');
const runner = require('../../src/request-auto-approve-worker');

const MOBILE = '+919999900055';
const ENV = {
  NODE_ENV: 'development', DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev', BITRIX_DEAL_PROFILE: 'actual', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true',
  PRIVATE_CHARTER_AUTO_APPROVE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2026-11-23T00:00:00Z', PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: 'true', PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: MOBILE,
};
const ARGS = ['--request-id', '210', '--request-reference', 'REQ-1210'];
const PDF = Buffer.from('%PDF-1.7\n% fixture\n');
let state; let prisma; let log; let databaseName; let deps;

const makeRequest = (over = {}) => ({
  id: 210, referenceNumber: 'REQ-1210', serviceKey: 'privatecharter', reviewStatus: 'in_review', createdAt: new Date('2026-11-23T13:26:46Z'), userId: 65,
  patientName: 'E2E-TEST Air Ambulance 2301', patientAge: 54, patientGender: 'male', country: 'IN', patientContact: '+919000000001', preferredDate: '2026-12-01',
  travelType: 'patient_transfer', origin: 'Mumbai', destination: 'Dubai', criticalLevel: 'icu', oxygenRequired: true, oxygenFlowLpm: 5, bitrixLeadId: null, documentsRequestReason: null,
  status: 'submitted', ...over,
});
const makeDoc = (over = {}) => ({
  id: 209, serviceRequestId: 210, originalName: 'fixture.pdf', scanStatus: 'clean', reviewStatus: 'pending', documentRequestId: null, supersededAt: null,
  sha256: 'a'.repeat(64), sizeBytes: 1152, mimeType: 'application/pdf', ...over,
});

beforeEach(() => {
  databaseName = 'humancare_dev';
  log = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  state = {
    requests: [makeRequest(), { id: 207, reviewStatus: 'in_review', status: 'submitted' }, { id: 208, reviewStatus: 'approved', status: 'submitted' }],
    documents: [makeDoc()], events: [{ action: 'request_created' }, { action: 'document_uploaded' }, { action: 'status_changed' }, { action: 'scan_clean' }],
    cases: [{ id: 206, serviceRequestId: 208, status: 'submitted', charterStage: 'patient_details', stageVersion: 1, referenceNumber: 'CASE-1206' }],
    links: [{ id: 1, caseId: 206, profile: 'actual', bitrixDealId: '21846' }],
    outbox: [
      { id: 1, caseId: 157, eventType: 'bitrix.deal.create', status: 'pending', attempts: 0, lockedBy: null, lastError: null, payload: {} },
      { id: 2, caseId: 158, eventType: 'bitrix.deal.create', status: 'pending', attempts: 0, lockedBy: null, lastError: null, payload: {} },
      { id: 52, caseId: 205, eventType: 'bitrix.deal.create', status: 'pending', attempts: 0, lockedBy: null, lastError: null, payload: {} },
    ],
    ownerMobile: MOBILE,
  };
  // Read methods only: any create / update / delete would be a TypeError.
  prisma = {
    $queryRaw: jest.fn(async () => [{ db: databaseName }]),
    serviceRequest: {
      findUnique: jest.fn(async ({ where }) => state.requests.find((r) => r.id === where.id) || null),
      findMany: jest.fn(async ({ where }) => state.requests.filter((r) => r.id !== where.id.not)),
    },
    user: { findUnique: jest.fn(async () => (state.ownerMobile === undefined ? null : { mobile: state.ownerMobile })) },
    requestDocument: { findMany: jest.fn(async () => state.documents) },
    requestEvent: { findMany: jest.fn(async () => state.events) },
    case: {
      findUnique: jest.fn(async ({ where }) => state.cases.find((c) => c.serviceRequestId === where.serviceRequestId) || null),
      findMany: jest.fn(async (args) => (args && args.where ? state.cases.filter((c) => c.serviceRequestId === args.where.serviceRequestId) : state.cases)),
    },
    bitrixDealLink: { findMany: jest.fn(async ({ where }) => state.links.filter((l) => l.caseId === where.caseId)) },
    integrationOutbox: {
      findMany: jest.fn(async (args) => (args && args.where ? state.outbox.filter((o) => o.caseId === args.where.caseId && o.eventType === args.where.eventType) : state.outbox)),
    },
  };
  deps = {
    readFile: jest.fn(async () => PDF), validateStructure: jest.fn(async () => null), verifyFixture: jest.fn(async () => ({ verified: true })),
    autoApprovalFn: jest.fn(async (id) => approve(id)),
  };
});

// What the existing engine does on success: ONE Case, ONE actual link, ONE pending actual event, request approved, document approved.
function approve(id, { profile = 'actual', cases = 1, events = 1, links = 1, touchOthers = false } = {}) {
  state.requests.find((r) => r.id === id).reviewStatus = 'approved';
  state.documents[0].reviewStatus = 'approved';
  for (let i = 0; i < cases; i += 1) state.cases.push({ id: 208 + i, serviceRequestId: id, status: 'submitted', charterStage: 'patient_details', stageVersion: 0, referenceNumber: `CASE-${1208 + i}` });
  for (let i = 0; i < links; i += 1) state.links.push({ id: 10 + i, caseId: 208, profile, bitrixDealId: null });
  for (let i = 0; i < events; i += 1) state.outbox.push({ id: 53 + i, caseId: 208, eventType: 'bitrix.deal.create', status: 'pending', attempts: 0, lockedBy: null, lastError: null, payload: { caseId: 208, profile } });
  if (touchOthers) state.outbox.find((o) => o.id === 52).status = 'processing';
  return { outcome: 'approved' };
}

const run = (argv = ARGS, extra = {}) => runner.run({ argv, env: extra.env || ENV, prisma, log, deps: { ...deps, ...(extra.deps || {}) } });
const out = () => [...log.log.mock.calls, ...log.error.mock.calls].map((c) => c.join(' ')).join('\n');
const refusedWith = async (code, extra) => {
  expect(await run(extra && extra.argv ? extra.argv : [...ARGS, ...(extra && extra.once ? ['--once'] : [])], extra)).toBe(1);
  expect(out()).toContain(code);
  expect(deps.autoApprovalFn).not.toHaveBeenCalled();
};

describe('arguments: exactly request 210 / REQ-1210, readiness by default', () => {
  test('both identifiers are required in every mode; only --once executes', () => {
    expect(runner.parseArgs(ARGS)).toEqual({ execute: false });
    expect(runner.parseArgs(['--readiness-only', ...ARGS])).toEqual({ execute: false });
    expect(runner.parseArgs(['--once', ...ARGS])).toEqual({ execute: true });
  });
  test.each([
    [['--once'], 'request_id_required'], [['--once', '--request-id', '210'], 'request_reference_required'], [['--once', '--request-reference', 'REQ-1210'], 'request_id_required'],
    [['--once', '--request-id', '208', '--request-reference', 'REQ-1208'], 'target_not_allowed'], [['--once', '--request-id', '207', '--request-reference', 'REQ-1207'], 'target_not_allowed'],
    [['--once', '--request-id', '211', '--request-reference', 'REQ-1211'], 'target_not_allowed'], [['--once', '--request-id', '210', '--request-reference', 'REQ-1208'], 'target_not_allowed'],
    [['--once', '--request-id', '208', '--request-reference', 'REQ-1210'], 'target_not_allowed'], [['--once', '--request-id', '0210', '--request-reference', 'REQ-1210'], 'target_not_allowed'],
    [['--once', '--request-id', '210', '--request-reference', 'req-1210'], 'target_not_allowed'],
    [[...ARGS, '--all'], 'unknown_argument'], [[...ARGS, '--request-id', '210'], 'argument_repeated'], [['--once', '--readiness-only', ...ARGS], 'mode_repeated_or_conflicting'],
    [['--request-id'], 'argument_value_missing'],
  ])('%j is refused (%s) before anything is read', async (argv, code) => {
    expect(await run(argv)).toBe(1);
    expect(out()).toContain(code);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
  });
});

describe('the environment: process-level actual profile, local humancare_dev, the designated E2E configuration', () => {
  test.each([
    [{ NODE_ENV: 'production' }, 'refused_in_production'], [{ NODE_ENV: 'test' }, 'node_env_test'],
    [{ DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }, 'database_not_humancare_dev'], [{ DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, 'database_host_not_local'],
    [{ DATABASE_URL: undefined }, 'database_url_invalid'],
    [{ BITRIX_DEAL_PROFILE: undefined }, 'bitrix_deal_profile_not_actual'], [{ BITRIX_DEAL_PROFILE: 'test' }, 'bitrix_deal_profile_not_actual'], [{ BITRIX_DEAL_PROFILE: 'ACTUAL' }, 'bitrix_deal_profile_not_actual'],
    [{ PRIVATE_CHARTER_REVIEW_WORKFLOW: 'false' }, 'review_workflow_not_true'],
    [{ PRIVATE_CHARTER_AUTO_APPROVE: undefined }, 'auto_approval_switch_off'], [{ PRIVATE_CHARTER_AUTO_APPROVE: 'TRUE' }, 'auto_approval_switch_off'],
    [{ PRIVATE_CHARTER_AUTO_APPROVE_FROM: undefined }, 'start_time_missing_or_invalid'], [{ PRIVATE_CHARTER_AUTO_APPROVE_FROM: 'soon' }, 'start_time_missing_or_invalid'],
    [{ PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: undefined }, 'unverified_content_not_accepted'], [{ PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE: 'false' }, 'unverified_content_not_accepted'],
    [{ PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: undefined }, 'e2e_mobiles_missing'], [{ PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES: 'not-a-number' }, 'e2e_mobiles_invalid'],
  ])('%j is refused (%s) in both modes and nothing runs', async (patch, code) => {
    for (const argv of [ARGS, ['--once', ...ARGS]]) {
      log.error.mockClear();
      expect(await run(argv, { env: { ...ENV, ...patch } })).toBe(1);
      expect(out()).toContain(code);
    }
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
  });
  test('the database SERVER must answer humancare_dev, not only the URL', async () => {
    databaseName = 'humancare_test';
    await refusedWith('database_not_humancare_dev', { once: true });
    expect(prisma.serviceRequest.findUnique).not.toHaveBeenCalled();
  });
  test('the cutoff must not be later than the request', async () => {
    await refusedWith('request_before_cutoff', { once: true, env: { ...ENV, PRIVATE_CHARTER_AUTO_APPROVE_FROM: '2026-11-24T00:00:00Z' } });
  });
});

describe('the request, the identity and the documents', () => {
  test.each([
    [() => { state.requests[0] = undefined; state.requests = state.requests.filter(Boolean); }, 'request_not_found'],
    [() => { state.requests[0] = makeRequest({ referenceNumber: 'REQ-1211' }); }, 'request_reference_mismatch'],
    [() => { state.requests[0] = makeRequest({ serviceKey: 'ground' }); }, 'not_private_charter'],
    [() => { state.requests[0] = makeRequest({ patientName: 'Asha Rao' }); }, 'patient_not_e2e_named'],
    [() => { state.requests[0] = makeRequest({ patientName: 'ZZ-SYNTHETIC Asha' }); }, 'patient_not_e2e_named'],
    [() => { state.requests[0] = makeRequest({ reviewStatus: 'approved' }); }, 'request_not_in_review'],
    [() => { state.requests[0] = makeRequest({ reviewStatus: 'awaiting_documents' }); }, 'request_not_in_review'],
    [() => { state.ownerMobile = '+919999900099'; }, 'owner_mobile_not_allowlisted'],
    [() => { state.ownerMobile = undefined; }, 'owner_mobile_not_allowlisted'],
    [() => { state.cases.push({ id: 208, serviceRequestId: 210, status: 'submitted' }); }, 'held_case_exists'],
    [() => { state.requests[0] = makeRequest({ bitrixLeadId: 99 }); }, 'held_has_bitrix_lead'],
    [() => { state.requests[0] = makeRequest({ documentsRequestReason: 'more' }); }, 'held_documents_requested'],
    [() => { state.requests[0] = makeRequest({ patientAge: null }); }, 'held_incomplete_form'],
    [() => { state.events.push({ action: 'documents_requested' }); }, 'held_review_history_requires_a_person'],
    [() => { state.documents = []; }, 'held_no_documents'],
    [() => { state.documents = [makeDoc({ scanStatus: 'pending' })]; }, 'held_document_scan_pending'],
    [() => { state.documents = [makeDoc({ scanStatus: 'infected' })]; }, 'held_document_scan_infected'],
    [() => { state.documents = [makeDoc({ scanStatus: 'error' })]; }, 'held_document_scan_error'],
    [() => { state.documents = [makeDoc({ reviewStatus: 'rejected' })]; }, 'held_document_rejected'],
    [() => { state.documents = [makeDoc({ mimeType: 'application/msword' })]; }, 'held_document_type_not_allowed'],
    [() => { state.documents = [makeDoc({ sha256: null })]; }, 'held_document_checksum_missing'],
    [() => { state.documents = [makeDoc(), makeDoc({ id: 210 })]; }, 'held_duplicate_document_content'],
  ])('arrangement %#: refused with %s, in readiness and --once, and nothing is approved', async (arrange, code) => {
    arrange();
    for (const argv of [ARGS, ['--once', ...ARGS]]) {
      log.error.mockClear();
      expect(await run(argv)).toBe(1);
      expect(out()).toContain(code);
    }
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
  });
  test('the stored file must be readable, structurally valid and the patient\'s own fixture', async () => {
    deps.readFile.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ENOENT' }));
    await refusedWith('document_document_unreadable', { once: true });
    deps.validateStructure.mockResolvedValueOnce({ code: 'encrypted' });
    await refusedWith('document_document_structure_invalid', { once: true });
    deps.verifyFixture.mockResolvedValueOnce({ verified: false, code: 'field_mismatch' });
    await refusedWith('document_fixture_not_verified', { once: true });
    deps.verifyFixture.mockResolvedValueOnce(null);
    await refusedWith('document_fixture_not_verified', { once: true });
    deps.readFile.mockResolvedValueOnce(Buffer.from('not a pdf at all, just text'));
    await refusedWith('document_document_type_unverifiable', { once: true });
  });
});

describe('readiness (the default)', () => {
  test('verifies everything, reports the planned writes and writes nothing', async () => {
    expect(await run()).toBe(0);
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
    expect(deps.verifyFixture).toHaveBeenCalledTimes(1);
    expect(out()).toMatch(/READY \(readiness only: nothing was written\)/);
    expect(out()).toContain('one pending bitrix.deal.create outbox event (profile actual)');
    expect(state.requests[0].reviewStatus).toBe('in_review');
    expect(state.cases).toHaveLength(1);
  });
  test('--readiness-only is the same', async () => {
    expect(await run(['--readiness-only', ...ARGS])).toBe(0);
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
  });
});

describe('--once', () => {
  test('calls the existing approval ONCE for request 210, then verifies one Case, one actual link, one pending actual event and nothing else changed', async () => {
    expect(await run(['--once', ...ARGS])).toBe(0);
    expect(deps.autoApprovalFn).toHaveBeenCalledTimes(1);
    expect(deps.autoApprovalFn).toHaveBeenCalledWith(210);
    expect(out()).toContain('APPROVED');
    expect(out()).toContain('"caseId":208');
    expect(out()).toContain('"outboxEventId":53');
    expect(out()).toMatch(/Exactly one Case, one actual-profile Deal link and one pending Deal-creation event/);
    expect(state.outbox.filter((o) => [1, 2, 52].includes(o.id)).every((o) => o.status === 'pending' && o.attempts === 0)).toBe(true);
  });
  test('a second run is refused before the engine is called: the Case already exists, so no duplicate Case or event can be made', async () => {
    expect(await run(['--once', ...ARGS])).toBe(0);
    deps.autoApprovalFn.mockClear();
    expect(await run(['--once', ...ARGS])).toBe(1);
    expect(deps.autoApprovalFn).not.toHaveBeenCalled();
    expect(state.cases.filter((c) => c.serviceRequestId === 210)).toHaveLength(1);
    expect(state.outbox.filter((o) => o.caseId === 208)).toHaveLength(1);
  });
  test('the engine reporting already_approved still goes through the same read-back', async () => {
    deps.autoApprovalFn.mockImplementationOnce(async (id) => { approve(id); return { outcome: 'already_approved' }; });
    expect(await run(['--once', ...ARGS])).toBe(0);
    expect(out()).toContain('ALREADY APPROVED');
  });
  test.each([['held', 'e2e_document_content_unverified'], ['disabled', undefined], ['error', 'P2002'], ['bad_request_id', undefined]])('an engine outcome of %s leaves the request as it was (exit 1)', async (outcome, code) => {
    deps.autoApprovalFn.mockResolvedValueOnce({ outcome, ...(code && { code }) });
    expect(await run(['--once', ...ARGS])).toBe(1);
    expect(out()).toContain(`not approved: ${outcome}`);
    expect(state.requests[0].reviewStatus).toBe('in_review');
  });
  test('the engine throwing is a short code only (exit 2), never its message', async () => {
    deps.autoApprovalFn.mockRejectedValueOnce(Object.assign(new Error('Access denied mysql://u:hunter2@localhost'), { code: 'P1001' }));
    expect(await run(['--once', ...ARGS])).toBe(2);
    expect(out()).toContain('P1001');
    expect(out()).not.toMatch(/hunter2|Access denied|mysql:/);
  });
  test.each([
    ['a link stamped for another profile', { profile: 'test' }, 'deal_link_not_actual_or_has_deal'],
    ['a link stamped for no profile', { profile: null }, 'deal_link_not_actual_or_has_deal'],
    ['two Cases', { cases: 2 }, 'case_count_not_one'],
    ['two links', { links: 2 }, 'deal_link_count_not_one'],
    ['two Deal events', { events: 2 }, 'deal_event_count_not_one'],
    ['no Deal event', { events: 0 }, 'deal_event_count_not_one'],
    ['no link', { links: 0 }, 'deal_link_count_not_one'],
    ['another event changing', { touchOthers: true }, 'other_records_changed'],
  ])('verification fails for %s (exit 2, with an alert)', async (_name, options, code) => {
    deps.autoApprovalFn.mockImplementationOnce(async (id) => approve(id, options));
    expect(await run(['--once', ...ARGS])).toBe(2);
    expect(out()).toContain('ALERT: approved, but verification failed');
    expect(out()).toContain(code);
  });
  test('an event whose payload is not stamped actual, or is not pending, fails verification', async () => {
    deps.autoApprovalFn.mockImplementationOnce(async (id) => { approve(id); state.outbox.find((o) => o.id === 53).payload = { caseId: 208 }; return { outcome: 'approved' }; });
    expect(await run(['--once', ...ARGS])).toBe(2);
    expect(out()).toContain('deal_event_not_actual');
    log.error.mockClear();
    deps.autoApprovalFn.mockImplementationOnce(async (id) => { approve(id); state.outbox.find((o) => o.id === 53).status = 'processing'; return { outcome: 'approved' }; });
    state.requests[0].reviewStatus = 'in_review'; state.cases = state.cases.filter((c) => c.serviceRequestId !== 210); state.outbox = state.outbox.filter((o) => o.caseId !== 208); state.links = state.links.filter((l) => l.caseId !== 208);
    expect(await run(['--once', ...ARGS])).toBe(2);
    expect(out()).toContain('deal_event_not_pending');
  });
});

describe('isolation: no Bitrix, no worker, no approval logic of its own', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
  const code = (rel) => read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const FILE = 'src/request-auto-approve-worker.js';
  test('it never requires the job list, the general worker, a timer, a Bitrix client or a payment module', () => {
    for (const forbidden of [/jobs[\\/]index/, /require\(['"]\.\/worker['"]\)/, /job-runner/, /setInterval/, /setTimeout/, /bitrix-deal\.api|bitrix\.service|getDeal|createDeal|fetch\(/, /razorpay|payment|invoice|quotation/i]) {
      expect({ hit: forbidden.test(code(FILE)) }).toEqual({ hit: false });
    }
  });
  test('it contains no approval, review or case-creation call of its own: only the existing autoApproveIfEligible', () => {
    const text = code(FILE);
    expect(text).toMatch(/autoApproveIfEligible/);
    expect(text).not.toMatch(/approveRequest\(|reviewDocument\(|createCaseForRequest|ensureDealCreation|\.create\(|\.update\(\{|updateMany|\$executeRaw|\$transaction/);
  });
  test('dotenv is read only inside main(), and requiring the file starts nothing', () => {
    const text = code(FILE);
    expect(text.split('async function main')[0]).not.toMatch(/dotenv/);
    expect(text).toMatch(/async function main[\s\S]*dotenv/);
    expect(text).toMatch(/if \(require\.main === module\)/);
    const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    expect(loaded.filter((k) => /\/src\/jobs\//.test(k))).toEqual([]);
    expect(loaded.filter((k) => /\/src\/worker\.js$/.test(k))).toEqual([]);
  });
  test('the target is fixed to request 210 / REQ-1210', () => {
    expect(runner.TARGET).toEqual({ requestId: 210, requestReference: 'REQ-1210' });
    expect(Object.isFrozen(runner.TARGET)).toBe(true);
  });
});
