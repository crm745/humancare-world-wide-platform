// The logic of the TEST-ONLY seed that makes ONE Private Charter request payable: one accepted quotation and one issued invoice that matches it, on a
// Case that already exists. The script around it (scripts/e2e-seed-payable-invoice.js) applies every safety guard BEFORE this runs; this file refuses on
// its own as well, and never touches anything but the rows listed below.
//
// What it writes (all marked SEED_<runid> in a text column, all in one transaction with the Case row locked):
//   an admin user        a synthetic one, only because a published quotation must name who confirmed and published it
//   a Deal link          ONLY if the Case has none. Created as "synced" with a clearly synthetic Deal id, so no Bitrix worker would try to create a Deal
//   a quotation          version = highest existing + 1, accepted and live, with the amount and currency given
//   an invoice           issued, source "quotation", linked to that quotation (the database enforces that Case, currency and amount match)
// It never changes an existing row: not the request, the Case, an existing link or a patient. It refuses when the Case already has a live quotation,
// is closed or cancelled, or is not a Private Charter Case of the named patient.
const crypto = require('crypto');
const { PRIVATE_CHARTER_KEY } = require('../../src/common/constants/request.constants');
const { ORDER_CURRENCIES, parseRequestAmount, formatAmount } = require('../../src/modules/payments/payment-money');

class SeedRefused extends Error {
  constructor(code) { super(code); this.name = 'SeedRefused'; this.code = code; }
}
const refuse = (code) => new SeedRefused(code);

const POSITIVE_INT = /^[1-9]\d{0,9}$/;

// --request-id N --user-id N [--amount 1500.00] [--currency INR] [--due-days N] [--allow-partial] [--execute]
// Without --execute nothing is written. Both ids are required: the user id is the proof that the request is that patient's.
function parseArgs(argv) {
  const out = { requestId: null, userId: null, amount: '1500.00', currency: 'INR', dueDays: null, allowPartial: false, execute: false };
  const list = [...argv];
  const take = (name) => {
    const value = list.shift();
    if (value === undefined || value.startsWith('--')) throw refuse(`missing_value_for_${name}`);
    return value;
  };
  while (list.length) {
    const flag = list.shift();
    if (flag === '--request-id') { const v = take(flag); if (!POSITIVE_INT.test(v)) throw refuse('request_id_invalid'); out.requestId = Number(v); }
    else if (flag === '--user-id') { const v = take(flag); if (!POSITIVE_INT.test(v)) throw refuse('user_id_invalid'); out.userId = Number(v); }
    else if (flag === '--amount') out.amount = take(flag);
    else if (flag === '--currency') out.currency = take(flag);
    else if (flag === '--due-days') { const v = take(flag); if (!/^\d{1,3}$/.test(v) || Number(v) < 1) throw refuse('due_days_invalid'); out.dueDays = Number(v); }
    else if (flag === '--allow-partial') out.allowPartial = true;
    else if (flag === '--execute') out.execute = true;
    else throw refuse('unknown_argument');
  }
  if (out.requestId === null) throw refuse('request_id_required');
  if (out.userId === null) throw refuse('user_id_required');
  if (!ORDER_CURRENCIES.has(out.currency)) throw refuse('currency_unsupported');
  const thousandths = parseRequestAmount(out.amount, out.currency);
  if (thousandths === null) throw refuse('amount_invalid');
  out.amountThousandths = thousandths;
  out.amountText = formatAmount(thousandths, out.currency);
  return out;
}

// Reads only. Resolves the facts the seed needs, or throws SeedRefused with a short code.
async function plan(db, options) {
  const request = await db.serviceRequest.findFirst({
    where: { id: options.requestId, userId: options.userId },
    select: { id: true, userId: true, serviceKey: true, case: { select: { id: true, status: true, closedAt: true } } },
  });
  if (!request) throw refuse('request_not_found_for_this_patient');
  if (request.serviceKey !== PRIVATE_CHARTER_KEY) throw refuse('not_a_private_charter_request');
  if (!request.case) throw refuse('request_has_no_case');
  if (request.case.closedAt || request.case.status === 'cancelled') throw refuse('case_closed');
  const live = await db.caseQuotation.findFirst({ where: { caseId: request.case.id, liveSlot: { not: null } }, select: { id: true } });
  if (live) throw refuse('case_already_has_a_live_quotation');
  const link = await db.bitrixDealLink.findUnique({ where: { caseId: request.case.id }, select: { id: true, bitrixDealId: true } });
  const head = await db.caseQuotation.findFirst({ where: { caseId: request.case.id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true } });
  return { requestId: request.id, caseId: request.case.id, linkId: link ? link.id : null, versionNumber: (head ? head.versionNumber : 0) + 1 };
}

/**
 * Dry run unless options.execute. Resolves { executed, plan, created? } where created is { adminId, linkId, quotationId, invoiceId, marker }.
 * `db` is the Prisma client. Nothing is written without options.execute.
 */
async function runSeed(db, options, { now = () => new Date(), marker: givenMarker } = {}) {
  const first = await plan(db, options);
  if (!options.execute) return { executed: false, plan: first };

  // `marker` can be given only by a test (so its own cleanup recognises the rows); the script never passes one.
  const marker = givenMarker || `SEED_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const created = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM cases WHERE id = ${first.caseId} FOR UPDATE`; // serialises concurrent seeds and quotation writers on this Case
    const again = await plan(tx, options); // every refusal is re-checked under the lock
    const at = now();

    const admin = await tx.adminUser.create({ data: { name: `${marker}_ADMIN`, email: `${marker}@example.invalid` } });
    let linkId = again.linkId;
    if (linkId === null) {
      const link = await tx.bitrixDealLink.create({ data: { caseId: again.caseId, bitrixDealId: marker.slice(0, 32), syncStatus: 'synced' } });
      linkId = link.id;
    }
    const fingerprint = crypto.createHash('sha256').update(`${marker}|${options.amountText}|${options.currency}`).digest('hex');
    const quotation = await tx.caseQuotation.create({
      data: {
        caseId: again.caseId, dealLinkId: linkId, bitrixDealId: marker.slice(0, 32), versionNumber: again.versionNumber, bitrixFileId: 'F1',
        contentFingerprint: fingerprint, storageKey: `${marker}_KEY`, sizeBytes: 100, sha256: crypto.createHash('sha256').update(marker).digest('hex'),
        scanStatus: 'clean', amount: options.amountText, currency: options.currency, status: 'accepted', liveSlot: 1,
        confirmedByAdminId: admin.id, confirmedAt: new Date(at.getTime() - 3000), publishedByAdminId: admin.id, publishedAt: new Date(at.getTime() - 2000),
        decidedByUserId: options.userId, decidedAt: new Date(at.getTime() - 1000),
      },
    });
    const due = options.dueDays ? new Date(at.getTime() + options.dueDays * 86400000) : null;
    const invoice = await tx.invoice.create({
      data: {
        caseId: again.caseId, source: 'quotation', quotationId: quotation.id, amount: options.amountText, currency: options.currency, status: 'issued',
        issueDate: at, dueDate: due, idempotencyKey: `${marker}_INV`, allowPartialPayment: options.allowPartial,
        ...(options.allowPartial && { partialPaymentAuthorizedByAdminId: admin.id, partialPaymentAuthorizedAt: at }),
      },
    });
    return { adminId: admin.id, linkId, quotationId: quotation.id, invoiceId: invoice.id, marker };
  });
  return { executed: true, plan: first, created };
}

module.exports = { parseArgs, plan, runSeed, SeedRefused };
