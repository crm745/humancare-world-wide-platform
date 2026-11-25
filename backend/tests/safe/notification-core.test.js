/* global describe, test, expect, jest, beforeEach */
// createPatientNotification (notification-core.js). No database, no network: Prisma is an in-memory fake that enforces the
// unique idempotency key like MySQL does, can run a transaction with rollback, and records which client every call used.
const mockDb = {};
const mockDelivery = { create: jest.fn(), createMany: jest.fn() };
const mockAttempt = { create: jest.fn(), createMany: jest.fn() };

function mockUniqueError(target) {
  const err = new Error('Unique constraint failed');
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function mockProject(row, select) {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function mockMakeClient(label) {
  const finder = (table) => async ({ where, select }) => {
    mockDb.calls.push([label, table, 'findUnique']);
    await Promise.resolve();
    const row = mockDb[table].find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    return mockProject(row, select);
  };
  return {
    user: { findUnique: jest.fn(finder('user')) },
    serviceRequest: { findUnique: jest.fn(finder('serviceRequest')) },
    case: { findUnique: jest.fn(finder('case')) },
    caseQuotation: { findUnique: jest.fn(finder('caseQuotation')) },
    payment: { findUnique: jest.fn(finder('payment')) },
    notification: {
      findUnique: jest.fn(finder('notification')),
      create: jest.fn(async ({ data }) => {
        mockDb.calls.push([label, 'notification', 'create']);
        if (mockDb.createError) throw mockDb.createError;
        await Promise.resolve();
        // check and insert in one synchronous block, like a unique index
        if (data.idempotencyKey && mockDb.notification.some((r) => r.idempotencyKey === data.idempotencyKey)) throw mockUniqueError('notifications_idempotency_key_key');
        const row = { id: mockDb.notification.length + 1, readAt: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), data: null, ...data };
        mockDb.notification.push(row);
        return { ...row };
      }),
    },
    notificationDelivery: mockDelivery,
    notificationDeliveryAttempt: mockAttempt,
  };
}

jest.mock('../../src/db/prisma', () => {
  const main = mockMakeClient('main');
  main.$transaction = async (fn) => {
    const snapshot = mockDb.notification.map((r) => ({ ...r }));
    try {
      return await fn(mockMakeClient('tx'));
    } catch (err) {
      mockDb.notification = snapshot; // rollback
      throw err;
    }
  };
  return { prisma: main };
});

const { prisma } = require('../../src/db/prisma');
const core = require('../../src/modules/notifications/notification-core');
const { createPatientNotification, NotificationCoreError } = core;

function seed() {
  Object.assign(mockDb, {
    calls: [],
    createError: null,
    user: [{ id: 1 }, { id: 2 }],
    serviceRequest: [{ id: 10, userId: 1 }, { id: 20, userId: 2 }],
    case: [
      { id: 100, serviceRequestId: 10 }, { id: 101, serviceRequestId: 10 },
      { id: 200, serviceRequestId: 20 }, { id: 300, serviceRequestId: null }, // 300: a corporate case, no service request
    ],
    caseQuotation: [{ id: 500, caseId: 100 }, { id: 600, caseId: 200 }],
    payment: [{ id: 900, caseId: 100 }, { id: 901, caseId: 101 }],
    notification: [],
  });
}

const base = (over = {}) => ({ recipientId: 1, kind: 'system', eventRef: 'evt1', ...over });
const SYSTEM_TITLE = 'HumanCare notification';
const TITLES = {
  system: 'HumanCare notification', stage_update: 'Your case has been updated', quotation_ready: 'Your quotation is ready', document: 'A document has been updated',
  security_password_changed: 'Your password was changed', security_new_login: 'New sign-in to your account',
  payment_received: 'Payment received', payment_failed: 'Payment failed', payment_refunded: 'Payment refunded',
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { expect(e).toBeInstanceOf(NotificationCoreError); return e.code; } };

beforeEach(() => {
  seed();
  jest.clearAllMocks();
});

describe('valid creation', () => {
  test('creates one patient notification with the key, the catalogue classification and no internal client fields', async () => {
    const out = await createPatientNotification(base({ body: 'A note', data: { screen: 'home' } }));
    expect(out.created).toBe(true);
    expect(out.notification).toMatchObject({
      recipientType: 'patient', recipientId: 1, kind: 'system', title: SYSTEM_TITLE, body: 'A note', isMandatory: false,
      idempotencyKey: 'system:patient:1:evt1', data: { screen: 'home' }, caseId: null, serviceRequestId: null, quotationId: null,
    });
    expect(mockDb.notification).toHaveLength(1);
  });

  test('optional fields are left out cleanly (no data, no body)', async () => {
    const { notification } = await createPatientNotification(base());
    expect(notification.body).toBeNull();
    expect(notification.data).toBeNull();
  });

  test('a stage_update always gets the fixed safe text; a staff note is never copied', async () => {
    const { notification } = await createPatientNotification(base({ kind: 'stage_update', body: 'Patient has stage 4 cancer, move to ICU', serviceRequestId: 10, caseId: 100, data: { screen: 'case', entityType: 'case', entityId: 100 } }));
    expect(notification.body).toBe('Your case status has been updated.');
    expect(JSON.stringify(mockDb.notification)).not.toMatch(/cancer|ICU/);
  });

  test('valid optional references: case, quotation, payment', async () => {
    expect((await createPatientNotification(base({ kind: 'stage_update', eventRef: 's1', serviceRequestId: 10, caseId: 101, data: { screen: 'case', entityType: 'case', entityId: 101 } }))).created).toBe(true);
    expect((await createPatientNotification(base({ kind: 'quotation_ready', eventRef: 'q500', serviceRequestId: 10, caseId: 100, quotationId: 500, data: { screen: 'quotation', entityType: 'quotation', entityId: 500 } }))).created).toBe(true);
    expect((await createPatientNotification(base({ kind: 'quotation_ready', eventRef: 'q500b', serviceRequestId: 10, quotationId: 500 }))).created).toBe(true); // case derived from the quotation, not supplied
    expect((await createPatientNotification(base({ kind: 'payment_received', eventRef: 'p900', serviceRequestId: 10, quotationId: 500, data: { screen: 'payment', entityType: 'payment', entityId: 900 } }))).created).toBe(true);
  });
});

describe('catalogue validation', () => {
  test('rejects unknown kinds and nothing is written', async () => {
    expect(await codeOf(createPatientNotification(base({ kind: 'made_up' })))).toBe('unknown_kind');
    expect(mockDb.notification).toHaveLength(0);
    expect(mockDb.calls).toHaveLength(0); // rejected before any database access
  });

  test('rejects invalid input of every kind', async () => {
    const cases = [
      [null, 'input_invalid'], [[], 'input_invalid'],
      [base({ recipientId: 'x' }), 'invalid_recipient_id'], [base({ recipientId: 0 }), 'invalid_recipient_id'],
      [base({ body: 'x'.repeat(1001) }), 'body_too_long'],
      [base({ eventRef: undefined }), 'invalid_event_ref'], [base({ eventRef: 'a:b' }), 'invalid_event_ref'], [base({ eventRef: '' }), 'invalid_event_ref'],
      [base({ data: { diagnosis: 'x' } }), 'data_key_not_allowed'], [base({ data: { screen: 'tickets' } }), 'invalid_screen'],
      [base({ data: { screen: 'case' } }), 'screen_not_allowed_for_kind'], // system allows home only
      [base({ kind: 'stage_update', data: { screen: 'case', entityType: 'service_request', entityId: 1 }, serviceRequestId: 10 }), 'entity_type_screen_mismatch'],
      [base({ kind: 'stage_update', data: { screen: 'request', entityType: 'service_request', entityId: 11 }, serviceRequestId: 10 }), 'entity_ref_mismatch'],
      [base({ kind: 'stage_update', data: { screen: 'request' } }), 'screen_ref_required'], // missing required reference
      [base({ kind: 'payment_failed', serviceRequestId: 10 }), 'ref_required'],
      [base({ caseId: '5' }), 'ref_invalid'],
    ];
    for (const [input, code] of cases) expect(await codeOf(createPatientNotification(input))).toBe(code);
    expect(mockDb.notification).toHaveLength(0);
  });

  test('a case or quotation reference needs the serviceRequestId (ownership is never inferred from a case alone)', async () => {
    expect(await codeOf(createPatientNotification(base({ kind: 'stage_update', caseId: 100 })))).toBe('service_request_required');
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', quotationId: 500 })))).toBe('service_request_required');
  });
});

describe('titles come only from the catalogue', () => {
  const REFS = { stage_update: { serviceRequestId: 10 }, quotation_ready: { serviceRequestId: 10, quotationId: 500 }, payment_received: { serviceRequestId: 10, quotationId: 500 }, payment_failed: { serviceRequestId: 10, quotationId: 500 }, payment_refunded: { serviceRequestId: 10, quotationId: 500 } };

  test('every supported kind has a fixed, non-empty, short title and the core stores exactly that', async () => {
    const catalogue = require('../../src/modules/notifications/notification-catalogue');
    expect(Object.keys(TITLES).sort()).toEqual(Object.keys(catalogue.CATALOGUE).sort());
    for (const [kind, title] of Object.entries(TITLES)) {
      expect(catalogue.getKindTitle(kind)).toBe(title);
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(catalogue.LIMITS.titleMax);
      const out = await createPatientNotification(base({ kind, eventRef: `t-${kind}`, ...(REFS[kind] || {}) }));
      expect(out.notification.title).toBe(title);
    }
    expect(catalogue.getKindTitle('made_up')).toBeNull();
  });

  test('a caller-supplied title cannot override it, whatever it is', async () => {
    const hostile = ['Patient John Smith has cancer', '', '   ', 'x'.repeat(5000), null, 42, { a: 1 }, ['x']];
    for (const [i, title] of hostile.entries()) {
      const { notification } = await createPatientNotification(base({ eventRef: `h${i}`, title }));
      expect(notification.title).toBe(SYSTEM_TITLE);
    }
    const stage = await createPatientNotification(base({ kind: 'stage_update', eventRef: 'h-stage', serviceRequestId: 10, title: 'CASE-1 is critical' }));
    expect(stage.notification.title).toBe('Your case has been updated');
    expect(JSON.stringify(mockDb.notification)).not.toMatch(/John Smith|cancer|critical/);
  });

  test('the stage_update body behavior is unchanged: fixed text', async () => {
    const { notification } = await createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 10, body: 'staff note' }));
    expect(notification.body).toBe('Your case status has been updated.');
  });
});

describe('classification comes only from the catalogue', () => {
  test('mandatory kinds are mandatory, others are not, whatever the caller says', async () => {
    const sec = await createPatientNotification(base({ kind: 'security_new_login', eventRef: 'l1', isMandatory: false }));
    expect(sec.notification.isMandatory).toBe(true);
    const pay = await createPatientNotification(base({ kind: 'payment_received', eventRef: 'p1', serviceRequestId: 10, quotationId: 500, isMandatory: false }));
    expect(pay.notification.isMandatory).toBe(true);
    const sys = await createPatientNotification(base({ eventRef: 's1', isMandatory: true }));
    expect(sys.notification.isMandatory).toBe(false);
  });

  test('recipientType, idempotencyKey, deletedAt, readAt, id and other internal fields from the caller are ignored', async () => {
    const forged = new Date('2020-01-01');
    const { notification } = await createPatientNotification(base({ recipientType: 'corporate_user', idempotencyKey: 'forged', deletedAt: forged, readAt: forged, id: 999, createdAt: forged }));
    expect(notification.recipientType).toBe('patient');
    expect(notification.idempotencyKey).toBe('system:patient:1:evt1');
    expect(notification.deletedAt).toBeNull();
    expect(notification.readAt).toBeNull();
    expect(notification.id).toBe(1);
    expect(notification.createdAt).not.toBe(forged);
  });
});

describe('recipient ownership and relationships', () => {
  test('a patient that does not exist is rejected', async () => {
    expect(await codeOf(createPatientNotification(base({ recipientId: 99 })))).toBe('recipient_not_found');
    expect(mockDb.notification).toHaveLength(0);
  });

  test('a service request owned by another patient, or an unknown one, gets the same safe error', async () => {
    const own = base({ kind: 'stage_update', data: { screen: 'request', entityType: 'service_request', entityId: 20 } });
    expect(await codeOf(createPatientNotification({ ...own, serviceRequestId: 20 }))).toBe('invalid_reference'); // patient 2's
    expect(await codeOf(createPatientNotification({ ...own, serviceRequestId: 99, data: { screen: 'request', entityType: 'service_request', entityId: 99 } }))).toBe('invalid_reference');
    try { await createPatientNotification({ ...own, serviceRequestId: 20 }); } catch (e) { expect(e.message).not.toMatch(/20|another|owner|belongs to patient/i); expect(e.statusCode).toBe(422); }
    expect(mockDb.notification).toHaveLength(0);
  });

  test('a case that does not belong to the service request is rejected', async () => {
    expect(await codeOf(createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 10, caseId: 200 })))).toBe('invalid_reference'); // another patient's case
    expect(await codeOf(createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 20, caseId: 100 })))).toBe('invalid_reference'); // SR is patient 2's
    expect(await codeOf(createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 10, caseId: 999 })))).toBe('invalid_reference');
  });

  test('a case with no service request (a corporate case) is refused', async () => {
    expect(await codeOf(createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 10, caseId: 300 })))).toBe('invalid_reference');
  });

  test('a quotation must exist, belong to the supplied case and to a case of the service request', async () => {
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', serviceRequestId: 10, quotationId: 999 })))).toBe('invalid_reference');
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', serviceRequestId: 10, caseId: 101, quotationId: 500 })))).toBe('invalid_reference'); // 500 is on case 100
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', serviceRequestId: 10, caseId: 100, quotationId: 600 })))).toBe('invalid_reference');
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', serviceRequestId: 10, quotationId: 600 })))).toBe('invalid_reference'); // 600 is on patient 2's case
    expect(await codeOf(createPatientNotification(base({ kind: 'quotation_ready', serviceRequestId: 20, quotationId: 600, recipientId: 1 })))).toBe('invalid_reference'); // SR 20 is patient 2's
    expect(mockDb.notification).toHaveLength(0);
  });

  test('a payment entity must exist and sit on the quotation\'s case', async () => {
    const pay = (entityId) => base({ kind: 'payment_received', serviceRequestId: 10, quotationId: 500, data: { screen: 'payment', entityType: 'payment', entityId } });
    expect(await codeOf(createPatientNotification(pay(901)))).toBe('invalid_reference'); // payment on case 101, quotation on 100
    expect(await codeOf(createPatientNotification(pay(999)))).toBe('invalid_reference');
    expect((await createPatientNotification(pay(900))).created).toBe(true);
  });
});

describe('idempotency', () => {
  test('a replay returns the stored row with created: false and writes nothing', async () => {
    const first = await createPatientNotification(base());
    const again = await createPatientNotification(base({ body: 'A different body' }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(first.notification.id);
    expect(again.notification.body).toBeNull(); // the stored row, unchanged
    expect(mockDb.notification).toHaveLength(1);
  });

  test('different patients, kinds or events never collide', async () => {
    const a = await createPatientNotification(base());
    const b = await createPatientNotification(base({ recipientId: 2 }));
    const c = await createPatientNotification(base({ kind: 'document' }));
    const d = await createPatientNotification(base({ eventRef: 'evt2' }));
    expect([a, b, c, d].every((r) => r.created)).toBe(true);
    expect(mockDb.notification.map((r) => r.idempotencyKey)).toEqual([
      'system:patient:1:evt1', 'system:patient:2:evt1', 'document:patient:1:evt1', 'system:patient:1:evt2',
    ]);
  });

  test('a soft-deleted notification still blocks re-creation and stays deleted', async () => {
    const { notification } = await createPatientNotification(base());
    const row = mockDb.notification.find((r) => r.id === notification.id);
    row.deletedAt = new Date('2026-06-01');
    const again = await createPatientNotification(base());
    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(notification.id);
    expect(mockDb.notification).toHaveLength(1);
    expect(row.deletedAt).toEqual(new Date('2026-06-01'));
  });

  test('a replay does not need the references to still verify', async () => {
    const input = base({ kind: 'stage_update', serviceRequestId: 10, caseId: 100 });
    await createPatientNotification(input);
    mockDb.case = []; // e.g. the case was removed since
    expect((await createPatientNotification(input)).created).toBe(false);
  });

  describe('replay mismatch protection', () => {
    const stage = (over = {}) => base({ kind: 'stage_update', eventRef: 'ev', serviceRequestId: 10, ...over });
    const mismatch = async (p) => { const e = await p.catch((x) => x); expect(e).toBeInstanceOf(NotificationCoreError); expect(e).toMatchObject({ code: 'idempotency_replay_mismatch', statusCode: 409 }); };

    test('the same references replay normally, with created: false', async () => {
      const first = await createPatientNotification(stage({ caseId: 100 }));
      const again = await createPatientNotification(stage({ caseId: 100 }));
      expect(again).toMatchObject({ created: false });
      expect(again.notification.id).toBe(first.notification.id);
    });

    test('an omitted optional reference matches a stored NULL, even when the stored row has no such field', async () => {
      await createPatientNotification(stage());
      expect((await createPatientNotification(stage())).created).toBe(false);
      expect((await createPatientNotification(stage({ caseId: undefined, quotationId: null }))).created).toBe(false);
    });

    test('a different caseId, serviceRequestId or quotationId is a 409 and nothing is returned or written', async () => {
      await createPatientNotification(stage({ caseId: 100 }));
      await mismatch(createPatientNotification(stage({ caseId: 101 }))); // different case
      await mismatch(createPatientNotification(stage())); // stored has a case, incoming omits it
      await createPatientNotification(stage({ eventRef: 'ev2' }));
      await mismatch(createPatientNotification(stage({ eventRef: 'ev2', caseId: 100 }))); // stored has none, incoming adds one
      await mismatch(createPatientNotification({ ...stage({ eventRef: 'ev2' }), serviceRequestId: 20, recipientId: 1 })); // different service request
      await createPatientNotification(base({ kind: 'quotation_ready', eventRef: 'qv', serviceRequestId: 10, quotationId: 500 }));
      await mismatch(createPatientNotification(base({ kind: 'quotation_ready', eventRef: 'qv', serviceRequestId: 10, quotationId: 600 })));
      expect(mockDb.notification).toHaveLength(3);
    });

    test('a mismatch is detected in memory: no reference lookup is run on a replay or a mismatch', async () => {
      await createPatientNotification(stage({ caseId: 100 }));
      mockDb.calls.length = 0;
      await createPatientNotification(stage({ caseId: 100 }));
      await mismatch(createPatientNotification(stage({ caseId: 101 })));
      expect(mockDb.calls).toEqual([['main', 'notification', 'findUnique'], ['main', 'notification', 'findUnique']]);
    });

    test('a soft-deleted notification still blocks, and a mismatch against it is still a 409', async () => {
      await createPatientNotification(stage({ caseId: 100 }));
      mockDb.notification[0].deletedAt = new Date();
      expect((await createPatientNotification(stage({ caseId: 100 }))).created).toBe(false);
      await mismatch(createPatientNotification(stage({ caseId: 101 })));
      expect(mockDb.notification).toHaveLength(1);
    });

    test('a concurrent loser with different references gets the 409 too', async () => {
      const results = await Promise.allSettled([createPatientNotification(stage({ caseId: 100, eventRef: 'cr' })), createPatientNotification(stage({ caseId: 101, eventRef: 'cr' }))]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'idempotency_replay_mismatch', statusCode: 409 });
      expect(mockDb.notification).toHaveLength(1);
    });
  });

  test('concurrent duplicate attempts create exactly one row', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => createPatientNotification(base({ eventRef: 'race' }))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(5);
    expect(new Set(results.map((r) => r.notification.id)).size).toBe(1);
    expect(mockDb.notification).toHaveLength(1);
    expect(prisma.notification.create.mock.calls.length).toBeGreaterThan(1); // the database constraint, not the pre-read, settled it
  });

  test('concurrent attempts for different patients both succeed', async () => {
    const [a, b] = await Promise.all([createPatientNotification(base({ eventRef: 'race' })), createPatientNotification(base({ eventRef: 'race', recipientId: 2 }))]);
    expect([a.created, b.created]).toEqual([true, true]);
    expect(mockDb.notification).toHaveLength(2);
  });

  test('a unique conflict that cannot be confirmed by a re-read is a 409, not a guess', async () => {
    // A transaction whose snapshot cannot see the row the other transaction just committed.
    const tx = mockMakeClient('tx');
    tx.notification.findUnique = jest.fn(async () => null);
    tx.notification.create = jest.fn(async () => { throw mockUniqueError(['idempotency_key']); });
    const err = await createPatientNotification(base(), { tx }).catch((e) => e);
    expect(err).toBeInstanceOf(NotificationCoreError);
    expect(err).toMatchObject({ code: 'idempotency_conflict_unresolved', statusCode: 409 });
  });

  test('unrelated Prisma errors are rethrown unchanged, including a unique conflict on another constraint', async () => {
    const fk = Object.assign(new Error('FK failed'), { code: 'P2003' });
    mockDb.createError = fk;
    await expect(createPatientNotification(base())).rejects.toBe(fk);
    const other = mockUniqueError('some_other_key');
    mockDb.createError = other;
    await expect(createPatientNotification(base())).rejects.toBe(other);
    mockDb.createError = new Error('connection lost');
    await expect(createPatientNotification(base())).rejects.toThrow('connection lost');
    expect(core.isIdempotencyConflict(mockUniqueError('notifications_idempotency_key_key'))).toBe(true);
    expect(core.isIdempotencyConflict(mockUniqueError(['idempotency_key']))).toBe(true);
    expect(core.isIdempotencyConflict(mockUniqueError('other'))).toBe(false);
    expect(core.isIdempotencyConflict(new Error('x'))).toBe(false);
  });

  test('a stored row under the key for a different recipient is refused, never returned', async () => {
    mockDb.notification.push({ id: 1, recipientType: 'patient', recipientId: 2, idempotencyKey: 'system:patient:1:evt1' });
    expect(await codeOf(createPatientNotification(base()))).toBe('idempotency_key_mismatch');
  });
});

describe('transactions', () => {
  test('options.tx is used for every database call and the shared client is not touched', async () => {
    await prisma.$transaction(async (tx) => {
      const spy = jest.spyOn(tx.notification, 'create');
      const out = await createPatientNotification(base({ kind: 'stage_update', serviceRequestId: 10, caseId: 100 }), { tx });
      expect(out.created).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const labels = new Set(mockDb.calls.map((c) => c[0]));
    expect(labels).toEqual(new Set(['tx']));
  });

  test('without options.tx the shared client is used and no transaction is opened', async () => {
    const spy = jest.spyOn(prisma, '$transaction');
    await createPatientNotification(base());
    expect(new Set(mockDb.calls.map((c) => c[0]))).toEqual(new Set(['main']));
    expect(spy).not.toHaveBeenCalled();
  });

  test('the notification commits with the caller\'s transaction', async () => {
    await prisma.$transaction(async (tx) => { await createPatientNotification(base(), { tx }); });
    expect(mockDb.notification).toHaveLength(1);
  });

  test('the notification rolls back with the caller\'s transaction', async () => {
    await expect(prisma.$transaction(async (tx) => {
      await createPatientNotification(base(), { tx });
      expect(mockDb.notification).toHaveLength(1);
      throw new Error('business step failed');
    })).rejects.toThrow('business step failed');
    expect(mockDb.notification).toHaveLength(0);
    // and the same event can be created again afterwards
    expect((await createPatientNotification(base())).created).toBe(true);
  });

  test('a malformed options.tx is rejected before anything runs', async () => {
    expect(await codeOf(createPatientNotification(base(), { tx: {} }))).toBe('tx_invalid');
    expect(await codeOf(createPatientNotification(base(), { tx: 'tx' }))).toBe('tx_invalid');
    expect(mockDb.calls).toHaveLength(0);
  });
});

describe('no delivery and no push', () => {
  test('creating notifications writes no delivery or attempt rows and makes no network call', async () => {
    const savedFetch = global.fetch;
    global.fetch = jest.fn();
    try {
      await createPatientNotification(base({ kind: 'payment_received', eventRef: 'p1', serviceRequestId: 10, quotationId: 500 }));
      await createPatientNotification(base({ kind: 'security_new_login', eventRef: 'l1' }));
    } finally {
      const calls = global.fetch.mock.calls.length;
      global.fetch = savedFetch;
      expect(calls).toBe(0);
    }
    expect(mockDelivery.create).not.toHaveBeenCalled();
    expect(mockDelivery.createMany).not.toHaveBeenCalled();
    expect(mockAttempt.create).not.toHaveBeenCalled();
    expect(mockAttempt.createMany).not.toHaveBeenCalled();
  });

  test('the module requires only the Prisma client and the catalogue (no push service)', () => {
    const src = require('fs').readFileSync(require.resolve('../../src/modules/notifications/notification-core.js'), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    expect([...src.matchAll(/require\(([^)]+)\)/g)].map((m) => m[1]).sort()).toEqual(["'../../db/prisma'", "'./notification-catalogue'"]);
    expect(src).not.toMatch(/sendExpoPush|expo-push|fetch\(|notificationDelivery|notificationDeviceDelivery/i);
  });
});
