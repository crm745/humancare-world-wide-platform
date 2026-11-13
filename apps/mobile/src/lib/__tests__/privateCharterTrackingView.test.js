/* global describe, test, expect */
// Fixtures only: no database, no network, no native modules.
const { buildPrivateCharterTracking } = require('../tracking/privateCharterTracking');
const view = require('../tracking/privateCharterTrackingView');
const { isPrivateCharterTracking } = require('../tracking/serviceFamily');
const { trackingItemFromCase, trackingItemFromRequest } = require('../trackingItem');
const I18N = require('../../data/i18n.json');

const { timelineRows, formatTime, routeEnds, changesMessage, showOpenRequest, toneColors, COLORS, MODEL_TEXT_KEYS } = view;

const CREATED = '2026-11-01T08:00:00.000Z';
const SUBMITTED = '2026-11-01T09:00:00.000Z';
const REVIEWED = '2026-11-02T10:00:00.000Z';
const T_SCHEDULED = '2026-11-03T11:00:00.000Z';
const T_PROGRESS = '2026-11-04T12:00:00.000Z';
const T_DONE = '2026-11-05T13:00:00.000Z';
const T_CANCELLED = '2026-11-03T15:00:00.000Z';

const ev = (stage, occurredAt) => ({ id: 1, stage, note: null, occurredAt });
const caseOf = (status, stageEvents = []) => ({ id: 9, status, stageEvents });
const base = (over = {}) => ({
  id: 5, serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', referenceNumber: 'REQ-1005',
  origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates', originCityName: 'Mumbai', destinationCityName: 'Dubai',
  originCountryCode: 'IN', destinationCountryCode: 'AE', status: 'submitted', reviewStatus: null, createdAt: CREATED, submittedAt: null,
  reviewedAt: null, documentsRequestReason: null, case: null, ...over,
});
const review = (reviewStatus, over = {}) => base({ reviewStatus, ...over });
const legacy = (over = {}) => base({ reviewStatus: null, case: caseOf('submitted', [ev('submitted', CREATED)]), ...over });
const model = (request) => buildPrivateCharterTracking(request);
const dots = (m) => timelineRows(m).map((r) => r.dot);
const keys = (m) => timelineRows(m).map((r) => r.key);

describe('which requests use the Private Charter presentation', () => {
  test('review-workflow and legacy Private Charter requests are detected from the raw request', () => {
    expect(isPrivateCharterTracking(review('in_review'))).toBe(true);
    expect(isPrivateCharterTracking(legacy())).toBe(true);
    expect(isPrivateCharterTracking(base({ serviceKey: 'air' }))).toBe(false); // legacy "air" uses generic tracking
  });

  test('other services, and a corporate Case item, are never detected', () => {
    expect(isPrivateCharterTracking(base({ serviceKey: 'commercialair_stretcher' }))).toBe(false);
    expect(isPrivateCharterTracking(base({ serviceKey: null }))).toBe(false);
    const caseItem = trackingItemFromCase({ referenceNumber: 'CASE-1', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress', patientName: 'P' });
    expect(caseItem.rawRequest).toBeUndefined();
    expect(isPrivateCharterTracking(caseItem.rawRequest)).toBe(false);
  });

  test('a patient item gives the model the raw request, with fields the flat item drops', () => {
    const raw = review('approved', { reviewedAt: REVIEWED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) });
    const item = trackingItemFromRequest({ ...raw, patientName: 'A Patient' });
    const m = model(item.rawRequest);
    expect(m.status.key).toBe('scheduled');
    expect(m.review.approved).toBe(true);
  });
});

describe('timeline rows: visibility and order', () => {
  test('legacy hides the two review steps; the rest keep the model order', () => {
    expect(keys(model(legacy()))).toEqual(['request_received', 'flight_scheduled', 'mission_in_progress', 'completed']);
  });

  test('a review request shows all six, in the fixed order', () => {
    expect(keys(model(review('in_review', { submittedAt: SUBMITTED })))).toEqual(['request_received', 'documents_review', 'request_approved', 'flight_scheduled', 'mission_in_progress', 'completed']);
  });

  test('a step operations skipped is hidden, and nothing is shown for not_applicable', () => {
    const m = model(legacy({ status: 'in_progress', case: caseOf('in_progress', [ev('in_progress', T_PROGRESS)]) }));
    expect(keys(m)).toEqual(['request_received', 'mission_in_progress', 'completed']);
    timelineRows(m).forEach((r) => expect(['completed', 'active', 'pending', 'cancelled']).toContain(r.dot));
  });

  test('exactly the last row has last = true', () => {
    const rows = timelineRows(model(review('approved', { reviewedAt: REVIEWED })));
    expect(rows.filter((r) => r.last)).toHaveLength(1);
    expect(rows[rows.length - 1].last).toBe(true);
  });

  test('a missing or malformed model gives no rows and does not throw', () => {
    [null, undefined, {}, { milestones: 'x' }, { milestones: [null, { state: 'weird', key: 'x' }] }].forEach((m) => expect(timelineRows(m)).toEqual([]));
  });
});

describe('timeline rows: completed, active and pending', () => {
  test('approved, waiting for scheduling: Flight Scheduling is the active row', () => {
    const m = model(review('approved', { submittedAt: SUBMITTED, reviewedAt: REVIEWED }));
    expect(dots(m)).toEqual(['completed', 'completed', 'completed', 'active', 'pending', 'pending']);
    expect(timelineRows(m)[3].titleKey).toBe('tcp_m_flight_scheduling');
  });

  test('scheduled: Flight Scheduled is completed, the mission is pending, and no row is active (activeMilestone is null)', () => {
    const m = model(review('approved', { submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }));
    expect(m.activeMilestone).toBeNull();
    expect(dots(m)).toEqual(['completed', 'completed', 'completed', 'completed', 'pending', 'pending']);
    expect(timelineRows(m)[3]).toMatchObject({ titleKey: 'tcp_m_flight_scheduled', time: formatTime(T_SCHEDULED) });
  });

  test('legacy submitted: nothing is active and the pending steps do not claim anything', () => {
    const m = model(legacy());
    expect(m.activeMilestone).toBeNull();
    expect(dots(m)).toEqual(['completed', 'pending', 'pending', 'pending']);
  });

  test('in progress and completed', () => {
    const progress = model(review('approved', { reviewedAt: REVIEWED, case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) }));
    expect(dots(progress)).toEqual(['completed', 'completed', 'completed', 'completed', 'active', 'pending']);
    const done = model(review('approved', { reviewedAt: REVIEWED, case: caseOf('completed', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS), ev('completed', T_DONE)]) }));
    expect(dots(done)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
  });

  test('a pending row shows the Pending label and no time; a reached row shows its time', () => {
    const rows = timelineRows(model(review('in_review', { submittedAt: SUBMITTED })));
    const pending = rows.filter((r) => r.dot === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    pending.forEach((r) => expect(r).toMatchObject({ time: '', showPendingLabel: true }));
    expect(rows[0]).toMatchObject({ dot: 'completed', time: formatTime(CREATED), showPendingLabel: false });
    expect(rows[1]).toMatchObject({ dot: 'active', time: formatTime(SUBMITTED) });
  });

  test('unknown review status: only the first step is done, nothing is active, nothing is claimed', () => {
    const m = model(review('some_new_state', { case: caseOf('completed', [ev('completed', T_DONE)]) }));
    expect(m.activeMilestone).toBeNull();
    expect(dots(m)).toEqual(['completed', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(JSON.stringify(timelineRows(m))).not.toContain('some_new_state');
  });

  test('a request with no Case at all draws without error', () => {
    expect(() => timelineRows(model(review('approved', { reviewedAt: REVIEWED, case: null })))).not.toThrow();
    expect(dots(model(review('awaiting_documents')))).toEqual(['completed', 'active', 'pending', 'pending', 'pending', 'pending']);
  });
});

describe('dynamic document-review wording', () => {
  const title = (s) => timelineRows(model(review(s, { submittedAt: SUBMITTED })))[1].titleKey;
  const sub = (s) => timelineRows(model(review(s, { submittedAt: SUBMITTED })))[1].subKey;

  test('the documents row follows the review status', () => {
    expect(title('awaiting_documents')).toBe('tcp_m_documents_review_awaiting_documents');
    expect(title('in_review')).toBe('tcp_m_documents_review_in_review');
    expect(title('changes_requested')).toBe('tcp_m_documents_review_changes_requested');
    expect(sub('in_review')).toBe('tcp_m_documents_review_in_review_sub');
    expect(title('approved')).toBe('tcp_m_documents_review');
  });

  test('English reads Documents Required / Under Review / Changes Required, and Flight Scheduling vs Scheduled', () => {
    const en = I18N.EN;
    expect(en.tcp_m_documents_review_awaiting_documents).toBe('Documents required');
    expect(en.tcp_m_documents_review_in_review).toBe('Documents under review');
    expect(en.tcp_m_documents_review_changes_requested).toBe('Changes required');
    expect(en.tcp_m_flight_scheduling).toBe('Flight scheduling');
    expect(en.tcp_m_flight_scheduled).toBe('Flight scheduled');
  });
});

describe('changes requested and the open-request action', () => {
  test('the Admin message is shown, trimmed, only while changes are requested', () => {
    const m = model(review('changes_requested', { submittedAt: SUBMITTED, documentsRequestReason: '  Please upload the discharge summary.  ' }));
    expect(changesMessage(m)).toBe('Please upload the discharge summary.');
    expect(showOpenRequest(m)).toBe(true);
    expect(changesMessage(model(review('in_review', { submittedAt: SUBMITTED, documentsRequestReason: 'old' })))).toBeNull();
    expect(changesMessage(null)).toBeNull();
  });

  test('the action is offered when documents are needed, and not otherwise', () => {
    expect(showOpenRequest(model(review('awaiting_documents')))).toBe(true);
    expect(showOpenRequest(model(review('in_review')))).toBe(false);
    expect(showOpenRequest(model(review('approved')))).toBe(false);
    expect(showOpenRequest(model(legacy()))).toBe(false);
    expect(showOpenRequest(model(review('awaiting_documents', { status: 'cancelled' })))).toBe(false);
  });
});

describe('cancellation', () => {
  test('the stop row is red, says it was closed, uses the cancellation time, and later steps disappear', () => {
    const m = model(review('approved', {
      status: 'cancelled', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('cancelled', [ev('scheduled', T_SCHEDULED), ev('cancelled', T_CANCELLED)]),
    }));
    const rows = timelineRows(m);
    expect(rows.map((r) => r.dot)).toEqual(['completed', 'completed', 'completed', 'cancelled']);
    expect(rows[3]).toMatchObject({ key: 'flight_scheduled', subKey: 'tcp_cancelled_sub', time: formatTime(T_CANCELLED) });
    expect(toneColors(m.status.tone).fg).toBe(COLORS.CANCEL);
  });

  test('the cancelled row is titled with the cancellation label, keeps its position, and every other row keeps its own title', () => {
    const m = model(review('approved', {
      status: 'cancelled', submittedAt: SUBMITTED, reviewedAt: REVIEWED,
      case: caseOf('cancelled', [ev('scheduled', T_SCHEDULED), ev('cancelled', T_CANCELLED)]),
    }));
    const rows = timelineRows(m);
    expect(rows[3]).toMatchObject({ key: 'flight_scheduled', dot: 'cancelled', titleKey: 'tcp_cancelled_label', stepTitleKey: 'tcp_m_flight_scheduled', last: true });
    expect(rows.slice(0, 3).map((r) => r.titleKey)).toEqual(m.milestones.slice(0, 3).map((x) => x.titleKey));
    rows.slice(0, 3).forEach((r) => expect(r.titleKey).not.toBe('tcp_cancelled_label'));
    // never the milestone's own "Flight scheduled" as the title of a cancelled row
    expect(I18N.EN[rows[3].titleKey]).toBe('Cancelled');
  });

  test.each(['EN', 'HI', 'MR', 'GU', 'TE', 'AR'])('%s: the cancellation label is translated and is not the milestone title', (lang) => {
    expect(I18N[lang].tcp_cancelled_label).toBeTruthy();
    expect(I18N[lang].tcp_cancelled_label).not.toBe(I18N[lang].tcp_m_flight_scheduled);
  });

  test('a request cancelled at the first step still titles that row "Cancelled"', () => {
    const rows = timelineRows(model(legacy({ status: 'cancelled', case: caseOf('cancelled', [ev('submitted', CREATED)]) })));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dot: 'cancelled', titleKey: 'tcp_cancelled_label', stepTitleKey: 'tcp_m_request_received', subKey: 'tcp_cancelled_sub' });
  });

  test('a cancelled time is never invented', () => {
    const m = model(legacy({ status: 'cancelled', case: caseOf('cancelled', [ev('submitted', CREATED)]) }));
    expect(timelineRows(m)[0]).toMatchObject({ dot: 'cancelled', time: '' });
  });

  test('cancelled before approval, with no Case, stops at the right row', () => {
    const rows = timelineRows(model(review('in_review', { status: 'cancelled', submittedAt: SUBMITTED })));
    expect(rows.map((r) => r.dot)).toEqual(['completed', 'cancelled']);
  });
});

describe('route', () => {
  test('uses the cities from the model, and null for a missing one', () => {
    expect(routeEnds(model(base()))).toEqual({ origin: 'Mumbai', destination: 'Dubai' });
    expect(routeEnds(model(base({ origin: null, destination: undefined, originCityName: null, destinationCityName: '' })))).toEqual({ origin: null, destination: null });
    expect(routeEnds(null)).toEqual({ origin: null, destination: null });
  });

  test('the city falls back to the readable label when the verified name is missing', () => {
    expect(routeEnds(model(base({ originCityName: null, destinationCityName: null })))).toEqual({ origin: 'Mumbai', destination: 'Dubai' });
  });
});

describe('timestamps', () => {
  test('a valid time is shown to the minute; anything else is empty', () => {
    expect(formatTime(CREATED)).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/);
    [null, undefined, '', '   ', 'not a date', 12345, {}].forEach((v) => expect(formatTime(v)).toBe(''));
  });

  test('invalid times in the request give rows with no time, not a crash', () => {
    const rows = timelineRows(model(review('approved', { createdAt: 'nope', submittedAt: '', reviewedAt: 12345 })));
    rows.forEach((r) => expect(r.time).toBe(''));
  });

  test('the view never reads the clock', () => {
    const real = Date.now;
    Date.now = () => { throw new Error('clock read'); };
    try {
      expect(() => timelineRows(model(review('approved', { reviewedAt: REVIEWED })))).not.toThrow();
    } finally {
      Date.now = real;
    }
  });
});

describe('header status comes from the model, never from the collapsed request.status', () => {
  const scenarios = {
    'awaiting documents': review('awaiting_documents'),
    'in review': review('in_review', { submittedAt: SUBMITTED }),
    'changes requested': review('changes_requested', { submittedAt: SUBMITTED, documentsRequestReason: 'Please resend the report.' }),
    approved: review('approved', { reviewedAt: REVIEWED }),
    // the backend writes request.status = in_progress for a scheduled Case too
    scheduled: review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }),
    'in progress': review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) }),
    completed: review('approved', { status: 'completed', reviewedAt: REVIEWED, case: caseOf('completed', [ev('scheduled', T_SCHEDULED), ev('completed', T_DONE)]) }),
    cancelled: review('approved', { status: 'cancelled', reviewedAt: REVIEWED, case: caseOf('cancelled', [ev('cancelled', T_CANCELLED)]) }),
    'legacy submitted': legacy(),
    'legacy scheduled': legacy({ status: 'in_progress', case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }),
    unknown: review('some_new_state', { status: 'in_progress' }),
    'no Case': review('approved', { status: 'in_progress', reviewedAt: REVIEWED, case: null }),
  };

  test.each(Object.keys(scenarios))('%s: the chip label and tone are the model status, with translations in every language', (name) => {
    const m = model(scenarios[name]);
    expect(m.status.labelKey).toBe(`tcp_status_${m.status.key}`);
    expect(toneColors(m.status.tone)).toEqual(expect.objectContaining({ fg: expect.any(String), bg: expect.any(String) }));
    Object.keys(I18N).forEach((lang) => expect(I18N[lang][m.status.labelKey]).toBeTruthy());
    // the timeline and the chip agree: a status of scheduled/in_progress/completed matches the rows
    if (m.status.key === 'scheduled') expect(m.activeMilestone).toBeNull();
    if (m.status.key === 'in_progress') expect(m.activeMilestone && m.activeMilestone.key).toBe('mission_in_progress');
    if (m.status.key === 'cancelled') expect(timelineRows(m).some((r) => r.dot === 'cancelled')).toBe(true);
  });

  test('a scheduled Case whose request.status reads in_progress is "scheduled", not "in progress"', () => {
    expect(model(scenarios.scheduled).status.key).toBe('scheduled');
    expect(model(scenarios['legacy scheduled']).status.key).toBe('scheduled');
    expect(model(scenarios['no Case']).status.key).toBe('approved');
    expect(model(scenarios.unknown).status.key).toBe('received');
  });
});

describe('RTL route arrow', () => {
  test('a right-to-left language mirrors the arrow, a left-to-right one leaves it alone', () => {
    expect(view.mirrorStyle(true)).toEqual({ transform: [{ scaleX: -1 }] });
    expect(view.mirrorStyle(false)).toBeNull();
    expect(view.mirrorStyle(undefined)).toBeNull();
  });
});

describe('timeline accessibility labels', () => {
  const en = (key) => I18N.EN[key];
  const label = (row) => view.rowAccessibilityLabel(row, en);

  test('each row says its step and its state', () => {
    const rows = timelineRows(model(review('approved', { submittedAt: SUBMITTED, reviewedAt: REVIEWED, case: caseOf('in_progress', [ev('scheduled', T_SCHEDULED), ev('in_progress', T_PROGRESS)]) })));
    expect(label(rows[0])).toMatch(/^Request received, Completed, /);
    expect(label(rows[4])).toMatch(/^Mission in progress, Current step, /);
    expect(label(rows[5])).toMatch(/^Completed, Pending, /);
    expect(label(rows[3])).toContain(formatTime(T_SCHEDULED));
  });

  test('a cancelled row is announced by the step it stopped at, with the state and the closed text', () => {
    const rows = timelineRows(model(review('approved', { status: 'cancelled', reviewedAt: REVIEWED, case: caseOf('cancelled', [ev('scheduled', T_SCHEDULED), ev('cancelled', T_CANCELLED)]) })));
    expect(label(rows[3])).toBe(`Flight scheduled, Cancelled, ${en('tcp_cancelled_sub')}, ${formatTime(T_CANCELLED)}`);
  });

  test('a waiting-for-scheduling row reads Flight scheduling, current step', () => {
    const rows = timelineRows(model(review('approved', { reviewedAt: REVIEWED })));
    expect(label(rows[3])).toMatch(/^Flight scheduling, Current step, /);
  });

  test.each(['EN', 'HI', 'MR', 'GU', 'TE', 'AR'])('%s: every label is built from translated text, never a raw key or "undefined"', (lang) => {
    const t = (key) => I18N[lang][key];
    const requests = Object.values({
      a: review('awaiting_documents'), b: review('in_review', { submittedAt: SUBMITTED }), c: review('approved', { reviewedAt: REVIEWED }),
      d: review('approved', { status: 'cancelled', case: caseOf('cancelled', [ev('cancelled', T_CANCELLED)]) }), e: legacy(),
    });
    requests.forEach((r) => timelineRows(model(r)).forEach((row) => {
      const text = view.rowAccessibilityLabel(row, t);
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/tcp_|undefined|null/);
    }));
  });

  test('the label carries no internal or free text from the request', () => {
    const request = review('changes_requested', {
      submittedAt: SUBMITTED, documentsRequestReason: 'ADMIN-REASON-SECRET', notes: 'INTERNAL-NOTE-SECRET', patientName: 'PATIENT-NAME-SECRET', billingNotes: 'BILLING-SECRET',
      case: caseOf('submitted', [{ stage: 'submitted', occurredAt: CREATED, note: 'STAGE-NOTE-SECRET' }]),
    });
    const all = timelineRows(model(request)).map(label).join(' | ');
    expect(all).not.toMatch(/SECRET/);
  });
});

describe('colours', () => {
  test('uses the approved brand colours', () => {
    expect(COLORS.PRIMARY).toBe('#303A8F');
    expect(COLORS.SECONDARY).toBe('#2F2A62');
    expect(COLORS.CANCEL).toBe('#C23B3B');
  });

  test('every status tone has colours, and an unknown tone falls back safely', () => {
    ['neutral', 'info', 'attention', 'done', 'cancelled'].forEach((t) => expect(toneColors(t)).toEqual({ fg: expect.stringMatching(/^#[0-9A-F]{6}$/), bg: expect.stringMatching(/^#[0-9A-F]{6}$/) }));
    expect(toneColors('weird')).toEqual(toneColors('neutral'));
  });
});

describe('translations', () => {
  const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

  test('the six supported languages are present', () => {
    expect(Object.keys(I18N)).toEqual(LANGS);
  });

  test.each(LANGS)('%s has every Private Charter tracking key, non-empty', (lang) => {
    MODEL_TEXT_KEYS.forEach((k) => {
      expect(typeof I18N[lang][k]).toBe('string');
      expect(I18N[lang][k].trim()).not.toBe('');
    });
  });

  test('key parity: every tcp_ key in any language exists in all six', () => {
    const all = new Set(LANGS.flatMap((l) => Object.keys(I18N[l]).filter((k) => k.startsWith('tcp_'))));
    expect([...all].sort()).toEqual([...MODEL_TEXT_KEYS].sort());
    LANGS.forEach((l) => all.forEach((k) => expect(I18N[l]).toHaveProperty(k)));
  });

  test('every key the model can emit is covered by the list above', () => {
    const requests = [
      base(), legacy(), review('awaiting_documents'), review('in_review', { submittedAt: SUBMITTED }), review('changes_requested', { submittedAt: SUBMITTED }),
      review('approved', { reviewedAt: REVIEWED }), review('some_new_state'),
      review('approved', { case: caseOf('scheduled', [ev('scheduled', T_SCHEDULED)]) }),
      review('approved', { case: caseOf('in_progress', [ev('in_progress', T_PROGRESS)]) }),
      review('approved', { case: caseOf('completed', [ev('completed', T_DONE)]) }),
      review('approved', { status: 'cancelled', case: caseOf('cancelled', [ev('cancelled', T_CANCELLED)]) }),
    ];
    requests.forEach((r) => {
      const m = model(r);
      expect(MODEL_TEXT_KEYS).toContain(m.status.labelKey);
      m.milestones.forEach((x) => {
        expect(MODEL_TEXT_KEYS).toContain(x.titleKey);
        expect(MODEL_TEXT_KEYS).toContain(x.subKey);
      });
      timelineRows(m).forEach((row) => {
        expect(MODEL_TEXT_KEYS).toContain(row.titleKey);
        expect(MODEL_TEXT_KEYS).toContain(row.subKey);
      });
    });
  });

  test('the new languages are translated, not copies of English', () => {
    ['HI', 'MR', 'GU', 'TE', 'AR'].forEach((l) => {
      const same = MODEL_TEXT_KEYS.filter((k) => I18N[l][k] === I18N.EN[k]);
      expect(same).toEqual([]);
    });
  });

  test('existing keys used by the new screens are present in all six languages', () => {
    ['lbl_from', 'lbl_to', 'timeline_pending', 'tracking_details_title'].forEach((k) => LANGS.forEach((l) => expect(I18N[l][k]).toBeTruthy()));
  });
});
