/* global describe, test, expect, beforeEach, jest */
// The submission transaction of a Private Charter request: ServiceRequest, Case, stage event, AuditLog, Deal link and
// Deal-creation event are written together, in this order, or not at all. No database: Prisma is mocked, and its
// $transaction is replaced by a recorder that reports whether the callback "committed" or "rolled back".
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const { prisma } = require('../../src/db/prisma');
const review = require('../../src/modules/request-review/request-review.service');
const { appendAuditLog, ALLOWED_DATA_KEYS } = require('../../src/common/audit/business-audit');
const businessAudit = require('../../src/common/audit/business-audit');

const DATA = {
  serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61,
  patientGender: 'female', patientContact: '+971501234567', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
  country: 'AE', careLevel: 'care_icu', description: 'Needs ICU transfer with a ventilator', mobility: 'bedridden', urgency: 'urgent_24h',
};

let log;
let outcome;

// A fake transaction. Every call is recorded in `log` ("table.method" plus the event action when there is one).
function fakeTx({ failOn } = {}) {
  const record = (name, build) => jest.fn(async (arg) => {
    log.push(arg && arg.data && arg.data.action && name.startsWith('requestEvent') ? `${name}:${arg.data.action}` : name);
    if (failOn === name) throw new Error('simulated write failure');
    return build(arg);
  });
  return {
    serviceRequest: {
      create: record('serviceRequest.create', ({ data }) => ({ id: 41, ...data })),
      update: record('serviceRequest.update', ({ data }) => ({ id: 41, userId: 7, serviceKey: 'privatecharter', reviewStatus: 'awaiting_documents', ...DATA, bitrixLeadId: null, ...data })),
    },
    requestEvent: { create: record('requestEvent.create', () => ({})) },
    case: {
      create: record('case.create', () => ({ id: 51 })),
      update: record('case.update', ({ data }) => ({ id: 51, serviceRequestId: 41, referenceNumber: data.referenceNumber })),
    },
    caseStageEvent: { create: record('caseStageEvent.create', () => ({})) },
    auditLog: { create: record('auditLog.create', () => ({})) },
    bitrixDealLink: { create: record('bitrixDealLink.create', () => ({})) },
    integrationOutbox: { create: record('integrationOutbox.create', () => ({})) },
  };
}

function useTransaction(options) {
  const tx = fakeTx(options);
  prisma.$transaction.mockImplementation(async (callback) => {
    try {
      const result = await callback(tx);
      outcome = 'committed';
      return result;
    } catch (err) {
      outcome = 'rolled back';
      throw err;
    }
  });
  return tx;
}

beforeEach(() => {
  jest.clearAllMocks();
  log = [];
  outcome = null;
});

describe('createReviewRequest', () => {
  test('writes the request, the Case, its stage event, its AuditLog entry, the Deal link and the Deal event in one transaction, in order', async () => {
    useTransaction();
    const request = await review.createReviewRequest(7, DATA);
    expect(request.id).toBe(41);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('committed');
    expect(log).toEqual([
      'serviceRequest.create', 'serviceRequest.update', 'requestEvent.create:request_created',
      'case.create', 'case.update', 'caseStageEvent.create', 'auditLog.create',
      'requestEvent.create:case_created', 'bitrixDealLink.create', 'integrationOutbox.create',
    ]);
  });

  test('the AuditLog entry names the Case, the action, the actor, the source and the correlation, with identifiers only', async () => {
    const tx = useTransaction();
    await review.createReviewRequest(7, DATA);
    const entry = tx.auditLog.create.mock.calls[0][0].data;
    expect(entry).toMatchObject({
      caseId: 51, entityType: 'case', entityId: '51', action: 'case.created', actorType: 'patient', actorId: '7', actorRole: null,
      source: 'mobile_app', isOverride: false, reasonCode: 'automatic_case_creation', beforeData: undefined,
      correlationId: 'request:41', idempotencyKey: 'case.created:request:41',
    });
    expect(entry.afterData).toEqual({
      caseId: 51, caseReference: 'CASE-1051', serviceRequestId: 41, requestReference: 'REQ-1041', charterStage: 'patient_details', status: 'submitted', stageVersion: 0,
    });
    for (const key of Object.keys(entry.afterData)) expect(ALLOWED_DATA_KEYS.has(key)).toBe(true);
  });

  test('the AuditLog entry holds no patient detail: no name, phone, email, medical text, document, token or URL', async () => {
    const tx = useTransaction();
    await review.createReviewRequest(7, DATA);
    const text = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
    for (const secret of ['Maria', 'Fernandez', '971501234567', 'ICU', 'ventilator', 'Mumbai', 'Dubai', 'bedridden', '@', 'http', 'token', 'password']) {
      expect(text).not.toContain(secret);
    }
  });

  test('the Deal records are tied to the Case and to nothing else; the Deal event is recorded without any switch', async () => {
    const tx = useTransaction();
    await review.createReviewRequest(7, DATA);
    expect(tx.bitrixDealLink.create).toHaveBeenCalledWith({ data: { caseId: 51, syncStatus: 'pending' } });
    expect(tx.integrationOutbox.create.mock.calls[0][0].data).toMatchObject({
      eventType: 'bitrix.deal.create', entityType: 'case', entityId: '51', caseId: 51, idempotencyKey: 'bitrix.deal.create:case:51', status: 'pending',
      payload: { caseId: 51, serviceRequestId: 41 },
    });
  });

  test('if the AuditLog entry cannot be written, the whole transaction fails: no later write is attempted and it rolls back', async () => {
    useTransaction({ failOn: 'auditLog.create' });
    await expect(review.createReviewRequest(7, DATA)).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
    expect(log).toEqual([
      'serviceRequest.create', 'serviceRequest.update', 'requestEvent.create:request_created', 'case.create', 'case.update', 'caseStageEvent.create', 'auditLog.create',
    ]);
  });

  test.each(['case.create', 'caseStageEvent.create', 'bitrixDealLink.create', 'integrationOutbox.create'])('a failure of %s rolls everything back', async (name) => {
    useTransaction({ failOn: name });
    await expect(review.createReviewRequest(7, DATA)).rejects.toThrow('simulated write failure');
    expect(outcome).toBe('rolled back');
  });
});

describe('the audit writer', () => {
  const db = () => ({ auditLog: { create: jest.fn(async () => ({})) } });
  const entry = (over = {}) => ({ entityType: 'case', entityId: 5, action: 'case.created', actorType: 'patient', actorId: 7, source: 'mobile_app', ...over });

  test('it only inserts: the module offers no update or delete', () => {
    expect(Object.keys(businessAudit).sort()).toEqual(['ALLOWED_DATA_KEYS', 'appendAuditLog']);
  });

  test('accepts allowlisted identifiers and state names', async () => {
    const target = db();
    await appendAuditLog(target, entry({ afterData: { caseId: 5, charterStage: 'patient_details', stageVersion: 0, status: 'submitted', bitrixDealId: '1234' } }));
    expect(target.auditLog.create).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a name', { patientName: 'Maria' }], ['a phone number', { patientContact: '+971501234567' }], ['an email', { email: 'a@b.c' }],
    ['medical text', { description: 'ICU' }], ['a token', { token: 'abc' }], ['a URL', { webhookUrl: 'https://x' }],
  ])('refuses %s as audit data', async (_label, data) => {
    const target = db();
    expect(() => appendAuditLog(target, entry({ afterData: data }))).toThrow(/may not contain/);
    expect(target.auditLog.create).not.toHaveBeenCalled();
  });

  test('refuses a nested value, a long text, and a whitespace-padded identifier', () => {
    const target = db();
    expect(() => appendAuditLog(target, entry({ afterData: { caseId: { id: 5 } } }))).toThrow(/short text/);
    expect(() => appendAuditLog(target, entry({ afterData: { caseReference: 'x'.repeat(201) } }))).toThrow(/short text/);
    expect(() => appendAuditLog(target, entry({ entityId: ' 5' }))).toThrow(/whitespace/);
    expect(() => appendAuditLog(target, entry({ idempotencyKey: 'key ' }))).toThrow(/whitespace/);
    expect(() => appendAuditLog(target, entry({ reasonCode: 'Free text with spaces' }))).toThrow(/reasonCode/);
    expect(() => appendAuditLog(target, entry({ source: undefined }))).toThrow(/required/);
    expect(target.auditLog.create).not.toHaveBeenCalled();
  });
});
