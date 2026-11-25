// Operations quotation management (Phase 2): what an Admin may do with the quotation versions that the Bitrix24 sync (Phase 1) stores as drafts.
//
//   confirm   draft -> confirmed      only a CLEAN, VALID (amount + currency, no validation error) version whose file still matches its hash
//   publish   confirmed -> published  separate action; supersedes the Case's previous live version; creates the patient's "quotation_ready"
//                                     notification in the SAME transaction, exactly once (the compare-and-set is the single winner)
//   withdraw  draft | confirmed | published -> withdrawn   with a mandatory reason
//   new-version  accepted | rejected | withdrawn | superseded head -> a NEW draft copy of the same PDF (the only way to publish identical content again:
//                it needs a fresh scan, confirmation, publication and a fresh patient acceptance)
//
// RULES THAT ARE NEVER BROKEN HERE
//   * accepted and rejected versions are immutable: no action changes them (an accepted live version may only be superseded by a NEWER published
//     version, which sets supersededAt / supersededById / liveSlot and nothing else);
//   * any change after publication is a NEW version (the sync creates it, or new-version below);
//   * every action runs in ONE transaction that first locks the Case row (SELECT ... FOR UPDATE, the same lock the sync takes), then re-reads the
//     quotation, then writes with a compare-and-set on (id, status, revision). The caller states the REVISION it looked at: if the version changed
//     since (for example the sync replaced the PDF in place) nothing is written and the Admin must look again;
//   * a repeated confirm / publish / withdraw is a no-op that returns the current state (no second audit row, no second notification);
//   * every action writes an append-only audit row in the same transaction; reading the PDF writes one too;
//   * no invoice and no payment is created here (an invoice is created only when the patient ACCEPTS), no Bitrix call is made, and the database
//     CHECKs of case_quotations (clean scan before confirmation, money pair, slots, decision, supersession) are a second line of defence.
const crypto = require('crypto');
const { prisma: defaultPrisma } = require('../../db/prisma');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { assertDealEligible } = require('../bitrix/deal-outbox');
const { createQuotationStorage, sha256Of } = require('../bitrix/quotation-storage');
const { WORKING_STATUSES } = require('../bitrix/quotation-versioning');
const { createPatientNotification } = require('../notifications/notification-core');
const { enqueuePushDeliveries } = require('../notifications/push-delivery-enqueue');
const { suppressionReason, SYNTHETIC_IDENTITY_PREFIX } = require('../notifications/push-delivery.config');

const REASON_MIN = 3;
const REASON_MAX = 1000;
const CLOSED_CASE_STATUSES = new Set(['completed', 'cancelled']);
const IMMUTABLE = new Set(['accepted', 'rejected', 'superseded']);
const NEW_VERSION_SOURCES = new Set(['accepted', 'rejected', 'withdrawn', 'superseded']);
const WITHDRAWABLE = new Set(['draft', 'confirmed', 'published']);
// The patient-facing text is fixed: it never carries an amount, a name or anything from Bitrix.
const NOTICE_BODY = 'Your quotation is ready to review. Open the app to see the details.';

function httpError(statusCode, message, publicCode, extra) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  if (extra) Object.assign(err, extra);
  return err;
}
const conflict = (code, message, extra) => httpError(409, message, code, extra);

// `enqueuePush(tx, notification)` queues the patient's push deliveries inside the publication's own transaction (notifications/push-delivery-enqueue.js). This
// service sends nothing and reads no push token: the push delivery worker (off unless PUSH_DELIVERY_ENABLED=true) does the sending, later. `env` is what
// decides whether this run may queue deliveries at all (see pushMayBeQueued).
function buildContext(overrides = {}) {
  const ctx = { prisma: defaultPrisma, storage: null, now: () => new Date(), enqueuePush: enqueuePushDeliveries, env: process.env, log: console, ...overrides };
  // An injection point passed as undefined (a caller that has nothing to say) means "the default", never "nothing": the real queuing and the real environment.
  if (typeof ctx.enqueuePush !== 'function') ctx.enqueuePush = enqueuePushDeliveries;
  if (!ctx.env || typeof ctx.env !== 'object') ctx.env = process.env;
  return ctx;
}

// A test, scoped, integration or synthetic run, or a synthetic E2E patient identity, never gets push deliveries queued (the in-app notification is
// unaffected). The same rules the delivery worker applies when it sends (push-delivery.config.js), so a run that must not send does not even queue.
function pushMayBeQueued(ctx, serviceRequest) {
  if (suppressionReason(ctx.env)) return false;
  const name = serviceRequest && typeof serviceRequest.patientName === 'string' ? serviceRequest.patientName : '';
  return !name.startsWith(SYNTHETIC_IDENTITY_PREFIX);
}
const storageOf = (ctx) => ctx.storage || (ctx.storage = createQuotationStorage());

function adminIdOf(adminId) {
  const id = Number(adminId);
  if (!Number.isInteger(id) || id < 1) throw httpError(401, 'Invalid admin session', 'admin_required');
  return id;
}
function quotationIdOf(value) {
  const text = String(value);
  if (!/^[1-9]\d{0,9}$/.test(text)) throw httpError(404, 'Quotation not found', 'quotation_not_found');
  return Number(text);
}
function revisionOf(value) {
  if (!Number.isInteger(value) || value < 0) throw httpError(400, 'The quotation revision you looked at is required.', 'revision_required');
  return value;
}
function reasonOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw httpError(400, `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.`, 'reason_invalid');
  return text;
}

// A Case by numeric id or CASE-... reference, only if it is an eligible Private Charter Case (anything else is "not found").
async function loadCase(db, idOrReference) {
  const text = String(idOrReference);
  const where = /^[1-9]\d{0,9}$/.test(text) ? { id: Number(text) } : { referenceNumber: text };
  const caseRecord = await db.case.findFirst({ where, include: { serviceRequest: true } });
  if (!caseRecord) throw httpError(404, 'Case not found', 'case_not_found');
  try { assertDealEligible(caseRecord, caseRecord.serviceRequest); } catch { throw httpError(404, 'Case not found', 'case_not_found'); }
  return caseRecord;
}

// ---- what an Admin sees ----------------------------------------------------------------------------------------------------------------
const SCAN_MESSAGES = {
  pending: 'The file has not been scanned for malware yet.',
  error: 'The malware scan has not completed yet.',
  infected: 'The file was flagged by the malware scan and can never be confirmed.',
};

/** Why this version cannot be confirmed or published right now (the same checks the actions apply). [] = nothing blocks it. */
function readinessBlockers(q, caseClosed) {
  const blockers = [];
  if (q.scanStatus !== 'clean') blockers.push({ code: 'scan_not_clean', message: SCAN_MESSAGES[q.scanStatus] || 'The malware scan is not clean.' });
  if (q.amount == null || q.currency == null || q.validationError) {
    blockers.push({ code: 'quotation_invalid', message: 'The final amount or currency is missing or invalid in Bitrix24. Correct it there; this version updates by itself.', ...(q.validationError ? { detail: q.validationError } : {}) });
  }
  if (caseClosed) blockers.push({ code: 'case_closed', message: 'The Case is closed.' });
  return blockers;
}

/** What the Admin Portal may offer for one version. `isHead`: highest version number; `hasWorking`: the Case has a draft or confirmed version. */
function quotationActions(q, { isHead, hasWorking, caseClosed }) {
  const blockers = readinessBlockers(q, caseClosed);
  return {
    canConfirm: q.status === 'draft' && blockers.length === 0,
    canPublish: q.status === 'confirmed' && blockers.length === 0,
    canWithdraw: WITHDRAWABLE.has(q.status),
    canCreateVersion: isHead && NEW_VERSION_SOURCES.has(q.status) && q.scanStatus === 'clean' && !hasWorking && !caseClosed,
    canViewFile: q.scanStatus === 'clean',
    blockers: q.status === 'draft' || q.status === 'confirmed' ? blockers : [],
  };
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const decimalText = (value) => (value == null ? null : typeof value === 'object' && typeof value.toFixed === 'function' ? value.toFixed(3) : String(value));

function quotationView(q, { names = new Map(), isHead, hasWorking, caseClosed }) {
  const admin = (id) => (id == null ? null : { id, name: names.get(id) || null });
  return {
    id: q.id, caseId: q.caseId, versionNumber: q.versionNumber, status: q.status, revision: q.revision,
    amount: decimalText(q.amount), currency: q.currency ?? null, bitrixAmountRaw: q.bitrixAmountRaw ?? null, bitrixCurrencyRaw: q.bitrixCurrencyRaw ?? null,
    validationError: q.validationError ?? null, bitrixFileId: q.bitrixFileId ?? null, sizeBytes: q.sizeBytes, sha256: q.sha256,
    scanStatus: q.scanStatus, scanDetail: q.scanDetail ?? null, scannedAt: iso(q.scannedAt),
    createdAt: iso(q.createdAt), updatedAt: iso(q.updatedAt), lastSeenAt: iso(q.lastSeenAt), validUntil: iso(q.validUntil),
    confirmedAt: iso(q.confirmedAt), confirmedBy: admin(q.confirmedByAdminId),
    publishedAt: iso(q.publishedAt), publishedBy: admin(q.publishedByAdminId),
    withdrawnAt: iso(q.withdrawnAt), withdrawnBy: admin(q.withdrawnByAdminId), withdrawReason: q.withdrawReason ?? null,
    decidedAt: iso(q.decidedAt), rejectionReason: q.rejectionReason ?? null,
    supersededAt: iso(q.supersededAt), supersededById: q.supersededById ?? null, live: q.liveSlot === 1,
    actions: quotationActions(q, { isHead, hasWorking, caseClosed }),
  };
}

async function namesFor(db, rows) {
  const ids = [...new Set(rows.flatMap((q) => [q.confirmedByAdminId, q.publishedByAdminId, q.withdrawnByAdminId]).filter((id) => id != null))];
  if (!ids.length) return new Map();
  const admins = await db.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(admins.map((a) => [a.id, a.name]));
}

/** All versions of a Case, newest first, each with the actions currently allowed. */
async function listCaseQuotations({ caseId }, deps) {
  const ctx = buildContext(deps);
  const caseRecord = await loadCase(ctx.prisma, caseId);
  const rows = (await ctx.prisma.caseQuotation.findMany({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } })) || [];
  const names = await namesFor(ctx.prisma, rows);
  const caseClosed = CLOSED_CASE_STATUSES.has(caseRecord.status);
  const hasWorking = rows.some((q) => WORKING_STATUSES.has(q.status));
  const live = rows.find((q) => q.liveSlot === 1 && !q.supersededAt);
  return {
    caseId: caseRecord.id, caseReference: caseRecord.referenceNumber,
    quotations: rows.map((q, i) => quotationView(q, { names, isHead: i === 0, hasWorking, caseClosed })),
    livePublishedId: live ? live.id : null,
  };
}

async function getQuotation({ quotationId }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const q = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!q) throw httpError(404, 'Quotation not found', 'quotation_not_found');
  const caseRecord = await loadCase(ctx.prisma, q.caseId);
  const rows = await ctx.prisma.caseQuotation.findMany({ where: { caseId: q.caseId }, orderBy: { versionNumber: 'desc' } });
  const names = await namesFor(ctx.prisma, [q]);
  return quotationView(q, { names, isHead: rows[0] && rows[0].id === q.id, hasWorking: rows.some((r) => WORKING_STATUSES.has(r.status)), caseClosed: CLOSED_CASE_STATUSES.has(caseRecord.status) });
}

/** The ONE quotation a patient may see for a Case: the live (published or accepted, not superseded) version that has not expired. Never a draft,
 * a confirmed, a withdrawn, a rejected or a superseded one. Used by the patient API (a later phase); defined here so the rule is in one place. */
async function findActivePublishedQuotation(db, caseId, now = new Date()) {
  const row = await db.caseQuotation.findFirst({ where: { caseId, liveSlot: 1, status: { in: ['published', 'accepted'] }, supersededAt: null }, orderBy: { versionNumber: 'desc' } });
  if (!row) return null;
  if (row.validUntil && new Date(row.validUntil) <= now) return null; // expired is computed, never stored
  return row;
}

// ---- the transaction every action runs in -----------------------------------------------------------------------------------------------
async function inTransaction(ctx, quotationId, work) {
  return ctx.prisma.$transaction(async (tx) => {
    const first = await tx.caseQuotation.findUnique({ where: { id: quotationId } });
    if (!first) throw httpError(404, 'Quotation not found', 'quotation_not_found');
    await tx.$queryRaw`SELECT id FROM cases WHERE id = ${first.caseId} FOR UPDATE`; // serialises every quotation writer of this Case, the sync included
    const q = await tx.caseQuotation.findUnique({ where: { id: quotationId } }); // re-read under the lock
    const caseRecord = await loadCase(tx, q.caseId);
    return work({ tx, q, caseRecord });
  }, { timeout: 30000, maxWait: 10000 });
}

// The only write path: compare-and-set on id, status and revision. Zero rows = somebody else got there first.
async function casUpdate(tx, q, data) {
  const { count } = await tx.caseQuotation.updateMany({
    where: { id: q.id, revision: q.revision, status: q.status },
    data: { ...data, revision: { increment: 1 } },
  });
  if (count !== 1) throw conflict('quotation_changed', 'The quotation was changed by someone else. Reload it and look again.');
}

function expectRevision(q, revision) {
  if (q.revision !== revision) throw conflict('quotation_changed', 'The quotation changed since you opened it (a new file or amount may have arrived from Bitrix24). Reload it and look again.', { currentRevision: q.revision });
}

function assertReady(q, caseRecord) {
  const blockers = readinessBlockers(q, CLOSED_CASE_STATUSES.has(caseRecord.status));
  if (blockers.length) throw conflict(blockers[0].code, blockers[0].message, { blockers });
}

async function assertFileIntact(ctx, q) {
  let actual;
  try { actual = await storageOf(ctx).hashOf(q.storageKey, q.storageProvider); } catch { actual = null; }
  if (actual !== q.sha256) throw conflict('file_unverified', 'The stored PDF is missing or no longer matches its checksum, so it cannot be used.');
}

function audit(ctx, action, q, caseRecord, actor, { reasonCode, before, after } = {}) {
  return {
    caseId: caseRecord.id, entityType: 'case_quotation', entityId: q.id, action,
    // The quotation auto-publish sweep acts as the designated Admin but is recorded as the SYSTEM (actor type "system", source "quotation_auto").
    actorType: actor.automation ? 'system' : 'admin', actorId: String(actor.adminId), actorRole: actor.adminRole ? String(actor.adminRole).slice(0, 32) : null, source: actor.automation ? 'quotation_auto' : 'admin_portal',
    reasonCode: reasonCode || null,
    ...(before ? { beforeData: before } : {}),
    afterData: { quotationId: q.id, versionNumber: q.versionNumber, caseId: caseRecord.id, caseReference: caseRecord.referenceNumber, ...(after || {}) },
    correlationId: `quotation:${q.id}:r${q.revision}`,
    idempotencyKey: `${action}:${q.id}:r${q.revision}`, // one audit row per action per revision, whatever happens
  };
}

// ---- actions ----------------------------------------------------------------------------------------------------------------------------

async function confirmQuotation({ quotationId, adminId, adminRole, revision, automation }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const admin = { adminId: adminIdOf(adminId), adminRole, automation: automation === true }; // only the auto-publish sweep passes `automation` (never an HTTP body)
  const expected = revisionOf(revision);
  const result = await inTransaction(ctx, id, async ({ tx, q, caseRecord }) => {
    if (q.status === 'confirmed') return { already: true };
    if (q.status !== 'draft') throw conflict('quotation_not_draft', `Only a draft quotation can be confirmed (this one is ${q.status}).`);
    expectRevision(q, expected);
    assertReady(q, caseRecord);
    await assertFileIntact(ctx, q);
    await casUpdate(tx, q, { status: 'confirmed', confirmedByAdminId: admin.adminId, confirmedAt: ctx.now() });
    await appendAuditLog(tx, audit(ctx, 'quotation.confirmed', q, caseRecord, admin, {
      reasonCode: admin.automation ? 'auto_confirmed' : 'admin_confirmed', before: { status: 'draft' }, after: { status: 'confirmed', scanStatus: q.scanStatus },
    }));
    return { already: false };
  });
  return { alreadyConfirmed: result.already, quotation: await getQuotation({ quotationId: id }, ctx) };
}

async function publishQuotation({ quotationId, adminId, adminRole, revision, validUntil, automation }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const admin = { adminId: adminIdOf(adminId), adminRole, automation: automation === true };
  const expected = revisionOf(revision);
  let until = null;
  if (validUntil !== undefined && validUntil !== null && validUntil !== '') {
    until = new Date(validUntil);
    if (Number.isNaN(until.getTime()) || until <= ctx.now()) throw httpError(400, 'The validity date must be in the future.', 'valid_until_invalid');
  }
  const result = await inTransaction(ctx, id, async ({ tx, q, caseRecord }) => {
    if (q.status === 'published') return { already: true };
    if (q.status === 'draft') throw conflict('quotation_not_confirmed', 'The quotation must be confirmed before it can be published.');
    if (q.status === 'accepted') throw conflict('new_version_required', 'An accepted quotation cannot be published again. Create a new version: it needs its own confirmation, publication and a fresh acceptance by the patient.');
    if (q.status !== 'confirmed') throw conflict('quotation_not_publishable', `Only a confirmed quotation can be published (this one is ${q.status}).`);
    expectRevision(q, expected);
    assertReady(q, caseRecord);
    await assertFileIntact(ctx, q);

    // The Case's previous live version is replaced by this one: a published one becomes superseded; an accepted one keeps its status and only
    // records what replaced it (accepted versions are otherwise immutable).
    const live = await tx.caseQuotation.findFirst({ where: { caseId: caseRecord.id, liveSlot: 1 } });
    if (live && live.id !== q.id) {
      const supersededStatus = live.status === 'published' ? 'superseded' : live.status;
      await casUpdate(tx, live, { status: supersededStatus, supersededAt: ctx.now(), supersededById: q.id, liveSlot: null });
      await appendAuditLog(tx, audit(ctx, 'quotation.superseded', live, caseRecord, admin, {
        reasonCode: 'newer_version_published', before: { status: live.status }, after: { status: supersededStatus, supersededById: q.id },
      }));
    }
    await casUpdate(tx, q, { status: 'published', workingSlot: null, liveSlot: 1, publishedByAdminId: admin.adminId, publishedAt: ctx.now(), validUntil: until });
    await appendAuditLog(tx, audit(ctx, 'quotation.published', q, caseRecord, admin, {
      reasonCode: admin.automation ? 'auto_published' : 'admin_published', before: { status: 'confirmed' }, after: { status: 'published' },
    }));
    // The patient's notification: written in THIS transaction, only on the winning compare-and-set, so a repeated or concurrent publish can never add a second one.
    // Through the central core, in this transaction (a failure rolls the publication back). Title: the catalogue's; body: NOTICE_BODY.
    // The patient's push deliveries are queued right after it, in the SAME transaction and only for a newly created notification (created: true), so the
    // publication, the notification and its deliveries commit or roll back together, and a replay can never queue a second set.
    const serviceRequest = caseRecord.serviceRequest;
    const created = await createPatientNotification({
      recipientId: serviceRequest.userId,
      kind: 'quotation_ready',
      body: NOTICE_BODY,
      caseId: caseRecord.id,
      serviceRequestId: serviceRequest.id,
      quotationId: q.id,
      eventRef: `q${q.id}`,
      data: { screen: 'quotation', entityType: 'quotation', entityId: q.id },
    }, { tx });
    if (created.created && pushMayBeQueued(ctx, serviceRequest)) await ctx.enqueuePush(tx, created.notification);
    return { already: false };
  });
  return { alreadyPublished: result.already, quotation: await getQuotation({ quotationId: id }, ctx) };
}

async function withdrawQuotation({ quotationId, adminId, adminRole, revision, reason }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const admin = { adminId: adminIdOf(adminId), adminRole };
  const why = reasonOf(reason);
  const expected = revisionOf(revision);
  const result = await inTransaction(ctx, id, async ({ tx, q, caseRecord }) => {
    if (q.status === 'withdrawn') return { already: true };
    if (IMMUTABLE.has(q.status)) throw conflict('quotation_immutable', `A ${q.status} quotation can no longer be changed.`);
    if (!WITHDRAWABLE.has(q.status)) throw conflict('quotation_not_withdrawable', `This quotation cannot be withdrawn (it is ${q.status}).`);
    expectRevision(q, expected);
    await casUpdate(tx, q, { status: 'withdrawn', workingSlot: null, liveSlot: null, withdrawnAt: ctx.now(), withdrawnByAdminId: admin.adminId, withdrawReason: why });
    await appendAuditLog(tx, audit(ctx, 'quotation.withdrawn', q, caseRecord, admin, {
      reasonCode: 'admin_withdrawn', before: { status: q.status }, after: { status: 'withdrawn' }, // the reason text lives on the row, never in the audit trail
    }));
    return { already: false };
  });
  return { alreadyWithdrawn: result.already, quotation: await getQuotation({ quotationId: id }, ctx) };
}

/** A NEW draft version made from the same PDF of an accepted / rejected / withdrawn / superseded HEAD version. The file is copied under a new key and
 * scanned again; nothing is confirmed or published, and an accepted version is not touched. */
async function createNewVersion({ quotationId, adminId, adminRole, revision }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const admin = { adminId: adminIdOf(adminId), adminRole };
  const expected = revisionOf(revision);
  const source = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!source) throw httpError(404, 'Quotation not found', 'quotation_not_found');
  if (!NEW_VERSION_SOURCES.has(source.status)) throw conflict('quotation_not_versionable', `A new version can be made from an accepted, rejected, withdrawn or superseded quotation (this one is ${source.status}).`);
  if (source.scanStatus !== 'clean') throw conflict('scan_not_clean', SCAN_MESSAGES[source.scanStatus] || 'The malware scan is not clean.');

  const storage = storageOf(ctx);
  let bytes;
  try { bytes = await storage.readVerified(source.storageKey, source.sha256, source.storageProvider); } catch { throw conflict('file_unverified', 'The stored PDF is missing or no longer matches its checksum, so it cannot be copied.'); }
  const newKey = `quotations/case-${source.caseId}/cp${source.id}-${crypto.randomBytes(4).toString('hex')}-${sha256Of(bytes)}.pdf`;
  const put = await storage.putIfAbsent(newKey, bytes, source.sha256);
  const newProvider = (put && put.provider) || storage.provider || 'local'; // where the copy really is

  try {
    const created = await inTransaction(ctx, id, async ({ tx, q, caseRecord }) => {
      if (CLOSED_CASE_STATUSES.has(caseRecord.status)) throw conflict('case_closed', 'The Case is closed.');
      expectRevision(q, expected);
      const all = await tx.caseQuotation.findMany({ where: { caseId: caseRecord.id }, orderBy: { versionNumber: 'desc' } });
      if (all.some((r) => WORKING_STATUSES.has(r.status))) throw conflict('working_version_exists', 'This Case already has an unpublished draft or confirmed quotation. Withdraw or publish it first.');
      if (!all[0] || all[0].id !== q.id) throw conflict('not_latest_version', 'A new version can only be made from the latest version.');
      if (!NEW_VERSION_SOURCES.has(q.status)) throw conflict('quotation_not_versionable', `A new version can be made from an accepted, rejected, withdrawn or superseded quotation (this one is ${q.status}).`);
      const link = await tx.bitrixDealLink.findUnique({ where: { caseId: caseRecord.id } });
      const row = await tx.caseQuotation.create({
        data: {
          caseId: caseRecord.id, dealLinkId: link.id, versionNumber: q.versionNumber + 1, bitrixDealId: q.bitrixDealId, bitrixFileId: q.bitrixFileId,
          bitrixAmountRaw: q.bitrixAmountRaw, bitrixCurrencyRaw: q.bitrixCurrencyRaw, bitrixDealStageId: q.bitrixDealStageId, contentFingerprint: q.contentFingerprint,
          storageProvider: newProvider, storageKey: newKey, sizeBytes: q.sizeBytes, sha256: q.sha256, amount: q.amount, currency: q.currency, validationError: q.validationError,
          status: 'draft', workingSlot: 1, scanStatus: 'pending', revision: 0, lastSeenAt: ctx.now(),
        },
      });
      await appendAuditLog(tx, audit(ctx, 'quotation.new_version_created', row, caseRecord, admin, {
        reasonCode: 'new_version_requested', before: { status: q.status }, after: { status: 'draft', previousQuotationId: q.id, scanStatus: 'pending' },
      }));
      return row;
    });
    return { quotation: await getQuotation({ quotationId: created.id }, ctx) };
  } catch (err) {
    await storage.remove(newKey, newProvider).catch(() => undefined); // nothing refers to the copy
    throw err;
  }
}

/** The PDF of a version, for an Admin. Served only while the scan is clean and the file still matches its hash; every access is audited. */
async function resolveQuotationFile({ quotationId, adminId, adminRole }, deps) {
  const ctx = buildContext(deps);
  const id = quotationIdOf(quotationId);
  const admin = { adminId: adminIdOf(adminId), adminRole };
  const q = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!q) throw httpError(404, 'Quotation not found', 'quotation_not_found');
  const caseRecord = await loadCase(ctx.prisma, q.caseId);
  if (q.scanStatus !== 'clean') throw conflict('scan_not_clean', SCAN_MESSAGES[q.scanStatus] || 'The malware scan is not clean, so the file cannot be opened.');
  let buffer;
  try { buffer = await storageOf(ctx).readVerified(q.storageKey, q.sha256, q.storageProvider); } catch { throw conflict('file_unverified', 'The stored PDF is missing or no longer matches its checksum, so it cannot be opened.'); }
  await appendAuditLog(ctx.prisma, { ...audit(ctx, 'quotation.file_viewed', q, caseRecord, admin, { reasonCode: 'admin_viewed_file' }), idempotencyKey: null });
  return { buffer, name: `${caseRecord.referenceNumber}-quotation-v${q.versionNumber}.pdf` };
}

module.exports = {
  listCaseQuotations, getQuotation, confirmQuotation, publishQuotation, withdrawQuotation, createNewVersion, resolveQuotationFile,
  findActivePublishedQuotation, quotationActions, readinessBlockers, quotationView, NOTICE_BODY, REASON_MIN, REASON_MAX,
};
