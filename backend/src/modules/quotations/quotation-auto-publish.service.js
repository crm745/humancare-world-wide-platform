// Automatic confirmation and publication of a Private Charter quotation after a CLEAN scan. It adds NO rule of its own to a quotation: it decides only
// WHETHER an Admin action may be taken for a person, and then calls the EXISTING confirmQuotation and publishQuotation (quotations.service.js), unchanged
// except for their optional `automation` marker, which only changes who the audit row says acted (actor type "system", source "quotation_auto"; the
// designated Admin's id and role are still recorded). So the clean-scan gate, the amount / currency / validation rules, the file-hash check, the Case lock,
// the revision compare-and-set, the idempotent audit rows, the single "quotation_ready" notification and the push all come from the one existing code.
//
// A version is acted on ONLY when EVERY rule passes; anything else is left exactly as it is for a person (or the next sweep):
//   switch      QUOTATION_AUTO_PUBLISH=true, an explicit cutoff, the designated Admin, local humancare_dev only, never production (quotation-auto-publish.config.js)
//   admin       the designated Admin (id from the configuration) exists, role "admin" (never a superadmin), status "active", not disabled, not locked: re-read on EVERY
//               sweep and again before each of the two actions
//   version     the HEAD version of its Case, a draft, scan "clean", amount and currency present, no validation error, created at or after the cutoff
//   settled     its scan finished at least SETTLE seconds ago (default and minimum 120). Any change of the PDF, amount or currency resets the scan, so a version
//               that changed lately has a recent (or no) scan time
//   bitrix      the Deal is read live (read only) and must be the Case's Deal of the actual pipeline (Category 0), sit in the stage "Quoted" (UC_R55CKV) and still hold
//               EXACTLY this file, amount and currency
//   case        an open, eligible Private Charter Case with NO accepted live quotation and NO invoice (those need a person)
// It never creates an invoice or a payment, never writes to Bitrix, never starts a charge. A version a PERSON confirmed (and did not publish) is left alone: only a
// confirmation this sweep itself made (its own audit row for this exact revision) is carried on to publication.
const { prisma: defaultPrisma } = require('../../db/prisma');
const bitrixDealApi = require('../bitrix/bitrix-deal.api');
const { isQuotationSyncActive } = require('../bitrix/bitrix-config');
const { assertDealEligible } = require('../bitrix/deal-outbox');
const { linkProfileProblem, dealProblem } = require('../bitrix/bitrix-profile-runtime');
const { quotationFieldsForProfile, readQuotationSignature, sameAsHead, NO_FILE } = require('../bitrix/quotation-outbox');
const { sendExpoPush } = require('../../integrations/push/expo-push.service');
const quotations = require('./quotations.service');
const { readSettings, REQUIRED_STAGE_ID, REQUIRED_DATABASE } = require('./quotation-auto-publish.config');

const BATCH = 10;
const CLOSED_CASE_STATUSES = new Set(['completed', 'cancelled']);
const SAFE_TOKEN = /[^A-Za-z0-9_.,:-]/g;

function buildContext(overrides = {}) {
  return { prisma: defaultPrisma, api: bitrixDealApi, push: sendExpoPush, storage: null, env: process.env, now: () => new Date(), log: console, ...overrides };
}

// What a log line may say about an error: its name and code. Never the message (it can quote values) or any query.
const describe = (err) => [String((err && err.name) || 'error').replace(SAFE_TOKEN, '_').slice(0, 60), ...(err && typeof err.code === 'string' ? [`code=${err.code.replace(SAFE_TOKEN, '_').slice(0, 20)}`] : [])].join(' ');

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

// The DATABASE SERVER's own answer, not just the URL.
async function databaseIsDevelopment(ctx) {
  try {
    const rows = await ctx.prisma.$queryRaw`SELECT DATABASE() AS db`;
    return Boolean(rows && rows[0] && rows[0].db === REQUIRED_DATABASE);
  } catch { return false; }
}

// Did THIS sweep confirm this exact revision? (Its own audit row; a person's confirmation is never carried on to publication.)
async function confirmedByAutomation(ctx, q) {
  if (q.revision < 1) return false;
  const row = await ctx.prisma.auditLog.findFirst({
    where: { entityType: 'case_quotation', entityId: String(q.id), action: 'quotation.confirmed', source: 'quotation_auto', idempotencyKey: `quotation.confirmed:${q.id}:r${q.revision - 1}` },
    select: { id: true },
  });
  return Boolean(row);
}

// One quotation. Resolves { id, outcome } where outcome is a short code. Never throws for data-driven refusals.
async function processOne(ctx, settings, id) {
  const done = (outcome) => ({ id, outcome });
  const q = await ctx.prisma.caseQuotation.findUnique({ where: { id } });
  if (!q || (q.status !== 'draft' && q.status !== 'confirmed')) return done('not_working_version');
  if (q.status === 'confirmed' && !(await confirmedByAutomation(ctx, q))) return done('confirmed_by_person');

  // The version itself.
  const head = await ctx.prisma.caseQuotation.findFirst({ where: { caseId: q.caseId }, orderBy: { versionNumber: 'desc' }, select: { id: true } });
  if (!head || head.id !== q.id) return done('not_head_version');
  if (q.scanStatus !== 'clean') return done('scan_not_clean');
  if (q.amount == null || q.currency == null || q.validationError) return done('quotation_invalid');
  if (new Date(q.createdAt) < settings.from) return done('before_cutoff');
  const settledSince = new Date(Math.max(+new Date(q.createdAt), q.scannedAt ? +new Date(q.scannedAt) : Infinity));
  if (!q.scannedAt || ctx.now().getTime() - settledSince.getTime() < settings.settleSeconds * 1000) return done('not_settled');

  // The Case.
  const caseRecord = await ctx.prisma.case.findFirst({ where: { id: q.caseId }, include: { serviceRequest: true } });
  if (!caseRecord) return done('case_not_found');
  try { assertDealEligible(caseRecord, caseRecord.serviceRequest); } catch { return done('case_not_eligible'); }
  if (CLOSED_CASE_STATUSES.has(caseRecord.status)) return done('case_closed');
  if (await ctx.prisma.caseQuotation.findFirst({ where: { caseId: q.caseId, liveSlot: 1, status: 'accepted' }, select: { id: true } })) return done('accepted_quotation_live');
  if (await ctx.prisma.invoice.findFirst({ where: { caseId: q.caseId }, select: { id: true } })) return done('case_has_invoice');

  // Bitrix, read only: the Deal must be this Case's Deal, in the stage "Quoted", still holding exactly this file, amount and currency.
  const fields = quotationFieldsForProfile(settings.profile);
  const link = await ctx.prisma.bitrixDealLink.findUnique({ where: { caseId: q.caseId } });
  if (!link || !link.bitrixDealId || link.bitrixDealId !== q.bitrixDealId) return done('deal_not_linked');
  if (linkProfileProblem(link, settings.profile)) return done('deal_profile_mismatch');
  const read = await ctx.api.getDeal(q.bitrixDealId, { env: ctx.env });
  if (read.status !== 'ok') return done('bitrix_unavailable');
  if (dealProblem(settings.profile, read.deal, q.bitrixDealId, caseRecord.referenceNumber)) return done('deal_mismatch');
  if (read.deal.STAGE_ID !== REQUIRED_STAGE_ID) return done('stage_not_quoted');
  const signature = readQuotationSignature(read.deal, fields);
  if (signature.fileId === NO_FILE || signature.fileId === 'invalid' || !sameAsHead(signature, q)) return done('bitrix_content_differs');

  const act = { adminId: settings.adminId, adminRole: 'admin', automation: true };
  const deps = { prisma: ctx.prisma, storage: ctx.storage || undefined, now: ctx.now, push: ctx.push, log: ctx.log };
  let revision = q.revision;
  let confirmedNow = false;
  try {
    if (q.status === 'draft') {
      if (await adminProblem(ctx, settings.adminId)) return done('admin_unusable');
      const result = await quotations.confirmQuotation({ quotationId: q.id, revision: q.revision, ...act }, deps);
      confirmedNow = !result.alreadyConfirmed;
      revision = result.quotation.revision;
    }
    if (await adminProblem(ctx, settings.adminId)) return done('admin_unusable');
    const published = await quotations.publishQuotation({ quotationId: q.id, revision, ...act }, deps);
    return done(published.alreadyPublished ? 'already_published' : 'published');
  } catch (err) {
    if (err && err.statusCode && err.publicCode) return done(`refused:${String(err.publicCode).replace(SAFE_TOKEN, '_').slice(0, 40)}${confirmedNow ? ':confirmed' : ''}`);
    throw err;
  }
}

let running = false; // one pass at a time within this process; across processes the Case lock and the compare-and-set decide

/** One sweep. Resolves { active, code?, checked, results }. While the switch is off, or anything about the configuration, the database or the designated Admin is not
 *  exactly right, nothing is read beyond that check and nothing is written. */
async function sweepQuotationAutoPublish(overrides = {}) {
  const ctx = buildContext(overrides);
  const { settings, problem } = readSettings(ctx.env);
  if (problem) return { active: false, code: problem, checked: 0, results: [] };
  if (!isQuotationSyncActive(ctx.env)) return { active: false, code: 'quotation_sync_inactive', checked: 0, results: [] };
  if (running) return { active: true, skipped: 'already_running', checked: 0, results: [] };
  running = true;
  try {
    if (!(await databaseIsDevelopment(ctx))) return { active: false, code: 'database_not_humancare_dev', checked: 0, results: [] };
    const blocked = await adminProblem(ctx, settings.adminId);
    if (blocked) return { active: true, code: blocked, checked: 0, results: [] };

    const cutoff = new Date(ctx.now().getTime() - settings.settleSeconds * 1000);
    const due = await ctx.prisma.caseQuotation.findMany({
      where: {
        ...(overrides.quotationIds ? { id: { in: overrides.quotationIds } } : {}),
        ...(overrides.caseIds ? { caseId: { in: overrides.caseIds } } : {}), // a one-time runner limits a pass to the Cases it was given
        status: { in: ['draft', 'confirmed'] }, scanStatus: 'clean', createdAt: { gte: settings.from }, scannedAt: { lte: cutoff },
        amount: { not: null }, currency: { not: null }, validationError: null,
      },
      orderBy: { id: 'asc' }, take: overrides.limit || BATCH, select: { id: true },
    });
    const results = [];
    for (const { id } of due) {
      try { results.push(await processOne(ctx, settings, id)); } catch (err) {
        ctx.log.error(`[quotation-auto-publish] quotation ${id}: ${describe(err)}`);
        results.push({ id, outcome: 'error' });
      }
    }
    return { active: true, checked: results.length, results };
  } finally {
    running = false;
  }
}

module.exports = { sweepQuotationAutoPublish, processOne, adminProblem, databaseIsDevelopment, BATCH };
