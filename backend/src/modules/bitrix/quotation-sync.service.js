// The Bitrix24 -> HumanCare quotation synchronization worker. It delivers "bitrix.quotation.sync" outbox events (queued by
// quotation-outbox.js when the Deal's Quotation PDF, amount or currency differ from what is stored).
//
// WHAT IT DOES, per event: re-read the Deal (never trusting the event), verify it is this Case's Deal, read the Quotation PDF,
// download it with the existing safe helper (https, pinned portal host, no redirects, 10 MB, PDF structure check), store it in
// the local uploads folder under a unique non-public key, and record it in case_quotations as a DRAFT with scan_status "pending".
//
// WHAT IT NEVER DOES: write to Bitrix24 (it calls getDeal, getDealFileField and downloadBitrixFile only); confirm, publish or
// accept a quotation; create an invoice or a payment; notify a patient; touch a version that is published, accepted or
// rejected; delete a stored file that a version refers to.
//
// VERSIONING (quotation-versioning.js, decided under the Case row lock with the head version re-read inside the transaction):
//   no version yet -> draft v1 | head unpublished (draft/confirmed) and changed -> that version is updated in place
//   head published/accepted/rejected/withdrawn/superseded and changed -> a NEW draft version | identical content -> nothing.
//
// RETRIES: a read or storage problem that may pass is retried with a growing delay, up to MAX_ATTEMPTS, then the event fails with an
// audit row and an [ALERT] line. A definitive problem (not a PDF, too large, the Deal is not this Case's) fails at once. A corrected
// upload in Bitrix is a different observation and so a new event. Everything is idempotent: the event is unique, the file key is
// derived from the event, a version is unique per (Case, number), and the whole result is one transaction.
const os = require('os');
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { isQuotationSyncActive } = require('./bitrix-config');
const { assertDealEligible } = require('./deal-outbox');
const { DEAL, FIELD } = require('./bitrix-deal');
const bitrixDealApi = require('./bitrix-deal.api');
const defaultStore = require('./quotation-sync.store');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { parseQuotationMoney } = require('./quotation-money');
const { contentFingerprint, decideVersion } = require('./quotation-versioning');
const { readQuotationSignature, sameAsHead, QUOTATION_FIELD, CLOSED_STAGES, NO_FILE } = require('./quotation-outbox');
const { createLocalStorage, keyFor } = require('./quotation-storage');

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const MAX_CLAIMS_RECOVERY = 10;
const BATCH_SIZE = 5;
const LAST_SEEN_THROTTLE_MS = 10 * 60 * 1000;
const CLOSED_CASE_STATUSES = new Set(['completed', 'cancelled']);
const retryDelay = (attempts) => Math.min(60 * attempts, 900);

class LeaseLostError extends Error {
  constructor() { super('The event lease was lost; nothing was written.'); this.name = 'LeaseLostError'; }
}
class ConcurrentChangeError extends Error {
  constructor() { super('The quotation changed during processing; nothing was written.'); this.name = 'ConcurrentChangeError'; }
}

const makeWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);

function buildContext(overrides = {}) {
  return {
    prisma: defaultPrisma, store: defaultStore, api: bitrixDealApi, env: process.env, log: console, storage: null,
    workerId: makeWorkerId(), now: () => new Date(), ...overrides,
  };
}
const storageOf = (ctx) => ctx.storage || (ctx.storage = createLocalStorage());

// ---- audit ---------------------------------------------------------------------------------------------------------------
const base = (claim, caseRecord) => ({ caseId: caseRecord ? caseRecord.id : claim.caseId, actorType: 'bitrix', source: 'bitrix_quotation', correlationId: `outbox:${claim.id}` });
function quotationAudit(action, claim, caseRecord, row, extra = {}) {
  return {
    ...base(claim, caseRecord), entityType: 'case_quotation', entityId: row.id, action, reasonCode: extra.reasonCode || null,
    afterData: {
      quotationId: row.id, versionNumber: row.versionNumber, bitrixFileId: row.bitrixFileId, bitrixDealId: claim.dealId, status: row.status,
      scanStatus: row.scanStatus, sizeBytes: row.sizeBytes, validationError: row.validationError ?? null,
      ...(caseRecord ? { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber } : {}), eventId: claim.id, ...(extra.after || {}),
    },
    ...(extra.before ? { beforeData: extra.before } : {}),
    idempotencyKey: `${action}:event:${claim.id}`,
  };
}
function eventAudit(action, claim, caseRecord, code) {
  return {
    ...base(claim, caseRecord), entityType: 'integration_outbox', entityId: claim.id, action, reasonCode: `code:${String(code).toLowerCase().replace(/[^a-z0-9_.:-]/g, '_').slice(0, 56)}`,
    afterData: { eventId: claim.id, bitrixDealId: claim.dealId, ...(caseRecord ? { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber } : {}) },
    idempotencyKey: `${action}:event:${claim.id}`,
  };
}

// ---- results that write no version ----------------------------------------------------------------------------------------
async function finish(ctx, claim, { status, code = null, delaySeconds = 0, audit = null, outcome }) {
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const written = await ctx.store.writeResult(tx, claim, { status, lastError: code, delaySeconds });
      if (written !== 1) throw new LeaseLostError();
      if (audit) await appendAuditLog(tx, audit);
    });
    return { outcome, code };
  } catch (err) {
    if (err instanceof LeaseLostError) { ctx.log.warn(`[quotation-sync] event ${claim.id}: lease lost, result not recorded.`); return { outcome: 'lease_lost' }; }
    throw err;
  }
}
const complete = (ctx, claim, outcome, code = null, audit = null) => finish(ctx, claim, { status: 'completed', code, audit, outcome });

async function failDefinitively(ctx, claim, code, caseRecord = null) {
  ctx.log.error(`[ALERT] Bitrix24 quotation sync event ${claim.id} (deal ${claim.dealId}) failed: ${code}`);
  return finish(ctx, claim, { status: 'failed', code, audit: eventAudit('quotation.sync_failed', claim, caseRecord, code), outcome: 'failed' });
}
async function retryLater(ctx, claim, code, caseRecord = null) {
  if (claim.attempts >= MAX_ATTEMPTS) {
    ctx.log.error(`[ALERT] Bitrix24 quotation sync event ${claim.id} (deal ${claim.dealId}) failed after ${claim.attempts} attempts: ${code}`);
    return finish(ctx, claim, { status: 'failed', code, audit: eventAudit('quotation.sync_failed', claim, caseRecord, code), outcome: 'failed' });
  }
  return finish(ctx, claim, { status: 'pending', code, delaySeconds: retryDelay(claim.attempts), outcome: 'retry' });
}

// ---- the version write ----------------------------------------------------------------------------------------------------
async function writeVersion(ctx, claim, link, caseRecord, content) {
  let stagedUnused = false;
  const result = await ctx.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM cases WHERE id = ${caseRecord.id} FOR UPDATE`; // serialises every quotation writer of this Case
    const written = await ctx.store.writeResult(tx, claim, { status: 'completed', lastError: null });
    if (written !== 1) throw new LeaseLostError();
    const head = await tx.caseQuotation.findFirst({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } });
    const decision = decideVersion(head, content.fingerprint);

    if (decision.action === 'unchanged') {
      stagedUnused = true; // somebody (an earlier event) already stored this exact content
      const seen = head.lastSeenAt ? ctx.now().getTime() - new Date(head.lastSeenAt).getTime() : Infinity;
      if (seen > LAST_SEEN_THROTTLE_MS) await tx.caseQuotation.updateMany({ where: { id: head.id, revision: head.revision }, data: { lastSeenAt: ctx.now() } });
      return { outcome: 'unchanged' };
    }
    const fields = {
      bitrixDealId: claim.dealId, bitrixFileId: content.fileId, bitrixAmountRaw: content.money.amountRaw, bitrixCurrencyRaw: content.money.currencyRaw,
      bitrixDealStageId: content.stageId, contentFingerprint: content.fingerprint, storageProvider: 'local', storageKey: content.storageKey,
      sizeBytes: content.sizeBytes, sha256: content.sha256, amount: content.money.amount, currency: content.money.currency,
      validationError: content.money.error, lastSeenAt: ctx.now(),
    };
    if (decision.action === 'create') {
      const row = await tx.caseQuotation.create({
        data: { caseId: caseRecord.id, dealLinkId: link.id, versionNumber: decision.versionNumber, ...fields, status: 'draft', workingSlot: 1, scanStatus: 'pending', revision: 0 },
      });
      await appendAuditLog(tx, quotationAudit('quotation.version_created', claim, caseRecord, row, { reasonCode: head ? 'content_changed_after_head' : 'first_upload', after: head ? { previousQuotationId: head.id } : {} }));
      return { outcome: 'created', quotationId: row.id, versionNumber: row.versionNumber };
    }
    // update_working: the unpublished working version takes the new content; a confirmed one returns to draft.
    const { count } = await tx.caseQuotation.updateMany({
      where: { id: head.id, revision: head.revision, status: { in: ['draft', 'confirmed'] } },
      data: {
        ...fields, status: 'draft', workingSlot: 1, confirmedByAdminId: null, confirmedAt: null,
        scanStatus: 'pending', scanEngine: null, scanDetail: null, scannedAt: null, scanAttempts: 0, scanNextAttemptAt: null, revision: { increment: 1 },
      },
    });
    if (count !== 1) throw new ConcurrentChangeError();
    const row = { ...head, ...fields, status: 'draft', scanStatus: 'pending', revision: head.revision + 1 };
    await appendAuditLog(tx, quotationAudit('quotation.working_version_updated', claim, caseRecord, row, {
      reasonCode: head.status === 'confirmed' ? 'confirmed_returned_to_draft' : 'content_changed_before_publication',
      before: { status: head.status, bitrixFileId: head.bitrixFileId, sizeBytes: head.sizeBytes },
    }));
    return { outcome: 'updated', quotationId: head.id, versionNumber: head.versionNumber };
  });

  // A staged file that no version refers to (an identical version already existed) is removed; one that is referenced is never touched.
  if (stagedUnused) {
    const referenced = await ctx.prisma.caseQuotation.findUnique({ where: { storageKey: content.storageKey }, select: { id: true } });
    if (!referenced) await storageOf(ctx).remove(content.storageKey).catch(() => undefined);
  }
  return result;
}

// ---- one event ------------------------------------------------------------------------------------------------------------
async function processQuotationEvent(ctx, claim) {
  const link = await ctx.prisma.bitrixDealLink.findUnique({ where: { caseId: claim.caseId }, include: { case: { include: { serviceRequest: true } } } });
  if (!link || !link.bitrixDealId || link.bitrixDealId !== claim.dealId) return failDefinitively(ctx, claim, 'deal_not_linked');
  const caseRecord = link.case;
  try { assertDealEligible(caseRecord, caseRecord && caseRecord.serviceRequest); } catch { return failDefinitively(ctx, claim, 'case_not_eligible', caseRecord); }
  if (CLOSED_CASE_STATUSES.has(caseRecord.status)) return complete(ctx, claim, 'case_closed', 'case_closed');

  const read = await ctx.api.getDeal(claim.dealId, { env: ctx.env });
  if (read.status === 'not_found') return failDefinitively(ctx, claim, 'deal_not_found', caseRecord);
  if (read.status !== 'ok') return retryLater(ctx, claim, 'bitrix_read_failed', caseRecord);
  const deal = read.deal;
  if (String(deal.ID) !== claim.dealId) return failDefinitively(ctx, claim, 'deal_id_mismatch', caseRecord);
  if (String(deal.CATEGORY_ID) !== String(DEAL.CATEGORY_ID)) return failDefinitively(ctx, claim, 'category_mismatch', caseRecord);
  if (deal[FIELD.REFERENCE] !== caseRecord.referenceNumber) return failDefinitively(ctx, claim, 'reference_mismatch', caseRecord);
  if (CLOSED_STAGES.has(deal.STAGE_ID)) return complete(ctx, claim, 'deal_closed', 'deal_closed');

  const signature = readQuotationSignature(deal);
  if (signature.fileId === 'invalid') return retryLater(ctx, claim, 'file_field_unreadable', caseRecord);
  const head = await ctx.prisma.caseQuotation.findFirst({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } });

  if (signature.fileId === NO_FILE) {
    if (!head || head.bitrixFileId == null) return complete(ctx, claim, 'no_file', 'no_file');
    // The file was removed in Bitrix. Nothing is deleted or changed here; Operations are told, once.
    ctx.log.error(`[ALERT] Bitrix24 quotation file removed for case ${caseRecord.id} (deal ${claim.dealId}); the stored version is unchanged.`);
    return complete(ctx, claim, 'file_removed', 'file_removed', quotationAudit('quotation.file_removed_in_bitrix', claim, caseRecord, head, { reasonCode: 'file_empty_in_bitrix' }));
  }
  if (sameAsHead(signature, head)) return complete(ctx, claim, 'unchanged', 'unchanged');

  // Only now the file itself: the one extra read that carries the download link, then the download.
  const fileRead = await ctx.api.getDealFileField(claim.dealId, QUOTATION_FIELD.FILE, { env: ctx.env });
  if (fileRead.status === 'not_found') return failDefinitively(ctx, claim, 'deal_not_found', caseRecord);
  if (fileRead.status !== 'ok') return retryLater(ctx, claim, 'bitrix_file_read_failed', caseRecord);
  if (!fileRead.file || fileRead.file.id !== signature.fileId) return retryLater(ctx, claim, 'file_changed_during_read', caseRecord);

  let download;
  try {
    download = await ctx.api.downloadBitrixFile(fileRead.file, { env: ctx.env });
  } catch (err) {
    const code = err && err.code ? `download_${String(err.code).slice(0, 40)}` : 'download_error';
    return err && err.outcome === 'definitive' ? failDefinitively(ctx, claim, code, caseRecord) : retryLater(ctx, claim, code, caseRecord);
  }

  const money = parseQuotationMoney(signature.amountRaw, signature.currencyRaw);
  const fingerprint = contentFingerprint({ pdfSha256: download.sha256, amount: money.amount, currency: money.currency, amountRaw: money.amountRaw, currencyRaw: money.currencyRaw });
  const storageKey = keyFor(caseRecord.id, claim.id, download.sha256);
  const content = { fileId: signature.fileId, money, fingerprint, storageKey, sizeBytes: download.byteCount, sha256: download.sha256, stageId: typeof deal.STAGE_ID === 'string' ? deal.STAGE_ID.slice(0, 64) : null };

  // The identical content may already be the head (the same PDF uploaded again): nothing to store.
  const latest = await ctx.prisma.caseQuotation.findFirst({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } });
  if (latest && decideVersion(latest, fingerprint).action === 'unchanged') return complete(ctx, claim, 'unchanged', 'unchanged_content');

  try {
    await storageOf(ctx).putIfAbsent(storageKey, download.bytes, download.sha256);
  } catch (err) {
    const permanent = err && ['key_invalid', 'conflict', 'hash_mismatch', 'empty_file'].includes(err.code);
    return permanent ? failDefinitively(ctx, claim, `storage_${err.code}`, caseRecord) : retryLater(ctx, claim, `storage_${(err && err.code) || 'error'}`, caseRecord);
  }

  try {
    return await writeVersion(ctx, claim, link, caseRecord, content);
  } catch (err) {
    if (err instanceof LeaseLostError) { ctx.log.warn(`[quotation-sync] event ${claim.id}: lease lost, result not recorded.`); return { outcome: 'lease_lost' }; }
    if (err instanceof ConcurrentChangeError) return retryLater(ctx, claim, 'concurrent_change', caseRecord);
    throw err;
  }
}

// One pass. Does nothing at all unless the quotation switch AND both Bitrix switches AND the review workflow are on.
async function runQuotationSync(overrides = {}) {
  const ctx = buildContext(overrides);
  if (!isQuotationSyncActive(ctx.env)) return { active: false, claimed: 0 };
  const scope = ctx.scope;
  await ctx.store.recoverExpiredLeases(ctx.prisma, { maxClaims: MAX_CLAIMS_RECOVERY, ...(scope && { caseIds: scope.caseIds }) });
  let claimed = 0;
  const results = [];
  for (const id of await ctx.store.findCandidateIds(ctx.prisma, BATCH_SIZE, scope)) {
    const claim = await ctx.store.claim(ctx.prisma, { id, workerId: ctx.workerId, leaseSeconds: LEASE_SECONDS });
    if (!claim) continue;
    claimed += 1;
    try {
      results.push({ eventId: id, ...(await processQuotationEvent(ctx, claim)) });
    } catch (err) {
      // Rolled back or unknown: nothing partial exists. The lease expires and recovery retries the event.
      ctx.log.error(`[quotation-sync] event ${claim.id}: ${err && err.name ? err.name : 'error'}; left for lease recovery.`);
    }
  }
  return { active: true, claimed, results };
}

module.exports = { runQuotationSync, processQuotationEvent, LeaseLostError, ConcurrentChangeError, LEASE_SECONDS, MAX_ATTEMPTS, BATCH_SIZE, retryDelay };
