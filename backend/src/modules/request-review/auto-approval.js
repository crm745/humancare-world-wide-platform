// Automatic approval of genuine Private Charter requests.
//
// This is NOT the synthetic E2E engine (which stays untouched and keeps its own signed marker, claim and fence). It decides only
// WHETHER a request may be approved without a person; the approval itself is done by the EXISTING reviewDocument and approveRequest services,
// unchanged apart from their optional `actorType: 'system'`. So the Case, the document copy, the request events, the audit entry and the
// Bitrix Deal outbox event all come from the one existing transaction, and a request that is already approved returns "already approved"
// and writes nothing (no second Case, no second outbox event: the Case is unique per request and the Deal event has a unique key per Case).
//
// A request is approved automatically only when EVERY rule below passes. Anything uncertain stays "in_review" for a person, untouched:
//   switch   PRIVATE_CHARTER_AUTO_APPROVE=true AND PRIVATE_CHARTER_AUTO_APPROVE_FROM is a valid date AND the review workflow is on
//            (all absent by default = this module is inert). PRIVATE_CHARTER_AUTO_APPROVE_FROM is the ONE, mandatory, explicit cutoff: a request
//            created before it is never looked at again (held as before_start_time, and the sweep does not even list it); a request created
//            at or after it may enter. There is no other date in the code, so whoever sets the cutoff decides which requests are history:
//            set it to the moment automation goes live, never earlier than the newest request that must stay with a person.
//   pipeline BITRIX_DEAL_PROFILE=actual on this process, so the Deal event written by the approval is stamped for Category 0. Without it the
//            event would carry no stamp (read as a legacy test event) and the actual worker would refuse it.
//   request  Private Charter, "in_review", no Bitrix Lead, no Case yet, not a synthetic E2E request (those belong to the synthetic engine),
//            never rejected / asked for more documents, and its stored form is complete.
//   files    at least one current document; every current document is clean (ClamAV), has a recorded SHA-256 and size, is an allowed file
//            type, is not rejected, and no two carry the same content. The existing approvalBlockers() and fileProblem() (checksum re-hash
//            inside approveRequest) still apply on top. In addition the stored bytes are READ and checked: what the file really is (from its own
//            bytes, never the name or the declared type) must match the recorded type, and its structure must be valid (no corruption, encryption
//            or active content). Anything that cannot be read or verified is held.
//
// THE DESIGNATED E2E TEST IDENTITY (a second, separate, explicit path; off by default). To run the real workflow end to end with test data (a
// Deal in the live portal's test pipeline, quotation, test-mode payment, stage sync) without ever opening the genuine path to unverified content:
//   * PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE=true and PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES=<1 to 5 E.164 numbers> designate the test identities
//     (the numbers of the owning account, User.mobile; Firebase TEST numbers, never a real patient's);
//   * such a request must carry the visible test marker E2E_NAME_PREFIX at the start of the patient name, AND be owned by a designated number.
//     A marked name from anyone else is held; a designated number with an unmarked name is held (a test identity never produces unmarked data);
//   * the mode refuses outright under NODE_ENV=production, and unless DATABASE_URL names humancare_dev on a loopback host AND the live server
//     answers SELECT DATABASE() = humancare_dev. It is also required to be explicit about the cutoff, like everything else here;
//   * it does NOT need, and is NOT, the genuine path's unverified-content acceptance: genuine requests stay disabled unless that flag is set.
//     Every other rule (profile, form, scan, bytes, structure, cutoff) applies to a designated request exactly as to any other.
//   * and its documents must pass a REAL content check, which genuine requests never get: each must be the operator's fictional E2E fixture for this
//     very patient (banner plus Patient Name, Age, Gender, Origin and Destination, every field equal to the stored request; see
//     e2e-document-verification.js). Only then is contentVerified recorded as true, and only from the verifier's own result.
// It is NOT the synthetic orchestrator's identity: requests named with the orchestrator's own prefix, or carrying its signed events, stay with the
// synthetic engine and are never approved here, whatever this mode says. The two prefixes are disjoint on purpose.
//
// WHAT IS NOT VERIFIED, and is never claimed: that a file is the RIGHT document or that its contents are correct. A clean malware scan proves only
// "no known malware", and file type and structure checks prove only "a well-formed PDF/image". HumanCare stores no document type, so no content or
// type requirement ("a medical report", "a passport") can be checked by machine. Therefore:
//   * auto-approval stays OFF unless PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT=true: a person must knowingly accept that the system
//     approves on file type and structure only;
//   * if PRIVATE_CHARTER_AUTO_APPROVE_REQUIRED_DOCUMENTS names any required document kind, EVERY request is held (required_document_types_unverifiable),
//     because the system cannot verify a kind;
//   * every automatic approval records contentVerified: false (true ONLY when the designated-E2E fixture verifier above succeeded for every
//     document), so nobody reads "auto-approved" as "documents checked". Operations still review the
//     Deal and its documents in Bitrix24 before any quotation.
const { activeProfileName } = require('../bitrix/bitrix-profiles');
const { PRIVATE_CHARTER_KEY } = require('../../common/constants/request.constants');
const { REQUEST_STATUS, SCAN, REVIEW, ACTION } = require('./request-review.config');
const { detectFileType } = require('../documents/file-type');
const { E2E_NAME_PREFIX, FIELDS: E2E_FIXTURE_FIELDS } = require('./e2e-document-verification');

const SYNTHETIC_NAME_PREFIX = 'ZZ-SYNTHETIC';
const SYNTHETIC_ACTION_PREFIX = 'synthetic_e2e';
// The visible marker of a designated E2E test request (disjoint from the synthetic orchestrator's prefix above); defined once, beside the fixture verifier.
const E2E_MAX_MOBILES = 5;
const E2E_MOBILE = /^\+[1-9]\d{7,14}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const E2E_DATABASE = 'humancare_dev';
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const SHA256 = /^[a-f0-9]{64}$/;
const HOLD_EVENTS = new Set([ACTION.DOCUMENT_REJECTED, ACTION.DOCUMENTS_REQUESTED]);
const SWEEP_LIMIT = 20;
const GENDERS = new Set(['male', 'female', 'other']);
const MIME_OF_TYPE = Object.freeze({ pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

// ---- configuration ------------------------------------------------------------------------------------------------------------------

// The designated-E2E settings. { requested, enabled, mobiles: Set, reason }. Never enabled by accident: it needs the explicit switch, a non-production
// process, a loopback humancare_dev database URL, and a valid list of designated numbers (1 to 5, E.164). A requested-but-unusable mode is NOT
// silently dropped: its reason is what the disabled configuration reports.
function e2eConfig(env = process.env) {
  const off = { requested: false, enabled: false, mobiles: new Set(), reason: 'e2e_mode_off' };
  if (env.PRIVATE_CHARTER_AUTO_APPROVE_E2E_MODE !== 'true') return off;
  const refuse = (reason) => ({ ...off, requested: true, reason });
  if (env.NODE_ENV === 'production') return refuse('e2e_refused_in_production');
  let url;
  try { url = new URL(String(env.DATABASE_URL || '')); } catch { return refuse('e2e_requires_local_dev_database'); }
  if (url.pathname.replace(/^\//, '') !== E2E_DATABASE || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return refuse('e2e_requires_local_dev_database');
  const mobiles = String(env.PRIVATE_CHARTER_AUTO_APPROVE_E2E_MOBILES || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!mobiles.length) return refuse('e2e_mobiles_missing');
  if (mobiles.length > E2E_MAX_MOBILES || mobiles.some((m) => !E2E_MOBILE.test(m))) return refuse('e2e_mobiles_invalid');
  return { requested: true, enabled: true, mobiles: new Set(mobiles), reason: null };
}

// { enabled, from } - enabled only when the switch is exactly "true" and the start time is a valid date.
function autoApprovalConfig(env = process.env) {
  if (env.PRIVATE_CHARTER_AUTO_APPROVE !== 'true') return { enabled: false, reason: 'switch_off' };
  if (env.PRIVATE_CHARTER_REVIEW_WORKFLOW !== 'true') return { enabled: false, reason: 'review_workflow_off' };
  const raw = typeof env.PRIVATE_CHARTER_AUTO_APPROVE_FROM === 'string' ? env.PRIVATE_CHARTER_AUTO_APPROVE_FROM.trim() : '';
  const from = raw ? new Date(raw) : null;
  if (!from || Number.isNaN(from.getTime())) return { enabled: false, reason: 'start_time_missing_or_invalid' };
  // Approving genuine requests without a person on file type and structure alone is a business decision: explicit, never by default.
  const acceptsGenuine = env.PRIVATE_CHARTER_AUTO_APPROVE_ACCEPT_UNVERIFIED_CONTENT === 'true';
  const e2e = e2eConfig(env);
  if (!acceptsGenuine && !e2e.enabled) return { enabled: false, reason: e2e.requested ? e2e.reason : 'unverified_content_not_accepted' };
  const requiredDocuments = String(env.PRIVATE_CHARTER_AUTO_APPROVE_REQUIRED_DOCUMENTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { enabled: true, from, requiredDocuments, acceptsGenuine, e2e };
}

// ---- the rules (pure) ---------------------------------------------------------------------------------------------------------------

// Fields the Private Charter validation requires at submission; read back from the stored row. [] when complete.
function missingFormFields(r) {
  const miss = [];
  if (!r.patientName || !String(r.patientName).trim()) miss.push('patientName');
  if (!(Number.isInteger(r.patientAge) && r.patientAge >= 1 && r.patientAge <= 120)) miss.push('patientAge');
  if (!GENDERS.has(r.patientGender)) miss.push('patientGender');
  if (!/^[A-Za-z]{2}$/.test(r.country || '')) miss.push('country');
  if (!r.patientContact || !String(r.patientContact).trim()) miss.push('patientContact');
  if (!r.preferredDate) miss.push('preferredDate');
  if (!r.travelType) miss.push('travelType');
  if (!r.origin || !r.destination) miss.push('route');
  if (!r.criticalLevel) miss.push('criticalLevel');
  if (r.oxygenRequired === null || r.oxygenRequired === undefined) miss.push('oxygenRequired');
  else if (r.oxygenRequired === true && !(Number.isInteger(r.oxygenFlowLpm) && r.oxygenFlowLpm > 0)) miss.push('oxygenFlowLpm');
  return miss;
}

function documentProblem(d) {
  if (d.scanStatus !== SCAN.CLEAN) return `document_scan_${d.scanStatus}`;
  if (d.reviewStatus === REVIEW.REJECTED) return 'document_rejected';
  if (d.documentRequestId != null) return 'document_is_post_approval_request';
  if (typeof d.sha256 !== 'string' || !SHA256.test(d.sha256) || !(d.sizeBytes > 0)) return 'document_checksum_missing';
  if (!ALLOWED_MIME.has(d.mimeType)) return 'document_type_not_allowed';
  return null;
}

// -> { ok: true, pending: [documents still to approve] } | { ok: false, code }. Same input -> same answer; reads and writes nothing.
// `input`: { request, documents (ALL rows of the request), eventActions: [string], hasCase, env, config }.
// `approvalBlockers` is the existing service function (injectable for tests).
function evaluate(input, { approvalBlockers } = {}) {
  const { request, documents, eventActions = [], hasCase = false, owner = null, env = process.env, config = autoApprovalConfig(env) } = input;
  if (!config.enabled) return { ok: false, code: config.reason || 'disabled' };
  if (!request) return { ok: false, code: 'request_not_found' };
  if (request.serviceKey !== PRIVATE_CHARTER_KEY) return { ok: false, code: 'not_private_charter' };
  if (request.reviewStatus !== REQUEST_STATUS.IN_REVIEW) return { ok: false, code: 'not_in_review' };
  if (!request.createdAt || new Date(request.createdAt) < config.from) return { ok: false, code: 'before_start_time' };
  if (String(request.patientName || '').startsWith(SYNTHETIC_NAME_PREFIX) || eventActions.some((a) => String(a).startsWith(SYNTHETIC_ACTION_PREFIX))) {
    return { ok: false, code: 'synthetic_request' }; // the synthetic engine alone handles these
  }
  // Which path is this request on? A visibly marked test request may enter ONLY through the designated E2E identity; everything else is the
  // genuine path, which needs its own explicit acceptance. A designated number never produces an unmarked request.
  const marked = String(request.patientName || '').startsWith(E2E_NAME_PREFIX);
  const e2e = config.e2e || { enabled: false, mobiles: new Set() };
  const designated = Boolean(e2e.enabled && owner && typeof owner.mobile === 'string' && e2e.mobiles.has(owner.mobile));
  if (marked) {
    if (!e2e.enabled) return { ok: false, code: 'e2e_mode_off' };
    if (!designated) return { ok: false, code: 'e2e_identity_not_designated' };
  } else {
    if (designated) return { ok: false, code: 'e2e_identity_requires_test_name' };
    if (!config.acceptsGenuine) return { ok: false, code: 'unverified_content_not_accepted' };
  }
  if (activeProfileName(env) !== 'actual') return { ok: false, code: 'profile_not_actual' };
  if (request.bitrixLeadId != null) return { ok: false, code: 'has_bitrix_lead' };
  if (hasCase) return { ok: false, code: 'case_exists' };
  if (request.documentsRequestReason) return { ok: false, code: 'documents_requested' };
  if (eventActions.some((a) => HOLD_EVENTS.has(a))) return { ok: false, code: 'review_history_requires_a_person' };
  const missing = missingFormFields(request);
  if (missing.length) return { ok: false, code: `incomplete_form:${missing.join('+')}` };

  // HumanCare keeps no document type, so a required KIND can never be verified by machine: hold rather than guess.
  if (config.requiredDocuments && config.requiredDocuments.length) return { ok: false, code: 'required_document_types_unverifiable' };
  const current = documents.filter((d) => d.supersededAt == null);
  if (!current.length) return { ok: false, code: 'no_documents' };
  for (const d of current) {
    const problem = documentProblem(d);
    if (problem) return { ok: false, code: problem };
  }
  if (new Set(current.map((d) => d.sha256)).size !== current.length) return { ok: false, code: 'duplicate_document_content' };
  const blockers = approvalBlockers(request, current).filter((b) => b.code !== 'awaiting_review');
  if (blockers.length) return { ok: false, code: String(blockers[0].code) };
  return { ok: true, e2e: marked, current, pending: current.filter((d) => d.reviewStatus === REVIEW.PENDING) };
}

// ---- the stored bytes (async: reads storage) ------------------------------------------------------------------------------------------
// -> null when the file is what it says it is and well-formed, otherwise a short code. Reads through the existing checksum-verified reader, so a file that
// changed since it was scanned is refused too. Never throws.
// `inspectStoredDocument` also hands back the verified bytes and the REAL type (from the bytes) so a later step does not read the file twice.
async function inspectStoredDocument(document, { readFile, validateStructure } = {}) {
  let bytes;
  try {
    bytes = await readFile(document);
  } catch (err) {
    return { problem: `document_unreadable:${codeOf(err)}` };
  }
  const type = detectFileType(bytes);
  if (!type) return { problem: 'document_type_unverifiable' };
  if (MIME_OF_TYPE[type] !== document.mimeType) return { problem: 'document_type_mismatch' };
  let problem;
  try {
    problem = await validateStructure(type, bytes);
  } catch {
    return { problem: 'document_structure_unverifiable' };
  }
  if (problem) return { problem: `document_structure_invalid:${String(problem.code || 'invalid').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 30)}` };
  return { problem: null, bytes, type };
}

async function verifyStoredDocument(document, deps) {
  return (await inspectStoredDocument(document, deps)).problem;
}

// ---- the engine ---------------------------------------------------------------------------------------------------------------------

const codeOf = (err) => String((err && (err.publicCode || err.code || err.statusCode)) || 'error').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 40);

function createAutoApproval(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console;
  const getPrisma = () => deps.prisma || require('../../db/prisma').prisma;
  const getServices = () => deps.services || require('./request-review.service');
  const readFile = (document) => (deps.readFile || require('./request-review.files').readVerifiedFile)(document);
  const verifyFixture = (args) => (deps.verifyFixture || require('./e2e-document-verification').verifyE2EFixture)(args);
  const validateStructure = (type, bytes) => (deps.validateStructure || require('../../storage/structure').validateStructure)(type, bytes);

  let databaseConfirmed = false;
  // E2E requests only: the live server itself must say it is humancare_dev (the URL alone is not trusted).
  async function confirmDatabase(prisma) {
    if (databaseConfirmed) return true;
    try {
      const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
      databaseConfirmed = Boolean(rows && rows[0] && rows[0].db === E2E_DATABASE);
    } catch {
      databaseConfirmed = false;
    }
    return databaseConfirmed;
  }

  async function load(prisma, requestId, config) {
    const request = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) return null;
    // The owner's number is only needed (and only read) when the designated-E2E mode is on.
    const owner = config.e2e && config.e2e.enabled ? await prisma.user.findUnique({ where: { id: request.userId }, select: { mobile: true } }) : null;
    const [documents, events, caseRecord] = await Promise.all([
      prisma.requestDocument.findMany({ where: { serviceRequestId: requestId }, orderBy: { id: 'asc' } }),
      prisma.requestEvent.findMany({ where: { serviceRequestId: requestId }, select: { action: true } }),
      prisma.case.findUnique({ where: { serviceRequestId: requestId } }),
    ]);
    return { request, documents, owner, eventActions: events.map((e) => e.action), hasCase: Boolean(caseRecord) };
  }

  // Never throws: the callers (the upload response, the scan job) must not be affected.
  async function processRequest(rawRequestId) {
    try {
      const config = autoApprovalConfig(env);
      if (!config.enabled) return { outcome: 'disabled' };
      const requestId = Number(rawRequestId);
      if (!Number.isInteger(requestId) || requestId < 1) return { outcome: 'bad_request_id' };
      const prisma = getPrisma();
      const { reviewDocument, approveRequest, approvalBlockers } = getServices();
      const loaded = await load(prisma, requestId, config);
      if (!loaded) return { outcome: 'held', code: 'request_not_found' };
      const verdict = evaluate({ ...loaded, env, config }, { approvalBlockers });
      if (!verdict.ok) return { outcome: 'held', code: verdict.code };
      if (verdict.e2e && !(await confirmDatabase(prisma))) return { outcome: 'held', code: 'database_not_identified' };
      // The cheap rules passed; now the stored bytes themselves. Any file that cannot be read or verified holds the whole request for a person.
      // For the designated E2E identity ONLY, the content itself is then checked: each document must be this patient's fictional fixture. The result of
      // the verifier is kept; contentVerified below is derived from those results and nowhere else.
      const contentResults = [];
      for (const document of verdict.current) {
        const inspected = await inspectStoredDocument(document, { readFile, validateStructure });
        if (inspected.problem) return { outcome: 'held', code: inspected.problem };
        if (verdict.e2e) {
          const result = await verifyFixture({ bytes: inspected.bytes, type: inspected.type, request: loaded.request });
          if (!result || result.verified !== true) return { outcome: 'held', code: `e2e_document_content_unverified:${String((result && result.code) || 'unknown').slice(0, 60)}` };
          contentResults.push(result);
        }
      }
      const contentVerified = verdict.e2e === true && contentResults.length === verdict.current.length && contentResults.length > 0 && contentResults.every((r) => r.verified === true);

      let stage = 'document_review';
      try {
        for (const document of verdict.pending) {
          try {
            await reviewDocument({ requestId, documentId: document.id, adminId: null, decision: REVIEW.APPROVED, actorType: 'system' });
          } catch (err) {
            if (!(err && err.publicCode === 'already_decided')) throw err; // another approver got there first: fine
          }
        }
        stage = 'request_approval';
        const result = await approveRequest({ requestId, adminId: null, actorType: 'system' });
        if (result && result.alreadyApproved) return { outcome: 'already_approved' };
        stage = 'audit_event';
        await prisma.requestEvent.create({
          data: {
            serviceRequestId: requestId, action: ACTION.AUTO_APPROVED, actorType: 'system', actorId: null,
            detail: { documents: verdict.current.length, rules: 'v2', startedFrom: config.from.toISOString(), contentVerified, verified: contentVerified ? 'e2e_fixture_text_match' : 'file_type_and_structure_only', ...(contentVerified && { fields: E2E_FIXTURE_FIELDS }), ...(verdict.e2e && { e2e: true }) },
          },
        }).catch(() => undefined); // supplementary: the approval's own system-actor events are the record
        return { outcome: 'approved' };
      } catch (err) {
        // A blocker found inside the approval (a person rejected a file meanwhile, a file changed, storage unreachable) leaves the
        // request in review exactly as it was; nothing partial can exist because the approval is one transaction.
        log.warn(`[auto-approval] request ${requestId}: ${stage} did not complete (${codeOf(err)}); left for review.`);
        return { outcome: 'held', code: codeOf(err), stage };
      }
    } catch (err) {
      log.warn(`[auto-approval] unexpected error (${codeOf(err)}).`);
      return { outcome: 'error', code: codeOf(err) };
    }
  }

  // The periodic pass: only requests that could qualify are even looked at (in review, no Case, created after the start time).
  async function sweep({ limit = SWEEP_LIMIT } = {}) {
    try {
      const config = autoApprovalConfig(env);
      if (!config.enabled) return { processed: 0, results: [] };
      const candidates = await getPrisma().serviceRequest.findMany({
        where: { serviceKey: PRIVATE_CHARTER_KEY, reviewStatus: REQUEST_STATUS.IN_REVIEW, createdAt: { gte: config.from }, bitrixLeadId: null, case: { is: null } },
        select: { id: true }, orderBy: { id: 'asc' }, take: limit,
      });
      const results = [];
      for (const { id } of candidates) results.push({ requestId: id, ...(await processRequest(id)) });
      return { processed: results.length, results };
    } catch {
      return { processed: 0, results: [] };
    }
  }

  return { processRequest, sweep };
}

let shared = null;
const engine = () => shared || (shared = createAutoApproval());
const autoApproveIfEligible = (requestId) => engine().processRequest(requestId);
const sweepAutoApprovals = (options) => engine().sweep(options);

module.exports = { E2E_NAME_PREFIX, e2eConfig, autoApprovalConfig, evaluate, missingFormFields, inspectStoredDocument, verifyStoredDocument, createAutoApproval, autoApproveIfEligible, sweepAutoApprovals, SWEEP_LIMIT };
