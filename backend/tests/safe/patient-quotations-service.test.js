/* global describe, test, expect, jest, beforeEach, afterEach */
// The patient's quotation workflow, rule by rule. In-memory world (fake Prisma whose transaction serialises callers like the Case row lock and rolls back
// on a throw), REAL stored files in a temp folder. No database, no network, no Bitrix, no Razorpay.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const fs = require('fs');
const kit = require('./quotation-test-kit');
const patient = require('../../src/modules/quotations/patient-quotations.service');
const admin = require('../../src/modules/quotations/quotations.service');

const { pdf, sha } = kit;
let rig; let seq;
const OWNER = 55; // world.request.userId
const STRANGER = 56;

beforeEach(() => { rig = kit.makeRig(); seq = 0; });
afterEach(() => rig.cleanup());

const deps = (extra = {}) => ({ prisma: rig.prisma, storage: rig.storage, now: () => new Date(rig.world.clock), log: rig.log, ...extra });
const row = (id) => rig.world.quotations.find((q) => q.id === id);
const actions = () => rig.world.audit.map((a) => a.action);
const HOUR = 3600 * 1000;

async function seed(over = {}) {
  seq += 1;
  const bytes = over.bytes || pdf(`pq${seq}`);
  const hash = sha(bytes);
  const key = `quotations/case-3037/ev${800 + seq}-${hash}.pdf`;
  await rig.storage.putIfAbsent(key, bytes, hash);
  const { bytes: _b, ...rest } = over;
  const status = rest.status || 'published';
  const live = ['published', 'accepted'].includes(status) && !rest.supersededAt;
  return rig.prisma.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(65000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', bitrixDealStageId: 'C38:NEW',
      contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash, amount: '1000.000', currency: 'INR', validationError: null, status,
      workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null, liveSlot: live ? 1 : null, scanStatus: 'clean', revision: 5, lastSeenAt: new Date(rig.world.clock),
      ...(status !== 'draft' ? { confirmedByAdminId: 7, confirmedAt: new Date(rig.world.clock - 3 * HOUR) } : {}),
      ...(['published', 'accepted', 'rejected', 'superseded'].includes(status) ? { publishedByAdminId: 7, publishedAt: new Date(rig.world.clock - 2 * HOUR) } : {}),
      ...(status === 'accepted' ? { decidedByUserId: OWNER, decidedAt: new Date(rig.world.clock - HOUR) } : {}),
      ...(status === 'rejected' ? { decidedByUserId: OWNER, decidedAt: new Date(rig.world.clock - HOUR), rejectionReason: 'Too high' } : {}),
      ...(status === 'withdrawn' ? { withdrawnAt: new Date(), withdrawnByAdminId: 7, withdrawReason: 'x' } : {}),
      ...rest,
    },
  });
}
const rejectsWith = async (promise, status, code) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err).toMatchObject({ statusCode: status, ...(code ? { publicCode: code } : {}) });
  return err;
};
const accept = (q, extra = {}) => patient.acceptQuotation({ userId: OWNER, quotationId: q.id, ...extra }, deps());
const reject = (q, reason = 'The amount is higher than agreed', extra = {}) => patient.rejectQuotation({ userId: OWNER, quotationId: q.id, reason, ...extra }, deps());
const active = (userId = OWNER) => patient.getActiveQuotation({ userId, requestId: 4672 }, deps());

describe('what a patient can see (the ONE active published quotation)', () => {
  test('the owner sees the live published version with exactly the fields the app needs, and nothing internal', async () => {
    const q = await seed({ validUntil: new Date(rig.world.clock + 24 * HOUR) });
    const { quotation, lastDecision } = await active();
    expect(lastDecision).toBeNull();
    expect(quotation).toEqual({
      id: q.id, versionNumber: q.versionNumber, status: 'published', amount: '1000.000', currency: 'INR', validUntil: new Date(rig.world.clock + 24 * HOUR).toISOString(),
      publishedAt: new Date(rig.world.clock - 2 * HOUR).toISOString(), decidedAt: null, rejectionReason: null, expired: false, fileAvailable: true, sizeBytes: q.sizeBytes, canDecide: true,
    });
    expect(JSON.stringify(quotation)).not.toMatch(/quotations\/case-|storageKey|sha256|\.pdf|bitrix|admin|confirmedBy|publishedBy|scan|revision|dealLink/i);
  });

  test.each(['draft', 'confirmed', 'withdrawn'])('a %s version is invisible to the patient', async (status) => {
    await seed({ status });
    expect(await active()).toEqual({ quotation: null, lastDecision: null });
  });

  test('only the latest live version is returned: a newer published version replaces the old one (superseded versions are never shown)', async () => {
    const v1 = await seed();
    Object.assign(row(v1.id), { status: 'superseded', liveSlot: null, supersededAt: new Date(rig.world.clock - 1000), supersededById: 2 });
    const v2 = await seed();
    const { quotation } = await active();
    expect(quotation.id).toBe(v2.id);
    expect(quotation.versionNumber).toBe(2);
  });

  test('an accepted quotation is shown with the confirmed decision and can no longer be decided', async () => {
    await seed({ status: 'accepted' });
    const { quotation } = await active();
    expect(quotation).toMatchObject({ status: 'accepted', canDecide: false, expired: false });
    expect(quotation.decidedAt).toBe(new Date(rig.world.clock - HOUR).toISOString());
  });

  test('an expired quotation is returned as expired and cannot be decided (the expiry is computed, never stored)', async () => {
    await seed({ validUntil: new Date(rig.world.clock - 1000) });
    const { quotation } = await active();
    expect(quotation).toMatchObject({ status: 'published', expired: true, canDecide: false });
    expect(rig.world.quotations[0].status).toBe('published');
  });

  test('a closed Case cannot be decided', async () => {
    await seed();
    rig.world.caseRecord.status = 'completed';
    expect((await active()).quotation.canDecide).toBe(false);
  });

  test('after a rejection nothing is live: the app is told about the rejection, not shown a quotation; a newer draft hides even that', async () => {
    const q = await seed({ status: 'rejected' });
    expect(await active()).toEqual({ quotation: null, lastDecision: { versionNumber: q.versionNumber, status: 'rejected', decidedAt: new Date(rig.world.clock - HOUR).toISOString(), amount: '1000.000', currency: 'INR' } });
    await seed({ status: 'draft' });
    expect(await active()).toEqual({ quotation: null, lastDecision: null });
  });

  test('another patient, an unknown request and a non-Private-Charter request all look the same: 404', async () => {
    await seed();
    await rejectsWith(active(STRANGER), 404, 'quotation_not_found');
    await rejectsWith(patient.getActiveQuotation({ userId: OWNER, requestId: 999 }, deps()), 404, 'quotation_not_found');
    await rejectsWith(patient.getActiveQuotation({ userId: OWNER, requestId: 'abc' }, deps()), 404, 'quotation_not_found');
    rig.world.request.serviceKey = 'ground';
    await rejectsWith(active(), 404, 'quotation_not_found');
    await rejectsWith(patient.getActiveQuotation({ userId: undefined, requestId: 4672 }, deps()), 401, 'not_signed_in');
  });
});

describe('the PDF', () => {
  test('is served to the owner for the live published (or accepted) version, and every access is audited as the patient', async () => {
    const bytes = pdf('patient-visible');
    const q = await seed({ bytes });
    const a = await patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: q.id }, deps());
    const b = await patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: q.id }, deps());
    expect(a.buffer).toEqual(bytes);
    expect(b.buffer).toEqual(bytes);
    expect(a.name).toBe(`CASE-4037-quotation-v${q.versionNumber}.pdf`);
    const views = rig.world.audit.filter((x) => x.action === 'quotation.file_viewed');
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ actorType: 'patient', actorId: '55', source: 'mobile_app', idempotencyKey: null });

    const accepted = await seed({ status: 'accepted', bytes: pdf('accepted-one') });
    Object.assign(row(q.id), { status: 'superseded', liveSlot: null, supersededAt: new Date(), supersededById: accepted.id });
    await expect(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: accepted.id }, deps())).resolves.toBeTruthy();
  });

  test.each(['draft', 'confirmed', 'withdrawn'])('a %s version is never served: 404, and nothing is audited', async (status) => {
    const q = await seed({ status });
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: q.id }, deps()), 404, 'quotation_not_found');
    expect(rig.world.audit).toEqual([]);
  });

  test('a rejected or superseded version is no longer available (409)', async () => {
    const rejected = await seed({ status: 'rejected' });
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: rejected.id }, deps()), 409, 'quotation_not_available');
    const old = await seed({ status: 'superseded', supersededAt: new Date(), supersededById: 99 });
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: old.id }, deps()), 409, 'quotation_not_available');
  });

  test('another patient\'s quotation is a 404; an unclean or altered file is never served', async () => {
    const q = await seed();
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: STRANGER, quotationId: q.id }, deps()), 404, 'quotation_not_found');
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: 12345 }, deps()), 404, 'quotation_not_found');
    for (const scanStatus of ['pending', 'error', 'infected']) {
      row(q.id).scanStatus = scanStatus;
      await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: q.id }, deps()), 409, 'quotation_not_available');
    }
    row(q.id).scanStatus = 'clean';
    fs.writeFileSync(rig.storage.pathOf(q.storageKey), 'tampered');
    await rejectsWith(patient.resolvePatientQuotationFile({ userId: OWNER, quotationId: q.id }, deps()), 409, 'quotation_not_available');
    expect(rig.world.audit).toEqual([]);
  });
});

describe('accepting', () => {
  test('records the patient, the exact version and the time; the version stays live and becomes immutable; nothing else happens', async () => {
    const q = await seed();
    const result = await accept(q);
    expect(result.alreadyAccepted).toBe(false);
    expect(row(q.id)).toMatchObject({ status: 'accepted', decidedByUserId: OWNER, revision: 6, liveSlot: 1, workingSlot: null, rejectionReason: null });
    expect(+row(q.id).decidedAt).toBe(rig.world.clock);
    expect(result.quotation).toMatchObject({ id: q.id, versionNumber: q.versionNumber, status: 'accepted', canDecide: false, amount: '1000.000', currency: 'INR' });
    expect(rig.world.audit).toHaveLength(1);
    expect(rig.world.audit[0]).toMatchObject({
      action: 'quotation.accepted', entityType: 'case_quotation', entityId: String(q.id), caseId: 3037, actorType: 'patient', actorId: '55', source: 'mobile_app',
      reasonCode: 'patient_accepted', beforeData: { status: 'published' }, idempotencyKey: `quotation.accepted:${q.id}`,
    });
    for (const model of ['invoice', 'payment']) expect(rig.prisma[model]).toBeUndefined(); // an invoice is a later step
    expect(rig.prisma.notification.create).not.toHaveBeenCalled();
    expect(rig.prisma.caseQuotation.create).toHaveBeenCalledTimes(1); // only the seed
  });

  test('a repeated acceptance by the same patient is a no-op: no second audit row, no change', async () => {
    const q = await seed();
    await accept(q);
    const before = JSON.stringify(row(q.id));
    const again = await accept(q);
    expect(again.alreadyAccepted).toBe(true);
    expect(JSON.stringify(row(q.id))).toBe(before);
    expect(actions()).toEqual(['quotation.accepted']);
  });

  test('an accepted quotation cannot be rejected, and a rejected one cannot be accepted (decisions are final)', async () => {
    const a = await seed();
    await accept(a);
    const afterAccept = JSON.stringify(row(a.id));
    const err = await rejectsWith(reject(a), 409, 'quotation_already_decided');
    expect(err.message).toMatch(/cannot be changed/);
    expect(JSON.stringify(row(a.id))).toBe(afterAccept);

    const r = await seed();
    await reject(r);
    const afterReject = JSON.stringify(row(r.id));
    await rejectsWith(accept(r), 409, 'quotation_already_decided');
    expect(JSON.stringify(row(r.id))).toBe(afterReject);
    expect(actions()).toEqual(['quotation.accepted', 'quotation.rejected']);
  });

  test('another patient cannot decide this quotation (404, nothing changes); a decision by someone else on a decided version is refused', async () => {
    const q = await seed();
    await rejectsWith(patient.acceptQuotation({ userId: STRANGER, quotationId: q.id }, deps()), 404, 'quotation_not_found');
    await rejectsWith(patient.rejectQuotation({ userId: STRANGER, quotationId: q.id, reason: 'no thanks' }, deps()), 404, 'quotation_not_found');
    expect(row(q.id)).toMatchObject({ status: 'published', decidedByUserId: null, revision: 5 });
    expect(rig.world.audit).toEqual([]);
    const done = await seed({ status: 'accepted', decidedByUserId: 77 });
    await rejectsWith(accept(done), 409, 'quotation_already_decided'); // accepted by somebody else: never "already done" for this patient
  });

  test.each(['draft', 'confirmed', 'withdrawn'])('a %s version cannot be decided: it does not exist for the patient (404)', async (status) => {
    const q = await seed({ status });
    await rejectsWith(accept(q), 404, 'quotation_not_found');
    await rejectsWith(reject(q), 404, 'quotation_not_found');
    expect(row(q.id).status).toBe(status);
  });

  test('a superseded version cannot be decided: the decision is about the exact version, and a newer one has replaced it', async () => {
    const v1 = await seed();
    const v2 = await seed({ status: 'confirmed' });
    await admin.publishQuotation({ quotationId: v2.id, revision: 5, adminId: 7, adminRole: 'admin' }, { ...deps(), push: jest.fn(async () => undefined) });
    expect(row(v1.id).status).toBe('superseded');
    await rejectsWith(accept(v1), 409, 'quotation_superseded');
    await rejectsWith(reject(v1), 409, 'quotation_superseded');
    expect(row(v2.id)).toMatchObject({ status: 'published', decidedByUserId: null }); // the new version is untouched
    await expect(accept(row(v2.id))).resolves.toMatchObject({ alreadyAccepted: false });
  });

  test('an expired quotation cannot be accepted or rejected, also exactly at the expiry time', async () => {
    const q = await seed({ validUntil: new Date(rig.world.clock - 1) });
    await rejectsWith(accept(q), 409, 'quotation_expired');
    await rejectsWith(reject(q), 409, 'quotation_expired');
    row(q.id).validUntil = new Date(rig.world.clock);
    await rejectsWith(accept(q), 409, 'quotation_expired');
    row(q.id).validUntil = new Date(rig.world.clock + 1);
    await expect(accept(q)).resolves.toMatchObject({ alreadyAccepted: false });
  });

  test('a closed Case, or a quotation that is not clean and valid, cannot be decided', async () => {
    const q = await seed();
    rig.world.caseRecord.status = 'cancelled';
    await rejectsWith(accept(q), 409, 'case_closed');
    rig.world.caseRecord.status = 'in_progress';
    for (const bad of [{ scanStatus: 'pending' }, { scanStatus: 'infected' }, { amount: null, currency: null }, { validationError: 'amount_precision' }]) {
      const original = Object.fromEntries(Object.keys(bad).map((k) => [k, row(q.id)[k]]));
      Object.assign(row(q.id), bad);
      await rejectsWith(accept(q), 409, 'quotation_unavailable');
      Object.assign(row(q.id), original);
    }
    expect(row(q.id)).toMatchObject({ status: 'published', revision: 5 });
  });

  test('a version that changed during the decision is refused, never overwritten', async () => {
    const q = await seed();
    rig.prisma.caseQuotation.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await rejectsWith(accept(q), 409, 'quotation_changed');
    expect(row(q.id)).toMatchObject({ status: 'published', decidedByUserId: null });
    expect(rig.world.audit).toEqual([]);
  });

  test('two acceptances at the same time: one writes, the other sees "already accepted"; one audit row', async () => {
    const q = await seed();
    const results = await Promise.all([accept(q), accept(q)]);
    expect(results.map((r) => r.alreadyAccepted).sort()).toEqual([false, true]);
    expect(row(q.id).revision).toBe(6);
    expect(actions()).toEqual(['quotation.accepted']);
  });

  test('an acceptance racing a rejection: exactly one decision is stored, the other request is refused', async () => {
    const q = await seed();
    const [a, r] = await Promise.allSettled([accept(q), reject(q)]);
    expect([a.status, r.status].sort()).toEqual(['fulfilled', 'rejected']);
    const loser = a.status === 'rejected' ? a.reason : r.reason;
    expect(loser).toMatchObject({ statusCode: 409, publicCode: 'quotation_already_decided' });
    expect(['accepted', 'rejected']).toContain(row(q.id).status);
    expect(rig.world.audit).toHaveLength(1);
    expect(row(q.id).revision).toBe(6);
  });

  test('an invalid id or no signed-in patient is refused', async () => {
    await rejectsWith(patient.acceptQuotation({ userId: OWNER, quotationId: 'x;y' }, deps()), 404, 'quotation_not_found');
    await rejectsWith(patient.acceptQuotation({ userId: OWNER, quotationId: 404 }, deps()), 404, 'quotation_not_found');
    const q = await seed();
    await rejectsWith(patient.acceptQuotation({ userId: null, quotationId: q.id }, deps()), 401, 'not_signed_in');
  });
});

describe('rejecting', () => {
  test('stores the reason (trimmed), the patient and the time; the version stops being live and becomes immutable; the reason is NOT in the audit trail', async () => {
    const q = await seed();
    const result = await reject(q, '  The amount is higher than agreed  ');
    expect(result.alreadyRejected).toBe(false);
    expect(row(q.id)).toMatchObject({ status: 'rejected', decidedByUserId: OWNER, rejectionReason: 'The amount is higher than agreed', liveSlot: null, revision: 6 });
    expect(+row(q.id).decidedAt).toBe(rig.world.clock);
    expect(result.quotation).toMatchObject({ status: 'rejected', canDecide: false, rejectionReason: 'The amount is higher than agreed' });
    expect(rig.world.audit[0]).toMatchObject({ action: 'quotation.rejected', actorType: 'patient', actorId: '55', reasonCode: 'patient_rejected', idempotencyKey: `quotation.rejected:${q.id}` });
    expect(JSON.stringify(rig.world.audit)).not.toMatch(/higher than agreed/);
    expect(rig.prisma.notification.create).not.toHaveBeenCalled();
    expect((await active()).quotation).toBeNull();
    expect((await active()).lastDecision).toMatchObject({ status: 'rejected', versionNumber: q.versionNumber });
  });

  test.each([[undefined], [null], [''], ['   '], ['no'], ['x'.repeat(1001)], [42], [{ text: 'a reason' }]])('a reason of %p is refused and nothing changes', async (reason) => {
    const q = await seed();
    await rejectsWith(patient.rejectQuotation({ userId: OWNER, quotationId: q.id, reason }, deps()), 400, 'reason_invalid');
    expect(row(q.id)).toMatchObject({ status: 'published', decidedByUserId: null, rejectionReason: null, revision: 5 });
    expect(rig.world.audit).toEqual([]);
  });

  test('a reason of exactly 3 and exactly 1000 characters is accepted', async () => {
    const a = await seed();
    await expect(reject(a, 'abc')).resolves.toMatchObject({ alreadyRejected: false });
    const b = await seed();
    await expect(reject(b, 'x'.repeat(1000))).resolves.toMatchObject({ alreadyRejected: false });
  });

  test('a repeated rejection by the same patient is a no-op and keeps the first reason', async () => {
    const q = await seed();
    await reject(q, 'First reason');
    const again = await reject(q, 'A different reason');
    expect(again.alreadyRejected).toBe(true);
    expect(row(q.id).rejectionReason).toBe('First reason');
    expect(actions()).toEqual(['quotation.rejected']);
  });
});

describe('the Phase 1 and Phase 2 rules still hold after a patient decision', () => {
  const adminCall = (fn, q, extra = {}) => admin[fn]({ quotationId: q.id, revision: row(q.id).revision, adminId: 7, adminRole: 'admin', ...extra }, { ...deps(), push: jest.fn(async () => undefined) });

  test('an Admin cannot confirm, publish or withdraw an accepted or rejected version', async () => {
    const a = await seed(); await accept(a);
    const r = await seed(); await reject(r);
    const snapshot = JSON.stringify(rig.world.quotations);
    await rejectsWith(adminCall('confirmQuotation', a), 409, 'quotation_not_draft');
    await rejectsWith(adminCall('publishQuotation', a), 409, 'new_version_required');
    await rejectsWith(adminCall('withdrawQuotation', a, { reason: 'changed my mind' }), 409, 'quotation_immutable');
    await rejectsWith(adminCall('confirmQuotation', r), 409, 'quotation_not_draft');
    await rejectsWith(adminCall('publishQuotation', r), 409, 'quotation_not_publishable');
    await rejectsWith(adminCall('withdrawQuotation', r, { reason: 'changed my mind' }), 409, 'quotation_immutable');
    expect(JSON.stringify(rig.world.quotations)).toBe(snapshot);
  });

  test('a new version of a rejected quotation needs a fresh publication AND a fresh decision by the patient', async () => {
    const r = await seed(); await reject(r);
    row(r.id).versionNumber = 1;
    const created = await adminCall('createNewVersion', r);
    const v2 = rig.world.quotations.find((q) => q.id === created.quotation.id);
    expect(v2).toMatchObject({ status: 'draft', decidedByUserId: null, decidedAt: null });
    await rejectsWith(accept(v2), 404, 'quotation_not_found'); // a draft is invisible to the patient
  });

  test('after a decision nothing in this module created a version, an invoice, a payment or a Bitrix call', async () => {
    const q = await seed();
    await accept(q);
    expect(rig.world.quotations).toHaveLength(1);
    expect(rig.api.calls).toEqual([]);
    const source = fs.readFileSync(require.resolve('../../src/modules/quotations/patient-quotations.service.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(source).not.toMatch(/bitrix-deal\.api|crm\.|fetch\(|razorpay|\.invoice\b|\.payment\b|notification\.create|caseQuotation\.create/i);
  });
});
