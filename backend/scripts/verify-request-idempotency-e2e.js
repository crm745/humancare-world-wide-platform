// Real-database end-to-end verification of idempotent request submission (Phase 4), on humancare_dev ONLY.
//
//   node scripts/verify-request-idempotency-e2e.js check                         read-only preflight + import check (writes nothing)
//   node scripts/verify-request-idempotency-e2e.js run                           creates the test data and runs the checks (leaves the rows for the cleanup step)
//   node scripts/verify-request-idempotency-e2e.js cleanup <runId>               DRY RUN of the cleanup (default): validates ownership, markers, counts, dependent tables
//   node scripts/verify-request-idempotency-e2e.js cleanup <runId> --execute     deletes exactly the rows this run created, in dependency order
//
// What it uses: the REAL controller (submitRequest, getMyRequestByClientRequestId) and the REAL service (createRequest) on the REAL database. Bitrix is forced off and the review
// workflow is off, so no CRM call is made and only service_requests, cases and case_stage_events are written (plus the two dedicated test users).
// Failure injection (T10) wraps the real Prisma client with a query extension that throws for ONE flagged call; the transaction, the rollback and the unique index are MySQL's own.
//
// Isolation: two dedicated users (idem-verify-<runId>-a/b@example.invalid) and a run marker in every patient name. Nothing existing is read for the test, used or changed.
// Cleanup deletes only rows reachable from those two user ids AND carrying the marker, and refuses (deleting nothing) if anything is unexpected. Auto-increment values are never touched.
const path = require('path');
const fs = require('fs');

const mode = process.argv[2] || 'check';
const backend = path.join(__dirname, '..');
const stop = (message) => { console.error(`STOP: ${message}`); process.exit(2); };

if (process.env.DATABASE_URL) stop('DATABASE_URL is set in the shell environment; it would override backend/.env');
require('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
if (process.env.NODE_ENV === 'test') stop('NODE_ENV=test would make the application refuse any database but humancare_test');
process.env.BITRIX_SYNC_ENABLED = 'false'; // no CRM call, whatever .env says
delete process.env.PRIVATE_CHARTER_REVIEW_WORKFLOW; // the legacy path only
delete process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED;

const url = new URL(process.env.DATABASE_URL || 'mysql://none');
const urlDb = url.pathname.replace(/^\//, '');
if (urlDb !== 'humancare_dev' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || (url.port || '3306') !== '3306') stop(`the URL does not name humancare_dev on localhost:3306 (database "${urlDb}")`);

const { PrismaClient } = require('@prisma/client');
const base = new PrismaClient({ omit: { user: { passwordHash: true } } }); // reads and the dedicated test users
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const n = (v) => Number(v);
const READ = /^\s*SELECT\b/i;
const q = (sql, ...params) => { if (!READ.test(sql) || /;\s*\S/.test(sql)) throw new Error('refused: not a single SELECT'); return base.$queryRawUnsafe(sql, ...params); };
const BASELINE = { users: 10, requests: 29, cases: 43, events: 46 };
const marks = (runId) => ({ a: `idem-verify-${runId}-a@example.invalid`, b: `idem-verify-${runId}-b@example.invalid`, name: (s) => `IDEM-VERIFY ${runId} ${s}` });
const counts = async () => ({
  users: await base.user.count(), requests: await base.serviceRequest.count(), cases: await base.case.count(), events: await base.caseStageEvent.count(),
});
const autoInc = async () => Object.fromEntries((await q("SELECT table_name AS t, auto_increment AS a FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users','service_requests','cases','case_stage_events')")).map((r) => [r.t, n(r.a)]));
const inList = (ids) => ids.map(() => '?').join(',');

async function identityAndPreflight() {
  const [{ d, p }] = await q('SELECT DATABASE() AS d, @@port AS p');
  check('DATABASE() is exactly humancare_dev, on port 3306', d === 'humancare_dev' && n(p) === 3306, `${d}:${n(p)}`);
  if (d !== 'humancare_dev') stop('live database identity is not humancare_dev');
  const rec = await q("SELECT migration_name AS m FROM _prisma_migrations WHERE migration_name IN ('20261113000000_private_charter_m1_case_stage_fields','20261113000100_private_charter_m2_case_stage_event_fields','20261119130000_service_request_client_request_id') AND finished_at IS NOT NULL AND rolled_back_at IS NULL");
  check('M1, M2 and the client_request_id migration are recorded as applied', rec.length === 3, `${rec.length} of 3`);
  const pending = await q("SELECT COUNT(*) AS x FROM _prisma_migrations WHERE migration_name LIKE '2026111300%' AND migration_name NOT LIKE '20261113000000%' AND migration_name NOT LIKE '20261113000100%'");
  check('M3-M9 are NOT applied (untouched)', n(pending[0].x) === 0);
  const c = await counts();
  check(`baseline counts are ${BASELINE.users} users, ${BASELINE.requests} requests, ${BASELINE.cases} Cases, ${BASELINE.events} stage events`, c.users === BASELINE.users && c.requests === BASELINE.requests && c.cases === BASELINE.cases && c.events === BASELINE.events, JSON.stringify(c));
  const left = await q("SELECT COUNT(*) AS x FROM users WHERE email LIKE 'idem-verify-%@example.invalid'");
  check('no leftover test users from an earlier run', n(left[0].x) === 0, `${n(left[0].x)} found`);
  if (results.some((r) => !r.ok)) stop('preflight failed; nothing was written');
  return c;
}

// The real application modules, with the real Prisma client wrapped so ONE flagged call can fail. Must run before the service is required.
const fault = { mode: null, hits: 0 };
function loadApplication() {
  const extended = base.$extends({
    query: {
      caseStageEvent: { async create({ args, query }) { if (fault.mode === 'event') { fault.hits += 1; throw new Error('INJECTED FAILURE at the stage-event insert'); } return query(args); } },
      case: { async create({ args, query }) { if (fault.mode === 'case') { fault.hits += 1; throw new Error('INJECTED FAILURE at the Case insert'); } return query(args); } },
    },
  });
  const dbModule = require.resolve(path.join(backend, 'src', 'db', 'prisma.js'));
  require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: { prisma: extended } };
  const service = require(path.join(backend, 'src', 'modules', 'requests', 'requests.service.js'));
  const controller = require(path.join(backend, 'src', 'modules', 'requests', 'requests.controller.js'));
  return { service, controller };
}

(async () => {
  console.log(`mode: ${mode}   database: ${urlDb}@${url.hostname}:${url.port || '3306'}`);
  if (mode === 'check') {
    await identityAndPreflight();
    loadApplication();
    check('the real controller and service load (import chain) with Bitrix off', true);
    check('Bitrix sync is off in this process', process.env.BITRIX_SYNC_ENABLED === 'false');
  } else if (mode === 'run') {
    const baseline = await identityAndPreflight();
    const autoBefore = await autoInc();
    const { service, controller } = loadApplication();
    const runId = `idem${Date.now().toString(36)}`;
    const M = marks(runId);
    console.log(`RUN ID: ${runId}`);
    const manifest = { runId, userIds: [], baseline, autoBefore, startedAt: new Date().toISOString() };
    const manifestPath = process.env.E2E_MANIFEST;
    const save = () => { if (manifestPath) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); };

    // ---- the two dedicated users
    const userA = await base.user.create({ data: { name: M.name('A'), email: M.a } });
    manifest.userIds.push(userA.id); save();
    const userB = await base.user.create({ data: { name: M.name('B'), email: M.b } });
    manifest.userIds.push(userB.id); save();
    console.log(`dedicated users: A=${userA.id}, B=${userB.id}`);

    const uuid = (tail) => `1de40000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
    const inDays = (d) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dataOf = (marker, extra = {}) => ({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: M.name(marker), origin: 'Pune', destination: 'Mumbai', urgency: 'urgent_24h', ...extra });
    const body = (marker, extra = {}) => ({
      serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: M.name(marker), patientAge: '61', patientGender: 'Male', patientLocation: 'Pune', patientContact: '+91 98765 43210',
      origin: 'Pune', destination: 'Mumbai', country: 'India', preferredDate: inDays(3), careLevel: 'crit_icu', description: `${M.name(marker)} transport`, equipOxygen: true, equipOxygenLpm: 3, urgency: 'urgent_24h', ...extra,
    });
    const post = async (b, userId) => {
      const out = {};
      const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
      await controller.submitRequest({ body: b, user: { id: userId } }, res, (err) => { out.err = err; });
      return out;
    };
    const lookup = async (key, userId) => {
      const out = {};
      const res = { status(code) { out.status = code; return this; }, json(payload) { out.body = payload; return this; } };
      await controller.getMyRequestByClientRequestId({ params: { clientRequestId: key }, user: { id: userId } }, res, (err) => { out.err = err; });
      if (out.status === undefined && !out.err) out.status = 200;
      return out;
    };
    const rowsOf = async (userId, key) => {
      const requests = await base.serviceRequest.findMany({ where: { userId, ...(key ? { clientRequestId: key } : {}) }, orderBy: { id: 'asc' } });
      const cases = requests.length ? await base.case.findMany({ where: { serviceRequestId: { in: requests.map((r) => r.id) } }, orderBy: { id: 'asc' } }) : [];
      const events = cases.length ? await base.caseStageEvent.findMany({ where: { caseId: { in: cases.map((c) => c.id) } }, orderBy: { id: 'asc' } }) : [];
      return { requests, cases, events };
    };
    const totals = async () => { const a = await rowsOf(userA.id); const b = await rowsOf(userB.id); return { requests: a.requests.length + b.requests.length, cases: a.cases.length + b.cases.length, events: a.events.length + b.events.length }; };

    // ---- T1: normal creation
    const K1 = uuid(1);
    const first = await service.createRequest(userA.id, dataOf('T1'), { clientRequestId: K1 });
    let t = await rowsOf(userA.id, K1);
    check('T1 one request, one Case and one stage event were created', t.requests.length === 1 && t.cases.length === 1 && t.events.length === 1, `${t.requests.length}/${t.cases.length}/${t.events.length}`);
    check('T1 the request carries the key and a REQ- reference built from its id', t.requests[0].clientRequestId === K1 && t.requests[0].referenceNumber === `REQ-${1000 + t.requests[0].id}`, t.requests[0].referenceNumber);
    check('T1 the Case copies that reference and links to the request', t.cases[0].serviceRequestId === t.requests[0].id && t.cases[0].referenceNumber === t.requests[0].referenceNumber && t.cases[0].corporateId === null, t.cases[0].referenceNumber);
    check('T1 the first stage event is "submitted" with the standard note', t.events[0].stage === 'submitted' && t.events[0].note === 'Request received from patient app.', t.events[0].stage);
    check('T1 the new M1/M2 columns hold their defaults', t.cases[0].stageVersion === 0 && t.cases[0].charterStage === null && t.events[0].idempotencyKey === null && t.events[0].previousStage === null);
    check('T1 the returned request is the saved one', first.id === t.requests[0].id);

    // ---- T2: same user, same key, through the service
    const again = await service.createRequest(userA.id, dataOf('T1'), { clientRequestId: K1 });
    t = await rowsOf(userA.id, K1);
    check('T2 the same user and key return the ORIGINAL request, with nothing duplicated', again.id === first.id && t.requests.length === 1 && t.cases.length === 1 && t.events.length === 1);

    // ---- T3 / T6 / T7: the real controller
    const K2 = uuid(2);
    const c1 = await post({ ...body('T3'), clientRequestId: K2 }, userA.id);
    check('T3 controller: first submission with a key is 201', c1.status === 201 && !c1.err, String(c1.status));
    const c2 = await post({ ...body('T3'), clientRequestId: K2 }, userA.id);
    check('T3 controller: the same submission again is 200 with the same request', c2.status === 200 && c2.body.request.id === c1.body.request.id, `${c2.status}`);
    const c3 = await post({ ...body('T3', { preferredDate: '2020-01-01', urgency: 'not-a-real-urgency', patientAge: 'abc' }), clientRequestId: K2 }, userA.id);
    check('T3 controller: changed (now INVALID) data still returns the existing request: no validation, no duplicate', c3.status === 200 && c3.body.request.id === c1.body.request.id, `${c3.status}`);
    const c4 = await post({ ...body('T3'), clientRequestId: K2.toUpperCase() }, userA.id);
    check('T3 controller: the key is case-insensitive (the same UUID is the same key)', c4.status === 200 && c4.body.request.id === c1.body.request.id);
    t = await rowsOf(userA.id, K2);
    check('T3 exactly one request, Case and event exist for that key', t.requests.length === 1 && t.cases.length === 1 && t.events.length === 1, `${t.requests.length}/${t.cases.length}/${t.events.length}`);
    check('T3 the response never exposes the key', !JSON.stringify(c1.body).includes(K2));
    const c5 = await post({ ...body('T3', { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital' }), clientRequestId: K2 }, userA.id);
    check('T4 the same key for a DIFFERENT service is 409 client_request_id_reused, and nothing is created', c5.status === 409 && c5.body.code === 'client_request_id_reused', `${c5.status}`);
    t = await rowsOf(userA.id, K2);
    check('T4 still exactly one request for that key', t.requests.length === 1);

    const l1 = await lookup(K2, userA.id);
    check('T6 the owner finds the request by its key (200)', l1.status === 200 && l1.body.request.id === c1.body.request.id);
    const l2 = await lookup(K2, userB.id);
    check('T6 a NON-owner gets 404 for the same key', l2.status === 404, String(l2.status));
    const l3 = await lookup(uuid(999), userA.id);
    check('T6 an unknown (valid) key is 404', l3.status === 404);
    const l4 = await lookup('nope', userA.id);
    check('T7 a malformed key in the lookup is 400', l4.status === 400, String(l4.status));
    const before7 = await totals();
    const m1 = await post({ ...body('T7'), clientRequestId: 'not-a-uuid' }, userA.id);
    const m2 = await post({ ...body('T7'), clientRequestId: '' }, userA.id);
    const m3 = await post({ ...body('T7'), clientRequestId: 12345 }, userA.id);
    check('T7 a malformed key on submit is 400 with a field error, for text, empty and non-text values', [m1, m2, m3].every((r) => r.status === 400 && r.body.fields && r.body.fields.clientRequestId), [m1.status, m2.status, m3.status].join(','));
    const after7 = await totals();
    check('T7 nothing was created by the malformed submissions', JSON.stringify(before7) === JSON.stringify(after7));

    // ---- T5: same key, different user
    const asB = await service.createRequest(userB.id, dataOf('T5'), { clientRequestId: K1 });
    const tA = await rowsOf(userA.id, K1);
    const tB = await rowsOf(userB.id, K1);
    check('T5 another user with the same key gets a SEPARATE request, Case and event', asB.id !== first.id && tB.requests.length === 1 && tB.cases.length === 1 && tB.events.length === 1);
    check('T5 the first user\'s request is untouched', tA.requests.length === 1 && tA.requests[0].id === first.id);
    check('T5 the two requests have different references', tA.requests[0].referenceNumber !== tB.requests[0].referenceNumber);

    // ---- T8: ten concurrent, same key
    const K3 = uuid(3);
    const ten = await Promise.allSettled(Array.from({ length: 10 }, () => service.createRequest(userA.id, dataOf('T8'), { clientRequestId: K3 })));
    const tenOk = ten.filter((r) => r.status === 'fulfilled').map((r) => r.value.id);
    const tenFailed = ten.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message).slice(0, 80));
    t = await rowsOf(userA.id, K3);
    check('T8 all ten concurrent submissions succeeded (none errored)', tenOk.length === 10, tenFailed.join(' | ') || '10 fulfilled');
    check('T8 all ten returned the SAME request', new Set(tenOk).size === 1);
    check('T8 exactly ONE request, ONE Case and ONE stage event exist for that key', t.requests.length === 1 && t.cases.length === 1 && t.events.length === 1, `${t.requests.length}/${t.cases.length}/${t.events.length}`);

    // ---- T9: five concurrent, different keys
    const five = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => service.createRequest(userA.id, dataOf(`T9-${i}`), { clientRequestId: uuid(100 + i) })));
    const fiveOk = five.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    check('T9 five concurrent submissions with different keys all succeeded', fiveOk.length === 5, five.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message).slice(0, 80)).join(' | ') || '5 fulfilled');
    check('T9 they are five DISTINCT requests with five distinct references', new Set(fiveOk.map((r) => r.id)).size === 5 && new Set(fiveOk.map((r) => r.referenceNumber)).size === 5);
    const nine = await base.serviceRequest.findMany({ where: { userId: userA.id, clientRequestId: { in: [0, 1, 2, 3, 4].map((i) => uuid(100 + i)) } } });
    const nineCases = await base.case.count({ where: { serviceRequestId: { in: nine.map((r) => r.id) } } });
    const nineEvents = await base.caseStageEvent.count({ where: { case: { serviceRequestId: { in: nine.map((r) => r.id) } } } });
    check('T9 five Cases and five stage events exist for them', nine.length === 5 && nineCases === 5 && nineEvents === 5, `${nine.length}/${nineCases}/${nineEvents}`);

    // ---- T10: injected failures, real rollback
    for (const [label, mode2, key] of [['stage-event insert', 'event', uuid(4)], ['Case insert', 'case', uuid(5)]]) {
      const snap = await totals();
      const idsBefore = (await base.serviceRequest.findMany({ where: { userId: userA.id }, select: { id: true } })).length;
      fault.mode = mode2; fault.hits = 0;
      const failed = await service.createRequest(userA.id, dataOf(`T10-${mode2}`), { clientRequestId: key }).then(() => null, (e) => e);
      fault.mode = null;
      check(`T10 a failure at the ${label} is raised to the caller`, !!failed && /INJECTED FAILURE/.test(String(failed.message)) && fault.hits === 1, failed ? String(failed.message).slice(0, 60) : 'no error');
      t = await rowsOf(userA.id, key);
      const snap2 = await totals();
      check(`T10 the transaction ROLLED BACK: no request, Case or event remains for that key (${label})`, t.requests.length === 0 && t.cases.length === 0 && t.events.length === 0 && JSON.stringify(snap) === JSON.stringify(snap2), `${t.requests.length}/${t.cases.length}/${t.events.length}`);
      check(`T10 no half-saved request exists for the user (${label})`, (await base.serviceRequest.findMany({ where: { userId: userA.id }, select: { id: true } })).length === idsBefore);
      const retry = await service.createRequest(userA.id, dataOf(`T10-${mode2}`), { clientRequestId: key });
      t = await rowsOf(userA.id, key);
      check(`T10 a retry with the SAME key then succeeds: one request, Case and event (${label})`, retry.id === t.requests[0].id && t.requests.length === 1 && t.cases.length === 1 && t.events.length === 1);
    }

    // ---- T11: legacy submissions without a key
    const noKeyA = await service.createRequest(userA.id, dataOf('T11-1'));
    const noKeyB = await service.createRequest(userA.id, dataOf('T11-2'));
    const nk = await base.serviceRequest.findMany({ where: { id: { in: [noKeyA.id, noKeyB.id] } } });
    check('T11 two submissions WITHOUT a key are two requests (the original behaviour)', noKeyA.id !== noKeyB.id && nk.length === 2);
    check('T11 neither stores a key', nk.every((r) => r.clientRequestId === null));
    const nkCases = await base.case.count({ where: { serviceRequestId: { in: [noKeyA.id, noKeyB.id] } } });
    check('T11 each still gets its Case', nkCases === 2);
    const nkBody = await post(body('T11-3'), userA.id);
    check('T11 the controller still accepts a body with no key (201)', nkBody.status === 201 && !nkBody.err);
    const nkNull = await post({ ...body('T11-4'), clientRequestId: null }, userA.id);
    check('T11 a null key counts as none (201)', nkNull.status === 201 && !nkNull.err);

    // ---- T12: references, and everything the run created
    const all = { a: await rowsOf(userA.id), b: await rowsOf(userB.id) };
    const reqs = [...all.a.requests, ...all.b.requests];
    const cases = [...all.a.cases, ...all.b.cases];
    const events = [...all.a.events, ...all.b.events];
    manifest.requestIds = reqs.map((r) => r.id); manifest.caseIds = cases.map((c) => c.id); manifest.eventIds = events.map((e) => e.id); save();
    check('T12 every reference is REQ-<1000 + id>', reqs.every((r) => r.referenceNumber === `REQ-${1000 + r.id}`));
    check('T12 every Case copies its request\'s reference', cases.every((c) => { const r = reqs.find((x) => x.id === c.serviceRequestId); return r && c.referenceNumber === r.referenceNumber; }));
    check('T12 no TEMP- reference remains on any request or Case of this run', ![...reqs.map((r) => r.referenceNumber), ...cases.map((c) => c.referenceNumber)].some((x) => String(x).startsWith('TEMP-')));
    check('T12 every Case has exactly one stage event', cases.every((c) => events.filter((e) => e.caseId === c.id).length === 1));
    check('T12 every row of the run carries the run marker', reqs.every((r) => String(r.patientName).startsWith(`IDEM-VERIFY ${runId} `)) && cases.every((c) => String(c.patientName).startsWith(`IDEM-VERIFY ${runId} `)));
    // 15 = T1 (1) + T5 other user (1) + T3 controller (1) + T8 (1) + T9 (5) + T10 retries (2) + T11 service (2) + T11 controller (2)
    check('T12 the run created the expected number of rows: 15 requests, 15 Cases, 15 events', reqs.length === 15 && cases.length === 15 && events.length === 15, `${reqs.length}/${cases.length}/${events.length}`);

    const autoAfter = await autoInc();
    const after = await counts();
    manifest.autoAfter = autoAfter; manifest.afterRun = after; manifest.finishedAt = new Date().toISOString(); save();
    console.log(`\nrows created by this run: users ${manifest.userIds.length}, requests ${reqs.length}, cases ${cases.length}, stage events ${events.length}`);
    console.log(`user ids: ${manifest.userIds.join(', ')}`);
    console.log(`request ids: ${manifest.requestIds.join(', ')}`);
    console.log(`case ids: ${manifest.caseIds.join(', ')}`);
    console.log(`stage-event ids: ${manifest.eventIds.join(', ')}`);
    console.log(`counts now: ${JSON.stringify(after)}   (baseline ${JSON.stringify(baseline)})`);
    console.log(`auto_increment before: ${JSON.stringify(autoBefore)}   after: ${JSON.stringify(autoAfter)}`);
    console.log(`\nCLEANUP NEXT: node scripts/verify-request-idempotency-e2e.js cleanup ${runId}   (dry run), then add --execute`);
  } else if (mode === 'cleanup') {
    const runId = process.argv[3];
    const execute = process.argv.includes('--execute');
    if (!/^idem[0-9a-z]{6,12}$/.test(runId || '')) stop('give the exact run id: cleanup <runId> [--execute]');
    await identityAndPreflightLight();
    const M = marks(runId);
    console.log(`cleanup of run ${runId}: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
    const users = await base.user.findMany({ where: { email: { in: [M.a, M.b] } }, select: { id: true, email: true, name: true } });
    check('only dedicated test users match (1 or 2), by exact email', users.length >= 1 && users.length <= 2, `${users.length} found`);
    check('each has the run marker in its name', users.every((u) => u.name === M.name(u.email === M.a ? 'A' : 'B')));
    const userIds = users.map((u) => u.id);
    const reqs = await base.serviceRequest.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true, patientName: true } });
    check('every request of these users carries the run marker (nothing foreign)', reqs.every((r) => String(r.patientName).startsWith(`IDEM-VERIFY ${runId} `)), `${reqs.length} requests`);
    const reqIds = reqs.map((r) => r.id);
    const cases = reqIds.length ? await base.case.findMany({ where: { serviceRequestId: { in: reqIds } }, select: { id: true, serviceRequestId: true, corporateId: true, patientName: true } }) : [];
    check('every Case of these requests carries the run marker and has no corporate link', cases.every((c) => String(c.patientName).startsWith(`IDEM-VERIFY ${runId} `) && c.corporateId === null), `${cases.length} cases`);
    const caseIds = cases.map((c) => c.id);
    const events = caseIds.length ? await base.caseStageEvent.findMany({ where: { caseId: { in: caseIds } }, select: { id: true, caseId: true } }) : [];
    check('the expected maxima are not exceeded (users <= 2, requests <= 15, Cases <= 15, events <= 15)', users.length <= 2 && reqs.length <= 15 && cases.length <= 15 && events.length <= 15, `${users.length}/${reqs.length}/${cases.length}/${events.length}`);
    check('every Case has at most one stage event (what the run created)', caseIds.every((id) => events.filter((e) => e.caseId === id).length <= 1));
    // dependent tables: must be empty for these ids
    const dep = async (label, sql, ids) => { if (!ids.length) return; const [{ x }] = await q(sql.replace('IN (?)', `IN (${inList(ids)})`), ...ids); check(`dependent table check: ${label} is empty for these ids`, n(x) === 0, `${n(x)} rows`); };
    await dep('request_events', 'SELECT COUNT(*) AS x FROM request_events WHERE service_request_id IN (?)', reqIds);
    await dep('request_documents', 'SELECT COUNT(*) AS x FROM request_documents WHERE service_request_id IN (?)', reqIds);
    await dep('documents', 'SELECT COUNT(*) AS x FROM documents WHERE case_id IN (?)', caseIds);
    await dep('case_communications', 'SELECT COUNT(*) AS x FROM case_communications WHERE case_id IN (?)', caseIds);
    await dep('user_consents', 'SELECT COUNT(*) AS x FROM user_consents WHERE user_id IN (?)', userIds);
    if (results.some((r) => !r.ok)) stop('a check failed; NOTHING was deleted');
    console.log(`would delete: stage events [${events.map((e) => e.id).join(', ')}]`);
    console.log(`              Cases [${caseIds.join(', ')}]`);
    console.log(`              requests [${reqIds.join(', ')}]`);
    console.log(`              users [${userIds.join(', ')}]`);
    if (!execute) { console.log('DRY RUN COMPLETE: all checks passed, nothing deleted'); } else {
      const done = await base.$transaction([
        base.caseStageEvent.deleteMany({ where: { id: { in: events.map((e) => e.id) } } }),
        base.case.deleteMany({ where: { id: { in: caseIds } } }),
        base.serviceRequest.deleteMany({ where: { id: { in: reqIds } } }),
        base.user.deleteMany({ where: { id: { in: userIds }, email: { in: [M.a, M.b] } } }),
      ]);
      console.log(`deleted: stage events ${done[0].count}, Cases ${done[1].count}, requests ${done[2].count}, users ${done[3].count}`);
      check('the deleted counts equal what was validated', done[0].count === events.length && done[1].count === caseIds.length && done[2].count === reqIds.length && done[3].count === userIds.length);
      const c = await counts();
      check(`baseline restored: ${BASELINE.users} users, ${BASELINE.requests} requests, ${BASELINE.cases} Cases, ${BASELINE.events} stage events`, c.users === BASELINE.users && c.requests === BASELINE.requests && c.cases === BASELINE.cases && c.events === BASELINE.events, JSON.stringify(c));
      const left = await q("SELECT COUNT(*) AS x FROM users WHERE email LIKE 'idem-verify-%@example.invalid'");
      check('no test user remains', n(left[0].x) === 0);
      console.log(`auto_increment now (never reset): ${JSON.stringify(await autoInc())}`);
    }
  } else { stop(`unknown mode "${mode}"`); }

  async function identityAndPreflightLight() {
    const [{ d, p }] = await q('SELECT DATABASE() AS d, @@port AS p');
    check('DATABASE() is exactly humancare_dev, on port 3306', d === 'humancare_dev' && n(p) === 3306, `${d}:${n(p)}`);
    if (d !== 'humancare_dev') stop('live database identity is not humancare_dev');
  }

  await base.$disconnect();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('SCRIPT ERROR:', String(e && e.message).split('\n').filter(Boolean).slice(-2).join(' | '));
  console.error('If this was the RUN, report the run id printed above; do NOT run a broad cleanup.');
  try { await base.$disconnect(); } catch { /* */ }
  process.exit(1);
});
