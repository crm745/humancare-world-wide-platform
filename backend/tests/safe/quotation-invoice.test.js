/* global describe, test, expect, jest, beforeEach, afterEach */
// Phase 4: the invoice created from an ACCEPTED quotation, rule by rule. In-memory world (fake Prisma whose transaction serialises callers like the Case
// row lock, rolls back on a throw, and refuses what the real unique keys / composite foreign key refuse). No database, no network, no Razorpay, no Bitrix.
jest.mock('../../src/db/prisma', () => ({ prisma: {} }));

const kit = require('./quotation-test-kit');
const patient = require('../../src/modules/quotations/patient-quotations.service');
const inv = require('../../src/modules/quotations/quotation-invoice.service');
const { listInvoicesForRequest } = require('../../src/modules/payments/patient-invoices.service');

const { pdf, sha } = kit;
const OWNER = 55;
const STRANGER = 56;
const HOUR = 3600 * 1000;
let rig; let seq;

beforeEach(() => { rig = kit.makeRig(); kit.attachInvoices(rig.prisma, rig.world); seq = 0; });
afterEach(() => rig.cleanup());

const deps = (extra = {}) => ({ prisma: rig.prisma, storage: rig.storage, now: () => new Date(rig.world.clock), log: rig.log, ...extra });
const actions = () => rig.world.audit.map((a) => a.action);
const rejectsWith = async (promise, status, code) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err).toMatchObject({ statusCode: status, ...(code ? { publicCode: code } : {}) });
};

async function seed(over = {}) {
  seq += 1;
  const bytes = pdf(`qi${seq}`);
  const hash = sha(bytes);
  const key = `quotations/case-3037/ev${900 + seq}-${hash}.pdf`;
  await rig.storage.putIfAbsent(key, bytes, hash);
  const status = over.status || 'published';
  const live = ['published', 'accepted'].includes(status) && !over.supersededAt;
  return rig.prisma.caseQuotation.create({
    data: {
      caseId: 3037, dealLinkId: 1173, versionNumber: seq, bitrixDealId: kit.DEAL, bitrixFileId: String(66000 + seq), bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', bitrixDealStageId: 'C38:NEW',
      contentFingerprint: hash, storageProvider: 'local', storageKey: key, sizeBytes: bytes.length, sha256: hash, amount: '1250.500', currency: 'INR', validationError: null, status,
      workingSlot: ['draft', 'confirmed'].includes(status) ? 1 : null, liveSlot: live ? 1 : null, scanStatus: 'clean', revision: 5, lastSeenAt: new Date(rig.world.clock),
      ...(status !== 'draft' ? { confirmedByAdminId: 7, confirmedAt: new Date(rig.world.clock - 3 * HOUR) } : {}),
      ...(['published', 'accepted', 'rejected', 'superseded'].includes(status) ? { publishedByAdminId: 7, publishedAt: new Date(rig.world.clock - 2 * HOUR) } : {}),
      ...(status === 'accepted' ? { decidedByUserId: OWNER, decidedAt: new Date(rig.world.clock - HOUR) } : {}),
      ...(status === 'rejected' ? { decidedByUserId: OWNER, decidedAt: new Date(rig.world.clock - HOUR), rejectionReason: 'Too high' } : {}),
      ...(status === 'withdrawn' ? { withdrawnAt: new Date(), withdrawnByAdminId: 7, withdrawReason: 'x' } : {}),
      ...over,
    },
  });
}
const ensure = (q, extra = {}) => inv.ensureInvoiceForPatient({ userId: OWNER, quotationId: q.id, ...extra }, deps());

describe('creation after acceptance', () => {
  test('accepting through the real patient flow and then ensuring creates one issued invoice that matches the quotation exactly', async () => {
    const q = await seed({ status: 'published' });
    await patient.acceptQuotation({ userId: OWNER, quotationId: q.id }, deps());
    expect(rig.world.invoices).toHaveLength(0); // the decision itself creates nothing: that rule is unchanged
    const { created, invoice } = await ensure(q);
    expect(created).toBe(true);
    expect(rig.world.invoices).toHaveLength(1);
    const row = rig.world.invoices[0];
    expect(row).toMatchObject({
      caseId: 3037, quotationId: q.id, source: 'quotation', status: 'issued', amount: '1250.500', currency: 'INR', allowPartialPayment: false,
      partialPaymentAuthorizedByAdminId: null, partialPaymentAuthorizedAt: null, invoiceNumber: 'INV-CASE-4037-V1', idempotencyKey: `quotation-invoice:${q.id}`, dueDate: null,
    });
    expect(row.issueDate.toISOString()).toBe('2030-01-02T00:00:00.000Z');
    expect(invoice).toMatchObject({ amount: '1250.500', currency: 'INR', invoiceNumber: 'INV-CASE-4037-V1', status: 'issued', issueDate: '2030-01-02', allowPartialPayment: false });
    expect(actions()).toEqual(['quotation.accepted', 'invoice.created']);
  });

  test('the accepted quotation row is not modified by the invoice step', async () => {
    const q = await seed({ status: 'accepted' });
    const before = JSON.stringify(rig.world.quotations);
    await ensure(q);
    expect(JSON.stringify(rig.world.quotations)).toBe(before);
  });

  test('the audit row names the invoice, the quotation version, the amount and currency, and no personal data', async () => {
    const q = await seed({ status: 'accepted' });
    await ensure(q);
    const a = rig.world.audit.find((x) => x.action === 'invoice.created');
    expect(a).toMatchObject({ entityType: 'invoice', entityId: '1', actorType: 'patient', actorId: String(OWNER), idempotencyKey: 'invoice.created:1' });
    expect(a.afterData).toEqual({ invoiceId: 1, quotationId: q.id, versionNumber: 1, caseId: 3037, caseReference: kit.REF, amount: '1250.500', currency: 'INR', status: 'issued' });
  });
});

describe('refusals: never an invoice for an ineligible quotation', () => {
  test.each([['rejected'], ['published']])('%s -> 409 quotation_not_accepted, no invoice, no audit', async (status) => {
    const q = await seed({ status });
    await rejectsWith(ensure(q), 409, 'quotation_not_accepted');
    expect(rig.world.invoices).toHaveLength(0);
    expect(actions()).toEqual([]);
  });
  test.each([['draft'], ['confirmed'], ['withdrawn']])('%s (unpublished) is invisible to the patient: 404, no invoice', async (status) => {
    const q = await seed({ status });
    await rejectsWith(ensure(q), 404, 'quotation_not_found');
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('an unpublished quotation is refused on the system path too', async () => {
    const q = await seed({ status: 'confirmed' });
    await rejectsWith(inv.ensureInvoiceForQuotation({ quotationId: q.id }, deps()), 409, 'quotation_not_accepted');
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('an accepted quotation that a newer version superseded gets no invoice', async () => {
    const q = await seed({ status: 'accepted', supersededAt: new Date(rig.world.clock), supersededById: 99, liveSlot: null });
    await rejectsWith(ensure(q), 409, 'quotation_superseded');
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('an expired-then-unaccepted (published, validUntil passed) quotation is not accepted, so no invoice', async () => {
    const q = await seed({ status: 'published', validUntil: new Date(rig.world.clock - 1000) });
    await rejectsWith(ensure(q), 409, 'quotation_not_accepted');
  });
  test('another patient: 404 exactly like a missing quotation, nothing created', async () => {
    const q = await seed({ status: 'accepted' });
    await rejectsWith(inv.ensureInvoiceForPatient({ userId: STRANGER, quotationId: q.id }, deps()), 404, 'quotation_not_found');
    await rejectsWith(inv.ensureInvoiceForPatient({ userId: OWNER, quotationId: 9999 }, deps()), 404, 'quotation_not_found');
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('a closed Case, a missing scan, or invalid money are refused', async () => {
    const q = await seed({ status: 'accepted' });
    rig.world.caseRecord.status = 'cancelled';
    await rejectsWith(ensure(q), 409, 'case_closed');
    rig.world.caseRecord.status = 'in_progress';
    rig.world.quotations[0].scanStatus = 'pending';
    await rejectsWith(ensure(q), 409, 'quotation_unavailable');
    rig.world.quotations[0].scanStatus = 'clean';
    rig.world.quotations[0].amount = '10.12345';
    await rejectsWith(ensure(q), 409, 'quotation_unavailable'); // more than three decimals would need rounding: refused, never rounded
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('a non-Private-Charter Case is refused', async () => {
    const q = await seed({ status: 'accepted' });
    rig.world.request.serviceKey = 'other';
    await rejectsWith(ensure(q), 409, 'quotation_ineligible');
    expect(rig.world.invoices).toHaveLength(0);
  });
  test('an accepted quotation decided by someone other than the Case owner is not invoiced on the patient path', async () => {
    const q = await seed({ status: 'accepted', decidedByUserId: 77 });
    await rejectsWith(ensure(q), 409, 'quotation_ineligible');
  });
});

describe('duplicates, retries and concurrency', () => {
  test('a retry after success returns the existing invoice: one row, one audit row', async () => {
    const q = await seed({ status: 'accepted' });
    const first = await ensure(q);
    const second = await ensure(q);
    expect(second.created).toBe(false);
    expect(second.invoice).toEqual(first.invoice);
    expect(rig.world.invoices).toHaveLength(1);
    expect(actions().filter((a) => a === 'invoice.created')).toHaveLength(1);
  });
  test('a retry returns the existing invoice even after the quotation was later superseded', async () => {
    const q = await seed({ status: 'accepted' });
    const first = await ensure(q);
    rig.world.quotations[0].supersededAt = new Date(rig.world.clock);
    rig.world.quotations[0].supersededById = 2;
    const again = await ensure(q);
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(first.invoice.id);
  });
  test('ten concurrent requests (patient, system and retries mixed) create exactly one invoice and one audit row', async () => {
    const q = await seed({ status: 'accepted' });
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 ? ensure(q) : inv.ensureInvoiceForQuotation({ quotationId: q.id }, deps())));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.invoice.id)).size).toBe(1);
    expect(rig.world.invoices).toHaveLength(1);
    expect(actions().filter((a) => a === 'invoice.created')).toHaveLength(1);
  });
  test('if another writer wins the race (unique violation, lock bypassed), the existing invoice is returned', async () => {
    const q = await seed({ status: 'accepted' });
    // A rival transaction already committed the invoice, but this one's first read (under a lock that did not hold) still saw nothing.
    await inv.ensureInvoiceForQuotation({ quotationId: q.id }, deps());
    const realFind = rig.prisma.invoice.findFirst;
    rig.prisma.invoice.findFirst = jest.fn().mockResolvedValueOnce(null).mockImplementation(realFind);
    const out = await ensure(q);
    expect(out.created).toBe(false);
    expect(rig.world.invoices).toHaveLength(1);
  });
  test('the database refuses a second invoice for the same quotation, and one whose amount or currency differs', async () => {
    const q = await seed({ status: 'accepted' });
    await ensure(q);
    const base = { caseId: 3037, source: 'quotation', quotationId: q.id, currency: 'INR', amount: '1250.500', status: 'issued' };
    await expect(rig.prisma.invoice.create({ data: { ...base, invoiceNumber: 'X1' } })).rejects.toMatchObject({ code: 'P2002' });
    const q2 = await seed({ status: 'accepted' });
    await expect(rig.prisma.invoice.create({ data: { ...base, quotationId: q2.id, amount: '1250.501' } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(rig.prisma.invoice.create({ data: { ...base, quotationId: q2.id, currency: 'USD' } })).rejects.toMatchObject({ code: 'P2003' });
  });
  test('an unexpected failure leaves the acceptance untouched, is recorded once per cause, and a later retry succeeds', async () => {
    const q = await seed({ status: 'accepted' });
    const real = rig.prisma.invoice.create;
    rig.prisma.invoice.create = jest.fn(async () => { const e = new Error('connection lost'); e.code = 'ECONNRESET'; throw e; });
    const before = JSON.stringify(rig.world.quotations);
    await expect(ensure(q)).rejects.toMatchObject({ code: 'ECONNRESET' });
    await expect(ensure(q)).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(JSON.stringify(rig.world.quotations)).toBe(before);
    expect(rig.world.invoices).toHaveLength(0);
    // the rolled-back transaction wrote no invoice audit; the failure row is written once, however many retries fail the same way
    expect(actions()).toEqual(['invoice.creation_failed']);
    expect(rig.world.audit[0]).toMatchObject({ entityType: 'case_quotation', entityId: String(q.id), reasonCode: 'econnreset', idempotencyKey: `invoice.creation_failed:${q.id}:econnreset` });
    expect(JSON.stringify(rig.log.error.mock.calls)).not.toContain('connection lost'); // the message is never logged
    rig.prisma.invoice.create = real;
    const ok = await ensure(q);
    expect(ok.created).toBe(true);
    expect(rig.world.invoices).toHaveLength(1);
  });
});

describe('Operations: finding and recovering failures', () => {
  test('accepted quotations without an invoice are listed; the sweep creates them, skips fresh ones and ignores everything else', async () => {
    const old = await seed({ status: 'accepted', decidedAt: new Date(rig.world.clock - HOUR) });
    await seed({ status: 'published' });
    await seed({ status: 'rejected' });
    const fresh = await seed({ status: 'accepted', decidedAt: new Date(rig.world.clock - 1000), liveSlot: null, supersededAt: null });
    expect((await inv.listAcceptedWithoutInvoice(deps())).map((r) => r.id)).toEqual([old.id, fresh.id]);
    const result = await inv.sweepAcceptedWithoutInvoice(deps());
    expect(result).toEqual({ found: 1, created: 1, failed: 0 }); // the fresh acceptance is left to its own request
    expect(rig.world.invoices.map((i) => i.quotationId)).toEqual([old.id]);
    expect(await inv.sweepAcceptedWithoutInvoice(deps())).toEqual({ found: 0, created: 0, failed: 0 }); // repeat: nothing
    expect((await inv.listAcceptedWithoutInvoice(deps())).map((r) => r.id)).toEqual([fresh.id]);
  });
  test('one failing quotation does not stop the sweep', async () => {
    await seed({ status: 'accepted', decidedAt: new Date(rig.world.clock - HOUR) });
    const second = await seed({ status: 'accepted', decidedAt: new Date(rig.world.clock - HOUR), liveSlot: null });
    const real = rig.prisma.invoice.create;
    rig.prisma.invoice.create = jest.fn(async (args) => { if (args.data.quotationId === 1) throw Object.assign(new Error('x'), { code: 'EBOOM' }); return real(args); });
    const result = await inv.sweepAcceptedWithoutInvoice(deps());
    expect(result).toEqual({ found: 2, created: 1, failed: 1 });
    expect(rig.world.invoices.map((i) => i.quotationId)).toEqual([second.id]);
  });
});

describe('partial payment authorization', () => {
  test('defaults to disabled', async () => {
    const q = await seed({ status: 'accepted' });
    await ensure(q);
    expect(rig.world.invoices[0]).toMatchObject({ allowPartialPayment: false, partialPaymentAuthorizedByAdminId: null, partialPaymentAuthorizedAt: null });
  });
  test('an Admin authorizes it: the Admin id and the time are stored together, one audit row', async () => {
    const q = await seed({ status: 'accepted' });
    const { invoice } = await ensure(q);
    const out = await inv.authorizePartialPayment({ invoiceId: invoice.id, adminId: 7, adminRole: 'admin' }, deps());
    expect(out.alreadyAuthorized).toBe(false);
    expect(rig.world.invoices[0]).toMatchObject({ allowPartialPayment: true, partialPaymentAuthorizedByAdminId: 7 });
    expect(rig.world.invoices[0].partialPaymentAuthorizedAt.toISOString()).toBe('2030-01-02T10:00:00.000Z');
    const a = rig.world.audit.find((x) => x.action === 'invoice.partial_payment_authorized');
    expect(a).toMatchObject({ actorType: 'admin', actorId: '7', actorRole: 'admin', entityType: 'invoice', idempotencyKey: `invoice.partial_payment_authorized:${invoice.id}` });
  });
  test('repeating it (even by another Admin) is a no-op that keeps the first authorization and writes no second audit row', async () => {
    const q = await seed({ status: 'accepted' });
    const { invoice } = await ensure(q);
    await inv.authorizePartialPayment({ invoiceId: invoice.id, adminId: 7 }, deps());
    rig.world.clock += HOUR;
    const again = await inv.authorizePartialPayment({ invoiceId: invoice.id, adminId: 8 }, deps());
    expect(again.alreadyAuthorized).toBe(true);
    expect(rig.world.invoices[0].partialPaymentAuthorizedByAdminId).toBe(7);
    expect(actions().filter((a) => a === 'invoice.partial_payment_authorized')).toHaveLength(1);
  });
  test('no Admin identity -> 401; unknown invoice -> 404; void or manual invoice -> 409; the quotation retry never enables it', async () => {
    const q = await seed({ status: 'accepted' });
    const { invoice } = await ensure(q);
    await rejectsWith(inv.authorizePartialPayment({ invoiceId: invoice.id, adminId: undefined }, deps()), 401, 'admin_required');
    await rejectsWith(inv.authorizePartialPayment({ invoiceId: 999, adminId: 7 }, deps()), 404, 'invoice_not_found');
    rig.world.invoices[0].status = 'void';
    await rejectsWith(inv.authorizePartialPayment({ invoiceId: invoice.id, adminId: 7 }, deps()), 409, 'invoice_not_payable');
    rig.world.invoices[0].status = 'issued';
    await ensure(q);
    expect(rig.world.invoices[0].allowPartialPayment).toBe(false);
  });
});

describe('visibility in Request Details and the pending state', () => {
  // The Request Details invoice list is listInvoicesForRequest; this fake serves it from the world's invoice rows.
  const detailsDb = () => {
    const w = rig.world;
    const loaded = (i) => {
      const q = w.quotations.find((x) => x.id === i.quotationId);
      return { ...i, quotation: q ? { id: q.id, status: q.status, supersededAt: q.supersededAt, versionNumber: q.versionNumber } : null, case: { id: 3037, status: w.caseRecord.status, closedAt: null, serviceRequest: { userId: w.request.userId, serviceKey: w.request.serviceKey } } };
    };
    return {
      invoice: {
        findMany: jest.fn(async ({ where }) => w.invoices.filter((i) => i.status !== 'draft' && where.case.serviceRequest.id === w.request.id && where.case.serviceRequest.userId === w.request.userId).map((i) => ({ id: i.id }))),
        findUnique: jest.fn(async ({ where }) => { const i = w.invoices.find((x) => x.id === where.id); return i ? loaded(i) : null; }),
      },
      payment: { findMany: jest.fn(async () => []) },
    };
  };
  const NOW = new Date('2030-01-02T12:00:00Z');
  const OFF = { PAYMENTS_ENABLED: 'false' };

  test('after creation the owner sees number, amount, currency, issue date, status and the quotation version; nobody else does', async () => {
    const q = await seed({ status: 'accepted' });
    await ensure(q);
    const [view] = await listInvoicesForRequest({ userId: OWNER, requestId: 4672, db: detailsDb(), now: NOW, env: OFF });
    expect(view).toMatchObject({ invoiceNumber: 'INV-CASE-4037-V1', amount: '1250.50', currency: 'INR', issueDate: '2030-01-02', dueDate: null, status: 'issued', quotationVersion: 1, allowPartialPayment: false });
    expect(await listInvoicesForRequest({ userId: STRANGER, requestId: 4672, db: detailsDb(), now: NOW, env: OFF })).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/idempotency|razorpay|sha256|storageKey|partialPaymentAuthorizedBy/);
  });
  test('Pay Now is only offered when the payment workflow confirms it: payments disabled -> payable false with a reason', async () => {
    const q = await seed({ status: 'accepted' });
    await ensure(q);
    const [view] = await listInvoicesForRequest({ userId: OWNER, requestId: 4672, db: detailsDb(), now: NOW, env: OFF });
    expect(view).toMatchObject({ payable: false, payableReason: 'payments_disabled' });
  });
  test('isInvoicePending: true between acceptance and creation, false after, false for rejected or another patient', async () => {
    const q = await seed({ status: 'accepted' });
    expect(await inv.isInvoicePending({ userId: OWNER, requestId: 4672 }, deps())).toEqual({ quotationId: q.id });
    expect(await inv.isInvoicePending({ userId: STRANGER, requestId: 4672 }, deps())).toBeNull();
    await ensure(q);
    expect(await inv.isInvoicePending({ userId: OWNER, requestId: 4672 }, deps())).toBeNull();
  });
  test('isInvoicePending is false when the live quotation was rejected', async () => {
    await seed({ status: 'rejected' });
    expect(await inv.isInvoicePending({ userId: OWNER, requestId: 4672 }, deps())).toBeNull();
  });
});
