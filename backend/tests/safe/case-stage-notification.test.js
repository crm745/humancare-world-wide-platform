/* global describe, test, expect, beforeEach, jest */
// updateCaseStage / applyStageChange (the admin stage change), rule by rule. No database, no network: Prisma is an in-memory fake whose
// $transaction rolls everything back when its callback throws, and a transaction client has no $transaction (like the real one).
//
//   transaction 1: the Case status, the stage event and the request status, together
//   transaction 2 (after the commit; patient Cases only): the patient's notification and its push deliveries, together
// A corporate Case (no service request) is updated and nobody is notified.
const mockWorld = {};
const mockOrder = [];

jest.mock('../../src/db/prisma', () => {
  const w = () => mockWorld;
  const pickFields = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row });
  const tx = {
    case: {
      findUnique: jest.fn(async ({ where }) => {
        const c = w().case;
        if (!c || (where.id !== undefined && where.id !== c.id)) return null; // getCaseById and the core's case check
        return { ...c, serviceRequest: c.serviceRequest ? { ...c.serviceRequest } : null, stageEvents: [], documents: [] };
      }),
      update: jest.fn(async ({ data }) => { mockOrder.push('case'); Object.assign(w().case, data); return { ...w().case }; }),
    },
    caseStageEvent: {
      create: jest.fn(async ({ data }) => { mockOrder.push('stage-event'); const row = { id: w().stageEvents.length + 1, ...data }; w().stageEvents.push(row); return { ...row }; }),
    },
    serviceRequest: {
      update: jest.fn(async ({ data }) => { mockOrder.push('request'); Object.assign(w().case.serviceRequest, data); }),
      findUnique: jest.fn(async ({ where, select }) => { const sr = w().case.serviceRequest; return sr && where.id === sr.id ? pickFields(sr, select || { id: true, userId: true }) : null; }),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => (where.id === 55 ? { id: 55 } : null)),
    },
    notification: {
      findUnique: jest.fn(async ({ where }) => {
        const f = where.id !== undefined ? w().notifications.find((n) => n.id === where.id) : w().notifications.find((n) => n.idempotencyKey === where.idempotencyKey);
        return f ? { ...f } : null;
      }),
      create: jest.fn(async ({ data }) => {
        mockOrder.push('notification');
        if (w().notifications.some((n) => n.idempotencyKey === data.idempotencyKey)) { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notifications_idempotency_key_key' }; throw e; }
        const row = { id: w().notifications.length + 1, readAt: null, deletedAt: null, createdAt: new Date('2030-01-02T10:00:00Z'), ...data };
        w().notifications.push(row);
        return { ...row };
      }),
    },
    notificationPreference: { findUnique: jest.fn(async ({ where }) => { const p = w().prefs[where.ownerType_ownerId.ownerId]; return p ? { ...p } : null; }) },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select }) => w().devices
        .filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status && +d.lastRegisteredAt <= +where.lastRegisteredAt.lte)
        .sort((a, b) => a.id - b.id).map((d) => pickFields(d, select))),
    },
    notificationDelivery: {
      findMany: jest.fn(async ({ where, select }) => w().deliveries.filter((d) => d.notificationId === where.notificationId && d.channel === where.channel).map((d) => pickFields(d, select))),
      create: jest.fn(async ({ data, select }) => {
        mockOrder.push('delivery');
        if (w().deliveries.some((d) => d.notificationId === data.notificationId && d.channel === data.channel && d.destinationKey === data.destinationKey)) { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notification_deliveries_dest_key' }; throw e; }
        const row = { id: w().deliveries.length + 1, status: 'pending', attemptCount: 0, ...data };
        w().deliveries.push(row);
        return pickFields(row, select);
      }),
    },
  };
  const prisma = {
    ...tx,
    // Like Prisma: the callback gets a client WITHOUT $transaction; a throw undoes everything the callback wrote.
    $transaction: jest.fn(async (fn) => {
      const snapshot = JSON.parse(JSON.stringify(w()), (k, v) => (/At$/.test(k) && typeof v === 'string' ? new Date(v) : v));
      mockOrder.push('tx');
      try {
        const result = await fn({ ...tx });
        mockOrder.push('tx-end');
        return result;
      } catch (err) {
        for (const key of Object.keys(snapshot)) w()[key] = snapshot[key]; // roll back
        mockOrder.push('tx-rolled-back');
        throw err;
      }
    }),
  };
  return { prisma };
});
jest.mock('../../src/modules/bitrix/bitrix.service', () => ({ createLead: jest.fn(), sendMedicalReportToBitrix: jest.fn() }));
jest.mock('../../src/integrations/push/expo-push.service', () => ({ sendExpoPush: jest.fn() })); // the legacy sender: it must never be reached

const { prisma } = require('../../src/db/prisma');
const { sendExpoPush } = require('../../src/integrations/push/expo-push.service');
const { updateCaseStage, applyStageChange } = require('../../src/modules/cases/cases.service');
const { suppressedEnqueuePush, enqueuePushDeliveries } = require('../../src/modules/notifications/push-delivery-enqueue');

const TITLE = 'Your case has been updated';
const BODY = 'Your case status has been updated.';
const LIVE = { NODE_ENV: 'development' }; // a run that may queue push deliveries (a jest run, NODE_ENV=test, deliberately may not)
let log;
const deps = (extra = {}) => ({ env: LIVE, log, ...extra });
const device = (over = {}) => { const d = { id: 10 + mockWorld.devices.length, ownerType: 'patient', ownerId: 55, status: 'active', expoPushToken: `ExponentPushToken[secret${mockWorld.devices.length}]`, lastRegisteredAt: new Date('2030-01-02T09:00:00Z'), ...over }; mockWorld.devices.push(d); return d; };

beforeEach(() => {
  Object.assign(mockWorld, {
    case: { id: 7, referenceNumber: 'CASE-1007', status: 'submitted', corporateId: null, serviceRequestId: 3, serviceRequest: { id: 3, userId: 55, referenceNumber: 'REQ-3', status: 'submitted', patientName: 'Asha Rao' } },
    stageEvents: [], notifications: [], deliveries: [], devices: [], prefs: {},
  });
  mockOrder.length = 0;
  jest.clearAllMocks();
  log = { error: jest.fn(), warn: jest.fn() };
});

describe('a patient case stage change: the stage and the in-app notification', () => {
  test('creates one notification through the core with the right patient, references, event reference and catalogue text', async () => {
    await updateCaseStage(7, 'in_progress', 'Patient moved to ICU ward 4 after cardiac event', deps());
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.notifications[0]).toMatchObject({
      recipientType: 'patient', recipientId: 55, kind: 'stage_update', title: TITLE, body: BODY, isMandatory: false,
      caseId: 7, serviceRequestId: 3, quotationId: null,
      idempotencyKey: `stage_update:patient:55:cse${mockWorld.stageEvents[0].id}`,
      data: { screen: 'request', entityType: 'service_request', entityId: 3 },
    });
  });

  test('the staff note is stored on the stage event but never copied into the notification or any delivery', async () => {
    device();
    await updateCaseStage(7, 'in_progress', 'Patient moved to ICU ward 4 after cardiac event', deps());
    expect(mockWorld.stageEvents[0].note).toBe('Patient moved to ICU ward 4 after cardiac event');
    expect(JSON.stringify([mockWorld.notifications, mockWorld.deliveries])).not.toMatch(/ICU|cardiac|CASE-1007/);
  });

  test('the event reference is the persisted stage event id: each stage change is its own notification', async () => {
    await updateCaseStage(7, 'scheduled', undefined, deps());
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockWorld.stageEvents.map((e) => e.id)).toEqual([1, 2]);
    expect(mockWorld.notifications.map((n) => n.idempotencyKey)).toEqual(['stage_update:patient:55:cse1', 'stage_update:patient:55:cse2']);
  });

  test('the case and request statuses are updated as before, and the call still returns the updated Case (the HTTP response is unchanged)', async () => {
    const updated = await updateCaseStage(7, 'cancelled', undefined, deps());
    expect(mockWorld.case.status).toBe('cancelled');
    expect(mockWorld.case.serviceRequest.status).toBe('cancelled');
    expect(updated).toMatchObject({ id: 7, status: 'cancelled' });
    expect(updated).not.toHaveProperty('patientNotification');
  });

  test('the request status follows the stage vocabulary', async () => {
    for (const [stage, request] of [['submitted', 'submitted'], ['scheduled', 'in_progress'], ['in_progress', 'in_progress'], ['completed', 'completed'], ['cancelled', 'cancelled']]) {
      await updateCaseStage(7, stage, undefined, deps());
      expect(mockWorld.case.serviceRequest.status).toBe(request);
    }
  });
});

describe('push deliveries of the stage notification', () => {
  test('one delivery per ACTIVE device of the patient, queued with the notification', async () => {
    const d = device();
    const result = await applyStageChange(7, 'in_progress', undefined, deps());
    expect(result.patientNotification).toEqual({ status: 'created', deliveries: { notificationId: 1, enqueued: 1, alreadyQueued: 0, skipped: null } });
    expect(mockWorld.deliveries).toEqual([expect.objectContaining({ notificationId: 1, recipientType: 'patient', recipientId: 55, channel: 'push', provider: 'expo', deviceId: d.id, destinationKey: `device:${d.id}`, status: 'pending' })]);
  });

  test('several devices: one delivery each; inactive devices and other people\'s devices get none', async () => {
    const [a, b, c] = [device(), device(), device()];
    device({ status: 'inactive' }); device({ ownerId: 56 }); device({ ownerType: 'corporate_user' });
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockWorld.deliveries.map((d) => d.deviceId)).toEqual([a.id, b.id, c.id]);
  });

  test('no device: the in-app notification only', async () => {
    const result = await applyStageChange(7, 'in_progress', undefined, deps());
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(0);
    expect(result.patientNotification).toMatchObject({ status: 'created', deliveries: { skipped: 'no_active_devices' } });
  });

  test('pushEnabled=false: the notification is created, no delivery is queued (stage_update is not mandatory)', async () => {
    device();
    mockWorld.prefs[55] = { inAppEnabled: true, pushEnabled: false };
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(0);
  });

  test('inAppEnabled=false does not stop the push', async () => {
    device();
    mockWorld.prefs[55] = { inAppEnabled: false, pushEnabled: true };
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockWorld.deliveries).toHaveLength(1);
  });

  test('a device registered after the notification was created gets nothing', async () => {
    const early = device();
    device({ lastRegisteredAt: new Date('2030-01-02T11:00:00Z') });
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockWorld.deliveries.map((d) => d.deviceId)).toEqual([early.id]);
  });

  test('a replay (the notification of this stage event already exists, even soft-deleted) creates and queues nothing; the stage change still applies', async () => {
    device();
    mockWorld.notifications.push({ id: 1, recipientType: 'patient', recipientId: 55, kind: 'stage_update', caseId: 7, serviceRequestId: 3, quotationId: null, idempotencyKey: 'stage_update:patient:55:cse1', deletedAt: new Date() });
    const result = await applyStageChange(7, 'in_progress', undefined, deps());
    expect(result.patientNotification).toEqual({ status: 'exists' });
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(0);
    expect(mockWorld.case.status).toBe('in_progress');
  });

  test('the enqueue helper gets the notice transaction\'s own client and the persisted notification; no extra transaction is opened', async () => {
    device();
    const enqueuePush = jest.fn((tx, notification) => enqueuePushDeliveries(tx, notification));
    await updateCaseStage(7, 'in_progress', undefined, deps({ enqueuePush }));
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    const [tx, notification] = enqueuePush.mock.calls[0];
    expect(tx).not.toBe(prisma);
    expect(tx.$transaction).toBeUndefined();
    expect(notification).toMatchObject({ id: mockWorld.notifications[0].id, recipientId: 55, kind: 'stage_update' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // the stage change and the notice: exactly two, never a third for the deliveries
  });
});

describe('transaction boundaries', () => {
  test('the stage writes are ONE transaction, the notification and its delivery a SECOND one that starts after the first has committed', async () => {
    device();
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(mockOrder).toEqual(['tx', 'case', 'stage-event', 'request', 'tx-end', 'tx', 'notification', 'delivery', 'tx-end']);
  });

  test('a delivery that cannot be queued rolls back the notification (they are atomic) but NOT the committed stage change; the call succeeds and the failure is reported', async () => {
    device();
    prisma.notificationDelivery.create.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'P1001' }));
    const result = await applyStageChange(7, 'in_progress', 'x', deps());
    expect(mockWorld.notifications).toHaveLength(0); // undone with its delivery
    expect(mockWorld.deliveries).toHaveLength(0);
    expect(mockWorld.case.status).toBe('in_progress'); // the stage change stands
    expect(mockWorld.stageEvents).toHaveLength(1);
    expect(mockWorld.case.serviceRequest.status).toBe('in_progress');
    expect(result.patientNotification).toEqual({ status: 'failed', code: 'P1001' });
    expect(mockOrder).toEqual(['tx', 'case', 'stage-event', 'request', 'tx-end', 'tx', 'notification', 'tx-rolled-back']); // the delivery insert failed; only the second transaction was undone
  });
});

describe('the corporate failure coupling (an admin stage change must not fail after it has committed)', () => {
  test('REGRESSION: a patient notification that cannot be written after the commit no longer turns the stage change into an error', async () => {
    prisma.notification.create.mockRejectedValueOnce(new Error('database down'));
    await expect(updateCaseStage(7, 'in_progress', undefined, deps())).resolves.toMatchObject({ id: 7, status: 'in_progress' });
    expect(mockWorld.case.status).toBe('in_progress');
    expect(mockWorld.stageEvents).toHaveLength(1);
    expect(mockWorld.notifications).toHaveLength(0);
  });

  test('a notice the core rejects (the patient\'s request cannot be verified) is reported the same way, with its code', async () => {
    prisma.serviceRequest.findUnique.mockResolvedValueOnce(null);
    const result = await applyStageChange(7, 'in_progress', undefined, deps());
    expect(result.patientNotification).toEqual({ status: 'failed', code: 'invalid_reference' });
    expect(mockWorld.case.status).toBe('in_progress');
  });

  test('NOT swallowed: an [ALERT] line names the Case, the stage event and a short code, and never a message, a note or a token', async () => {
    device();
    prisma.notification.create.mockRejectedValueOnce(Object.assign(new Error('boom ExponentPushToken[secret0] Patient moved to ICU'), { code: 'P2034' }));
    await applyStageChange(7, 'in_progress', 'Patient moved to ICU', deps());
    expect(log.error).toHaveBeenCalledTimes(1);
    const line = log.error.mock.calls[0][0];
    expect(line).toMatch(/^\[ALERT\] Case 7: the stage change to "in_progress" is committed \(stage event 1\) but the patient's notification could not be created \(P2034\)\.$/);
    expect(line).not.toMatch(/ICU|ExponentPushToken|boom/);
  });

  test('a real failure of the stage change itself still fails the call, and nothing is notified', async () => {
    prisma.case.update.mockRejectedValueOnce(new Error('case update failed'));
    await expect(updateCaseStage(7, 'in_progress', undefined, deps())).rejects.toThrow('case update failed');
    expect(mockWorld.stageEvents).toHaveLength(0);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  test('the stage change is atomic: if the request status cannot be updated, the Case status and the stage event are rolled back too', async () => {
    prisma.serviceRequest.update.mockRejectedValueOnce(Object.assign(new Error('request update failed'), { code: 'P2025' }));
    await expect(updateCaseStage(7, 'in_progress', undefined, deps())).rejects.toMatchObject({ code: 'P2025' });
    expect(mockWorld.case.status).toBe('submitted');
    expect(mockWorld.stageEvents).toHaveLength(0);
    expect(mockWorld.case.serviceRequest.status).toBe('submitted');
    expect(prisma.notification.create).not.toHaveBeenCalled(); // no notice for a stage change that did not happen
  });

  test('a stage-event failure rolls the Case status back as well', async () => {
    prisma.caseStageEvent.create.mockRejectedValueOnce(new Error('event failed'));
    await expect(updateCaseStage(7, 'scheduled', undefined, deps())).rejects.toThrow('event failed');
    expect(mockWorld.case.status).toBe('submitted');
  });

  test('a corporate Case (no service request) is updated, in one transaction, and nobody is notified', async () => {
    mockWorld.case = { id: 8, referenceNumber: 'CASE-1008', status: 'submitted', corporateId: 9, serviceRequestId: null, serviceRequest: null };
    const result = await applyStageChange(8, 'in_progress', undefined, deps());
    expect(result.patientNotification).toEqual({ status: 'not_applicable' });
    expect(mockWorld.case.status).toBe('in_progress');
    expect(mockWorld.stageEvents).toHaveLength(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    for (const fn of [prisma.notification.create, prisma.notification.findUnique, prisma.notificationDevice.findMany, prisma.notificationDelivery.create, prisma.serviceRequest.update, prisma.user.findUnique]) expect(fn).not.toHaveBeenCalled();
    expect(sendExpoPush).not.toHaveBeenCalled();
  });

  test('a corporate Case\'s stage change still fails if the stage change itself fails', async () => {
    mockWorld.case = { id: 8, referenceNumber: 'CASE-1008', status: 'submitted', corporateId: 9, serviceRequestId: null, serviceRequest: null };
    prisma.caseStageEvent.create.mockRejectedValueOnce(new Error('event failed'));
    await expect(updateCaseStage(8, 'in_progress', undefined, deps())).rejects.toThrow('event failed');
    expect(mockWorld.case.status).toBe('submitted');
  });

  test('an invalid stage is a 400 with no writes and no transaction; an unknown case is a 404 with no notification', async () => {
    await expect(updateCaseStage(7, 'nope')).rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.case.update).not.toHaveBeenCalled();
    await expect(updateCaseStage(999, 'in_progress')).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('test, scoped and synthetic runs queue nothing (the in-app notification and the stage change are unaffected)', () => {
  const unaffected = () => {
    expect(mockWorld.case.status).toBe('in_progress');
    expect(mockWorld.notifications).toHaveLength(1);
    expect(mockWorld.deliveries).toHaveLength(0);
  };

  test.each([
    ['a test run (NODE_ENV=test)', { NODE_ENV: 'test' }],
    ['a scoped test run', { NODE_ENV: 'development', HUMANCARE_SCOPED_RUN: 'true' }],
    ['an integration test run', { NODE_ENV: 'development', HUMANCARE_INTEGRATION_RUN: 'true' }],
    ['a synthetic E2E run', { NODE_ENV: 'development', SYNTHETIC_E2E_AUTO_APPROVE: 'true' }],
  ])('%s', async (_name, env) => {
    device();
    const enqueuePush = jest.fn();
    const result = await applyStageChange(7, 'in_progress', undefined, deps({ env, enqueuePush }));
    unaffected();
    expect(enqueuePush).not.toHaveBeenCalled();
    expect(result.patientNotification).toMatchObject({ status: 'created', deliveries: { skipped: 'suppressed' } });
  });

  test('by default (no env given) a jest run queues nothing', async () => {
    device();
    await updateCaseStage(7, 'in_progress', undefined, { log });
    unaffected();
  });

  test('the explicit no-op dependency queues nothing whatever the environment says', async () => {
    device();
    await updateCaseStage(7, 'in_progress', undefined, deps({ enqueuePush: suppressedEnqueuePush }));
    unaffected();
  });

  test('a synthetic E2E patient identity queues nothing', async () => {
    device();
    mockWorld.case.serviceRequest.patientName = 'ZZ-SYNTHETIC Patient';
    await updateCaseStage(7, 'in_progress', undefined, deps());
    unaffected();
  });

  test('an undefined enqueuePush means the default, never "nothing"', async () => {
    device();
    await updateCaseStage(7, 'in_progress', undefined, deps({ enqueuePush: undefined }));
    expect(mockWorld.deliveries).toHaveLength(1);
  });
});

describe('the case sender has no legacy push', () => {
  test('no direct Expo call, no User.pushToken lookup and no network code in the source; the legacy sender is never reached at run time', async () => {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '../../src/modules/cases/cases.service.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/sendExpoPush|expo-push\.service|expo-push\.client|pushToken|push_token|\bfetch\b/);
    device();
    await updateCaseStage(7, 'in_progress', undefined, deps());
    expect(sendExpoPush).not.toHaveBeenCalled();
    for (const [args] of prisma.user.findUnique.mock.calls) expect(JSON.stringify(args)).not.toMatch(/pushToken/);
  });
});
