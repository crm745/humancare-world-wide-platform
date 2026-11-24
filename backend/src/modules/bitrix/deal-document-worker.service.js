// The Bitrix24 Deal DOCUMENT worker: attaches Admin-authorized HumanCare documents, as ORIGINAL FILES, to the existing Deal's
// multiple file field (UF_CRM_1794832401), and removes them again when an Admin revokes the share. Same architecture as the Deal
// worker (deal-worker.service.js): outbox events, a lease and a fence on every result, evidence written BEFORE a call, and an
// ambiguous outcome is reconciled by READING the Deal, never repeated blindly. Bitrix is never called inside a transaction.
//
// SWITCHES: idle (no recovery, no claim, no call) unless BITRIX_SYNC_ENABLED, BITRIX_PRIVATE_CHARTER_DEAL_ENABLED and
// PRIVATE_CHARTER_REVIEW_WORKFLOW are all exactly "true" (the same rule as the Deal worker).
//
// PRESERVING EXISTING FILES. Bitrix replaces the field's whole list on every update. So every update is built from a fresh READ of
// the Deal's files: attach = all existing ids + the new file; remove = all existing ids except ours. Files added by Operations are
// therefore kept. A per-Deal lease serializes these read-modify-write cycles, and after every update the Deal is read again.
// The adapter writes with crm.item.update (retained files as numeric { id }, the new file as [name, base64]); see bitrix-deal.api.js.
//
// UNKNOWN OR RENAMED FILE IDS ARE NEVER ADOPTED. After an update every file id from the read just before it must still be on the Deal and
// exactly one new id must have appeared; anything else (a prior id gone, so a "new" id may be a re-created old file) is MANUAL REVIEW,
// never "attached". The same rule holds when an uncertain attempt is reconciled. The only exception is a person's explicit confirmation
// (ctx.confirmedFileIds: { [shareId]: fileId }, set by a guarded one-shot script after the file was identified in Bitrix24).
//
// DUPLICATES. One share per (Deal, document, generation) is unique in the database. The Deal's file ids are recorded BEFORE an
// upload (file_ids_before); after a timeout the new file is found by comparing ids, so the same document is never uploaded twice
// for one outcome. The share's token is also part of the remote file name so people can tell the files apart.
//
// RETRIES. Each attempt is one event; an automatic retry is a NEW event (new key) with a delay from RETRY_DELAYS_SECONDS. After
// MAX_ATTEMPTS the share becomes "failed" / "revoke_failed", an AuditLog alert and an [ALERT] line are written and Operations
// is e-mailed (optional). An Admin can retry from the Admin API.
const os = require('os');
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { isPrivateCharterDealWorkerActive } = require('./bitrix-config');
const { gatewayForPass } = require('./queue/dispatcher');
const { PRIVATE_CHARTER_QUEUE } = require('./queue/service-registry');
const bitrixDealApi = require('./bitrix-deal.api');
const { profileForCategory, documentsConfig, TEST_PROFILE, PROFILE_TEST } = require('./bitrix-profiles');
const defaultStore = require('./deal-document.store');
const { makeNotifier } = require('./deal-document-notify');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { readVerifiedFile } = require('../request-review/request-review.files');
const { EXTENSION } = require('../documents/file-type');

const LEASE_SECONDS = 180; // well above three 15 s requests (read, update, read)
const MIN_LEASE_LEFT_BEFORE_CALL_SECONDS = bitrixDealApi.REQUEST_TIMEOUT_MS / 1000 * 2 + 30;
const FILE_LEASE_SECONDS = 150;
const MAX_CLAIMS_BEFORE_ANY_CALL = 10;
const BATCH_SIZE = 5;
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 4 * 60 * 60]; // after failed attempt 1, 2, 3, 4 (the 5th is final)
const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length;
const RECONCILE_FIRST_DELAY_SECONDS = 120;
const RECONCILE_INTERVAL_SECONDS = 10 * 60;
// An upload whose outcome is unknown is looked for until this long after the call; only then is it treated as "did not arrive".
const RECONCILE_WINDOW_SECONDS = 30 * 60;
const BUSY_DELAY_SECONDS = 15;
const WAIT_FOR_DEAL_DELAY_SECONDS = 120;
const WAIT_FOR_DEAL_MAX_MS = 24 * 60 * 60 * 1000;
const REMOTE_NAME_MAX = 150;

class LeaseLostError extends Error {
  constructor() { super('The event lease was lost; nothing was written.'); this.name = 'LeaseLostError'; }
}

const makeWorkerId = () => `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);

function buildContext(overrides = {}) {
  const ctx = {
    prisma: defaultPrisma, store: defaultStore, api: bitrixDealApi, env: process.env, log: console, readFile: readVerifiedFile,
    workerId: makeWorkerId(), now: () => Date.now(), ...overrides,
  };
  if (!ctx.notify) ctx.notify = makeNotifier({ env: ctx.env });
  return ctx;
}

// The remote file name: the share token, then the original name made safe, always ending with the extension of the REAL type, at
// most REMOTE_NAME_MAX characters.
function remoteFileName(share, originalName) {
  const extension = EXTENSION[share.detectedType] || '';
  const prefix = `${share.shareToken}__`;
  let base = String(originalName || 'document').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, ''); // the original extension is replaced by the real one
  base = base.slice(0, Math.max(1, REMOTE_NAME_MAX - prefix.length - extension.length)).replace(/[. ]+$/, '') || 'document';
  return `${prefix}${base}${extension}`;
}

// ---- recording results ----------------------------------------------------------------------------------------------------

const auditEntry = (action, share, caseRecord, claim, code, extra = {}) => ({
  caseId: caseRecord ? caseRecord.id : null, entityType: 'bitrix_deal_document', entityId: String(share.id), action,
  actorType: 'system', source: 'system', reasonCode: code,
  afterData: {
    ...(caseRecord ? { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber } : {}), shareId: share.id, requestDocumentId: share.requestDocumentId, ...extra,
  },
  correlationId: `outbox:${claim.id}`, idempotencyKey: `${action}:share:${share.id}:${claim.id}`,
});

async function record(ctx, claim, { eventStatus, lastError = null, delaySeconds = 0, share = null, nextEvent = null, audit = [] }) {
  try {
    await ctx.prisma.$transaction(async (tx) => {
      const written = await ctx.store.writeResult(tx, claim, { status: eventStatus, lastError, delaySeconds });
      if (written !== 1) throw new LeaseLostError();
      if (share) {
        let data = share.data;
        if (share.attachSide && data.status) {
          // An Admin may have revoked the share while this attach attempt was running: that decision is never overwritten.
          const current = await tx.bitrixDealDocument.findUnique({ where: { id: share.id }, select: { status: true } });
          if (current && (current.status === 'revoking' || current.status === 'revoked')) { const { status, ...rest } = data; data = rest; } // eslint-disable-line no-unused-vars
        }
        await tx.bitrixDealDocument.update({ where: { id: share.id }, data });
      }
      if (nextEvent) await tx.integrationOutbox.create({ data: nextEvent });
      for (const entry of audit) await appendAuditLog(tx, entry);
    });
    return true;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      ctx.log.warn(`[deal-document] event ${claim.id}: lease lost, result not recorded (recovery will handle it).`);
      return false;
    }
    throw err;
  }
}

// An alert for a person: written AFTER the result is committed (an e-mail failure can never undo or block it).
async function escalate(ctx, share, caseRecord, kind, code) {
  const reference = caseRecord ? caseRecord.referenceNumber : `share ${share.id}`;
  ctx.log.error(`[ALERT] Bitrix24 document ${kind} for ${reference} (share ${share.id}, document ${share.requestDocumentId}): ${code}`);
  try {
    await ctx.notify({
      subject: `HumanCare: Bitrix24 document ${kind} (${reference})`,
      text: `Share ${share.id} of document ${share.requestDocumentId} on Case ${reference}: ${kind} (${code}). Open the request in the Admin Portal for details.`,
    });
  } catch { /* an alert channel problem never affects the work */ }
}

const nextTryEvent = (ctx, share, kind, caseRecord, delaySeconds) => {
  const tryNumber = share.tryCount + 1;
  const eventType = kind === 'attach' ? ctx.store.ATTACH_EVENT : ctx.store.REMOVE_EVENT;
  return {
    eventType, entityType: ctx.store.ENTITY_TYPE, entityId: ctx.store.entityOf(share.id, kind, tryNumber), caseId: caseRecord.id,
    idempotencyKey: kind === 'attach' ? ctx.store.attachKey(share.id, tryNumber) : ctx.store.removeKey(share.id, tryNumber),
    payload: { shareId: share.id, caseId: caseRecord.id, tryNumber }, status: 'pending', nextAttemptAt: new Date(ctx.now() + delaySeconds * 1000),
  };
};

// A failed attempt: another automatic try after a delay, or - after MAX_ATTEMPTS - a final failure that needs a person.
async function retryOrFail(ctx, claim, share, caseRecord, kind, rawCode) {
  const text = String(rawCode || 'error');
  const code = text;
  const attempts = share.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return failFinally(ctx, claim, share, caseRecord, kind, code, attempts);
  const delay = RETRY_DELAYS_SECONDS[attempts - 1];
  return record(ctx, claim, {
    eventStatus: 'completed', lastError: text,
    share: { id: share.id, attachSide: kind === 'attach', data: { attempts, tryCount: share.tryCount + 1, lastError: text.slice(0, 500), status: kind === 'attach' ? 'authorized' : 'revoking' } },
    nextEvent: nextTryEvent(ctx, share, kind, caseRecord, delay),
  });
}

// A final failure. kind: "attach" | "remove". Needs a person: AuditLog alert, [ALERT] line, optional e-mail, Admin API status.
async function failFinally(ctx, claim, share, caseRecord, kind, rawCode, attempts = share.attempts + 1) {
  const code = String(rawCode || 'error');
  const status = kind === 'attach' ? 'failed' : 'revoke_failed';
  const ok = await record(ctx, claim, {
    eventStatus: 'failed', lastError: code,
    share: { id: share.id, attachSide: kind === 'attach', data: { status, attempts, lastError: code.slice(0, 500) } },
    audit: [auditEntry('bitrix.deal.document.failed', share, caseRecord, claim, `${kind}:${code}`.slice(0, 64), { status })],
  });
  if (ok) await escalate(ctx, share, caseRecord, kind === 'attach' ? 'attachment failed' : 'removal failed', code);
  return ok;
}

// An outcome only a person can settle (for example several new files appeared: Operations may have added one at the same moment).
// The event stays "ambiguous" with the manual-review marker, so the worker never offers it again.
async function manualReview(ctx, claim, share, caseRecord, kind, reason) {
  const text = `${ctx.store.MANUAL_REVIEW_PREFIX}:${reason}`;
  const ok = await record(ctx, claim, {
    eventStatus: 'ambiguous', lastError: text, delaySeconds: RECONCILE_INTERVAL_SECONDS,
    share: { id: share.id, attachSide: kind === 'attach', data: { status: 'ambiguous', lastError: text.slice(0, 500) } },
    audit: [auditEntry('bitrix.deal.document.manual_review_required', share, caseRecord, claim, `review:${reason}`.slice(0, 64), { status: 'ambiguous' })],
  });
  if (ok) await escalate(ctx, share, caseRecord, `${kind} needs manual review`, reason);
  return ok;
}

const completeNoop = (ctx, claim, code) => record(ctx, claim, { eventStatus: 'completed', lastError: code });

const reschedule = (ctx, claim, code, delaySeconds) => record(ctx, claim, { eventStatus: 'pending', lastError: code, delaySeconds });

const reconcileLater = (ctx, claim, share, code, delaySeconds) => record(ctx, claim, {
  eventStatus: 'ambiguous', lastError: code, delaySeconds,
  share: { id: share.id, attachSide: share.status !== 'revoking', data: { status: share.status === 'revoking' ? 'revoking' : 'ambiguous', lastError: code.slice(0, 500) } },
});

async function markAttached(ctx, claim, share, caseRecord, fileId, adopted, extraAudit = []) {
  return record(ctx, claim, {
    eventStatus: 'completed', lastError: null,
    share: { id: share.id, attachSide: true, data: { status: 'attached', bitrixFileId: fileId, attachedAt: new Date(ctx.now()), attempts: 0, lastError: null } },
    // `adopted` is false (a normal attach), true (adopted after an uncertain attempt) or a specific reason code (a person's confirmation).
    audit: [auditEntry('bitrix.deal.document.attached', share, caseRecord, claim, typeof adopted === 'string' ? adopted : adopted ? 'adopted_after_uncertain_attempt' : 'attached', { status: 'attached', bitrixFileId: fileId }), ...extraAudit],
  });
}

async function markRevoked(ctx, claim, share, caseRecord, code) {
  const ok = await record(ctx, claim, {
    eventStatus: 'completed', lastError: null,
    share: { id: share.id, data: { status: 'revoked', revokedAt: new Date(ctx.now()), lastError: null } },
    audit: [auditEntry('bitrix.deal.document.revoked', share, caseRecord, claim, code, { status: 'revoked' })],
  });
  // Operations is told when a document that was shared with the Deal has been removed from it.
  if (ok && share.bitrixFileId) await escalate(ctx, share, caseRecord, 'document removed from the Deal', code);
  return ok;
}

// Bitrix refusals worth retrying: a rate limit or a temporary condition. Everything else (a missing field, no permission, a bad
// payload) is a configuration problem that more attempts cannot fix.
const isRetryable = (err) => /QUERY_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|OPERATION_TIME_LIMIT|HTTP 429/i.test(String(err && err.message));

const idsAdded = (before, after) => { const known = new Set(before); return after.filter((id) => !known.has(id)); };
const idsMissing = (before, after) => { const now = new Set(after); return before.filter((id) => !now.has(id)); };

// ---- ATTACH ---------------------------------------------------------------------------------------------------------------------

async function attachFlow(ctx, claim, share, caseRecord) {
  const link = share.dealLink;
  const document = share.requestDocument;
  const request = caseRecord.serviceRequest;
  const dealId = link.bitrixDealId;

  // Eligibility is re-checked at send time: a document must still be exactly what was authorized.
  if (!request || request.reviewStatus !== 'approved') return failFinally(ctx, claim, share, caseRecord, 'attach', 'request_not_approved');
  // Clean scan and not rejected (Admin review is not required: a clean scan alone authorizes sharing). The code keeps its old name for the Admin API.
  if (document.scanStatus !== 'clean' || document.reviewStatus === 'rejected') return failFinally(ctx, claim, share, caseRecord, 'attach', 'document_not_clean_and_approved');
  if (!document.sha256 || document.sha256 !== share.sha256) return failFinally(ctx, claim, share, caseRecord, 'attach', 'checksum_changed');
  if (!dealId) {
    if (ctx.now() - new Date(share.authorizedAt).getTime() > WAIT_FOR_DEAL_MAX_MS) return failFinally(ctx, claim, share, caseRecord, 'attach', 'deal_not_available');
    return reschedule(ctx, claim, 'waiting_for_deal', WAIT_FOR_DEAL_DELAY_SECONDS); // no attempt is used while the Deal does not exist yet
  }

  if (!(await ctx.store.acquireFileLease(ctx.prisma, link.id, ctx.workerId, FILE_LEASE_SECONDS))) return reschedule(ctx, claim, 'deal_files_busy', BUSY_DELAY_SECONDS);
  try {
    // Only while RECONCILING an uncertain upload: a fresh attempt never adopts a file it did not upload (it could be Operations').
    const reconciling = claim.fromStatus === 'ambiguous' || claim.externalCallStartedAt != null;

    // The stored file is read and verified FIRST, so the Deal's file list is read right before the update: Bitrix replaces the whole
    // list, and a file Operations adds between our read and our update would be lost, so that gap is kept to one round trip.
    let bytes = null;
    if (!reconciling) {
      try {
        bytes = await ctx.readFile(document);
      } catch (err) {
        if (err && err.publicCode) return failFinally(ctx, claim, share, caseRecord, 'attach', `file:${err.publicCode}`);
        return retryOrFail(ctx, claim, share, caseRecord, 'attach', 'file_read_error');
      }
    }

    const read = await ctx.api.getDealFiles(dealId, fileOptions(ctx, link));
    if (read.status === 'not_found') return failFinally(ctx, claim, share, caseRecord, 'attach', 'deal_not_found');
    if (read.status !== 'ok') return retryOrFail(ctx, claim, share, caseRecord, 'attach', `read_failed:${read.reason || 'unknown'}`);

    // A timeout is being reconciled: look for exactly one NEW file since the ids recorded before the upload.
    if (reconciling) {
      if (Array.isArray(share.fileIdsBefore)) {
        const before = share.fileIdsBefore.map(String);
        const added = idsAdded(before, read.ids);
        // A prior file is gone: a "new" id could be that file re-created under another id, so it is NOT adopted on its own. Only a
        // person's explicit confirmation of exactly this id (after identifying the file in Bitrix24) lets it through.
        const missingBefore = idsMissing(before, read.ids);
        if (missingBefore.length > 0) {
          const confirmed = ctx.confirmedFileIds && ctx.confirmedFileIds[share.id];
          if (!(added.length === 1 && confirmed != null && String(confirmed) === added[0])) return manualReview(ctx, claim, share, caseRecord, 'attach', 'existing_files_changed');
          return adopt(ctx, claim, share, caseRecord, added[0], { confirmedMissing: missingBefore.length }); // evidence: confirmed by a person, prior file(s) missing
        }
        if (added.length === 1) return adopt(ctx, claim, share, caseRecord, added[0]);
        if (added.length > 1) return manualReview(ctx, claim, share, caseRecord, 'attach', 'several_new_files');
      }
      const waited = claim.secondsSinceCall == null ? RECONCILE_WINDOW_SECONDS : claim.secondsSinceCall;
      if (waited < RECONCILE_WINDOW_SECONDS) return reconcileLater(ctx, claim, share, 'reconciling:not_visible_yet', RECONCILE_INTERVAL_SECONDS);
      return retryOrFail(ctx, claim, share, caseRecord, 'attach', 'not_landed_after_waiting_period');
    }

    // The first (and only) upload of this attempt.
    const entries = [...read.ids.map((id) => ({ id })), { fileData: [remoteFileName(share, document.originalName), bytes.toString('base64')] }];

    // Evidence first, committed BEFORE the call: the ids that are on the Deal now (so our new file can be recognised afterwards).
    await ctx.prisma.bitrixDealDocument.update({ where: { id: share.id }, data: { fileIdsBefore: read.ids, status: 'attaching' } });
    if (!(await ctx.store.markExternalCallStarted(ctx.prisma, claim, MIN_LEASE_LEFT_BEFORE_CALL_SECONDS))) {
      ctx.log.warn(`[deal-document] event ${claim.id}: lease too short or lost before the call; no call made.`);
      return false;
    }
    try {
      await ctx.api.updateDealFiles(dealId, entries, fileOptions(ctx, link));
    } catch (err) {
      const definitive = err instanceof bitrixDealApi.BitrixDealCallError && err.outcome === 'definitive';
      if (!definitive) return reconcileLater(ctx, claim, share, err instanceof bitrixDealApi.BitrixDealCallError ? err.message.slice(0, 200) : 'unexpected_error_during_call', RECONCILE_FIRST_DELAY_SECONDS);
      return isRetryable(err) ? retryOrFail(ctx, claim, share, caseRecord, 'attach', err.code) : failFinally(ctx, claim, share, caseRecord, 'attach', `bitrix:${err.code}`);
    }

    // Verify by reading the Deal again.
    let after = await ctx.api.getDealFiles(dealId, fileOptions(ctx, link));
    if (after.status !== 'ok') return reconcileLater(ctx, claim, share, `verify_read_failed:${after.reason || after.status}`, RECONCILE_FIRST_DELAY_SECONDS);
    let added = idsAdded(read.ids, after.ids);
    if (added.length === 0) { // one more look before calling it a failure (the field may be slow to show the file)
      after = await ctx.api.getDealFiles(dealId, fileOptions(ctx, link));
      if (after.status !== 'ok') return reconcileLater(ctx, claim, share, `verify_read_failed:${after.reason || after.status}`, RECONCILE_FIRST_DELAY_SECONDS);
      added = idsAdded(read.ids, after.ids);
    }
    // Every file that was on the Deal before the update must still be there. If one is gone, a new id may be that file re-created, so
    // nothing is recorded as attached and no id is adopted: a person looks at the Deal.
    if (idsMissing(read.ids, after.ids).length > 0) return manualReview(ctx, claim, share, caseRecord, 'attach', 'existing_files_changed');
    if (added.length === 0) return failFinally(ctx, claim, share, caseRecord, 'attach', 'file_not_visible_after_update');
    if (added.length > 1) return manualReview(ctx, claim, share, caseRecord, 'attach', 'several_new_files');
    return await markAttached(ctx, claim, share, caseRecord, added[0], false); // awaited: the result is written before the Deal lease is released
  } finally {
    await ctx.store.releaseFileLease(ctx.prisma, link.id, ctx.workerId);
  }
}

// `confirmedMissing` > 0 only when a person confirmed this exact id although prior file(s) are gone from the Deal: the audit trail then
// says so (reason adopted_confirmed_by_person, plus an existing_files_missing entry) and Operations is alerted.
async function adopt(ctx, claim, share, caseRecord, fileId, { confirmedMissing = 0 } = {}) {
  try {
    if (!confirmedMissing) return await markAttached(ctx, claim, share, caseRecord, fileId, true);
    const extra = [auditEntry('bitrix.deal.document.existing_files_missing', share, caseRecord, claim, `confirmed_missing_${confirmedMissing}`, { status: 'attached' })];
    const done = await markAttached(ctx, claim, share, caseRecord, fileId, 'adopted_confirmed_by_person', extra);
    if (done) await escalate(ctx, share, caseRecord, 'attachment adopted by confirmation: existing files are missing from the Deal', `${confirmedMissing}_missing`);
    return done;
  } catch (err) {
    // The same Bitrix file is already linked to another share (unique per Deal): not guessed at, a person decides.
    if (err && err.code === 'P2002') return manualReview(ctx, claim, share, caseRecord, 'attach', 'file_id_already_linked');
    throw err;
  }
}

// The options of every Deal-file call. The Deal's own category decides which pipeline's Documents field is read and written: the test
// pipeline keeps its existing field (no extra option, exactly as before); the actual pipeline's Medical Report field is passed
// explicitly. A link whose category is neither is refused (the call throws, the event is retried or failed, nothing is sent).
function fileOptions(ctx, link) {
  // A link with no category is a Deal linked before profiles existed: always the test pipeline (never the actual one).
  const legacy = !link || link.categoryId == null;
  const profile = legacy ? TEST_PROFILE : profileForCategory(link.categoryId);
  if (!profile) throw new Error('unknown_bitrix_category');
  if (profile.name === PROFILE_TEST) return { env: ctx.env };
  // The other pipeline names its field AND says whether it holds one file or several. Missing or invalid metadata refuses the call.
  const documents = documentsConfig(profile);
  if (!documents) throw new Error('documents_field_metadata_invalid');
  return { env: ctx.env, ...documents };
}

// ---- REMOVE ---------------------------------------------------------------------------------------------------------------------

async function removeFlow(ctx, claim, share, caseRecord) {
  const link = share.dealLink;
  const dealId = link.bitrixDealId;

  // Never remove while an attach attempt of this share is still running: it could be about to add the file.
  const running = await ctx.prisma.integrationOutbox.count({
    where: { eventType: ctx.store.ATTACH_EVENT, entityId: { startsWith: `${share.id}:attach:` }, status: 'processing' },
  });
  if (running > 0) return reschedule(ctx, claim, 'attach_in_progress', BUSY_DELAY_SECONDS);

  const everSent = share.bitrixFileId != null || Array.isArray(share.fileIdsBefore);
  if (!everSent || !dealId) return markRevoked(ctx, claim, share, caseRecord, 'never_attached');

  if (!(await ctx.store.acquireFileLease(ctx.prisma, link.id, ctx.workerId, FILE_LEASE_SECONDS))) return reschedule(ctx, claim, 'deal_files_busy', BUSY_DELAY_SECONDS);
  try {
    const read = await ctx.api.getDealFiles(dealId, fileOptions(ctx, link));
    if (read.status === 'not_found') return failFinally(ctx, claim, share, caseRecord, 'remove', 'deal_not_found');
    if (read.status !== 'ok') return retryOrFail(ctx, claim, share, caseRecord, 'remove', `read_failed:${read.reason || 'unknown'}`);

    // Which Bitrix file is ours? Known after a successful attach; after an uncertain one it is the single new file since the upload.
    let target = share.bitrixFileId;
    if (target == null) {
      // After an uncertain upload nobody can say for sure which new file is ours (it could be Operations'): nothing is removed
      // unless no new file exists at all; otherwise a person removes it in Bitrix24.
      const added = idsAdded((share.fileIdsBefore || []).map(String), read.ids);
      if (added.length === 0) return markRevoked(ctx, claim, share, caseRecord, 'not_present');
      return manualReview(ctx, claim, share, caseRecord, 'remove', 'file_not_identified');
    }
    if (!read.ids.includes(String(target))) return markRevoked(ctx, claim, share, caseRecord, 'already_absent');

    // Keep EVERY other file (Operations' own included). An empty list is sent only because the read proved ours was the only one.
    const keep = read.ids.filter((id) => id !== String(target));
    if (!(await ctx.store.markExternalCallStarted(ctx.prisma, claim, MIN_LEASE_LEFT_BEFORE_CALL_SECONDS))) {
      ctx.log.warn(`[deal-document] event ${claim.id}: lease too short or lost before the call; no call made.`);
      return false;
    }
    try {
      await ctx.api.updateDealFiles(dealId, keep.map((id) => ({ id })), { ...fileOptions(ctx, link), allowEmpty: keep.length === 0 });
    } catch (err) {
      const definitive = err instanceof bitrixDealApi.BitrixDealCallError && err.outcome === 'definitive';
      if (!definitive) return reconcileLater(ctx, claim, share, err instanceof bitrixDealApi.BitrixDealCallError ? err.message.slice(0, 200) : 'unexpected_error_during_call', RECONCILE_FIRST_DELAY_SECONDS);
      return isRetryable(err) ? retryOrFail(ctx, claim, share, caseRecord, 'remove', err.code) : failFinally(ctx, claim, share, caseRecord, 'remove', `bitrix:${err.code}`);
    }

    const after = await ctx.api.getDealFiles(dealId, fileOptions(ctx, link));
    if (after.status !== 'ok') return reconcileLater(ctx, claim, share, `verify_read_failed:${after.reason || after.status}`, RECONCILE_FIRST_DELAY_SECONDS);
    if (after.ids.includes(String(target))) return retryOrFail(ctx, claim, share, caseRecord, 'remove', 'removal_not_confirmed');
    const lost = idsMissing(keep, after.ids);
    const done = await markRevoked(ctx, claim, share, caseRecord, 'removed');
    if (done && lost.length) await escalate(ctx, share, caseRecord, 'removal: other files are missing from the Deal', `${lost.length}_missing`);
    return done;
  } finally {
    await ctx.store.releaseFileLease(ctx.prisma, link.id, ctx.workerId);
  }
}

// ---- one event ------------------------------------------------------------------------------------------------------------------

async function processClaim(ctx, claim) {
  const event = await ctx.store.loadEvent(ctx.prisma, claim.id);
  if (!event || !ctx.store.EVENT_TYPES.includes(event.eventType)) return record(ctx, claim, { eventStatus: 'failed', lastError: 'unknown_event_type' });
  const shareId = event.payload && Number(event.payload.shareId);
  const share = Number.isInteger(shareId)
    ? await ctx.prisma.bitrixDealDocument.findUnique({
      where: { id: shareId },
      include: { requestDocument: true, dealLink: { include: { case: { include: { serviceRequest: true } } } } },
    })
    : null;
  if (!share) return record(ctx, claim, { eventStatus: 'failed', lastError: 'share_missing' });
  const caseRecord = share.dealLink.case;
  const attach = event.eventType === ctx.store.ATTACH_EVENT;

  // Only the newest attempt of a share acts; an older or already-settled event just finishes.
  if (event.payload.tryNumber !== share.tryCount) return completeNoop(ctx, claim, 'superseded_event');
  if (attach) {
    if (share.status !== 'authorized' && share.status !== 'attaching' && share.status !== 'ambiguous') return completeNoop(ctx, claim, `share_${share.status}`);
    return attachFlow(ctx, claim, share, caseRecord);
  }
  if (share.status === 'revoked') return completeNoop(ctx, claim, 'already_revoked');
  if (share.status !== 'revoking') return completeNoop(ctx, claim, `share_${share.status}`);
  return removeFlow(ctx, claim, share, caseRecord);
}

// One pass. Returns how many events it claimed. Safe to call repeatedly; the job runner never overlaps two passes.
async function runDealDocumentWorker(overrides = {}) {
  const ctx = buildContext(overrides);
  if (!isPrivateCharterDealWorkerActive(ctx.env)) return { active: false, claimed: 0 };
  // Every Bitrix call of this worker passes the shared gateway at the API layer; here it is only asked BEFORE anything is claimed, so an open circuit
  // pauses the pass without using up a single delivery attempt.
  ctx.gateway = ctx.gateway || gatewayForPass(overrides);
  const start = ctx.gateway.canStart(PRIVATE_CHARTER_QUEUE);
  if (!start.ok) return { active: true, claimed: 0, paused: start.reason };

  await ctx.store.recoverExpiredLeases(ctx.prisma, { maxClaims: MAX_CLAIMS_BEFORE_ANY_CALL, ...(ctx.scope && { caseIds: ctx.scope.caseIds }) });
  let claimed = 0;
  for (const fromStatus of ['pending', 'ambiguous']) {
    const ids = await ctx.store.findCandidateIds(ctx.prisma, fromStatus, BATCH_SIZE, ctx.scope);
    for (const id of ids) {
      const claim = await ctx.store.claim(ctx.prisma, { id, fromStatus, workerId: ctx.workerId, leaseSeconds: LEASE_SECONDS });
      if (!claim) continue;
      claimed += 1;
      try {
        await processClaim(ctx, claim);
      } catch (err) {
        // Unknown failure: leave the event as it is. If a call had started, lease expiry makes it ambiguous; if not, it returns
        // to pending. Only the error name is logged (a message could carry data).
        ctx.log.error(`[deal-document] event ${claim.id}: unexpected ${err && err.name ? err.name : 'error'}; left for lease recovery.`);
      }
    }
  }
  return { active: true, claimed };
}

module.exports = {
  runDealDocumentWorker, processClaim, remoteFileName, fileOptions,
  LEASE_SECONDS, FILE_LEASE_SECONDS, MIN_LEASE_LEFT_BEFORE_CALL_SECONDS, RETRY_DELAYS_SECONDS, MAX_ATTEMPTS,
  RECONCILE_FIRST_DELAY_SECONDS, RECONCILE_INTERVAL_SECONDS, RECONCILE_WINDOW_SECONDS, REMOTE_NAME_MAX,
};
