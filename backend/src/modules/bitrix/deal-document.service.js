// Admin operations for sharing HumanCare documents with the Bitrix24 Deal (the database half; the worker does the Bitrix calls,
// see deal-document-worker.service.js). Everything here happens in ONE transaction under the request's row lock and writes the
// share row, its outbox event, the request audit event and the business audit entry together or not at all. Nothing here calls
// Bitrix24, and nothing here changes or deletes a HumanCare document.
//
//   * Document REVIEW and sharing AUTHORIZATION are separate: reviewing a document never shares it; an Admin must authorize each
//     document explicitly (authorizeShare), before or after the request is approved... but only once the Case and Deal exist.
//   * Only a document that is scanned clean, approved, current and really a PDF, JPEG, PNG or WEBP (read from the file's own bytes,
//     checksum verified) can be authorized.
//   * Revocation (revokeShare) asks the worker to remove the Bitrix attachment only. The original stays in HumanCare.
const { prisma } = require('../../db/prisma');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { httpError, readVerifiedFile } = require('../request-review/request-review.files');
const { ACTION, REASON_MIN, REASON_MAX } = require('../request-review/request-review.config');
const { detectFileType, SHAREABLE_TYPES } = require('../documents/file-type');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const store = require('./deal-document.store');

const REVOCABLE = ['authorized', 'attaching', 'attached', 'ambiguous', 'failed'];
const NEEDS_ATTENTION = ['failed', 'revoke_failed', 'ambiguous'];

// What an Admin may see of a share (never the file's checksum or the visible token).
const SHARE_SELECT = {
  id: true, requestDocumentId: true, caseDocumentId: true, generation: true, detectedType: true, status: true, bitrixFileId: true, tryCount: true,
  attempts: true, lastError: true, authorizedByAdminId: true, authorizedAt: true, attachedAt: true, revokedByAdminId: true, revokedAt: true, revokeReason: true, updatedAt: true,
};

const numericId = (value, label) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw httpError(400, `${label} is not valid.`);
  return id;
};

async function lockApprovedRequest(tx, requestId) {
  await tx.$queryRaw`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`;
  const request = await tx.serviceRequest.findUnique({ where: { id: requestId } });
  if (!request || request.reviewStatus == null) throw httpError(404, 'Request not found');
  if (request.serviceKey !== PRIVATE_CHARTER_KEY) throw httpError(404, 'Request not found');
  if (request.reviewStatus !== 'approved') throw httpError(409, 'Documents can be shared only after the request is approved.', 'request_not_approved');
  const caseRecord = await tx.case.findUnique({ where: { serviceRequestId: request.id }, include: { bitrixDealLink: true } });
  if (!caseRecord || !caseRecord.bitrixDealLink) throw httpError(409, 'The request has no Case and Deal record yet.', 'no_deal_link');
  return { request, caseRecord, link: caseRecord.bitrixDealLink };
}

// `automation` (only the automatic sharing passes it): recorded as the SYSTEM, source "document_auto_share"; the designated Admin's id is still stored.
const requestEvent = (tx, { request, documentId = null, action, adminId, detail, automation = false }) => tx.requestEvent.create({
  data: { serviceRequestId: request.id, documentId, action, actorType: automation ? 'system' : 'admin', actorId: adminId, detail },
});

const audit = (tx, { caseRecord, share, action, adminId, code, automation = false }) => appendAuditLog(tx, {
  caseId: caseRecord.id, entityType: 'bitrix_deal_document', entityId: String(share.id), action,
  actorType: automation ? 'system' : 'admin', actorId: adminId, source: automation ? 'document_auto_share' : 'admin_portal', reasonCode: code,
  afterData: { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber, shareId: share.id, requestDocumentId: share.requestDocumentId, status: share.status },
  correlationId: `share:${share.id}`, idempotencyKey: `${action}:share:${share.id}:${share.tryCount}`,
});

const eventData = (kind, share, caseRecord, tryNumber) => ({
  eventType: kind === 'attach' ? store.ATTACH_EVENT : store.REMOVE_EVENT,
  entityType: store.ENTITY_TYPE,
  entityId: store.entityOf(share.id, kind, tryNumber),
  caseId: caseRecord.id,
  idempotencyKey: kind === 'attach' ? store.attachKey(share.id, tryNumber) : store.removeKey(share.id, tryNumber),
  payload: { shareId: share.id, caseId: caseRecord.id, tryNumber },
  status: 'pending',
  nextAttemptAt: new Date(),
});

// ---- authorize ----------------------------------------------------------------------------------------------------------------

/** Admin explicitly authorizes ONE document to be attached to the Deal. Idempotent: an active share is returned as it is.
 *  `automation: true` is passed ONLY by the automatic sharing (deal-document-auto-share.js): a clean scan alone is enough (Admin review is not required, a
 *  rejected document is still refused), the Case document need not exist yet, and a document whose earlier share was REVOKED is never shared again. */
async function authorizeShare({ requestId, documentId, adminId, readFile = readVerifiedFile, automation = false }) {
  const auto = automation === true;
  const rid = numericId(requestId, 'The request');
  const did = numericId(documentId, 'The document');
  return prisma.$transaction(async (tx) => {
    const { request, caseRecord, link } = await lockApprovedRequest(tx, rid);
    const document = await tx.requestDocument.findFirst({ where: { id: did, serviceRequestId: request.id } });
    if (!document) throw httpError(404, 'Document not found');
    if (document.scanStatus !== 'clean') throw httpError(409, 'Only a document whose virus scan is clean can be shared.', 'document_not_clean');
    if (auto ? document.reviewStatus === 'rejected' : document.reviewStatus !== 'approved') throw httpError(409, auto ? 'A rejected document is never shared.' : 'Only an approved document can be shared.', auto ? 'document_rejected' : 'document_not_approved');
    if (document.supersededAt) throw httpError(409, 'This document was replaced by a newer one.', 'document_superseded');
    if (!auto && document.caseDocumentId == null) throw httpError(409, 'The document is not part of the Case yet.', 'not_in_case');

    const last = await tx.bitrixDealDocument.findFirst({ where: { dealLinkId: link.id, requestDocumentId: document.id }, orderBy: { generation: 'desc' } });
    if (last && last.status !== 'revoked') return { share: last, alreadyAuthorized: true };
    if (auto && last) return { share: last, alreadyAuthorized: true, revoked: true }; // an Admin revoked it: the automation never undoes that

    // The file must exist, match its checksum, and REALLY be a PDF or an image (its own bytes decide, not its name or declared type).
    const buffer = await readFile(document);
    const detectedType = detectFileType(buffer);
    if (!detectedType) throw httpError(409, `Only ${SHAREABLE_TYPES.join(', ').toUpperCase()} files can be shared.`, 'unsupported_type');

    const generation = last ? last.generation + 1 : 1;
    const share = await tx.bitrixDealDocument.create({
      data: {
        dealLinkId: link.id, requestDocumentId: document.id, caseDocumentId: document.caseDocumentId ?? null, generation,
        sha256: document.sha256, sizeBytes: document.sizeBytes, detectedType,
        shareToken: `HC-D${document.id}G${generation}-${String(document.sha256).slice(0, 8)}`,
        status: 'authorized', tryCount: 1, authorizedByAdminId: adminId,
      },
    });
    await tx.integrationOutbox.create({ data: eventData('attach', share, caseRecord, 1) });
    await requestEvent(tx, { request, documentId: document.id, action: ACTION.DOCUMENT_SHARE_AUTHORIZED, adminId, detail: { shareId: share.id, generation }, automation: auto });
    await audit(tx, { caseRecord, share, action: 'bitrix.deal.document.authorized', adminId, code: auto ? 'share_auto_authorized' : 'share_authorized', automation: auto });
    return { share, alreadyAuthorized: false };
  });
}

// ---- revoke -------------------------------------------------------------------------------------------------------------------

async function shareOfRequest(tx, caseRecord, shareId) {
  const share = await tx.bitrixDealDocument.findUnique({ where: { id: shareId } });
  if (!share || share.dealLinkId !== caseRecord.bitrixDealLink.id) throw httpError(404, 'Share not found');
  return share;
}

/** Admin revokes a share: the worker removes the Bitrix attachment; the HumanCare original and the audit history stay. */
async function revokeShare({ requestId, shareId, adminId, reason }) {
  const rid = numericId(requestId, 'The request');
  const sid = numericId(shareId, 'The share');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw httpError(400, `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.`, 'reason_required');
  return prisma.$transaction(async (tx) => {
    const { request, caseRecord } = await lockApprovedRequest(tx, rid);
    const share = await shareOfRequest(tx, caseRecord, sid);
    if (share.status === 'revoking' || share.status === 'revoked') return { share, alreadyRevoked: true };
    if (!REVOCABLE.includes(share.status)) throw httpError(409, `A share that is ${share.status} cannot be revoked; retry it first.`, 'share_not_revocable');
    const tryNumber = share.tryCount + 1;
    const updated = await tx.bitrixDealDocument.update({
      where: { id: share.id },
      data: { status: 'revoking', revokedByAdminId: adminId, revokeReason: text, attempts: 0, tryCount: tryNumber, lastError: null },
    });
    await tx.integrationOutbox.create({ data: eventData('remove', share, caseRecord, tryNumber) });
    await requestEvent(tx, { request, documentId: share.requestDocumentId, action: ACTION.DOCUMENT_SHARE_REVOKED, adminId, detail: { shareId: share.id } });
    await audit(tx, { caseRecord, share: { ...updated, tryCount: tryNumber }, action: 'bitrix.deal.document.revocation_requested', adminId, code: 'share_revoked' });
    return { share: updated, alreadyRevoked: false };
  });
}

// ---- retry (the Admin side of the escalation) -----------------------------------------------------------------------------------

/** Admin retries a share that failed for good (attach or removal). A new event with a new key; the attempts start again. */
async function retryShare({ requestId, shareId, adminId }) {
  const rid = numericId(requestId, 'The request');
  const sid = numericId(shareId, 'The share');
  return prisma.$transaction(async (tx) => {
    const { request, caseRecord } = await lockApprovedRequest(tx, rid);
    const share = await shareOfRequest(tx, caseRecord, sid);
    if (share.status !== 'failed' && share.status !== 'revoke_failed') throw httpError(409, 'Only a failed share can be retried.', 'share_not_retryable');
    const kind = share.status === 'failed' ? 'attach' : 'remove';
    const tryNumber = share.tryCount + 1;
    const updated = await tx.bitrixDealDocument.update({
      where: { id: share.id }, data: { status: kind === 'attach' ? 'authorized' : 'revoking', attempts: 0, tryCount: tryNumber, lastError: null },
    });
    await tx.integrationOutbox.create({ data: eventData(kind, share, caseRecord, tryNumber) });
    await requestEvent(tx, { request, documentId: share.requestDocumentId, action: ACTION.DOCUMENT_SHARE_RETRIED, adminId, detail: { shareId: share.id, kind } });
    await audit(tx, { caseRecord, share: { ...updated, tryCount: tryNumber }, action: 'bitrix.deal.document.retried', adminId, code: `retry_${kind}` });
    return { share: updated };
  });
}

// ---- list (Admin-visible status) -------------------------------------------------------------------------------------------------

/** The shares of a request's Case with their status, attempts and last error code; `needsAttention` marks the ones a person must look at. */
async function listShares(requestId) {
  const rid = numericId(requestId, 'The request');
  const shares = await prisma.bitrixDealDocument.findMany({
    where: { dealLink: { case: { serviceRequestId: rid } } }, select: SHARE_SELECT, orderBy: { id: 'asc' },
  });
  return shares.map((share) => ({ ...share, needsAttention: NEEDS_ATTENTION.includes(share.status) }));
}

module.exports = { authorizeShare, revokeShare, retryShare, listShares, SHARE_SELECT, NEEDS_ATTENTION, REVOCABLE };
