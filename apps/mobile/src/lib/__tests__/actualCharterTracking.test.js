/* global describe, test, expect, __dirname */
// The five-stage Private Charter tracking journey: Request Received, Quotation Ready, Payment Confirmed, Service In Progress, Completed.
// It is shown ONLY when the backend says so (request.trackingFlow === 'five_stage'), from the first moment, with all five stages listed even when
// the Deal skips some, and it is never guessed from stage events, quotations or payments. Every other request keeps the existing tracking.
const fs = require('fs');
const path = require('path');
const { buildPrivateCharterTracking, ACTUAL_STAGE_KEYS, TRACKING_FLOW_FIVE_STAGE } = require('../tracking/privateCharterTracking');
const { timelineRows, mirrorStyle, MODEL_TEXT_KEYS } = require('../tracking/privateCharterTrackingView');
const { buildTrackingDetails } = require('../trackingDetailsView');

const I18N = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const tIn = (lang) => (key, values) => {
  const text = (I18N[lang] && I18N[lang][key]) || I18N.EN[key] || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const t = tIn('EN');

const CREATED = '2030-02-01T08:00:00.000Z';
const T1 = '2030-02-02T09:00:00.000Z';
const T2 = '2030-02-03T10:00:00.000Z';
const T3 = '2030-02-04T11:00:00.000Z';
const T4 = '2030-02-05T12:00:00.000Z';
const ev = (stage, occurredAt) => ({ id: 1, stage, note: null, occurredAt });
// An approved request in the five-stage journey, with the Case at `caseStatus` and the given stage events.
const five = (caseStatus, stageEvents, over = {}) => ({
  id: 5, referenceNumber: 'HC-PC-000123', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status: 'in_progress',
  reviewStatus: 'approved', createdAt: CREATED, trackingFlow: 'five_stage', origin: 'Mumbai, India', destination: 'Dubai, United Arab Emirates',
  case: { id: 9, status: caseStatus, stageEvents }, ...over,
});
const rowsOf = (req) => timelineRows(buildPrivateCharterTracking(req));
const titles = (rows, translate = t) => rows.map((row) => translate(row.titleKey));
const dots = (rows) => rows.map((row) => row.dot);
const FIVE = ['Request Received', 'Quotation Ready', 'Payment Confirmed', 'Service In Progress', 'Completed'];

describe('the five approved labels', () => {
  test('in order, in English', () => {
    expect(TRACKING_FLOW_FIVE_STAGE).toBe('five_stage');
    expect(ACTUAL_STAGE_KEYS).toEqual(['request_received', 'quotation_ready', 'payment_confirmed', 'service_in_progress', 'completed']);
    expect(ACTUAL_STAGE_KEYS.map((k) => I18N.EN[`acs_${k}`])).toEqual(FIVE);
  });
  test('they are text keys of their own: the existing tcp_ keys keep their six-language parity', () => {
    for (const k of ACTUAL_STAGE_KEYS) {
      expect(MODEL_TEXT_KEYS).not.toContain(`acs_${k}`);
      expect(Object.keys(I18N.EN).filter((key) => key.startsWith('tcp_'))).not.toContain(`acs_${k}`);
    }
  });
});

describe('initial tracking: all five stages from the very start', () => {
  test('a new request lists all five, Request Received current, the rest pending', () => {
    const rows = rowsOf(five('submitted', []));
    expect(titles(rows)).toEqual(FIVE);
    expect(dots(rows)).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(rows[0].time).not.toBe('');
    expect(rows.slice(1).every((r) => r.time === '')).toBe(true);
  });
  test('a request with no Case yet, and one still in review, show the five stages with Request Received current (no progress from the Case)', () => {
    for (const req of [five('submitted', [], { case: null }), five('submitted', [ev('quotation_ready', T1)], { reviewStatus: 'in_review' }), five('submitted', [], { reviewStatus: 'awaiting_documents' })]) {
      const rows = rowsOf(req);
      expect(titles(rows)).toEqual(FIVE);
      expect(dots(rows)).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    }
  });
  test('while documents are in review the status chip keeps the review wording; once approved it names the current stage', () => {
    expect(buildPrivateCharterTracking(five('submitted', [], { reviewStatus: 'in_review' })).status.labelKey).toBe('tcp_status_in_review');
    const approved = buildPrivateCharterTracking(five('submitted', []));
    expect(approved.status).toMatchObject({ labelKey: 'acs_request_received', tone: 'info' });
    expect(t(approved.status.labelKey)).toBe('Request Received');
  });
});

describe('each stage, in order', () => {
  test.each([
    ['Quotation Ready', five('submitted', [ev('quotation_ready', T1)]), ['completed', 'active', 'pending', 'pending', 'pending'], 'Quotation Ready'],
    ['Payment Confirmed', five('submitted', [ev('quotation_ready', T1), ev('payment_confirmed', T2)]), ['completed', 'completed', 'active', 'pending', 'pending'], 'Payment Confirmed'],
    ['Service In Progress', five('in_progress', [ev('quotation_ready', T1), ev('payment_confirmed', T2), ev('in_progress', T3)]), ['completed', 'completed', 'completed', 'active', 'pending'], 'Service In Progress'],
    ['Completed', five('completed', [ev('quotation_ready', T1), ev('payment_confirmed', T2), ev('in_progress', T3), ev('completed', T4)]), ['completed', 'completed', 'completed', 'completed', 'completed'], 'Completed'],
  ])('%s', (_name, req, expected, chip) => {
    const model = buildPrivateCharterTracking(req);
    const rows = timelineRows(model);
    expect(titles(rows)).toEqual(FIVE);
    expect(dots(rows)).toEqual(expected);
    expect(t(model.status.labelKey)).toBe(chip);
    expect(model.cancellation.isCancelled).toBe(false);
  });
  test('stages reached have their own time; stages not reached have none', () => {
    const rows = rowsOf(five('in_progress', [ev('quotation_ready', T1), ev('payment_confirmed', T2), ev('in_progress', T3)]));
    expect(rows.map((r) => r.time !== '')).toEqual([true, true, true, true, false]);
  });
});

describe('skipped stages: all five stay listed and the current stage is right', () => {
  test('Enquiry straight to Activate: Quotation Ready and Payment Confirmed are passed, Service In Progress is current', () => {
    const model = buildPrivateCharterTracking(five('in_progress', [ev('in_progress', T3)]));
    const rows = timelineRows(model);
    expect(titles(rows)).toEqual(FIVE);
    expect(dots(rows)).toEqual(['completed', 'completed', 'completed', 'active', 'pending']);
    expect(rows[1].time).toBe(''); // skipped: nothing happened at it, so no invented time
    expect(rows[2].time).toBe('');
    expect(rows[3].time).not.toBe('');
    expect(t(model.status.labelKey)).toBe('Service In Progress');
    expect(model.activeMilestone.key).toBe('service_in_progress');
  });
  test('Enquiry straight to Case Completed: everything is completed', () => {
    const model = buildPrivateCharterTracking(five('completed', [ev('completed', T4)]));
    expect(dots(timelineRows(model))).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
    expect(t(model.status.labelKey)).toBe('Completed');
  });
  test('Quotation Ready then straight to Service In Progress', () => {
    expect(dots(rowsOf(five('in_progress', [ev('quotation_ready', T1), ev('in_progress', T3)])))).toEqual(['completed', 'completed', 'completed', 'active', 'pending']);
  });
  test('the Case status alone is enough evidence for Service In Progress and Completed (a missing stage event does not lose the stage)', () => {
    expect(dots(rowsOf(five('in_progress', [])))).toEqual(['completed', 'completed', 'completed', 'active', 'pending']);
    expect(dots(rowsOf(five('completed', [])))).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
  });
  test('stage events arriving in any order give the furthest stage', () => {
    expect(dots(rowsOf(five('in_progress', [ev('in_progress', T3), ev('quotation_ready', T1), ev('payment_confirmed', T2)])))).toEqual(['completed', 'completed', 'completed', 'active', 'pending']);
  });
});

describe('cancelled', () => {
  test('stops at the stage reached; the stages after it are not shown', () => {
    const rows = rowsOf(five('cancelled', [ev('quotation_ready', T1), ev('payment_confirmed', T2)], { status: 'cancelled' }));
    expect(titles(rows)).toEqual(['Request Received', 'Quotation Ready', 'Cancelled']);
    expect(t(rows[2].stepTitleKey)).toBe('Payment Confirmed');
    expect(dots(rows)).toEqual(['completed', 'completed', 'cancelled']);
  });
  test('cancelled at the very start stops at Request Received', () => {
    const rows = rowsOf(five('cancelled', [], { status: 'cancelled' }));
    expect(dots(rows)).toEqual(['cancelled']);
  });
});

describe('the flow is decided by the backend, never inferred', () => {
  test.each([
    ['no trackingFlow, with quotation and payment events', five('submitted', [ev('quotation_ready', T1), ev('payment_confirmed', T2)], { trackingFlow: undefined })],
    ['trackingFlow null (the test profile), with those events', five('submitted', [ev('quotation_ready', T1), ev('payment_confirmed', T2)], { trackingFlow: null })],
    ['an unknown trackingFlow value', five('submitted', [ev('quotation_ready', T1)], { trackingFlow: 'actual' })],
  ])('%s keeps the existing milestones', (_name, req) => {
    const model = buildPrivateCharterTracking(req);
    expect(model.actualStages).toBeNull();
    const rows = timelineRows(model);
    expect(rows.map((r) => r.key)).toEqual(model.milestones.filter((m) => m.state !== 'not_applicable').map((m) => m.key));
    for (const row of rows) expect(row.titleKey).toMatch(/^tcp_/);
    expect(model.status.labelKey).toMatch(/^tcp_status_/);
  });
  test('the milestones and status of other requests are exactly what they were', () => {
    const model = buildPrivateCharterTracking(five('submitted', [], { trackingFlow: undefined }));
    expect(model.milestones.map((m) => m.key)).toEqual(['request_received', 'documents_review', 'request_approved', 'flight_scheduled', 'mission_in_progress', 'completed']);
    expect(Object.keys(model).sort()).toEqual(['activeMilestone', 'actualStages', 'cancellation', 'destination', 'family', 'milestones', 'mode', 'origin', 'reference', 'review', 'serviceName', 'status'].sort());
  });
  test('a different service is never given the five stages, even if the flag were present', () => {
    const { isPrivateCharterTracking } = require('../tracking/serviceFamily');
    expect(isPrivateCharterTracking(five('submitted', [], { serviceKey: 'ground', serviceType: 'Ground Ambulance' }))).toBe(false);
  });
});

describe('the Tracking details screen uses the same stages', () => {
  test('a five-stage request lists the five labels and its current step; others keep the milestones', () => {
    const details = buildTrackingDetails(five('in_progress', [ev('in_progress', T3)]), t);
    expect(details.steps.map((s) => s.title)).toEqual(FIVE);
    expect(details.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'pending']);
    expect(details.total).toBe(5);
    expect(details.currentTitle).toBe('Service In Progress');
    const standard = buildTrackingDetails(five('submitted', [], { trackingFlow: null }), t);
    expect(standard.steps.map((s) => s.title)).not.toEqual(FIVE);
  });
});

describe('translations: English, Hindi, Marathi, Gujarati, Telugu, Arabic', () => {
  const KEYS = ACTUAL_STAGE_KEYS.flatMap((k) => [`acs_${k}`, `acs_${k}_sub`]);
  test.each(LANGS)('%s has all five stages and their supporting text, non-empty', (lang) => {
    for (const key of KEYS) {
      expect(typeof I18N[lang][key]).toBe('string');
      expect(I18N[lang][key].trim()).not.toBe('');
    }
  });
  test('every language is translated, not copied from English (except none)', () => {
    for (const lang of LANGS.filter((l) => l !== 'EN')) {
      for (const key of KEYS) expect(I18N[lang][key]).not.toBe(I18N.EN[key]);
    }
  });
  test.each([['HI', /[ऀ-ॿ]/], ['MR', /[ऀ-ॿ]/], ['GU', /[઀-૿]/], ['TE', /[ఀ-౿]/], ['AR', /[؀-ۿ]/]])('%s is written in its own script', (lang, script) => {
    for (const key of KEYS) expect(I18N[lang][key]).toMatch(script);
  });
  test('the five labels are distinct in every language', () => {
    for (const lang of LANGS) expect(new Set(ACTUAL_STAGE_KEYS.map((k) => I18N[lang][`acs_${k}`])).size).toBe(5);
  });
  test.each(LANGS)('%s renders the five-stage timeline from its own text', (lang) => {
    const rows = rowsOf(five('in_progress', [ev('in_progress', T3)]));
    const translate = tIn(lang);
    expect(titles(rows, translate)).toEqual(ACTUAL_STAGE_KEYS.map((k) => I18N[lang][`acs_${k}`]));
  });
  test('the existing tracking keys still have six-language parity (nothing was added under tcp_)', () => {
    const all = new Set(LANGS.flatMap((l) => Object.keys(I18N[l]).filter((k) => k.startsWith('tcp_'))));
    expect([...all].sort()).toEqual([...MODEL_TEXT_KEYS].sort());
  });
});

describe('Arabic right-to-left', () => {
  test('the Arabic stage text is pure Arabic script with no Latin letters or direction marks that could scramble the order', () => {
    for (const k of ACTUAL_STAGE_KEYS) {
      for (const key of [`acs_${k}`, `acs_${k}_sub`]) {
        expect(I18N.AR[key]).not.toMatch(/[A-Za-z]/);
        expect(I18N.AR[key]).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
      }
    }
  });
  test('the timeline is laid out with logical (start/end) direction, so the mirrored order comes from the app\'s RTL setting', () => {
    const component = fs.readFileSync(path.join(__dirname, '../../components/tracking/PrivateCharterTracking.js'), 'utf8');
    expect(component).toMatch(/flexDirection: 'row'/);
    expect(component).not.toMatch(/marginLeft|marginRight|paddingLeft|paddingRight|\bleft:|\bright:|textAlign: ?'(left|right)'|row-reverse/);
    expect(component).toMatch(/const \{ t, isRTL \} = useApp\(\);/);
    expect(mirrorStyle(true)).toEqual({ transform: [{ scaleX: -1 }] });
    expect(mirrorStyle(false)).toBeNull();
  });
  test('the five-stage rows are drawn by the same component and rows as every Private Charter timeline', () => {
    const rows = rowsOf(five('submitted', [ev('quotation_ready', T1)]));
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['dot', 'key', 'last', 'showPendingLabel', 'stepTitleKey', 'subKey', 'time', 'titleKey']);
  });
});
