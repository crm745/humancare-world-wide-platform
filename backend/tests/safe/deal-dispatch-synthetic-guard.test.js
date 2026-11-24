/* global describe, test, expect, jest */
// The synthetic-identity dispatch guard: the Deal worker's candidate selection never offers an event whose request carries the synthetic E2E identity
// (patient name starting with ZZ-SYNTHETIC), in either statement, either status and any profile; every other event is offered exactly as before.
// No database, no network. The two SQL statements are checked as text and parameters; the rows below are the real shapes found in humancare_dev
// (protected REQ-1157 with its actual-profile event, the unstamped synthetic events, the E2E test request REQ-1208) and a genuine request.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const store = require('../../src/modules/bitrix/deal-outbox.store');

const text = (strings) => strings.join('?').replace(/\s+/g, ' ');
const PREFIX = 'ZZ-SYNTHETIC%';

// One row per event; `profile` is the stamp inside the event payload (null = an unstamped legacy event, which the test profile reads as 'test').
const EVENTS = [
  { id: 1, status: 'pending', profile: null, name: 'ZZ-SYNTHETIC Run A', caseId: 157, label: 'REQ-1156 (synthetic, unstamped)' },
  { id: 2, status: 'pending', profile: 'actual', name: 'ZZ-SYNTHETIC Run B', caseId: 158, label: 'REQ-1157 (synthetic, actual) <- protected request 157' },
  { id: 52, status: 'pending', profile: null, name: 'ZZ-SYNTHETIC Run C', caseId: 205, label: 'REQ-1155 (synthetic, unstamped)' },
  { id: 53, status: 'pending', profile: 'actual', name: 'E2E-TEST Asha Rao 1122', caseId: 206, label: 'REQ-1208 (E2E test identity, actual)' },
  { id: 60, status: 'pending', profile: 'actual', name: 'Asha Rao', caseId: 300, label: 'a genuine request (actual)' },
  { id: 61, status: 'pending', profile: null, name: 'Rakesh Sharma', caseId: 301, label: 'a genuine legacy request (unstamped)' },
  { id: 70, status: 'ambiguous', profile: 'actual', name: 'ZZ-SYNTHETIC Run D', caseId: 310, label: 'a synthetic event awaiting reconciliation (actual)' },
  { id: 71, status: 'ambiguous', profile: 'actual', name: 'Asha Rao', caseId: 311, label: 'a genuine event awaiting reconciliation (actual)' },
];

// A stand-in for the database that applies the statement's own parameters the way SQL would: status, profile and the NOT LIKE prefix. The parameter
// POSITIONS are the ones the statements' text defines (asserted separately below), so a change in the statement breaks these tests.
function applyFilters(rows, { status, profile, notLikePrefix, caseIds }) {
  const prefix = notLikePrefix.replace(/%$/, '');
  return rows
    .filter((e) => e.status === status)
    .filter((e) => (e.profile || 'test') === profile)
    .filter((e) => !e.name.startsWith(prefix))
    .filter((e) => !caseIds || caseIds.includes(e.caseId))
    .map((e) => ({ id: BigInt(e.id) }));
}
function fakeDb(rows = EVENTS) {
  return {
    // unscoped: values = [event, entity, status, privateCharterKey, manualReview%, profile, syntheticPrefix%, limit]
    $queryRaw: jest.fn(async (_s, ...v) => applyFilters(rows, { status: v[2], profile: v[5], notLikePrefix: v[6] })),
    // scoped: [sql, event, entity, status, key, manualReview%, profile, syntheticPrefix%, ...caseIds, limit]
    $queryRawUnsafe: jest.fn(async (_sql, ...v) => applyFilters(rows, { status: v[2], profile: v[5], notLikePrefix: v[6], caseIds: v.slice(7, -1) })),
  };
}
const candidates = (status, profile, scope) => store.findCandidateIds(fakeDb(), status, 5, scope, profile);

describe('the statements', () => {
  test('the unscoped statement excludes the synthetic prefix, with the prefix as a bound parameter after the profile', async () => {
    const queried = [];
    const db = { $queryRaw: jest.fn(async (s, ...v) => { queried.push({ sql: text(s), values: v }); return []; }) };
    await store.findCandidateIds(db, 'pending', 5, undefined, 'actual');
    const { sql, values } = queried[0];
    expect(sql).toContain('AND sr.patient_name NOT LIKE ?');
    expect(sql.indexOf("'$.profile')), 'test') = ?")).toBeLessThan(sql.indexOf('sr.patient_name NOT LIKE ?')); // right after the profile condition
    expect(values).toEqual(['bitrix.deal.create', 'case', 'pending', 'privatecharter', 'manual_review_required%', 'actual', PREFIX, 5]);
    expect(PREFIX).toBe(`${store.SYNTHETIC_IDENTITY_PREFIX}%`);
  });

  test('the scoped statement excludes it too, in the same position, and the constant text carries the condition', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => []) };
    await store.findCandidateIds(db, 'ambiguous', 5, { caseIds: [206] }, 'actual');
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('AND sr.patient_name NOT LIKE ?');
    expect(sql.indexOf("'$.profile')), 'test') = ?")).toBeLessThan(sql.indexOf('sr.patient_name NOT LIKE ?'));
    expect(sql.indexOf('sr.patient_name NOT LIKE ?')).toBeLessThan(sql.indexOf('o.case_id IN'));
    expect(params).toEqual(['bitrix.deal.create', 'case', 'ambiguous', 'privatecharter', 'manual_review_required%', 'actual', PREFIX, 206, 5]);
    expect(store.SCOPED_CANDIDATES_SQL).toContain('AND sr.patient_name NOT LIKE ?');
  });

  test('every existing condition is still there (only one was added)', () => {
    for (const sql of [store.SCOPED_CANDIDATES_SQL]) {
      for (const part of ['o.event_type = ?', 'o.status = ?', 'o.next_attempt_at <= UTC_TIMESTAMP(3)', 'sr.service_key = ?', 'sr.review_status IS NOT NULL', "(o.status <> 'pending' OR sr.review_status = 'approved')", 'sr.bitrix_lead_id IS NULL', 'o.last_error NOT LIKE ?', "'$.profile')), 'test') = ?"]) {
        expect(sql.replace(/\s+/g, ' ')).toContain(part);
      }
    }
  });
});

describe('what the actual-profile worker is offered (the humancare_dev event shapes)', () => {
  test("pending, profile 'actual': ONLY the E2E request and the genuine request; REQ-1157's event 2 is excluded", async () => {
    expect(await candidates('pending', 'actual')).toEqual([53, 60]);
  });

  test('REQ-1208 (event 53) remains eligible, and so does an ordinary genuine request', async () => {
    const ids = await candidates('pending', 'actual');
    expect(ids).toContain(53);
    expect(ids).toContain(60);
    expect(ids).not.toContain(2);
  });

  test("ambiguous events (reconciliation) are guarded the same way: a synthetic one is never offered, a genuine one still is", async () => {
    expect(await candidates('ambiguous', 'actual')).toEqual([71]);
  });

  test('the scoped statement gives the same answer for the same Cases', async () => {
    expect(await candidates('pending', 'actual', { caseIds: [158, 206, 300] })).toEqual([53, 60]); // Case 158 (REQ-1157) is named and STILL excluded
    expect(await candidates('pending', 'actual', { caseIds: [158] })).toEqual([]);
    expect(await candidates('ambiguous', 'actual', { caseIds: [310, 311] })).toEqual([71]);
  });

  test("the test profile: genuine unstamped events behave exactly as before; the synthetic unstamped events (1 and 52) are no longer offered either", async () => {
    expect(await candidates('pending', 'test')).toEqual([61]);
    // the stamp-based separation of the two profiles is untouched: actual events are not offered to the test profile, and vice versa
    expect(await candidates('pending', 'test')).not.toContain(53);
    expect(await candidates('pending', 'actual')).not.toContain(61);
  });

  test('a name that merely contains the prefix, or differs in case or position, is not the synthetic identity (the match is the exact start of the name)', async () => {
    const rows = [
      { id: 80, status: 'pending', profile: 'actual', name: 'Dr ZZ-SYNTHETIC Smith', caseId: 1 },
      { id: 81, status: 'pending', profile: 'actual', name: 'ZZ-SYNTHETI Smith', caseId: 2 },
      { id: 82, status: 'pending', profile: 'actual', name: 'ZZ-SYNTHETIC', caseId: 3 },
    ];
    expect((await store.findCandidateIds(fakeDb(rows), 'pending', 5, undefined, 'actual'))).toEqual([80, 81]);
  });
});

describe('what the guard does not touch', () => {
  test('the approval path is unchanged: nothing about creating the Case or the outbox event depends on this prefix', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
    expect(read('src/modules/bitrix/deal-outbox.js')).not.toMatch(/ZZ-SYNTHETIC|SYNTHETIC_IDENTITY_PREFIX/); // enqueueing still works for the synthetic engine
    expect(read('src/modules/request-review/request-review.service.js')).not.toMatch(/ZZ-SYNTHETIC|SYNTHETIC_IDENTITY_PREFIX/);
    expect(read('src/modules/request-review/synthetic-approval.js')).not.toMatch(/SYNTHETIC_IDENTITY_PREFIX/);
  });

  test('the store holds the prefix as its own literal and does not import the synthetic engine or its marker module', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/bitrix/deal-outbox.store.js'), 'utf8');
    expect(source).toMatch(/const SYNTHETIC_IDENTITY_PREFIX = 'ZZ-SYNTHETIC';/);
    expect(source).not.toMatch(/require\([^)]*synthetic/i);
  });

  test('the guard writes nothing: findCandidateIds only reads', async () => {
    const db = { $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn(), $executeRawUnsafe: jest.fn(), $transaction: jest.fn() };
    await store.findCandidateIds(db, 'pending', 5, undefined, 'actual');
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
