// Explicit, separate cleanup command. Dry-run by default (`--apply` required to make any change).
// Audit preservation is structural, not a policy choice this file can override: RequestEvent.service
// Request and Case.serviceRequest are `onDelete: Restrict` in prisma/schema.prisma, so the database
// itself refuses to delete a service_requests row while request_events or a Case reference it.
// security_events has no foreign key at all, by design ("the history outlives a deleted account"),
// and is never touched here regardless. This module therefore NEVER deletes request_events,
// security_events, cases, bitrix_deal_links or integration_outbox rows, under any flag — see
// safety.NEVER_DELETE_TABLES. The one narrow case where a DB row may be removed is a run that
// registered a synthetic account but never created a service_request at all (nothing to retain yet).
const fs = require('fs');
const path = require('path');
const { assertNotProtected, PROTECTED_REQUEST_IDS, NEVER_DELETE_TABLES } = require('./safety');

const NAME_PREFIX = 'ZZ-SYNTHETIC';

class CleanupRefused extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CleanupRefused';
    this.code = code;
  }
}

function loadManifest(runsDir, runId) {
  const manifestPath = path.join(runsDir, runId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new CleanupRefused(`no manifest found for run ${runId}`, 'manifest_not_found');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Re-derives and PROVES ownership from the database itself — never trusts the manifest alone.
// Returns { provenUser, provenRequestId, hasServiceRequests } or throws CleanupRefused.
async function proveOwnership(prisma, manifest) {
  const { identity, runId } = manifest;
  if (!identity || !identity.email || !identity.patientName) throw new CleanupRefused('manifest is missing identity data', 'manifest_incomplete');
  if (!identity.patientName.startsWith(NAME_PREFIX)) throw new CleanupRefused('manifest identity does not carry the ZZ-SYNTHETIC name prefix', 'not_synthetic');
  if (!identity.email.includes(runId)) throw new CleanupRefused('manifest identity does not carry this exact runId tag', 'tag_mismatch');

  const user = await prisma.user.findUnique({ where: { email: identity.email }, select: { id: true, name: true, email: true, mobile: true } });
  if (!user) return { provenUser: null, provenRequestId: null, hasServiceRequests: false, note: 'account not found — nothing to clean up' };
  if (!String(user.name || '').startsWith(NAME_PREFIX)) throw new CleanupRefused('the account found by this email no longer carries the ZZ-SYNTHETIC name — refusing to touch it', 'identity_drift');

  const requests = await prisma.serviceRequest.findMany({ where: { userId: user.id }, select: { id: true } });
  if (requests.length > 1) throw new CleanupRefused('this account owns more than one request — ambiguous ownership, refusing to touch it', 'ambiguous_ownership');
  const requestId = requests[0] ? requests[0].id : null;
  if (requestId != null) assertNotProtected(requestId); // hard stop, unconditionally, before anything else

  return { provenUser: user, provenRequestId: requestId, hasServiceRequests: requests.length > 0 };
}

// dryRun=true by default. Returns a report describing exactly what was retained (and why) and what,
// if anything, was deleted. Never partially deletes: if any proof fails, it retains everything and
// reports it for manual review rather than guessing.
async function runCleanup(prisma, runsDir, runId, { dryRun = true } = {}) {
  const manifest = loadManifest(runsDir, runId);
  const ownership = await proveOwnership(prisma, manifest);

  const result = {
    runId, dryRun, protectedIds: PROTECTED_REQUEST_IDS, neverDeleteTables: NEVER_DELETE_TABLES,
    retained: [], deleted: [], localArtifactsRemoved: [],
  };

  if (!ownership.provenUser) {
    result.retained.push({ reason: 'no synthetic account found for this run — nothing to report or delete' });
  } else if (ownership.hasServiceRequests) {
    // The normal case: a request exists, so request_events (and, once approved, the Case, Deal link
    // and outbox event) exist too. The database itself (onDelete: Restrict) would refuse to delete the
    // user or the request while those rows exist — so they are retained by policy, not merely by
    // choice, and reported for manual/administrative review.
    result.retained.push({
      userId: ownership.provenUser.id, requestId: ownership.provenRequestId,
      reason: 'audit evidence exists for this request (request_events / Case / Deal link / outbox) — '
        + 'retained per audit-preservation policy; deleting it would require deleting append-only audit '
        + 'history or would be refused by the database\'s own referential-integrity constraints',
    });
  } else if (!dryRun) {
    // Narrow, proven-safe edge case: registered, never submitted. UserConsent cascades; nothing else
    // references this user.
    await prisma.user.delete({ where: { id: ownership.provenUser.id } });
    result.deleted.push({ table: 'users', id: ownership.provenUser.id, reason: 'no service_requests ever existed for this account' });
  } else {
    result.retained.push({ userId: ownership.provenUser.id, reason: 'dry run: would delete the orphaned synthetic account (no service_requests exist) — rerun with --apply to actually delete' });
  }

  // Local filesystem artifacts (never a database row, never audit evidence) may always be removed
  // under --apply: the run's own manifest/report/temp files.
  if (!dryRun) {
    const runDir = path.join(runsDir, runId);
    try { fs.rmSync(runDir, { recursive: true, force: true }); result.localArtifactsRemoved.push(runDir); } catch (err) { result.localArtifactsError = err.message; }
  }

  return result;
}

module.exports = { runCleanup, proveOwnership, loadManifest, CleanupRefused, NAME_PREFIX };
