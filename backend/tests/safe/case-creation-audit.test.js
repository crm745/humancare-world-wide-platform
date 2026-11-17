/* global describe, test, expect, beforeEach, jest */
// The submission transaction of a Private Charter request: it creates the ServiceRequest and its first event, and NOTHING
// else. The Case, its stage event, its AuditLog entry, the Deal link and the Deal-creation event are created later, by the
// Admin approval (see approve-request.test.js). No database: Prisma is mocked, and its $transaction is replaced by a
// recorder that reports whether the callback "committed" or "rolled back".
jest.mock('../../src/db/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../../src/middleware/upload.middleware', () => ({ UPLOAD_DIR: require('os').tmpdir() }));
jest.mock('../../src/integrations/clamav/clamav', () => ({}));

const { prisma } = require('../../src/db/prisma');
const review = require('../../src/modules/request-review/request-review.service');
const { appendAuditLog } = require('../../src/common/audit/business-audit');
const businessAudit = require('../../src/common/audit/business-audit');

const DATA = {
  serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61,
  patientGender: 'female', patientContact: '+971501234567', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
  country: 'AE', careLevel: 'care_icu', description: 'Needs ICU transfer with a ventilator', mobility: 'bedridden', urgency: 'urgent_24h',
};

let log;
let outcome;

// A fake transaction. Every call is recorded in `log` ("table.method" plus the event action when there is one). The tables a
// submission must never touch are present too, so a stray write is caught by the log instead of by a missing-method error.
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
    case: { create: record('case.create', () => ({ id: 51 })), update: record('case.update', () => ({ id: 51 })) },
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

describe('createReviewRequest (a submission)', () => {
  test('writes the request and its first event in one transaction, and nothing else', async () => {
    useTransaction();
    const request = await review.createReviewRequest(7, DATA);
    expect(request.id).toBe(41);
    expect(request.referenceNumber).toBe('REQ-1041');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('committed');
    expect(log).toEqual(['serviceRequest.create', 'serviceRequest.update', 'requestEvent.create:request_created']);
  });

  test('creates no Case, no stage event, no AuditLog entry, no Deal link and no Deal event', async () => {
    const tx = useTransaction();
    await review.createReviewRequest(7, DATA);
    for (const table of ['case', 'caseStageEvent', 'auditLog', 'bitrixDealLink', 'integrationOutbox']) {
      for (const fn of Object.values(tx[table])) expect(fn).not.toHaveBeenCalled();
    }
    expect(log.some((line) => /case_created/.test(line))).toBe(false);
  });

  test('the request starts as a draft waiting for documents, with no Lead', async () => {
    const tx = useTransaction();
    await review.createReviewRequest(7, DATA);
    expect(tx.serviceRequest.create.mock.calls[0][0].data).toMatchObject({ status: 'submitted', reviewStatus: 'awaiting_documents', userId: 7 });
  });

  test.each(['serviceRequest.create', 'serviceRequest.update', 'requestEvent.create'])('a failure of %s rolls everything back', async (name) => {
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
