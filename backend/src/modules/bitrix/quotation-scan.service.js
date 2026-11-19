// Malware scanning of quotation PDFs, reusing the existing ClamAV client (integrations/clamav) and the retry policy of the request
// document scan (request-review.config.js SCAN_RETRY: lease, exponential backoff with jitter, at most 10 attempts).
//
// A quotation is eligible for confirmation or publication ONLY with scan_status "clean": case_quotations_confirmed_chk makes the
// database itself refuse a confirmed, published, accepted, rejected or superseded row that is not clean. This service only ever sets
// pending -> clean | infected | error.
//
// scan_status vocabulary is fixed by the table's CHECK (pending | clean | infected | error), so:
//   pending                         never scanned, or being scanned (scan_next_attempt_at is then a lease)
//   error + scan_next_attempt_at    failed for now: retried after that time
//   error + scan_next_attempt_at NULL   FINAL: retries exhausted, or the file is missing or altered. The sweep never picks it up again;
//                                   only a replacement file (a new sync result) resets the row to pending.
//   infected                        final: the file is moved to uploads/quarantine/quotations/... and nobody can confirm the row.
//
// The scan is bound to the stored checksum: the file must equal sha256 before it is scanned and be unchanged after, and every write is
// fenced on (id, storage_key, sha256, the attempt number), so a result for a file that was replaced meanwhile is discarded.
const fs = require('fs');
const path = require('path');
const { prisma: defaultPrisma } = require('../../db/prisma');
const clamav = require('../../integrations/clamav/clamav');
const { SCAN_RETRY, scanBackoffMs, isStorageErrorCode } = require('../request-review/request-review.config');
const { isQuotationSyncActive } = require('./bitrix-config');
const { appendAuditLog } = require('../../common/audit/business-audit');
const { createLocalStorage, hashFile } = require('./quotation-storage');

const SCAN = { PENDING: 'pending', CLEAN: 'clean', INFECTED: 'infected', ERROR: 'error' };
const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

function buildContext(overrides = {}) {
  return { prisma: defaultPrisma, storage: null, scanner: clamav.scanFile, health: clamav.ping, clock: Date.now, rng: Math.random, log: console, env: process.env, ...overrides };
}
// What a log line may say about an error: its name, a Prisma / system code (P2002, EIO ...) and, for a constraint failure, the NAME of the
// constraint or columns (meta.target). Never the message (it can quote values), the query, the parameters or any file content.
const SAFE_TOKEN = /[^A-Za-z0-9_.,:-]/g;
function describeError(err) {
  if (!err) return 'error';
  const parts = [String(err.name || 'error').replace(SAFE_TOKEN, '_').slice(0, 60)];
  if (typeof err.code === 'string' && err.code) parts.push(`code=${err.code.replace(SAFE_TOKEN, '_').slice(0, 20)}`);
  const target = err.meta && err.meta.target;
  const text = Array.isArray(target) ? target.filter((t) => typeof t === 'string').join(',') : typeof target === 'string' ? target : '';
  if (text) parts.push(`target=${text.replace(SAFE_TOKEN, '_').slice(0, 120)}`);
  return parts.join(' ');
}
const storageOf = (ctx) => ctx.storage || (ctx.storage = createLocalStorage());

// The identity of ONE stored file: its storage key without the folder and extension ("ev466-<sha256>"). A storage key is unique per stored
// object (the table has UNIQUE storage_key) and is derived from the sync event that stored it, so two versions or two replacements with the
// SAME PDF bytes (an amount-only change keeps the sha256) have different identities, while a repeated scan of the SAME stored file has the same
// one and stays idempotent. Anything unexpected is hashed, so the key is always a short, safe token.
function fileIdentity(row) {
  const name = String(row.storageKey || '').split('/').pop().replace(/\.pdf$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) ? name : require('crypto').createHash('sha256').update(String(row.storageKey)).digest('hex');
}
const scanAuditKey = (action, row) => `${action}:${row.id}:${fileIdentity(row)}`;

function scanAudit(action, row, reasonCode) {
  return {
    caseId: row.caseId, entityType: 'case_quotation', entityId: row.id, action, actorType: 'system', source: 'quotation_scan', reasonCode,
    afterData: { quotationId: row.id, versionNumber: row.versionNumber, scanStatus: action === 'quotation.scan_clean' ? 'clean' : action === 'quotation.scan_infected' ? 'infected' : 'error', caseId: row.caseId, sizeBytes: row.sizeBytes },
    idempotencyKey: scanAuditKey(action, row),
  };
}

// Writes one outcome, fenced on the file's identity and the attempt. Resolves true when it was recorded.
async function saveOutcome(ctx, row, attempts, { status, detail, nextAt = null, audit = null, definite = false }) {
  return ctx.prisma.$transaction(async (tx) => {
    const { count } = await tx.caseQuotation.updateMany({
      where: { id: row.id, storageKey: row.storageKey, sha256: row.sha256, scanAttempts: attempts, scanStatus: { in: [SCAN.PENDING, SCAN.ERROR] } },
      data: {
        scanStatus: status, scanEngine: clamav.ENGINE, scanDetail: clip(detail, 255), scannedAt: definite ? new Date(ctx.clock()) : null,
        scanNextAttemptAt: nextAt ? new Date(nextAt) : null, revision: { increment: 1 },
      },
    });
    if (count !== 1) return false;
    if (audit) await appendAuditLog(tx, audit);
    return true;
  });
}

async function claimScan(ctx, id) {
  const row = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!row || (row.scanStatus !== SCAN.PENDING && row.scanStatus !== SCAN.ERROR)) return { claimed: false, row };
  const now = ctx.clock();
  if (row.scanStatus === SCAN.ERROR && !row.scanNextAttemptAt) return { claimed: false, row }; // final
  if (row.scanNextAttemptAt && +row.scanNextAttemptAt > now) return { claimed: false, row }; // backing off, or another worker holds the lease

  if (row.scanAttempts >= SCAN_RETRY.maxAttempts) {
    const done = await saveOutcome(ctx, row, row.scanAttempts, {
      status: SCAN.ERROR, detail: `retries_exhausted after ${row.scanAttempts} attempts`, audit: scanAudit('quotation.scan_failed', row, 'retries_exhausted'),
    });
    if (done) ctx.log.error(`[ALERT] quotation ${row.id}: the malware scan failed after ${row.scanAttempts} attempts and will not be retried.`);
    return { claimed: false, row, exhausted: done };
  }
  const attempts = row.scanAttempts + 1;
  const { count } = await ctx.prisma.caseQuotation.updateMany({
    where: { id, scanStatus: row.scanStatus, scanAttempts: row.scanAttempts, scanNextAttemptAt: row.scanNextAttemptAt, storageKey: row.storageKey, sha256: row.sha256 },
    data: { scanAttempts: attempts, scanNextAttemptAt: new Date(now + SCAN_RETRY.leaseMs) },
  });
  return count ? { claimed: true, row, attempts } : { claimed: false, row }; // lost the race
}

const retryAt = (ctx, attempts) => ctx.clock() + scanBackoffMs(attempts, { rng: ctx.rng });

async function attemptScan(ctx, id) {
  const claim = await claimScan(ctx, id);
  if (!claim.claimed) return { id, outcome: claim.exhausted ? 'exhausted' : 'not_claimed' };
  const { row, attempts } = claim;
  const storage = storageOf(ctx);

  let verdict;
  try {
    const file = storage.pathOf(row.storageKey);
    const before = await hashFile(file);
    if (before !== row.sha256) verdict = { final: true, detail: 'the stored file does not match its checksum' };
    else {
      verdict = await ctx.scanner(file);
      if (verdict && verdict.status === SCAN.CLEAN && (await hashFile(file)) !== before) verdict = { final: true, detail: 'the file changed while it was being scanned' };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Missing file: if the storage folder itself is there the file is really gone (final); otherwise the storage is in trouble and no attempt is used up.
      const folderOk = await fs.promises.stat(path.dirname(storage.pathOf(row.storageKey))).then(() => true, () => false);
      verdict = folderOk ? { final: true, detail: 'the stored file is missing' } : { storage: true, detail: 'the quotation storage is not reachable' };
    } else if (isStorageErrorCode(err && err.code)) verdict = { storage: true, detail: `storage error (${err.code})` };
    else verdict = { retry: true, detail: `the scan could not be completed (${clip((err && (err.code || err.message)) || 'error', 80)})` };
  }

  if (verdict.final) {
    const done = await saveOutcome(ctx, row, attempts, { status: SCAN.ERROR, detail: verdict.detail, audit: scanAudit('quotation.scan_failed', row, 'file_unverifiable') });
    if (done) ctx.log.error(`[ALERT] quotation ${row.id}: the malware scan cannot succeed (${verdict.detail}). A replacement file is needed.`);
    return { id, outcome: done ? 'failed' : 'discarded' };
  }
  if (verdict.storage) {
    // Not this file's fault: give the attempt back and look again later.
    await saveOutcome(ctx, row, attempts, { status: SCAN.ERROR, detail: verdict.detail, nextAt: ctx.clock() + SCAN_RETRY.storageRecheckMs }).then(async (ok) => {
      if (ok) await ctx.prisma.caseQuotation.updateMany({ where: { id: row.id, storageKey: row.storageKey, sha256: row.sha256 }, data: { scanAttempts: attempts - 1 } });
    });
    return { id, outcome: 'storage_unavailable' };
  }
  if (verdict.status === SCAN.CLEAN) {
    const done = await saveOutcome(ctx, row, attempts, { status: SCAN.CLEAN, detail: 'stream: OK', definite: true, audit: scanAudit('quotation.scan_clean', row, 'clean') });
    return { id, outcome: done ? 'clean' : 'discarded' };
  }
  if (verdict.status === SCAN.INFECTED) {
    const done = await saveOutcome(ctx, row, attempts, { status: SCAN.INFECTED, detail: `infected: ${clip(verdict.signature, 120)}`, definite: true, audit: scanAudit('quotation.scan_infected', row, 'infected') });
    if (done) {
      ctx.log.error(`[ALERT] quotation ${row.id}: malware detected; the file is quarantined and the version can never be confirmed.`);
      try { await storage.quarantine(row.storageKey); } catch (err) { ctx.log.error(`[ALERT] quotation ${row.id}: the infected file could not be moved to quarantine (${(err && err.code) || 'error'}); it must be moved by hand.`); }
    }
    return { id, outcome: done ? 'infected' : 'discarded' };
  }
  // The scanner could not give a verdict (down, timeout, unexpected answer): retried with a growing delay.
  const detail = clip((verdict && verdict.detail) || verdict.status || 'no verdict', 200);
  await saveOutcome(ctx, row, attempts, { status: SCAN.ERROR, detail, nextAt: retryAt(ctx, attempts) });
  return { id, outcome: 'retry' };
}

/** Scans quotation versions that are due. `caseIds` limits the sweep to those Cases and `quotationIds` to those quotations (the scoped runner). While ClamAV is down nothing is
 * claimed and no attempt is used up. Does nothing at all unless the quotation switch is on. */
async function sweepPendingQuotationScans(overrides = {}) {
  const ctx = buildContext(overrides);
  if (!isQuotationSyncActive(ctx.env)) return { active: false, checked: 0 };
  const now = new Date(ctx.clock());
  const due = await ctx.prisma.caseQuotation.findMany({
    where: {
      ...(overrides.caseIds ? { caseId: { in: overrides.caseIds } } : {}),
      ...(overrides.quotationIds ? { id: { in: overrides.quotationIds } } : {}), // the scoped runner can pin a pass to named quotations
      OR: [
        { scanStatus: SCAN.PENDING, OR: [{ scanNextAttemptAt: null }, { scanNextAttemptAt: { lte: now } }] },
        { scanStatus: SCAN.ERROR, scanNextAttemptAt: { lte: now } }, // a final error has no time, so it is never due
      ],
    },
    orderBy: { id: 'asc' }, take: overrides.limit || 25, select: { id: true },
  });
  if (!due.length) return { active: true, checked: 0, due: 0, results: [] };
  if (!(await ctx.health())) return { active: true, checked: 0, due: due.length, scannerUnavailable: true, results: [] };
  const results = [];
  for (const { id } of due) {
    try { results.push(await attemptScan(ctx, id)); } catch (err) { ctx.log.error(`[quotation-scan] quotation ${id}: ${describeError(err)}`); }
  }
  return { active: true, checked: results.length, due: due.length, results };
}

module.exports = { sweepPendingQuotationScans, attemptScan, claimScan, scanAuditKey, describeError, SCAN };
