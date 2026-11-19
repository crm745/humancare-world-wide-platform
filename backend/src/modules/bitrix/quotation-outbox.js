// The detection half of the quotation synchronization: given a Deal that was ALREADY read (by the inbound processor), decide
// whether the Quotation PDF, amount or currency differ from what HumanCare last stored, and if so record ONE durable
// "bitrix.quotation.sync" outbox event. Nothing here calls Bitrix24, reads a file or writes a quotation.
//
// ENTITY TYPE: "bitrix_deal_quotation" (entity id = the Deal id). The Deal worker's claim blocks a Deal event behind any earlier
// unfinished event of the same entity type and id; a separate entity type means quotation work never blocks, and is never blocked by,
// Deal creation or document sharing.
//
// IDEMPOTENCY: one unique key per (Case, head version, file id, hash of the raw amount and currency). The same observation can be
// queued only once, however many webhooks and reconciliation passes report it. The head version is part of the key so that going
// back to an earlier value (A, then B, then A again) is a new event, not a refused duplicate.
const crypto = require('crypto');
const { rawText } = require('./quotation-money');

const QUOTATION_SYNC_EVENT = 'bitrix.quotation.sync';
const QUOTATION_ENTITY_TYPE = 'bitrix_deal_quotation';
// Verified Deal field codes (Quotation PDF - single file; Final Quotation Amount; Final Quotation Currency).
const QUOTATION_FIELD = Object.freeze({ FILE: 'UF_CRM_1794985313', AMOUNT: 'UF_CRM_6A3399F56ECFF', CURRENCY: 'UF_CRM_6A23F4E86AA45' });
// A Deal in these Category 38 stages is finished: no quotation work is queued for it.
const CLOSED_STAGES = new Set(['C38:WON', 'C38:LOSE']);
const NO_FILE = 'none';

const FILE_ID = /^[1-9]\d{0,17}$/;

/** { fileId: '65834' | 'none' | 'invalid', amountRaw, currencyRaw } from a Deal as crm.deal.get returns it. */
function readQuotationSignature(deal) {
  const value = deal ? deal[QUOTATION_FIELD.FILE] : undefined;
  let fileId;
  if (value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0)) fileId = NO_FILE;
  else if (typeof value === 'object' && !Array.isArray(value) && FILE_ID.test(String(value.id))) fileId = String(value.id);
  else if ((typeof value === 'string' || typeof value === 'number') && FILE_ID.test(String(value))) fileId = String(value);
  else fileId = 'invalid';
  return { fileId, amountRaw: rawText(deal && deal[QUOTATION_FIELD.AMOUNT], 64), currencyRaw: rawText(deal && deal[QUOTATION_FIELD.CURRENCY], 32) };
}

// Does the head version already record exactly this observation?
function sameAsHead(signature, head) {
  if (!head) return signature.fileId === NO_FILE; // no quotation yet and no file: nothing to do
  return (signature.fileId === NO_FILE ? head.bitrixFileId == null : head.bitrixFileId === signature.fileId)
    && (head.bitrixAmountRaw ?? null) === signature.amountRaw && (head.bitrixCurrencyRaw ?? null) === signature.currencyRaw;
}

const moneyDigest = (s) => crypto.createHash('sha256').update(`${s.amountRaw ?? ''}|${s.currencyRaw ?? ''}`).digest('hex').slice(0, 16);

const quotationSyncKey = (caseId, headVersion, signature) => `bitrix.quotation.sync:case:${caseId}:v${headVersion}:${signature.fileId}:${moneyDigest(signature)}`;

/**
 * -> { queued: boolean, reason }. `db` is the Prisma client (or a transaction). Safe to call any number of times.
 * reasons: queued | deal_closed | unchanged | file_unreadable | already_queued
 */
async function detectAndEnqueueQuotationSync(db, caseRecord, deal) {
  if (CLOSED_STAGES.has(deal && deal.STAGE_ID)) return { queued: false, reason: 'deal_closed' };
  const signature = readQuotationSignature(deal);
  if (signature.fileId === 'invalid') return { queued: false, reason: 'file_unreadable' };
  const head = await db.caseQuotation.findFirst({
    where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' },
    select: { id: true, versionNumber: true, bitrixFileId: true, bitrixAmountRaw: true, bitrixCurrencyRaw: true },
  });
  if (sameAsHead(signature, head)) return { queued: false, reason: 'unchanged' };
  try {
    await db.integrationOutbox.create({
      data: {
        eventType: QUOTATION_SYNC_EVENT, entityType: QUOTATION_ENTITY_TYPE, entityId: String(deal.ID), caseId: caseRecord.id,
        idempotencyKey: quotationSyncKey(caseRecord.id, head ? head.versionNumber : 0, signature),
        payload: { caseId: caseRecord.id, dealId: String(deal.ID), fileId: signature.fileId }, // identifiers only
        status: 'pending', nextAttemptAt: new Date(),
      },
    });
    return { queued: true, reason: 'queued' };
  } catch (err) {
    if (err && err.code === 'P2002') return { queued: false, reason: 'already_queued' };
    throw err;
  }
}

module.exports = {
  QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE, QUOTATION_FIELD, CLOSED_STAGES, NO_FILE,
  readQuotationSignature, sameAsHead, quotationSyncKey, detectAndEnqueueQuotationSync,
};
