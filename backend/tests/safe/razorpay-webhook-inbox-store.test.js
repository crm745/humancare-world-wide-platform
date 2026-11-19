/* global describe, test, expect, jest */
// The worker half of the Razorpay inbox store (claim, lease, fenced result, retry policy, lease recovery). No database and no network: a recording
// fake captures EXACTLY which SQL is sent and with which parameters, and scripts the answers. What this file proves is the contract of the SQL (Razorpay
// rows only, the database's UTC clock, the fence predicates, the status vocabulary), the argument validation, the retry policy and the failure
// behaviour. The real lease, fence and concurrency SEMANTICS run against MySQL in tests/integration/razorpay-inbox.integration.js.
const fs = require('fs');
const path = require('path');
const store = require('../../src/modules/payments/razorpay-webhook.inbox.store');
const bitrixStore = require('../../src/modules/bitrix/deal-inbox.store');

const SOURCE_FILE = path.join(__dirname, '..', '..', 'src', 'modules', 'payments', 'razorpay-webhook.inbox.store.js');
const BITRIX_FILE = path.join(__dirname, '..', '..', 'src', 'modules', 'bitrix', 'deal-inbox.store.js');
const squash = (text) => text.replace(/\s+/g, ' ').trim();

// A fake Prisma that records every raw statement (as text with ? for each parameter) and answers from a script.
function makeDb({ query = [], execute = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    $queryRaw: jest.fn(async (strings, ...values) => {
      calls.push({ kind: 'query', sql: squash(strings.join('?')), values });
      const next = query.shift();
      if (next instanceof Error) throw next;
      return next === undefined ? [] : next;
    }),
    $executeRaw: jest.fn(async (strings, ...values) => {
      calls.push({ kind: 'execute', sql: squash(strings.join('?')), values });
      const next = execute.shift();
      if (next instanceof Error) throw next;
      return next === undefined ? 0 : next;
    }),
    $transaction: jest.fn(async (fn) => fn(db)),
  };
  return db;
}
const claimRow = (over = {}) => ({ id: 5, attempts: 0, external_event_id: 'evt_FAKE_00000001', event_type: 'payment.captured', entity_type: 'order', entity_id: 'order_FAKE1', external_occurred_at: new Date('2025-12-17T19:33:20Z'), payload: { event: 'payment.captured' }, ...over });
const aClaim = (over = {}) => ({ id: 5, workerId: 'worker-1', attempts: 1, ...over });
const rejection = async (promise) => { try { await promise; } catch (err) { return err; } throw new Error('expected a rejection'); };

describe('the policy constants', () => {
  test('lease, attempts and batch follow the existing inbox policy', () => {
    expect(store.LEASE_SECONDS).toBe(120);
    expect(store.MAX_ATTEMPTS).toBe(8);
    expect(store.BATCH_SIZE).toBe(10);
    expect(store.SOURCE).toBe('razorpay');
  });
  test('the status vocabulary is the existing schema\'s: final statuses and "received" for a retry; never "processing" or an invented value', () => {
    expect([...store.FINAL_STATUSES]).toEqual(['processed', 'ignored', 'failed']);
    expect([...store.RESULT_STATUSES]).toEqual(['processed', 'ignored', 'failed', 'received']);
    expect(Object.isFrozen(store.FINAL_STATUSES) && Object.isFrozen(store.RESULT_STATUSES)).toBe(true);
  });
  test('the retry delay grows by one minute per attempt and stops at fifteen minutes', () => {
    expect([1, 2, 3, 4, 5, 8].map(store.retryDelaySeconds)).toEqual([60, 120, 180, 240, 300, 480]);
    expect(store.retryDelaySeconds(15)).toBe(900);
    expect(store.retryDelaySeconds(16)).toBe(900);
    expect(store.retryDelaySeconds(1000)).toBe(900);
    expect(store.retryDelaySeconds(0)).toBe(60); // never zero
    expect(store.retryDelaySeconds(-3)).toBe(60);
  });
});

describe('findDueIds: only due Razorpay events', () => {
  test('selects waiting rows of the razorpay source that are due and not leased, oldest first, using the database UTC clock', async () => {
    const db = makeDb({ query: [[{ id: 3n }, { id: 4 }, { id: '9' }]] });
    expect(await store.findDueIds(db, 10)).toEqual([3, 4, 9]);
    const [call] = db.calls;
    expect(call.sql).toContain('FROM integration_inbox');
    expect(call.sql).toContain('source = ?');
    expect(call.values[0]).toBe('razorpay');
    expect(call.sql).toContain("status = 'received'");
    expect(call.sql).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(call.sql).toContain('(locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))');
    expect(call.sql).toContain('ORDER BY id');
    expect(call.sql).toMatch(/LIMIT \?$/);
    expect(call.values).toEqual(['razorpay', 10]);
  });
  test('the batch size is the default and the limit is validated before any query', async () => {
    const db = makeDb();
    await store.findDueIds(db);
    expect(db.calls[0].values[1]).toBe(10);
    for (const bad of [0, -1, 101, 1.5, '10', NaN, null]) expect(await rejection(store.findDueIds(db, bad))).toBeInstanceOf(RangeError);
    expect(db.calls).toHaveLength(1);
  });
  test('an empty answer is an empty list', async () => {
    expect(await store.findDueIds(makeDb({ query: [[]] }), 5)).toEqual([]);
  });
});

describe('claim: a compare-and-swap that can only take a due Razorpay event', () => {
  test('locks the row, then claims it with a compare-and-swap on attempts, a lease measured by the database clock, and the source in BOTH statements', async () => {
    const db = makeDb({ query: [[claimRow({ attempts: 2 })]], execute: [1] });
    const claimed = await store.claim(db, { id: 5, workerId: 'worker-1', leaseSeconds: 90 });
    const [select, update] = db.calls;
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(select.kind).toBe('query');
    expect(select.sql).toContain('FOR UPDATE');
    expect(select.sql).toContain('source = ?');
    expect(select.values).toEqual([5, 'razorpay']);
    expect(select.sql).toContain("status = 'received'");
    expect(select.sql).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(update.kind).toBe('execute');
    expect(update.sql).toContain("SET status = 'processing', attempts = attempts + 1");
    expect(update.sql).toContain('locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(update.sql).toContain('source = ?');
    expect(update.sql).toContain("status = 'received' AND attempts = ?");
    expect(update.sql).toContain('(locked_until IS NULL OR locked_until <= UTC_TIMESTAMP(3))');
    expect(update.values).toEqual(['worker-1', 90, 5, 'razorpay', 2]); // worker, lease, id, source, the attempts value it read (the compare)
    expect(claimed).toEqual({
      id: 5, workerId: 'worker-1', attempts: 3, externalEventId: 'evt_FAKE_00000001', eventType: 'payment.captured', entityType: 'order', entityId: 'order_FAKE1',
      occurredAt: new Date('2025-12-17T19:33:20Z'), payload: { event: 'payment.captured' },
    });
  });
  test('the default lease is 120 seconds', async () => {
    const db = makeDb({ query: [[claimRow()]], execute: [1] });
    await store.claim(db, { id: 5, workerId: 'w' });
    expect(db.calls[1].values[1]).toBe(120);
  });
  test('a row that is not claimable (another source, not waiting, not due, leased) yields null and no UPDATE is attempted', async () => {
    const db = makeDb({ query: [[]] });
    expect(await store.claim(db, { id: 5, workerId: 'worker-1' })).toBeNull();
    expect(db.calls).toHaveLength(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  test('losing the compare-and-swap (the UPDATE changes no row) yields null', async () => {
    const db = makeDb({ query: [[claimRow()]], execute: [0] });
    expect(await store.claim(db, { id: 5, workerId: 'worker-1' })).toBeNull();
  });
  test('an UPDATE that changes more than one row is not a valid claim either', async () => {
    const db = makeDb({ query: [[claimRow()]], execute: [2] });
    expect(await store.claim(db, { id: 5, workerId: 'worker-1' })).toBeNull();
  });
  test('the stored payload is returned as an object, whether the driver gives text or an object, and null when unreadable', async () => {
    for (const [stored, expected] of [['{"event":"order.paid","order":{"id":"order_FAKE1"}}', { event: 'order.paid', order: { id: 'order_FAKE1' } }], [{ a: 1 }, { a: 1 }], [null, null], ['not json', null], [undefined, null]]) {
      const db = makeDb({ query: [[claimRow({ payload: stored })]], execute: [1] });
      expect((await store.claim(db, { id: 5, workerId: 'w' })).payload).toEqual(expected);
    }
  });
  test('optional columns may be NULL', async () => {
    const db = makeDb({ query: [[claimRow({ entity_type: null, entity_id: null, external_occurred_at: null })]], execute: [1] });
    expect(await store.claim(db, { id: 5, workerId: 'w' })).toMatchObject({ entityType: null, entityId: null, occurredAt: null });
  });
  test('arguments are validated before the database is touched', async () => {
    const db = makeDb();
    for (const bad of [
      { id: 0, workerId: 'w' }, { id: -1, workerId: 'w' }, { id: 1.5, workerId: 'w' }, { id: '5', workerId: 'w' }, { id: undefined, workerId: 'w' },
      { id: 5, workerId: '' }, { id: 5, workerId: 'has space' }, { id: 5, workerId: 'semi;colon' }, { id: 5, workerId: 'x'.repeat(65) }, { id: 5, workerId: 7 },
      { id: 5, workerId: 'w', leaseSeconds: 0 }, { id: 5, workerId: 'w', leaseSeconds: 3601 }, { id: 5, workerId: 'w', leaseSeconds: 1.5 }, { id: 5, workerId: 'w', leaseSeconds: '60' },
    ]) expect(await rejection(store.claim(db, bad))).toBeInstanceOf(RangeError);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });
});

describe('writeResult: the fenced result write', () => {
  test('is ONE update that checks id, source, "processing", the claimed attempts, the lock owner and that the lease has not expired', async () => {
    const db = makeDb({ execute: [1] });
    expect(await store.writeResult(db, aClaim({ attempts: 3 }), { status: 'processed' })).toBe(1);
    expect(db.calls).toHaveLength(1);
    const [call] = db.calls;
    expect(call.sql).toContain('UPDATE integration_inbox');
    expect(call.sql).toContain("WHERE id = ? AND source = ? AND status = 'processing' AND attempts = ? AND locked_by = ? AND locked_until > UTC_TIMESTAMP(3)");
    expect(call.values.slice(-4)).toEqual([5, 'razorpay', 3, 'worker-1']);
    expect(call.sql).toContain('locked_by = NULL, locked_until = NULL'); // the lease is released
    expect(call.sql).toContain('next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL ? SECOND'); // scheduling by the database clock
  });
  test('zero changed rows means the lease was lost: reported as 0, never thrown', async () => {
    const db = makeDb({ execute: [0] });
    expect(await store.writeResult(db, aClaim(), { status: 'processed' })).toBe(0);
  });
  test.each([['processed'], ['ignored'], ['failed'], ['received']])('the status "%s" is accepted and passed as a parameter', async (status) => {
    const db = makeDb({ execute: [1] });
    await store.writeResult(db, aClaim(), { status });
    expect(db.calls[0].values[0]).toBe(status);
  });
  test('processed_at is set for the final statuses only (a retry keeps it)', async () => {
    const db = makeDb({ execute: [1] });
    await store.writeResult(db, aClaim(), { status: 'received', delaySeconds: 60 });
    expect(db.calls[0].sql).toContain("processed_at = CASE WHEN ? IN ('processed', 'ignored', 'failed') THEN UTC_TIMESTAMP(3) ELSE processed_at END");
  });
  test.each([['processing'], ['PROCESSED'], [''], [undefined], [null], ['done'], ['received; DROP TABLE x'], [1]])('the status %p is refused before any SQL is sent', async (status) => {
    const db = makeDb();
    expect(await rejection(store.writeResult(db, aClaim(), { status }))).toBeInstanceOf(RangeError);
    expect(db.calls).toHaveLength(0);
  });
  test.each([[-1], [86401], [1.5], ['60'], [NaN], [null]])('a delay of %p is refused before any SQL is sent', async (delaySeconds) => {
    const db = makeDb();
    expect(await rejection(store.writeResult(db, aClaim(), { status: 'received', delaySeconds }))).toBeInstanceOf(RangeError);
    expect(db.calls).toHaveLength(0);
  });
  test('a missing or malformed claim is refused before any SQL is sent', async () => {
    const db = makeDb();
    for (const bad of [undefined, null, {}, { id: 5, attempts: 1 }, { id: 0, attempts: 1, workerId: 'w' }, { id: 5, attempts: 0, workerId: 'w' }, { id: 5, attempts: 1, workerId: 7 }, 'claim']) {
      expect(await rejection(store.writeResult(db, bad, { status: 'processed' }))).toBeInstanceOf(TypeError);
    }
    expect(db.calls).toHaveLength(0);
  });
  test('last_error is a short sanitised code: free text, spaces, quotes and secrets cannot get in', async () => {
    const db = makeDb({ execute: [1, 1, 1] });
    await store.writeResult(db, aClaim(), { status: 'failed', lastError: "amount_mismatch: it's 'bad'; DROP TABLE x -- whsec_SECRET" });
    await store.writeResult(db, aClaim(), { status: 'failed', lastError: 'x'.repeat(500) });
    await store.writeResult(db, aClaim(), { status: 'processed' });
    const [a, b, c] = db.calls.map((call) => call.values[1]);
    expect(a).toBe('amount_mismatch:_it_s__bad___DROP_TABLE_x_--_whsec_SECRET'); // the colon is an allowed separator; everything else unsafe became "_"
    expect(a).toMatch(/^[A-Za-z0-9_.:-]+$/);
    expect(b).toHaveLength(200);
    expect(c).toBeNull();
  });
  test('cleanCode on its own', () => {
    expect(store.cleanCode(null)).toBeNull();
    expect(store.cleanCode(undefined)).toBeNull();
    expect(store.cleanCode('ok_code:1.2-3')).toBe('ok_code:1.2-3');
    expect(store.cleanCode('a b/c\\d')).toBe('a_b_c_d');
    expect(store.cleanCode(12345)).toBe('12345');
  });
});

describe('retry scheduling and the maximum-attempt policy (retryOrFail)', () => {
  test.each([[1, 60], [2, 120], [3, 180], [7, 420]])('attempt %i: back to "received" after %i seconds, with the code', async (attempts, delay) => {
    const db = makeDb({ execute: [1] });
    const outcome = await store.retryOrFail(db, aClaim({ attempts }), { code: 'order_not_found_yet' });
    expect(outcome).toEqual({ status: 'received', delaySeconds: delay, written: 1 });
    expect(db.calls[0].values.slice(0, 3)).toEqual(['received', 'order_not_found_yet', delay]);
  });
  test('the 8th attempt is the last: the event becomes "failed" (final), with no further delay', async () => {
    const db = makeDb({ execute: [1] });
    const outcome = await store.retryOrFail(db, aClaim({ attempts: 8 }), { code: 'order_not_found' });
    expect(outcome).toEqual({ status: 'failed', delaySeconds: 0, written: 1 });
    expect(db.calls[0].values.slice(0, 2)).toEqual(['failed', 'order_not_found']);
  });
  test('beyond the maximum it also fails (a claim can never exceed it, but nothing retries forever)', async () => {
    const db = makeDb({ execute: [1] });
    expect((await store.retryOrFail(db, aClaim({ attempts: 9 }), { code: 'x' })).status).toBe('failed');
    expect((await store.retryOrFail(db, aClaim({ attempts: 50 }), { code: 'x' })).status).toBe('failed');
  });
  test('seven retries then a final failure: the whole schedule, with no attempt skipped', async () => {
    const db = makeDb({ execute: Array(8).fill(1) });
    const results = [];
    for (let attempts = 1; attempts <= 8; attempts += 1) results.push(await store.retryOrFail(db, aClaim({ attempts }), { code: 'transient' }));
    expect(results.map((r) => r.status)).toEqual([...Array(7).fill('received'), 'failed']);
    expect(results.map((r) => r.delaySeconds)).toEqual([60, 120, 180, 240, 300, 360, 420, 0]);
  });
  test('a lost lease is reported as written 0 and nothing else', async () => {
    const db = makeDb({ execute: [0] });
    expect(await store.retryOrFail(db, aClaim({ attempts: 2 }), { code: 'transient' })).toEqual({ status: 'received', delaySeconds: 120, written: 0 });
  });
  test('the retry write goes through the same fence as every result', async () => {
    const db = makeDb({ execute: [1] });
    await store.retryOrFail(db, aClaim({ attempts: 2 }), { code: 'transient' });
    expect(db.calls[0].sql).toContain("status = 'processing' AND attempts = ? AND locked_by = ? AND locked_until > UTC_TIMESTAMP(3)");
  });
});

describe('recoverExpiredLeases: safe reclaim, Razorpay rows only', () => {
  test('returns expired claims to "received" (due now) and fails those that used every attempt, both by the database clock and both for source razorpay', async () => {
    const db = makeDb({ execute: [2, 5] });
    expect(await store.recoverExpiredLeases(db)).toEqual({ failed: 2, again: 5 });
    const [failed, again] = db.calls;
    for (const call of [failed, again]) {
      expect(call.sql).toContain('source = ?');
      expect(call.values[0]).toBe('razorpay');
      expect(call.sql).toContain("status = 'processing' AND locked_until <= UTC_TIMESTAMP(3)");
    }
    expect(failed.sql).toContain("SET status = 'failed', last_error = 'lease_expired_repeatedly'");
    expect(failed.sql).toContain('attempts >= ?');
    expect(again.sql).toContain("SET status = 'received', next_attempt_at = UTC_TIMESTAMP(3)");
    expect(again.sql).toContain('locked_by = NULL, locked_until = NULL');
    expect(again.sql).toContain('attempts < ?');
    expect(failed.values).toEqual(['razorpay', 8]);
    expect(again.values).toEqual(['razorpay', 8]);
  });
  test('the attempts cap is configurable and validated', async () => {
    const db = makeDb({ execute: [0, 0] });
    await store.recoverExpiredLeases(db, { maxAttempts: 3 });
    expect(db.calls.map((c) => c.values[1])).toEqual([3, 3]);
    for (const bad of [0, -1, 1.5, '8', null, 1001]) expect(await rejection(store.recoverExpiredLeases(makeDb(), { maxAttempts: bad }))).toBeInstanceOf(RangeError);
  });
  test('a live lease is never touched (the predicate requires locked_until in the past)', async () => {
    const db = makeDb({ execute: [0, 0] });
    await store.recoverExpiredLeases(db);
    for (const call of db.calls) expect(call.sql).toContain('locked_until <= UTC_TIMESTAMP(3)');
  });
});

describe('only Razorpay events, only the database clock: static checks of the source', () => {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const code = source.replace(/\/\/.*$/gm, ''); // comments aside
  const statements = [...code.matchAll(/(?:\$queryRaw|\$executeRaw)`([^`]*)`/g)].map((m) => m[1]);

  test('there are the expected raw statements and every one is restricted to ${SOURCE}', () => {
    expect(statements).toHaveLength(7); // findDueIds, claim select + update, holdLease, writeResult, recoverExpiredLeases x2
    for (const statement of statements) expect(statement).toContain('source = ${SOURCE}');
  });
  test('every statement that reads or writes the inbox names integration_inbox', () => {
    for (const statement of statements) expect(statement).toMatch(/integration_inbox/);
  });
  test('time comes from the database UTC clock only: no NOW(), CURRENT_TIMESTAMP, SYSDATE or application Date in any statement', () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\bNOW\s*\(|CURRENT_TIMESTAMP|SYSDATE|LOCALTIME|UNIX_TIMESTAMP|CURDATE/i);
      expect(statement).not.toMatch(/\$\{\s*new Date|\$\{\s*Date\./);
    }
    expect(statements.join('\n')).toContain('UTC_TIMESTAMP(3)');
  });
  test('the worker functions do not use the application clock at all', () => {
    const worker = code.slice(code.indexOf('const LEASE_SECONDS'));
    expect(worker).not.toMatch(/new Date|Date\.now|setTimeout|setInterval/);
  });
  test('nothing in the code mentions another source or imports the Bitrix store', () => {
    expect(code).not.toMatch(/bitrix|deal-inbox|ONCRMDEALUPDATE/i);
    expect(code).not.toMatch(/require\(['"]\.\.\/bitrix/);
    expect(code.match(/require\(/g) || []).toHaveLength(0);
  });
  test('the store never logs and never touches payments or invoices', () => {
    expect(code).not.toMatch(/console\.|logger\./);
    expect(code).not.toMatch(/FROM payments|UPDATE payments|FROM invoices|UPDATE invoices|prisma\.payment|\.payment\./);
  });
  test('values are bound as parameters: no value is concatenated into any statement', () => {
    for (const statement of statements) {
      for (const match of statement.matchAll(/\$\{([^}]*)\}/g)) expect(match[1]).toMatch(/^(SOURCE|id|limit|workerId|leaseSeconds|status|delaySeconds|maxAttempts|row\.attempts|claimed\.(id|attempts|workerId)|cleanCode\(lastError\))$/);
    }
  });
});

describe('the Bitrix24 inbox store is untouched and independent', () => {
  test('it keeps its own exports, its own source and its own event type', () => {
    expect(Object.keys(bitrixStore).sort()).toEqual(['DEAL_EVENT', 'SOURCE', 'claim', 'cleanCode', 'findDueIds', 'recoverExpiredLeases', 'writeResult']);
    expect(bitrixStore.SOURCE).toBe('bitrix24');
    expect(bitrixStore.DEAL_EVENT).toBe('ONCRMDEALUPDATE');
    expect(store.SOURCE).not.toBe(bitrixStore.SOURCE);
  });
  test('its SQL is still hard-wired to Bitrix and was not parameterized for Razorpay', () => {
    const bitrix = fs.readFileSync(BITRIX_FILE, 'utf8');
    expect(bitrix).toContain('WHERE source = ${SOURCE} AND event_type = ${DEAL_EVENT}');
    expect(bitrix).not.toMatch(/razorpay/i);
  });
  test('the Razorpay functions are not the Bitrix functions', () => {
    for (const name of ['findDueIds', 'claim', 'writeResult', 'recoverExpiredLeases']) expect(store[name]).not.toBe(bitrixStore[name]);
  });
});

describe('database errors fail safely', () => {
  const boom = () => Object.assign(new Error('connect ECONNREFUSED mysql://user:pa55@host/db SENTINEL'), { code: 'P1001' });

  test('findDueIds propagates the error and returns no ids', async () => {
    const error = boom();
    expect(await rejection(store.findDueIds(makeDb({ query: [error] })))).toBe(error);
  });
  test('claim: a failure while locking claims nothing (no UPDATE is issued) and the error propagates', async () => {
    const error = boom();
    const db = makeDb({ query: [error] });
    expect(await rejection(store.claim(db, { id: 5, workerId: 'w' }))).toBe(error);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  test('claim: a failure of the UPDATE propagates, so the transaction rolls back and nothing is claimed', async () => {
    const error = boom();
    const db = makeDb({ query: [[claimRow()]], execute: [error] });
    expect(await rejection(store.claim(db, { id: 5, workerId: 'w' }))).toBe(error);
  });
  test('writeResult: a failure propagates (the caller\'s transaction rolls back); it is never reported as "recorded"', async () => {
    const error = boom();
    const db = makeDb({ execute: [error] });
    expect(await rejection(store.writeResult(db, aClaim(), { status: 'processed' }))).toBe(error);
  });
  test('retryOrFail: a failing write propagates and no success is reported', async () => {
    const error = boom();
    expect(await rejection(store.retryOrFail(makeDb({ execute: [error] }), aClaim(), { code: 'x' }))).toBe(error);
  });
  test('recoverExpiredLeases: a failure of the first statement stops before the second; the error propagates', async () => {
    const error = boom();
    const db = makeDb({ execute: [error] });
    expect(await rejection(store.recoverExpiredLeases(db))).toBe(error);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
  test('the store itself writes nothing to the console when a database error occurs', async () => {
    const spies = ['log', 'info', 'warn', 'error'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
    try {
      await rejection(store.findDueIds(makeDb({ query: [boom()] })));
      await rejection(store.claim(makeDb({ query: [boom()] }), { id: 5, workerId: 'w' }));
      await rejection(store.writeResult(makeDb({ execute: [boom()] }), aClaim(), { status: 'processed' }));
      await rejection(store.recoverExpiredLeases(makeDb({ execute: [boom()] })));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
  test('the receiver\'s own functions are unchanged by the worker additions', () => {
    expect(typeof store.storeEvent).toBe('function');
    expect(typeof store.bodyAlreadyStored).toBe('function');
  });
});
