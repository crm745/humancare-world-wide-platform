/* global describe, it, expect, beforeAll, afterAll */
// The Razorpay webhook inbox worker infrastructure on REAL MySQL (humancare_test): claims, leases, the fenced result write, retry scheduling, the
// attempt cap, lease recovery, and isolation from the Bitrix24 inbox. Nothing about the database is mocked: the application's own store functions run
// through SEPARATE Prisma clients (separate MySQL connections) wherever concurrency matters, and time is read from the database's own UTC clock. Only
// synthetic PAYTEST_<runid> rows are written (registered by exact id, removed by exact id after a before/after snapshot; see helpers/payments-fixture.js).
const guard = require('../../src/common/safety/integration-runner-guard');
const store = require('../../src/modules/payments/razorpay-webhook.inbox.store');
const { PaymentsFixture, sleep } = require('./helpers/payments-fixture');

const fx = new PaymentsFixture();
let main; let c1; let c2; let c3; let c4; let baseline; let cleanupReport; let afterSnapshot; let remaining;

const attempt = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
let counter = 0;
const workerName = (label) => { counter += 1; return `PT${fx.runId}-${label}-${counter}`; };

// A synthetic inbox row. Razorpay rows are due at once (next_attempt_at in the past), like the receiver stores them.
async function mk(over = {}) {
  const row = await main.integrationInbox.create({
    data: {
      source: 'razorpay', externalEventId: fx.name('EVT'), eventType: 'payment.captured', entityType: 'order', entityId: fx.name('ORD').slice(0, 60),
      payload: { event: 'payment.captured', payment: { id: 'pay_FAKE1', orderId: 'order_FAKE1', amount: 150000, currency: 'INR', status: 'captured' }, bodySha256: 'a'.repeat(64) },
      status: 'received', nextAttemptAt: new Date(0), ...over,
    },
  });
  fx.track('inbox', row.id);
  return row;
}
const mkBitrix = (over = {}) => mk({ source: 'bitrix24', eventType: 'ONCRMDEALUPDATE', entityType: 'deal', payload: { event: 'ONCRMDEALUPDATE', dealId: '4711' }, ...over });
const rowOf = (id) => main.integrationInbox.findUnique({ where: { id } });

// Time facts, always from the DATABASE clock.
async function facts(id) {
  const [r] = await main.$queryRaw`
    SELECT status, attempts, locked_by AS lockedBy, last_error AS lastError, processed_at IS NOT NULL AS hasProcessedAt,
           locked_until IS NOT NULL AS hasLease, locked_until > UTC_TIMESTAMP(3) AS leaseLive,
           TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), locked_until) AS leaseLeft, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), next_attempt_at) AS nextIn,
           next_attempt_at <= UTC_TIMESTAMP(3) AS due
    FROM integration_inbox WHERE id = ${id}`;
  return {
    status: r.status, attempts: Number(r.attempts), lockedBy: r.lockedBy, lastError: r.lastError, hasProcessedAt: Number(r.hasProcessedAt) === 1,
    hasLease: Number(r.hasLease) === 1, leaseLive: r.leaseLive === null ? null : Number(r.leaseLive) === 1, leaseLeft: r.leaseLeft === null ? null : Number(r.leaseLeft),
    nextIn: Number(r.nextIn), due: Number(r.due) === 1,
  };
}
// Test levers on SYNTHETIC rows only (exact id): move a lease into the past, move the schedule, set the attempts counter.
const expireLease = (id) => main.$executeRaw`UPDATE integration_inbox SET locked_until = UTC_TIMESTAMP(3) - INTERVAL 30 SECOND WHERE id = ${id}`;
const makeDue = (id) => main.$executeRaw`UPDATE integration_inbox SET next_attempt_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ${id}`;
const setAttempts = (id, n) => main.$executeRaw`UPDATE integration_inbox SET attempts = ${n} WHERE id = ${id}`;
const claimOn = (client, id, label = 'w', leaseSeconds = 120) => store.claim(client, { id, workerId: workerName(label), leaseSeconds });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env); // opt-in, humancare_test URL, ordinary test rules
  main = fx.newClient('main');
  c1 = fx.newClient('c1'); c2 = fx.newClient('c2'); c3 = fx.newClient('c3'); c4 = fx.newClient('c4');
  const live = await guard.verifyLiveIdentity(main); // the server must say humancare_test, as a confined test account
  expect(live.database).toBe('humancare_test');
  baseline = await fx.snapshot(main);
  // findDueIds and recoverExpiredLeases are set-based over EVERY razorpay row: there must be none but ours.
  const [existing] = await main.$queryRaw`SELECT COUNT(*) AS n FROM integration_inbox WHERE source = 'razorpay'`;
  expect(Number(existing.n)).toBe(0);
}, 60000);

afterAll(async () => {
  try {
    cleanupReport = await fx.cleanup(main);
    remaining = await fx.remaining(main);
    afterSnapshot = await fx.snapshot(main);
  } finally {
    await fx.disconnectAll();
  }
  expect(cleanupReport.failures).toEqual([]);
  expect(Object.values(remaining).every((n) => n === 0)).toBe(true);
  expect(afterSnapshot.counts).toEqual(baseline.counts); // nothing that existed before was added or removed
  expect(afterSnapshot.checksums).toEqual(baseline.checksums); // and nothing was modified
}, 120000);

describe('claiming eligible Razorpay events', () => {
  it('a due, waiting Razorpay event is listed, claimed, and then leased by the database clock', async () => {
    const e = await mk();
    expect(await store.findDueIds(main, 100)).toContain(e.id);
    const claim = await claimOn(c1, e.id, 'a', 90);
    expect(claim).toMatchObject({ id: e.id, attempts: 1, eventType: 'payment.captured', entityType: 'order', entityId: e.entityId, externalEventId: e.externalEventId });
    expect(claim.payload).toMatchObject({ event: 'payment.captured', payment: { id: 'pay_FAKE1', amount: 150000 } }); // a parsed object, as stored
    expect(claim.occurredAt === null || claim.occurredAt instanceof Date).toBe(true);
    const f = await facts(e.id);
    expect(f).toMatchObject({ status: 'processing', attempts: 1, lockedBy: claim.workerId, hasLease: true, leaseLive: true });
    expect(f.leaseLeft).toBeGreaterThanOrEqual(86); // locked_until = the database's UTC now + 90 s
    expect(f.leaseLeft).toBeLessThanOrEqual(90);
    expect(await store.findDueIds(main, 100)).not.toContain(e.id); // leased: no longer listed
  });

  it('the default lease is 120 seconds', async () => {
    const e = await mk();
    const claim = await store.claim(c1, { id: e.id, workerId: workerName('d') });
    expect(claim).not.toBeNull();
    const f = await facts(e.id);
    expect(f.leaseLeft).toBeGreaterThanOrEqual(116);
    expect(f.leaseLeft).toBeLessThanOrEqual(120);
  });

  it('an event scheduled for later is neither listed nor claimable until it is due', async () => {
    const e = await mk();
    await main.$executeRaw`UPDATE integration_inbox SET next_attempt_at = UTC_TIMESTAMP(3) + INTERVAL 300 SECOND WHERE id = ${e.id}`;
    expect(await store.findDueIds(main, 100)).not.toContain(e.id);
    expect(await claimOn(c1, e.id)).toBeNull();
    expect((await facts(e.id)).status).toBe('received');
    await makeDue(e.id);
    expect(await store.findDueIds(main, 100)).toContain(e.id);
    expect(await claimOn(c1, e.id)).not.toBeNull();
  });

  it('events are listed oldest first and the batch limit is honoured', async () => {
    const made = [await mk(), await mk(), await mk()];
    const ids = await store.findDueIds(main, 100);
    const mine = ids.filter((id) => made.some((m) => m.id === id));
    expect(mine).toEqual(made.map((m) => m.id).sort((a, b) => a - b));
    expect((await store.findDueIds(main, 1)).length).toBe(1);
    for (const e of made) await claimOn(main, e.id); // lease them so later tests start from a clean slate
  });

  it('an id that does not exist is not claimable', async () => {
    expect(await claimOn(c1, 2147483000)).toBeNull();
  });
});

describe('preventing duplicate simultaneous claims', () => {
  it('four connections race for one event: exactly one wins, the event is claimed once', async () => {
    const e = await mk();
    const clients = [c1, c2, c3, c4];
    const results = await Promise.all(clients.map((c, i) => attempt(claimOn(c, e.id, `r${i}`))));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const winners = results.map((r) => r.value).filter(Boolean);
    expect(winners).toHaveLength(1);
    const f = await facts(e.id);
    expect(f).toMatchObject({ status: 'processing', attempts: 1, lockedBy: winners[0].workerId });
  });

  it('twelve events and four competing workers: every event is claimed exactly once, none twice, none missed', async () => {
    const events = [];
    for (let i = 0; i < 12; i += 1) events.push(await mk());
    const mineIds = new Set(events.map((e) => e.id));
    const clients = [c1, c2, c3, c4];
    const claimedBy = clients.map(() => []);
    await Promise.all(clients.map(async (client, index) => {
      const worker = workerName(`pool${index}`);
      for (let pass = 0; pass < 6; pass += 1) {
        const ids = (await store.findDueIds(client, 100)).filter((id) => mineIds.has(id));
        for (const id of ids) {
          const claim = await store.claim(client, { id, workerId: worker, leaseSeconds: 60 });
          if (claim) claimedBy[index].push(claim);
        }
      }
    }));
    const all = claimedBy.flat();
    expect(all).toHaveLength(12);
    expect(new Set(all.map((c) => c.id)).size).toBe(12); // no event claimed twice
    expect(new Set(all.map((c) => c.id))).toEqual(mineIds);
    for (const claim of all) expect(claim.attempts).toBe(1);
    for (const e of events) {
      const f = await facts(e.id);
      expect(f.status).toBe('processing');
      expect(f.attempts).toBe(1);
    }
    expect(claimedBy.filter((list) => list.length > 0).length).toBeGreaterThan(0);
  }, 60000);

  it('an event that is already leased cannot be claimed by anyone else', async () => {
    const e = await mk();
    const first = await claimOn(c1, e.id, 'first');
    expect(first).not.toBeNull();
    for (const c of [c2, c3, c4, main]) expect(await claimOn(c, e.id, 'second')).toBeNull();
    expect((await facts(e.id)).lockedBy).toBe(first.workerId);
  });
});

describe('lease expiry and safe reclaim', () => {
  it('after the lease really expires (database clock) the event is recovered and a new worker claims it with attempts 2', async () => {
    const e = await mk();
    const first = await claimOn(c1, e.id, 'slow', 1);
    await sleep(1400);
    expect((await facts(e.id)).leaseLive).toBe(false);
    expect(await claimOn(c2, e.id, 'early')).toBeNull(); // still "processing": not claimable until recovered
    const swept = await store.recoverExpiredLeases(c3);
    expect(swept.again).toBeGreaterThanOrEqual(1);
    expect(await facts(e.id)).toMatchObject({ status: 'received', hasLease: false, lockedBy: null, attempts: 1, due: true });
    const second = await claimOn(c2, e.id, 'takeover');
    expect(second).toMatchObject({ attempts: 2 });
    expect(second.workerId).not.toBe(first.workerId);
  }, 30000);

  it('a LIVE lease is never recovered: the sweep leaves the owner in place', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'live', 120);
    await store.recoverExpiredLeases(main);
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: claim.workerId, leaseLive: true, attempts: 1 });
  });

  it('an event that used every attempt is not given another: recovery makes it a final failure', async () => {
    const e = await mk();
    await claimOn(c1, e.id, 'last', 60);
    await setAttempts(e.id, store.MAX_ATTEMPTS); // synthetic row: pretend the 8th claim is the one that stalled
    await expireLease(e.id);
    const swept = await store.recoverExpiredLeases(c2);
    expect(swept.failed).toBeGreaterThanOrEqual(1);
    expect(await facts(e.id)).toMatchObject({ status: 'failed', lastError: 'lease_expired_repeatedly', hasProcessedAt: true, hasLease: false });
    expect(await claimOn(c3, e.id)).toBeNull();
    expect(await store.findDueIds(main, 100)).not.toContain(e.id);
  });

  it('recovery sweeps running on several connections at once are harmless: the event is recovered once and can be claimed once', async () => {
    const events = [];
    for (let i = 0; i < 6; i += 1) { const e = await mk(); await claimOn(c1, e.id, 'z', 60); await expireLease(e.id); events.push(e); }
    const sweeps = await Promise.all([c1, c2, c3, c4].map((c) => attempt(store.recoverExpiredLeases(c))));
    expect(sweeps.filter((s) => !s.ok)).toEqual([]);
    for (const e of events) expect(await facts(e.id)).toMatchObject({ status: 'received', attempts: 1, hasLease: false });
    const claims = await Promise.all(events.flatMap((e) => [c1, c2].map((c, i) => claimOn(c, e.id, `rc${i}`))));
    expect(claims.filter(Boolean)).toHaveLength(6); // one claim per event
    for (const e of events) expect((await facts(e.id)).attempts).toBe(2);
  }, 60000);

  it('recovery racing fresh claims never double-claims: each recovered event ends with exactly one owner', async () => {
    const events = [];
    for (let i = 0; i < 6; i += 1) { const e = await mk(); await claimOn(c1, e.id, 'y', 60); await expireLease(e.id); events.push(e); }
    const ids = new Set(events.map((e) => e.id));
    const claimed = [];
    await Promise.all([
      ...[c1, c2].map(async (client, index) => { for (let i = 0; i < 8; i += 1) await store.recoverExpiredLeases(client); return index; }),
      ...[c3, c4].map(async (client, index) => {
        const worker = workerName(`race${index}`);
        for (let pass = 0; pass < 12; pass += 1) {
          for (const id of (await store.findDueIds(client, 100)).filter((x) => ids.has(x))) { const claim = await store.claim(client, { id, workerId: worker, leaseSeconds: 60 }); if (claim) claimed.push(claim); }
          await sleep(15);
        }
      }),
    ]);
    expect(new Set(claimed.map((c) => c.id)).size).toBe(claimed.length); // no event claimed twice
    for (const claim of claimed) expect(claim.attempts).toBe(2);
    for (const e of events) {
      const f = await facts(e.id);
      expect(['processing', 'received']).toContain(f.status);
      if (f.status === 'processing') expect(f.lockedBy).toBe(claimed.find((c) => c.id === e.id).workerId);
    }
  }, 60000);
});

describe('the valid lease owner completes processing', () => {
  it('writes the result once: the status, the code and processed_at are recorded and the lease is released', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'ok');
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(1);
    expect(await facts(e.id)).toMatchObject({ status: 'processed', lastError: null, hasProcessedAt: true, hasLease: false, lockedBy: null });
  });

  it.each(['processed', 'ignored', 'failed'])('a final "%s" event is never listed or claimed again', async (status) => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'fin');
    expect(await store.writeResult(main, claim, { status, lastError: status === 'processed' ? null : 'some_reason' })).toBe(1);
    expect(await store.findDueIds(main, 100)).not.toContain(e.id);
    for (const c of [c1, c2, c3]) expect(await claimOn(c, e.id)).toBeNull();
    await store.recoverExpiredLeases(c4); // and recovery does not resurrect it either
    expect((await facts(e.id)).status).toBe(status);
    expect((await facts(e.id)).hasProcessedAt).toBe(true);
  });

  it('a second result for the same claim is refused: the first result stands', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'twice');
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(1);
    expect(await store.writeResult(c1, claim, { status: 'failed', lastError: 'late' })).toBe(0);
    expect((await facts(e.id)).status).toBe('processed');
  });

  it('two results written at the very same moment for the same claim: exactly one wins', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'dup');
    const [a, b] = await Promise.all([store.writeResult(c2, claim, { status: 'processed' }), store.writeResult(c3, claim, { status: 'failed', lastError: 'other' })]);
    expect([a, b].sort()).toEqual([0, 1]);
    const f = await facts(e.id);
    expect(f.status).toBe(a === 1 ? 'processed' : 'failed');
  });

  it('last_error is stored as a short sanitised code', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'code');
    await store.writeResult(c1, claim, { status: 'ignored', lastError: "bad payload: it's 'x'; DROP -- secret" });
    expect((await facts(e.id)).lastError).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });
});

describe('an expired or stale lease owner cannot overwrite a newer result', () => {
  it('a wrong owner or a wrong attempt number cannot write, and the lease holder keeps the event', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'owner');
    expect(await store.writeResult(c2, { ...claim, workerId: workerName('imposter') }, { status: 'processed' })).toBe(0);
    expect(await store.writeResult(c2, { ...claim, attempts: claim.attempts + 1 }, { status: 'processed' })).toBe(0);
    expect(await store.writeResult(c2, { ...claim, attempts: claim.attempts - 0 + 5 }, { status: 'processed' })).toBe(0);
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: claim.workerId });
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(1);
  });

  it('a holder whose lease EXPIRED cannot write, even if nobody has taken the event over yet', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'expired', 60);
    await expireLease(e.id);
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(0);
    expect((await facts(e.id)).status).toBe('processing'); // untouched
  });

  it('the stalled worker cannot overwrite the worker that took over, whichever order they finish in', async () => {
    const e = await mk();
    const stale = await claimOn(c1, e.id, 'stale', 60);
    await expireLease(e.id);
    await store.recoverExpiredLeases(c2);
    const fresh = await claimOn(c2, e.id, 'fresh', 60);
    expect(fresh.attempts).toBe(2);

    expect(await store.writeResult(c1, stale, { status: 'failed', lastError: 'stale_failure' })).toBe(0); // the stalled worker wakes up: refused
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: fresh.workerId });
    expect(await store.writeResult(c2, fresh, { status: 'processed' })).toBe(1); // the new owner finishes
    expect(await store.writeResult(c1, stale, { status: 'failed', lastError: 'stale_failure' })).toBe(0); // and the stale one is refused again, now the row is final
    expect(await store.writeResult(c1, stale, { status: 'received', delaySeconds: 0 })).toBe(0);
    expect(await facts(e.id)).toMatchObject({ status: 'processed', lastError: null });
  });

  it('the stale owner racing the new owner at the same instant: only the new owner\'s result is recorded', async () => {
    const e = await mk();
    const stale = await claimOn(c1, e.id, 'stale2', 60);
    await expireLease(e.id);
    await store.recoverExpiredLeases(c2);
    const fresh = await claimOn(c2, e.id, 'fresh2', 60);
    const [staleWrite, freshWrite] = await Promise.all([store.writeResult(c1, stale, { status: 'failed', lastError: 'stale' }), store.writeResult(c2, fresh, { status: 'processed' })]);
    expect(staleWrite).toBe(0);
    expect(freshWrite).toBe(1);
    expect((await facts(e.id)).status).toBe('processed');
  });

  it('the stale owner\'s retry request is fenced too: it cannot reschedule or fail an event another worker owns', async () => {
    const e = await mk();
    const stale = await claimOn(c1, e.id, 'stale3', 60);
    await expireLease(e.id);
    await store.recoverExpiredLeases(c2);
    const fresh = await claimOn(c2, e.id, 'fresh3', 60);
    expect((await store.retryOrFail(c1, stale, { code: 'late' })).written).toBe(0);
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: fresh.workerId, attempts: 2 });
  });
});

describe('retry scheduling and next-attempt eligibility', () => {
  it('an unsuccessful attempt goes back to "received" with a database-clock delay of 60 s per attempt, and is not eligible until then', async () => {
    const e = await mk();
    const first = await claimOn(c1, e.id, 'retry1');
    const outcome = await store.retryOrFail(c1, first, { code: 'order_not_found_yet' });
    expect(outcome).toEqual({ status: 'received', delaySeconds: 60, written: 1 });
    const f = await facts(e.id);
    expect(f).toMatchObject({ status: 'received', lastError: 'order_not_found_yet', hasLease: false, lockedBy: null, attempts: 1, due: false });
    expect(f.nextIn).toBeGreaterThanOrEqual(56);
    expect(f.nextIn).toBeLessThanOrEqual(60);
    expect(await store.findDueIds(main, 100)).not.toContain(e.id);
    expect(await claimOn(c2, e.id)).toBeNull(); // not due yet

    await makeDue(e.id); // time passes (on the database clock)
    expect(await store.findDueIds(main, 100)).toContain(e.id);
    const second = await claimOn(c2, e.id, 'retry2');
    expect(second.attempts).toBe(2);
    const again = await store.retryOrFail(c2, second, { code: 'order_not_found_yet' });
    expect(again.delaySeconds).toBe(120); // the delay grows with the attempt
    expect((await facts(e.id)).nextIn).toBeGreaterThanOrEqual(116);
  });

  it('the delay is capped at 15 minutes', async () => {
    const e = await mk();
    await claimOn(c1, e.id, 'cap');
    await setAttempts(e.id, 7);
    const claim = { id: e.id, attempts: 7, workerId: (await facts(e.id)).lockedBy };
    const outcome = await store.retryOrFail(c1, claim, { code: 'x' });
    expect(outcome).toMatchObject({ status: 'received', delaySeconds: 420 });
    const big = await mk();
    const bigClaim = await claimOn(c1, big.id, 'cap2');
    await main.$executeRaw`UPDATE integration_inbox SET attempts = 15 WHERE id = ${big.id}`;
    const r = await store.writeResult(c1, { ...bigClaim, attempts: 15 }, { status: 'received', delaySeconds: store.retryDelaySeconds(15) });
    expect(r).toBe(1);
    expect((await facts(big.id)).nextIn).toBeLessThanOrEqual(900);
    expect((await facts(big.id)).nextIn).toBeGreaterThanOrEqual(896);
  });
});

describe('the maximum-attempt policy and the final failure state', () => {
  it('seven unsuccessful attempts are retried; the eighth is a FINAL failure that is never claimed again', async () => {
    const e = await mk();
    for (let attempts = 1; attempts <= 8; attempts += 1) {
      const claim = await claimOn(c1, e.id, `cap${attempts}`);
      expect(claim.attempts).toBe(attempts);
      const outcome = await store.retryOrFail(c1, claim, { code: 'transient_error' });
      expect(outcome.written).toBe(1);
      if (attempts < 8) { expect(outcome.status).toBe('received'); await makeDue(e.id); } else { expect(outcome.status).toBe('failed'); }
    }
    expect(await facts(e.id)).toMatchObject({ status: 'failed', attempts: 8, lastError: 'transient_error', hasProcessedAt: true, hasLease: false });
    expect(await claimOn(c2, e.id)).toBeNull();
    await makeDue(e.id);
    expect(await store.findDueIds(main, 100)).not.toContain(e.id);
    await store.recoverExpiredLeases(c3);
    expect((await facts(e.id)).status).toBe('failed'); // recovery does not revive it
  }, 60000);
});

describe('Bitrix24 events are never touched by the Razorpay worker infrastructure', () => {
  it('a due Bitrix24 event is not listed and not claimable, whatever id it is given; it stays exactly as it was', async () => {
    const b = await mkBitrix();
    expect(await store.findDueIds(main, 100)).not.toContain(b.id);
    expect(await store.claim(c1, { id: b.id, workerId: workerName('rz'), leaseSeconds: 60 })).toBeNull();
    expect(await facts(b.id)).toMatchObject({ status: 'received', attempts: 0, hasLease: false, lockedBy: null });
    // the Razorpay event next to it IS claimable: the isolation is by source, not by luck
    const e = await mk();
    expect(await claimOn(c1, e.id)).not.toBeNull();
    expect((await facts(b.id)).status).toBe('received');
  });

  it('a Bitrix24 event that is being processed cannot be finished, retried or failed with a Razorpay claim, even with a matching worker and attempt', async () => {
    const worker = workerName('bx');
    const b = await mkBitrix({ status: 'processing', attempts: 1, lockedBy: worker, lockedUntil: new Date(Date.now() + 300000) });
    const forged = { id: b.id, workerId: worker, attempts: 1 };
    expect(await store.writeResult(c1, forged, { status: 'processed' })).toBe(0);
    expect(await store.writeResult(c1, forged, { status: 'failed', lastError: 'x' })).toBe(0);
    expect((await store.retryOrFail(c1, forged, { code: 'x' })).written).toBe(0);
    expect(await facts(b.id)).toMatchObject({ status: 'processing', attempts: 1, lockedBy: worker });
  });

  it('Razorpay lease recovery does not touch a Bitrix24 event with an expired lease, nor does it fail one that used every attempt', async () => {
    const stalled = await mkBitrix({ status: 'processing', attempts: 2, lockedBy: workerName('bx2'), lockedUntil: new Date(Date.now() + 300000) });
    const spent = await mkBitrix({ status: 'processing', attempts: 8, lockedBy: workerName('bx3'), lockedUntil: new Date(Date.now() + 300000) });
    await expireLease(stalled.id);
    await expireLease(spent.id);
    await store.recoverExpiredLeases(c2);
    expect(await facts(stalled.id)).toMatchObject({ status: 'processing', attempts: 2, hasLease: true });
    expect(await facts(spent.id)).toMatchObject({ status: 'processing', attempts: 8, lastError: null });
  });

  it('a Bitrix24 final or ignored row is untouched too, and other sources are equally invisible', async () => {
    const other = await mk({ source: 'somewhere_else' });
    expect(await store.findDueIds(main, 100)).not.toContain(other.id);
    expect(await claimOn(c1, other.id)).toBeNull();
    expect((await facts(other.id)).status).toBe('received');
  });
});

describe('database errors fail safely', () => {
  // A connection that fails on a chosen raw statement, to prove nothing half-happens.
  const failing = (client, { onExecute = false, onQuery = false } = {}) => {
    const wrapTx = (tx) => new Proxy(tx, {
      get(target, prop) {
        if (prop === '$executeRaw' && onExecute) return async () => { throw new Error('injected failure'); };
        if (prop === '$queryRaw' && onQuery) return async () => { throw new Error('injected failure'); };
        const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return new Proxy(client, {
      get(target, prop) {
        if (prop === '$transaction') return (fn, opts) => target.$transaction((tx) => fn(wrapTx(tx)), opts);
        // writeResult / retryOrFail call the raw methods directly on the client (not inside a transaction), so fail those too.
        if (prop === '$executeRaw' && onExecute) return async () => { throw new Error('injected failure'); };
        if (prop === '$queryRaw' && onQuery) return async () => { throw new Error('injected failure'); };
        const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };

  it('a claim whose UPDATE fails claims nothing: the event is still waiting, untouched, and a normal claim then succeeds', async () => {
    const e = await mk();
    const result = await attempt(store.claim(failing(c1, { onExecute: true }), { id: e.id, workerId: workerName('f1') }));
    expect(result.ok).toBe(false);
    expect(await facts(e.id)).toMatchObject({ status: 'received', attempts: 0, hasLease: false, lockedBy: null });
    expect(await claimOn(c2, e.id, 'ok')).not.toBeNull();
  });

  it('a claim whose lock query fails claims nothing either', async () => {
    const e = await mk();
    expect((await attempt(store.claim(failing(c1, { onQuery: true }), { id: e.id, workerId: workerName('f2') }))).ok).toBe(false);
    expect(await facts(e.id)).toMatchObject({ status: 'received', attempts: 0 });
  });

  it('a failing result write is not recorded: the worker keeps its lease and can still finish', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'f3');
    const result = await attempt(store.writeResult(failing(c1, { onExecute: true }), claim, { status: 'processed' }));
    expect(result.ok).toBe(false);
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: claim.workerId, leaseLive: true });
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(1);
  });

  it('the result commits or rolls back WITH the work: a transaction that writes the result and then fails leaves the event processing', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'f4');
    const result = await attempt(c2.$transaction(async (tx) => {
      expect(await store.writeResult(tx, claim, { status: 'processed' })).toBe(1); // recorded inside the transaction...
      throw new Error('the event\'s own changes failed'); // ...then the work fails
    }));
    expect(result.ok).toBe(false);
    expect(await facts(e.id)).toMatchObject({ status: 'processing', lockedBy: claim.workerId, hasProcessedAt: false }); // ...so nothing was recorded
    expect(await store.writeResult(c1, claim, { status: 'processed' })).toBe(1); // and the owner can still finish properly
  });

  it('a transaction that succeeds commits the result with the work', async () => {
    const e = await mk();
    const claim = await claimOn(c1, e.id, 'f5');
    await c2.$transaction(async (tx) => { expect(await store.writeResult(tx, claim, { status: 'processed' })).toBe(1); });
    expect((await facts(e.id)).status).toBe('processed');
  });

  it('a failing recovery sweep changes nothing', async () => {
    const e = await mk();
    await claimOn(c1, e.id, 'f6', 60);
    await expireLease(e.id);
    const result = await attempt(store.recoverExpiredLeases({ $executeRaw: async () => { throw new Error('injected failure'); } }));
    expect(result.ok).toBe(false);
    expect((await facts(e.id)).status).toBe('processing');
    expect((await store.recoverExpiredLeases(c1)).again).toBeGreaterThanOrEqual(1);
    expect((await facts(e.id)).status).toBe('received');
  });
});
