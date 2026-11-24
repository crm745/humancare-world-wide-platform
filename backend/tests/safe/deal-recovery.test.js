/* global describe, test, expect, jest, beforeEach */
// Deal failure alerts and safe manual recovery. No database, no network: Prisma is an in-memory fake whose
// transaction serialises callers (standing in for SELECT ... FOR UPDATE) and rolls back on a throw, and the
// Bitrix client is mocked.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { reportDealFailures, classifyFailure, ACTION_FAILED, ACTION_REVIEW } = require('../../src/modules/bitrix/deal-failure-alerts');
const { recoverDealEvent, RecoveryError, REASON_CODES } = require('../../src/modules/bitrix/deal-recovery.service');
const { dealRecoveryIdempotencyKey } = require('../../src/modules/bitrix/deal-outbox');
const { postDealRecovery } = require('../../src/modules/bitrix/deal-recovery.controller');

const REF = 'HC-PC-000123';
const ADMIN = { id: 9, role: 'superadmin' };

// ---- in-memory world ----------------------------------------------------------------------------------------------
let events; let audit; let link; let caseRow; let unique; let mutex;

const ev = (over = {}) => ({
  id: 1, event_type: 'bitrix.deal.create', case_id: 7, status: 'failed', last_error: 'mapping:care_level_not_single',
  external_call_started_at: null, locked_by: null, idempotency_key: 'bitrix.deal.create:case:7', ...over,
});
const goodCase = () => ({
  id: 7, referenceNumber: REF, serviceRequestId: 3, patientName: 'Asha Rao',
  serviceRequest: {
    id: 3, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null, patientName: 'Asha Rao', patientContact: '+971501234567',
    preferredDate: new Date('2030-03-05T00:00:00Z'), careLevel: 'care_icu', mobility: 'walking', equipCardiacMonitor: false, urgency: 'planned', patientGender: 'female',
  },
});

function makePrisma() {
  const text = (strings) => strings.join('?').replace(/\s+/g, ' ');
  const tx = {
    $queryRaw: jest.fn(async (strings, ...values) => {
      const sql = text(strings);
      if (sql.includes('WHERE id = ?')) return events.filter((e) => e.id === values[0]).map((e) => ({ ...e }));
      if (sql.includes('WHERE entity_type')) return events.map((e) => ({ ...e }));
      throw new Error(`unexpected query ${sql}`);
    }),
    $executeRaw: jest.fn(async (strings, ...values) => {
      const target = events.find((e) => e.id === values[0] && e.status === 'ambiguous' && e.locked_by == null);
      if (!target) return 0;
      target.status = 'completed';
      return 1;
    }),
    case: { findUnique: jest.fn(async () => (caseRow ? { ...caseRow, bitrixDealLink: link } : null)) },
    integrationOutbox: {
      create: jest.fn(async ({ data }) => {
        if (unique.has(data.idempotencyKey)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        unique.add(data.idempotencyKey);
        const row = ev({ id: 100 + events.length, status: data.status, last_error: null, idempotency_key: data.idempotencyKey, case_id: data.caseId });
        events.push(row);
        return { id: row.id };
      }),
    },
    bitrixDealLink: { update: jest.fn(async ({ data }) => { link = { ...link, ...data }; }) },
    auditLog: { create: jest.fn(async ({ data }) => { audit.push(data); }) },
  };
  return {
    tx,
    integrationOutbox: { findUnique: jest.fn(async ({ where }) => { const e = events.find((x) => x.id === where.id); return e ? { id: e.id, eventType: e.event_type, caseId: e.case_id } : null; }) },
    case: { findUnique: jest.fn(async () => (caseRow ? { referenceNumber: caseRow.referenceNumber } : null)) },
    // One transaction at a time (the row locks), and a throw undoes everything the transaction did.
    $transaction: jest.fn((callback) => {
      const run = async () => {
        const snap = { events: events.map((e) => ({ ...e })), audit: [...audit], link: { ...link }, unique: new Set(unique) };
        try { return await callback(tx); } catch (err) { ({ events, audit, link, unique } = snap); throw err; }
      };
      const result = mutex.then(run, run);
      mutex = result.catch(() => {});
      return result;
    }),
  };
}

let prisma; let api;
const recover = (over = {}) => recoverDealEvent({ prisma, api, env: { BITRIX_DEAL_PROFILE: 'test' }, actor: ADMIN, caseId: 7, eventId: 1, mode: 'requeue', reasonCode: 'data_corrected', ...over });
const code = (promise) => promise.then(() => null, (err) => (err instanceof RecoveryError ? `${err.status}:${err.code}` : err));

beforeEach(() => {
  events = [ev()]; audit = []; link = { id: 1, caseId: 7, bitrixDealId: null, syncStatus: 'error', lastError: 'mapping:care_level_not_single' };
  caseRow = goodCase(); unique = new Set(events.map((e) => e.idempotency_key)); mutex = Promise.resolve();
  prisma = makePrisma();
  api = { findDealsByReference: jest.fn(async () => ({ status: 'none', dealIds: [] })) };
});

// ---- alerts -------------------------------------------------------------------------------------------------------
describe('failure classification', () => {
  test.each([
    ['mapping:care_level_not_single', 'mapping:care_level_not_single'],
    ['mapping:gender_unknown', 'mapping:gender_unknown'],
    ['not_eligible: only Private Charter requests get a Deal', 'eligibility:not_eligible'],
    ['deal_link_missing', 'eligibility:deal_link_missing'],
    ['lease_expired_repeatedly_before_any_external_call', 'lease:lease_expired_repeatedly_before_any_external_call'],
    ['Bitrix24 Deal call: bitrix_error (HTTP 400 ERROR_CORE: Field is invalid)', 'bitrix:bitrix_error'],
    ['Bitrix24 Deal call: switch_off (a Bitrix switch is off)', 'bitrix:switch_off'],
    ['manual_review_required:multiple_matching_deals', 'review:multiple_matching_deals'],
    ['manual_review_required:no_match_after_waiting_period', 'review:no_match_after_waiting_period'],
    ['something odd', 'unknown:unclassified'],
    [null, 'unknown:unclassified'],
  ])('%p -> %s', (lastError, expected) => {
    const result = classifyFailure(lastError);
    expect(result.code).toBe(expected);
    expect(result.code).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });
});

describe('failure alerts', () => {
  let rows; let reported; let log; let alertDb;
  beforeEach(() => {
    rows = [
      { id: 5, caseId: 7, status: 'failed', lastError: 'mapping:care_level_not_single' },
      { id: 6, caseId: 8, status: 'ambiguous', lastError: 'manual_review_required:multiple_matching_deals' },
    ];
    reported = [];
    log = { error: jest.fn() };
    alertDb = {
      integrationOutbox: { findMany: jest.fn(async () => rows) },
      auditLog: {
        findMany: jest.fn(async () => reported.map((r) => ({ entityId: r.entityId, action: r.action }))),
        create: jest.fn(async ({ data }) => { reported.push(data); }),
      },
      case: { findMany: jest.fn(async () => [{ id: 7, referenceNumber: 'HC-PC-000007' }, { id: 8, referenceNumber: 'HC-PC-000008' }]) },
    };
  });

  test('a failed event and a manual-review event are alerted, with different actions and safe contents', async () => {
    expect(await reportDealFailures({ prisma: alertDb, log })).toBe(2);
    const [failed, review] = reported;
    expect(failed).toMatchObject({ action: ACTION_FAILED, entityType: 'integration_outbox', entityId: '5', caseId: 7, actorType: 'system', reasonCode: 'mapping:care_level_not_single' });
    expect(failed.afterData).toEqual({ eventId: 5, caseId: 7, caseReference: 'HC-PC-000007', status: 'failed' });
    expect(review).toMatchObject({ action: ACTION_REVIEW, entityId: '6', reasonCode: 'review:multiple_matching_deals' });
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[0][0]).toContain('[ALERT]');
    expect(log.error.mock.calls[0][0]).toContain('HC-PC-000007');
  });

  test('the same failure is never alerted twice: a second pass writes and logs nothing', async () => {
    await reportDealFailures({ prisma: alertDb, log });
    log.error.mockClear();
    expect(await reportDealFailures({ prisma: alertDb, log })).toBe(0);
    expect(reported).toHaveLength(2);
    expect(log.error).not.toHaveBeenCalled();
  });

  test('a race with another pass (duplicate key) is ignored without a second log line', async () => {
    alertDb.auditLog.create.mockImplementation(async () => { throw Object.assign(new Error('dup'), { code: 'P2002' }); });
    expect(await reportDealFailures({ prisma: alertDb, log })).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  test('an ordinary ambiguous event (still reconciling) and completed events are not alerted: only failed/manual-review are even read', async () => {
    await reportDealFailures({ prisma: alertDb, log });
    const where = alertDb.integrationOutbox.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ status: 'failed' }, { status: 'ambiguous', lastError: { startsWith: 'manual_review_required' } }]);
  });

  test('the alert never contains patient data, URLs or Bitrix text', async () => {
    rows[0].lastError = 'Bitrix24 Deal call: bitrix_error (HTTP 400 Field is invalid for +971501234567 Asha Rao https://x.invalid/rest/1/TOKEN/)';
    await reportDealFailures({ prisma: alertDb, log });
    const everything = JSON.stringify(reported) + log.error.mock.calls.map((c) => c[0]).join('\n');
    expect(everything).not.toMatch(/\+971|Asha|TOKEN|https?:|Field is invalid/);
  });
});

// ---- authorization and input --------------------------------------------------------------------------------------
describe('who may recover, and what must be given', () => {
  test.each([[{ id: 5, role: 'admin' }], [{ id: 5, role: undefined }], [null], [{ id: 'x', role: 'superadmin' }]])('actor %p is refused', async (actor) => {
    expect(await code(recover({ actor }))).toMatch(/^403:forbidden$/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test.each([[undefined], [''], ['because'], ['data_corrected '], [42]])('a missing or free-text reason %p is refused', async (reasonCode) => {
    expect(await code(recover({ reasonCode }))).toBe('400:reason_required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test('only a listed mode, whole-number ids, and a digit-string Deal ID are accepted', async () => {
    expect(await code(recover({ mode: 'reset' }))).toBe('400:invalid_mode');
    expect(await code(recover({ eventId: 1.5 }))).toBe('400:invalid_ids');
    expect(await code(recover({ mode: 'adopt_deal', dealId: '12a' }))).toBe('400:invalid_deal_id');
    expect(await code(recover({ mode: 'adopt_deal', dealId: 12 }))).toBe('400:invalid_deal_id');
  });
  test('an event of another Case or of another type is not found', async () => {
    expect(await code(recover({ caseId: 8 }))).toBe('404:event_not_found');
    events[0].event_type = 'bitrix.deal.stage';
    expect(await code(recover())).toBe('404:event_not_found');
  });
  test('the reason codes are a fixed list', () => {
    expect(REASON_CODES).toEqual(['data_corrected', 'bitrix_issue_resolved', 'checked_in_bitrix', 'deal_found_in_bitrix']);
  });
});

// ---- requeue (failure before any call) ----------------------------------------------------------------------------
describe('requeue: a failure before any Bitrix call', () => {
  test('writes a NEW event with a new key, leaves the original failed and untouched, and records the audit entry', async () => {
    const original = { ...events[0] };
    const result = await recover();
    expect(result).toMatchObject({ mode: 'requeue', eventId: 1, status: 'pending' });
    expect(events[0]).toEqual(original);
    const created = events.find((e) => e.id === result.newEventId);
    expect(created).toMatchObject({ status: 'pending', idempotency_key: dealRecoveryIdempotencyKey(7, 1) });
    expect(created.idempotency_key).not.toBe(original.idempotency_key);
    expect(prisma.tx.integrationOutbox.create.mock.calls[0][0].data.nextAttemptAt).toEqual(new Date(0));
    expect(link).toMatchObject({ syncStatus: 'pending', lastError: null, bitrixDealId: null });

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'bitrix.deal.recovery', entityType: 'integration_outbox', entityId: '1', caseId: 7, actorType: 'admin', actorId: '9', actorRole: 'superadmin',
      source: 'admin_portal', reasonCode: 'data_corrected', isOverride: false, idempotencyKey: 'bitrix.deal.recovery:event:1',
    });
    expect(audit[0].beforeData).toEqual({ eventId: 1, status: 'failed' });
    expect(audit[0].afterData).toEqual({ eventId: 1, newEventId: result.newEventId, caseId: 7, caseReference: REF, status: 'pending' });
    expect(api.findDealsByReference).not.toHaveBeenCalled();
  });

  test('is refused while the original problem is still there', async () => {
    caseRow.serviceRequest.careLevel = 'care_icu,care_na';
    expect(await code(recover())).toBe('422:not_corrected');
    expect(events).toHaveLength(1);
    expect(audit).toHaveLength(0);
    expect(link.syncStatus).toBe('error');
  });

  test('an event with external-call evidence can never be requeued', async () => {
    events[0].external_call_started_at = new Date();
    events[0].last_error = 'Bitrix24 Deal call: bitrix_error (HTTP 400)';
    expect(await code(recover())).toBe('409:external_call_evidence');
    events[0].status = 'ambiguous';
    expect(await code(recover())).toBe('409:external_call_evidence');
    expect(events).toHaveLength(1);
    expect(audit).toHaveLength(0);
  });

  test.each(['pending', 'processing', 'completed', 'ambiguous'])('a %s event is not requeued', async (status) => {
    events[0].status = status;
    expect(await code(recover())).toMatch(/^409:/);
    expect(events).toHaveLength(1);
  });

  test('is refused when the Case already has a Deal, is not eligible, or another event is waiting or running', async () => {
    link.bitrixDealId = '777';
    expect(await code(recover())).toBe('409:deal_already_linked');
    link.bitrixDealId = null;
    caseRow.serviceRequest.serviceKey = 'ground';
    expect(await code(recover())).toBe('409:not_eligible');
    caseRow.serviceRequest.serviceKey = 'privatecharter';
    events.push(ev({ id: 2, status: 'pending', idempotency_key: 'other' }));
    expect(await code(recover())).toBe('409:event_in_flight');
  });
});

describe('idempotency and concurrency', () => {
  test('a repeated request does not create a second event', async () => {
    const first = await recover();
    expect(await code(recover())).toBe('409:already_recovered');
    expect(events.filter((e) => e.idempotency_key === dealRecoveryIdempotencyKey(7, 1))).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(first.newEventId).toBeDefined();
  });

  test('two simultaneous requests create exactly one event and one audit entry', async () => {
    const results = await Promise.all([code(recover()), code(recover()), code(recover())]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === '409:already_recovered')).toHaveLength(2);
    expect(events.filter((e) => e.idempotency_key === dealRecoveryIdempotencyKey(7, 1))).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('the database key is the last line of defence: a duplicate-key error becomes "already recovered" and rolls everything back', async () => {
    prisma.tx.integrationOutbox.create.mockImplementationOnce(async () => { throw Object.assign(new Error('dup'), { code: 'P2002' }); });
    expect(await code(recover())).toBe('409:already_recovered');
    expect(audit).toHaveLength(0);
    expect(link.syncStatus).toBe('error');
  });

  test('a failed audit write rolls the whole recovery back', async () => {
    prisma.tx.auditLog.create.mockImplementationOnce(async () => { throw new Error('audit down'); });
    await expect(recover()).rejects.toThrow('audit down');
    expect(events).toHaveLength(1);
    expect(link.syncStatus).toBe('error');
  });
});

// ---- ambiguous / call-evidence events -----------------------------------------------------------------------------
describe('events with call evidence: reconciliation first, explicit manual resolution', () => {
  const definitive = () => { events[0] = ev({ status: 'failed', external_call_started_at: new Date(), last_error: 'Bitrix24 Deal call: bitrix_error (HTTP 400 x)' }); };
  const review = (reason) => { events[0] = ev({ status: 'ambiguous', external_call_started_at: new Date(), last_error: `manual_review_required:${reason}` }); };

  test('an ambiguous event that is still being reconciled cannot be touched in any mode', async () => {
    events[0] = ev({ status: 'ambiguous', external_call_started_at: new Date(), last_error: 'reconciling:no_match' });
    for (const mode of ['requeue', 'confirm_no_deal']) expect(await code(recover({ mode, reasonCode: 'checked_in_bitrix' }))).toMatch(/^409:/);
    expect(await code(recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '55' }))).toBe('409:deal_not_confirmed');
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['55'], stageId: 'C38:NEW' });
    expect(await code(recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '55' }))).toBe('409:reconciliation_required');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('ambiguous');
  });

  test('one empty search is never enough: a Deal found by Bitrix blocks confirm_no_deal', async () => {
    definitive();
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['55'] });
    expect(await code(recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' }))).toBe('409:deal_exists_in_bitrix');
    api.findDealsByReference.mockResolvedValue({ status: 'multiple', dealIds: ['55', '56'] });
    expect(await code(recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' }))).toBe('409:deal_exists_in_bitrix');
    expect(events).toHaveLength(1);
  });

  test('manual review after the whole waiting period + explicit attestation + empty search -> a new event, original untouched, marked as an override', async () => {
    review('no_match_after_waiting_period');
    const original = { ...events[0] };
    const result = await recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' });
    expect(api.findDealsByReference).toHaveBeenCalledWith(REF, { env: { BITRIX_DEAL_PROFILE: 'test' } });
    expect(events[0]).toEqual(original);
    expect(result.status).toBe('pending');
    expect(audit[0]).toMatchObject({ action: 'bitrix.deal.recovery', isOverride: true, reasonCode: 'checked_in_bitrix' });
  });

  test('a definitive Bitrix refusal can be replaced the same way, but not when the mapping is still wrong', async () => {
    definitive();
    caseRow.serviceRequest.mobility = 'flying';
    expect(await code(recover({ mode: 'confirm_no_deal', reasonCode: 'bitrix_issue_resolved' }))).toBe('422:not_corrected');
    caseRow.serviceRequest.mobility = 'walking';
    expect((await recover({ mode: 'confirm_no_deal', reasonCode: 'bitrix_issue_resolved' })).status).toBe('pending');
  });

  test.each(['multiple_matching_deals', 'deal_id_already_linked'])('manual review "%s" can never be replaced: a Deal exists', async (reason) => {
    review(reason);
    expect(await code(recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' }))).toBe('409:not_recoverable');
    expect(events).toHaveLength(1);
  });

  test('confirm_no_deal on an event with no call evidence is refused: use requeue', async () => {
    expect(await code(recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' }))).toBe('409:use_requeue');
  });

  test('adopt_deal links a Deal that Bitrix confirms (one of several is allowed), completes the event and audits it', async () => {
    review('multiple_matching_deals');
    api.findDealsByReference.mockResolvedValue({ status: 'multiple', dealIds: ['55', '56'] });
    const result = await recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '56' });
    expect(result).toMatchObject({ status: 'completed', bitrixDealId: '56', newEventId: null });
    expect(events[0].status).toBe('completed');
    expect(events).toHaveLength(1); // no new event: nothing can create a Deal
    expect(link).toMatchObject({ bitrixDealId: '56', categoryId: '38', syncStatus: 'synced' });
    expect(audit[0]).toMatchObject({ action: 'bitrix.deal.adopted_manually', isOverride: true, actorId: '9' });
    expect(audit[0].afterData.bitrixDealId).toBe('56');
  });

  test('adopt_deal refuses a Deal ID that Bitrix does not confirm for this reference', async () => {
    review('no_match_after_waiting_period');
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['55'] });
    expect(await code(recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '99' }))).toBe('409:deal_not_confirmed');
    api.findDealsByReference.mockResolvedValue({ status: 'uncertain', dealIds: [] });
    expect(await code(recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '55' }))).toBe('409:deal_not_confirmed');
    expect(link.bitrixDealId).toBeNull();
  });

  test('adopt_deal when the Deal ID is already linked to another Case rolls back', async () => {
    review('multiple_matching_deals');
    api.findDealsByReference.mockResolvedValue({ status: 'single', dealIds: ['55'] });
    prisma.tx.bitrixDealLink.update.mockImplementationOnce(async () => { throw Object.assign(new Error('Unique'), { code: 'P2002' }); });
    expect(await code(recover({ mode: 'adopt_deal', reasonCode: 'deal_found_in_bitrix', dealId: '55' }))).toBe('409:deal_id_already_linked');
    expect(events[0].status).toBe('ambiguous');
    expect(audit).toHaveLength(0);
  });

  test('Bitrix is only read, and never inside the transaction', async () => {
    review('no_match_after_waiting_period');
    let inside = false;
    const original = prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockImplementation((cb) => original(async (tx) => { inside = true; try { return await cb(tx); } finally { inside = false; } }));
    api.findDealsByReference.mockImplementation(async () => { expect(inside).toBe(false); return { status: 'none', dealIds: [] }; });
    await recover({ mode: 'confirm_no_deal', reasonCode: 'checked_in_bitrix' });
    expect(Object.keys(api)).toEqual(['findDealsByReference']); // there is no create function in reach
  });
});

// ---- the HTTP handler ---------------------------------------------------------------------------------------------
describe('the HTTP handler', () => {
  test('maps a refusal to its status and code, and never leaks internals', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    // The real service runs with the (mocked, empty) client: a non-superadmin is refused before any database call.
    await postDealRecovery({ params: { id: '7' }, body: { eventId: 1, mode: 'requeue', reasonCode: 'data_corrected' }, user: { id: 3, adminRole: 'admin' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Superadmin access required.', code: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });
  test('a body that is not an object is treated as empty and refused', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await postDealRecovery({ params: { id: '7' }, body: [1], user: { id: 3, adminRole: 'superadmin' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
