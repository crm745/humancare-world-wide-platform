/* global describe, it, expect, beforeAll, afterAll */
// Phase 2B: the REAL MySQL behaviour of the Private Charter integration (transactions, row locks, compare-and-swap,
// outbox/inbox leases and fencing, per-Case ordering, duplicate prevention). Nothing is mocked: the application's own
// store functions run against humancare_test, using SEPARATE Prisma clients (separate MySQL connections) wherever
// concurrency matters. Only synthetic PHASE2B_TEST_<runid> records are written, each id is registered, and cleanup
// deletes those exact ids in reverse foreign-key order (see helpers/phase2b-fixture.js).
const fs = require('fs');
const guard = require('../../src/common/safety/integration-runner-guard');
const outbox = require('../../src/modules/bitrix/deal-outbox.store');
const inbox = require('../../src/modules/bitrix/deal-inbox.store');
const { dealRecoveryIdempotencyKey } = require('../../src/modules/bitrix/deal-outbox');
const { Phase2bFixture, sleep } = require('./helpers/phase2b-fixture');

const f = new Phase2bFixture();
let main; let baseline; let cleanupReport; let afterSnapshot; let remaining;

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const attempt = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
const isDup = (r) => !r.ok && r.error && r.error.code === 'P2002';
const exactlyOne = (results) => results.filter((r) => r.ok).length;

async function mkCase(db, label = 'CASE') {
  const row = await db.case.create({ data: { referenceNumber: f.name(label), patientName: f.name('PATIENT'), serviceType: 'PHASE2B synthetic', origin: 'Synthetic-A', destination: 'Synthetic-B' } });
  f.track('case', row.id);
  return row;
}
async function mkEvent(db, { entityId, key, status = 'pending', caseId = null, lastError = null, lockedUntil = null, callStarted = null } = {}) {
  const row = await db.integrationOutbox.create({
    data: {
      eventType: 'bitrix.deal.create', entityType: 'case', entityId: entityId || f.name('ENT'), caseId, idempotencyKey: key || f.name('KEY'),
      payload: { synthetic: true }, status, nextAttemptAt: new Date(0), lastError, lockedUntil, lockedBy: lockedUntil ? 'PHASE2B_HOLDER' : null, externalCallStartedAt: callStarted,
    },
  });
  f.track('outbox', row.id);
  return row;
}
async function mkInbox(db) {
  const row = await db.integrationInbox.create({
    data: { source: 'bitrix24', externalEventId: f.name('EVT'), eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: f.name('DEAL'), payload: { synthetic: true }, status: 'received', nextAttemptAt: new Date(0) },
  });
  f.track('inbox', row.id);
  return row;
}
const outboxRow = (db, id) => db.integrationOutbox.findUnique({ where: { id } });
const inboxRow = (db, id) => db.integrationInbox.findUnique({ where: { id } });
const claimArgs = (id, workerId, leaseSeconds = 120, fromStatus = 'pending') => ({ id, fromStatus, workerId, leaseSeconds });

beforeAll(async () => {
  guard.assertIntegrationEnvironment(process.env); // opt-in, humancare_test URL, ordinary test rules, Bitrix off
  main = f.newClient('main');
  // The identity guard, again, BEFORE any write: the server must say humancare_test, as a confined test account.
  const live = await guard.verifyLiveIdentity(main);
  expect(live.database).toBe('humancare_test');
  baseline = await f.snapshot(main);
  // The lease-recovery sweeps are set-based: they must have nothing but our rows to look at.
  expect(baseline.counts.integration_outbox).toBe(0);
  expect(baseline.counts.integration_inbox).toBe(0);
  f.note('setup', { database: live.database, account: live.account, runId: f.runId, prefix: f.prefix, baselineTotalRows: Object.values(baseline.counts).reduce((a, b) => a + b, 0), connection: await f.connectionInfo(main) });
}, 60000);

afterAll(async () => {
  try {
    // Rows that belong to a synthetic Case (stage events, audits, links, outbox) are registered by exact id first.
    const caseIds = [...new Set(f.ids.case)];
    if (caseIds.length) {
      const list = caseIds.join(',');
      for (const [kind, table] of [['stage', 'case_stage_events'], ['audit', 'audit_logs'], ['link', 'bitrix_deal_links'], ['outbox', 'integration_outbox']]) {
        const rows = await main.$queryRawUnsafe(`SELECT id FROM ${table} WHERE case_id IN (${list})`);
        for (const row of rows) if (!f.ids[kind].includes(Number(row.id))) f.track(kind, row.id);
      }
    }
    cleanupReport = await f.cleanup(main);
    remaining = await f.remaining(main);
    afterSnapshot = await f.snapshot(main);
    f.note('cleanup', { cleanupReport, remaining, createdIds: f.ids, countsEqualBaseline: JSON.stringify(afterSnapshot.counts) === JSON.stringify(baseline.counts), checksumsEqualBaseline: JSON.stringify(afterSnapshot.checksums) === JSON.stringify(baseline.checksums), baselineChecksums: baseline.checksums, afterChecksums: afterSnapshot.checksums, baselineCounts: baseline.counts, afterCounts: afterSnapshot.counts });
  } finally {
    if (process.env.PHASE2B_EVIDENCE_FILE) fs.writeFileSync(process.env.PHASE2B_EVIDENCE_FILE, JSON.stringify(f.evidence, null, 1));
    await f.disconnectAll();
  }
  expect(cleanupReport.failures).toEqual([]);
  expect(remaining).toEqual({ audit: 0, stage: 0, link: 0, outbox: 0, inbox: 0, case: 0 });
  expect(afterSnapshot.counts).toEqual(baseline.counts); // every pre-existing table has exactly its old row count
  expect(afterSnapshot.checksums).toEqual(baseline.checksums); // and unchanged contents in every touched table
  if (fs.existsSync(f.registryFile)) fs.rmSync(f.registryFile);
}, 120000);

describe('transactions', () => {
  it('T1 commit persists the synthetic changes and is visible from a second connection', async () => {
    const a = f.newClient('T1-writer'); const b = f.newClient('T1-reader');
    let caseId;
    await a.$transaction(async (tx) => {
      const c = await tx.case.create({ data: { referenceNumber: f.name('T1'), patientName: f.name('PATIENT'), serviceType: 'PHASE2B', origin: 'A', destination: 'B' } });
      caseId = c.id; f.track('case', c.id);
      const key = f.name('T1KEY');
      await tx.caseStageEvent.create({ data: { caseId: c.id, stage: 'phase2b', idempotencyKey: key } });
      await tx.bitrixDealLink.create({ data: { caseId: c.id, syncStatus: 'pending' } });
    }, { timeout: 20000 });
    const seen = await b.$queryRaw`SELECT (SELECT COUNT(*) FROM cases WHERE id = ${caseId}) AS c, (SELECT COUNT(*) FROM case_stage_events WHERE case_id = ${caseId}) AS e, (SELECT COUNT(*) FROM bitrix_deal_links WHERE case_id = ${caseId}) AS l`;
    f.note('T1 commit', { caseId, seenBySecondConnection: { cases: Number(seen[0].c), stageEvents: Number(seen[0].e), links: Number(seen[0].l) }, connections: [await f.connectionInfo(a), await f.connectionInfo(b)] });
    expect([Number(seen[0].c), Number(seen[0].e), Number(seen[0].l)]).toEqual([1, 1, 1]);
  });

  it('T2 rollback leaves nothing behind (checked from a second connection)', async () => {
    const a = f.newClient('T2-writer'); const b = f.newClient('T2-reader');
    const reference = f.name('T2ROLLBACK');
    const key = f.name('T2KEY');
    const outcome = await attempt(a.$transaction(async (tx) => {
      const c = await tx.case.create({ data: { referenceNumber: reference, patientName: f.name('PATIENT'), serviceType: 'PHASE2B', origin: 'A', destination: 'B' } });
      await tx.caseStageEvent.create({ data: { caseId: c.id, stage: 'phase2b', idempotencyKey: key } });
      await tx.integrationOutbox.create({ data: { eventType: 'bitrix.deal.create', entityType: 'case', entityId: f.name('ENT'), idempotencyKey: key, status: 'pending', nextAttemptAt: new Date(0) } });
      throw new Error('PHASE2B simulated failure');
    }, { timeout: 20000 }));
    const left = await b.$queryRaw`SELECT (SELECT COUNT(*) FROM cases WHERE reference_number = ${reference}) AS c, (SELECT COUNT(*) FROM case_stage_events WHERE idempotency_key = ${key}) AS e, (SELECT COUNT(*) FROM integration_outbox WHERE idempotency_key = ${key}) AS o`;
    f.note('T2 rollback', { transactionResult: outcome.ok ? 'committed' : String(outcome.error.message), leftBehind: { cases: Number(left[0].c), stageEvents: Number(left[0].e), outbox: Number(left[0].o) } });
    expect(outcome.ok).toBe(false);
    expect([Number(left[0].c), Number(left[0].e), Number(left[0].o)]).toEqual([0, 0, 0]);
  });
});

describe('row locking and compare-and-swap', () => {
  it('T3 a held row lock blocks a second connection until commit; NOWAIT fails at once; SKIP LOCKED skips', async () => {
    const c = await mkCase(main, 'T3');
    const a = f.newClient('T3-holder'); const b = f.newClient('T3-waiter'); const n = f.newClient('T3-nowait');
    const locked = deferred(); const release = deferred();
    const holder = a.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cases WHERE id = ${c.id} FOR UPDATE`;
      locked.resolve(Date.now());
      await release.promise;
      await tx.case.updateMany({ where: { id: c.id }, data: { stageVersion: { increment: 1 } } });
    }, { timeout: 20000 });
    await locked.promise;

    // NOWAIT and SKIP LOCKED while A still holds the lock.
    const t0 = Date.now();
    const nowait = await attempt(n.$transaction(async (tx) => tx.$queryRaw`SELECT id FROM cases WHERE id = ${c.id} FOR UPDATE NOWAIT`, { timeout: 20000 }));
    const nowaitMs = Date.now() - t0;
    const skipped = await n.$transaction(async (tx) => tx.$queryRaw`SELECT id FROM cases WHERE id = ${c.id} FOR UPDATE SKIP LOCKED`, { timeout: 20000 });

    // A blocking waiter.
    const waiterStart = Date.now();
    const waiter = b.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT stage_version AS v FROM cases WHERE id = ${c.id} FOR UPDATE`;
      return { waitedMs: Date.now() - waiterStart, version: Number(rows[0].v) };
    }, { timeout: 20000 });
    await sleep(1500);
    const stillBlocked = await Promise.race([waiter.then(() => false), sleep(50).then(() => true)]);
    release.resolve();
    await holder;
    const waited = await waiter;
    f.note('T3 row lock', { nowaitRejected: !nowait.ok, nowaitError: nowait.ok ? null : String(nowait.error.message).slice(0, 160), nowaitMs, skipLockedRows: skipped.length, waiterStillBlockedWhileHeld: stillBlocked, waiterWaitedMs: waited.waitedMs, versionSeenAfterWait: waited.version, connections: [await f.connectionInfo(a), await f.connectionInfo(b), await f.connectionInfo(n)] });
    expect(nowait.ok).toBe(false);
    expect(nowaitMs).toBeLessThan(1500);
    expect(skipped).toEqual([]);
    expect(stillBlocked).toBe(true);
    expect(waited.waitedMs).toBeGreaterThanOrEqual(1300);
    expect(waited.version).toBe(1); // it saw the holder's COMMITTED change, not the old value
  });

  it('T4 compare-and-swap: of 8 concurrent updates from 4 connections exactly one wins', async () => {
    const c = await mkCase(main, 'T4');
    const clients = [1, 2, 3, 4].map((i) => f.newClient(`T4-${i}`));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => clients[i % 4].case.updateMany({
      where: { id: c.id, stageVersion: 0 }, data: { stageVersion: { increment: 1 }, charterStage: `PHASE2B_WINNER_${i}` },
    })));
    const row = await main.case.findUnique({ where: { id: c.id } });
    const wins = results.map((r) => r.count);
    f.note('T4 CAS', { rowsChangedPerAttempt: wins, finalStageVersion: row.stageVersion, finalCharterStage: row.charterStage, connections: await Promise.all(clients.map((x) => f.connectionInfo(x))) });
    expect(wins.reduce((a, b) => a + b, 0)).toBe(1);
    expect(row.stageVersion).toBe(1);
    expect(row.charterStage).toMatch(/^PHASE2B_WINNER_/);
  });

  describe('T5 a stage-change-shaped transaction (lock, check, event, CAS, audit)', () => {
    const run = (client, caseId, key, failAfter = false) => client.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw`SELECT id, stage_version FROM cases WHERE id = ${caseId} FOR UPDATE`;
      const dup = await tx.caseStageEvent.findFirst({ where: { caseId, idempotencyKey: key }, select: { id: true } });
      if (dup) return { result: 'duplicate' };
      const event = await tx.caseStageEvent.create({ data: { caseId, stage: 'phase2b_stage', note: null, idempotencyKey: key, actorType: 'system', source: 'phase2b' } });
      const cas = await tx.case.updateMany({ where: { id: caseId, stageVersion: Number(current.stage_version) }, data: { charterStage: 'phase2b_stage', stageVersion: { increment: 1 } } });
      if (cas.count !== 1) throw new Error('compare-and-swap lost');
      const audit = await tx.auditLog.create({ data: { caseId, entityType: 'case', entityId: String(caseId), action: 'phase2b.test', actorType: 'system', source: 'phase2b', idempotencyKey: key } });
      if (failAfter) throw new Error('PHASE2B simulated failure');
      return { result: 'applied', eventId: event.id, auditId: audit.id };
    }, { timeout: 20000 });

    it('commit applies everything together', async () => {
      const c = await mkCase(main, 'T5A'); const a = f.newClient('T5A'); const r = f.newClient('T5A-reader');
      const key = f.name('T5KEY');
      const out = await run(a, c.id, key);
      f.track('stage', out.eventId); f.track('audit', out.auditId);
      const row = await r.case.findUnique({ where: { id: c.id } });
      f.note('T5 commit', { out, stageVersion: row.stageVersion, charterStage: row.charterStage });
      expect(out.result).toBe('applied');
      expect([row.stageVersion, row.charterStage]).toEqual([1, 'phase2b_stage']);
    });

    it('a failure after the writes rolls EVERYTHING back (no event, no audit, no version change)', async () => {
      const c = await mkCase(main, 'T5B'); const a = f.newClient('T5B'); const r = f.newClient('T5B-reader');
      const key = f.name('T5KEY');
      const out = await attempt(run(a, c.id, key, true));
      const seen = await r.$queryRaw`SELECT (SELECT stage_version FROM cases WHERE id = ${c.id}) AS v, (SELECT COUNT(*) FROM case_stage_events WHERE case_id = ${c.id}) AS e, (SELECT COUNT(*) FROM audit_logs WHERE case_id = ${c.id}) AS a`;
      f.note('T5 rollback', { failed: !out.ok, stageVersion: Number(seen[0].v), events: Number(seen[0].e), audits: Number(seen[0].a) });
      expect(out.ok).toBe(false);
      expect([Number(seen[0].v), Number(seen[0].e), Number(seen[0].a)]).toEqual([0, 0, 0]);
    });

    it('three concurrent duplicates of the same transition: one applies, the others see it and do nothing', async () => {
      const c = await mkCase(main, 'T5C'); const clients = [1, 2, 3].map((i) => f.newClient(`T5C-${i}`));
      const key = f.name('T5KEY');
      const outs = await Promise.all(clients.map((x) => run(x, c.id, key)));
      for (const o of outs) if (o.result === 'applied') { f.track('stage', o.eventId); f.track('audit', o.auditId); }
      const row = await main.case.findUnique({ where: { id: c.id } });
      const counts = await main.$queryRaw`SELECT (SELECT COUNT(*) FROM case_stage_events WHERE case_id = ${c.id}) AS e, (SELECT COUNT(*) FROM audit_logs WHERE case_id = ${c.id}) AS a`;
      f.note('T5 duplicates', { results: outs.map((o) => o.result), stageVersion: row.stageVersion, stageEvents: Number(counts[0].e), audits: Number(counts[0].a) });
      expect(outs.filter((o) => o.result === 'applied')).toHaveLength(1);
      expect(outs.filter((o) => o.result === 'duplicate')).toHaveLength(2);
      expect([row.stageVersion, Number(counts[0].e), Number(counts[0].a)]).toEqual([1, 1, 1]);
    });
  });
});

describe('outbox leases and fencing (the application\'s own store functions)', () => {
  it('T6 four connections race to claim one event: exactly one wins, with a database-clock lease', async () => {
    const e = await mkEvent(main, { entityId: f.name('ENT-T6') });
    const clients = [1, 2, 3, 4].map((i) => f.newClient(`T6-${i}`));
    const claims = await Promise.all(clients.map((c, i) => outbox.claim(c, claimArgs(e.id, `PHASE2B-W${i + 1}`))));
    const winners = claims.filter(Boolean);
    const row = await outboxRow(main, e.id);
    const [lease] = await main.$queryRaw`SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), locked_until) AS s, UTC_TIMESTAMP(3) AS now FROM integration_outbox WHERE id = ${e.id}`;
    f.note('T6 claim race', { winners: winners.map((w) => w.workerId), results: claims.map((c) => (c ? 'claimed' : 'null')), status: row.status, attempts: row.attempts, lockedBy: row.lockedBy, leaseSecondsRemaining: Number(lease.s), dbUtcNow: lease.now.toISOString(), connections: await Promise.all(clients.map((x) => f.connectionInfo(x))) });
    expect(winners).toHaveLength(1);
    expect(row).toMatchObject({ status: 'processing', attempts: 1, lockedBy: winners[0].workerId });
    expect(Number(lease.s)).toBeGreaterThanOrEqual(115);
    expect(Number(lease.s)).toBeLessThanOrEqual(120);
    expect(await outbox.writeResult(main, winners[0], { status: 'completed' })).toBe(1);
  });

  it('T7 fencing: wrong owner / wrong attempt / expired lease write 0 rows; recovery distinguishes the three cases; a stale holder never overwrites', async () => {
    const plain = await mkEvent(main, { entityId: f.name('ENT-T7A') });
    const called = await mkEvent(main, { entityId: f.name('ENT-T7B') });
    const failed = await mkEvent(main, { entityId: f.name('ENT-T7C'), status: 'failed', lastError: 'mapping:phase2b', callStarted: new Date() });
    const tooShort = await mkEvent(main, { entityId: f.name('ENT-T7D') });
    const a = f.newClient('T7-A'); const b = f.newClient('T7-B');

    const claimPlain = await outbox.claim(a, claimArgs(plain.id, 'PHASE2B-A', 2));
    const claimCalled = await outbox.claim(a, claimArgs(called.id, 'PHASE2B-A', 2));
    const claimShort = await outbox.claim(a, claimArgs(tooShort.id, 'PHASE2B-A', 12));
    expect([claimPlain, claimCalled, claimShort].every(Boolean)).toBe(true);

    // Before expiry: only the exact owner and attempt may write; the call marker needs a lease that outlives the call.
    const wrongOwner = await outbox.writeResult(main, { ...claimPlain, workerId: 'PHASE2B-X' }, { status: 'completed' });
    const wrongAttempt = await outbox.writeResult(main, { ...claimPlain, attempts: claimPlain.attempts + 1 }, { status: 'completed' });
    const markShort = await outbox.markExternalCallStarted(main, claimShort, 60); // lease 12 s < required 60 s
    const markOk = await outbox.markExternalCallStarted(main, claimCalled, 1);
    const markTwice = await outbox.markExternalCallStarted(main, claimCalled, 1); // evidence is written once, never overwritten

    await sleep(3500); // the 2 s leases are now over; nobody has re-claimed anything
    const expiredWrite = await outbox.writeResult(a, claimPlain, { status: 'completed' });
    const stillProcessing = (await outboxRow(main, plain.id)).status;

    const swept = await outbox.recoverExpiredLeases(main, { maxClaims: 10 });
    const afterSweep = { plain: await outboxRow(main, plain.id), called: await outboxRow(main, called.id), failed: await outboxRow(main, failed.id) };

    // A second worker re-claims; the first (stale) holder can no longer write; the new holder can.
    const reclaim = await outbox.claim(b, claimArgs(plain.id, 'PHASE2B-B', 60));
    const staleWrite = await outbox.writeResult(a, claimPlain, { status: 'failed', lastError: 'stale' });
    const newWrite = await outbox.writeResult(b, reclaim, { status: 'completed' });
    const staleAfter = await outbox.writeResult(a, claimPlain, { status: 'failed', lastError: 'stale-again' });
    const final = await outboxRow(main, plain.id);

    f.note('T7 fencing', { wrongOwner, wrongAttempt, markCallStartedWithTooShortLease: markShort, markCallStarted: markOk, markCallStartedTwice: markTwice, writeAfterExpiryWithNoReclaim: expiredWrite, statusAfterExpiredWrite: stillProcessing, sweepCounts: swept, statuses: { noCall: afterSweep.plain.status, callStarted: afterSweep.called.status, failed: afterSweep.failed.status }, calledLastError: afterSweep.called.lastError, reclaimAttempts: reclaim && reclaim.attempts, staleHolderWrite: staleWrite, newHolderWrite: newWrite, staleWriteAfterCompletion: staleAfter, finalStatus: final.status });
    expect([wrongOwner, wrongAttempt]).toEqual([0, 0]);
    expect(markShort).toBe(false);
    expect([markOk, markTwice]).toEqual([true, false]);
    expect(expiredWrite).toBe(0);
    expect(stillProcessing).toBe('processing');
    expect(afterSweep.plain).toMatchObject({ status: 'pending', lockedBy: null, lockedUntil: null }); // (a) no call started -> pending
    expect(afterSweep.called).toMatchObject({ status: 'ambiguous', lastError: 'lease_expired_during_external_call' }); // (b) call started -> ambiguous
    expect(afterSweep.called.externalCallStartedAt).not.toBeNull();
    expect(afterSweep.failed.status).toBe('failed'); // (c) a failed event is left alone
    expect(reclaim).toMatchObject({ attempts: 2, workerId: 'PHASE2B-B' });
    expect([staleWrite, newWrite, staleAfter]).toEqual([0, 1, 0]);
    expect(final.status).toBe('completed');
    // The still-live 12 s lease of "tooShort" was not touched by the sweep that ran at ~3.5 s.
    expect((await outboxRow(main, tooShort.id)).status).toBe('processing');
    expect(await outbox.writeResult(main, claimShort, { status: 'completed' })).toBe(1);
  });

  describe('T8 per-Case ordering', () => {
    const blockedBy = async (earlierStatus, extra = {}) => {
      const entityId = f.name('ENT-T8');
      const first = await mkEvent(main, { entityId, status: earlierStatus, ...extra });
      const later = await mkEvent(main, { entityId });
      const claim = await outbox.claim(main, claimArgs(later.id, 'PHASE2B-ORD'));
      if (claim) await outbox.writeResult(main, claim, { status: 'completed' });
      return { first, later, claimed: Boolean(claim) };
    };
    it.each([
      ['pending'], ['processing'], ['ambiguous'], ['failed'],
    ])('a later event is NOT claimed while an earlier event of the same entity is %s', async (status) => {
      const extra = status === 'processing' ? { lockedUntil: new Date(Date.now() + 3600 * 1000) } : {};
      const r = await blockedBy(status, extra);
      f.note(`T8 earlier ${status}`, { laterClaimed: r.claimed });
      expect(r.claimed).toBe(false);
      expect((await outboxRow(main, r.later.id)).status).toBe('pending');
    });
    it('a later event IS claimed once the earlier one is completed; other entities are never blocked', async () => {
      const done = await blockedBy('completed');
      const other = await mkEvent(main, { entityId: f.name('ENT-OTHER') });
      const claimOther = await outbox.claim(main, claimArgs(other.id, 'PHASE2B-ORD'));
      f.note('T8 completed earlier', { laterClaimed: done.claimed, otherEntityClaimed: Boolean(claimOther) });
      expect(done.claimed).toBe(true);
      expect(claimOther).toBeTruthy();
      await outbox.writeResult(main, claimOther, { status: 'completed' });
    });
    it('a recovery decision releases a failed event for its own replacement, and for later events only once the replacement completed', async () => {
      const entityId = f.name('ENT-T8R');
      const failed = await mkEvent(main, { entityId, status: 'failed', lastError: 'mapping:phase2b' });
      const replacement = await mkEvent(main, { entityId, key: dealRecoveryIdempotencyKey(entityId, failed.id) });
      const later = await mkEvent(main, { entityId });
      const laterWhileReplacementPending = await outbox.claim(main, claimArgs(later.id, 'PHASE2B-ORD'));
      const claimReplacement = await outbox.claim(main, claimArgs(replacement.id, 'PHASE2B-ORD'));
      const laterWhileReplacementRunning = await outbox.claim(main, claimArgs(later.id, 'PHASE2B-ORD'));
      await outbox.writeResult(main, claimReplacement, { status: 'completed' });
      const laterAfterCompleted = await outbox.claim(main, claimArgs(later.id, 'PHASE2B-ORD'));
      if (laterAfterCompleted) await outbox.writeResult(main, laterAfterCompleted, { status: 'completed' });
      f.note('T8 recovery replacement', { laterWhileReplacementPending: Boolean(laterWhileReplacementPending), replacementClaimed: Boolean(claimReplacement), laterWhileReplacementRunning: Boolean(laterWhileReplacementRunning), laterAfterReplacementCompleted: Boolean(laterAfterCompleted) });
      expect(laterWhileReplacementPending).toBeNull();
      expect(claimReplacement).toBeTruthy();
      expect(laterWhileReplacementRunning).toBeNull();
      expect(laterAfterCompleted).toBeTruthy();
    });
    it('an ambiguous event still reconciling blocks its replacement-looking successor; one in manual review does not', async () => {
      const reconciling = f.name('ENT-T8S'); const review = f.name('ENT-T8M');
      const a = await mkEvent(main, { entityId: reconciling, status: 'ambiguous', lastError: 'reconciling:no_match' });
      const aNext = await mkEvent(main, { entityId: reconciling, key: dealRecoveryIdempotencyKey(reconciling, a.id) });
      const m = await mkEvent(main, { entityId: review, status: 'ambiguous', lastError: 'manual_review_required:no_match_after_waiting_period' });
      const mNext = await mkEvent(main, { entityId: review, key: dealRecoveryIdempotencyKey(review, m.id) });
      const blocked = await outbox.claim(main, claimArgs(aNext.id, 'PHASE2B-ORD'));
      const released = await outbox.claim(main, claimArgs(mNext.id, 'PHASE2B-ORD'));
      if (released) await outbox.writeResult(main, released, { status: 'completed' });
      f.note('T8 ambiguous', { reconcilingBlocksSuccessor: blocked === null, manualReviewReleasesReplacement: Boolean(released) });
      expect(blocked).toBeNull();
      expect(released).toBeTruthy();
    });
  });
});

describe('duplicate prevention (database constraints under concurrent inserts)', () => {
  it('T9 one winner among concurrent inserts of the same unique key, for every unique key the integration relies on', async () => {
    const c1 = await mkCase(main, 'T9A'); const c2 = await mkCase(main, 'T9B');
    const clients = [1, 2, 3, 4].map((i) => f.newClient(`T9-${i}`));
    const outboxKey = f.name('T9OUT'); const stageKey = f.name('T9STG'); const auditKey = f.name('T9AUD'); const eventId = f.name('T9EVT');
    const dealId = `P2B_${f.runId}_1`;

    const outboxResults = await Promise.all(clients.map((c) => attempt(c.integrationOutbox.create({ data: { eventType: 'bitrix.deal.create', entityType: 'case', entityId: f.name('ENT-T9'), idempotencyKey: outboxKey, status: 'pending', nextAttemptAt: new Date(0) } }))));
    outboxResults.filter((r) => r.ok).forEach((r) => f.track('outbox', r.value.id));
    const linkResults = await Promise.all(clients.map((c) => attempt(c.bitrixDealLink.create({ data: { caseId: c1.id, syncStatus: 'pending' } }))));
    linkResults.filter((r) => r.ok).forEach((r) => f.track('link', r.value.id));
    const stageResults = await Promise.all(clients.map((c) => attempt(c.caseStageEvent.create({ data: { caseId: c1.id, stage: 'phase2b', idempotencyKey: stageKey } }))));
    stageResults.filter((r) => r.ok).forEach((r) => f.track('stage', r.value.id));
    const auditResults = await Promise.all(clients.map((c) => attempt(c.auditLog.create({ data: { caseId: c1.id, entityType: 'case', entityId: String(c1.id), action: 'phase2b.test', actorType: 'system', source: 'phase2b', idempotencyKey: auditKey } }))));
    auditResults.filter((r) => r.ok).forEach((r) => f.track('audit', r.value.id));
    const inboxResults = await Promise.all(clients.map((c) => attempt(c.integrationInbox.create({ data: { source: 'bitrix24', externalEventId: eventId, eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: f.name('DEAL'), status: 'ignored', nextAttemptAt: new Date(0) } }))));
    inboxResults.filter((r) => r.ok).forEach((r) => f.track('inbox', r.value.id));

    // One Deal ID can belong to one Case only: give it to c1, then try c2.
    const linkOfC1 = await main.bitrixDealLink.findUnique({ where: { caseId: c1.id } });
    await main.bitrixDealLink.update({ where: { id: linkOfC1.id }, data: { bitrixDealId: dealId } });
    const linkC2 = await attempt(main.bitrixDealLink.create({ data: { caseId: c2.id, bitrixDealId: dealId, syncStatus: 'pending' } }));
    if (linkC2.ok) f.track('link', linkC2.value.id);

    const summary = {
      outboxIdempotencyKey: { winners: exactlyOne(outboxResults), duplicateErrors: outboxResults.filter(isDup).length },
      oneLinkPerCase: { winners: exactlyOne(linkResults), duplicateErrors: linkResults.filter(isDup).length },
      stageEventPerCaseKey: { winners: exactlyOne(stageResults), duplicateErrors: stageResults.filter(isDup).length },
      auditEntityKey: { winners: exactlyOne(auditResults), duplicateErrors: auditResults.filter(isDup).length },
      inboxSourceEventId: { winners: exactlyOne(inboxResults), duplicateErrors: inboxResults.filter(isDup).length },
      oneDealIdPerCase: { secondCaseAccepted: linkC2.ok, duplicateError: isDup(linkC2) },
    };
    f.note('T9 duplicates', summary);
    for (const [name, value] of Object.entries(summary)) {
      if (name === 'oneDealIdPerCase') { expect(value).toEqual({ secondCaseAccepted: false, duplicateError: true }); continue; }
      expect({ name, ...value }).toEqual({ name, winners: 1, duplicateErrors: 3 });
    }
    const rows = await main.$queryRaw`SELECT (SELECT COUNT(*) FROM integration_outbox WHERE idempotency_key = ${outboxKey}) AS o, (SELECT COUNT(*) FROM bitrix_deal_links WHERE case_id = ${c1.id}) AS l, (SELECT COUNT(*) FROM case_stage_events WHERE case_id = ${c1.id} AND idempotency_key = ${stageKey}) AS s, (SELECT COUNT(*) FROM audit_logs WHERE idempotency_key = ${auditKey}) AS a, (SELECT COUNT(*) FROM integration_inbox WHERE external_event_id = ${eventId}) AS i`;
    expect(Object.values(rows[0]).map(Number)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('inbox leases and fencing', () => {
  it('T10 four connections race to claim one inbox event: one wins; an expired holder cannot write; recovery returns it; the stale holder never overwrites', async () => {
    const e = await mkInbox(main);
    const clients = [1, 2, 3, 4].map((i) => f.newClient(`T10-${i}`));
    const claims = await Promise.all(clients.map((c, i) => inbox.claim(c, { id: e.id, workerId: `PHASE2B-I${i + 1}`, leaseSeconds: 2 })));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    const wrongOwner = await inbox.writeResult(main, { ...winner, workerId: 'PHASE2B-X' }, { status: 'processed' });
    await sleep(3500);
    const expiredWrite = await inbox.writeResult(main, winner, { status: 'processed' });
    const swept = await inbox.recoverExpiredLeases(main, { maxAttempts: 8 });
    const afterSweep = await inboxRow(main, e.id);
    const reclaim = await inbox.claim(clients[0], { id: e.id, workerId: 'PHASE2B-I9', leaseSeconds: 60 });
    const staleWrite = await inbox.writeResult(main, winner, { status: 'failed', lastError: 'stale' });
    const newWrite = await inbox.writeResult(main, reclaim, { status: 'processed' });
    const final = await inboxRow(main, e.id);
    f.note('T10 inbox', { claimResults: claims.map((c) => (c ? 'claimed' : 'null')), winner: winner.workerId, wrongOwnerWrite: wrongOwner, writeAfterExpiry: expiredWrite, sweepCounts: swept, statusAfterSweep: afterSweep.status, reclaimAttempts: reclaim && reclaim.attempts, staleHolderWrite: staleWrite, newHolderWrite: newWrite, finalStatus: final.status, connections: await Promise.all(clients.map((x) => f.connectionInfo(x))) });
    expect([wrongOwner, expiredWrite]).toEqual([0, 0]);
    expect(afterSweep).toMatchObject({ status: 'received', lockedBy: null });
    expect(reclaim).toMatchObject({ attempts: 2, workerId: 'PHASE2B-I9' });
    expect([staleWrite, newWrite]).toEqual([0, 1]);
    expect(final).toMatchObject({ status: 'processed', lockedBy: null });
  });
});
