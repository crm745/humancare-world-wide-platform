/* global describe, test, expect, jest, beforeEach */
// scripts/synthetic-mark.js: the operator-only command that creates a signed marker. Fake Prisma; nothing is executed against a database.
const fs = require('fs');
const path = require('path');
const { run, parseArgs, describe: describeResult } = require('../../scripts/synthetic-mark');
const marker = require('../../src/common/safety/synthetic-e2e-marker');
const { ACTION } = marker;

const SECRET = 'k'.repeat(40);
const NOW = Date.parse('2026-11-20T12:00:00Z');
const ENV = { ALLOW_SYNTHETIC_MARKING: 'true', SYNTHETIC_E2E_SECRET: SECRET, DATABASE_URL: 'mysql://user:pw@localhost:3306/humancare_dev' };
const ARGV = ['61', '--owner-id', '7', '--admin-id', '3', '--run-id', 'run-1', '--documents', '2'];

let s;
let prisma;
function setUp(over = {}) {
  s = {
    db: 'humancare_dev',
    request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'awaiting_documents', patientName: 'ZZ-SYNTHETIC Jane', createdAt: new Date(NOW - 3600000), bitrixLeadId: null },
    owned: 1, caseRecord: { id: 5 }, link: null, outbox: 0, admin: { id: 3 }, events: [],
    ...over,
  };
  prisma = {
    $queryRaw: jest.fn(async (strings) => (strings.join('?').includes('DATABASE()') ? (s.db instanceof Error ? Promise.reject(s.db) : [{ db: s.db }]) : [])),
    $transaction: jest.fn((fn) => fn(prisma)),
    serviceRequest: { findUnique: jest.fn(async () => s.request), count: jest.fn(async () => s.owned) },
    case: { findUnique: jest.fn(async () => s.caseRecord) },
    bitrixDealLink: { findUnique: jest.fn(async () => s.link) },
    integrationOutbox: { count: jest.fn(async () => s.outbox) },
    adminUser: { findUnique: jest.fn(async () => s.admin) },
    requestEvent: { findMany: jest.fn(async () => s.events), create: jest.fn(async ({ data }) => data) },
  };
}
const go = (argv = ARGV, env = ENV) => run({ argv, env, prisma, now: () => NOW });
beforeEach(() => setUp());

describe('marking', () => {
  test('writes ONE signed, append-only marker event that verifies, with the operator as actor and a 24-hour expiry', async () => {
    expect(await go()).toEqual({ ok: true, exitCode: 0, requestId: 61, outcome: 'marked' });
    expect(prisma.requestEvent.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.requestEvent.create.mock.calls[0][0];
    expect(data).toMatchObject({ serviceRequestId: 61, action: ACTION.MARKED, actorType: 'admin', actorId: 3 });
    const mark = marker.verifyMark({ id: 1, ...data }, { secret: SECRET, requestId: 61 });
    expect(mark).toMatchObject({ ownerUserId: 7, adminId: 3, expectedDocuments: 2, runId: 'run-1' });
    expect(mark.expiresMs - NOW).toBe(24 * 3600 * 1000);
    expect(prisma.requestEvent.create.mock.calls[0][0]).not.toHaveProperty('where');
  });
  test('the printed output holds only the request id and the outcome', async () => {
    const text = describeResult(await go());
    expect(text).toBe('synthetic request 61: marked');
    expect(text).not.toMatch(/Jane|pw|mysql|k{10}/);
  });
  test('a request already in review (documents uploaded) can be marked', async () => {
    setUp({ request: { ...s.request, reviewStatus: 'in_review' } });
    expect((await go()).ok).toBe(true);
  });
});

describe('refusals (nothing is written)', () => {
  test.each([
    ['no opt-in', () => go(undefined, { ...ENV, ALLOW_SYNTHETIC_MARKING: undefined }), 'opt_in_missing'],
    ['production', () => go(undefined, { ...ENV, NODE_ENV: 'production' }), 'production_refused'],
    ['no secret', () => go(undefined, { ...ENV, SYNTHETIC_E2E_SECRET: undefined }), 'secret_missing'],
    ['a short secret', () => go(undefined, { ...ENV, SYNTHETIC_E2E_SECRET: 'short' }), 'secret_missing'],
    ['no request id', () => go(['--owner-id', '7', '--admin-id', '3', '--run-id', 'run-1', '--documents', '2']), 'request_id_required'],
    ['two request ids', () => go(['61', '62', ...ARGV.slice(1)]), 'request_id_required'],
    ['no owner id', () => go(['61', '--admin-id', '3', '--run-id', 'run-1', '--documents', '2']), 'owner_id_required'],
    ['no admin id', () => go(['61', '--owner-id', '7', '--run-id', 'run-1', '--documents', '2']), 'admin_id_required'],
    ['a bad run id', () => go(['61', '--owner-id', '7', '--admin-id', '3', '--run-id', 'a b', '--documents', '2']), 'run_id_required'],
    ['0 documents', () => go(['61', '--owner-id', '7', '--admin-id', '3', '--run-id', 'run-1', '--documents', '0']), 'documents_must_be_1_to_5'],
    ['6 documents', () => go(['61', '--owner-id', '7', '--admin-id', '3', '--run-id', 'run-1', '--documents', '6']), 'documents_must_be_1_to_5'],
    ['an unknown option', () => go([...ARGV, '--force']), 'unknown_option'],
    ['humancare_test in the URL', () => go(undefined, { ...ENV, DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' }), 'database_not_identified'],
    ['a remote database URL', () => go(undefined, { ...ENV, DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }), 'database_not_identified'],
  ])('%s', async (_name, call, code) => {
    expect(await call()).toMatchObject({ ok: false, exitCode: 2, code });
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
    expect(prisma.serviceRequest.findUnique).not.toHaveBeenCalled();
  });
  test('the server reporting another database, or failing to answer', async () => {
    setUp({ db: 'humancare_test' });
    expect(await go()).toMatchObject({ code: 'database_not_identified' });
    setUp({ db: new Error('down') });
    expect(await go()).toMatchObject({ code: 'database_not_identified' });
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });
  test.each([
    ['a missing request', { request: null }, 'request_not_found'],
    ['another service', { request: { id: 61, userId: 7, serviceKey: 'commercialcharter', reviewStatus: 'awaiting_documents', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW) } }, 'not_private_charter'],
    ['an approved request', { request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'approved', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW) } }, 'already_approved'],
    ['changes requested', { request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'changes_requested', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW) } }, 'not_pending_review'],
    ['a request older than 6 hours', { request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'in_review', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW - 7 * 3600000) } }, 'request_too_old'],
    ['a different owner id than the request\'s account', { request: { id: 61, userId: 8, serviceKey: 'privatecharter', reviewStatus: 'in_review', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW) } }, 'owner_mismatch'],
    ['a real patient name', { request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'in_review', patientName: 'Jane Doe', createdAt: new Date(NOW) } }, 'not_synthetic_name'],
    ['an owner with other requests', { owned: 2 }, 'owner_has_other_requests'],
    ['a Bitrix lead', { request: { id: 61, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'in_review', patientName: 'ZZ-SYNTHETIC', createdAt: new Date(NOW), bitrixLeadId: 12 } }, 'has_bitrix_footprint'],
    ['a Deal link', { link: { id: 1 } }, 'has_bitrix_footprint'],
    ['an outbox event', { outbox: 1 }, 'has_bitrix_footprint'],
    ['an unknown admin', { admin: null }, 'admin_not_found'],
  ])('%s', async (_name, over, code) => {
    setUp(over);
    expect(await go()).toMatchObject({ ok: false, exitCode: 2, code });
    expect(prisma.requestEvent.create).not.toHaveBeenCalled();
  });
  test('a request that is already marked (in any state) is refused', async () => {
    setUp({ events: [{ id: 1, serviceRequestId: 61, action: ACTION.MARKED, detail: {} }] });
    expect(await go()).toMatchObject({ code: 'already_marked' });
  });
  test('at most 3 markers may be active at once; finished ones do not count', async () => {
    const active = (id, extra = []) => {
      const detail = marker.buildMark({ secret: SECRET, requestId: id, ownerUserId: 100 + id, adminId: 3, expectedDocuments: 1, runId: 'run-x', now: NOW });
      return [{ id: id * 10, serviceRequestId: id, action: ACTION.MARKED, detail, occurredAt: new Date(NOW) }, ...extra.map((a, i) => ({ id: id * 10 + 1 + i, serviceRequestId: id, action: a, detail: { markSig: detail.sig }, occurredAt: new Date(NOW) }))];
    };
    setUp({ events: [...active(11), ...active(12), ...active(13)] });
    expect(await go()).toMatchObject({ code: 'too_many_active_marks' });
    setUp({ events: [...active(11), ...active(12), ...active(13, [ACTION.CONSUMED])] });
    expect((await go()).ok).toBe(true);
  });
});

test('structure: operator-only, no approval, no Bitrix, no server import', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/synthetic-mark.js'), 'utf8');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  expect(code).not.toMatch(/approveRequest|reviewDocument|bitrix\.service|razorpay|payment|notification|\.env\.test/);
  expect(parseArgs(ARGV)).toEqual({ requestId: 61, ownerId: 7, adminId: 3, runId: 'run-1', documents: 2 });
});
