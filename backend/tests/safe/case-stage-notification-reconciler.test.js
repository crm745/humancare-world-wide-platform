/* global describe, test, expect, beforeEach, jest */
// Recovery of a missed patient notification after an admin case stage change (case-stage-notification-reconciler.js), and the event marker the admin path writes.
// No database, no network, no Expo: Prisma is an in-memory fake (like case-stage-notification.test.js) whose $transaction rolls back when its callback throws.
const mockWorld = {};

jest.mock('../../src/db/prisma', () => {
  const w = () => mockWorld;
  const pickFields = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });
  const caseOf = (id) => w().cases.find((c) => c.id === id);
  const srOf = (id) => { const c = w().cases.find((x) => x.serviceRequest && x.serviceRequest.id === id); return c ? c.serviceRequest : null; };
  const uniq = (target) => { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target }; return e; };
  const tx = {
    case: {
      findUnique: jest.fn(async ({ where }) => { const c = caseOf(where.id); return c ? { ...c, serviceRequest: c.serviceRequest ? { ...c.serviceRequest } : null, stageEvents: [], documents: [] } : null; }),
      update: jest.fn(async ({ where, data }) => { const c = caseOf(where.id); Object.assign(c, data); return { ...c }; }),
    },
    caseStageEvent: {
      create: jest.fn(async ({ data }) => { const row = { id: w().events.length + 1, occurredAt: new Date(w().now), ...data }; w().events.push(row); return { ...row }; }),
      findMany: jest.fn(async ({ where, orderBy, take, select }) => {
        let rows = w().events.filter((e) => e.source === where.source && e.actorType === where.actorType
          && e.occurredAt >= where.occurredAt.gte && e.occurredAt <= where.occurredAt.lte
          && (() => { const c = caseOf(e.caseId); return !!c && c.serviceRequest != null; })());
        if (orderBy && orderBy.id === 'asc') rows = rows.sort((a, b) => a.id - b.id);
        rows = rows.slice(0, take);
        return rows.map((e) => { const c = caseOf(e.caseId); return { ...pickFields(e, select), case: { id: c.id, serviceRequest: { id: c.serviceRequest.id, userId: c.serviceRequest.userId } } }; });
      }),
    },
    serviceRequest: {
      update: jest.fn(async ({ where, data }) => Object.assign(srOf(where.id), data)),
      findUnique: jest.fn(async ({ where, select }) => { const sr = srOf(where.id); return sr ? pickFields(sr, select || { id: true, userId: true }) : null; }),
    },
    user: { findUnique: jest.fn(async ({ where }) => (w().users.includes(where.id) ? { id: where.id } : null)) },
    notification: {
      findUnique: jest.fn(async ({ where }) => { const f = where.id !== undefined ? w().notifications.find((n) => n.id === where.id) : w().notifications.find((n) => n.idempotencyKey === where.idempotencyKey); return f ? { ...f } : null; }),
      findMany: jest.fn(async ({ where, select }) => w().notifications.filter((n) => where.idempotencyKey.in.includes(n.idempotencyKey)).map((n) => pickFields(n, select))),
      create: jest.fn(async ({ data }) => {
        if (w().notifications.some((n) => n.idempotencyKey === data.idempotencyKey)) throw uniq('notifications_idempotency_key_key');
        const row = { id: w().notifications.length + 1, readAt: null, deletedAt: null, createdAt: new Date('2030-01-02T10:00:00Z'), ...data };
        w().notifications.push(row);
        return { ...row };
      }),
    },
    notificationPreference: { findUnique: jest.fn(async () => null) },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select }) => w().devices
        .filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status && +d.lastRegisteredAt <= +where.lastRegisteredAt.lte)
        .sort((a, b) => a.id - b.id).map((d) => pickFields(d, select))),
    },
    notificationDelivery: {
      findMany: jest.fn(async ({ where, select }) => w().deliveries.filter((d) => d.notificationId === where.notificationId && d.channel === where.channel).map((d) => pickFields(d, select))),
      create: jest.fn(async ({ data, select }) => {
        if (w().deliveries.some((d) => d.notificationId === data.notificationId && d.channel === data.channel && d.destinationKey === data.destinationKey)) throw uniq('notification_deliveries_dest_key');
        const row = { id: w().deliveries.length + 1, status: 'pending', attemptCount: 0, ...data };
        w().deliveries.push(row);
        return pickFields(row, select);
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn) => {
      const snapshot = JSON.parse(JSON.stringify(w()), (k, v) => (/(At|now)$/.test(k) && typeof v === 'string' ? new Date(v) : v));
      try { return await fn({ ...tx }); } catch (err) { for (const key of ['notifications', 'deliveries']) w()[key] = snapshot[key]; throw err; }
    }),
  };
  return { prisma };
});
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn() }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() })); // the legacy sender: it must never be reached

const fs = require('fs');
const path = require('path');
const { prisma } = require('../../src/db/prisma');
const { sendExpoPush } = require('../../src/integrations/push/expo-push.service');
const { applyStageChange } = require('../../src/modules/cases/cases.service');
const { reconcileStageNotifications, POLICY } = require('../../src/modules/cases/case-stage-notification-reconciler');
const reconcileJob = require('../../src/jobs/case-stage-notification-reconcile.job');

const T0 = Date.parse('2030-01-02T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const LIVE = { NODE_ENV: 'development' }; // a run that may queue push deliveries (a jest run, NODE_ENV=test, deliberately may not)
const ADMIN = { source: 'admin_stage_change', actorType: 'admin' };
let log;
let state;

const patientCase = (id, userId, over = {}) => ({ id, status: 'submitted', corporateId: null, serviceRequestId: 100 + id, serviceRequest: { id: 100 + id, userId, referenceNumber: `REQ-${id}`, status: 'submitted', patientName: 'Asha Rao' }, ...over });
const event = (over = {}) => { const e = { id: mockWorld.events.length + 1, caseId: 7, stage: 'in_progress', note: 'internal note', occurredAt: new Date(T0 - 10 * MIN), ...ADMIN, ...over }; mockWorld.events.push(e); return e; };
const reconcile = (over = {}) => reconcileStageNotifications({ prisma, env: LIVE, log, nowMs: () => T0, state, ...over });
const device = (ownerId = 55) => { const d = { id: 10 + mockWorld.devices.length, ownerType: 'patient', ownerId, status: 'active', lastRegisteredAt: new Date('2030-01-01T00:00:00Z') }; mockWorld.devices.push(d); return d; };
const keyFor = (userId, eventId) => `stage_update:patient:${userId}:cse${eventId}`;
const everyLog = () => JSON.stringify([log.info.mock.calls, log.error.mock.calls, log.warn.mock.calls]);

beforeEach(() => {
  Object.assign(mockWorld, { now: T0 - 10 * MIN, cases: [patientCase(7, 55)], events: [], notifications: [], deliveries: [], devices: [], users: [55, 56] });
  jest.clearAllMocks();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  state = { lastFailureAlertAtMs: 0 };
});

describe('the marker written by the admin stage change', () => {
  test('a patient Case stage event is marked source=admin_stage_change, actorType=admin, and keeps its stage and note', async () => {
    await applyStageChange(7, 'in_progress', 'internal note', { env: LIVE, log });
    expect(mockWorld.events).toHaveLength(1);
    expect(mockWorld.events[0]).toMatchObject({ caseId: 7, stage: 'in_progress', note: 'internal note', source: 'admin_stage_change', actorType: 'admin' });
  });

  test('a corporate Case (no service request) is updated, its event is NOT marked and nobody is notified', async () => {
    mockWorld.cases.push({ id: 9, status: 'submitted', corporateId: 3, serviceRequestId: null, serviceRequest: null });
    const res = await applyStageChange(9, 'scheduled', 'n', { env: LIVE, log });
    expect(res.patientNotification).toEqual({ status: 'not_applicable' });
    const ev = mockWorld.events.find((e) => e.caseId === 9);
    expect(ev).toMatchObject({ caseId: 9, stage: 'scheduled' });
    expect(ev.source).toBeUndefined();
    expect(ev.actorType).toBeUndefined();
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('no other writer of case stage events carries the marker: Bitrix, review workflow, request creation, reassignment', () => {
    for (const file of ['modules/bitrix/deal-inbox.service.js', 'modules/request-review/request-review.service.js', 'modules/requests/requests.service.js', 'modules/admin/admin.service.js']) {
      expect(fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')).not.toMatch(/admin_stage_change|ADMIN_STAGE_SOURCE/);
    }
  });
});

describe('recovery', () => {
  test('1. a notification step that failed after the stage change is recovered: same key, in-app notification and push delivery, stage change untouched', async () => {
    device(55);
    const failing = jest.fn(async () => { throw Object.assign(new Error('deadlock with secret detail'), { code: 'P2034' }); });
    mockWorld.now = T0 - 10 * MIN;
    const res = await applyStageChange(7, 'in_progress', 'internal note', { env: LIVE, log, enqueuePush: failing });
    expect(res.patientNotification).toEqual({ status: 'failed', code: 'P2034' });
    expect(mockWorld.notifications).toHaveLength(0); // the whole notice rolled back
    expect(mockWorld.cases[0].status).toBe('in_progress'); // the stage change stayed
    expect(mockWorld.events).toHaveLength(1);

    const out = await reconcile();
    expect(out).toEqual({ active: true, checked: 1, alreadyNotified: 0, recovered: 1, failed: 0 });
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.notifications[0]).toMatchObject({ recipientType: 'patient', recipientId: 55, kind: 'stage_update', caseId: 7, serviceRequestId: 107, idempotencyKey: keyFor(55, 1), title: 'Your case has been updated' });
    expect(mockWorld.deliveries).toHaveLength(1);
    expect(mockWorld.deliveries[0]).toMatchObject({ notificationId: 1, channel: 'push', deviceId: mockWorld.devices[0].id });
    expect(JSON.stringify(mockWorld.notifications)).not.toContain('internal note'); // the staff note is never copied
    expect(mockWorld.cases[0].status).toBe('in_progress');
    expect(sendExpoPush).not.toHaveBeenCalled();
  });

  test('2. a successful original notification is not duplicated: the job skips it without opening a transaction', async () => {
    device(55);
    await applyStageChange(7, 'in_progress', null, { env: LIVE, log });
    expect(mockWorld.notifications).toHaveLength(1);
    const transactions = prisma.$transaction.mock.calls.length;
    const out = await reconcile();
    expect(out).toMatchObject({ checked: 1, alreadyNotified: 1, recovered: 0, failed: 0 });
    expect(prisma.$transaction.mock.calls.length).toBe(transactions);
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(1);
  });

  test('3. repeated reconciliation is idempotent', async () => {
    device(55);
    event({ caseId: 7 });
    expect(await reconcile()).toMatchObject({ recovered: 1 });
    for (let i = 0; i < 3; i += 1) expect(await reconcile()).toMatchObject({ checked: 1, alreadyNotified: 1, recovered: 0, failed: 0 });
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(1);
  });

  test('4. two reconcilers racing for the same event (neither sees the notification in its pre-check) create exactly one notification and one delivery per device', async () => {
    device(55); device(55);
    event({ caseId: 7 });
    const [a, b] = await Promise.all([reconcile(), reconcile()]);
    expect(a.recovered + b.recovered).toBe(1);
    expect(a.alreadyNotified + b.alreadyNotified).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(2);
  });

  test('the same race with the ORIGINAL path: whichever is second creates nothing', async () => {
    device(55);
    const e = event({ caseId: 7 });
    const [a] = await Promise.all([reconcile(), (async () => { const { notifyPatient, caseDeps } = require('../../src/modules/cases/case-stage-notice'); return notifyPatient(caseDeps({ env: LIVE, log }), mockWorld.cases[0], e); })()]);
    expect(a.failed).toBe(0);
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(1);
  });

  test('a stale pre-check is harmless: if the notification appears after it, the job reports "already notified" and writes nothing', async () => {
    event({ caseId: 7 });
    const notify = jest.fn(async () => ({ status: 'exists' }));
    expect(await reconcile({ notify })).toMatchObject({ recovered: 0, alreadyNotified: 1, failed: 0 });
  });
});

describe('what is NOT eligible', () => {
  test('5/9. a Case without a patient service request is ignored, even with the marker', async () => {
    mockWorld.cases.push({ id: 9, status: 'submitted', corporateId: 3, serviceRequestId: null, serviceRequest: null });
    event({ caseId: 9 });
    expect(await reconcile()).toEqual({ active: true, checked: 0, alreadyNotified: 0, recovered: 0, failed: 0 });
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('6. Bitrix-originated events are ignored', async () => {
    event({ source: 'bitrix_webhook', actorType: 'bitrix' });
    event({ source: 'bitrix_webhook', actorType: 'admin' });
    event({ source: 'admin_stage_change', actorType: 'bitrix' });
    expect(await reconcile()).toMatchObject({ checked: 0, recovered: 0 });
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('7. events with a NULL, missing or unrelated source or actor are ignored (nothing old is back-filled)', async () => {
    event({ source: null, actorType: null });
    event({ source: undefined, actorType: undefined });
    event({ source: 'system', actorType: 'system' });
    event({ source: 'admin_stage_change', actorType: null });
    event({ source: null, actorType: 'admin' });
    event({ source: 'Admin_Stage_Change', actorType: 'admin' });
    expect(await reconcile()).toMatchObject({ checked: 0, recovered: 0 });
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('8. events older than 24 hours are ignored; 23 h 59 min is still eligible; one younger than the 2 minute grace is left to the original path', async () => {
    event({ occurredAt: new Date(T0 - 24 * HOUR - 1000) });
    event({ occurredAt: new Date(T0 - 25 * HOUR) });
    event({ occurredAt: new Date(T0 - 60 * 1000) });
    expect(await reconcile()).toMatchObject({ checked: 0, recovered: 0 });
    const recent = event({ occurredAt: new Date(T0 - 24 * HOUR + MIN) });
    expect(await reconcile()).toMatchObject({ checked: 1, recovered: 1 });
    expect(mockWorld.notifications.map((n) => n.idempotencyKey)).toEqual([keyFor(55, recent.id)]);
    expect(POLICY.MAX_AGE_HOURS).toBe(24);
  });

  test('the recovery never changes a stage change: no event, case or request row is written', async () => {
    event({ caseId: 7 });
    const before = JSON.stringify([mockWorld.events, mockWorld.cases]);
    await reconcile();
    expect(JSON.stringify([mockWorld.events, mockWorld.cases])).toBe(before);
    expect(prisma.case.update).not.toHaveBeenCalled();
    expect(prisma.caseStageEvent.create).not.toHaveBeenCalled();
  });
});

describe('failures and logging', () => {
  test('10. one failing event does not stop the next; the failure is counted and reported once with a short code and no identifiers', async () => {
    mockWorld.cases.push(patientCase(8, 99)); // patient 99 does not exist: the core refuses (invalid_reference)
    mockWorld.cases.push(patientCase(10, 56));
    device(56);
    const bad = event({ caseId: 8 });
    const good = event({ caseId: 10 });
    const out = await reconcile();
    expect(out).toEqual({ active: true, checked: 2, alreadyNotified: 0, recovered: 1, failed: 1 });
    expect(mockWorld.notifications.map((n) => n.idempotencyKey)).toEqual([keyFor(56, good.id)]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/^\[ALERT\] \[case-stage-reconciler\] 1 patient notification\(s\) could not be recovered \(codes [A-Za-z0-9_.-]+:1\)/);
    // the failed event is tried again on the next run, and the stage events are untouched
    expect(await reconcile({ nowMs: () => T0 + MIN })).toMatchObject({ checked: 2, alreadyNotified: 1, failed: 1 });
    expect(bad.id).toBeGreaterThan(0);
  });

  test('a failure alert is not repeated on every run: once per 30 minutes', async () => {
    mockWorld.cases.push(patientCase(8, 99));
    event({ caseId: 8 });
    await reconcile();
    await reconcile({ nowMs: () => T0 + 3 * MIN });
    await reconcile({ nowMs: () => T0 + 6 * MIN });
    expect(log.error).toHaveBeenCalledTimes(1);
    await reconcile({ nowMs: () => T0 + 31 * MIN });
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  test('the logs hold aggregate counts and codes only: no id, name, notification text, note or token', async () => {
    device(55);
    mockWorld.cases.push(patientCase(8, 99));
    event({ caseId: 7, note: 'Patient moved to ICU ward 4' });
    event({ caseId: 8 });
    await reconcile();
    const text = everyLog();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toBe('[case-stage-reconciler] recovered 1 missed patient notification(s) (checked 2, already notified 0, failed 1).');
    for (const secret of ['Asha', 'Rao', 'ICU', 'Your case has been updated', 'ExponentPushToken', 'REQ-', 'cse', 'stage_update', ':55', '"55"']) expect(text).not.toContain(secret);
  });

  test('a run that finds nothing to do logs nothing', async () => {
    await reconcile();
    expect(everyLog()).toBe('[[],[],[]]');
  });
});

describe('the notification key', () => {
  test('11. is the original key, unchanged: stage_update:patient:<patient id>:cse<stage event id>, from either path', async () => {
    await applyStageChange(7, 'scheduled', null, { env: LIVE, log });
    expect(mockWorld.notifications[0].idempotencyKey).toBe(keyFor(55, mockWorld.events[0].id));
    mockWorld.notifications.length = 0;
    expect(await reconcile()).toMatchObject({ recovered: 1 });
    expect(mockWorld.notifications[0].idempotencyKey).toBe('stage_update:patient:55:cse1');
  });
});

describe('suppression: a test, scoped, integration or synthetic run does nothing at all', () => {
  test.each([
    ['test', { NODE_ENV: 'test' }, 'suppressed_test_environment'],
    ['scoped', { NODE_ENV: 'production', HUMANCARE_SCOPED_RUN: 'true' }, 'suppressed_scoped_test_run'],
    ['integration', { NODE_ENV: 'production', HUMANCARE_INTEGRATION_RUN: 'true' }, 'suppressed_integration_test_run'],
    ['synthetic', { NODE_ENV: 'production', SYNTHETIC_E2E_AUTO_APPROVE: 'true' }, 'suppressed_synthetic_run'],
  ])('15. a %s run: no query, no notification, no delivery', async (_name, env, problem) => {
    device(55);
    event({ caseId: 7 });
    expect(await reconcile({ env })).toEqual({ active: false, problem });
    expect(prisma.caseStageEvent.findMany).not.toHaveBeenCalled();
    expect(mockWorld.notifications).toHaveLength(0);
    expect(mockWorld.deliveries).toHaveLength(0);
  });

  test('the scheduled job does nothing under jest (NODE_ENV=test) and has the documented schedule', async () => {
    event({ caseId: 7 });
    expect(await reconcileJob.run()).toEqual({ active: false, problem: 'suppressed_test_environment' });
    expect(reconcileJob).toMatchObject({ name: 'case-stage-notification-reconcile', intervalMs: 180000, runOnStart: false });
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('a synthetic E2E patient gets the in-app notification but no push delivery (the original rule), and the push switch is not needed', async () => {
    device(55);
    mockWorld.cases[0].serviceRequest.patientName = 'ZZ-SYNTHETIC patient';
    event({ caseId: 7 });
    expect(await reconcile()).toMatchObject({ recovered: 1 });
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(0);
  });
});
