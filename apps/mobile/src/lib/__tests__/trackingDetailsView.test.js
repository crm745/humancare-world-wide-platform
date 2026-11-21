/* global describe, test, expect */
const i18n = require('../../data/i18n.json');
const { translate } = require('../translate');
const V = require('../trackingDetailsView');
const { buildPrivateCharterTracking } = require('../tracking/privateCharterTracking');
const { trackingView, TRACKING_STEPS } = require('../requestTracking');

const t = (key, values) => translate(i18n, 'EN', key, values);
const ev = (stage, occurredAt) => ({ id: 1, caseId: 3, stage, note: 'a staff note', occurredAt });
const caseOf = (status, events) => ({ id: 3, status, stageEvents: events, documents: [] });

// Made-up requests, in the shapes the API returns.
const ground = (status, events = [], extra = {}) => ({
  id: 5, referenceNumber: 'REQ-1070', serviceType: 'Ground Ambulance', serviceKey: 'ground', status, createdAt: '2026-11-13T12:07:00',
  origin: 'Pune, Maharashtra, India', destination: 'Mumbai, Maharashtra, India', originCityName: null, destinationCityName: null,
  case: events.length ? caseOf(status, events) : null, ...extra,
});
const charter = (status, caseStatus, events = [], extra = {}) => ({
  id: 7, referenceNumber: 'REQ-1067', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', status, reviewStatus: null,
  createdAt: '2026-11-13T12:07:00', origin: 'Mumbai, Maharashtra, India', destination: 'Delhi, Delhi, India', originCityName: 'Mumbai', destinationCityName: 'Delhi',
  case: caseStatus ? caseOf(caseStatus, events) : null, ...extra,
});
const HALF_WAY = charter('in_progress', 'in_progress', [ev('submitted', '2026-11-13T12:07:00'), ev('scheduled', '2026-11-14T05:50:00'), ev('in_progress', '2026-11-15T01:15:00')]);

describe('places and times', () => {
  test('the city is the city name field when there is one, otherwise the text before the first comma', () => {
    expect(V.cityOf('Mumbai', 'Mumbai, Maharashtra, India')).toBe('Mumbai');
    expect(V.cityOf(null, 'Pune, Maharashtra, India')).toBe('Pune');
    expect(V.cityOf('', 'City General Hospital, Andheri West, Mumbai')).toBe('City General Hospital');
    expect(V.cityOf(null, 'Dubai')).toBe('Dubai');
    expect(V.cityOf(null, '')).toBe('');
    expect(V.cityOf(undefined, null)).toBe('');
  });
  test('a time reads "15 Nov, 06:45" (day and month, a comma, 24-hour time); nothing for a missing or invalid one', () => {
    expect(V.whenText('2026-11-15T06:45:00')).toBe('15 Nov, 06:45');
    expect(V.whenText(null)).toBe('');
    expect(V.whenText('nonsense')).toBe('');
  });
  test('"Last updated" is the time of the latest stage event, whatever the order; else the case\'s / the request\'s own updatedAt; none when there is nothing', () => {
    const request = ground('in_progress', [ev('in_progress', '2026-11-15T06:45:00'), ev('submitted', '2026-11-13T17:37:00'), { stage: 'x', occurredAt: 'bad' }]);
    expect(V.latestUpdateAt(request)).toBe('2026-11-15T06:45:00');
    expect(V.latestUpdateAt({ ...ground('submitted'), updatedAt: '2026-11-16T10:00:00' })).toBe('2026-11-16T10:00:00');
    expect(V.latestUpdateAt({ ...ground('submitted'), case: { updatedAt: '2026-11-17T10:00:00', stageEvents: [] }, updatedAt: '2026-11-16T10:00:00' })).toBe('2026-11-17T10:00:00');
    expect(V.latestUpdateAt({ ...ground('submitted'), updatedAt: 'bad' })).toBe('');
    expect(V.latestUpdateAt(ground('submitted'))).toBe('');
    expect(V.latestUpdateAt(null)).toBe('');
  });
});

describe('a Private Charter request', () => {
  test('mid-way: the model\'s own steps, in its order, with its own names and times; the third of four is current', () => {
    const d = V.buildTrackingDetails(HALF_WAY, t);
    const model = buildPrivateCharterTracking(HALF_WAY);
    const applicable = model.milestones.filter((m) => m.state !== 'not_applicable');
    expect(d.steps.map((s) => s.key)).toEqual(applicable.map((m) => m.key));
    expect(d.steps.map((s) => s.title)).toEqual(['Request received', 'Flight scheduled', 'Mission in progress', 'Completed']);
    expect(d.steps.map((s) => s.description)).toEqual(['We have your request', 'Your flight has been scheduled', 'Your transfer is under way', 'The mission is complete']);
    expect(d.steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'pending']);
    expect(d.steps.map((s) => s.time)).toEqual(['13 Nov, 12:07', '14 Nov, 05:50', '15 Nov, 01:15', '']);
    expect(d.steps).toHaveLength(4);
    expect(d.updatedAt).toBe('2026-11-15T01:15:00');
    expect(d.cancelled).toBe(false);
  });
  test('the header facts: reference, base service name, the app-wide status, the two cities, the icon\'s key', () => {
    const d = V.buildTrackingDetails(HALF_WAY, t);
    expect(d.reference).toBe('REQ-1067');
    expect(d.serviceName).toBe('Private Charter Air Ambulance Service');
    expect(d.badge.label).toBe('In Progress');
    expect(d.from).toBe('Mumbai');
    expect(d.to).toBe('Delhi');
    expect(d.hasRoute).toBe(true);
    expect(d.serviceKey).toBe('privatecharter');
  });
  test('the step count follows the model: three when scheduling was skipped, more in the review workflow', () => {
    const skipped = charter('in_progress', 'in_progress', [ev('submitted', '2026-11-13T12:07:00'), ev('in_progress', '2026-11-15T01:15:00')]);
    expect(V.buildTrackingDetails(skipped, t).steps).toHaveLength(3);
    const review = charter('submitted', 'submitted', [ev('submitted', '2026-11-13T12:07:00')], { reviewStatus: 'approved', submittedAt: '2026-11-13T13:00:00', reviewedAt: '2026-11-13T14:00:00' });
    const model = buildPrivateCharterTracking(review);
    const d = V.buildTrackingDetails(review, t);
    expect(d.steps).toHaveLength(model.milestones.filter((m) => m.state !== 'not_applicable').length);
    expect(d.steps.length).toBeGreaterThanOrEqual(5);
    expect(d.steps.map((s) => s.key)).toEqual(expect.arrayContaining(['documents_review', 'request_approved']));
  });
  test('a request just received: no step is under way, so the last finished one is the current (its marker stays a check)', () => {
    const d = V.buildTrackingDetails(charter('submitted', 'submitted', [ev('submitted', '2026-11-13T12:07:00')]), t);
    expect(d.steps[0].state).toBe('done');
    expect(d.steps.some((s) => s.state === 'current')).toBe(false);
  });
  test('completed: every step done, the last is the current one, the chip at the end, every segment lit', () => {
    const done = charter('completed', 'completed', [ev('submitted', '2026-11-13T12:07:00'), ev('scheduled', '2026-11-14T05:50:00'), ev('in_progress', '2026-11-15T01:15:00'), ev('completed', '2026-11-15T09:00:00')]);
    const d = V.buildTrackingDetails(done, t);
    expect(d.steps.every((s) => s.state === 'done')).toBe(true);
    expect(d.badge.label).toBe('Completed');
    expect(d.updatedAt).toBe('2026-11-15T09:00:00');
  });
  test('cancelled: the steps before are done, the stop step reads "Cancelled" with no ring and no check, later steps stay hidden', () => {
    const cancelled = charter('cancelled', 'cancelled', [ev('submitted', '2026-11-13T12:07:00'), ev('scheduled', '2026-11-14T05:50:00'), ev('cancelled', '2026-11-14T08:00:00')]);
    const d = V.buildTrackingDetails(cancelled, t);
    const model = buildPrivateCharterTracking(cancelled);
    expect(d.cancelled).toBe(true);
    expect(d.steps).toHaveLength(model.milestones.filter((m) => m.state !== 'not_applicable').length);
    const stop = d.steps[d.steps.length - 1];
    expect(stop).toMatchObject({ title: 'Cancelled', state: 'pending', stopped: true });
    expect(d.steps.slice(0, -1).every((s) => s.state === 'done')).toBe(true);
    expect(d.steps.some((s) => s.state === 'current')).toBe(false);
    expect(d.badge.label).toBe('Cancelled');
    expect(stop.time).toBe('14 Nov, 08:00');
  });
  test('while changes are requested: the Admin\'s message and the way to the request are carried; otherwise neither', () => {
    const changes = charter('submitted', null, [], { reviewStatus: 'changes_requested', documentsRequestReason: 'Send a clearer copy of the ID.', submittedAt: '2026-11-13T13:00:00' });
    const d = V.buildTrackingDetails(changes, t);
    expect(d.message).toBe('Send a clearer copy of the ID.');
    expect(d.openRequest).toBe(true);
    expect(d.steps.find((s) => s.state === 'current').key).toBe('documents_review');
    const plain = V.buildTrackingDetails(HALF_WAY, t);
    expect(plain.message).toBeNull();
    expect(plain.openRequest).toBe(false);
  });
});

describe('any other request (the generic model)', () => {
  test('submitted: the model\'s five steps, the first current', () => {
    const request = ground('submitted', [ev('submitted', '2026-11-13T12:07:00')]);
    const d = V.buildTrackingDetails(request, t);
    expect(d.steps.map((s) => s.key)).toEqual(TRACKING_STEPS.map((s) => s.key));
    expect(d.steps.map((s) => s.title)).toEqual(TRACKING_STEPS.map((s) => t(s.title)));
    expect(d.steps.map((s) => s.description)).toEqual(TRACKING_STEPS.map((s) => t(s.sub)));
    expect(d.steps.map((s) => s.state)).toEqual(['current', 'pending', 'pending', 'pending', 'pending']);
    expect(d.steps[0].time).toBe('13 Nov, 12:07');
    expect(d.steps[1].time).toBe('');
    expect(d.badge.label).toBe('Submitted');
    expect(d.serviceName).toBe('Ground Ambulance');
    expect(d.serviceKey).toBe('ground');
  });
  test('in progress: the same step the old page showed (the model decides), with its time', () => {
    const request = ground('in_progress', [ev('submitted', '2026-11-13T12:07:00'), ev('in_progress', '2026-11-14T08:15:00')]);
    const view = trackingView(request);
    const d = V.buildTrackingDetails(request, t);
    const index = d.steps.findIndex((s) => s.state === 'current');
    expect(index).toBe(view.index);
    expect(d.steps.map((s) => s.state)).toEqual(view.steps.map((s) => (s.state === 'done' ? 'done' : s.state === 'now' ? 'current' : 'pending')));
    expect(d.steps[index].time).toBe('14 Nov, 08:15');
  });
  test('completed: every step done, the chip at the end, every segment lit', () => {
    const d = V.buildTrackingDetails(ground('completed', [ev('submitted', '2026-11-13T12:07:00'), ev('completed', '2026-11-15T09:00:00')]), t);
    expect(d.steps.every((s) => s.state === 'done')).toBe(true);

  });
  test('cancelled: the reached step reads "Cancelled", the later steps stay pending, no ring, dimmed segments', () => {
    const request = ground('cancelled', [ev('submitted', '2026-11-13T12:07:00'), ev('payment', '2026-11-14T06:00:00')]);
    const d = V.buildTrackingDetails(request, t);
    expect(d.cancelled).toBe(true);
    expect(d.steps).toHaveLength(5);
    expect(d.steps.map((s) => s.state)).toEqual(['done', 'done', 'pending', 'pending', 'pending']);
    expect(d.steps[2]).toMatchObject({ title: 'Cancelled', stopped: true });
    expect(d.steps.some((s) => s.state === 'current')).toBe(false);
    expect(d.badge.label).toBe('Cancelled');
  });
  test('a long name wraps instead of being cut: the texts are passed whole', () => {
    const long = 'A'.repeat(150);
    const d = V.buildTrackingDetails(ground('submitted', [], { origin: `${long}, Somewhere`, destination: 'Mumbai, India' }), t);
    expect(d.from).toBe(long);
  });
});

describe('the route', () => {
  test('one side missing: there is no route (the banner is titled by the service); the one city that is known is the area', () => {
    const noTo = V.buildTrackingDetails(ground('submitted', [], { destination: '' }), t);
    expect(noTo.from).toBe('Pune');
    expect(noTo.to).toBe('');
    expect(noTo.hasRoute).toBe(false);
    expect(noTo.area).toBe('Pune, Maharashtra, India');
    const none = V.buildTrackingDetails(ground('submitted', [], { origin: '', destination: null }), t);
    expect(none.hasRoute).toBe(false);
  });
  test('no request: nothing', () => {
    expect(V.buildTrackingDetails(null, t)).toBeNull();
    expect(V.buildTrackingDetails(undefined, t)).toBeNull();
  });
  test('the chip\'s icon is the request\'s own service (its key first), so a ground request does not get a plane', () => {
    expect(V.buildTrackingDetails(ground('submitted'), t).serviceKey).toBe('ground');
    expect(V.buildTrackingDetails(HALF_WAY, t).serviceKey).toBe('privatecharter');
    expect(V.buildTrackingDetails(ground('submitted', [], { serviceKey: 'commercialair_stretcher', serviceType: 'Commercial Airlines — Stretcher (CAS)' }), t).serviceKey).toBe('commercialair');
  });
});

describe('the words', () => {
  test('the new labels exist in all six languages', () => {
    for (const key of ['td_pickup', 'td_dropoff', 'td_progress', 'timeline_pending', 'mr_step_of', 'rd_updated', 'tracking_details_title']) {
      for (const lang of Object.keys(i18n)) expect(typeof i18n[lang][key]).toBe('string');
    }
    expect(i18n.EN.td_pickup).toBe('Pickup');
    expect(i18n.EN.td_dropoff).toBe('Drop-off');
    expect(i18n.EN.td_progress).toBe('Progress');
  });
  test('the title is "Tracking Details" for every service', () => {
    expect(i18n.EN.tracking_details_title).toBe('Tracking Details');
  });
});
