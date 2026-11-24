/* global describe, test, expect, __dirname */
// Five-stage Private Charter tracking, the parts a person checks on a phone: the request LIST card, the same stage on the card and in the details,
// every language (strings fit, no raw keys, spoken labels), and Arabic right-to-left. Safe: pure functions and source text only. This is preparation
// for a physical-device check; it is NOT a device check.
const fs = require('fs');
const path = require('path');
const { buildPrivateCharterTracking, ACTUAL_STAGE_KEYS } = require('../tracking/privateCharterTracking');
const { timelineRows, rowAccessibilityLabel, mirrorStyle } = require('../tracking/privateCharterTrackingView');
const { progressOf, cardView, STEP_COUNT } = require('../myRequestsView');
const { toListItem } = require('../requestShape');
const { buildTrackingDetails } = require('../trackingDetailsView');
// The same table the backend test (backend/tests/safe/tracking-flow.test.js) checks against the server's own decision, so the server, the list card
// and the details cannot drift apart.
const SHARED = require('./fixtures/fiveStageCases.json').cases;

const I18N = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const tIn = (lang) => (key, values) => {
  const text = (I18N[lang] && I18N[lang][key]) || I18N.EN[key] || key;
  return values ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n) => (values[n] == null ? '' : String(values[n]))) : text;
};
const t = tIn('EN');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const FIVE = ['Request Received', 'Quotation Ready', 'Payment Confirmed', 'Service In Progress', 'Completed'];

const ev = (stage, occurredAt = '2030-02-02T09:00:00.000Z') => ({ id: 1, stage, note: null, occurredAt });
// One request as the backend sends it (a detail response, and the row of the list), for a request in the five-stage journey. `trackingStage` is
// what the server reports; the shared table below proves it is what the server computes.
function backendRequest({ reviewStatus = 'approved', caseStatus = 'submitted', events = [], status = 'submitted', link = null, noCase = false, serviceKey = 'privatecharter', expected } = {}) {
  const base = {
    id: 5, serviceKey, serviceType: 'Private Charter Air Ambulance Service', referenceNumber: 'HC-PC-000123', status, reviewStatus, createdAt: '2030-02-01T08:00:00.000Z',
    origin: 'Mumbai, India', destination: 'Dubai, United Arab Emirates',
  };
  const flow = serviceKey !== 'privatecharter' ? {} : link && link.profile === 'test' ? { trackingFlow: null } : reviewStatus == null ? { trackingFlow: null }
    : { trackingFlow: 'five_stage', trackingStage: expected || 'request_received' };
  const detail = { ...base, ...flow, case: noCase ? null : { id: 9, referenceNumber: 'HC-PC-000123', status: caseStatus, stageEvents: events } };
  const listRow = { ...base, ...flow };
  return { detail, listRow };
}
const stageNow = (details) => details.steps[details.index].title;

describe('the request list card', () => {
  test('a five-stage request is listed with its own stage names, from the first moment', () => {
    const { listRow } = backendRequest();
    const item = toListItem(listRow);
    expect(item).toMatchObject({ trackingFlow: 'five_stage', trackingStage: 'request_received' });
    const view = cardView(item, t);
    expect(view.progress).toMatchObject({ kind: 'step', step: 1, filled: 1 });
    expect(t(view.progress.stageKey)).toBe('Request Received');
  });
  test.each([
    [{ expected: 'request_received' }, 1, 'Request Received'],
    [{ expected: 'quotation_ready', events: [ev('quotation_ready')] }, 2, 'Quotation Ready'],
    [{ expected: 'payment_confirmed', events: [ev('quotation_ready'), ev('payment_confirmed')] }, 3, 'Payment Confirmed'],
    [{ expected: 'service_in_progress', caseStatus: 'in_progress', status: 'in_progress', events: [ev('in_progress')] }, 4, 'Service In Progress'], // Enquiry straight to Activate
  ])('listed at step %#: %j -> step %i of 5, %s', (over, step, label) => {
    const view = cardView(toListItem(backendRequest(over).listRow), t);
    expect(view.progress).toMatchObject({ kind: 'step', step });
    expect(t(view.progress.stageKey)).toBe(label);
    expect(STEP_COUNT).toBe(5);
  });
  test('a completed request (also straight from Enquiry) reads Completed with all five segments', () => {
    for (const over of [{ expected: 'completed', caseStatus: 'completed', status: 'completed', events: [ev('completed')] }, { expected: 'completed', caseStatus: 'completed', status: 'completed', events: [] }]) {
      expect(cardView(toListItem(backendRequest(over).listRow), t).progress).toMatchObject({ kind: 'completed', filled: 5 });
    }
  });
  test('a cancelled request keeps its cancelled card', () => {
    const { listRow } = backendRequest({ caseStatus: 'cancelled', status: 'cancelled', events: [ev('quotation_ready')] });
    expect(cardView(toListItem(listRow), t).progress).toMatchObject({ kind: 'cancelled', filled: 0 });
  });
  test('every other request keeps the generic step names', () => {
    for (const request of [
      backendRequest({ link: { profile: 'test' } }).listRow, // the test profile
      backendRequest({ reviewStatus: null }).listRow, // a historical request
      backendRequest({ serviceKey: 'ground' }).listRow, // another service
    ]) {
      const item = toListItem(request);
      expect(item.trackingFlow).toBeNull();
      expect(cardView(item, t).progress).toEqual(progressOf(item.rawStatus));
      expect(cardView(item, t).progress.stageKey || '').not.toMatch(/^acs_/);
    }
    expect(t(progressOf('submitted').stageKey)).toBe('Request received');
  });
  test('an unknown stage from the server reads as the first stage, never as another request\'s wording', () => {
    expect(progressOf('submitted', { trackingFlow: 'five_stage', trackingStage: 'bogus' })).toMatchObject({ kind: 'step', step: 1, stageKey: 'acs_request_received' });
    expect(progressOf('submitted', { trackingFlow: 'five_stage', trackingStage: undefined })).toMatchObject({ step: 1, stageKey: 'acs_request_received' });
  });
});

describe('the card, the details and the server always agree on the stage (shared table)', () => {
  test.each(SHARED.map((c) => [c.name, c]))('%s', (_name, c) => {
    const { detail, listRow } = backendRequest({
      reviewStatus: c.reviewStatus, caseStatus: c.caseStatus, status: c.status, noCase: c.noCase, events: c.events.map((stage) => ev(stage)), expected: c.expected,
    });
    const details = buildTrackingDetails(detail, t);
    expect(details.steps.map((s) => s.title)).toEqual(FIVE);
    // the details compute the stage themselves from the Case...
    expect(stageNow(details)).toBe(FIVE[ACTUAL_STAGE_KEYS.indexOf(c.expected)]);
    // ...and the list card shows the stage the server reports, which is the same
    const view = cardView(toListItem(listRow), t);
    if (c.expected === 'completed') expect(view.progress.kind).toBe('completed');
    else expect(t(view.progress.stageKey)).toBe(FIVE[ACTUAL_STAGE_KEYS.indexOf(c.expected)]);
  });
});

describe('cancelled and completed details', () => {
  test('cancelled stops at the stage reached and the stages after it are not listed', () => {
    const { detail } = backendRequest({ caseStatus: 'cancelled', status: 'cancelled', events: [ev('quotation_ready'), ev('payment_confirmed')] });
    const rows = timelineRows(buildPrivateCharterTracking(detail));
    expect(rows.map((r) => t(r.titleKey))).toEqual(['Request Received', 'Quotation Ready', 'Cancelled']);
    expect(rows.map((r) => r.dot)).toEqual(['completed', 'completed', 'cancelled']);
  });
  test('completed lists all five as completed', () => {
    const { detail } = backendRequest({ caseStatus: 'completed', status: 'completed', events: [ev('completed')] });
    const rows = timelineRows(buildPrivateCharterTracking(detail));
    expect(rows.map((r) => r.dot)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
  });
});

describe.each(LANGS.filter((l) => l !== 'EN'))('%s: the strings a person will read on the phone', (lang) => {
  const tt = tIn(lang);
  const states = { completed: {}, active: {}, pending: {}, cancelled: {} };
  test('every stage title and description is translated and fits a timeline row', () => {
    for (const k of ACTUAL_STAGE_KEYS) {
      const title = I18N[lang][`acs_${k}`];
      const sub = I18N[lang][`acs_${k}_sub`];
      expect(title).not.toBe(I18N.EN[`acs_${k}`]);
      expect(title.length).toBeLessThanOrEqual(32); // one line on a narrow phone
      expect(sub.length).toBeLessThanOrEqual(80); // two lines at most
      expect(title).not.toMatch(/\{\{|\}\}|\s{2,}|^\s|\s$/);
    }
  });
  test('the spoken label of every row, in every state, is built from translated text only (no raw keys)', () => {
    const rowOf = (key, dot) => ({ stepTitleKey: `acs_${key}`, subKey: `acs_${key}_sub`, dot, time: dot === 'pending' ? '' : '02 Feb 2030, 09:00' });
    for (const k of ACTUAL_STAGE_KEYS) {
      for (const dot of Object.keys(states)) {
        const label = rowAccessibilityLabel(rowOf(k, dot), tt);
        expect(label).not.toMatch(/\bacs_|\btcp_|\bstatus_|timeline_/);
        expect(label).toContain(I18N[lang][`acs_${k}`]);
      }
    }
  });
  test('the card wording ("Step n of 5") exists', () => {
    for (const key of ['mr_step_of', 'mr_a11y_step', 'status_completed', 'tcp_state_active', 'timeline_pending', 'tcp_cancelled_label']) {
      expect(typeof I18N[lang][key]).toBe('string');
      expect(I18N[lang][key].trim()).not.toBe('');
    }
    expect(tt('mr_step_of', { n: 2, total: 5 })).toMatch(/2/);
    expect(tt('mr_step_of', { n: 2, total: 5 })).toMatch(/5/);
  });
});

describe('Arabic right-to-left', () => {
  test('digits and Arabic text can share a line: the "Step n of 5" text keeps both numbers, and the stage text is pure Arabic', () => {
    const text = tIn('AR')('mr_step_of', { n: 3, total: 5 });
    expect(text).toMatch(/3/);
    expect(text).toMatch(/5/);
    for (const k of ACTUAL_STAGE_KEYS) expect(I18N.AR[`acs_${k}`]).toMatch(/^[؀-ۿ\s]+$/);
  });
  test('the timeline and the list card use logical direction only, so they mirror with the app\'s RTL setting', () => {
    for (const file of ['components/tracking/PrivateCharterTracking.js', 'components/requests/RequestCard.js']) {
      const source = read(`../${file}`);
      expect(source).not.toMatch(/marginLeft|marginRight|paddingLeft|paddingRight|\bleft:|\bright:|textAlign: ?'(left|right)'|row-reverse/);
    }
    expect(read('../components/tracking/PrivateCharterTracking.js')).toMatch(/mirrorStyle\(isRTL\)/);
    expect(mirrorStyle(true)).toEqual({ transform: [{ scaleX: -1 }] });
  });
  test('the five-stage timeline in Arabic reads in the order of the journey (the app mirrors the row, not the text order)', () => {
    const { detail } = backendRequest({ caseStatus: 'in_progress', status: 'in_progress', events: [ev('in_progress')] });
    const titles = timelineRows(buildPrivateCharterTracking(detail)).map((r) => tIn('AR')(r.titleKey));
    expect(titles).toEqual(ACTUAL_STAGE_KEYS.map((k) => I18N.AR[`acs_${k}`]));
  });
});
