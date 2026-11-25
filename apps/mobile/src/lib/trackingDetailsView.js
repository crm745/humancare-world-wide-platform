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
import { bannerConfigFor } from './trackingBannerConfig';
import { bannerImageFor } from './trackingBannerImages';
import { serviceKeyOf } from './myRequestsView';
import { isNewTeleRequest } from './teleConsultation';
import { isNewHomeRequest } from './homeHealthcare';
import { isNewCorporateRequest } from './corporateMedical';

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

// When the request last changed, as a time the banner turns into "2 min ago": the latest stage event, else the case's / the request's own updatedAt ('' when there is none).
export function latestUpdateAt(request) {
  const list = events(request).filter((e) => Number.isFinite(time(e)));
  if (list.length) return list.reduce((best, e) => (time(e) >= time(best) ? e : best)).occurredAt;
  const fallback = [request && request.case && request.case.updatedAt, request && request.updatedAt].find((v) => Number.isFinite(Date.parse(v)));
  return fallback || '';
}

// The steps of a Private Charter request: the model's milestones that apply, in its order.
function charterSteps(model, t) {
  // A request in the five-stage journey lists its five stages; every other request lists the milestones.
  return (Array.isArray(model.actualStages) ? model.actualStages : model.milestones).filter((m) => m && m.state !== MILESTONE_STATE.NOT_APPLICABLE).map((m) => {
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

// The step the request is at: the one stopped, else the one under way, else the last one finished (its marker stays a check), else the first. (The banner draws its own progress from the
// steps; this is the single answer to "which stage is it at", shared by the request list card, the details and the tests that check they agree: fiveStageTracking.test.js.)
export function currentIndexOf(steps) {
  const stop = steps.findIndex((s) => s.stopped);
  if (stop >= 0) return stop;
  const active = steps.findIndex((s) => s.state === 'current');
  if (active >= 0) return active;
  let lastDone = -1;
  steps.forEach((s, i) => { if (s.state === 'done') lastDone = i; });
  return lastDone >= 0 ? lastDone : 0;
}

// Everything the screen draws. `t` is the app's translate function; null when there is no request.
export function buildTrackingDetails(request, t) {
  if (!request) return null;
  const charter = isPrivateCharterTracking(request);
  const model = charter ? buildPrivateCharterTracking(request) : null;
  const steps = charter ? charterSteps(model, t) : genericSteps(request, t);
  const cancelled = charter ? model.cancellation.isCancelled : request.status === 'cancelled';
  // A new-format Teleconsultation has no route (its origin is an address, and it has no destination): the route is not drawn.
  // (a new-format Home Healthcare request has a home address, not a route, either; nor does a new-format Corporate Medical Solutions request: its origin is the Office Address)
  const tele = isNewTeleRequest(request) || isNewHomeRequest(request) || isNewCorporateRequest(request);
  const from = tele ? '' : cityOf(request.originCityName, request.origin);
  const to = tele ? '' : cityOf(request.destinationCityName, request.destination);
  const serviceKey = serviceKeyOf(request);
  const config = bannerConfigFor(serviceKey);
  const serviceName = baseServiceName(request, t);
  // A route needs both cities; with one or none the banner is titled by the service and says where the patient is (a home address, an office) when it knows.
  const hasRoute = !!(from && to);
  const area = hasRoute ? '' : textOf(request.originCityName) || textOf(request.origin) || from || to;
  return {
    reference: textOf(request.referenceNumber),
    serviceKey,
    serviceName,
    badge: statusBadge(request, t),
    status: textOf(request.status),
    from,
    to,
    hasRoute,
    area,
    steps,
    total: steps.length,
    index: currentIndexOf(steps),
    currentTitle: steps.length ? steps[currentIndexOf(steps)].title : '',
    cancelled,
    // The banner: the chip's label and icon, the service's drawn picture (null when it has none), the short service name and when the request last changed.
    chipLabel: t(config.shortKey || config.chipKey), // the service's own name (the same words as the title), never a second, different name for it
    chipIcon: config.icon,
    bannerImage: bannerImageFor(serviceKey),
    shortName: config.shortKey ? t(config.shortKey) : '',
    updatedAt: latestUpdateAt(request),
    // Private Charter only: the Admin's message while changes are requested, and the way to the request to answer it.
    message: charter ? changesMessage(model) : null,
    openRequest: charter ? showOpenRequest(model) : false,
  };
}
