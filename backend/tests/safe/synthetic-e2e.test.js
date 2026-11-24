/* global describe, test, expect, jest, beforeEach */
// Automatic approval of marked synthetic E2E requests: the marker, the engine, the claim / fence rules and the guarantees for real requests.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const fs = require('fs');
const path = require('path');
const { makeRig, SECRET, T0, tick, httpError } = require('./synthetic-e2e-kit');
const marker = require('../../src/common/safety/synthetic-e2e-marker');
const { ACTION, LIMITS } = marker;
const { requestRecordData } = require('../../src/modules/requests/request-record');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let rig;
let engine;
const run = (id = 61, mode = 'auto') => engine.processRequest(id, { mode });
const names = () => rig.world.events.map((e) => e.action.replace('synthetic_e2e_', ''));

beforeEach(() => { rig = makeRig(); engine = rig.engine(); });

describe('the signed marker (pure)', () => {
  const base = () => { rig.mark(); return rig.world.events[0]; };
  const verify = (event, over = {}) => marker.verifyMark(event, { secret: SECRET, requestId: 61, ...over });
  test('a valid marker verifies and carries the operator, owner, run and expected count', () => {
    expect(verify(base())).toMatchObject({ ownerUserId: 7, adminId: 3, expectedDocuments: 2, runId: 'run-1' });
  });
  test.each([
    ['another secret', (e) => verify(e, { secret: 'x'.repeat(40) })],
    ['another request (a copied row)', (e) => verify(e, { requestId: 62 })],
    ['a tampered owner', (e) => verify({ ...e, detail: { ...e.detail, ownerUserId: 8 } })],
    ['a tampered admin', (e) => verify({ ...e, detail: { ...e.detail, adminId: 1 } })],
    ['a tampered document count', (e) => verify({ ...e, detail: { ...e.detail, expectedDocuments: 5 } })],
    ['a tampered expiry', (e) => verify({ ...e, detail: { ...e.detail, expiresAt: '2099-01-01T00:00:00.000Z' } })],
    ['a missing signature', (e) => verify({ ...e, detail: { ...e.detail, sig: undefined } })],
    ['a non-hex signature', (e) => verify({ ...e, detail: { ...e.detail, sig: 'zz' } })],
    ['a document count out of range', (e) => verify({ ...e, detail: { ...e.detail, expectedDocuments: 6 } })],
    ['no secret', (e) => verify(e, { secret: null })],
  ])('is not accepted with %s', (_name, check) => expect(check(base())).toBeNull());

  test('the state is derived from events: expiry, revoked, consumed, and a lease measured from the server timestamp', () => {
    rig.mark();
    const at = (events) => marker.deriveState(events, { secret: SECRET, requestId: 61, now: rig.clock.now });
    expect(at(rig.world.events).state).toBe('active');
    expect(marker.deriveState(rig.world.events, { secret: SECRET, requestId: 61, now: T0 + 25 * HOUR })).toMatchObject({ state: 'expired', recorded: false });
    const sig = rig.world.events[0].detail.sig;
    const ev = (action, extra = {}, occurredAt = new Date(T0)) => ({ id: 100 + rig.world.events.length, serviceRequestId: 61, action, occurredAt, detail: { markSig: sig, ...extra } });
    expect(at([...rig.world.events, ev(ACTION.REVOKED)]).state).toBe('revoked');
    expect(at([...rig.world.events, ev(ACTION.CONSUMED)]).state).toBe('consumed');
    expect(at([...rig.world.events, ev(ACTION.CONSUMED, { markSig: 'f'.repeat(64) })]).state).toBe('active'); // an event for another marker does not count
    const live = at([...rig.world.events, ev(ACTION.STARTED, { token: 'a' })]);
    expect(marker.holdsClaim(live, 'a')).toBe(true);
    expect(marker.holdsClaim(live, 'b')).toBe(false);
    const old = marker.deriveState([...rig.world.events, ev(ACTION.STARTED, { token: 'a' }, new Date(T0 - 6 * MIN))], { secret: SECRET, requestId: 61, now: T0 });
    expect(marker.holdsClaim(old, 'a')).toBe(false); // expired lease
    const future = marker.deriveState([...rig.world.events, ev(ACTION.STARTED, { token: 'a' }, new Date(T0 + 3 * HOUR))], { secret: SECRET, requestId: 61, now: T0 });
    expect(future.claim.live).toBe(false); // a forged future-dated claim cannot stall the process
  });
});

describe('automatic approval', () => {
  test('happens after the FINAL required document becomes clean, through the existing services, and records what it did', async () => {
    rig.mark({ docs: 2 });
    rig.addDoc();
    rig.addDoc({ scanStatus: 'pending', scanEngine: null });
    expect(await run()).toMatchObject({ entered: true, outcome: 'waiting', code: 'unscanned' });
    expect(rig.services.reviewDocument).not.toHaveBeenCalled();
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    rig.world.documents[1].scanStatus = 'clean'; // the scan finishes
    expect(await run()).toEqual({ entered: true, outcome: 'approved' });
    expect(rig.services.reviewDocument.mock.calls.map(([a]) => a)).toEqual([
      { requestId: 61, documentId: 1, adminId: 3, decision: 'approved' },
      { requestId: 61, documentId: 2, adminId: 3, decision: 'approved' },
    ]);
    expect(rig.services.approveRequest).toHaveBeenCalledWith({ requestId: 61, adminId: 3 });
    expect(rig.world.requests.get(61).reviewStatus).toBe('approved');
    expect(rig.world.outbox.size).toBe(1); // the normal Bitrix Deal event, created by approveRequest
    expect(names()).toEqual(['marked', 'approval_started', 'document_approved', 'document_approved', 'consumed']);
  });
  test('audit: the engine events are system events that say AUTOMATIC and name the initiating admin; they never pose as an admin click', async () => {
    rig.mark({ docs: 1, admin: 3 });
    rig.addDoc();
    await run();
    const mine = rig.world.events.filter((e) => e.action !== ACTION.MARKED);
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      expect(e.actorType).toBe('system');
      expect(e.detail).toMatchObject({ automatic: true, initiatedByAdminId: 3, runId: 'run-1' });
    }
    expect(rig.world.events.find((e) => e.action === ACTION.MARKED)).toMatchObject({ actorType: 'admin', actorId: 3 }); // the operator initiated it
    // the existing services keep their own audit behaviour (admin actor = the operator), unchanged
    expect(rig.world.serviceEvents.map((e) => e.action)).toEqual(['document_approved', 'request_approved']);
    expect(JSON.stringify(rig.world.events)).not.toMatch(/private-name|ZZ-SYNTHETIC|mysql:|@/);
  });
  test.each([
    ['pending', { scanStatus: 'pending' }, 'unscanned'],
    ['infected', { scanStatus: 'infected' }, 'infected'],
    ['failed', { scanStatus: 'failed' }, 'scan_unrecoverable'],
    ['errored', { scanStatus: 'error' }, 'scan_failed'],
    ['rejected', { reviewStatus: 'rejected' }, 'rejected'],
  ])('no approval while a document is %s, even when the count is met', async (_name, bad, code) => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    rig.addDoc(bad);
    expect(await run()).toMatchObject({ outcome: 'waiting', code });
    expect(rig.services.reviewDocument).not.toHaveBeenCalled();
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    expect(rig.events(ACTION.STARTED)).toHaveLength(0);
  });
  test.each([
    ['the same file uploaded twice counts once', () => { const a = rig.addDoc(); rig.addDoc({ sha256: a.sha256 }); }, 'documents_missing'],
    ['a replaced (superseded) document does not count', () => { rig.addDoc(); rig.addDoc({ supersededAt: new Date() }); }, 'documents_missing'],
    ['a document that belongs to a post-approval document request does not count', () => { rig.addDoc(); rig.addDoc({ documentRequestId: 9 }); }, 'document_not_ready'],
    ['a file with no recorded checksum does not count', () => { rig.addDoc(); rig.addDoc({ sha256: null }); }, 'document_not_ready'],
    ['a file of a type that is not allowed does not count', () => { rig.addDoc(); rig.addDoc({ mimeType: 'application/msword' }); }, 'document_not_ready'],
    ['an empty file does not count', () => { rig.addDoc(); rig.addDoc({ sizeBytes: 0 }); }, 'document_not_ready'],
  ])('clean but irrelevant files never satisfy a missing required document: %s', async (_name, setup, code) => {
    rig.mark({ docs: 2 });
    setup();
    const result = await run();
    expect(result).toMatchObject({ outcome: 'waiting', code });
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
  test('an extra clean document beyond the expected count is fine (it is approved too)', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    rig.addDoc();
    expect(await run()).toMatchObject({ outcome: 'approved' });
    expect(rig.services.reviewDocument).toHaveBeenCalledTimes(2);
  });
});

describe('duplicates, concurrency and fencing', () => {
  test('duplicate scan events: later runs after the approval are no-ops (one approval, one Deal event, one consumed)', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    await run();
    for (let i = 0; i < 4; i += 1) expect(await run()).toMatchObject({ entered: true, outcome: 'consumed' });
    expect(rig.services.approveRequest).toHaveBeenCalledTimes(1);
    expect(rig.world.outbox.size).toBe(1);
    expect(rig.events(ACTION.CONSUMED)).toHaveLength(1);
    expect(rig.events(ACTION.STARTED)).toHaveLength(1);
  });
  test('concurrent engine invocations never double-approve or double-enqueue', async () => {
    rig.mark({ docs: 2 });
    rig.addDoc();
    rig.addDoc();
    const results = await Promise.all(Array.from({ length: 6 }, () => run()));
    expect(results.filter((r) => r.outcome === 'approved')).toHaveLength(1);
    expect(results.every((r) => ['approved', 'claimed_elsewhere', 'consumed'].includes(r.outcome))).toBe(true);
    expect(rig.services.approveRequest).toHaveBeenCalledTimes(1);
    expect(rig.services.reviewDocument).toHaveBeenCalledTimes(2);
    expect(rig.world.outbox.size).toBe(1);
    expect(rig.events(ACTION.STARTED)).toHaveLength(1);
    expect(rig.events(ACTION.CONSUMED)).toHaveLength(1);
  });
  test('an expired claim resumes safely, and the stale holder is fenced out before its next operation', async () => {
    rig.mark({ docs: 2 });
    rig.addDoc();
    rig.addDoc();
    // holder A stalls inside its first document review
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = rig.services.reviewDocument.getMockImplementation();
    rig.services.reviewDocument.mockImplementationOnce(async (args) => { await gate; return original(args); });
    const a = run();
    await tick(); await tick(); await tick();
    expect(rig.events(ACTION.STARTED)).toHaveLength(1);
    rig.advance(6 * MIN); // A's five-minute lease runs out
    const b = await run();
    expect(b).toMatchObject({ outcome: 'approved' });
    expect(rig.events(ACTION.STARTED)).toHaveLength(2);
    release();
    expect(await a).toMatchObject({ entered: true, outcome: 'claim_lost' });
    expect(rig.services.approveRequest).toHaveBeenCalledTimes(1);
    expect(rig.world.outbox.size).toBe(1);
    expect(rig.events(ACTION.CONSUMED)).toHaveLength(1);
    expect(rig.world.documents.every((d) => d.reviewStatus === 'approved')).toBe(true);
  });
  test('a live claim held by someone else is respected', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    const sig = rig.world.events[0].detail.sig;
    rig.world.events.push({ id: 99, serviceRequestId: 61, action: ACTION.STARTED, actorType: 'system', occurredAt: new Date(rig.clock.now - MIN), detail: { markSig: sig, token: 'other' } });
    expect(await run()).toMatchObject({ outcome: 'claimed_elsewhere' });
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
  test('a crash after the approval but before "consumed" converges: no second approval, no second Deal event', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    await run();
    rig.world.events = rig.world.events.filter((e) => e.action !== ACTION.CONSUMED); // the consumed event was lost
    expect(await run()).toMatchObject({ outcome: 'consumed' });
    expect(rig.services.approveRequest).toHaveBeenCalledTimes(1);
    expect(rig.world.outbox.size).toBe(1);
    expect(rig.events(ACTION.CONSUMED)).toHaveLength(1);
  });
});

describe('retries and partial failure', () => {
  test('a failed approval is recorded, retried only after 60 seconds, and resumes without repeating finished steps', async () => {
    rig.mark({ docs: 2 });
    rig.addDoc();
    rig.addDoc();
    rig.world.fail.approveRequest = 1;
    expect(await run()).toMatchObject({ outcome: 'failed', stage: 'request_approval' });
    expect(rig.events(ACTION.FAILED)).toHaveLength(1);
    expect(rig.world.documents.every((d) => d.reviewStatus === 'approved')).toBe(true); // a valid partial state
    expect(await run()).toMatchObject({ outcome: 'retry_later' });
    rig.advance(61 * 1000);
    expect(await run()).toMatchObject({ outcome: 'approved' });
    expect(rig.services.reviewDocument).toHaveBeenCalledTimes(2); // not repeated
    expect(rig.world.outbox.size).toBe(1);
  });
  test('after five failed attempts the marker is revoked and nothing more is attempted', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    rig.world.fail.approveRequest = 99;
    for (let i = 0; i < 5; i += 1) { expect((await run()).outcome).toBe('failed'); rig.advance(61 * 1000); }
    expect(rig.events(ACTION.FAILED)).toHaveLength(5);
    expect(rig.events(ACTION.REVOKED)).toHaveLength(1);
    expect(rig.events(ACTION.REVOKED)[0].detail.reason).toBe('attempts_exhausted');
    const calls = rig.services.approveRequest.mock.calls.length;
    expect(await run()).toMatchObject({ outcome: 'revoked' });
    expect(rig.services.approveRequest.mock.calls.length).toBe(calls);
  });
  test('a document that changes after the claim stops the run before approval (documents_changed), then retries', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    const original = rig.services.approvalBlockers;
    rig.services.approvalBlockers = jest.fn(() => []);
    rig.services.approvalBlockers.mockReturnValueOnce([]).mockReturnValueOnce([{ code: 'unscanned' }]);
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'unscanned' });
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    rig.services.approvalBlockers = original;
  });
  test('the periodic sweep retries unfinished marked requests only', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    rig.world.requests.set(70, { id: 70, userId: 9, serviceKey: 'privatecharter', patientName: 'Real Patient', reviewStatus: 'in_review', createdAt: new Date(T0) });
    const result = await engine.sweep();
    expect(result.results).toEqual([{ requestId: 61, entered: true, outcome: 'approved' }]);
    expect(await engine.sweep()).toEqual({ processed: 0, results: [] }); // consumed: no longer listed
    expect(rig.world.requests.get(70).reviewStatus).toBe('in_review');
  });
});

describe('invalid markers never approve', () => {
  const none = async (expected) => {
    rig.addDoc(); rig.addDoc();
    const result = await run();
    expect(result.outcome).toBe(expected);
    expect(rig.services.reviewDocument).not.toHaveBeenCalled();
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    expect(rig.world.requests.get(61).reviewStatus).toBe('in_review');
  };
  test('expired: one "expired" event is recorded, once', async () => {
    rig.mark();
    rig.advance(25 * HOUR);
    await none('expired');
    expect(rig.events(ACTION.EXPIRED)).toHaveLength(1);
    await run();
    expect(rig.events(ACTION.EXPIRED)).toHaveLength(1);
  });
  test('revoked', async () => {
    const detail = rig.mark();
    rig.world.events.push({ id: 90, serviceRequestId: 61, action: ACTION.REVOKED, actorType: 'system', occurredAt: new Date(), detail: { markSig: detail.sig } });
    await none('revoked');
  });
  test('consumed', async () => {
    const detail = rig.mark();
    rig.world.events.push({ id: 90, serviceRequestId: 61, action: ACTION.CONSUMED, actorType: 'system', occurredAt: new Date(), detail: { markSig: detail.sig } });
    await none('consumed');
  });
  test('forged (wrong signature) and signed with another secret: nothing is written', async () => {
    const detail = rig.mark();
    rig.world.events[0].detail = { ...detail, sig: 'a'.repeat(64) };
    const before = rig.world.events.length;
    await none('marker_invalid');
    expect(rig.world.events.length).toBe(before);
    rig.world.events = [];
    rig.mark({ secret: 'y'.repeat(40) });
    await none('marker_invalid');
  });
  test('a marker copied from another request does not work', async () => {
    rig.mark({ requestId: 62 });
    rig.world.events[0].serviceRequestId = 61;
    await none('marker_invalid');
  });
  test('wrong owner: the request is not the marked account\'s', async () => {
    rig.mark({ owner: 8 });
    await none('refused');
    expect(rig.events(ACTION.STARTED)).toHaveLength(0);
  });
  test('an owner with other requests is refused', async () => {
    rig = makeRig({ otherRequests: [{ id: 99, userId: 7 }] });
    engine = rig.engine();
    rig.mark();
    await none('refused');
  });
  test('a request whose patient name lacks the synthetic prefix is refused', async () => {
    rig = makeRig({ request: { patientName: 'Real Person' } });
    engine = rig.engine();
    rig.mark();
    await none('refused');
  });
  test('a request that is not Private Charter, or not in review, is refused / waits', async () => {
    rig = makeRig({ request: { serviceKey: 'commercialcharter' } });
    engine = rig.engine();
    rig.mark();
    await none('refused');
    rig = makeRig({ request: { reviewStatus: 'awaiting_documents' } });
    engine = rig.engine();
    rig.mark();
    expect((await run()).outcome).toBe('waiting');
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
  test('the secret missing or too short, production, a wrong database, or no opt-in: the engine is inert and touches nothing', async () => {
    rig.mark();
    rig.addDoc(); rig.addDoc();
    for (const env of [{ SYNTHETIC_E2E_SECRET: undefined }, { SYNTHETIC_E2E_SECRET: 'short' }, { NODE_ENV: 'production' }, { DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_test' },
      { DATABASE_URL: 'mysql://u:p@db.example.com:3306/humancare_dev' }, { SYNTHETIC_E2E_AUTO_APPROVE: undefined }, { SYNTHETIC_E2E_AUTO_APPROVE: '1' }]) {
      rig.prisma.requestEvent.findMany.mockClear();
      expect(await rig.engine(env).processRequest(61)).toEqual({ entered: false, outcome: 'disabled' });
      expect(rig.prisma.requestEvent.findMany).not.toHaveBeenCalled();
      expect(rig.prisma.$transaction).not.toHaveBeenCalled();
    }
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
  test('the server reporting another database stops the engine', async () => {
    rig.mark();
    rig.addDoc(); rig.addDoc();
    rig.world.db = 'humancare_test';
    expect(await run()).toMatchObject({ entered: false, outcome: 'database_not_identified' });
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
});

describe('real patient requests never enter this path', () => {
  test('a request with no marker returns after one read and writes and approves nothing', async () => {
    rig.addDoc(); rig.addDoc();
    expect(await run()).toEqual({ entered: false, outcome: 'not_synthetic' });
    expect(rig.prisma.requestEvent.findMany).toHaveBeenCalledTimes(1);
    expect(rig.prisma.requestEvent.create).not.toHaveBeenCalled();
    expect(rig.prisma.$transaction).not.toHaveBeenCalled();
    expect(rig.services.reviewDocument).not.toHaveBeenCalled();
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    expect(rig.world.requests.get(61).reviewStatus).toBe('in_review');
  });
  test('many real-looking requests with every document clean are never approved, under any enabled mode', async () => {
    for (let id = 100; id < 160; id += 1) {
      rig.world.requests.set(id, { id, userId: 1000 + id, serviceKey: 'privatecharter', patientName: id % 2 ? 'ZZ-SYNTHETIC Look-alike' : `Patient ${id}`, reviewStatus: 'in_review', createdAt: new Date(T0) });
      rig.addDoc({ serviceRequestId: id });
      expect(await run(id)).toEqual({ entered: false, outcome: 'not_synthetic' });
      expect(await run(id, 'recovery')).toEqual({ entered: false, outcome: 'disabled' });
    }
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
    expect(rig.services.reviewDocument).not.toHaveBeenCalled();
    expect(rig.prisma.requestEvent.create).not.toHaveBeenCalled();
  });
  test('forged non-marker events (started / consumed / revoked) cannot enable anything', async () => {
    rig.addDoc(); rig.addDoc();
    for (const action of [ACTION.STARTED, ACTION.FAILED, ACTION.CONSUMED, ACTION.DOC_APPROVED]) {
      rig.world.events.push({ id: ++rig.world.seq, serviceRequestId: 61, action, actorType: 'system', occurredAt: new Date(), detail: { token: 'x', markSig: 'a'.repeat(64) } });
    }
    expect(await run()).toEqual({ entered: false, outcome: 'not_synthetic' });
    expect(rig.services.approveRequest).not.toHaveBeenCalled();
  });
  test('a patient request body cannot create a marker: the field allow-list drops unknown fields', () => {
    const data = requestRecordData(7, {
      serviceType: 'Private Charter', patientName: 'ZZ-SYNTHETIC x', origin: 'a', destination: 'b',
      synthetic_e2e_marked: true, detail: { sig: 'x' }, action: ACTION.MARKED, reviewStatus: 'approved', syntheticE2e: { expectedDocuments: 1 },
    });
    expect(Object.keys(data).join(',')).not.toMatch(/synthetic|detail|action|reviewStatus/i);
  });
  test('only the two guarded call sites and the scripts use the engine; the services, controllers and admin flow never import it', () => {
    const root = path.join(__dirname, '../..');
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const users = walk('src').filter((f) => f.endsWith('.js') && /synthetic-approval|synthetic-e2e-marker/.test(read(f)));
    expect(users.map((f) => f.replace(/\\/g, '/')).sort()).toEqual([
      'src/jobs/scan-request-documents.job.js',
      'src/modules/request-review/synthetic-approval.js',
      'src/modules/requests/requests.controller.js',
      'src/synthetic-e2e-api.js', // the orchestrator's isolated API entry: it only reads the marker module's database name (LIMITS.DATABASE)
      'src/synthetic-e2e-worker.js',
    ]);
    for (const unchanged of ['src/modules/request-review/request-review.service.js', 'src/modules/request-review/request-review.controller.js', 'src/modules/request-review/request-review.files.js', 'src/modules/admin/admin.controller.js']) {
      expect(read(unchanged)).not.toMatch(/synthetic/i);
    }
    expect(read('src/modules/requests/requests.controller.js')).toMatch(/autoApproveIfSynthetic\(request\.id\)\.catch\(/);
    expect(read('src/jobs/scan-request-documents.job.js')).toMatch(/sweepSyntheticApprovals\(\)\.catch\(/);
  });
  test('the scan, upload, storage and structure code never reads the marker (synthetic documents get exactly the real checks)', () => {
    const root = path.join(__dirname, '../..');
    const files = ['src/storage', 'src/integrations/clamav'].flatMap((dir) => fs.readdirSync(path.join(root, dir), { recursive: true }).filter((f) => String(f).endsWith('.js')).map((f) => path.join(dir, String(f))));
    for (const f of files) expect(fs.readFileSync(path.join(root, f), 'utf8')).not.toMatch(/synthetic/i);
  });
  test('the engine only ever writes events: it never updates a request, document or Case itself', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/modules/request-review/synthetic-approval.js'), 'utf8');
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\.(update|updateMany|delete|deleteMany|upsert)\(/);
    expect(code).not.toMatch(/serviceRequest\.create|requestDocument\.create|case\.create|integrationOutbox/);
    expect(code).not.toMatch(/bitrix|razorpay|payment|notification|mailer|expoPush|expo-push/i);
  });
  test('a failing service never leaks file names or patient details into events or logs', async () => {
    rig.mark({ docs: 1 });
    rig.addDoc();
    rig.services.approveRequest.mockRejectedValueOnce(Object.assign(new Error('"private-name.pdf" for ZZ-SYNTHETIC Test'), { statusCode: 409, publicCode: 'approval_blocked', blockers: [{ message: 'private-name.pdf' }] }));
    expect(await run()).toMatchObject({ outcome: 'failed', code: 'approval_blocked' });
    expect(JSON.stringify(rig.world.events)).not.toMatch(/private-name|ZZ-SYNTHETIC/);
    expect(JSON.stringify(rig.log.warn.mock.calls)).not.toMatch(/private-name|ZZ-SYNTHETIC/);
  });
});

test('httpError helper sanity (kit)', () => expect(httpError(409, 'x')).toMatchObject({ statusCode: 409, publicCode: 'x' }));
describe('limits', () => {
  test('the approved limits', () => expect(LIMITS).toMatchObject({ EXPIRY_MS: 24 * HOUR, MAX_ACTIVE_MARKS: 3, MAX_REQUEST_AGE_MS: 6 * HOUR, LEASE_MS: 5 * MIN, RETRY_SPACING_MS: 60000, MAX_FAILURES: 5, MIN_DOCUMENTS: 1, MAX_DOCUMENTS: 5 }));
});
