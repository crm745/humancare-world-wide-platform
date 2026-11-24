// ONE-TIME recovery runner for the designated-E2E automatic approval of EXACTLY ONE request: id 210, reference REQ-1210, on the local humancare_dev database.
//
// The automatic approval normally runs inside the document-upload request (requests.controller.js) or the scan job's sweep. REQ-1210's API process was started
// without the E2E flags, so it was never approved. This runner calls the EXISTING autoApproveIfEligible(210) (auto-approval.js) ONCE, in a process that has the flags,
// and adds no approval logic of its own: the document review, the Case, the Deal link, the Deal-creation event, the transaction, the locks and every duplicate
// protection are the unchanged existing services. It is not src/worker.js, never requires src/jobs/index.js, starts no timer and never contacts Bitrix24.
//
//   node src/request-auto-approve-worker.js --request-id 210 --request-reference REQ-1210              READINESS (the default): read-only, writes nothing
//   node src/request-auto-approve-worker.js --once --request-id 210 --request-reference REQ-1210       approve it ONCE
// Needs (process environment only; backend/.env is read, never written):
//   BITRIX_DEAL_PROFILE=actual            so the Deal link and event are stamped for Category 0 (they are never restamped afterwards)
//   PRIVATE_CHARTER_AUTO_APPROVE=true, PRIVATE_CHARTER_AUTO_APPROVE_FROM=<ISO time not later than the request>, PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE=true,
//   PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES=<the owner's Firebase TEST number, E.164>, and PRIVATE_CHARTER_REVIEW_WORKFLOW=true (set in .env)
// Refuses unless: the database is humancare_dev on a loopback host, confirmed by SELECT DATABASE(); the request is exactly REQ-1210 / id 210; it is in review, owned by
// a designated number, named E2E-TEST..., without a Case; every document is clean, current and the patient's own fictional fixture. After --once it verifies that there
// is exactly ONE Case, ONE actual-profile Deal link and ONE pending Deal-creation event for it, and that nothing else changed.
// WRITES (--once, all through the existing services): document review, one Case with its stage event, audit row and case-document row, the request's approval and
// events, one Deal link, one pending bitrix.deal.create event. No storage write, no Bitrix call, no notification, no push.
const path = require('path');
const { developmentDatabaseProblem, confirmDatabase } = require('./common/safety/single-stage-runner');

const TARGET = Object.freeze({ requestId: 210, requestReference: 'REQ-1210' });
const PRIVATE_CHARTER = 'privatecharter';
const SAFE = /^[A-Za-z0-9_.:+-]{1,80}$/;

class Refusal extends Error {
  constructor(code) { super(code); this.name = 'Refusal'; this.code = code; }
}
const refuse = (code) => new Refusal(code);
const safe = (value) => (typeof value === 'string' && SAFE.test(value) ? value : 'error');

// ---- arguments ---------------------------------------------------------------------------------------------------------------------------------
/** -> { execute }. Throws Refusal. Both identifiers are required in every mode and must be EXACTLY the target; only --once executes. */
function parseArgs(argv = []) {
  const named = {};
  let mode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once' || arg === '--readiness-only') {
      if (mode) throw refuse('mode_repeated_or_conflicting');
      mode = arg;
    } else if (arg === '--request-id' || arg === '--request-reference') {
      if (named[arg] !== undefined) throw refuse('argument_repeated');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw refuse('argument_value_missing');
      named[arg] = value;
      i += 1;
    } else {
      throw refuse('unknown_argument');
    }
  }
  if (named['--request-id'] === undefined) throw refuse('request_id_required');
  if (named['--request-reference'] === undefined) throw refuse('request_reference_required');
  if (named['--request-id'] !== String(TARGET.requestId) || named['--request-reference'] !== TARGET.requestReference) throw refuse('target_not_allowed');
  return { execute: mode === '--once' };
}

// ---- the state read back ---------------------------------------------------------------------------------------------------------------------
const key = (rows) => new Map(rows.map((r) => [Number(r.id), JSON.stringify(r)]));

// Everything that must not change: every other request, Case and outbox event (as it is now). Rows that appear later are counted separately.
async function snapshot(prisma) {
  const requests = await prisma.serviceRequest.findMany({ where: { id: { not: TARGET.requestId } }, select: { id: true, reviewStatus: true, status: true }, orderBy: { id: 'asc' } });
  const cases = await prisma.case.findMany({ select: { id: true, status: true, charterStage: true, stageVersion: true, serviceRequestId: true }, orderBy: { id: 'asc' } });
  const outbox = await prisma.integrationOutbox.findMany({ select: { id: true, status: true, attempts: true, lockedBy: true, lastError: true }, orderBy: { id: 'asc' } });
  return { requests: key(requests), cases: key(cases), outbox: key(outbox) };
}
const unchanged = (before, after) => ['requests', 'cases', 'outbox'].every((name) => [...before[name]].every(([id, text]) => after[name].get(id) === text));
const added = (before, after, name) => [...after[name].keys()].filter((id) => !before[name].has(id));

// -> { ok, problems: [codes], facts }. Reads only.
async function verifyResult(prisma, before) {
  const problems = [];
  const request = await prisma.serviceRequest.findUnique({ where: { id: TARGET.requestId } });
  if (!request || request.reviewStatus !== 'approved') problems.push('request_not_approved');
  const cases = await prisma.case.findMany({ where: { serviceRequestId: TARGET.requestId } });
  if (cases.length !== 1) problems.push('case_count_not_one');
  const caseRecord = cases[0];
  let links = []; let events = [];
  if (caseRecord) {
    links = await prisma.bitrixDealLink.findMany({ where: { caseId: caseRecord.id } });
    events = await prisma.integrationOutbox.findMany({ where: { caseId: caseRecord.id, eventType: 'bitrix.deal.create' } });
  }
  if (caseRecord && links.length !== 1) problems.push('deal_link_count_not_one');
  if (links[0] && (links[0].profile !== 'actual' || links[0].bitrixDealId != null)) problems.push('deal_link_not_actual_or_has_deal');
  if (caseRecord && events.length !== 1) problems.push('deal_event_count_not_one');
  if (events[0]) {
    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    if (events[0].status !== 'pending' || events[0].attempts !== 0) problems.push('deal_event_not_pending');
    if (!payload || payload.profile !== 'actual') problems.push('deal_event_not_actual');
  }
  const after = await snapshot(prisma);
  if (!unchanged(before, after)) problems.push('other_records_changed');
  if (added(before, after, 'cases').length > 1) problems.push('more_than_one_case_created');
  if (added(before, after, 'outbox').length > 1) problems.push('more_than_one_event_created');
  return { ok: problems.length === 0, problems, facts: { caseId: caseRecord ? caseRecord.id : null, caseReference: caseRecord ? caseRecord.referenceNumber : null, outboxEventId: events[0] ? events[0].id : null, links: links.length, events: events.length } };
}

// ---- the checks (all reads) ----------------------------------------------------------------------------------------------------------------------
/** Throws Refusal on the first failed check. Resolves { request, config, verdict, ...}. Writes nothing. */
async function checkReadiness({ prisma, env, deps }) {
  if (env.NODE_ENV === 'production') throw refuse('refused_in_production');
  const dbProblem = developmentDatabaseProblem(env);
  if (dbProblem) throw refuse(dbProblem);
  const { resolveProfile } = require('./modules/bitrix/bitrix-profiles');
  const profile = resolveProfile(env);
  if (!profile || profile.name !== 'actual') throw refuse('bitrix_deal_profile_not_actual');
  if (env.PRIVATE_CHARTER_REVIEW_WORKFLOW !== 'true') throw refuse('review_workflow_not_true');
  if (!(await confirmDatabase(prisma))) throw refuse('database_not_humancare_dev');

  const aa = deps.autoApproval || require('./modules/request-review/auto-approval');
  const config = aa.autoApprovalConfig(env);
  if (!config.enabled) throw refuse(`auto_approval_${config.reason || 'disabled'}`);
  if (!config.e2e || !config.e2e.enabled) throw refuse('e2e_mode_off');

  const request = await prisma.serviceRequest.findUnique({ where: { id: TARGET.requestId } });
  if (!request) throw refuse('request_not_found');
  if (request.id !== TARGET.requestId || request.referenceNumber !== TARGET.requestReference) throw refuse('request_reference_mismatch');
  if (request.serviceKey !== PRIVATE_CHARTER) throw refuse('not_private_charter');
  if (!String(request.patientName || '').startsWith(aa.E2E_NAME_PREFIX)) throw refuse('patient_not_e2e_named');
  if (request.reviewStatus !== 'in_review') throw refuse('request_not_in_review');
  if (!request.createdAt || new Date(request.createdAt) < config.from) throw refuse('request_before_cutoff');
  const owner = await prisma.user.findUnique({ where: { id: request.userId }, select: { mobile: true } });
  if (!owner || typeof owner.mobile !== 'string' || !config.e2e.mobiles.has(owner.mobile)) throw refuse('owner_mobile_not_allowlisted');

  const [documents, events, caseRecord] = await Promise.all([
    prisma.requestDocument.findMany({ where: { serviceRequestId: TARGET.requestId }, orderBy: { id: 'asc' } }),
    prisma.requestEvent.findMany({ where: { serviceRequestId: TARGET.requestId }, select: { action: true } }),
    prisma.case.findUnique({ where: { serviceRequestId: TARGET.requestId } }),
  ]);
  const services = deps.services || require('./modules/request-review/request-review.service');
  const verdict = aa.evaluate({ request, documents, owner, eventActions: events.map((e) => e.action), hasCase: Boolean(caseRecord), env, config }, { approvalBlockers: services.approvalBlockers });
  if (!verdict.ok) throw refuse(`held_${String(verdict.code).replace(/[^A-Za-z0-9_.:+-]/g, '_').slice(0, 60)}`);
  if (verdict.e2e !== true) throw refuse('not_designated_e2e_path');

  // The stored bytes and the fixture content, exactly as the engine will check them (read only).
  const readFile = deps.readFile || require('./modules/request-review/request-review.files').readVerifiedFile;
  const validateStructure = deps.validateStructure || require('./storage/structure').validateStructure;
  const verifyFixture = deps.verifyFixture || require('./modules/request-review/e2e-document-verification').verifyE2EFixture;
  for (const document of verdict.current) {
    const inspected = await aa.inspectStoredDocument(document, { readFile, validateStructure });
    if (inspected.problem) throw refuse(`document_${String(inspected.problem).replace(/[^A-Za-z0-9_.:+-]/g, '_').slice(0, 60)}`);
    const result = await verifyFixture({ bytes: inspected.bytes, type: inspected.type, request });
    if (!result || result.verified !== true) throw refuse('document_fixture_not_verified');
  }
  return { request, config, verdict };
}

const PLANNED_WRITES = [
  'request_documents: pending documents approved (actor system) + request events',
  'one Case (stage event, audit row, case-document rows pointing at the same stored files)',
  'service_requests: REQ-1210 approved + request events',
  'one bitrix_deal_links row (profile actual)',
  'one pending bitrix.deal.create outbox event (profile actual)',
];

/**
 * Resolves the process exit code: 0 ready / approved, 1 refused or held, 2 failed or the result did not verify.
 * deps: { autoApprovalFn, autoApproval, services, readFile, validateStructure, verifyFixture } (all default to the real, existing ones).
 */
async function run({ argv, env, prisma, log = console, deps = {} }) {
  let options;
  try { options = parseArgs(argv); } catch (err) { log.error(`[request-approve] refused: ${err.code || 'arguments_invalid'}.`); return 1; }

  let ready;
  try { ready = await checkReadiness({ prisma, env, deps }); } catch (err) {
    if (err instanceof Refusal) { log.error(`[request-approve] refused: ${err.code}. Nothing was written.`); return 1; }
    log.error(`[request-approve] failed while checking: ${safe(err && (err.code || err.name))}. Nothing was written.`);
    return 2;
  }
  const documents = ready.verdict.current.length;
  if (!options.execute) {
    log.log(`[request-approve] READY (readiness only: nothing was written). Request ${TARGET.requestReference} would be approved by the existing automatic approval; ${documents} document(s) verified as the E2E fixture; ${ready.verdict.pending.length} pending review. Writes with --once: ${PLANNED_WRITES.join('; ')}.`);
    return 0;
  }

  const approve = deps.autoApprovalFn || require('./modules/request-review/auto-approval').autoApproveIfEligible;
  let before; let outcome;
  try {
    before = await snapshot(prisma);
    outcome = await approve(TARGET.requestId); // the existing engine: never throws, one transaction, idempotent
  } catch (err) {
    log.error(`[request-approve] failed: ${safe(err && (err.code || err.name))}. Run the readiness check again; every step is idempotent.`);
    return 2;
  }
  if (!outcome || (outcome.outcome !== 'approved' && outcome.outcome !== 'already_approved')) {
    log.error(`[request-approve] not approved: ${safe(outcome && outcome.outcome)}${outcome && outcome.code ? ` (${safe(outcome.code)})` : ''}. The request is left as it was.`);
    return 1;
  }
  let result;
  try { result = await verifyResult(prisma, before); } catch (err) {
    log.error(`[request-approve] approved, but the read-back failed: ${safe(err && (err.code || err.name))}. Verify by hand.`);
    return 2;
  }
  if (!result.ok) {
    log.error(`[request-approve] ALERT: approved, but verification failed: ${result.problems.join(', ')}.`);
    return 2;
  }
  log.log(`[request-approve] ${outcome.outcome === 'already_approved' ? 'ALREADY APPROVED (nothing new was written)' : 'APPROVED'}. ${JSON.stringify(result.facts)} Exactly one Case, one actual-profile Deal link and one pending Deal-creation event; no other record changed.`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true }); // inside main only; values already in the process environment win
  const { prisma } = require('./db/prisma');
  try {
    return await run({ argv, env: process.env, prisma });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

module.exports = { run, parseArgs, checkReadiness, verifyResult, snapshot, TARGET, PLANNED_WRITES, Refusal };
if (require.main === module) main().then((code) => { process.exitCode = code; });
