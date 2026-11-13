/* global describe, test, expect */
// Fixtures only: no database, no network, no native modules.
const { buildPrivateCharterTracking, MILESTONE_KEYS, MILESTONE_STATE } = require('../tracking/privateCharterTracking');
const palette = require('../tracking/palette');

const CREATED = '2026-11-01T08:00:00.000Z';
const SUBMITTED = '2026-11-01T09:00:00.000Z';
const REVIEWED = '2026-11-02T10:00:00.000Z';
const T_CASE = '2026-11-02T10:00:05.000Z';
const T_SCHEDULED = '2026-11-03T11:00:00.000Z';
const T_PROGRESS = '2026-11-04T12:00:00.000Z';
const T_DONE = '2026-11-05T13:00:00.000Z';
const T_CANCELLED = '2026-11-03T15:00:00.000Z';

const ev = (stage, occurredAt, note) => ({ id: Math.floor(Math.random() * 1e6), stage, note: note ?? null, occurredAt });
const caseOf = (status, stageEvents = [], extra = {}) => ({ id: 9, status, stageEvents, ...extra });

const base = (over = {}) => ({
  id: 5,
  serviceKey: 'privatecharter',
  serviceType: 'Private Charter Air Ambulance Service',
  referenceNumber: 'REQ-1005',
  origin: 'Mumbai, Maharashtra, India',
  destination: 'Dubai, United Arab Emirates',
  originCityName: 'Mumbai',
  destinationCityName: 'Dubai',
  originCountryCode: 'IN',
  destinationCountryCode: 'AE',
  status: 'submitted',
  reviewStatus: null,
  createdAt: CREATED,
  submittedAt: null,
  reviewedAt: null,
  documentsRequestReason: null,
  case: null,
  ...over,
});

const review = (reviewStatus, over = {}) => base({ reviewStatus, ...over });
const legacy = (over = {}) => base({ reviewStatus: null, case: caseOf('submitted', [ev('submitted', CREATED)]), ...over });

const states = (m) => m.milestones.map((x) => x.state);
const times = (m) => m.milestones.map((x) => x.occurredAt);
const milestone = (m, key) => m.milestones.find((x) => x.key === key);
const { COMPLETED: C, ACTIVE: A, PENDING: P, NOT_APPLICABLE: N, CANCELLED: X } = MILESTONE_STATE;

describe('shape', () => {
  test('milestones are the six approved ones, in order, with the five states', () => {
    const m = buildPrivateCharterTracking(base());
    expect(m.milestones.map((x) => x.key)).toEqual(MILESTONE_KEYS);
    expect(MILESTONE_KEYS).toEqual(['request_received', 'documents_review', 'request_approved', 'flight_scheduled', 'mission_in_progress', 'completed']);
    expect(Object.values(MILESTONE_STATE).sort()).toEqual(['active', 'cancelled', 'completed', 'not_applicable', 'pending']);
  });

  test('the model carries reference, service name, route, status, review info, milestones, active milestone and cancellation', () => {
    const m = buildPrivateCharterTracking(review('in_review', { submittedAt: SUBMITTED }));
    expect(m).toMatchObject({
      family: 'privatecharter',
      mode: 'review',
      reference: 'REQ-1005',
      serviceName: 'Private Charter Air Ambulance Service',
      origin: { city: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' },
      destination: { city: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' },
      status: { key: 'in_review', labelKey: 'tcp_status_in_review' },
      review: { mode: 'review', state: 'in_review', approved: false, actionNeeded: false },
      cancellation: { isCancelled: false, stoppedAtKey: null, cancelledAt: null },
    });
    expect(m.activeMilestone).toEqual(milestone(m, 'documents_review'));
    m.milestones.forEach((x) => {
      // documents_review carries a status-specific wording; every other milestone keeps its plain key.
      const wording = x.key === 'documents_review' ? 'documents_review_in_review' : x.key;
      expect(x.titleKey).toBe(`tcp_m_${wording}`);
      expect(x.subKey).toBe(`tcp_m_${wording}_sub`);
    });
  });

  test('a milestone is active only on evidence that the step is under way', () => {
    const one = [
      review('awaiting_documents'),
      review('in_review', { submittedAt: SUBMITTED }),
      review('changes_requested', { submittedAt: SUBMITTED }),
      review('approved', { reviewedAt: REVIEWED }),
      legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) }),
    ];
    one.forEach((r) => expect(states(buildPrivateCharterTracking(r)).filter((s) => s === A)).toHaveLength(1));
    const none = [
      legacy(),
      legacy({ status: 'in_progress', case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }),
      base({ reviewStatus: 'some_new_state' }),
    ];
    none.forEach((r) => {
      const m = buildPrivateCharterTracking(r);
      expect(states(m).filter((s) => s === A)).toHaveLength(0);
      expect(m.activeMilestone).toBeNull();
    });
    const done = buildPrivateCharterTracking(legacy({ status: 'completed', case: caseOf('completed', [ev('scheduled', T_SCHEDULED), ev('completed', T_DONE)]) }));
    expect(states(done).filter((s) => s === A)).toHaveLength(0);
    expect(done.activeMilestone).toBeNull();
  });
});

describe('review-enabled lifecycle, every reviewStatus', () => {
  test('awaiting_documents: nothing sent yet, waiting for the patient', () => {
    const m = buildPrivateCharterTracking(review('awaiting_documents'));
    expect(m.mode).toBe('review');
    expect(states(m)).toEqual([C, A, P, P, P, P]);
    expect(times(m)).toEqual([CREATED, null, null, null, null, null]);
    expect(m.status).toMatchObject({ key: 'awaiting_documents', tone: 'attention', detail: null });
    expect(m.review).toMatchObject({ state: 'awaiting_documents', actionNeeded: true, approved: false, reason: null });
  });

  test('in_review: documents with the Admin; the time is when the first document arrived', () => {
    const m = buildPrivateCharterTracking(review('in_review', { submittedAt: SUBMITTED }));
    expect(states(m)).toEqual([C, A, P, P, P, P]);
    expect(milestone(m, 'documents_review').occurredAt).toBe(SUBMITTED);
    expect(m.status.key).toBe('in_review');
    expect(m.review).toMatchObject({ actionNeeded: false, submittedAt: SUBMITTED, approvedAt: null });
  });

  test('changes_requested: action needed, the Admin\'s reason is passed on', () => {
    const m = buildPrivateCharterTracking(review('changes_requested', { submittedAt: SUBMITTED, reviewedAt: REVIEWED, documentsRequestReason: '  Please upload the discharge summary.  ' }));
    expect(states(m)).toEqual([C, A, P, P, P, P]);
    expect(m.status).toMatchObject({ key: 'changes_requested', tone: 'attention', detail: 'Please upload the discharge summary.' });
    expect(m.review).toMatchObject({ actionNeeded: true, reason: 'Please upload the discharge summary.', approvedAt: null });
    expect(milestone(m, 'request_approved').occurredAt).toBeNull();
  });

  test('the request reason is shown only while changes are requested', () => {
    const m = buildPrivateCharterTracking(review('in_review', { submittedAt: SUBMITTED, documentsRequestReason: 'old reason' }));
    expect(m.review.reason).toBeNull();
    expect(m.status.detail).toBeNull();
  });

  test('approved, Case not started yet: review steps done, flight scheduling is next; approval time is reviewedAt', () => {
    const m = buildPrivateCharterTracking(review('approved', { submittedAt: SUBMITTED, reviewedAt: REVIEWED }));
    expect(states(m)).toEqual([C, C, C, A, P, P]);
    expect(milestone(m, 'request_approved').occurredAt).toBe(REVIEWED);
    expect(milestone(m, 'documents_review').occurredAt).toBe(SUBMITTED);
    expect(m.status.key).toBe('approved');
    expect(m.review).toMatchObject({ approved: true, approvedAt: REVIEWED, actionNeeded: false });
  });

  test('approved with a Case still in its first stage', () => {
    const m = buildPrivateCharterTracking(review('approved', { submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: caseOf('submitted', [ev('submitted', T_CASE, 'Case opened after Admin approval of REQ-1005.')]) }));
    expect(states(m)).toEqual([C, C, C, A, P, P]);
    expect(m.status.key).toBe('approved');
  });

  test('reviewedAt is not an approval time unless reviewStatus is approved', () => {
    ['awaiting_documents', 'in_review', 'changes_requested'].forEach((s) => {
      const m = buildPrivateCharterTracking(review(s, { submittedAt: SUBMITTED, reviewedAt: REVIEWED }));
      expect(milestone(m, 'request_approved').occurredAt).toBeNull();
      expect(m.review.approvedAt).toBeNull();
      expect(JSON.stringify(m)).not.toContain(REVIEWED);
    });
  });

  test('documents_review keeps its key but uses status-specific wording keys', () => {
    const key = (s) => milestone(buildPrivateCharterTracking(review(s, { submittedAt: SUBMITTED })), 'documents_review').titleKey;
    expect(key('awaiting_documents')).toBe('tcp_m_documents_review_awaiting_documents');
    expect(key('in_review')).toBe('tcp_m_documents_review_in_review');
    expect(key('changes_requested')).toBe('tcp_m_documents_review_changes_requested');
    expect(key('approved')).toBe('tcp_m_documents_review');
    expect(key('some_new_state')).toBe('tcp_m_documents_review');
  });

  test('approved without scheduling evidence reads "Flight Scheduling"; with evidence it is "Flight Scheduled"', () => {
    const waiting = buildPrivateCharterTracking(review('approved', { reviewedAt: REVIEWED }));
    expect(milestone(waiting, 'flight_scheduled')).toMatchObject({ state: A, titleKey: 'tcp_m_flight_scheduling', subKey: 'tcp_m_flight_scheduling_sub' });
    const scheduled = buildPrivateCharterTracking(review('approved', { reviewedAt: REVIEWED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(milestone(scheduled, 'flight_scheduled')).toMatchObject({ state: C, titleKey: 'tcp_m_flight_scheduled', occurredAt: T_SCHEDULED });
  });

  test.each(['some_new_state', 'APPROVED', 'constructor', '__proto__', 42, {}])('unknown reviewStatus %p: neutral, not approved, nothing inferred', (value) => {
    [null, caseOf('submitted'), caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]), caseOf('in_progress', [ev('in_progress', T_PROGRESS)]), caseOf('completed', [ev('completed', T_DONE)])].forEach((c) => {
      const m = buildPrivateCharterTracking(base({ reviewStatus: value, status: 'in_progress', submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: c }));
      expect(m.mode).toBe('review');
      expect(m.review).toMatchObject({ mode: 'review', state: 'unknown', approved: false, actionNeeded: false, reason: null, approvedAt: null });
      expect(m.status).toMatchObject({ key: 'received', tone: 'neutral', detail: null });
      expect(states(m)).toEqual([C, P, P, P, P, P]);
      expect(m.activeMilestone).toBeNull();
      expect(m.milestones.map((x) => x.titleKey)).toEqual(MILESTONE_KEYS.map((k) => `tcp_m_${k}`));
      // the raw backend value never reaches the model
      if (typeof value === 'string') expect(JSON.stringify(m)).not.toContain(value);
    });
  });

  test('an empty reviewStatus behaves like no review workflow', () => {
    ['', '   '].forEach((value) => expect(buildPrivateCharterTracking(base({ reviewStatus: value })).mode).toBe('legacy'));
  });

  test('a cancelled unknown-status request stops at "received", not at documents', () => {
    const m = buildPrivateCharterTracking(base({ reviewStatus: 'some_new_state', status: 'cancelled', submittedAt: SUBMITTED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(states(m)).toEqual([X, N, N, N, N, N]);
    expect(m.cancellation.stoppedAtKey).toBe('request_received');
  });

  test.each(['awaiting_documents', 'in_review', 'changes_requested'])('%s: a stray Case or request.status never advances or approves the request', (s) => {
    const strays = [
      caseOf('submitted', [ev('submitted', T_CASE)]),
      caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]),
      caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]),
      caseOf('completed', [ev('completed', T_DONE)]),
    ];
    strays.forEach((c) => {
      const m = buildPrivateCharterTracking(review(s, { status: 'in_progress', submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: c }));
      expect(states(m)).toEqual([C, A, P, P, P, P]);
      expect(m.status.key).toBe(s);
      expect(m.review.approved).toBe(false);
      expect(m.review.approvedAt).toBeNull();
      expect(times(m).slice(2)).toEqual([null, null, null, null]);
      expect(JSON.stringify(m)).not.toContain(T_SCHEDULED);
    });
    // request.status alone, with no Case
    expect(states(buildPrivateCharterTracking(review(s, { status: 'completed' })))).toEqual([C, A, P, P, P, P]);
  });

  test('a stray Case does not stop a cancelled in_review request at a later step', () => {
    const m = buildPrivateCharterTracking(review('in_review', { status: 'cancelled', submittedAt: SUBMITTED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(states(m)).toEqual([C, X, N, N, N, N]);
    expect(m.cancellation.stoppedAtKey).toBe('documents_review');
  });

  test('review flow through to completion', () => {
    const events = [ev('submitted', T_CASE), ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS), ev('completed', T_DONE)];
    const reqOf = (status, caseStatus, n) => review('approved', { status, submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: caseOf(caseStatus, events.slice(0, n)) });

    const scheduled = buildPrivateCharterTracking(reqOf('in_progress', 'scheduled', 2));
    // scheduled does not imply the mission has started: mission pending, nothing active
    expect(states(scheduled)).toEqual([C, C, C, C, P, P]);
    expect(scheduled.activeMilestone).toBeNull();
    expect(milestone(scheduled, 'flight_scheduled').occurredAt).toBe(T_SCHEDULED);
    expect(scheduled.status.key).toBe('scheduled');

    const progress = buildPrivateCharterTracking(reqOf('in_progress', 'in_progress', 3));
    expect(states(progress)).toEqual([C, C, C, C, A, P]);
    expect(milestone(progress, 'mission_in_progress').occurredAt).toBe(T_PROGRESS);
    expect(progress.status.key).toBe('in_progress');

    const done = buildPrivateCharterTracking(reqOf('completed', 'completed', 4));
    expect(states(done)).toEqual([C, C, C, C, C, C]);
    expect(times(done)).toEqual([CREATED, SUBMITTED, REVIEWED, T_SCHEDULED, T_PROGRESS, T_DONE]);
    expect(done.status).toMatchObject({ key: 'completed', tone: 'done' });
  });
});

describe('legacy lifecycle (no review workflow, Case exists from submission)', () => {
  test('review milestones do not apply; an existing Case is not an approval and schedules nothing', () => {
    const m = buildPrivateCharterTracking(legacy());
    expect(m.mode).toBe('legacy');
    expect(states(m)).toEqual([C, N, N, P, P, P]);
    expect(m.activeMilestone).toBeNull();
    expect(times(m)).toEqual([CREATED, null, null, null, null, null]);
    expect(m.review).toMatchObject({ mode: 'legacy', state: 'not_applicable', approved: false, actionNeeded: false, reason: null, submittedAt: null, approvedAt: null });
    expect(m.status.key).toBe('received');
  });

  test('review milestones are never completed for a legacy request, whatever the Case stage', () => {
    const variants = [
      legacy(),
      legacy({ status: 'in_progress', case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }),
      legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('in_progress', T_PROGRESS)]) }),
      legacy({ status: 'completed', case: caseOf('completed', [ev('completed', T_DONE)]) }),
      legacy({ status: 'cancelled', case: caseOf('cancelled', [ev('cancelled', T_CANCELLED)]) }),
      base({ reviewStatus: null, case: null }),
      // an unexpected reviewedAt/submittedAt on a legacy row must not light the review steps either
      legacy({ submittedAt: SUBMITTED, reviewedAt: REVIEWED }),
    ];
    variants.forEach((r) => {
      const m = buildPrivateCharterTracking(r);
      expect(milestone(m, 'documents_review').state).toBe(N);
      expect(milestone(m, 'request_approved').state).toBe(N);
      expect(milestone(m, 'documents_review').occurredAt).toBeNull();
      expect(milestone(m, 'request_approved').occurredAt).toBeNull();
    });
  });

  test('legacy lifecycle through to completion, with all four steps timed from real events', () => {
    const events = [ev('submitted', CREATED), ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS), ev('completed', T_DONE)];
    const scheduled = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('scheduled', events.slice(0, 2)) }));
    expect(states(scheduled)).toEqual([C, N, N, C, P, P]);
    expect(scheduled.activeMilestone).toBeNull();
    expect(scheduled.status.key).toBe('scheduled');

    const progress = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('in_progress', events.slice(0, 3)) }));
    expect(states(progress)).toEqual([C, N, N, C, A, P]);
    expect(times(progress)).toEqual([CREATED, null, null, T_SCHEDULED, T_PROGRESS, null]);
    expect(progress.status.key).toBe('in_progress');

    const done = buildPrivateCharterTracking(legacy({ status: 'completed', case: caseOf('completed', events) }));
    expect(states(done)).toEqual([C, N, N, C, C, C]);
    expect(times(done)).toEqual([CREATED, null, null, T_SCHEDULED, T_PROGRESS, T_DONE]);
  });

  test('a request with no reviewStatus and no Case yet is still just "received"', () => {
    const m = buildPrivateCharterTracking(base({ reviewStatus: undefined, case: null }));
    expect(m.mode).toBe('legacy');
    expect(states(m)).toEqual([C, N, N, P, P, P]);
    expect(m.review.approved).toBe(false);
    expect(m.status.key).toBe('received');
  });
});

describe('Flight Scheduled', () => {
  test('completed by a real scheduled event even when the Case has moved on', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('submitted', CREATED), ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) }));
    expect(milestone(m, 'flight_scheduled')).toMatchObject({ state: C, occurredAt: T_SCHEDULED });
  });

  test('completed by a reliable Case status when the event has no usable time; the time stays null', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('scheduled', [ev('submitted', CREATED)]) }));
    expect(milestone(m, 'flight_scheduled')).toMatchObject({ state: C, occurredAt: null });
  });

  test('skipped by operations (straight to in_progress): not applicable, no time', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('submitted', CREATED), ev('in_progress', T_PROGRESS)]) }));
    expect(milestone(m, 'flight_scheduled')).toMatchObject({ state: N, occurredAt: null });
    expect(states(m)).toEqual([C, N, N, N, A, P]);
  });

  test('skipped straight to completed: not applicable', () => {
    const m = buildPrivateCharterTracking(review('approved', { status: 'completed', submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: caseOf('completed', [ev('submitted', T_CASE), ev('completed', T_DONE)]) }));
    expect(milestone(m, 'flight_scheduled').state).toBe(N);
    expect(states(m)).toEqual([C, C, C, N, C, C]);
  });

  test('not completed while the Case has not been scheduled', () => {
    expect(milestone(buildPrivateCharterTracking(legacy()), 'flight_scheduled').state).toBe(P);
    expect(milestone(buildPrivateCharterTracking(review('approved', { reviewedAt: REVIEWED })), 'flight_scheduled').state).toBe(A);
  });

  test('request.status alone never schedules a flight or starts a mission (it reads "in_progress" for scheduled Cases too)', () => {
    const m = buildPrivateCharterTracking(review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: null }));
    expect(milestone(m, 'flight_scheduled')).toMatchObject({ state: A, titleKey: 'tcp_m_flight_scheduling' });
    expect(milestone(m, 'mission_in_progress').state).toBe(P);
  });

  test('case.status is the primary source: a stale request.status does not override it', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'submitted', case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(milestone(m, 'flight_scheduled').state).toBe(C);
    expect(milestone(m, 'mission_in_progress').state).toBe(P);
    expect(m.status.key).toBe('scheduled');
  });
});

describe('cancelled requests', () => {
  test('cancelled while the flight was scheduled: stops there, later steps do not apply', () => {
    const m = buildPrivateCharterTracking(legacy({
      status: 'cancelled',
      case: caseOf('cancelled', [ev('submitted', CREATED), ev('scheduled', T_SCHEDULED), ev('cancelled', T_CANCELLED)]),
    }));
    expect(states(m)).toEqual([C, N, N, X, N, N]);
    expect(m.cancellation).toEqual({ isCancelled: true, stoppedAtKey: 'flight_scheduled', cancelledAt: T_CANCELLED });
    expect(m.status).toMatchObject({ key: 'cancelled', tone: 'cancelled', detail: null });
    expect(m.activeMilestone).toBeNull();
  });

  test('cancelled during the mission', () => {
    const m = buildPrivateCharterTracking(review('approved', {
      status: 'cancelled', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('cancelled', [ev('submitted', T_CASE), ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS), ev('cancelled', T_CANCELLED)]),
    }));
    expect(states(m)).toEqual([C, C, C, C, X, N]);
    expect(m.cancellation.stoppedAtKey).toBe('mission_in_progress');
  });

  test('cancelled right after approval', () => {
    const m = buildPrivateCharterTracking(review('approved', {
      status: 'cancelled', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('cancelled', [ev('submitted', T_CASE), ev('cancelled', T_CANCELLED)]),
    }));
    expect(states(m)).toEqual([C, C, X, N, N, N]);
    expect(m.cancellation.stoppedAtKey).toBe('request_approved');
  });

  test('cancelled with no Case, documents already sent', () => {
    const m = buildPrivateCharterTracking(review('in_review', { status: 'cancelled', submittedAt: SUBMITTED }));
    expect(states(m)).toEqual([C, X, N, N, N, N]);
    expect(m.cancellation).toEqual({ isCancelled: true, stoppedAtKey: 'documents_review', cancelledAt: null });
  });

  test('cancelled with no Case and nothing sent stops at "received"', () => {
    const m = buildPrivateCharterTracking(review('awaiting_documents', { status: 'cancelled' }));
    expect(states(m)).toEqual([X, N, N, N, N, N]);
    expect(m.cancellation.stoppedAtKey).toBe('request_received');
  });

  test('cancelled legacy request that never got past its first stage', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'cancelled', case: caseOf('cancelled', [ev('submitted', CREATED), ev('cancelled', T_CANCELLED)]) }));
    expect(states(m)).toEqual([X, N, N, N, N, N]);
  });

  test('cancelled is detected from either the request or the Case', () => {
    expect(buildPrivateCharterTracking(legacy({ status: 'cancelled' })).cancellation.isCancelled).toBe(true);
    expect(buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('cancelled', [ev('cancelled', T_CANCELLED)]) })).cancellation.isCancelled).toBe(true);
  });

  test('a cancelled request no longer asks the patient to act', () => {
    const m = buildPrivateCharterTracking(review('changes_requested', { status: 'cancelled', submittedAt: SUBMITTED, documentsRequestReason: 'Send the report.' }));
    expect(m.review).toMatchObject({ actionNeeded: false, reason: null });
    expect(m.status).toMatchObject({ key: 'cancelled', detail: null });
  });

  test('a cancelled time is never invented', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'cancelled', case: caseOf('cancelled', [ev('submitted', CREATED)]) }));
    expect(m.cancellation.cancelledAt).toBeNull();
  });
});

describe('missing and unknown data', () => {
  test('no Case, no timestamps: nothing is invented', () => {
    const m = buildPrivateCharterTracking({ serviceKey: 'privatecharter', status: 'submitted', reviewStatus: 'in_review' });
    expect(times(m)).toEqual([null, null, null, null, null, null]);
    expect(m.reference).toBeNull();
    expect(m.review.submittedAt).toBeNull();
    expect(m.cancellation.cancelledAt).toBeNull();
  });

  test('invalid timestamps become null', () => {
    const m = buildPrivateCharterTracking(review('approved', { createdAt: 'not a date', submittedAt: '', reviewedAt: 12345 }));
    expect(times(m)).toEqual([null, null, null, null, null, null]);
    expect(m.review.submittedAt).toBeNull();
  });

  test('a Case with no stage events, or with events missing their time', () => {
    const none = buildPrivateCharterTracking(legacy({ case: caseOf('scheduled', undefined) }));
    expect(milestone(none, 'flight_scheduled')).toMatchObject({ state: C, occurredAt: null });
    const noTime = buildPrivateCharterTracking(legacy({ case: caseOf('submitted', [{ stage: 'scheduled' }, { stage: 'scheduled', occurredAt: 'x' }]) }));
    expect(milestone(noTime, 'flight_scheduled')).toMatchObject({ state: C, occurredAt: null });
  });

  test('the latest event of a stage supplies its time, whatever the array order', () => {
    const later = '2026-11-03T18:00:00.000Z';
    const m = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('scheduled', [ev('scheduled', later), ev('scheduled', T_SCHEDULED)]) }));
    expect(milestone(m, 'flight_scheduled').occurredAt).toBe(later);
  });

  test('approved, no Case: request.status in_progress or completed infers no mission progress or completion', () => {
    ['in_progress', 'completed'].forEach((status) => {
      const m = buildPrivateCharterTracking(review('approved', { status, reviewedAt: REVIEWED }));
      expect(states(m)).toEqual([C, C, C, A, P, P]);
      expect(milestone(m, 'flight_scheduled')).toMatchObject({ state: A, titleKey: 'tcp_m_flight_scheduling', occurredAt: null });
      expect(milestone(m, 'mission_in_progress').state).toBe(P);
      expect(milestone(m, 'completed').state).toBe(P);
      expect(m.activeMilestone).toEqual(milestone(m, 'flight_scheduled'));
      expect(m.status).toMatchObject({ key: 'approved', tone: 'info' });
      expect(times(m)).toEqual([CREATED, null, REVIEWED, null, null, null]);
    });
  });

  test('legacy, no Case: request.status in_progress or completed infers nothing', () => {
    ['in_progress', 'completed'].forEach((status) => {
      const m = buildPrivateCharterTracking(base({ reviewStatus: null, status, case: null }));
      expect(states(m)).toEqual([C, N, N, P, P, P]);
      expect(m.activeMilestone).toBeNull();
      expect(m.status).toMatchObject({ key: 'received', tone: 'neutral' });
    });
  });

  test('no Case: request.status never yields a scheduled, in_progress or completed status, whatever its value', () => {
    ['submitted', 'scheduled', 'in_progress', 'completed', 'weird', null, undefined].forEach((status) => {
      ['approved', null].forEach((reviewStatus) => {
        const m = buildPrivateCharterTracking(base({ reviewStatus, status, case: null }));
        expect(['scheduled', 'in_progress', 'completed']).not.toContain(m.status.key);
        expect(milestone(m, 'mission_in_progress').state).toBe(P);
        expect(milestone(m, 'completed').state).toBe(P);
      });
    });
  });

  test('Case evidence still drives progress: scheduled, in_progress and completed Cases', () => {
    const collapsed = buildPrivateCharterTracking(review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(milestone(collapsed, 'flight_scheduled').state).toBe(C);
    expect(milestone(collapsed, 'mission_in_progress').state).toBe(P);
    expect(collapsed.status.key).toBe('scheduled');
    const progress = buildPrivateCharterTracking(review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) }));
    expect(milestone(progress, 'mission_in_progress').state).toBe(A);
    expect(progress.status.key).toBe('in_progress');
    const done = buildPrivateCharterTracking(review('approved', { status: 'completed', reviewedAt: REVIEWED, case: caseOf('completed', [ev('scheduled', T_SCHEDULED), ev('completed', T_DONE)]) }));
    expect(states(done)).toEqual([C, C, C, C, C, C]);
    expect(done.status.key).toBe('completed');
  });

  test('cancellation without a Case still works (request.status cancelled)', () => {
    const approved = buildPrivateCharterTracking(review('approved', { status: 'cancelled', submittedAt: SUBMITTED, reviewedAt: REVIEWED }));
    expect(states(approved)).toEqual([C, C, X, N, N, N]);
    expect(approved.cancellation).toMatchObject({ isCancelled: true, stoppedAtKey: 'request_approved' });
    expect(approved.status.key).toBe('cancelled');
    const plain = buildPrivateCharterTracking(base({ reviewStatus: null, status: 'cancelled', case: null }));
    expect(states(plain)).toEqual([X, N, N, N, N, N]);
    expect(plain.cancellation.stoppedAtKey).toBe('request_received');
  });

  test('unknown request.status, case.status and stage names do not throw and are not progress', () => {
    const m = buildPrivateCharterTracking(legacy({ status: 'weird', case: caseOf('weird_stage', [ev('also_weird', T_SCHEDULED), ev('constructor', T_SCHEDULED), ev('toString', T_PROGRESS)]) }));
    expect(states(m)).toEqual([C, N, N, P, P, P]);
    expect(m.status.key).toBe('received');
    const proto = buildPrivateCharterTracking(legacy({ status: 'constructor', case: caseOf('hasOwnProperty') }));
    expect(states(proto)).toEqual([C, N, N, P, P, P]);
  });

  test('own-property check works where Object.hasOwn is missing (older Hermes)', () => {
    const original = Object.hasOwn;
    Object.hasOwn = undefined;
    try {
      const m = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS), ev('toString', T_DONE)]) }));
      expect(states(m)).toEqual([C, N, N, C, A, P]);
      expect(buildPrivateCharterTracking(legacy({ case: caseOf('constructor', [ev('__proto__', T_DONE)]) })).status.key).toBe('received');
    } finally {
      Object.hasOwn = original;
    }
  });

  test('legacy Case with no reliable status or events reads like a submitted Case', () => {
    [caseOf(null, []), caseOf('weird', []), { id: 1 }].forEach((c) => {
      const m = buildPrivateCharterTracking(legacy({ case: c }));
      expect(states(m)).toEqual([C, N, N, P, P, P]);
      expect(m.activeMilestone).toBeNull();
      expect(m.status.key).toBe('received');
      expect(m.review.approved).toBe(false);
    });
  });

  test('legacy in_progress or completed without a scheduled step: flight scheduling does not apply', () => {
    const progress = buildPrivateCharterTracking(legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('in_progress', T_PROGRESS)]) }));
    expect(states(progress)).toEqual([C, N, N, N, A, P]);
    const done = buildPrivateCharterTracking(legacy({ status: 'completed', case: caseOf('completed', [ev('completed', T_DONE)]) }));
    expect(states(done)).toEqual([C, N, N, N, C, C]);
  });

  test.each([null, undefined, 0, 'text', [], {}])('a non-request input (%p) does not throw and yields an empty, honest model', (input) => {
    const m = buildPrivateCharterTracking(input);
    expect(m.milestones).toHaveLength(6);
    expect(m.reference).toBeNull();
    expect(m.serviceName).toBe('Private Charter Air Ambulance Service');
    expect(times(m)).toEqual([null, null, null, null, null, null]);
  });

  test('malformed Case and event entries are ignored', () => {
    const m = buildPrivateCharterTracking(legacy({ case: { status: 'submitted', stageEvents: [null, 7, 'x', { stage: 5 }, { occurredAt: T_SCHEDULED }] } }));
    expect(states(m)).toEqual([C, N, N, P, P, P]);
    expect(buildPrivateCharterTracking(legacy({ case: 'not-an-object' })).review.approved).toBe(false);
  });
});

describe('origin and destination', () => {
  test('uses the verified city names and country codes', () => {
    const m = buildPrivateCharterTracking(base());
    expect(m.origin).toEqual({ city: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: 'IN' });
    expect(m.destination).toEqual({ city: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: 'AE' });
  });

  test('falls back to the city part of the readable label when the verified fields are null', () => {
    const m = buildPrivateCharterTracking(base({ originCityName: null, destinationCityName: undefined, originCountryCode: null, destinationCountryCode: undefined }));
    expect(m.origin).toEqual({ city: 'Mumbai', label: 'Mumbai, Maharashtra, India', countryCode: null });
    expect(m.destination).toEqual({ city: 'Dubai', label: 'Dubai, United Arab Emirates', countryCode: null });
  });

  test('missing origin and destination give nulls, not placeholders', () => {
    const m = buildPrivateCharterTracking(base({ origin: null, destination: undefined, originCityName: null, destinationCityName: null, originCountryCode: null, destinationCountryCode: null }));
    expect(m.origin).toEqual({ city: null, label: null, countryCode: null });
    expect(m.destination).toEqual({ city: null, label: null, countryCode: null });
    const blank = buildPrivateCharterTracking(base({ origin: '   ', destination: '', originCityName: '  ', destinationCityName: '' }));
    expect(blank.origin.city).toBeNull();
    expect(blank.destination.city).toBeNull();
  });

  test('a country code is accepted only as two letters', () => {
    const m = buildPrivateCharterTracking(base({ originCountryCode: 'in', destinationCountryCode: 'ARE' }));
    expect(m.origin.countryCode).toBe('IN');
    expect(m.destination.countryCode).toBeNull();
  });
});

describe('no invented timestamps', () => {
  test('every time in the model is one the request itself carries', () => {
    const request = review('approved', {
      status: 'in_progress', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('in_progress', [ev('submitted', T_CASE), ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]),
    });
    const given = new Set([CREATED, SUBMITTED, REVIEWED, T_CASE, T_SCHEDULED, T_PROGRESS]);
    const m = buildPrivateCharterTracking(request);
    const found = JSON.stringify(m).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) || [];
    expect(found.length).toBeGreaterThan(0);
    found.forEach((t) => expect(given.has(t)).toBe(true));
  });

  test('a milestone that has not been reached never has a time', () => {
    const m = buildPrivateCharterTracking(review('approved', {
      submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('submitted', [ev('submitted', T_CASE), ev('completed', T_DONE)]), // a stray later event on a Case that is still "submitted"
    }));
    m.milestones.filter((x) => x.state === P || x.state === N).forEach((x) => expect(x.occurredAt).toBeNull());
  });

  test('updatedAt is never used as a milestone time', () => {
    const UPDATED = '2026-12-31T23:59:59.000Z';
    const m = buildPrivateCharterTracking(review('in_review', { updatedAt: UPDATED }));
    expect(JSON.stringify(m)).not.toContain(UPDATED);
    expect(times(m)).toEqual([CREATED, null, null, null, null, null]);
    const l = buildPrivateCharterTracking(legacy({ updatedAt: UPDATED, status: 'completed', case: caseOf('completed', [ev('completed', T_DONE)]) }));
    expect(JSON.stringify(l)).not.toContain(UPDATED);
  });

  test('the model is built without reading the clock', () => {
    const real = Date.now;
    Date.now = () => { throw new Error('clock read'); };
    try {
      expect(() => buildPrivateCharterTracking(review('approved', { reviewedAt: REVIEWED }))).not.toThrow();
    } finally {
      Date.now = real;
    }
  });
});

describe('nothing sensitive or invented reaches the model', () => {
  const SECRETS = {
    billingAmount: '98765.43', billingCurrency: 'XCD', billingStatus: 'overdue', billingNotes: 'BILLING-NOTE-SECRET',
    bitrixLeadId: 424242, bitrixLastError: 'BITRIX-ERROR-SECRET', bitrixSyncAttempts: 7, bitrixSyncFailedAt: '2026-11-09T00:00:00.000Z',
    notes: 'INTERNAL-NOTE-SECRET', additionalInfo: 'ADDITIONAL-SECRET', specialRequirements: 'SPECIAL-SECRET', referralSource: 'REFERRAL-SECRET',
    policyReference: 'POLICY-SECRET', description: 'DESCRIPTION-SECRET', careLevel: 'care_icu', urgency: 'critical_6h',
    patientName: 'PATIENT-NAME-SECRET', patientAge: 61, patientGender: 'male', patientContact: '+919000000000', patientLocation: 'LOCATION-SECRET',
    mobility: 'bedridden', equipOxygen: true, equipVentilator: true, equipCardiacMonitor: true,
    originGeonameId: 1275339, destinationGeonameId: 292223, originTimezone: 'Asia/Kolkata',
    preferredDate: '2026-12-25', userId: 77, user: { email: 'USER-EMAIL-SECRET' },
    updatedAt: '2026-12-30T00:00:00.000Z',
    requestDocuments: [{ id: 1, originalName: 'DOCUMENT-NAME-SECRET.pdf', scanStatus: 'clean', rejectionReason: 'DOC-REASON-SECRET' }],
    requestEvents: [{ action: 'EVENT-ACTION-SECRET', detail: { x: 1 } }],
    eta: '2026-12-01T10:00:00Z', distance: 3300, distanceKm: 3300, latitude: 12.3, longitude: 45.6, flightNumber: 'FL123', tailNumber: 'VT-ABC', coordinator: { name: 'COORDINATOR-SECRET', phone: '+10000000000' },
  };
  const CASE_SECRETS = {
    billingAmount: '1.00', billingNotes: 'CASE-BILLING-SECRET', notes: 'CASE-NOTE-SECRET', bitrixLastError: 'CASE-BITRIX-SECRET', bitrixLeadId: 99,
    policyReference: 'CASE-POLICY-SECRET', communications: [{ summary: 'COMMUNICATION-SECRET' }], documents: [{ id: 1, name: 'CASE-DOC-SECRET.pdf' }], serviceRequest: { userId: 1 },
  };

  const full = () => base({
    ...SECRETS, status: 'in_progress', reviewStatus: 'approved', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
    case: caseOf('scheduled', [ev('submitted', T_CASE, 'STAGE-NOTE-SECRET'), ev('scheduled', T_SCHEDULED, 'OPS-NOTE-SECRET')], CASE_SECRETS),
  });

  test('none of the internal values appear anywhere in the model', () => {
    const text = JSON.stringify(buildPrivateCharterTracking(full()));
    ['SECRET', '98765', 'XCD', '424242', '+919000000000', 'male', 'Asia/Kolkata', '1275339', '2026-12-25', '2026-12-30', 'FL123', 'VT-ABC', '3300', 'care_icu', 'critical_6h']
      .forEach((needle) => expect(text).not.toContain(needle));
  });

  test('the model has exactly the approved top-level fields and no ETA, distance, position or coordinator', () => {
    const m = buildPrivateCharterTracking(full());
    expect(Object.keys(m).sort()).toEqual(['activeMilestone', 'cancellation', 'destination', 'family', 'milestones', 'mode', 'origin', 'reference', 'review', 'serviceName', 'status'].sort());
    expect(Object.keys(m.status).sort()).toEqual(['detail', 'key', 'labelKey', 'tone']);
    expect(Object.keys(m.milestones[0]).sort()).toEqual(['key', 'occurredAt', 'state', 'subKey', 'titleKey']);
    expect(Object.keys(m.review).sort()).toEqual(['actionNeeded', 'approved', 'approvedAt', 'mode', 'reason', 'state', 'submittedAt']);
    const forbidden = /^(eta|etd|distance\w*|latitude|longitude|position|flightNumber|tailNumber|aircraft\w*|coordinator\w*|billing\w*|bitrix\w*|notes?|patient\w*|contact\w*|email|phone)$/i;
    const keysOf = (value) => (value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
    keysOf(m).forEach((k) => expect(k).not.toMatch(forbidden));
  });

  test('the model is a fresh object: changing it does not change the request', () => {
    const request = full();
    const copy = JSON.stringify(request);
    const m = buildPrivateCharterTracking(request);
    m.milestones.forEach((x) => { x.state = 'x'; });
    m.origin.city = 'changed';
    expect(JSON.stringify(request)).toBe(copy);
  });

  test('building the model does not modify the request', () => {
    const request = full();
    const copy = JSON.stringify(request);
    buildPrivateCharterTracking(request);
    expect(JSON.stringify(request)).toBe(copy);
  });
});

describe('palette', () => {
  test('uses the approved brand colours', () => {
    expect(palette.NAVY).toBe('#0D2340');
    expect(palette.BLUE).toBe('#2457A7');
    expect(palette.LIGHT).toBe('#EDF2F9');
    expect(palette.WHITE).toBe('#FFFFFF');
  });

  test('every colour is a valid hex value and none of the theme colours is green', () => {
    Object.entries(palette.PALETTE).forEach(([name, hex]) => {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
      if (['NAVY', 'BLUE', 'LIGHT', 'WHITE'].includes(name)) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        expect(g > r && g > b).toBe(false);
      }
    });
    expect(Object.isFrozen(palette.PALETTE)).toBe(true);
  });
});
