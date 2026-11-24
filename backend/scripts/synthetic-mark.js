// Marks ONE request as a synthetic E2E request, so the backend may approve it automatically once its documents are clean.
//
//   ALLOW_SYNTHETIC_MARKING=true node scripts/synthetic-mark.js <requestId> --owner-id <userId> --admin-id <adminId> --run-id <label> --documents <1-5>
//
// Operator-only: it is not an API endpoint and the server never imports it. The marker is a signed, append-only request_events row
// (see src/common/safety/synthetic-e2e-marker.js); SYNTHETIC_E2E_SECRET must be set in backend/.env by the operator. Refuses unless:
//   - ALLOW_SYNTHETIC_MARKING is exactly "true", the secret is set, NODE_ENV is not "production";
//   - the database is positively identified as humancare_dev (the URL and the server's own DATABASE());
//   - the request exists, is Private Charter, is awaiting_documents or in_review (never approved), and is younger than 6 hours;
//   - it has no Bitrix lead, no Deal link and no outbox event;
//   - --owner-id equals the owning account, and that account owns only this one request;
//   - the patient name starts with ZZ-SYNTHETIC; the admin exists; the request has no marker yet; fewer than 3 markers are active.
// Output: the request id and the outcome, or a short fixed refusal code. Never patient details or secrets.
const path = require('path');
const { ACTION, ALL_ACTIONS, LIMITS, RUN_ID, databaseOfUrl, secretOf, buildMark, deriveState } = require('../src/common/safety/synthetic-e2e-marker');

const OPT_IN = 'ALLOW_SYNTHETIC_MARKING';
const refuse = (code) => ({ ok: false, exitCode: 2, code });
const ID = /^[1-9]\d{0,9}$/;

function parseArgs(argv) {
  const args = argv.slice();
  const named = {};
  const positional = [];
  const allowed = new Set(['--owner-id', '--admin-id', '--run-id', '--documents']);
  while (args.length) {
    const arg = args.shift();
    if (arg && arg.startsWith('--')) {
      if (!allowed.has(arg)) return { error: 'unknown_option' };
      named[arg] = args.shift();
    } else positional.push(arg);
  }
  if (positional.length !== 1 || !ID.test(String(positional[0]))) return { error: 'request_id_required' };
  if (!ID.test(String(named['--owner-id']))) return { error: 'owner_id_required' };
  if (!ID.test(String(named['--admin-id']))) return { error: 'admin_id_required' };
  if (!RUN_ID.test(String(named['--run-id']))) return { error: 'run_id_required' };
  const documents = Number(named['--documents']);
  if (!/^\d$/.test(String(named['--documents'])) || documents < LIMITS.MIN_DOCUMENTS || documents > LIMITS.MAX_DOCUMENTS) return { error: 'documents_must_be_1_to_5' };
  return { requestId: Number(positional[0]), ownerId: Number(named['--owner-id']), adminId: Number(named['--admin-id']), runId: named['--run-id'], documents };
}

async function run({ argv, env, prisma, now = Date.now }) {
  if (env[OPT_IN] !== 'true') return refuse('opt_in_missing');
  if (env.NODE_ENV === 'production') return refuse('production_refused');
  const secret = secretOf(env);
  if (!secret) return refuse('secret_missing');
  const parsed = parseArgs(argv);
  if (parsed.error) return refuse(parsed.error);
  if (databaseOfUrl(env.DATABASE_URL) !== LIMITS.DATABASE) return refuse('database_not_identified');
  try {
    const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
    if (!rows || !rows[0] || rows[0].db !== LIMITS.DATABASE) return refuse('database_not_identified');
  } catch {
    return refuse('database_not_identified');
  }
  const { requestId, ownerId, adminId, runId, documents } = parsed;

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_requests WHERE id = ${requestId} FOR UPDATE`;
    const request = await tx.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) return refuse('request_not_found');
    if (request.serviceKey !== LIMITS.PRIVATE_CHARTER_KEY) return refuse('not_private_charter');
    if (request.reviewStatus !== 'awaiting_documents' && request.reviewStatus !== 'in_review') return refuse(request.reviewStatus === 'approved' ? 'already_approved' : 'not_pending_review');
    if (!request.createdAt || now() - new Date(request.createdAt).getTime() > LIMITS.MAX_REQUEST_AGE_MS) return refuse('request_too_old');
    if (request.userId !== ownerId) return refuse('owner_mismatch');
    if (!String(request.patientName || '').startsWith(LIMITS.NAME_PREFIX)) return refuse('not_synthetic_name');
    if ((await tx.serviceRequest.count({ where: { userId: ownerId } })) !== 1) return refuse('owner_has_other_requests');
    if (request.bitrixLeadId != null) return refuse('has_bitrix_footprint');
    const caseRecord = await tx.case.findUnique({ where: { serviceRequestId: requestId } });
    if (caseRecord) {
      if (await tx.bitrixDealLink.findUnique({ where: { caseId: caseRecord.id } })) return refuse('has_bitrix_footprint');
      if ((await tx.integrationOutbox.count({ where: { caseId: caseRecord.id } })) > 0) return refuse('has_bitrix_footprint');
    }
    if (!(await tx.adminUser.findUnique({ where: { id: adminId }, select: { id: true } }))) return refuse('admin_not_found');

    const all = await tx.requestEvent.findMany({ where: { action: { in: ALL_ACTIONS } }, orderBy: { id: 'asc' } });
    const byRequest = new Map();
    for (const event of all) {
      if (!byRequest.has(event.serviceRequestId)) byRequest.set(event.serviceRequestId, []);
      byRequest.get(event.serviceRequestId).push(event);
    }
    if ((byRequest.get(requestId) || []).some((e) => e.action === ACTION.MARKED)) return refuse('already_marked');
    let active = 0;
    for (const [id, events] of byRequest) if (deriveState(events, { secret, requestId: id, now: now() }).state === 'active') active += 1;
    if (active >= LIMITS.MAX_ACTIVE_MARKS) return refuse('too_many_active_marks');

    const mark = buildMark({ secret, requestId, ownerUserId: ownerId, adminId, expectedDocuments: documents, runId, now: now() });
    await tx.requestEvent.create({ data: { serviceRequestId: requestId, action: ACTION.MARKED, actorType: 'admin', actorId: adminId, detail: mark } });
    return { ok: true, exitCode: 0, requestId, outcome: 'marked' };
  }, { timeout: 15000, maxWait: 10000 });
}

const describe = (result, requestId) => (result.ok
  ? `synthetic request ${result.requestId}: ${result.outcome}`
  : `synthetic marking refused${requestId ? ` for request ${requestId}` : ''}: ${result.code}`);

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const parsed = parseArgs(process.argv.slice(2));
  let prisma = null;
  let result;
  try {
    if (process.env[OPT_IN] === 'true' && !parsed.error && secretOf(process.env) && databaseOfUrl(process.env.DATABASE_URL) === LIMITS.DATABASE) {
      ({ prisma } = require('../src/db/prisma'));
    }
    result = await run({ argv: process.argv.slice(2), env: process.env, prisma });
  } catch {
    result = { ok: false, exitCode: 1, code: 'unexpected_error' };
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => undefined);
  }
  console.log(describe(result, parsed.requestId));
  process.exit(result.exitCode);
}

if (require.main === module) main();

module.exports = { run, parseArgs, describe, OPT_IN };
