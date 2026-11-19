/* global describe, test, expect, jest, beforeEach */
// The test-only single-Deal Bitrix reconciliation (scripts/lib/single-deal-reconcile.js, scripts/e2e-reconcile-single-deal.js) and the `scope` option of
// reconcileDeals. No database, no network, no process started: Prisma and the Bitrix client are fakes.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const path = require('path');
const lib = require('../../scripts/lib/single-deal-reconcile');
const { reconcileDeals } = require('../../src/modules/bitrix/deal-reconcile.service');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\/.*$/gm, '');
const refusalOf = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };
const argsRefusal = (...a) => { try { lib.parseArgs(a); } catch (e) { return e.code; } return null; };

const ENV_ON = { BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const REF_FIELD = 'UF_CRM_1794548440549';

describe('arguments', () => {
  test('the default is a dry run; --execute needs the exact stage id stated by a person', () => {
    expect(lib.parseArgs([])).toEqual({ expectStage: null, push: true, execute: false });
    expect(argsRefusal('--execute')).toBe('expect_stage_required');
    expect(lib.parseArgs(['--execute', '--expect-stage', 'C38:EXECUTING', '--no-push'])).toEqual({ expectStage: 'C38:EXECUTING', push: false, execute: true });
  });
  test.each([
    [['--expect-stage', 'In Progress'], 'expect_stage_invalid'], // a display name is never accepted as a stage id
    [['--expect-stage', 'C12:NEW'], 'expect_stage_invalid'], // only Category 38
    [['--expect-stage'], 'missing_value_for_--expect-stage'],
    [['--deal-id', '21803'], 'target_not_allowed'],
    [['--case-id', '3038'], 'target_not_allowed'],
    [['--case-reference', 'CASE-4038'], 'target_not_allowed'],
    [['--all'], 'unknown_argument'],
    [['--limit', '10'], 'unknown_argument'],
  ])('refuses %j with %s', (a, expected) => { expect(argsRefusal(...a)).toBe(expected); });
  test('the target options are accepted only when they name the one allowed Deal', () => {
    expect(lib.TARGET).toEqual({ dealId: '21802', caseId: 3037, caseReference: 'CASE-4037', categoryId: '38' });
    expect(() => lib.parseArgs(['--deal-id', '21802', '--case-id', '3037', '--case-reference', 'CASE-4037'])).not.toThrow();
  });
});

// ---- the orchestration ------------------------------------------------------------------------------------------------------------------------------
const linkRow = (over = {}) => ({
  id: 1173, caseId: 3037, bitrixDealId: '21802', categoryId: '38', stageId: 'C38:NEW', externalModifiedAt: null,
  case: { id: 3037, referenceNumber: 'CASE-4037', status: 'submitted', charterStage: 'patient_details', stageVersion: 0, serviceRequest: { serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null } },
  ...over,
});
const dealBody = (over = {}) => ({ ID: '21802', CATEGORY_ID: '38', STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-05T10:00:00+00:00', [REF_FIELD]: 'CASE-4037', ...over });

let link; let deal; let api; let prisma; let reconcile; let runInbox; let calls; let othersDigest;
const deps = (extra = {}) => ({ prisma, api, env: ENV_ON, log: { warn: jest.fn(), error: jest.fn() }, reconcile, runInbox, store: { findDueIds: jest.fn(async () => [11, 12, 13]) }, ...extra });

beforeEach(() => {
  link = linkRow(); deal = dealBody(); calls = []; othersDigest = [{ id: 5, status: 'received', attempts: 0 }];
  api = { getDeal: jest.fn(async () => ({ status: 'ok', deal })) };
  prisma = {
    bitrixDealLink: { findUnique: jest.fn(async () => link), findMany: jest.fn(async () => []) },
    integrationInbox: { findMany: jest.fn(async ({ where }) => (where.OR ? othersDigest : [{ id: 12 }])) },
  };
  reconcile = jest.fn(async () => { calls.push('reconcile'); return { active: true, checked: 1, queued: 1 }; });
  runInbox = jest.fn(async () => { calls.push('inbox'); return { active: true, claimed: 1 }; });
});

describe('verification before anything is applied', () => {
  test('a dry run reads Bitrix once, reports the EXACT stage id and the mapping, and writes nothing (no reconcile, no inbox)', async () => {
    const out = await lib.runSingleDeal({ execute: false, expectStage: null, push: true }, deps());
    expect(out.executed).toBe(false);
    expect(out.facts.deal).toEqual({ id: '21802', categoryId: '38', stageId: 'C38:EXECUTING', modifiedAt: '2030-01-05T10:00:00.000Z' });
    expect(out.facts.mapping).toEqual({ approved: true, charterStage: 'in_progress', caseStatus: 'in_progress', patientVisible: true });
    expect(out.facts.case).toMatchObject({ id: 3037, reference: 'CASE-4037', status: 'submitted', charterStage: 'patient_details' });
    expect(api.getDeal).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(runInbox).not.toHaveBeenCalled();
  });
  test.each([
    ['no link for the Deal', () => { link = null; }, 'deal_not_linked'],
    ['linked to another Case', () => { link.caseId = 3038; }, 'link_case_mismatch'],
    ['the Case reference differs', () => { link.case.referenceNumber = 'CASE-4038'; }, 'case_reference_mismatch'],
    ['the link is not Category 38', () => { link.categoryId = '12'; }, 'link_category_mismatch'],
    ['not a Private Charter Case', () => { link.case.serviceRequest.serviceKey = 'ground'; }, 'case_not_private_charter'],
    ['the Case is closed', () => { link.case.status = 'completed'; }, 'case_closed'],
    ['the Deal answered with another id', () => { deal.ID = '21803'; }, 'deal_id_mismatch'],
    ['the Deal is not Category 38', () => { deal.CATEGORY_ID = '12'; }, 'deal_category_mismatch'],
    ['the Deal names another Case', () => { deal[REF_FIELD] = 'CASE-4038'; }, 'deal_reference_mismatch'],
    ['the modified time is missing', () => { delete deal.DATE_MODIFY; }, 'deal_modified_time_invalid'],
  ])('refuses when %s, before anything else (even in execute mode)', async (_name, mutate, expected) => {
    mutate();
    expect(await refusalOf(() => lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps()))).toBe(expected);
    expect(reconcile).not.toHaveBeenCalled();
    expect(runInbox).not.toHaveBeenCalled();
  });
  test.each([['not_found', 'deal_not_found_in_bitrix'], ['uncertain', 'bitrix_read_failed_uncertain']])('a Bitrix %s answer refuses and applies nothing', async (status, expected) => {
    api.getDeal = jest.fn(async () => ({ status }));
    expect(await refusalOf(() => lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps()))).toBe(expected);
    expect(reconcile).not.toHaveBeenCalled();
  });
  test('execute refuses when the live stage id is not exactly the one the operator confirmed', async () => {
    expect(await refusalOf(() => lib.runSingleDeal({ execute: true, expectStage: 'C38:FINAL_INVOICE', push: true }, deps()))).toBe('expect_stage_mismatch');
    expect(reconcile).not.toHaveBeenCalled();
  });
  test.each([['C38:UC_1PK4XX', 'obsolete_stage'], ['C38:SOMETHING_NEW', 'unknown_stage'], ['C38:LOSE', 'lost_reason_missing']])('an unapproved stage %s is reported and --execute refuses', async (stage, codeName) => {
    deal.STAGE_ID = stage;
    const dry = await lib.runSingleDeal({ execute: false }, deps());
    expect(dry.facts.mapping).toEqual({ approved: false, quarantineCode: codeName });
    expect(await refusalOf(() => lib.runSingleDeal({ execute: true, expectStage: stage, push: true }, deps()))).toBe(`stage_not_approved_${codeName}`);
    expect(reconcile).not.toHaveBeenCalled();
  });
  test('a Deal HumanCare already applied is "nothing to apply": no queue, no processing', async () => {
    link.stageId = 'C38:EXECUTING'; link.externalModifiedAt = new Date('2030-01-05T10:00:00Z');
    const out = await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps());
    expect(out).toMatchObject({ executed: false, nothingToApply: true });
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('what is applied, and how narrowly', () => {
  test('execute: reconcile (scoped to the Deal) then the inbox pass, both with the PINNED snapshot as the only Bitrix client', async () => {
    const out = await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps());
    expect(calls).toEqual(['reconcile', 'inbox']);
    expect(out).toMatchObject({ executed: true, reconciled: { queued: 1 }, processed: { claimed: 1 }, othersUnchanged: true });
    const recArgs = reconcile.mock.calls[0][0];
    expect(recArgs.scope).toEqual({ dealId: '21802', ignoreRecheck: true });
    for (const a of [recArgs, runInbox.mock.calls[0][0]]) {
      expect(await a.api.getDeal('21802')).toEqual({ status: 'ok', deal });
      expect(await a.api.getDeal('21803')).toEqual({ status: 'uncertain', reason: 'out_of_scope' }); // no other Deal can be read
      expect(Object.keys(a.api)).toEqual(['getDeal']); // and nothing else can be called
    }
    expect(api.getDeal).toHaveBeenCalledTimes(1); // Bitrix was contacted exactly once, whatever happens later
  });
  test('the pinned snapshot is what is applied even if the Deal is moved again after the verification', async () => {
    runInbox = jest.fn(async (o) => { deal.STAGE_ID = 'C38:WON'; return { seen: (await o.api.getDeal('21802')).deal.STAGE_ID }; });
    const out = await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps());
    expect(out.processed.seen).toBe('C38:EXECUTING');
  });
  test('the inbox pass gets a store that sees ONLY this Deal\'s pending rows and cannot recover leases of others', async () => {
    const base = { findDueIds: jest.fn(async () => [11, 12, 13]), claim: jest.fn(), recoverExpiredLeases: jest.fn(async () => ({ failed: 9, again: 9 })) };
    await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps({ store: base }));
    const store = runInbox.mock.calls[0][0].store;
    expect(await store.findDueIds(prisma, 10)).toEqual([12]); // 11 and 13 are other Deals' rows: never offered
    expect(prisma.integrationInbox.findMany).toHaveBeenCalledWith({ where: { source: 'bitrix24', entityId: '21802', status: 'received' }, select: { id: true } });
    expect(await store.recoverExpiredLeases(prisma, { maxAttempts: 8 })).toEqual({ failed: 0, again: 0 });
    expect(base.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(store.claim).toBe(base.claim);
  });
  test('--no-push replaces only the push; the notification row is the processor\'s, unchanged', async () => {
    await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: false }, deps());
    const pushed = await runInbox.mock.calls[0][0].push('token', { title: 't', body: 'b' });
    expect(pushed).toBeUndefined();
    await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps());
    expect('push' in runInbox.mock.calls[1][0]).toBe(false); // default: the processor's own best-effort push
  });
  test('it reports when something else changed (other inbox rows or links): othersUnchanged false', async () => {
    runInbox = jest.fn(async () => { othersDigest = [{ id: 5, status: 'processing', attempts: 1 }]; return { claimed: 1 }; });
    const out = await lib.runSingleDeal({ execute: true, expectStage: 'C38:EXECUTING', push: true }, deps());
    expect(out.othersUnchanged).toBe(false);
  });
});

describe('reconcileDeals with a scope', () => {
  const NOW = Date.UTC(2030, 0, 10, 12, 0, 0);
  const mkLink = (n, over = {}) => ({
    id: n, caseId: 100 + n, bitrixDealId: String(5000 + n), stageId: 'C38:NEW', externalModifiedAt: null, lastAttemptAt: new Date(NOW - 60000),
    case: { id: 100 + n, referenceNumber: `HC-PC-${n}`, serviceRequestId: n, serviceRequest: { id: n, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null } }, ...over,
  });
  test('the query is narrowed to the one Deal (one row, no 15-minute window with ignoreRecheck); every other filter stays', async () => {
    const p = { bitrixDealLink: { findMany: jest.fn(async () => []), update: jest.fn() }, integrationInbox: { create: jest.fn() } };
    await reconcileDeals({ prisma: p, api: { getDeal: jest.fn() }, env: ENV_ON, log: console, now: () => NOW, scope: { dealId: '21802', ignoreRecheck: true } });
    const q = p.bitrixDealLink.findMany.mock.calls[0][0];
    expect(q.where.bitrixDealId).toBe('21802');
    expect(q.where.OR).toBeUndefined();
    expect(q.where.case.is.status).toEqual({ notIn: ['completed', 'cancelled'] });
    expect(q.take).toBe(1);
    await reconcileDeals({ prisma: p, api: { getDeal: jest.fn() }, env: ENV_ON, log: console, now: () => NOW, scope: { dealId: '21802' } });
    expect(p.bitrixDealLink.findMany.mock.calls[1][0].where.OR).toBeDefined(); // without ignoreRecheck the window applies
  });
  test('a malformed scope matches nothing: no query, no read', async () => {
    const p = { bitrixDealLink: { findMany: jest.fn(), update: jest.fn() }, integrationInbox: { create: jest.fn() } };
    const a = { getDeal: jest.fn() };
    for (const dealId of ['', 'abc', '0', undefined, '21802 OR 1=1']) {
      expect(await reconcileDeals({ prisma: p, api: a, env: ENV_ON, log: console, now: () => NOW, scope: { dealId } })).toEqual({ active: true, checked: 0, queued: 0 });
    }
    expect(p.bitrixDealLink.findMany).not.toHaveBeenCalled();
    expect(a.getDeal).not.toHaveBeenCalled();
  });
  test('a scoped pass queues ONE event for that Deal only and stays idle while the Bitrix switches are off', async () => {
    const l = mkLink(1, { bitrixDealId: '21802' });
    const created = [];
    const p = { bitrixDealLink: { findMany: jest.fn(async () => [l]), update: jest.fn(async () => ({})) }, integrationInbox: { create: jest.fn(async ({ data }) => { created.push(data); }) } };
    const a = { getDeal: jest.fn(async () => ({ status: 'ok', deal: { ID: '21802', CATEGORY_ID: '38', STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-05T10:00:00+00:00', [REF_FIELD]: l.case.referenceNumber } })) };
    expect(await reconcileDeals({ prisma: p, api: a, env: ENV_ON, log: console, now: () => NOW, scope: { dealId: '21802', ignoreRecheck: true } })).toEqual({ active: true, checked: 1, queued: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityId: '21802', eventType: 'ONCRMDEALUPDATE', status: 'received' });
    expect(await reconcileDeals({ prisma: p, api: a, env: {}, log: console, scope: { dealId: '21802' } })).toEqual({ active: false, checked: 0, queued: 0 });
  });
});

describe('static guarantees', () => {
  test('the library and the script never touch Razorpay, a job runner, a webhook registration or the other Bitrix write calls', () => {
    for (const file of ['scripts/lib/single-deal-reconcile.js', 'scripts/e2e-reconcile-single-deal.js']) {
      const text = code(file);
      expect(text).not.toMatch(/razorpay|createJobRunner|jobs\/index|event\.bind|event\.get|tunnel|ngrok|createDeal|updateDealFiles|crm\.deal\.update|fetch\(/i);
    }
  });
  test('the script uses the existing database identity guards, forces quotation sync off and never writes an env file', () => {
    const text = code('scripts/e2e-reconcile-single-deal.js');
    expect(text).toMatch(/assertTestDatabaseUrl/);
    expect(text).toMatch(/verifyLiveIdentity/);
    expect(text).toMatch(/buildIsolatedEnv/);
    expect(text).toMatch(/BITRIX_QUOTATION_SYNC_ENABLED = 'false'/);
    expect(text).not.toMatch(/writeFile|appendFile|\.env\.test'\s*,\s*['"]w/);
  });
  test('the scheduled reconcile job does not pass a scope (its behaviour is unchanged)', () => {
    expect(code('src/jobs/bitrix-deal-reconcile.job.js')).not.toMatch(/scope/);
  });
});
