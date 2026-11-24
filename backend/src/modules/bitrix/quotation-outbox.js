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

// The quotation fields of a profile as { FILE, AMOUNT, CURRENCY }, or null when they are missing or not usable. FILE must be a UF_CRM_ file
// field; AMOUNT and CURRENCY are each a UF_CRM_ user field or the standard Deal field (OPPORTUNITY / CURRENCY_ID); the three must differ. Anything
// else gives null, and the callers refuse (fail closed): no other profile's fields are ever substituted.
const UF_CODE = /^UF_CRM_[A-Za-z0-9_]{1,60}$/;
function quotationFieldsOf(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const { FILE, AMOUNT, CURRENCY } = fields;
  if (typeof FILE !== 'string' || !UF_CODE.test(FILE)) return null;
  if (typeof AMOUNT !== 'string' || !(UF_CODE.test(AMOUNT) || AMOUNT === 'OPPORTUNITY')) return null;
  if (typeof CURRENCY !== 'string' || !(UF_CODE.test(CURRENCY) || CURRENCY === 'CURRENCY_ID')) return null;
  if (new Set([FILE, AMOUNT, CURRENCY]).size !== 3) return null;
  return { FILE, AMOUNT, CURRENCY };
}
const NO_FILE = 'none';

const FILE_ID = /^[1-9]\d{0,17}$/;

// The quotation fields a profile may use, or null (fail closed). On top of quotationFieldsOf: the Quotation PDF must be a SINGLE-file field, and a
// profile other than the test pipeline (whose single-file field was verified earlier and is left exactly as it was) must SAY so with
// `quotationFileMultiple: false`. Missing, true or any other value is refused, so multiplicity is never assumed.
function quotationFieldsForProfile(profile) {
  const fields = quotationFieldsOf(profile && profile.quotationFields);
  if (!fields) return null;
  if (profile.name !== 'test' && profile.quotationFileMultiple !== false) return null;
  if (profile.name === 'test' && profile.quotationFileMultiple !== undefined && profile.quotationFileMultiple !== false) return null;
  return fields;
}

/** { fileId: '65834' | 'none' | 'invalid', amountRaw, currencyRaw } from a Deal as crm.deal.get returns it. A single-file field is ONE object
 *  ({ id, ... }) or empty; a list with any file in it (what a multiple field returns) is 'invalid', never read as one file. */
function readQuotationSignature(deal, fields = QUOTATION_FIELD) {
  const value = deal ? deal[fields.FILE] : undefined;
  let fileId;
  if (value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0)) fileId = NO_FILE;
  else if (typeof value === 'object' && !Array.isArray(value) && FILE_ID.test(String(value.id))) fileId = String(value.id);
  else if ((typeof value === 'string' || typeof value === 'number') && FILE_ID.test(String(value))) fileId = String(value);
  else fileId = 'invalid';
  return { fileId, amountRaw: rawText(deal && deal[fields.AMOUNT], 64), currencyRaw: rawText(deal && deal[fields.CURRENCY], 32) };
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
 * reasons: queued | deal_closed | unchanged | file_unreadable | already_queued | quotation_not_configured
 * `profile` (a profile object of bitrix-profiles.js) selects the pipeline's quotation fields and closed stages and is stamped on the event; a profile
 * whose quotation fields are not configured queues nothing (fail closed). With no profile it is the test pipeline, exactly as before.
 */
async function detectAndEnqueueQuotationSync(db, caseRecord, deal, profile = null) {
  const fields = profile ? quotationFieldsForProfile(profile) : QUOTATION_FIELD;
  if (!fields) return { queued: false, reason: 'quotation_not_configured' };
  const closed = profile ? new Set(profile.closedStageIds) : CLOSED_STAGES;
  if (closed.has(deal && deal.STAGE_ID)) return { queued: false, reason: 'deal_closed' };
  const signature = readQuotationSignature(deal, fields);
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
        payload: { caseId: caseRecord.id, dealId: String(deal.ID), fileId: signature.fileId, ...(profile ? { profile: profile.name } : {}) }, // identifiers only
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
  QUOTATION_SYNC_EVENT, QUOTATION_ENTITY_TYPE, QUOTATION_FIELD, CLOSED_STAGES, NO_FILE, quotationFieldsOf, quotationFieldsForProfile,
  readQuotationSignature, sameAsHead, quotationSyncKey, detectAndEnqueueQuotationSync,
};
