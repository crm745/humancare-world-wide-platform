/* global describe, test, expect, jest, beforeEach, afterEach */
// How a Private Charter request is tracked on the phone: the neutral `trackingFlow` ("five_stage" | null | absent) and `trackingStage` of the patient
// response, for a single request, a request list row and a just-created request. The flow is DISPLAY configuration (PRIVATE_CHARTER_TRACKING_FLOW),
// separate from the Bitrix worker: it needs no switch, no BITRIX_DEAL_PROFILE, no worker and creates nothing. No database, no network.
const {
  toPatientRequest, toPatientRequests, TRACKING_FLOW_FIVE_STAGE, TRACKING_FLOW_ENV, FIVE_STAGE_KEYS,
} = require('../../src/modules/requests/request-response');

const caseOf = (over = {}) => ({ id: 9, referenceNumber: 'HC-PC-000123', status: 'submitted', bitrixDealLink: null, stageEvents: [], ...over });
const request = (over = {}, caseOver) => ({
  id: 5, serviceKey: 'privatecharter', referenceNumber: 'HC-PC-000123', status: 'submitted', reviewStatus: 'approved',
  case: caseOver === undefined ? caseOf() : caseOver, ...over,
});
const withLink = (profile, extra = {}, over = {}) => request(over, caseOf({ bitrixDealLink: { profile }, ...extra }));
const ev = (stage) => ({ id: 1, stage, note: null, occurredAt: '2030-01-01T00:00:00Z' });

const KEYS = ['BITRIX_DEAL_PROFILE', TRACKING_FLOW_ENV, 'BITRIX_SYNC_ENABLED', 'BITRIX_PRIVATE_CHARTER_DEAL_ENABLED'];
let saved;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

describe('decoupled from the Bitrix worker: new requests are five_stage from the beginning', () => {
  test('with nothing configured at all (no Bitrix switch, no BITRIX_DEAL_PROFILE) a new Private Charter request is five_stage at Request Received', () => {
    expect(process.env.BITRIX_DEAL_PROFILE).toBeUndefined();
    const out = toPatientRequest(request({ reviewStatus: 'awaiting_documents' }, caseOf()));
    expect(out).toMatchObject({ trackingFlow: 'five_stage', trackingStage: 'request_received' });
  });
  test('the response to creating a request carries it too (it has no Case yet)', () => {
    const created = { id: 5, serviceKey: 'privatecharter', reviewStatus: 'awaiting_documents', status: 'submitted' };
    expect(toPatientRequest(created, { newRequest: true })).toMatchObject({ trackingFlow: 'five_stage', trackingStage: 'request_received' });
  });
  test('BITRIX_DEAL_PROFILE does not influence it in any direction', () => {
    for (const profile of [undefined, 'test', 'actual', 'nonsense']) {
      if (profile) process.env.BITRIX_DEAL_PROFILE = profile; else delete process.env.BITRIX_DEAL_PROFILE;
      expect(toPatientRequest(request()).trackingFlow).toBe('five_stage');
    }
  });
  test('the Bitrix switches do not influence it either', () => {
    process.env.BITRIX_SYNC_ENABLED = 'false';
    process.env.BITRIX_PRIVATE_CHARTER_DEAL_ENABLED = 'false';
    expect(toPatientRequest(request()).trackingFlow).toBe('five_stage');
    process.env.BITRIX_SYNC_ENABLED = 'true';
    expect(toPatientRequest(request()).trackingFlow).toBe('five_stage');
  });
  test('the intended flow is configurable: "standard" (or anything but five_stage) keeps the existing tracking', () => {
    for (const value of ['standard', 'five-stage', 'FIVE_STAGE', 'off', ' ']) {
      process.env[TRACKING_FLOW_ENV] = value;
      expect(toPatientRequest(request()).trackingFlow).toBeNull();
    }
    for (const value of ['five_stage', '']) {
      process.env[TRACKING_FLOW_ENV] = value;
      expect(toPatientRequest(request()).trackingFlow).toBe('five_stage');
    }
  });
  test('deciding it reads configuration only: nothing is queued, created or sent (the module has no database or Bitrix dependency)', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('../../src/modules/requests/request-response.js'), 'utf8');
    expect(source).not.toMatch(/require\([^)]*(db\/prisma|bitrix\.service|deal-outbox|bitrix-deal\.api)/);
    expect(source).not.toMatch(/env.BITRIX|activeProfileName|resolveProfile/); // prose may mention the variable; the code never reads it
  });
});

describe('an existing Deal link takes precedence', () => {
  test('an actual link is five_stage whatever the display configuration says', () => {
    for (const value of [undefined, 'standard', 'five_stage']) {
      if (value) process.env[TRACKING_FLOW_ENV] = value; else delete process.env[TRACKING_FLOW_ENV];
      expect(toPatientRequest(withLink('actual')).trackingFlow).toBe('five_stage');
    }
  });
  test('a test link (and any other stamp) keeps the existing tracking, even with five_stage configured', () => {
    for (const profile of ['test', 'production', '']) expect(toPatientRequest(withLink(profile)).trackingFlow).toBeNull();
    expect(toPatientRequest(withLink('test', { stageEvents: [ev('quotation_ready'), ev('payment_confirmed')] })).trackingFlow).toBeNull();
  });
  test('a link with no profile (made while none was configured) follows the intended flow, so a request does not change flow when it is approved', () => {
    expect(toPatientRequest(withLink(null)).trackingFlow).toBe('five_stage');
    process.env[TRACKING_FLOW_ENV] = 'standard';
    expect(toPatientRequest(withLink(null)).trackingFlow).toBeNull();
  });
});

describe('historical and other requests', () => {
  test('a request from before the review workflow (no reviewStatus) keeps the existing tracking', () => {
    expect(toPatientRequest(request({ reviewStatus: null })).trackingFlow).toBeNull();
    expect(toPatientRequest(request({ reviewStatus: undefined })).trackingFlow).toBeNull();
    expect(toPatientRequest({ id: 5, serviceKey: 'privatecharter' }, { newRequest: true }).trackingFlow).toBeNull();
  });
  test('a request of another service never carries either field', () => {
    for (const serviceKey of ['ground', 'commercialair_stretcher', undefined]) {
      const out = toPatientRequest({ ...withLink('actual'), serviceKey });
      expect(out).not.toHaveProperty('trackingFlow');
      expect(out).not.toHaveProperty('trackingStage');
    }
  });
  test('without Case information (not loaded) nothing is claimed', () => {
    expect(toPatientRequest({ id: 5, serviceKey: 'privatecharter', reviewStatus: 'approved' })).not.toHaveProperty('trackingFlow');
    expect(toPatientRequest(request({}, { id: 9, status: 'submitted' }))).not.toHaveProperty('trackingFlow'); // a Case whose link was not loaded
  });
  test('a request with no Case at all is five_stage at Request Received', () => {
    expect(toPatientRequest(request({}, null))).toMatchObject({ trackingFlow: 'five_stage', trackingStage: 'request_received' });
  });
});

describe('the current stage (trackingStage)', () => {
  const stageOf = (status, events, over = {}) => toPatientRequest(request(over, caseOf({ status, stageEvents: events }))).trackingStage;
  test('the five keys, in order', () => {
    expect(FIVE_STAGE_KEYS).toEqual(['request_received', 'quotation_ready', 'payment_confirmed', 'service_in_progress', 'completed']);
  });
  test('each stage', () => {
    expect(stageOf('submitted', [])).toBe('request_received');
    expect(stageOf('submitted', [ev('patient_details')])).toBe('request_received');
    expect(stageOf('submitted', [ev('quotation_ready')])).toBe('quotation_ready');
    expect(stageOf('submitted', [ev('quotation_ready'), ev('payment_confirmed')])).toBe('payment_confirmed');
    expect(stageOf('in_progress', [ev('quotation_ready'), ev('payment_confirmed'), ev('in_progress')])).toBe('service_in_progress');
    expect(stageOf('completed', [ev('quotation_ready'), ev('payment_confirmed'), ev('in_progress'), ev('completed')])).toBe('completed');
  });
  test('skipped stages: Enquiry straight to Activate, and straight to completion', () => {
    expect(stageOf('in_progress', [ev('in_progress')])).toBe('service_in_progress');
    expect(stageOf('completed', [ev('completed')])).toBe('completed');
  });
  test('the Case status alone reaches Service In Progress and Completed; events in any order give the furthest', () => {
    expect(stageOf('in_progress', [])).toBe('service_in_progress');
    expect(stageOf('completed', [])).toBe('completed');
    expect(stageOf('in_progress', [ev('in_progress'), ev('quotation_ready'), ev('payment_confirmed')])).toBe('service_in_progress');
  });
  test('before approval the Case does not advance the stage', () => {
    expect(stageOf('submitted', [ev('quotation_ready')], { reviewStatus: 'in_review' })).toBe('request_received');
    expect(stageOf('in_progress', [ev('in_progress')], { reviewStatus: 'awaiting_documents' })).toBe('request_received');
  });
  test('an unknown stage name or a hostile one is ignored', () => {
    expect(stageOf('submitted', [ev('constructor'), ev('__proto__'), ev('toString')])).toBe('request_received');
  });
  test('a standard (non five_stage) request has no stage', () => {
    expect(toPatientRequest(withLink('test'))).not.toHaveProperty('trackingStage');
  });
});

describe('the table shared with the mobile app (the list card and the details must agree with the server)', () => {
  const SHARED = require('../../../apps/mobile/src/lib/__tests__/fixtures/fiveStageCases.json').cases;
  test.each(SHARED.map((c) => [c.name, c]))('%s', (_name, c) => {
    const built = {
      id: 5, serviceKey: 'privatecharter', status: c.status, reviewStatus: c.reviewStatus,
      case: c.noCase ? null : caseOf({ status: c.caseStatus, stageEvents: c.events.map((stage) => ({ id: 1, stage, note: null, occurredAt: '2030-01-01T00:00:00Z' })) }),
    };
    expect(toPatientRequest(built)).toMatchObject({ trackingFlow: 'five_stage', trackingStage: c.expected });
    expect(toPatientRequests([built])[0]).toMatchObject({ trackingFlow: 'five_stage', trackingStage: c.expected }); // the list row says the same
  });
});

describe('request list rows', () => {
  const row = (over = {}, caseOver) => ({ id: 5, serviceKey: 'privatecharter', referenceNumber: 'HC-PC-000123', status: 'submitted', reviewStatus: 'approved', createdAt: '2030-01-01', case: caseOver, ...over });
  test('a Private Charter row carries trackingFlow and trackingStage, and its Case is not sent', () => {
    const [out] = toPatientRequests([row({}, caseOf({ status: 'in_progress', stageEvents: [{ stage: 'in_progress' }], bitrixDealLink: { profile: 'actual' } }))]);
    expect(out).toMatchObject({ trackingFlow: 'five_stage', trackingStage: 'service_in_progress', referenceNumber: 'HC-PC-000123' });
    expect(out).not.toHaveProperty('case');
    expect(JSON.stringify(out)).not.toMatch(/bitrix|profile|actual"/i);
  });
  test('a row for a test link or a historical request is the existing row (flow null, no stage)', () => {
    const [test] = toPatientRequests([row({}, caseOf({ bitrixDealLink: { profile: 'test' } }))]);
    expect(test.trackingFlow).toBeNull();
    expect(test).not.toHaveProperty('trackingStage');
    const [old] = toPatientRequests([row({ reviewStatus: null }, caseOf())]);
    expect(old.trackingFlow).toBeNull();
  });
  test('a row of another service, or a row with no Case information, is exactly what it was', () => {
    const [ground] = toPatientRequests([row({ serviceKey: 'ground' }, caseOf())]);
    expect(ground).not.toHaveProperty('trackingFlow');
    const bare = { id: 5, serviceKey: 'privatecharter', status: 'submitted', referenceNumber: 'X' };
    expect(toPatientRequests([bare])[0]).toEqual({ id: 5, serviceKey: 'privatecharter', status: 'submitted', referenceNumber: 'X' });
  });
  test('the list query loads only what the decision needs, and nothing of the Deal link but its profile', async () => {
    jest.resetModules();
    const findMany = jest.fn(async () => []);
    jest.doMock('../../src/db/prisma', () => ({ prisma: { serviceRequest: { findMany } } }));
    const { listRequestsForUser } = require('../../src/modules/requests/requests.service');
    await listRequestsForUser(1, {});
    expect(findMany.mock.calls[0][0].include).toEqual({ case: { select: { status: true, bitrixDealLink: { select: { profile: true } }, stageEvents: { select: { stage: true } } } } });
    jest.dontMock('../../src/db/prisma');
  });
});

describe('the single-request query', () => {
  test('getRequestForUser asks for case.bitrixDealLink.profile and nothing more of the link', async () => {
    jest.resetModules();
    const findFirst = jest.fn(async () => null);
    jest.doMock('../../src/db/prisma', () => ({ prisma: { serviceRequest: { findFirst } } }));
    const { getRequestForUser } = require('../../src/modules/requests/requests.service');
    await getRequestForUser(1, 5).catch(() => undefined);
    expect(findFirst.mock.calls[0][0].include.case.include.bitrixDealLink).toEqual({ select: { profile: true } });
    jest.dontMock('../../src/db/prisma');
  });
  test('nothing about the Deal link or Bitrix reaches the patient', () => {
    const out = toPatientRequest(withLink('actual'));
    expect(out.case).not.toHaveProperty('bitrixDealLink');
    expect(Object.keys(out).filter((k) => /profile|bitrix/i.test(k))).toEqual([]);
  });
});
