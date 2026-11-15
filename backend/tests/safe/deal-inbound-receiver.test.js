/* global describe, test, expect, jest, beforeEach */
// The inbound Bitrix24 receiver (authentication, validation, storage, deduplication, privacy) and the approved
// Category 38 stage table. No database, no network: the Prisma client is a fake and requests are plain objects.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const { makeHandler, tokenMatches, eventIdentity, bitrixInboundRouter } = require('../../src/modules/bitrix/bitrix-inbound.controller');
const { STAGES, lookupStage, LOST_REASON_FIELD } = require('../../src/modules/bitrix/bitrix-deal-stages');

const TOKEN = 'fake-inbound-token-0123456789';
const ENV = { BITRIX_INBOUND_APPLICATION_TOKEN: TOKEN };

const call = async (handler, body) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await handler({ body }, res);
  return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
};
const goodBody = (over = {}) => ({ event: 'ONCRMDEALUPDATE', ts: '1893456000', data: { FIELDS: { ID: '4711' } }, auth: { application_token: TOKEN, domain: 'x.invalid' }, ...over });

let db; let log;
beforeEach(() => {
  db = { integrationInbox: { create: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) } };
  log = { error: jest.fn(), warn: jest.fn() };
});

describe('authentication', () => {
  test.each([
    ['no token configured', {}, TOKEN],
    ['an empty configured token', { BITRIX_INBOUND_APPLICATION_TOKEN: '' }, ''],
    ['a configured token that is too short', { BITRIX_INBOUND_APPLICATION_TOKEN: 'short' }, 'short'],
    ['a wrong token', ENV, 'fake-inbound-token-0123456780'],
    ['a token of another length', ENV, `${TOKEN}x`],
    ['a missing token', ENV, undefined],
    ['a non-string token', ENV, { $ne: 1 }],
    ['an array token', ENV, [TOKEN]],
  ])('%s -> 401, nothing stored, same answer', async (_name, env, provided) => {
    const result = await call(makeHandler({ db, env, log }), goodBody({ auth: { application_token: provided } }));
    expect(result).toEqual({ status: 401, body: { ok: false } });
    expect(db.integrationInbox.create).not.toHaveBeenCalled();
  });
  test('a body with no auth block, or no body at all, is refused', async () => {
    expect((await call(makeHandler({ db, env: ENV, log }), { event: 'ONCRMDEALUPDATE' })).status).toBe(401);
    expect((await call(makeHandler({ db, env: ENV, log }), undefined)).status).toBe(401);
  });
  test('tokenMatches: only the exact configured value, never the outbound webhook setting', () => {
    expect(tokenMatches(TOKEN, ENV)).toBe(true);
    expect(tokenMatches('https://x.invalid/rest/1/abc/', { BITRIX24_WEBHOOK_URL: 'https://x.invalid/rest/1/abc/' })).toBe(false);
    expect(tokenMatches(TOKEN, { BITRIX24_WEBHOOK_URL: TOKEN })).toBe(false);
  });
});

describe('validation', () => {
  test.each([
    ['no event', { event: undefined }], ['a non-string event', { event: 5 }],
    ['no Deal', { data: {} }], ['no FIELDS', { data: { FIELDS: 'x' } }],
    ['a non-numeric Deal ID', { data: { FIELDS: { ID: '12abc' } } }], ['a zero Deal ID', { data: { FIELDS: { ID: '0' } } }],
    ['a padded Deal ID', { data: { FIELDS: { ID: '007' } } }], ['an object Deal ID', { data: { FIELDS: { ID: { a: 1 } } } }],
    ['an overlong Deal ID', { data: { FIELDS: { ID: '1'.repeat(40) } } }],
  ])('%s -> 400 and nothing stored', async (_name, over) => {
    expect(await call(makeHandler({ db, env: ENV, log }), goodBody(over))).toEqual({ status: 400, body: { ok: false } });
    expect(db.integrationInbox.create).not.toHaveBeenCalled();
  });
  test('an unsupported event is quarantined (ignored), never queued for processing', async () => {
    expect((await call(makeHandler({ db, env: ENV, log }), goodBody({ event: 'ONCRMDEALDELETE' }))).status).toBe(200);
    expect(db.integrationInbox.create.mock.calls[0][0].data).toMatchObject({ status: 'ignored', lastError: 'quarantined:unsupported_event' });
  });
});

describe('storing an event', () => {
  test('stores only the event, the Deal ID and the timestamp, due at once, as "received"', async () => {
    expect(await call(makeHandler({ db, env: ENV, log }), goodBody())).toEqual({ status: 200, body: { ok: true } });
    const data = db.integrationInbox.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ source: 'bitrix24', eventType: 'ONCRMDEALUPDATE', entityType: 'deal', entityId: '4711', status: 'received', nextAttemptAt: new Date(0) });
    expect(data.payload).toEqual({ event: 'ONCRMDEALUPDATE', dealId: '4711', ts: new Date(1893456000 * 1000).toISOString() });
    expect(data.externalEventId).toBe(eventIdentity('ONCRMDEALUPDATE', '4711', '1893456000'));
  });
  test('the token and the rest of the payload are never stored', async () => {
    await call(makeHandler({ db, env: ENV, log }), goodBody({ data: { FIELDS: { ID: '4711', TITLE: 'Asha Rao' } }, extra: 'secret-note' }));
    const stored = JSON.stringify(db.integrationInbox.create.mock.calls[0][0]);
    expect(stored).not.toMatch(new RegExp(`${TOKEN}|Asha|secret-note|x\\.invalid`));
  });
  test('a repeated delivery while the first copy is still waiting is recorded once and answered ok', async () => {
    db.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    db.integrationInbox.findUnique.mockResolvedValue({ status: 'received' });
    expect(await call(makeHandler({ db, env: ENV, log }), goodBody())).toEqual({ status: 200, body: { ok: true } });
    expect(db.integrationInbox.create).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });
  test.each(['processing', 'processed', 'ignored', 'failed'])('a repeat of an event already %s stores a follow-up row, so a change in that second is never dropped', async (status) => {
    db.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    db.integrationInbox.findUnique.mockResolvedValue({ status });
    expect(await call(makeHandler({ db, env: ENV, log }), goodBody())).toEqual({ status: 200, body: { ok: true } });
    expect(db.integrationInbox.create).toHaveBeenCalledTimes(2);
    const [first, second] = db.integrationInbox.create.mock.calls.map((c) => c[0].data);
    expect(second.externalEventId).not.toBe(first.externalEventId);
    expect(second).toMatchObject({ entityId: '4711', status: 'received' });
  });
  test('a follow-up that collides again is still acknowledged', async () => {
    db.integrationInbox.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    db.integrationInbox.findUnique.mockResolvedValue({ status: 'processed' });
    expect((await call(makeHandler({ db, env: ENV, log }), goodBody())).status).toBe(200);
  });
  test('the identity changes with the Deal, the event or the timestamp, and is stable otherwise', () => {
    const base = eventIdentity('ONCRMDEALUPDATE', '1', '100');
    expect(eventIdentity('ONCRMDEALUPDATE', '1', '100')).toBe(base);
    for (const other of [eventIdentity('ONCRMDEALUPDATE', '2', '100'), eventIdentity('ONCRMDEALUPDATE', '1', '101'), eventIdentity('X', '1', '100')]) expect(other).not.toBe(base);
  });
  test('a storage failure answers a fixed 500 and logs only an error name', async () => {
    db.integrationInbox.create.mockRejectedValueOnce(Object.assign(new Error(`failed for ${TOKEN} Asha`), { name: 'PrismaClientKnownRequestError' }));
    expect(await call(makeHandler({ db, env: ENV, log }), goodBody())).toEqual({ status: 500, body: { ok: false } });
    expect(log.error.mock.calls.map((c) => c[0]).join(' ')).not.toMatch(new RegExp(`${TOKEN}|Asha`));
  });
  test('the route exists and is POST /deal-stage', () => {
    const layer = bitrixInboundRouter.stack.find((l) => l.route && l.route.path === '/deal-stage');
    expect(layer.route.methods).toEqual({ post: true });
  });
});

describe('the approved Category 38 stage table', () => {
  const expected = {
    'C38:NEW': ['patient_details', 'submitted', false],
    'C38:PREPARATION': ['no_response', null, false],
    'C38:PREPAYMENT_INVOIC': ['documentation', 'in_progress', true],
    'C38:EXECUTING': ['in_progress', 'in_progress', true],
    'C38:FINAL_INVOICE': ['final_invoice', 'in_progress', true],
    'C38:1': ['on_hold', null, false],
    'C38:WON': ['completed', 'completed', true],
    'C38:APOLOGY': ['duplicate', null, false],
  };
  test.each(Object.entries(expected))('%s -> %s / status %s / patient-visible %s', (stageId, [key, status, visible]) => {
    expect(lookupStage(stageId, {})).toEqual({ ok: true, entry: expect.objectContaining({ key, status, patientVisible: visible }) });
  });
  test('only Documentation, In Progress, Final invoice and Completed are patient-visible, each with a fixed message', () => {
    const visible = Object.values(STAGES).filter((s) => s.patientVisible).map((s) => s.key).sort();
    expect(visible).toEqual(['completed', 'documentation', 'final_invoice', 'in_progress']);
    for (const s of Object.values(STAGES)) expect(Boolean(s.message)).toBe(s.patientVisible);
  });
  test('Deal Lost: only lost reason 5914 (Patient Cancelled) maps, to cancelled; everything else is quarantined', () => {
    const opts = { lostReasonField: 'UF_LOST' };
    expect(lookupStage('C38:LOSE', { UF_LOST: '5914' }, opts)).toEqual({ ok: true, entry: expect.objectContaining({ key: 'cancelled', status: 'cancelled' }) });
    expect(lookupStage('C38:LOSE', { UF_LOST: 5914 }, opts).ok).toBe(true);
    for (const reason of ['5916', '0', 'x', ' 5914', '5914 ']) expect(lookupStage('C38:LOSE', { UF_LOST: reason }, opts)).toEqual({ ok: false, code: 'lost_reason_unmapped' });
    for (const reason of [undefined, null, '']) expect(lookupStage('C38:LOSE', { UF_LOST: reason }, opts)).toEqual({ ok: false, code: 'lost_reason_missing' });
  });
  test('Deal Lost reads the confirmed lost-reason field and never the companion text field', () => {
    expect(LOST_REASON_FIELD).toBe('UF_CRM_1788858985323');
    expect(lookupStage('C38:LOSE', { UF_CRM_1788858985323: '5914' })).toEqual({ ok: true, entry: expect.objectContaining({ key: 'cancelled', status: 'cancelled' }) });
    expect(lookupStage('C38:LOSE', { UF_CRM_1788858985323: '5914', UF_CRM_1788859072681: 'anything' }).ok).toBe(true);
    expect(lookupStage('C38:LOSE', { UF_CRM_1788859072681: '5914' })).toEqual({ ok: false, code: 'lost_reason_missing' });
    expect(lookupStage('C38:LOSE', { UF_CRM_1788858985323: '5916', UF_CRM_1788859072681: 'Patient Cancelled' })).toEqual({ ok: false, code: 'lost_reason_unmapped' });
    expect(lookupStage('C38:LOSE', { LOST_REASON_ID: '5914' })).toEqual({ ok: false, code: 'lost_reason_missing' });
  });
  test('Patient Cancelled is patient-visible as "Request Cancelled" with one fixed message', () => {
    const { entry } = lookupStage('C38:LOSE', { UF_CRM_1788858985323: '5914' });
    expect(entry).toMatchObject({ key: 'cancelled', status: 'cancelled', patientVisible: true, label: 'Request Cancelled' });
    expect(entry.message).toBe('Your Private Charter request has been cancelled. Please contact our support team if you need assistance.');
  });
  test.each([['C38:UC_1PK4XX', 'obsolete_stage'], ['C38:UNKNOWN', 'unknown_stage'], ['NEW', 'unknown_stage'], ['C12:NEW', 'unknown_stage'], ['c38:new', 'unknown_stage'], ['constructor', 'unknown_stage'], ['__proto__', 'unknown_stage'], ['', 'stage_missing'], [undefined, 'stage_missing'], [7, 'stage_missing']])(
    'stage %p is quarantined as %s', (stageId, code) => {
      expect(lookupStage(stageId, {})).toEqual({ ok: false, code });
    },
  );
});
