// The request-first review workflow (Private Charter only; see backend/REQUEST-REVIEW-WORKFLOW.md).
//
// A new request is saved with its permanent REQ- reference and NO Case. The patient uploads one or
// more documents against it; every document is scanned by ClamAV and then approved or rejected by
// an Admin; only when an Admin approves the request, and every current document is clean and
// approved, is the operational Case (CASE- reference) created, in one transaction.
//
// Every change to a request or its documents writes an event to request_events in the same
// transaction (append-only: this file only ever inserts events).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../../db/prisma');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const { URGENCY_TO_CASE } = require('../../common/constants/request.constants');
const clamav = require('../../integrations/clamav/clamav');
const { requestRecordData } = require('../requests/request-record');
const {
  REQUEST_STATUS, REQUEST_STATUSES, SCAN, REVIEW, ACTION, MAX_DOCUMENTS_PER_REQUEST, REASON_MIN, REASON_MAX, SCAN_RETRY, scanBackoffMs, isStorageErrorCode,
} = require('./request-review.config');
const { httpError, hashFile, storedPath, fileProblem, readVerifiedFile, cleanOriginalName } = require('./request-review.files');

const QUARANTINE_DIR = path.join(UPLOAD_DIR, 'quarantine');

const randomSuffix = () => crypto.randomBytes(4).toString('hex');
const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

// Business audit history. `db` is the transaction (or the client) the change itself is written with.
function appendEvent(db, { serviceRequestId, documentId, action, fromStatus, toStatus, actorType, actorId, detail }) {
  return db.requestEvent.create({
    data: {
      serviceRequestId, documentId: documentId ?? null, action, fromStatus: fromStatus ?? null, toStatus: toStatus ?? null,
      actorType, actorId: actorId ?? null, ...(detail !== undefined && { detail }),
    },
  });
}

// Takes the request's row lock for the rest of the transaction, so uploads, reviews and the approval
// of one request never interleave. Returns the request as it is once the lock is held.
async function lockRequest(tx, requestId) {
  await tx.$queryRaw`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`;
  return tx.serviceRequest.findUnique({ where: { id: requestId } });
}

function reasonOrThrow(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    throw httpError(400, `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.`, 'reason_required');
  }
  return text;
}

function numericId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw httpError(400, `${label} is not valid.`);
  return id;
}

// ---- creating the request ---------------------------------------------------------------------

// `data` is what the Private Charter validator returned. Request, permanent reference and first
// event are saved together or not at all. No Case, and no Bitrix lead, is created here.
async function createReviewRequest(userId, data) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.serviceRequest.create({
      data: {
        ...requestRecordData(userId, data),
        referenceNumber: `TEMP-${Date.now()}-${randomSuffix()}`,
        status: 'submitted',
        reviewStatus: REQUEST_STATUS.AWAITING_DOCUMENTS,
      },
    });
    const request = await tx.serviceRequest.update({ where: { id: created.id }, data: { referenceNumber: `REQ-${1000 + created.id}` } });
    await appendEvent(tx, {
      serviceRequestId: request.id, action: ACTION.REQUEST_CREATED, toStatus: REQUEST_STATUS.AWAITING_DOCUMENTS,
      actorType: 'patient', actorId: userId, detail: { referenceNumber: request.referenceNumber },
    });
    return request;
  });
}

// ---- patient uploads --------------------------------------------------------------------------

// Stores one uploaded file as a new document of the patient's own request. `file` is multer's file
// (already on disk in the uploads folder). An optional `replacesDocumentId` marks an earlier
// document as replaced; the earlier row is kept untouched apart from that mark. The first document
// moves the request into review, and any upload while changes were requested puts it back into
// review. The file is removed again if anything fails.
async function addPatientDocument({ userId, requestId, file, replacesDocumentId }) {
  try {
    const sha256 = await hashFile(file.path);
    const id = numericId(requestId, 'The request');
    return await prisma.$transaction(async (tx) => {
      const request = await lockRequest(tx, id);
      if (!request || request.userId !== userId) throw httpError(404, 'Request not found');
      if (request.reviewStatus == null) throw httpError(409, 'This request is not in the document review workflow.');
      if (request.reviewStatus === REQUEST_STATUS.APPROVED) {
        throw httpError(409, 'This request has been approved. Please contact HumanCare to add more documents.', 'request_approved');
      }

      const existing = await tx.requestDocument.findMany({ where: { serviceRequestId: id }, select: { id: true, supersededAt: true } });
      if (existing.length >= MAX_DOCUMENTS_PER_REQUEST) {
        throw httpError(400, `A request can hold at most ${MAX_DOCUMENTS_PER_REQUEST} documents.`, 'too_many_documents');
      }
      let replaced = null;
      if (replacesDocumentId !== undefined && replacesDocumentId !== null && replacesDocumentId !== '') {
        const target = numericId(replacesDocumentId, 'The document to replace');
        replaced = existing.find((d) => d.id === target && !d.supersededAt);
        if (!replaced) throw httpError(400, 'The document to replace was not found on this request, or was already replaced.', 'replace_target_invalid');
      }

      const document = await tx.requestDocument.create({
        data: {
          serviceRequestId: id, originalName: cleanOriginalName(file.originalname), storageKey: file.filename, sizeBytes: file.size,
          mimeType: clip(file.mimetype, 191), sha256, uploadedByUserId: userId, replacesId: replaced ? replaced.id : null,
        },
      });
      if (replaced) await tx.requestDocument.update({ where: { id: replaced.id }, data: { supersededAt: new Date() } });
      await appendEvent(tx, {
        serviceRequestId: id, documentId: document.id, action: replaced ? ACTION.DOCUMENT_REPLACED : ACTION.DOCUMENT_UPLOADED,
        actorType: 'patient', actorId: userId, detail: { name: document.originalName, sizeBytes: document.sizeBytes, replacesId: replaced ? replaced.id : null },
      });

      const from = request.reviewStatus;
      if (from === REQUEST_STATUS.AWAITING_DOCUMENTS || from === REQUEST_STATUS.CHANGES_REQUESTED) {
        await tx.serviceRequest.update({
          where: { id },
          data: { reviewStatus: REQUEST_STATUS.IN_REVIEW, submittedAt: request.submittedAt || new Date(), documentsRequestReason: null },
        });
        await appendEvent(tx, {
          serviceRequestId: id, action: ACTION.STATUS_CHANGED, fromStatus: from, toStatus: REQUEST_STATUS.IN_REVIEW, actorType: 'patient', actorId: userId,
        });
      }
      return document;
    });
  } catch (err) {
    fs.rm(file.path, { force: true }, () => {});
    throw err;
  }
}

// What the upload endpoint returns: the legacy field names the app already reads, plus the states.
const toUploadResponse = (document) => ({
  id: document.id, name: document.originalName, fileSizeBytes: document.sizeBytes, uploadedAt: document.uploadedAt,
  replacesId: document.replacesId, scanStatus: document.scanStatus, reviewStatus: document.reviewStatus,
});

// ---- scanning ---------------------------------------------------------------------------------

// Why a scan gave no verdict. TRANSIENT failures can heal by themselves (ClamAV is down, slow or unreachable, a file
// could not be read for now): the document stays "error" (unusable) and the worker tries again. PERMANENT failures
// cannot: no retry brings a deleted file back or makes an altered one match its checksum, so the document ends as
// "failed" (final, unusable) and the patient has to upload a replacement. Only the cases below are permanent; anything
// else, including every answer or error from the scanner itself, is transient. A missing file is permanent only when the
// storage itself is known to be healthy (see confirmFileMissing).
const permanentFailure = (detail) => ({ status: SCAN.ERROR, permanent: true, detail });
const transientFailure = (detail) => ({ status: SCAN.ERROR, detail });
// The storage is what failed (folder unavailable, no permission, I/O error), not the document and not ClamAV: retried when the
// storage is back, and it never uses up a retry attempt (see attemptScan). A storage outage must not fail valid documents.
const storageFailure = (detail) => ({ status: SCAN.ERROR, storage: true, detail });

// A file that is not where it should be is lost for good only if the STORAGE is fine. If the upload folder is gone or
// unreadable, or is the wrong folder (a worker started with another HC_UPLOAD_DIR, a volume that is not mounted: every
// file then "disappears" at once), failing the documents for good would destroy valid uploads that a retry brings back.
// So before a missing file is called permanent, two things must hold: the upload folder is a readable directory, AND at
// least one OTHER document that was scanned clean is still found in it (looking at the newest few). When that cannot be
// confirmed the answer is "not sure", and "not sure" is retried, never terminal. This only reads; it writes nothing.
const STORAGE_WITNESSES = 5;
async function confirmFileMissing(document) {
  try {
    const folder = await fs.promises.stat(UPLOAD_DIR);
    if (!folder.isDirectory()) throw new Error('not a directory');
    await fs.promises.access(UPLOAD_DIR, fs.constants.R_OK);
  } catch {
    return storageFailure('the stored file was not found and the upload folder is unavailable, so it is retried instead of failing the document');
  }
  const witnesses = await prisma.requestDocument.findMany({
    where: { scanStatus: SCAN.CLEAN, id: { not: document.id } }, orderBy: { id: 'desc' }, take: STORAGE_WITNESSES, select: { storageKey: true },
  });
  for (const witness of witnesses) {
    try {
      if ((await fs.promises.stat(storedPath(witness.storageKey))).isFile()) return permanentFailure('the stored file is missing');
    } catch { /* this one is not there either: try the next */ }
  }
  return storageFailure('the stored file was not found, and no other stored document could be found in the upload folder to show the storage is intact, so it is retried instead of failing the document');
}

// Moves an infected file out of the uploads folder (defence in depth: the verdict alone already stops every download
// and review). It never throws and never touches the saved verdict. A failure is logged with the document, the step
// and the error code (not the message, which holds file-system paths), because the file then needs to be moved by hand.
function quarantineFile(document, file) {
  const name = path.basename(document.storageKey);
  const target = path.join(QUARANTINE_DIR, name);
  let step = 'creating the quarantine folder';
  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    step = 'moving the file';
    fs.renameSync(file, target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' && fs.existsSync(target)) return true; // already quarantined
    console.error(
      `[scan] document ${document.id} (request ${document.serviceRequestId}) is INFECTED but could not be quarantined while ${step}: ${err.code || 'unknown error'}. `
      + `The verdict is saved and nobody can open the file, but ${name} is still in the uploads folder and must be moved by hand.`,
    );
    return false;
  }
}

// ---- scanning: claims, retries and backoff -------------------------------------------------------
//
// Every scan attempt is CLAIMED first, atomically, in one compare-and-swap UPDATE on the row: it only succeeds
// while scanAttempts and scanNextAttemptAt still hold the values that were just read, and it raises scanAttempts by
// one and moves scanNextAttemptAt to the end of a lease (SCAN_RETRY.leaseMs). Of two workers that try at once, one
// wins and the other scans nothing. A worker that dies mid-scan leaves a lease that runs out, after which the
// document is due again. Attempts are counted when claimed, so a document that crashes its worker is still bounded.
//
// The verdict is written only while scanAttempts is still the claimed value, so a worker that was cut off (its lease
// ran out and another worker claimed the document) can never overwrite a newer result.
//
// A failure that may heal ("error") schedules the next attempt with exponential backoff (scanBackoffMs). After
// SCAN_RETRY.maxAttempts attempts without a verdict the document becomes "failed" (final), like any other permanent
// failure. When ClamAV itself is unreachable no attempt is used up (see the health check below).

// Writes one outcome, as a compare-and-swap on the claimed attempt count. Returns how many rows were written (0 or 1).
// The audit event goes in the same transaction; a scanner that stays down is recorded once, not on every retry.
async function saveScanOutcome(document, expectedAttempts, { status, detail, attempts, nextAttemptAt, at, eventDetail }) {
  return prisma.$transaction(async (tx) => {
    const { count: written } = await tx.requestDocument.updateMany({
      where: { id: document.id, scanStatus: { in: [SCAN.PENDING, SCAN.ERROR] }, scanAttempts: expectedAttempts },
      data: {
        scanStatus: status, scanEngine: clamav.ENGINE, scanDetail: detail, scannedAt: at, scanAttempts: attempts, scanNextAttemptAt: nextAttemptAt,
      },
    });
    if (written && (status !== SCAN.ERROR || document.scanStatus !== SCAN.ERROR)) {
      await appendEvent(tx, {
        serviceRequestId: document.serviceRequestId, documentId: document.id, actorType: 'system',
        action: status === SCAN.CLEAN ? ACTION.SCAN_CLEAN
          : status === SCAN.INFECTED ? ACTION.SCAN_INFECTED
            : status === SCAN.FAILED ? ACTION.SCAN_FAILED : ACTION.SCAN_ERROR,
        detail: { engine: clamav.ENGINE, ...(detail && { detail }), ...eventDetail },
      });
    }
    return written;
  });
}

const exhaustedDetail = (attempts, last) => clip(`scan retries exhausted after ${attempts} attempts${last ? `: ${last}` : ''}`, 255);

function logExhausted(document, attempts) {
  console.error(`[scan] document ${document.id} (request ${document.serviceRequestId}) could not be scanned after ${attempts} attempts. It will not be retried; the patient must upload a replacement.`);
}

// Claims the next attempt for one document. Resolves { claimed: false, document } when nothing should be scanned now (the
// document is gone, replaced, final, not due yet, or another worker got there first) and { claimed: true, document,
// attempts } when this caller owns the attempt. `document` is the row as it was before the claim.
// A document that is due again with every attempt already used (the last one never finished: its worker died) is
// failed here without scanning.
async function claimScan(documentId, { clock, retry = SCAN_RETRY }) {
  const document = await prisma.requestDocument.findUnique({ where: { id: documentId } });
  if (!document || document.supersededAt) return { claimed: false, document };
  if (document.scanStatus !== SCAN.PENDING && document.scanStatus !== SCAN.ERROR) return { claimed: false, document }; // clean, infected, failed: final
  const now = clock();
  const next = document.scanNextAttemptAt;
  if (next && +next > now) return { claimed: false, document }; // backing off, or another worker holds the lease

  if (document.scanAttempts >= retry.maxAttempts) {
    const written = await saveScanOutcome(document, document.scanAttempts, {
      status: SCAN.FAILED, detail: exhaustedDetail(document.scanAttempts, 'the last attempt did not finish'), attempts: document.scanAttempts,
      nextAttemptAt: null, at: new Date(now), eventDetail: { attempts: document.scanAttempts, reason: 'retries_exhausted' },
    });
    if (written) logExhausted(document, document.scanAttempts);
    return { claimed: false, exhausted: Boolean(written), document: await prisma.requestDocument.findUnique({ where: { id: documentId } }) };
  }

  const attempts = document.scanAttempts + 1;
  const { count } = await prisma.requestDocument.updateMany({
    where: { id: documentId, supersededAt: null, scanStatus: document.scanStatus, scanAttempts: document.scanAttempts, scanNextAttemptAt: next },
    data: { scanAttempts: attempts, scanNextAttemptAt: new Date(now + retry.leaseMs) },
  });
  if (!count) return { claimed: false, document: await prisma.requestDocument.findUnique({ where: { id: documentId } }) }; // lost the race
  return { claimed: true, document, attempts };
}

// One scan attempt. Resolves { document: the row as it is now, scannerDown: true when ClamAV was unreachable }.
async function attemptScan(documentId, { scanner, health, clock = Date.now, rng = Math.random } = {}) {
  const scan = scanner || clamav.scanFile;
  // With an injected scanner there is no real ClamAV to ask, unless the caller injects a health check too.
  const isScannerUp = health || (scanner ? async () => true : clamav.ping);
  const claim = await claimScan(documentId, { clock });
  if (!claim.claimed) return { document: claim.document, scannerDown: false };
  const { document, attempts } = claim;

  const file = path.join(UPLOAD_DIR, path.basename(document.storageKey));
  let verdict;
  try {
    // The scan is bound to the upload's checksum: the file must be what was uploaded before it is
    // scanned, and unchanged after, otherwise "clean" would describe different bytes than the ones kept.
    const before = await hashFile(file);
    if (!document.sha256) {
      verdict = permanentFailure('no checksum was recorded for this upload, so the file cannot be verified');
    } else if (before !== document.sha256) {
      verdict = permanentFailure('the stored file does not match its upload checksum');
    } else {
      verdict = await scan(file);
      if (verdict && verdict.status === SCAN.CLEAN && (await hashFile(file)) !== before) {
        verdict = permanentFailure('the file changed while it was being scanned');
      }
    }
  } catch (err) {
    verdict = err.code === 'ENOENT'
      ? await confirmFileMissing(document)
      : (isStorageErrorCode(err.code) ? storageFailure : transientFailure)(`the scan could not be completed (${err.code || clip(err.message, 120)})`);
  }
  const definite = verdict && (verdict.status === SCAN.CLEAN || verdict.status === SCAN.INFECTED);
  let status = definite ? verdict.status : verdict && verdict.permanent === true ? SCAN.FAILED : SCAN.ERROR;
  let detail = clip(status === SCAN.INFECTED ? verdict.signature : verdict && verdict.detail, 255);

  // What to store with the outcome. A final outcome clears the schedule.
  const at = new Date(clock());
  let savedAttempts = attempts;
  let nextAttemptAt = null;
  let eventDetail;
  let scannerDown = false;
  let exhausted = false;
  if (status === SCAN.ERROR) {
    // The scan gave no verdict. If the STORAGE failed (or ClamAV could not read the file from it) that is not this document's
    // fault: the attempt is given back and the document is looked at again after storageRecheckMs, however long the outage lasts.
    // If ClamAV is unreachable that is not its fault either: the attempt is given back and the sweep stops (it will not even
    // start again until ClamAV answers). Otherwise the attempt counts.
    const storageProblem = Boolean(verdict && (verdict.storage || isStorageErrorCode(verdict.fsCode)));
    scannerDown = storageProblem ? false : !(await isScannerUp());
    if (storageProblem) {
      savedAttempts = attempts - 1;
      nextAttemptAt = new Date(clock() + SCAN_RETRY.storageRecheckMs);
    } else if (scannerDown) {
      savedAttempts = attempts - 1;
    } else if (attempts >= SCAN_RETRY.maxAttempts) {
      status = SCAN.FAILED;
      exhausted = true;
      detail = exhaustedDetail(attempts, detail);
      eventDetail = { attempts, reason: 'retries_exhausted' };
    } else {
      nextAttemptAt = new Date(clock() + scanBackoffMs(attempts, { rng }));
      eventDetail = { attempts, nextAttemptAt: nextAttemptAt.toISOString() };
    }
  }

  // The verdict and its audit event are saved together or not at all: if the event cannot be written
  // the verdict is not recorded either, the document stays claimed until its lease runs out, and a later sweep tries again.
  // Only the first verdict is written: a concurrent or cut-off scan of the same document cannot overwrite it.
  const count = await saveScanOutcome(document, attempts, { status, detail, attempts: savedAttempts, nextAttemptAt, at, eventDetail });

  if (count) {
    // One line per document and per change, never one per retry: a permanent failure is logged when it happens, a
    // transient one only the first time it is seen (a later retry that fails the same way stays quiet).
    if (exhausted) {
      logExhausted(document, attempts);
    } else if (status === SCAN.FAILED) {
      console.error(`[scan] document ${documentId} (request ${document.serviceRequestId}) can never be scanned: ${detail}. It will not be retried; the patient must upload a replacement.`);
    } else if (status === SCAN.ERROR && document.scanStatus !== SCAN.ERROR) {
      console.warn(`[scan] document ${documentId} (request ${document.serviceRequestId}) could not be scanned for now: ${detail}. It stays unusable and will be retried.`);
    }
    if (status === SCAN.INFECTED) quarantineFile(document, file);
  }
  return { document: await prisma.requestDocument.findUnique({ where: { id: documentId } }), scannerDown };
}

// Scans one document with ClamAV. Fail closed: anything but a definite clean or infected verdict leaves the document
// unusable, as "error" (retried with backoff) or, for a permanent failure or after the last attempt, "failed" (final).
// Safe to call twice, or from two workers, for one document: only one of them gets the attempt (see claimScan), and a
// document that is backing off is returned as it is. A replaced (superseded) version is history and is never scanned.
async function scanRequestDocument(documentId, options) {
  return (await attemptScan(documentId, options)).document;
}

// Scans documents that are due: never scanned, or failed for now and past their backoff. Run by the worker.
// Documents with no schedule come first, then the one due longest ago. Replaced (superseded) versions are never swept, and
// "failed" documents are final, so neither is ever picked up again.
// ClamAV is asked PING before anything is claimed: while it is down the sweep scans nothing, uses up no attempt and
// resolves with scannerUnavailable: true. It stops early too if ClamAV goes away during the sweep.
// Resolves with { checked, scanned (clean or infected), failed (became permanent in this run, retries exhausted
// included), waiting (still retryable), due (documents that were due), scannerUnavailable }.
async function sweepPendingScans({ limit = 25, scanner, health, clock = Date.now, rng } = {}) {
  const now = clock();
  const due = await prisma.requestDocument.findMany({
    where: {
      scanStatus: { in: [SCAN.PENDING, SCAN.ERROR] }, supersededAt: null,
      OR: [{ scanNextAttemptAt: null }, { scanNextAttemptAt: { lte: new Date(now) } }],
    },
    orderBy: [{ scanNextAttemptAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
  });
  if (!due.length) return { checked: 0, scanned: 0, failed: 0, waiting: 0, due: 0, scannerUnavailable: false };

  const isScannerUp = health || (scanner ? async () => true : clamav.ping);
  if (!(await isScannerUp())) return { checked: 0, scanned: 0, failed: 0, waiting: 0, due: due.length, scannerUnavailable: true };

  let checked = 0;
  let scanned = 0;
  let failed = 0;
  let scannerUnavailable = false;
  for (const { id } of due) {
    try {
      const result = await attemptScan(id, { scanner, health, clock, ...(rng && { rng }) });
      const doc = result.document;
      if (doc && (doc.scanStatus === SCAN.CLEAN || doc.scanStatus === SCAN.INFECTED)) scanned += 1;
      else if (doc && doc.scanStatus === SCAN.FAILED) failed += 1;
      checked += 1;
      if (result.scannerDown) { scannerUnavailable = true; break; }
    } catch (err) {
      // One document that cannot be recorded must not stop the others: it stays waiting (its lease runs out).
      checked += 1;
      console.error(`[scan] document ${id}: ${err.message}`);
    }
  }
  return { checked, scanned, failed, waiting: checked - scanned - failed, due: due.length, scannerUnavailable };
}

// ---- admin: reading ---------------------------------------------------------------------------

const ADMIN_DOCUMENT_SELECT = {
  id: true, serviceRequestId: true, originalName: true, sizeBytes: true, mimeType: true, sha256: true, uploadedByUserId: true,
  uploadedAt: true, replacesId: true, supersededAt: true, scanStatus: true, scanEngine: true, scanDetail: true, scannedAt: true,
  reviewStatus: true, reviewedByAdminId: true, reviewedAt: true, rejectionReason: true, caseDocumentId: true,
};

function documentSummary(documents) {
  const current = documents.filter((d) => !d.supersededAt);
  return {
    current: current.length,
    awaitingScan: current.filter((d) => d.scanStatus === SCAN.PENDING || d.scanStatus === SCAN.ERROR).length,
    // The part of awaitingScan whose scan was attempted and failed (it is retried by the worker).
    scanErrors: current.filter((d) => d.scanStatus === SCAN.ERROR).length,
    // Scans that can never succeed (the file is gone or altered). They are final: only a replacement helps.
    scanFailed: current.filter((d) => d.scanStatus === SCAN.FAILED).length,
    infected: current.filter((d) => d.scanStatus === SCAN.INFECTED).length,
    awaitingReview: current.filter((d) => d.scanStatus === SCAN.CLEAN && d.reviewStatus === REVIEW.PENDING).length,
    approved: current.filter((d) => d.reviewStatus === REVIEW.APPROVED).length,
    rejected: current.filter((d) => d.reviewStatus === REVIEW.REJECTED).length,
  };
}

// The submissions in the review workflow, newest first. A request with no document yet
// ("awaiting_documents") is a DRAFT, not a submission: it is left out unless asked for with
// status=awaiting_documents. Every request with at least one uploaded document is listed, however far
// along it is (waiting for its scan, infected, waiting for review, changes requested...).
//
// `status` is one status or a comma-separated list of them (e.g. "in_review,changes_requested").
// `search` matches the request reference or the patient name (contains, case-insensitive).
const SEARCH_MAX = 100;

function listWhere({ status, search } = {}) {
  let statuses;
  if (status !== undefined && status !== '') {
    statuses = String(status).split(',').map((s) => s.trim());
    if (!statuses.length || statuses.some((s) => !REQUEST_STATUSES.includes(s))) {
      throw httpError(400, `Invalid status. Use one of: ${REQUEST_STATUSES.join(', ')}`);
    }
  }
  // LIKE wildcards in the typed text are matched literally (Prisma's `contains` does not escape them).
  const term = typeof search === 'string' ? search.trim().slice(0, SEARCH_MAX).replace(/[\\%_]/g, '\\$&') : '';
  return {
    AND: [
      statuses
        ? { reviewStatus: { in: statuses } }
        : { AND: [{ reviewStatus: { not: null } }, { reviewStatus: { not: REQUEST_STATUS.AWAITING_DOCUMENTS } }] },
      ...(term ? [{ OR: [{ referenceNumber: { contains: term } }, { patientName: { contains: term } }] }] : []),
    ],
  };
}

// How many requests match the same filters, ignoring limit and offset.
async function countReviewRequests({ status, search } = {}) {
  return prisma.serviceRequest.count({ where: listWhere({ status, search }) });
}

async function listReviewRequests({ status, search, limit = 50, offset = 0 } = {}) {
  const rows = await prisma.serviceRequest.findMany({
    where: listWhere({ status, search }),
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    skip: Math.max(Number(offset) || 0, 0),
    select: {
      id: true, referenceNumber: true, patientName: true, serviceType: true, urgency: true, origin: true, destination: true,
      preferredDate: true, reviewStatus: true, documentsRequestReason: true, createdAt: true, submittedAt: true, reviewedAt: true,
      requestDocuments: { select: { scanStatus: true, reviewStatus: true, supersededAt: true } },
    },
  });
  return rows.map(({ requestDocuments, ...request }) => ({ ...request, documents: documentSummary(requestDocuments) }));
}

async function getReviewRequest(requestId) {
  const id = numericId(requestId, 'The request');
  const request = await prisma.serviceRequest.findFirst({
    where: { id, reviewStatus: { not: null } },
    include: {
      user: { select: { id: true, name: true, email: true, mobile: true } },
      requestDocuments: { select: ADMIN_DOCUMENT_SELECT, orderBy: { id: 'asc' } },
      requestEvents: { orderBy: { id: 'asc' } },
      case: { select: { id: true, referenceNumber: true, status: true } },
    },
  });
  if (!request) throw httpError(404, 'Request not found');
  return { ...request, documentSummary: documentSummary(request.requestDocuments) };
}

// The file an Admin may open. Only a document whose scan said "clean" is ever returned: infected,
// unscanned, failed-scan and quarantined files are refused, for every Admin. The stored checksum is
// verified too (a missing checksum is refused), and the bytes returned are the very bytes that were
// hashed, so a file changed after its scan, or while it is being downloaded, is not served.
async function resolveAdminDownload({ requestId, documentId, adminId }) {
  const document = await prisma.requestDocument.findFirst({
    where: { id: numericId(documentId, 'The document'), serviceRequestId: numericId(requestId, 'The request') },
  });
  if (!document) throw httpError(404, 'Document not found');
  if (document.scanStatus !== SCAN.CLEAN) {
    throw httpError(409, `This document cannot be opened: its virus scan is "${document.scanStatus}".`, 'document_not_clean');
  }
  const buffer = await readVerifiedFile(document);
  await appendEvent(prisma, {
    serviceRequestId: document.serviceRequestId, documentId: document.id, action: ACTION.DOCUMENT_DOWNLOADED, actorType: 'admin', actorId: adminId,
  });
  return { buffer, name: document.originalName };
}

// ---- admin: decisions -------------------------------------------------------------------------

async function lockedOpenRequest(tx, requestId) {
  const request = await lockRequest(tx, numericId(requestId, 'The request'));
  if (!request || request.reviewStatus == null) throw httpError(404, 'Request not found');
  if (request.reviewStatus === REQUEST_STATUS.APPROVED) throw httpError(409, 'This request has already been approved.', 'request_approved');
  return request;
}

// Approves or rejects one clean, current document. A rejection (reason shown to the patient) puts
// the request into "changes_requested" until the patient replaces the document.
async function reviewDocument({ requestId, documentId, adminId, decision, reason }) {
  if (decision !== REVIEW.APPROVED && decision !== REVIEW.REJECTED) throw httpError(400, 'decision must be "approved" or "rejected".');
  const text = decision === REVIEW.REJECTED ? reasonOrThrow(reason) : null;
  const docId = numericId(documentId, 'The document');

  return prisma.$transaction(async (tx) => {
    const request = await lockedOpenRequest(tx, requestId);
    const document = await tx.requestDocument.findFirst({ where: { id: docId, serviceRequestId: request.id } });
    if (!document) throw httpError(404, 'Document not found');
    if (document.supersededAt) throw httpError(409, 'This document was replaced by a newer one.', 'document_superseded');
    if (document.scanStatus !== SCAN.CLEAN) {
      throw httpError(409, `Only a document whose virus scan is clean can be reviewed (scan: "${document.scanStatus}").`, 'document_not_clean');
    }
    const allowed = decision === REVIEW.APPROVED ? document.reviewStatus === REVIEW.PENDING : document.reviewStatus !== REVIEW.REJECTED;
    if (!allowed) throw httpError(409, `This document is already ${document.reviewStatus}.`, 'already_decided');

    const now = new Date();
    const updated = await tx.requestDocument.update({
      where: { id: document.id },
      data: { reviewStatus: decision, reviewedByAdminId: adminId, reviewedAt: now, rejectionReason: text },
      select: ADMIN_DOCUMENT_SELECT,
    });
    await appendEvent(tx, {
      serviceRequestId: request.id, documentId: document.id, actorType: 'admin', actorId: adminId,
      action: decision === REVIEW.APPROVED ? ACTION.DOCUMENT_APPROVED : ACTION.DOCUMENT_REJECTED,
      detail: { previous: document.reviewStatus, ...(text && { reason: text }) },
    });
    if (decision === REVIEW.REJECTED && request.reviewStatus !== REQUEST_STATUS.CHANGES_REQUESTED) {
      await tx.serviceRequest.update({ where: { id: request.id }, data: { reviewStatus: REQUEST_STATUS.CHANGES_REQUESTED, reviewedAt: now } });
      await appendEvent(tx, {
        serviceRequestId: request.id, action: ACTION.STATUS_CHANGED, fromStatus: request.reviewStatus, toStatus: REQUEST_STATUS.CHANGES_REQUESTED,
        actorType: 'admin', actorId: adminId,
      });
    }
    return updated;
  });
}

// Asks the patient for more documents. The reason is shown to the patient; the request cannot be
// approved until the patient uploads something. Only a submitted request that is in review can be asked:
//   - a draft ("awaiting_documents") has nothing submitted yet, and asking would turn it into a submission;
//   - a request already in "changes_requested" is waiting for the patient (an earlier ask, or a rejected
//     document), and a second ask would overwrite the reason the patient is reading.
// The checks run after the reason is validated and the request is found and locked, so a bad reason is
// still 400, an unknown request 404 and an approved one 409 `request_approved`.
async function requestAdditionalDocuments({ requestId, adminId, reason }) {
  const text = reasonOrThrow(reason);
  return prisma.$transaction(async (tx) => {
    const request = await lockedOpenRequest(tx, requestId);
    if (request.reviewStatus === REQUEST_STATUS.AWAITING_DOCUMENTS) {
      throw httpError(409, 'This request is still a draft: the patient has not uploaded a document yet, so documents cannot be requested.', 'request_is_draft');
    }
    if (request.reviewStatus === REQUEST_STATUS.CHANGES_REQUESTED) {
      throw httpError(409, 'The patient has already been asked for changes and has not responded yet. Wait for their upload before requesting more.', 'documents_request_already_pending');
    }
    const now = new Date();
    const updated = await tx.serviceRequest.update({
      where: { id: request.id }, data: { reviewStatus: REQUEST_STATUS.CHANGES_REQUESTED, documentsRequestReason: text, reviewedAt: now },
    });
    await appendEvent(tx, {
      serviceRequestId: request.id, action: ACTION.DOCUMENTS_REQUESTED, fromStatus: request.reviewStatus, toStatus: REQUEST_STATUS.CHANGES_REQUESTED,
      actorType: 'admin', actorId: adminId, detail: { reason: text },
    });
    return updated;
  });
}

// Why a request cannot be approved yet: [{ code, message, documentId? }], empty when it can.
function approvalBlockers(request, currentDocuments) {
  const blockers = [];
  if (request.reviewStatus === REQUEST_STATUS.AWAITING_DOCUMENTS) blockers.push({ code: 'no_documents', message: 'No document has been uploaded yet.' });
  if (request.reviewStatus === REQUEST_STATUS.CHANGES_REQUESTED) {
    blockers.push({ code: 'documents_requested', message: 'Documents were requested from the patient and have not been provided.' });
  }
  if (request.reviewStatus !== REQUEST_STATUS.AWAITING_DOCUMENTS && currentDocuments.length === 0) {
    blockers.push({ code: 'no_documents', message: 'The request has no current document.' });
  }
  for (const d of currentDocuments) {
    const label = `"${d.originalName}"`;
    if (d.scanStatus === SCAN.PENDING) blockers.push({ code: 'unscanned', documentId: d.id, message: `${label} has not been scanned yet.` });
    else if (d.scanStatus === SCAN.ERROR) blockers.push({ code: 'scan_failed', documentId: d.id, message: `${label} could not be scanned.` });
    else if (d.scanStatus === SCAN.INFECTED) blockers.push({ code: 'infected', documentId: d.id, message: `${label} failed the virus scan and is quarantined.` });
    else if (d.scanStatus === SCAN.FAILED) blockers.push({ code: 'scan_unrecoverable', documentId: d.id, message: `${label} can never be scanned (${d.scanDetail || 'its file is unusable'}). The patient needs to upload a replacement.` });
    else if (d.reviewStatus === REVIEW.PENDING) blockers.push({ code: 'awaiting_review', documentId: d.id, message: `${label} is waiting for review.` });
    else if (d.reviewStatus === REVIEW.REJECTED) blockers.push({ code: 'rejected', documentId: d.id, message: `${label} was rejected and has not been replaced.` });
  }
  return blockers;
}

// Approves the request and creates its Case, in one transaction. Safe to repeat: a request that is
// already approved returns its existing Case (the Case's serviceRequestId is unique, and the request
// row is locked, so two approvals can never create two Cases).
async function approveRequest({ requestId, adminId }) {
  // The timeout leaves room to re-hash every stored file while the request row is locked.
  return prisma.$transaction(async (tx) => {
    const request = await lockRequest(tx, numericId(requestId, 'The request'));
    if (!request || request.reviewStatus == null) throw httpError(404, 'Request not found');

    if (request.reviewStatus === REQUEST_STATUS.APPROVED) {
      const existing = await tx.case.findUnique({ where: { serviceRequestId: request.id } });
      return { request, case: existing, alreadyApproved: true };
    }

    const documents = await tx.requestDocument.findMany({ where: { serviceRequestId: request.id, supersededAt: null }, orderBy: { id: 'asc' } });
    const blockers = approvalBlockers(request, documents);
    if (request.reviewStatus !== REQUEST_STATUS.IN_REVIEW && !blockers.length) blockers.push({ code: 'not_in_review', message: 'The request is not in review.' });
    // Before a Case exists, every file must still be there and byte-identical to what was scanned: the
    // Case's documents are served later on the strength of this check.
    if (!blockers.length) {
      for (const d of documents) {
        const problem = await fileProblem(d);
        if (problem) blockers.push({ code: problem.code, documentId: d.id, message: `"${d.originalName}": ${problem.message}` });
      }
    }
    if (blockers.length) throw httpError(409, 'This request cannot be approved yet.', 'approval_blocked', { blockers });

    const created = await tx.case.create({
      data: {
        serviceRequestId: request.id,
        referenceNumber: `TEMP-${Date.now()}-${randomSuffix()}`,
        patientName: request.patientName,
        patientAge: request.patientAge,
        patientGender: request.patientGender,
        patientContact: request.patientContact,
        serviceType: request.serviceType,
        origin: request.origin,
        destination: request.destination,
        country: request.country,
        careLevel: request.careLevel,
        description: request.description,
        // Left out when the request has none, so the Case keeps its own 'routine' default.
        ...(request.urgency && { urgency: URGENCY_TO_CASE[request.urgency] }),
        status: 'submitted',
      },
    });
    const caseRecord = await tx.case.update({ where: { id: created.id }, data: { referenceNumber: `CASE-${1000 + created.id}` } });
    await tx.caseStageEvent.create({
      data: { caseId: caseRecord.id, stage: 'submitted', note: `Case opened after Admin approval of ${request.referenceNumber}.` },
    });
    for (const d of documents) {
      const row = await tx.document.create({
        data: { caseId: caseRecord.id, type: 'Medical Report', name: d.originalName, fileUrl: `/uploads/${d.storageKey}`, fileSizeBytes: d.sizeBytes },
      });
      await tx.requestDocument.update({ where: { id: d.id }, data: { caseDocumentId: row.id } });
    }

    const updated = await tx.serviceRequest.update({
      where: { id: request.id }, data: { reviewStatus: REQUEST_STATUS.APPROVED, reviewedAt: new Date(), documentsRequestReason: null },
    });
    await appendEvent(tx, {
      serviceRequestId: request.id, action: ACTION.REQUEST_APPROVED, fromStatus: request.reviewStatus, toStatus: REQUEST_STATUS.APPROVED,
      actorType: 'admin', actorId: adminId, detail: { documents: documents.length },
    });
    await appendEvent(tx, {
      serviceRequestId: request.id, action: ACTION.CASE_CREATED, actorType: 'admin', actorId: adminId,
      detail: { caseId: caseRecord.id, caseReference: caseRecord.referenceNumber },
    });
    return { request: updated, case: caseRecord, alreadyApproved: false };
  }, { timeout: 30000, maxWait: 10000 });
}

module.exports = {
  createReviewRequest, addPatientDocument, toUploadResponse, scanRequestDocument, sweepPendingScans,
  listReviewRequests, countReviewRequests, getReviewRequest, resolveAdminDownload, reviewDocument, requestAdditionalDocuments, approveRequest,
  approvalBlockers, documentSummary, QUARANTINE_DIR,
};
