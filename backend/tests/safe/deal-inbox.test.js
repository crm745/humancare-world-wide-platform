/* global describe, test, expect, jest, beforeEach */
// The inbound Deal-stage processor. No database and no network: an in-memory world (Case, link, stage events,
// notifications, audit, inbox) behind a fake Prisma whose transaction serialises callers (standing in for the
// Case row lock) and rolls back on a throw; a fake store applying the same lease/fence rules as the real SQL;
// and a mocked Bitrix client. The real store's SQL is checked at the bottom. A patient-visible stage queues the patient's PUSH DELIVERIES in the same
// transaction (fake device / preference / delivery tables below); nothing here sends a push.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() })); // the legacy sender: it must never be reached

const service = require('../../src/modules/bitrix/deal-inbox.service');
const realStore = require('../../src/modules/bitrix/deal-inbox.store');
const { STAGES } = require('../../src/modules/bitrix/bitrix-deal-stages');
const { suppressedEnqueuePush } = require('../../src/modules/notifications/push-delivery-enqueue');

const { runInboxWorker, LEASE_SECONDS, MAX_ATTEMPTS, NOT_LINKED_RETRIES } = service;
const ENV_ON = { BITRIX_DEAL_PROFILE: 'test', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' };
const REF = 'HC-PC-000123';
const DEAL = '4711';
const REF_FIELD = 'UF_CRM_1794548440549';
const LOST_FIELD = 'UF_LOST';

let clock; let inbox; let world; let mutex; let order;

const dealBody = (over = {}) => ({
  ID: DEAL, CATEGORY_ID: '38', STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-02T10:00:00+00:00', [REF_FIELD]: REF,
  COMMENTS: 'INTERNAL NOTE do not show', TITLE: REF, ...over,
});
const STAGE_TITLE = 'Your case has been updated'; // the catalogue's title for stage_update
const STAGE_BODY = 'Your case status has been updated.'; // the core's fixed stage_update body
const newInbox = (over = {}) => ({ id: 1, status: 'received', attempts: 0, nextAt: 0, lockedBy: null, lockedUntil: null, lastError: null, dealId: DEAL, ...over });
const freshWorld = () => ({
  case: { id: 7, referenceNumber: REF, status: 'submitted', charter_stage: 'patient_details', stage_version: 0, closedAt: null },
  serviceRequest: { id: 3, userId: 55, serviceKey: 'privatecharter', reviewStatus: 'in_review', bitrixLeadId: null, status: 'submitted', patientName: 'Asha Rao', patientContact: '+971501234567' },
  link: { id: 1, caseId: 7, bitrixDealId: DEAL, stageId: 'C38:NEW', externalModifiedAt: null, syncStatus: 'synced' },
  stageEvents: [], notifications: [], audit: [],
  devices: [{ id: 10, ownerType: 'patient', ownerId: 55, status: 'active', expoPushToken: 'ExponentPushToken[fake]', lastRegisteredAt: new Date('2030-01-02T09:00:00Z') }],
  deliveries: [], prefs: {},
});

function makeStore() {
  const due = (e) => e.status === 'received' && e.nextAt <= clock && (e.lockedUntil == null || e.lockedUntil <= clock);
  const owns = (e, c) => e.status === 'processing' && e.attempts === c.attempts && e.lockedBy === c.workerId && e.lockedUntil > clock;
  return {
    recoverExpiredLeases: jest.fn(async (_db, { maxAttempts }) => {
      for (const e of inbox) {
        if (e.status !== 'processing' || e.lockedUntil > clock) continue;
        Object.assign(e, e.attempts >= maxAttempts ? { status: 'failed', lastError: 'lease_expired_repeatedly' } : { status: 'received', nextAt: clock }, { lockedBy: null, lockedUntil: null });
      }
    }),
    findDueIds: jest.fn(async (_db, limit) => inbox.filter(due).slice(0, limit).map((e) => e.id)),
    claim: jest.fn(async (_db, { id, workerId, leaseSeconds }) => {
      const e = inbox.find((x) => x.id === id);
      if (!e || !due(e)) return null;
      Object.assign(e, { status: 'processing', attempts: e.attempts + 1, lockedBy: workerId, lockedUntil: clock + leaseSeconds });
      return { id, workerId, attempts: e.attempts, dealId: e.dealId, occurredAt: null };
    }),
    writeResult: jest.fn(async (_db, c, { status, lastError = null, delaySeconds = 0 }) => {
      const e = inbox.find((x) => x.id === c.id);
      if (!owns(e, c)) return 0;
      Object.assign(e, { status, lastError, nextAt: clock + delaySeconds, lockedBy: null, lockedUntil: null });
      order.push(`inbox:${status}`);
      return 1;
    }),
  };
}

function makePrisma() {
  const w = () => world;
  const tx = {
    $queryRaw: jest.fn(async () => [{ ...w().case }]),
    bitrixDealLink: { findUnique: jest.fn(async () => ({ ...w().link })), update: jest.fn(async ({ data }) => { order.push('link'); w().link = { ...w().link, ...data }; }) },
    caseStageEvent: {
      findFirst: jest.fn(async ({ where }) => w().stageEvents.find((e) => e.idempotencyKey === where.idempotencyKey) || null),
      // Returns the created row (with its id), like Prisma: the notification's event reference is built from this id.
      create: jest.fn(async ({ data }) => { order.push('stage-event'); const row = { id: w().stageEvents.length + 1, ...data }; w().stageEvents.push(row); return { ...row }; }),
    },
    case: {
      // What the central notification core reads (through the same transaction client) to check ownership.
      findUnique: jest.fn(async ({ where }) => (where.id === w().case.id ? { id: w().case.id, serviceRequestId: w().serviceRequest.id } : null)),
      updateMany: jest.fn(async ({ where, data }) => {
        if (w().case.stage_version !== where.stageVersion) return { count: 0 };
        order.push('case');
        const c = w().case;
        c.charter_stage = data.charterStage; c.status = data.status; c.stage_version += 1;
        if (data.closedAt) c.closedAt = data.closedAt;
        return { count: 1 };
      }),
    },
    serviceRequest: {
      update: jest.fn(async ({ data }) => { w().serviceRequest.status = data.status; }),
      findUnique: jest.fn(async ({ where }) => (where.id === w().serviceRequest.id ? { id: w().serviceRequest.id, userId: w().serviceRequest.userId } : null)),
    },
    user: { findUnique: jest.fn(async ({ where }) => (where.id === w().serviceRequest.userId ? { id: where.id } : null)) },
    // Like the real table: the idempotency key is unique (a duplicate is a P2002) and findUnique reads by it.
    notification: {
      findUnique: jest.fn(async ({ where }) => {
        const found = where.id !== undefined ? w().notifications.find((n) => n.id === where.id) : w().notifications.find((n) => n.idempotencyKey === where.idempotencyKey);
        return found ? { ...found } : null;
      }),
      create: jest.fn(async ({ data }) => {
        order.push('notification');
        if (w().notifications.some((n) => n.idempotencyKey === data.idempotencyKey)) { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notifications_idempotency_key_key' }; throw e; }
        const row = { id: w().notifications.length + 1, readAt: null, deletedAt: null, createdAt: new Date('2030-01-02T10:00:00Z'), ...data };
        w().notifications.push(row);
        return { ...row };
      }),
    },
    // The push tables, like the real ones: a query returns only what it selects; the destination index is unique (a duplicate is a P2002).
    notificationPreference: { findUnique: jest.fn(async ({ where }) => { const p = w().prefs[where.ownerType_ownerId.ownerId]; return p ? { ...p } : null; }) },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select }) => w().devices
        .filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status && +d.lastRegisteredAt <= +where.lastRegisteredAt.lte)
        .sort((a, b) => a.id - b.id).map((d) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, d[k]])))),
    },
    notificationDelivery: {
      findMany: jest.fn(async ({ where, select }) => w().deliveries
        .filter((d) => d.notificationId === where.notificationId && d.channel === where.channel).map((d) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, d[k]])))),
      create: jest.fn(async ({ data, select }) => {
        order.push('delivery');
        if (w().deliveries.some((d) => d.notificationId === data.notificationId && d.channel === data.channel && d.destinationKey === data.destinationKey)) { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notification_deliveries_dest_key' }; throw e; }
        const row = { id: w().deliveries.length + 1, status: 'pending', attemptCount: 0, ...data };
        w().deliveries.push(row);
        return select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
      }),
    },
    auditLog: { create: jest.fn(async ({ data }) => { w().audit.push(data); }) },
  };
  return {
    tx,
    bitrixDealLink: {
      findUnique: jest.fn(async () => (world.link && world.link.bitrixDealId === DEAL && world.present !== false
        ? { ...world.link, case: { id: 7, referenceNumber: REF, serviceRequestId: 3, serviceRequest: { ...world.serviceRequest } } } : null)),
    },
    user: { findUnique: jest.fn(async () => ({ pushToken: 'ExponentPushToken[fake]' })) },
    $transaction: jest.fn((callback) => {
      const run = async () => {
        const snap = { world: structuredClone(world), inbox: inbox.map((e) => ({ ...e })), order: [...order] };
        try { return await callback(tx); } catch (err) { world = snap.world; inbox = snap.inbox; order = snap.order; throw err; }
      };
      const result = mutex.then(run, run);
      mutex = result.catch(() => {});
      return result;
    }),
  };
}

let prisma; let store; let api; let log;
const run = (extra = {}) => runInboxWorker({ prisma, store, api, env: ENV_ON, log, lostReasonField: LOST_FIELD, workerId: 'worker-A', ...extra });
const logged = () => [...log.error.mock.calls, ...log.warn.mock.calls].map((c) => c[0]).join('\n');
const auditActions = () => world.audit.map((a) => a.action);

beforeEach(() => {
  clock = 1000; inbox = [newInbox()]; world = freshWorld(); mutex = Promise.resolve(); order = [];
  prisma = makePrisma(); store = makeStore();
  log = { error: jest.fn(), warn: jest.fn() };
  api = { getDeal: jest.fn(async () => ({ status: 'ok', deal: dealBody() })) };
});

// ---- the switches --------------------------------------------------------------------------------------------------
describe('switches', () => {
  test.each([[{}], [{ BITRIX_SYNC_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }], [{ BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true' }], [{ BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true' }]])(
    'a switch off (%j): nothing is recovered, claimed, read or changed', async (env) => {
      expect(await run({ env })).toEqual({ active: false, claimed: 0 });
      expect(store.claim).not.toHaveBeenCalled();
      expect(api.getDeal).not.toHaveBeenCalled();
      expect(inbox[0].status).toBe('received');
    },
  );
});

// ---- every approved stage ------------------------------------------------------------------------------------------
describe('applying an approved stage', () => {
  const startFor = (key) => (key === 'patient_details' ? { charter_stage: 'documentation', status: 'in_progress' } : { charter_stage: 'patient_details', status: 'submitted' });
  test.each(Object.entries(STAGES))('%s', async (stageId, entry) => {
    Object.assign(world.case, startFor(entry.key));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: stageId }) });
    await run();
    expect(inbox[0]).toMatchObject({ status: 'processed', lastError: null });
    expect(world.case.charter_stage).toBe(entry.key);
    expect(world.case.status).toBe(entry.status ?? startFor(entry.key).status);
    expect(world.case.stage_version).toBe(1);
    expect(world.stageEvents).toHaveLength(1);
    expect(world.stageEvents[0]).toMatchObject({ caseId: 7, stage: entry.key, note: null, previousStage: startFor(entry.key).charter_stage, actorType: 'bitrix', source: 'bitrix_webhook', reasonCode: `bitrix:${stageId}` });
    expect(world.link).toMatchObject({ stageId, syncStatus: 'synced' });
    // Patient visibility: exactly the four approved stages notify, with the fixed message.
    expect(world.notifications).toHaveLength(entry.patientVisible ? 1 : 0);
    expect(world.deliveries).toHaveLength(entry.patientVisible ? 1 : 0);
    // Through the central core: catalogue title, the core's fixed stage_update body (the profile's `message` only decides whether to notify).
    if (entry.patientVisible) expect(world.notifications[0]).toMatchObject({ recipientType: 'patient', recipientId: 55, kind: 'stage_update', title: STAGE_TITLE, body: STAGE_BODY, isMandatory: false });
    // ... and one push delivery for the patient's active device, queued in the same transaction (the worker sends it later from the stored notification)
    if (entry.patientVisible) expect(world.deliveries).toEqual([expect.objectContaining({ notificationId: world.notifications[0].id, recipientType: 'patient', recipientId: 55, channel: 'push', provider: 'expo', deviceId: 10, destinationKey: 'device:10', status: 'pending' })]);
  });

  const CANCEL_MESSAGE = 'Your Private Charter request has been cancelled. Please contact our support team if you need assistance.'; // the profile's message: now only the gate
  const cancelledDeal = (over = {}) => dealBody({ STAGE_ID: 'C38:LOSE', UF_CRM_1788858985323: '5914', UF_CRM_1788859072681: 'FREE TEXT lost reason, internal', ...over });

  test('Deal Lost with reason 5914 (the confirmed field, default configuration) -> cancelled, closed, ONE fixed notification', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: cancelledDeal() });
    await run({ lostReasonField: undefined });
    expect(world.case).toMatchObject({ charter_stage: 'cancelled', status: 'cancelled' });
    expect(world.case.closedAt).toBeInstanceOf(Date);
    expect(world.serviceRequest.status).toBe('cancelled');
    expect(world.stageEvents[0]).toMatchObject({ stage: 'cancelled', note: null, reasonCode: 'bitrix:C38:LOSE' });
    expect(world.notifications).toHaveLength(1);
    expect(world.notifications[0]).toMatchObject({ recipientType: 'patient', recipientId: 55, kind: 'stage_update', title: STAGE_TITLE, body: STAGE_BODY });
    expect(JSON.stringify(world.notifications)).not.toContain(CANCEL_MESSAGE);
    expect(order).toEqual(['inbox:processed', 'case', 'stage-event', 'link', 'notification', 'delivery']);
    expect(world.deliveries).toHaveLength(1);
    expect(inbox[0].status).toBe('processed');
  });

  test('the cancellation message never carries the lost-reason text, the companion field or any note', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: cancelledDeal() });
    await run({ lostReasonField: undefined });
    expect(JSON.stringify([world.notifications, world.deliveries, world.audit, world.stageEvents])).not.toMatch(/FREE TEXT|INTERNAL NOTE|internal/);
  });

  test('duplicate deliveries of the cancellation create no second notification, stage event or push delivery', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: cancelledDeal() });
    inbox.push(newInbox({ id: 2 }), newInbox({ id: 3 }));
    await run({ lostReasonField: undefined });
    expect(world.notifications).toHaveLength(1);
    expect(world.stageEvents).toHaveLength(1);
    expect(world.deliveries).toHaveLength(1);
  });

  test('cancellation is terminal: no later event reopens it, and nothing more is queued', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: cancelledDeal() });
    await run({ lostReasonField: undefined });
    for (const [i, stageId] of ['C38:EXECUTING', 'C38:NEW', 'C38:WON'].entries()) {
      inbox.push(newInbox({ id: 20 + i }));
      api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: stageId, DATE_MODIFY: `2030-02-0${i + 1}T10:00:00+00:00` }) });
      await run({ lostReasonField: undefined });
    }
    expect(world.case).toMatchObject({ charter_stage: 'cancelled', status: 'cancelled' });
    expect(inbox.slice(1).map((e) => e.lastError)).toEqual(Array(3).fill('quarantined:case_already_closed'));
    expect(world.notifications).toHaveLength(1);
  });

  test.each([['5916'], ['0'], [''], [undefined]])('Deal Lost with reason %p stays quarantined and the companion text is never used', async (reason) => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: cancelledDeal({ UF_CRM_1788858985323: reason, UF_CRM_1788859072681: 'Patient Cancelled' }) });
    await run({ lostReasonField: undefined });
    expect(inbox[0].lastError).toMatch(/^quarantined:lost_reason_/);
    expect(world.case.status).toBe('submitted');
    expect(world.notifications).toHaveLength(0);
  });

  test('the patient request status follows the Case status only when the stage sets one', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:EXECUTING' }) });
    await run();
    expect(world.serviceRequest.status).toBe('in_progress');
    world.serviceRequest.status = 'in_progress';
    inbox.push(newInbox({ id: 2 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:1', DATE_MODIFY: '2030-01-02T11:00:00+00:00' }) });
    await run();
    expect(world.case).toMatchObject({ charter_stage: 'on_hold', status: 'in_progress' });
    expect(world.serviceRequest.status).toBe('in_progress');
  });

  test('Duplicate changes the stage but never notifies; hidden stages never notify', async () => {
    for (const [i, stageId] of ['C38:APOLOGY', 'C38:PREPARATION', 'C38:1'].entries()) {
      inbox.push(newInbox({ id: 10 + i }));
      api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: stageId, DATE_MODIFY: `2030-01-02T1${i}:00:00+00:00` }) });
      await run();
    }
    expect(world.notifications).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
  });
});

// ---- notifications -------------------------------------------------------------------------------------------------
describe('patient notifications', () => {
  test('never carry the Deal\'s notes, comments, title or any personal data', async () => {
    await run();
    const sent = JSON.stringify([world.notifications, world.deliveries]);
    expect(sent).not.toMatch(/INTERNAL NOTE|Asha|971501234567/);
    expect(world.notifications[0].body).toBe(STAGE_BODY);
  });
  test('the notification and its push delivery are written inside the same transaction as the stage change, in that order', async () => {
    await run();
    expect(order).toEqual(['inbox:processed', 'case', 'stage-event', 'link', 'notification', 'delivery']);
    expect(world.deliveries).toEqual([expect.objectContaining({ deviceId: 10, destinationKey: 'device:10' })]);
    // Only the transaction client has notification and delivery tables: both were handed `tx`, not the shared client.
    expect(prisma.notification).toBeUndefined();
    expect(prisma.notificationDelivery).toBeUndefined();
    expect(prisma.tx.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.tx.notificationDelivery.create).toHaveBeenCalledTimes(1);
  });
  test('the references and the event reference come from the persisted stage event', async () => {
    await run();
    expect(world.stageEvents).toHaveLength(1);
    expect(world.notifications[0]).toMatchObject({
      recipientId: 55, caseId: 7, serviceRequestId: 3, quotationId: null,
      idempotencyKey: `stage_update:patient:55:cse${world.stageEvents[0].id}`,
      data: { screen: 'request', entityType: 'service_request', entityId: 3 },
    });
    expect(world.notifications[0].idempotencyKey).not.toMatch(/\d{4}-\d\d-\d\d|inbox|bitrix/i); // not time-, inbox- or Deal-based
  });
  test('a notification the core rejects (it cannot verify the patient\'s request) rolls the whole stage change back and queues no delivery', async () => {
    prisma.tx.serviceRequest.findUnique.mockResolvedValueOnce(null);
    await run();
    expect(world.notifications).toHaveLength(0);
    expect(world.stageEvents).toHaveLength(0);
    expect(world.case).toMatchObject({ charter_stage: 'patient_details', status: 'submitted', stage_version: 0 });
    expect(world.deliveries).toHaveLength(0);
  });
  test('no deliveries are queued when the notification already existed (created: false); the stage change still applies', async () => {
    world.notifications.push({ id: 1, recipientType: 'patient', recipientId: 55, kind: 'stage_update', caseId: 7, serviceRequestId: 3, quotationId: null, idempotencyKey: 'stage_update:patient:55:cse1', deletedAt: new Date() });
    await run();
    expect(world.case.charter_stage).toBe('in_progress');
    expect(world.stageEvents).toHaveLength(1);
    expect(world.notifications).toHaveLength(1);
    expect(world.deliveries).toHaveLength(0);
  });
  test('a delivery that cannot be queued rolls the WHOLE stage change back, notification included (one transaction); nothing is swallowed or sent', async () => {
    prisma.tx.notificationDelivery.create.mockRejectedValueOnce(Object.assign(new Error('connection lost for ExponentPushToken[fake]'), { code: 'P1001' }));
    await run();
    expect(world.notifications).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
    expect(world.stageEvents).toHaveLength(0);
    expect(world.case).toMatchObject({ charter_stage: 'patient_details', status: 'submitted', stage_version: 0 });
    expect(logged()).not.toContain('ExponentPushToken');
    expect(require('../../src/integrations/push/expo-push.service').sendExpoPush).not.toHaveBeenCalled();
  });
  test('a repeated delivery of the same state queues nothing more', async () => {
    await run();
    inbox.push(newInbox({ id: 2 }));
    await run();
    expect(world.notifications).toHaveLength(1);
    expect(world.deliveries).toHaveLength(1);
    expect(world.stageEvents).toHaveLength(1);
  });
  test('a rolled-back transaction leaves no notification and no delivery', async () => {
    prisma.tx.notification.create.mockRejectedValueOnce(new Error('db error'));
    await run();
    expect(world.notifications).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
  });
  test('quarantined and unresolved transitions never notify', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:WON', [REF_FIELD]: 'OTHER' }) });
    await run();
    expect(world.notifications).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
  });
});

// ---- push deliveries (Phase 4) -------------------------------------------------------------------------------------
describe('push deliveries of the stage notification', () => {
  const device = (over = {}) => { const d = { id: 11 + world.devices.length, ownerType: 'patient', ownerId: 55, status: 'active', expoPushToken: `ExponentPushToken[secret${world.devices.length}]`, lastRegisteredAt: new Date('2030-01-02T09:00:00Z'), ...over }; world.devices.push(d); return d; };

  test('one delivery per ACTIVE device of the patient; inactive devices and other people\'s devices get none', async () => {
    const b = device(); const c = device();
    device({ status: 'inactive' }); device({ ownerId: 56 }); device({ ownerType: 'corporate_user' });
    await run();
    expect(world.notifications).toHaveLength(1);
    expect(world.deliveries.map((d) => d.deviceId)).toEqual([10, b.id, c.id]);
    expect(world.deliveries.every((d) => d.notificationId === world.notifications[0].id && d.recipientId === 55 && d.channel === 'push')).toBe(true);
  });

  test('a patient with no device still gets the in-app notification and no delivery', async () => {
    world.devices = [];
    await run();
    expect(world.notifications).toHaveLength(1);
    expect(world.deliveries).toHaveLength(0);
  });

  test('pushEnabled=false: the notification is created, no delivery is queued (stage_update is not mandatory)', async () => {
    world.prefs[55] = { inAppEnabled: true, pushEnabled: false };
    await run();
    expect(world.notifications[0]).toMatchObject({ kind: 'stage_update', isMandatory: false });
    expect(world.deliveries).toHaveLength(0);
  });

  test('inAppEnabled=false does not stop the push: the delivery is queued', async () => {
    world.prefs[55] = { inAppEnabled: false, pushEnabled: true };
    await run();
    expect(world.deliveries).toHaveLength(1);
  });

  test('a device registered after the notification was created gets nothing', async () => {
    device({ lastRegisteredAt: new Date('2030-01-02T11:00:00Z') });
    await run();
    expect(world.deliveries.map((d) => d.deviceId)).toEqual([10]);
  });

  test('a replay of the same stage (another delivery of the event) queues no second set', async () => {
    device();
    await run();
    expect(world.deliveries).toHaveLength(2);
    inbox.push(newInbox({ id: 2 }));
    await run();
    expect(world.notifications).toHaveLength(1);
    expect(world.deliveries).toHaveLength(2);
  });

  test('the helper is handed the stage transaction\'s client and the persisted notification; it is not called for a replay or a hidden stage', async () => {
    const calls = [];
    const enqueuePush = jest.fn(async (tx, notification) => { calls.push([tx, notification]); return require('../../src/modules/notifications/push-delivery-enqueue').enqueuePushDeliveries(tx, notification); });
    await run({ enqueuePush });
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    expect(calls[0][0]).toBe(prisma.tx);
    expect(calls[0][0].$transaction).toBeUndefined();
    expect(calls[0][1]).toMatchObject({ id: world.notifications[0].id, recipientId: 55, kind: 'stage_update' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // no second transaction for the deliveries
    inbox.push(newInbox({ id: 2 })); // the same state again
    await run({ enqueuePush });
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    inbox.push(newInbox({ id: 3 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:APOLOGY', DATE_MODIFY: '2030-01-02T13:00:00+00:00' }) }); // a stage the patient is not told about
    await run({ enqueuePush });
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    expect(world.deliveries).toHaveLength(1);
  });

  describe('scoped, synthetic and test runs queue nothing; the in-app notification and the stage change are unaffected', () => {
    const queuesNone = () => {
      expect(inbox[0].status).toBe('processed');
      expect(world.case.charter_stage).toBe('in_progress');
      expect(world.notifications).toHaveLength(1);
      expect(world.deliveries).toHaveLength(0);
    };

    test('the explicit no-op (what single-deal-detect and "--no-push" pass) queues nothing, whatever the environment says', async () => {
      await run({ enqueuePush: suppressedEnqueuePush });
      queuesNone();
      expect(await suppressedEnqueuePush({}, { id: 5 })).toEqual({ notificationId: 5, enqueued: 0, alreadyQueued: 0, skipped: 'suppressed' });
    });

    test.each([
      ['a test run (NODE_ENV=test)', { NODE_ENV: 'test' }],
      ['a scoped test run', { HUMANCARE_SCOPED_RUN: 'true' }],
      ['an integration test run', { HUMANCARE_INTEGRATION_RUN: 'true' }],
      ['a synthetic E2E run', { SYNTHETIC_E2E_AUTO_APPROVE: 'true' }],
    ])('%s', async (_name, extra) => {
      const enqueuePush = jest.fn();
      await run({ env: { ...ENV_ON, ...extra }, enqueuePush });
      queuesNone();
      expect(enqueuePush).not.toHaveBeenCalled();
    });

    test('a synthetic E2E patient identity', async () => {
      world.serviceRequest.patientName = 'ZZ-SYNTHETIC Patient';
      await run();
      queuesNone();
    });

    test('the old "push" option is refused loudly, not silently ignored (it meant "no push": ignoring it would queue deliveries)', async () => {
      await expect(run({ push: async () => undefined })).rejects.toThrow(/replaced by "enqueuePush"/);
      expect(world.deliveries).toHaveLength(0);
      expect(inbox[0].status).toBe('received');
    });

    test('an undefined enqueuePush means the default, never "nothing"', async () => {
      await run({ enqueuePush: undefined });
      expect(world.deliveries).toHaveLength(1);
    });
  });

  test('the Bitrix sender has no direct Expo call, no User.pushToken lookup and no network code', async () => {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '../../src/modules/bitrix/deal-inbox.service.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/sendExpoPush|expo-push\.service|expo-push\.client|pushToken|push_token|\bfetch\b/);
    expect(code).not.toMatch(/ctx\.push\b|\bpush:\s/);
    await run();
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); // the shared client's user lookup (the old token read) is never made
    expect(require('../../src/integrations/push/expo-push.service').sendExpoPush).not.toHaveBeenCalled();
  });
});

// ---- identification and quarantine ---------------------------------------------------------------------------------
describe('quarantine', () => {
  const quarantined = (code) => {
    expect(inbox[0]).toMatchObject({ status: 'ignored', lastError: `quarantined:${code}` });
    expect(world.audit.map((a) => a.action)).toEqual(['bitrix.deal.inbound_quarantined']);
    expect(world.audit[0]).toMatchObject({ reasonCode: `quarantine:${code}`, actorType: 'bitrix', source: 'bitrix_webhook', entityType: 'integration_inbox', entityId: '1' });
    expect(world.case).toMatchObject({ charter_stage: 'patient_details', status: 'submitted', stage_version: 0 });
    expect(world.stageEvents).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
    expect(world.deliveries).toHaveLength(0);
  };

  test.each([
    ['a different Deal ID', { ID: '9999' }, 'deal_id_mismatch'],
    ['another category', { CATEGORY_ID: '12' }, 'category_mismatch'],
    ['a missing category', { CATEGORY_ID: undefined }, 'category_mismatch'],
    ['a different Case reference', { [REF_FIELD]: 'HC-PC-000999' }, 'reference_mismatch'],
    ['a reference differing only in case', { [REF_FIELD]: REF.toLowerCase() }, 'reference_mismatch'],
    ['a reference with padding', { [REF_FIELD]: ` ${REF}` }, 'reference_mismatch'],
    ['a missing reference', { [REF_FIELD]: undefined }, 'reference_mismatch'],
    ['an unknown stage', { STAGE_ID: 'C38:SOMETHING' }, 'unknown_stage'],
    ['the obsolete On Hold stage', { STAGE_ID: 'C38:UC_1PK4XX' }, 'obsolete_stage'],
    ['a stage of another category', { STAGE_ID: 'C12:WON' }, 'unknown_stage'],
    ['a missing stage', { STAGE_ID: undefined }, 'stage_missing'],
    ['Deal Lost with another reason', { STAGE_ID: 'C38:LOSE', [LOST_FIELD]: '5916' }, 'lost_reason_unmapped'],
    ['Deal Lost with no reason', { STAGE_ID: 'C38:LOSE' }, 'lost_reason_missing'],
    ['no modified time', { DATE_MODIFY: undefined }, 'modified_time_missing'],
    ['an unreadable modified time', { DATE_MODIFY: 'yesterday-ish' }, 'modified_time_missing'],
  ])('%s -> quarantined (%s)', async (_name, over, code) => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody(over) });
    await run();
    quarantined(code);
    expect(world.audit[0].afterData).toMatchObject({ inboxEventId: 1, bitrixDealId: DEAL, caseId: 7, caseReference: REF });
  });

  test('Deal Lost is quarantined while the lost-reason field is not configured', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:LOSE', [LOST_FIELD]: '5914' }) });
    await run({ lostReasonField: null });
    quarantined('lost_reason_field_not_configured');
  });

  test('Bitrix says the Deal does not exist -> quarantined', async () => {
    api.getDeal.mockResolvedValue({ status: 'not_found' });
    await run();
    quarantined('deal_not_found');
  });

  test.each([
    ['another service', (w) => { w.serviceRequest.serviceKey = 'ground'; }],
    ['a request outside the review workflow (NULL review status)', (w) => { w.serviceRequest.reviewStatus = null; }],
    ['a request that has a Lead', (w) => { w.serviceRequest.bitrixLeadId = 4321; }],
  ])('%s -> quarantined without even asking Bitrix', async (_name, change) => {
    change(world);
    await run();
    quarantined('case_not_eligible');
    expect(api.getDeal).not.toHaveBeenCalled();
  });

  test('a Deal that is not linked to any Case: retried while our own link may still be saving, then quarantined; no Case is created', async () => {
    world.present = false;
    for (let i = 1; i < NOT_LINKED_RETRIES; i += 1) {
      await run();
      expect(inbox[0]).toMatchObject({ status: 'received', lastError: 'deal_not_linked_yet' });
      clock += 10000;
    }
    await run();
    expect(inbox[0]).toMatchObject({ status: 'ignored', lastError: 'quarantined:deal_not_linked' });
    expect(world.audit.map((a) => a.action)).toEqual(['bitrix.deal.inbound_quarantined']);
    expect(world.audit[0].caseId).toBeNull();
    expect(api.getDeal).not.toHaveBeenCalled();
    expect(world.stageEvents).toHaveLength(0);
  });

  test('a quarantined event is final: it is never claimed again', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:SOMETHING' }) });
    await run();
    clock += 100000;
    await run();
    expect(api.getDeal).toHaveBeenCalledTimes(1);
  });
});

describe('Bitrix cannot be read', () => {
  test('a failed read is retried with a growing delay, then ends failed with an audit entry; the Case is never touched', async () => {
    api.getDeal.mockResolvedValue({ status: 'uncertain', reason: 'timeout' });
    let lastDelay = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await run();
      expect(inbox[0]).toMatchObject({ status: 'received', lastError: 'bitrix_read_failed' });
      expect(inbox[0].nextAt - clock).toBeGreaterThanOrEqual(lastDelay);
      lastDelay = inbox[0].nextAt - clock;
      clock = inbox[0].nextAt;
    }
    await run();
    expect(inbox[0]).toMatchObject({ status: 'failed', lastError: 'bitrix_read_failed' });
    expect(auditActions()).toEqual(['bitrix.deal.inbound_failed']);
    expect(world.case.stage_version).toBe(0);
  });
});

// ---- idempotency, ordering, concurrency ----------------------------------------------------------------------------
describe('duplicates, ordering and concurrency', () => {
  test('two deliveries of the same state: one stage event, one audit entry, one notification', async () => {
    inbox.push(newInbox({ id: 2 }));
    await run();
    expect(world.stageEvents).toHaveLength(1);
    expect(world.notifications).toHaveLength(1);
    expect(inbox.map((e) => e.status)).toEqual(['processed', 'ignored']);
    expect(inbox[1].lastError).toBe('ignored:already_applied');
    expect(auditActions()).toEqual(['bitrix.deal.stage_synced', 'bitrix.deal.inbound_ignored']);
  });

  test('the same state with a new modified time changes nothing but the sync time', async () => {
    await run();
    inbox.push(newInbox({ id: 2 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ DATE_MODIFY: '2030-01-02T12:00:00+00:00' }) });
    await run();
    expect(inbox[1]).toMatchObject({ status: 'ignored', lastError: 'ignored:no_change' });
    expect(world.stageEvents).toHaveLength(1);
    expect(world.case.stage_version).toBe(1);
    expect(world.link.externalModifiedAt).toEqual(new Date('2030-01-02T12:00:00+00:00'));
  });

  test('an older state arriving later never moves the Case backwards', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:FINAL_INVOICE', DATE_MODIFY: '2030-01-05T10:00:00+00:00' }) });
    await run();
    inbox.push(newInbox({ id: 2 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-04T10:00:00+00:00' }) });
    await run();
    expect(world.case.charter_stage).toBe('final_invoice');
    expect(inbox[1]).toMatchObject({ status: 'ignored', lastError: 'ignored:stale_event' });
    expect(world.notifications).toHaveLength(1);
    expect(world.link.stageId).toBe('C38:FINAL_INVOICE');
  });

  test('a different stage with exactly the same modified time is looked at again before it is applied', async () => {
    await run(); // EXECUTING at 10:00:00
    inbox.push(newInbox({ id: 2 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:FINAL_INVOICE' }) }); // same second
    await run();
    expect(inbox[1]).toMatchObject({ status: 'received', lastError: 'same_second_conflict' });
    expect(world.case.charter_stage).toBe('in_progress');
    expect(world.notifications).toHaveLength(1);
    clock = inbox[1].nextAt;
    await run();
    expect(inbox[1].status).toBe('processed'); // the second, later read is applied
    expect(world.case.charter_stage).toBe('final_invoice');
    expect(world.notifications).toHaveLength(2);
  });

  test('a completed or cancelled Case is never reopened or changed by an inbound event', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:WON', DATE_MODIFY: '2030-01-05T10:00:00+00:00' }) });
    await run();
    inbox.push(newInbox({ id: 2 }));
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:EXECUTING', DATE_MODIFY: '2030-01-06T10:00:00+00:00' }) });
    await run();
    expect(world.case).toMatchObject({ charter_stage: 'completed', status: 'completed' });
    expect(inbox[1]).toMatchObject({ status: 'ignored', lastError: 'quarantined:case_already_closed' });
    expect(auditActions()).toContain('bitrix.deal.inbound_quarantined');
    expect(world.notifications).toHaveLength(1);
  });

  test('concurrent events for one Deal: the Case row lock serialises them, exactly one applies', async () => {
    inbox = [newInbox({ id: 1 }), newInbox({ id: 2 }), newInbox({ id: 3 })];
    await Promise.all([run({ workerId: 'worker-A' }), run({ workerId: 'worker-B' })]);
    expect(world.stageEvents).toHaveLength(1);
    expect(world.notifications).toHaveLength(1);
    expect(world.case.stage_version).toBe(1);
    expect(inbox.filter((e) => e.status === 'processed')).toHaveLength(1);
    expect(inbox.filter((e) => e.status === 'ignored')).toHaveLength(2);
    expect(world.deliveries).toHaveLength(1);
  });

  test('an event is claimed by only one worker at a time', async () => {
    const [a, b] = await Promise.all([store.claim(null, { id: 1, workerId: 'A', leaseSeconds: 120 }), store.claim(null, { id: 1, workerId: 'B', leaseSeconds: 120 })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

// ---- transactions, leases ------------------------------------------------------------------------------------------
describe('rollback and lease', () => {
  test.each([
    ['the stage event write', (p) => p.tx.caseStageEvent.create],
    ['the link update', (p) => p.tx.bitrixDealLink.update],
    ['the request status update', (p) => p.tx.serviceRequest.update],
    ['the audit write', (p) => p.tx.auditLog.create],
  ])('a failure in %s leaves no partial Case, event, notification or audit entry', async (_name, pick) => {
    pick(prisma).mockImplementationOnce(async () => { throw new Error('simulated write failure'); });
    await run();
    expect(world.case).toMatchObject({ charter_stage: 'patient_details', status: 'submitted', stage_version: 0 });
    expect(world.stageEvents).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
    expect(world.audit).toHaveLength(0);
    expect(world.link.stageId).toBe('C38:NEW');
    expect(inbox[0].status).toBe('processing'); // unchanged: the lease expires and the event is retried
    expect(world.deliveries).toHaveLength(0);
    expect(logged()).not.toContain('simulated write failure'); // only the error name is logged
  });

  test('an event left in processing is retried after its lease expires, and then applies cleanly', async () => {
    prisma.tx.caseStageEvent.create.mockImplementationOnce(async () => { throw new Error('boom'); });
    await run();
    clock += LEASE_SECONDS + 1;
    await run();
    expect(inbox[0].status).toBe('processed');
    expect(world.stageEvents).toHaveLength(1);
    expect(world.notifications).toHaveLength(1);
  });

  test('a concurrent change to the Case (stage_version) rolls back and writes nothing', async () => {
    prisma.tx.case.updateMany.mockResolvedValueOnce({ count: 0 });
    await run();
    expect(world.case.stage_version).toBe(0);
    expect(world.stageEvents).toHaveLength(0);
    expect(inbox[0].status).toBe('processing');
  });

  test('a worker whose lease expired during the Bitrix read cannot record anything or change the Case', async () => {
    api.getDeal.mockImplementation(async () => { clock += LEASE_SECONDS + 1; return { status: 'ok', deal: dealBody() }; });
    await run();
    expect(world.case.stage_version).toBe(0);
    expect(world.stageEvents).toHaveLength(0);
    expect(world.notifications).toHaveLength(0);
    expect(inbox[0].status).toBe('processing');
    expect(world.deliveries).toHaveLength(0);
  });

  test('Bitrix is read outside any database transaction', async () => {
    let depth = 0;
    const original = prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockImplementation((cb) => original(async (tx) => { depth += 1; try { return await cb(tx); } finally { depth -= 1; } }));
    api.getDeal.mockImplementation(async () => { expect(depth).toBe(0); return { status: 'ok', deal: dealBody() }; });
    await run();
    expect(api.getDeal).toHaveBeenCalledTimes(1);
  });
});

// ---- audit and privacy ---------------------------------------------------------------------------------------------
describe('audit and logs', () => {
  test('an applied stage is audited with the previous and new stage, Bitrix stage, Deal, Case and event', async () => {
    await run();
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({
      action: 'bitrix.deal.stage_synced', entityType: 'case', entityId: '7', caseId: 7, actorType: 'bitrix', source: 'bitrix_webhook', reasonCode: 'stage:in_progress',
      beforeData: { charterStage: 'patient_details', status: 'submitted', stageVersion: 0 },
      afterData: { charterStage: 'in_progress', status: 'in_progress', stageVersion: 1, bitrixStageId: 'C38:EXECUTING', bitrixDealId: DEAL, caseId: 7, caseReference: REF, inboxEventId: 1 },
    });
  });
  test('the audit entries and logs never contain patient data, notes or tokens', async () => {
    api.getDeal.mockResolvedValue({ status: 'ok', deal: dealBody({ STAGE_ID: 'C38:SOMETHING' }) });
    await run();
    const everything = JSON.stringify(world.audit) + logged();
    expect(everything).not.toMatch(/INTERNAL NOTE|Asha|971501234567|ExponentPushToken|fake-inbound-token/);
    expect(logged()).toContain('[ALERT]');
  });
  test('an unexpected error logs only its name', async () => {
    prisma.bitrixDealLink.findUnique.mockRejectedValueOnce(Object.assign(new Error('contains Asha Rao +971501234567'), { name: 'WeirdError' }));
    await run();
    expect(logged()).toContain('WeirdError');
    expect(logged()).not.toMatch(/Asha|971501234567/);
  });
  test('the processor never creates a Case, Deal or Lead: it has no way to', () => {
    expect(Object.keys(api)).toEqual(['getDeal']);
    expect(prisma.tx.case.create).toBeUndefined();
  });
});

// ---- the real store's SQL ------------------------------------------------------------------------------------------
describe('the SQL of the real inbox store', () => {
  const text = (strings) => strings.join('?').replace(/\s+/g, ' ');
  function fakeDb(results = []) {
    const executed = []; const queried = [];
    const db = {
      $executeRaw: jest.fn(async (strings, ...values) => { executed.push({ sql: text(strings), values }); return 1; }),
      $queryRaw: jest.fn(async (strings, ...values) => { queried.push({ sql: text(strings), values }); return results.shift() ?? []; }),
      $transaction: jest.fn(async (cb) => cb(db)),
    };
    return { db, executed, queried };
  }

  test('due events: only bitrix24 ONCRMDEALUPDATE rows that are "received", due and not leased, on the database clock', async () => {
    const { db, queried } = fakeDb([[{ id: 3n }]]);
    expect(await realStore.findDueIds(db, 10, 'test')).toEqual([3]);
    expect(queried[0].sql).toContain("status = 'received'");
    expect(queried[0].sql).toContain('next_attempt_at <= UTC_TIMESTAMP(3)');
    expect(queried[0].sql).toContain('locked_until IS NULL OR i.locked_until <= UTC_TIMESTAMP(3)');
    // only the active profile's events: the Deal link's profile (an unlinked Deal reads as test)
    expect(queried[0].sql).toContain("COALESCE(l.profile, 'test') = ?");
    expect(queried[0].values).toEqual(expect.arrayContaining(['bitrix24', 'ONCRMDEALUPDATE', 'test']));
  });
  test('claim: a locking read then one compare-and-swap UPDATE with a database-clock lease', async () => {
    const { db, executed, queried } = fakeDb([[{ id: 3, attempts: 0, entity_id: '4711' }]]);
    const claimed = await realStore.claim(db, { id: 3, workerId: 'w', leaseSeconds: 120 });
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(executed[0].sql).toContain("status = 'processing', attempts = attempts + 1");
    expect(executed[0].sql).toContain('locked_until = UTC_TIMESTAMP(3) + INTERVAL ? SECOND');
    expect(executed[0].sql).toContain("WHERE id = ? AND status = 'received' AND attempts = ?");
    expect(executed[0].sql).not.toMatch(/NOW\(/i);
    expect(claimed).toMatchObject({ id: 3, attempts: 1, dealId: '4711' });
  });
  test('claim: another worker got there first -> null', async () => {
    const lost = fakeDb([[{ id: 3, attempts: 0, entity_id: '4711' }]]);
    lost.db.$executeRaw.mockResolvedValue(0);
    expect(await realStore.claim(lost.db, { id: 3, workerId: 'w', leaseSeconds: 120 })).toBeNull();
    expect(await realStore.claim(fakeDb([[]]).db, { id: 3, workerId: 'w', leaseSeconds: 120 })).toBeNull();
  });
  test('the result UPDATE is fenced on id, status, attempts, owner and an unexpired lease', async () => {
    const { db, executed } = fakeDb();
    expect(await realStore.writeResult(db, { id: 3, attempts: 2, workerId: 'w' }, { status: 'processed' })).toBe(1);
    expect(executed[0].sql).toContain("WHERE id = ? AND status = 'processing' AND attempts = ? AND locked_by = ?");
    expect(executed[0].sql).toContain('locked_until > UTC_TIMESTAMP(3)');
  });
  test('recovery: expired leases go back to "received" or, past the cap, "failed"', async () => {
    const { db, executed } = fakeDb();
    await realStore.recoverExpiredLeases(db, { maxAttempts: 8 });
    expect(executed[0].sql).toContain("SET status = 'failed'");
    expect(executed[0].sql).toContain('attempts >= ?');
    expect(executed[1].sql).toContain("SET status = 'received'");
    expect(executed[1].sql).toContain('attempts < ?');
  });
  test('last_error is a short code only', () => {
    expect(realStore.cleanCode('quarantined:unknown_stage')).toBe('quarantined:unknown_stage');
    expect(realStore.cleanCode('bad https://x.invalid/a b')).not.toMatch(/[ /]/);
    expect(realStore.cleanCode('a'.repeat(500))).toHaveLength(200);
  });
});
