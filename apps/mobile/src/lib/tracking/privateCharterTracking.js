// The patient-facing tracking model of a Private Charter request (no React, no native modules, no network).
//
// Input: one request as GET /requests/me/:id returns it. Output: a plain object the screen can render as is.
// Only the allow-listed fields below are read. Everything else the response carries (billing, Bitrix fields,
// internal notes, stage-event notes, patient details, updatedAt, preferredDate...) never passes through here,
// and the model has no ETA, distance, position, flight number or coordinator: the backend has no such data.
//
// Two lifecycles (see docs/PRIVATE_CHARTER_TRACKING_IMPLEMENTATION_PLAN.md):
//   'review'  reviewStatus carries any non-empty value. Four values are known (documents, review, changes,
//             approval); the Case exists from submission but is ignored for progress until approval. Any other value is 'unknown': not approved,
//             nothing inferred, the Case and request.status are ignored for progress, the raw value is never exposed.
//   'legacy'  reviewStatus is null/missing/empty: the Case exists from submission. The two review milestones
//             do not apply. A Case drives progress but is never an approval (review.approved stays false).
//
// A milestone is ACTIVE only on evidence that the step is under way; otherwise nothing is active and the
// following steps stay pending. Wording variants are chosen through titleKey/subKey (translations live elsewhere).
import { PRIVATE_CHARTER_SERVICE_TYPE } from '../privateCharter';
import { TRACKING_FAMILY } from './serviceFamily';

export const MILESTONE_STATE = Object.freeze({
  COMPLETED: 'completed',
  ACTIVE: 'active',
  PENDING: 'pending',
  NOT_APPLICABLE: 'not_applicable',
  CANCELLED: 'cancelled',
});

// Fixed order of the journey.
export const MILESTONE_KEYS = Object.freeze([
  'request_received',
  'documents_review',
  'request_approved',
  'flight_scheduled',
  'mission_in_progress',
  'completed',
]);

const REVIEW_STATUSES = ['awaiting_documents', 'in_review', 'changes_requested', 'approved'];
// How far along the Case is. 'cancelled' is not progress, so it has no rank.
const STAGE_RANK = { submitted: 0, scheduled: 1, in_progress: 2, completed: 3 };

// Own keys only, so a stray status such as "constructor" is never mistaken for a stage.
// (Object.prototype.hasOwnProperty.call, not Object.hasOwn: older Hermes builds may lack the latter.)
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const rankOf = (stage) => (typeof stage === 'string' && hasOwn(STAGE_RANK, stage) ? STAGE_RANK[stage] : -1);
// Recognized review statuses in which the documents step is under way.
const DOCUMENT_STEP_STATUSES = ['awaiting_documents', 'in_review', 'changes_requested'];
const isObject = (value) => value !== null && typeof value === 'object';
const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

// A real timestamp as given, or null. Never "now", never a guess.
function timeOrNull(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) return value;
  return null;
}

function place(cityName, label, countryCode) {
  const full = textOrNull(label);
  return {
    city: textOrNull(cityName) || textOrNull(full ? full.split(',')[0] : null),
    label: full,
    countryCode: typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode) ? countryCode.toUpperCase() : null,
  };
}

// The most recent stage event of one stage: { exists, at }. `at` stays null when the event has no valid time.
function latestEvent(events, stage) {
  let exists = false;
  let best = null;
  for (const event of events) {
    if (event.stage !== stage) continue;
    exists = true;
    const at = timeOrNull(event.occurredAt);
    if (at && (best === null || Date.parse(at) >= Date.parse(best))) best = at;
  }
  return { exists, at: best };
}

function statusFor({ cancelled, rank, reviewStatus, reason }) {
  if (cancelled) return { key: 'cancelled', tone: 'cancelled', detail: null };
  // rank is -1 whenever the Case/request.status may not drive progress (unapproved or unknown review).
  if (rank >= STAGE_RANK.completed) return { key: 'completed', tone: 'done', detail: null };
  if (rank === STAGE_RANK.in_progress) return { key: 'in_progress', tone: 'info', detail: null };
  if (rank === STAGE_RANK.scheduled) return { key: 'scheduled', tone: 'info', detail: null };
  if (reviewStatus === 'awaiting_documents') return { key: 'awaiting_documents', tone: 'attention', detail: null };
  if (reviewStatus === 'changes_requested') return { key: 'changes_requested', tone: 'attention', detail: reason };
  if (reviewStatus === 'in_review') return { key: 'in_review', tone: 'info', detail: null };
  if (reviewStatus === 'approved') return { key: 'approved', tone: 'info', detail: null };
  return { key: 'received', tone: 'neutral', detail: null }; // legacy, or unknown review status
}

// The five approved patient-facing stages of the five-stage journey (the actual Air Ambulance pipeline), in order. Request Received is always reached;
// Quotation Ready, Payment Confirmed, Service In Progress and Completed are reached by the stage events "quotation_ready", "payment_confirmed",
// "in_progress" and "completed" (and Service In Progress / Completed also by the Case status). Text keys are acs_* (translated in every language).
const ACTUAL_STAGES = Object.freeze([
  { key: 'request_received', event: null },
  { key: 'quotation_ready', event: 'quotation_ready' },
  { key: 'payment_confirmed', event: 'payment_confirmed' },
  { key: 'service_in_progress', event: 'in_progress' },
  { key: 'completed', event: 'completed' },
]);
export const ACTUAL_STAGE_KEYS = Object.freeze(ACTUAL_STAGES.map((s) => s.key));
// The value of request.trackingFlow the backend sends for a request in this journey.
export const TRACKING_FLOW_FIVE_STAGE = 'five_stage';

// The five stages as a timeline, or null. They are shown ONLY when the backend says so (request.trackingFlow === 'five_stage'): never because a
// quotation or a payment exists, and never guessed from stage events. All five are always listed, from the first moment.
//   * The furthest stage reached is the current one (active; the last one is completed). Every stage before it counts as passed (completed), also
//     one that was skipped (Enquiry straight to Activate): it has no time of its own, because nothing happened at it.
//   * Before approval, or without a Case, nothing is reached beyond Request Received.
//   * A cancelled request stops at the furthest stage reached; the stages after it are not shown.
function buildActualStages({ flow, events, caseStatus, caseDrivesProgress, cancelled, createdAt }) {
  if (flow !== TRACKING_FLOW_FIVE_STAGE) return null;
  const reached = ACTUAL_STAGES.map((s) => s.event === null || (caseDrivesProgress && events.some((e) => e.stage === s.event)));
  if (caseDrivesProgress && !cancelled) {
    if (caseStatus === 'in_progress') reached[3] = true;
    if (caseStatus === 'completed') { reached[3] = true; reached[4] = true; }
  }
  let furthest = 0;
  reached.forEach((hit, i) => { if (hit) furthest = i; });
  return ACTUAL_STAGES.map((s, i) => {
    let state = MILESTONE_STATE.PENDING;
    if (cancelled) state = i < furthest ? MILESTONE_STATE.COMPLETED : i === furthest ? MILESTONE_STATE.CANCELLED : MILESTONE_STATE.NOT_APPLICABLE;
    else if (i < furthest || (i === furthest && i === ACTUAL_STAGES.length - 1)) state = MILESTONE_STATE.COMPLETED;
    else if (i === furthest) state = MILESTONE_STATE.ACTIVE;
    const at = s.event === null ? timeOrNull(createdAt) : caseDrivesProgress ? latestEvent(events, s.event).at : null;
    return {
      key: s.key, titleKey: `acs_${s.key}`, subKey: `acs_${s.key}_sub`, state,
      occurredAt: state === MILESTONE_STATE.PENDING || state === MILESTONE_STATE.NOT_APPLICABLE ? null : at,
    };
  });
}

export function buildPrivateCharterTracking(request) {
  const r = isObject(request) ? request : {};
  const c = isObject(r.case) ? r.case : null;
  const caseExists = c !== null;
  const events = (Array.isArray(c?.stageEvents) ? c.stageEvents : []).filter((e) => isObject(e) && typeof e.stage === 'string');

  // Any non-empty value puts the request in the review workflow; only the four known values are recognized.
  const raw = r.reviewStatus;
  const hasReviewValue = raw !== null && raw !== undefined && !(typeof raw === 'string' && raw.trim() === '');
  const reviewStatus = typeof raw === 'string' && REVIEW_STATUSES.includes(raw) ? raw : null;
  const mode = hasReviewValue ? 'review' : 'legacy';
  const reviewState = mode === 'legacy' ? 'not_applicable' : reviewStatus || 'unknown';
  // Approval comes from reviewStatus alone, never from the Case existing.
  const approved = reviewStatus === 'approved';
  // Only legacy and approved requests may take progress from the Case / request.status.
  const progressAllowed = mode === 'legacy' || approved;
  const caseDrivesProgress = caseExists && progressAllowed;
  const progressEvents = caseDrivesProgress ? events : [];

  const caseStatus = typeof c?.status === 'string' ? c.status : null;
  const cancelled = r.status === 'cancelled' || caseStatus === 'cancelled';

  // How far the Case got. case.status is the primary source; a cancelled Case (whose status says nothing about
  // progress) or an unknown status falls back to the furthest stage event. request.status NEVER establishes
  // progress: it collapses "scheduled" into "in_progress" and an admin can set it without a Case, so only the
  // Case is reliable evidence. -1 = nothing known beyond "received". (request.status still detects cancellation.)
  let rank = -1;
  if (caseDrivesProgress) {
    if (!cancelled && rankOf(caseStatus) >= 0) {
      rank = rankOf(caseStatus);
    } else {
      rank = Math.max(0, ...events.map((e) => rankOf(e.stage)));
    }
  }

  const scheduledEvent = latestEvent(progressEvents, 'scheduled');
  const inProgressEvent = latestEvent(progressEvents, 'in_progress');
  const completedEvent = latestEvent(progressEvents, 'completed');
  const cancelledEvent = latestEvent(events, 'cancelled');

  // Flight Scheduled needs real evidence: a scheduled event, or a Case that is in the scheduled stage.
  // If operations went straight on without it, it did not happen as a step and does not apply.
  const scheduledEvidence = caseDrivesProgress && (scheduledEvent.exists || caseStatus === 'scheduled');
  const scheduledSkipped = !scheduledEvidence && rank >= STAGE_RANK.in_progress;

  const submittedAt = timeOrNull(r.submittedAt);

  // `done`: the step is finished. `reached`: the journey got to it (a step under way is reached but not done:
  // documents in review, a mission in progress). `at`: the real time it was reached, or null.
  const defs = [
    { key: 'request_received', applies: true, done: true, reached: true, at: timeOrNull(r.createdAt) },
    { key: 'documents_review', applies: mode === 'review', done: approved, reached: approved || (reviewStatus !== null && submittedAt !== null), at: submittedAt },
    { key: 'request_approved', applies: mode === 'review', done: approved, reached: approved, at: reviewStatus === 'approved' ? timeOrNull(r.reviewedAt) : null },
    { key: 'flight_scheduled', applies: !scheduledSkipped, done: scheduledEvidence, reached: scheduledEvidence, at: scheduledEvent.at },
    { key: 'mission_in_progress', applies: true, done: rank >= STAGE_RANK.completed, reached: rank >= STAGE_RANK.in_progress, at: inProgressEvent.at },
    { key: 'completed', applies: true, done: rank >= STAGE_RANK.completed, reached: rank >= STAGE_RANK.completed, at: completedEvent.at },
  ];

  // A milestone is completed when it is done, or when a later applicable one is (so nothing is left "waiting"
  // behind a step that has happened).
  let laterDone = false;
  const reachedByLater = new Array(defs.length).fill(false);
  for (let i = defs.length - 1; i >= 0; i -= 1) {
    reachedByLater[i] = laterDone;
    if (defs[i].applies && defs[i].done) laterDone = true;
  }

  let states = defs.map((d, i) => {
    if (!d.applies) return MILESTONE_STATE.NOT_APPLICABLE;
    return d.done || reachedByLater[i] ? MILESTONE_STATE.COMPLETED : MILESTONE_STATE.PENDING;
  });

  let stoppedAtKey = null;
  if (cancelled) {
    // Stops at the furthest step reached: that one reads "cancelled", the ones before stay completed, the rest do not apply.
    // A step under way counts as reached (documents sent for review, a mission in progress), though it is not done.
    let furthest = 0;
    defs.forEach((d, i) => {
      if (d.applies && d.reached) furthest = i;
    });
    states = defs.map((d, i) => {
      if (!d.applies) return MILESTONE_STATE.NOT_APPLICABLE;
      if (i < furthest) return MILESTONE_STATE.COMPLETED;
      if (i === furthest) return MILESTONE_STATE.CANCELLED;
      return MILESTONE_STATE.NOT_APPLICABLE;
    });
    stoppedAtKey = defs[furthest].key;
  } else {
    // ACTIVE only on evidence that the step is under way; otherwise nothing is active.
    let activeIndex = -1;
    if (DOCUMENT_STEP_STATUSES.includes(reviewStatus)) activeIndex = 1;
    else if (approved && !scheduledEvidence && !scheduledSkipped && rank < STAGE_RANK.scheduled) activeIndex = 3;
    else if (rank === STAGE_RANK.in_progress) activeIndex = 4;
    if (activeIndex !== -1 && states[activeIndex] === MILESTONE_STATE.PENDING) states[activeIndex] = MILESTONE_STATE.ACTIVE;
  }

  const milestones = defs.map((d, i) => {
    const state = states[i];
    // A time belongs only to a step that has been reached.
    const reached = state === MILESTONE_STATE.COMPLETED || state === MILESTONE_STATE.ACTIVE || state === MILESTONE_STATE.CANCELLED;
    // Wording variants: documents_review follows the review status; flight_scheduled reads "Flight Scheduling"
    // while it is the active step and "Flight Scheduled" once it is completed.
    let wording = d.key;
    if (d.key === 'documents_review' && DOCUMENT_STEP_STATUSES.includes(reviewStatus)) wording = `${d.key}_${reviewStatus}`;
    if (d.key === 'flight_scheduled' && state === MILESTONE_STATE.ACTIVE) wording = 'flight_scheduling';
    return {
      key: d.key,
      titleKey: `tcp_m_${wording}`,
      subKey: `tcp_m_${wording}_sub`,
      state,
      occurredAt: reached ? d.at : null,
    };
  });

  const reason = textOrNull(r.documentsRequestReason);
  const changesReason = reviewStatus === 'changes_requested' && !cancelled ? reason : null;
  const actualStages = buildActualStages({
    flow: r.trackingFlow, events: progressEvents, caseStatus, caseDrivesProgress, cancelled, createdAt: r.createdAt,
  });
  let status = statusFor({ cancelled, rank, reviewStatus, reason: changesReason });
  // In the five-stage journey the chip names the current stage (Request Received ... Completed) once the request may take progress from its Case
  // (legacy or approved); while documents are in review the review chip stays. A cancelled request keeps "Cancelled".
  if (actualStages && !cancelled && progressAllowed) {
    const current = actualStages.find((m) => m.state === MILESTONE_STATE.ACTIVE) || actualStages[actualStages.length - 1];
    status = { key: current.key, tone: current.state === MILESTONE_STATE.COMPLETED ? 'done' : 'info', detail: null, labelKey: current.titleKey };
  }

  return {
    family: TRACKING_FAMILY.PRIVATE_CHARTER,
    mode,
    reference: textOrNull(r.referenceNumber),
    serviceName: textOrNull(r.serviceType) || PRIVATE_CHARTER_SERVICE_TYPE,
    origin: place(r.originCityName, r.origin, r.originCountryCode),
    destination: place(r.destinationCityName, r.destination, r.destinationCountryCode),
    status: { key: status.key, labelKey: status.labelKey || `tcp_status_${status.key}`, tone: status.tone, detail: status.detail },
    review: {
      mode,
      state: reviewState,
      approved,
      actionNeeded: !cancelled && (reviewStatus === 'awaiting_documents' || reviewStatus === 'changes_requested'),
      reason: changesReason,
      submittedAt,
      approvedAt: reviewStatus === 'approved' ? timeOrNull(r.reviewedAt) : null,
    },
    milestones,
    // The five actual-pipeline stages (Request Received ... Completed) for a request that is in that pipeline; null for every other request.
    actualStages,
    activeMilestone: (actualStages || milestones).find((m) => m.state === MILESTONE_STATE.ACTIVE) || null,
    cancellation: {
      isCancelled: cancelled,
      stoppedAtKey,
      cancelledAt: cancelled ? cancelledEvent.at : null,
    },
  };
}
