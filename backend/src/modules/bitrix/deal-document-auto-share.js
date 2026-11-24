// AUTOMATIC sharing of patient documents with the Bitrix24 Deal. A document is authorized for sharing by the SYSTEM as soon as two things are both true: its malware scan
// is "clean", and its request has a Case with a Deal link (which exists from the request's approval; the Deal itself may be created later: the document worker waits for it).
// It adds NO sharing rule of its own: it calls the EXISTING authorizeShare (deal-document.service.js, with `automation: true`), so the request row lock, the clean-scan
// gate, the file and checksum verification, the one-share-per-(Deal, document, generation) uniqueness, the idempotent outbox event and the audit entries are the existing
// code. The Bitrix attachment, its retries, its read-back reconciliation and the preservation of files already on the Deal are the existing document worker, unchanged.
//
// A document is shared only when ALL hold: scan clean; not rejected (Admin review itself is NOT required); not replaced; belongs to the request given; the request is
// approved and has a Deal link; no share exists yet (an active, failed or REVOKED share is never replaced here: an Admin who revoked a document is obeyed, and a failed
// share is retried by the worker or an Admin). Infected, pending, error and failed scans can never be "clean", so they can never be shared.
//
// WHEN IT RUNS (every call is idempotent, so the order of events does not matter):
//   afterScanClean(documentId)       after a document's scan turned "clean" (request-review.service attemptScan): the Case and Deal link exist already
//   afterRequestApproved(requestId)  after a request's approval committed (approveRequest): documents scanned before the Case existed
//   sweep()                          a safety net, run before every document-worker pass: any clean document of an approved request still without a share
// The hooks are best-effort: they never throw and never change the outcome of the scan or the approval.
//
// SWITCH AND ACTOR: DOCUMENT_AUTO_SHARE must be exactly "true" (OFF by default), DOCUMENT_AUTO_SHARE_ADMIN_ID names the existing Admin the sharing acts as (re-verified on EVERY
// run: role "admin", status "active", not disabled, not locked), and it works ONLY against the local development database: it refuses under NODE_ENV=production, and
// unless DATABASE_URL names humancare_dev on a loopback host AND the database server itself answers SELECT DATABASE() = humancare_dev. Audit rows say actor type "system",
// source "document_auto_share". Nothing here calls Bitrix24 or changes or deletes a document.
const { prisma: defaultPrisma } = require('../../db/prisma');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { developmentDatabaseProblem } = require('../../common/safety/single-stage-runner');

const REQUIRED_DATABASE = 'humancare_dev';
const SWEEP_LIMIT = 20;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const codeOf = (err) => (err && ((typeof err.publicCode === 'string' && SAFE_CODE.test(err.publicCode) && err.publicCode) || (typeof err.code === 'string' && SAFE_CODE.test(err.code) && err.code) || (typeof err.name === 'string' && SAFE_CODE.test(err.name) && err.name))) || 'error';

/** { settings: { adminId } } or { problem } (a short code, never a value). `switch_off` is the normal, quiet state. */
function readSettings(env = process.env) {
  if (env.DOCUMENT_AUTO_SHARE !== 'true') return { problem: 'switch_off' };
  if (env.NODE_ENV === 'production') return { problem: 'refused_in_production' };
  const databaseProblem = developmentDatabaseProblem(env);
  if (databaseProblem) return { problem: databaseProblem };
  const adminText = env.DOCUMENT_AUTO_SHARE_ADMIN_ID;
  if (typeof adminText !== 'string' || !/^[1-9]\d{0,9}$/.test(adminText)) return { problem: 'admin_id_missing_or_invalid' };
  return { settings: { adminId: Number(adminText) } };
}

function buildContext(overrides = {}) {
  return { prisma: defaultPrisma, env: process.env, now: () => new Date(), log: console, authorize: null, ...overrides };
}

// null when the designated Admin may act, otherwise a short code.
async function adminProblem(ctx, adminId) {
  const admin = await ctx.prisma.adminUser.findUnique({ where: { id: adminId }, select: { id: true, role: true, status: true, disabledAt: true, lockedUntil: true } });
  if (!admin) return 'admin_not_found';
  if (admin.role !== 'admin') return 'admin_role_not_admin';
  if (admin.status !== 'active') return 'admin_not_active';
  if (admin.disabledAt) return 'admin_disabled';
  if (admin.lockedUntil && new Date(admin.lockedUntil) > ctx.now()) return 'admin_locked';
  return null;
}

async function databaseIsDevelopment(ctx) {
  try {
    const rows = await ctx.prisma.$queryRaw`SELECT DATABASE() AS db`;
    return Boolean(rows && rows[0] && rows[0].db === REQUIRED_DATABASE);
  } catch { return false; }
}

// -> { ok: true, adminId } | { ok: false, code }. Every call: the switch, the environment, the live database and the Admin.
async function gate(ctx) {
  const { settings, problem } = readSettings(ctx.env);
  if (problem) return { ok: false, code: problem };
  if (!(await databaseIsDevelopment(ctx))) return { ok: false, code: 'database_not_humancare_dev' };
  const blocked = await adminProblem(ctx, settings.adminId);
  if (blocked) return { ok: false, code: blocked };
  return { ok: true, adminId: settings.adminId };
}

const authorizeOf = (ctx) => ctx.authorize || require('./deal-document.service').authorizeShare;

// One document of a request, already past the gate. Never throws for a data-driven refusal.
async function shareOne(ctx, adminId, { requestId, documentId }) {
  try {
    const result = await authorizeOf(ctx)({ requestId, documentId, adminId, automation: true });
    if (result.alreadyAuthorized) return { documentId, outcome: result.revoked ? 'revoked_by_admin' : 'already_shared', shareId: result.share && result.share.id };
    return { documentId, outcome: 'shared', shareId: result.share.id };
  } catch (err) {
    // Not ready yet (the request is not approved, or its Deal link does not exist yet): normal, a later hook or the sweep tries again.
    if (err && (err.publicCode === 'request_not_approved' || err.publicCode === 'no_deal_link')) return { documentId, outcome: 'not_ready', code: err.publicCode };
    if (err && err.statusCode && err.statusCode < 500) return { documentId, outcome: 'refused', code: codeOf(err) };
    ctx.log.error(`[document-auto-share] document ${documentId}: ${codeOf(err)}`);
    return { documentId, outcome: 'error', code: codeOf(err) };
  }
}

/** One document (the scan-clean hook). Resolves { outcome, ... }; never throws. */
async function autoShareDocument(documentId, overrides = {}) {
  const ctx = buildContext(overrides);
  try {
    const open = await gate(ctx);
    if (!open.ok) return { outcome: 'disabled', code: open.code };
    const document = await ctx.prisma.requestDocument.findUnique({ where: { id: Number(documentId) }, select: { id: true, serviceRequestId: true, scanStatus: true, reviewStatus: true, supersededAt: true } });
    if (!document) return { outcome: 'not_found' };
    if (document.scanStatus !== 'clean') return { documentId: document.id, outcome: 'not_clean' };
    if (document.reviewStatus === 'rejected') return { documentId: document.id, outcome: 'rejected' };
    if (document.supersededAt) return { documentId: document.id, outcome: 'superseded' };
    return await shareOne(ctx, open.adminId, { requestId: document.serviceRequestId, documentId: document.id });
  } catch (err) {
    ctx.log.error(`[document-auto-share] document ${documentId}: ${codeOf(err)}`);
    return { outcome: 'error', code: codeOf(err) };
  }
}

/** Every eligible document of ONE request (the approval hook). Resolves { outcome, results }; never throws. */
async function autoShareRequest(requestId, overrides = {}) {
  const ctx = buildContext(overrides);
  try {
    const open = await gate(ctx);
    if (!open.ok) return { outcome: 'disabled', code: open.code, results: [] };
    const documents = await ctx.prisma.requestDocument.findMany({
      where: { serviceRequestId: Number(requestId), scanStatus: 'clean', supersededAt: null, reviewStatus: { not: 'rejected' } }, orderBy: { id: 'asc' }, select: { id: true },
    });
    const results = [];
    for (const { id } of documents) results.push(await shareOne(ctx, open.adminId, { requestId: Number(requestId), documentId: id }));
    return { outcome: 'done', results };
  } catch (err) {
    ctx.log.error(`[document-auto-share] request ${requestId}: ${codeOf(err)}`);
    return { outcome: 'error', code: codeOf(err), results: [] };
  }
}

/** The safety net: clean, current, non-rejected documents of approved Private Charter requests that have a Deal link and NO share at all. `requestIds` narrows it. */
async function sweep(overrides = {}) {
  const ctx = buildContext(overrides);
  try {
    const open = await gate(ctx);
    if (!open.ok) return { outcome: 'disabled', code: open.code, results: [] };
    const documents = await ctx.prisma.requestDocument.findMany({
      where: {
        scanStatus: 'clean', supersededAt: null, reviewStatus: { not: 'rejected' }, dealShares: { none: {} },
        ...(overrides.requestIds ? { serviceRequestId: { in: overrides.requestIds } } : {}),
        serviceRequest: { is: { serviceKey: PRIVATE_CHARTER_KEY, reviewStatus: 'approved', case: { is: { bitrixDealLink: { isNot: null } } } } },
      },
      orderBy: { id: 'asc' }, take: overrides.limit || SWEEP_LIMIT, select: { id: true, serviceRequestId: true },
    });
    const results = [];
    for (const document of documents) results.push(await shareOne(ctx, open.adminId, { requestId: document.serviceRequestId, documentId: document.id }));
    return { outcome: 'done', results };
  } catch (err) {
    ctx.log.error(`[document-auto-share] sweep: ${codeOf(err)}`);
    return { outcome: 'error', code: codeOf(err), results: [] };
  }
}

// The hooks used by the scan and the approval: best-effort, silent while the switch is off, and they can never throw.
const afterScanClean = (documentId, overrides) => autoShareDocument(documentId, overrides).catch(() => ({ outcome: 'error' }));
const afterRequestApproved = (requestId, overrides) => autoShareRequest(requestId, overrides).catch(() => ({ outcome: 'error', results: [] }));

module.exports = { readSettings, adminProblem, gate, autoShareDocument, autoShareRequest, sweep, afterScanClean, afterRequestApproved, REQUIRED_DATABASE, SWEEP_LIMIT };
