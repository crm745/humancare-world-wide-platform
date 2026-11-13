// What the Tracking Details screen (app/request-tracking.js) draws, whichever tracking model the request uses.
// Pure (no React, no native modules), so it can be unit-tested.
//
// It changes neither model. A Private Charter request goes through buildPrivateCharterTracking (its milestones, which vary
// from 4 to 6 steps), every other request through trackingView (the generic five steps). Both are turned into the same list
// of steps, so the screen never hard-codes a step name, a step count or a text: it draws whatever steps it is given.
//
//   step    { key, title, description, time, state }   state: 'done' | 'current' | 'pending'
//           A cancelled request's stop step is a 'pending'-looking step (no ring, no check) with `stopped: true`, titled
//           "Cancelled", as the existing models show it.
import { MILESTONE_STATE, buildPrivateCharterTracking } from './tracking/privateCharterTracking';
import { changesMessage, showOpenRequest } from './tracking/privateCharterTrackingView';
import { isPrivateCharterTracking } from './tracking/serviceFamily';
import { formatDayMonth, formatTime } from './dateFormat';
import { trackingView } from './requestTracking';
import { baseServiceName, statusBadge, textOf } from './requestDetailsView';
import { serviceKeyOf } from './myRequestsView';

// "15 Nov, 06:45" in the language the app is showing; '' for a missing or invalid time.
export function whenText(iso) {
  const day = formatDayMonth(iso);
  return day ? `${day}, ${formatTime(iso)}` : '';
}

// The city of a place: the city name field when there is one, otherwise the text before the first comma.
export function cityOf(cityName, place) {
  return textOf(cityName) || textOf(String(place || '').split(',')[0]);
}

const events = (request) => (request && request.case && Array.isArray(request.case.stageEvents) ? request.case.stageEvents : []);
const time = (e) => { const ms = Date.parse(e && e.occurredAt); return Number.isNaN(ms) ? -Infinity : ms; };

// The time of the latest stage event, as "Updated ..." shows it ('' when there is none).
export function latestUpdate(request) {
  const list = events(request).filter((e) => Number.isFinite(time(e)));
  if (!list.length) return '';
  const last = list.reduce((best, e) => (time(e) >= time(best) ? e : best));
  return whenText(last.occurredAt);
}

// The steps of a Private Charter request: the model's milestones that apply, in its order.
function charterSteps(model, t) {
  return model.milestones.filter((m) => m && m.state !== MILESTONE_STATE.NOT_APPLICABLE).map((m) => {
    const stop = m.state === MILESTONE_STATE.CANCELLED;
    return {
      key: m.key,
      title: t(stop ? 'tcp_cancelled_label' : m.titleKey),
      description: t(stop ? 'tcp_cancelled_sub' : m.subKey),
      time: m.state === MILESTONE_STATE.PENDING ? '' : whenText(stop ? model.cancellation.cancelledAt : m.occurredAt),
      state: m.state === MILESTONE_STATE.COMPLETED ? 'done' : m.state === MILESTONE_STATE.ACTIVE ? 'current' : 'pending',
      stopped: stop,
    };
  });
}

// The steps of every other request: the generic model's five steps. A time is the latest stage event of that step; the first
// step falls back to when the request was made (the same rule as the generic model).
function genericSteps(request, t) {
  const view = trackingView(request);
  const list = events(request);
  return view.steps.map((s, i) => {
    const event = [...list].reverse().find((e) => e.stage === s.key);
    const at = event ? event.occurredAt : i === 0 ? request.createdAt : null;
    const stop = s.state === 'bad';
    return {
      key: s.key,
      title: t(stop ? 'trk_chip_cancelled' : s.title),
      description: t(stop ? 'trk_cancelled_sub' : s.sub),
      time: s.state === 'todo' ? '' : whenText(at),
      state: s.state === 'done' ? 'done' : s.state === 'now' ? 'current' : 'pending',
      stopped: stop,
    };
  });
}

// The step the card talks about: the one under way, otherwise the last one finished (its marker stays a check), otherwise the first.
export function currentIndexOf(steps) {
  const stop = steps.findIndex((s) => s.stopped);
  if (stop >= 0) return stop;
  const active = steps.findIndex((s) => s.state === 'current');
  if (active >= 0) return active;
  let lastDone = -1;
  steps.forEach((s, i) => { if (s.state === 'done') lastDone = i; });
  return lastDone >= 0 ? lastDone : 0;
}

// Where the chip sits on the route: 0 at the first step, 1 at the last. A cancelled request stays half way, as before.
export function chipPosition({ index, total, cancelled }) {
  if (cancelled) return 0.5;
  if (!(total > 1)) return 0;
  return Math.min(1, Math.max(0, index / (total - 1)));
}

// The segments of the footer. Up to and including the current step are lit; a cancelled request's are dimmer.
//   'on' (white) | 'dim' (a cancelled request's reached steps) | 'off'
export function segmentsOf({ total, index, cancelled }) {
  return Array.from({ length: total }, (_, i) => (i <= index ? (cancelled ? 'dim' : 'on') : 'off'));
}

// Everything the screen draws. `t` is the app's translate function; null when there is no request.
export function buildTrackingDetails(request, t) {
  if (!request) return null;
  const charter = isPrivateCharterTracking(request);
  const model = charter ? buildPrivateCharterTracking(request) : null;
  const steps = charter ? charterSteps(model, t) : genericSteps(request, t);
  const cancelled = charter ? model.cancellation.isCancelled : request.status === 'cancelled';
  const total = steps.length;
  const index = currentIndexOf(steps);
  const current = steps[index];
  const from = cityOf(request.originCityName, request.origin);
  const to = cityOf(request.destinationCityName, request.destination);
  const label = [
    from && to ? t('mr_a11y_route', { from, to }) : from || to,
    current ? t('mr_a11y_step', { n: index + 1, total }) : '',
    current ? current.title : '',
  ].filter(Boolean).join(', ');
  return {
    reference: textOf(request.referenceNumber),
    serviceKey: serviceKeyOf(request),
    serviceName: baseServiceName(request, t),
    badge: statusBadge(request, t),
    from,
    to,
    hasRoute: !!(from || to),
    steps,
    total,
    index,
    currentTitle: current ? current.title : '',
    cancelled,
    position: chipPosition({ index, total, cancelled }),
    segments: segmentsOf({ total, index, cancelled }),
    updated: latestUpdate(request),
    // Private Charter only: the Admin's message while changes are requested, and the way to the request to answer it.
    message: charter ? changesMessage(model) : null,
    openRequest: charter ? showOpenRequest(model) : false,
    accessibilityLabel: label,
  };
}
