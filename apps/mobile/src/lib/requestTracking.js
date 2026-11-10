// Pure shaping of the patient's Tracking page (no React, no native modules), so it can be unit-tested.
// Five steps, in order. A request's `status` says which one it is on; the Case's stage events (when a Case
// exists) give the time each step was reached. A cancelled request stops at the step it had reached.
import { formatDisplayDate } from './requestShape';

export const TRACKING_STEPS = [
  { key: 'submitted', title: 'trk_received', sub: 'trk_received_sub', chip: 'trk_chip_received' },
  { key: 'scheduled', title: 'trk_medical', sub: 'trk_medical_sub', chip: 'trk_chip_medical' },
  { key: 'payment', title: 'trk_quote', sub: 'trk_quote_sub', chip: 'trk_chip_quote' },
  { key: 'in_progress', title: 'trk_progress', sub: 'trk_progress_sub', chip: 'trk_chip_progress' },
  { key: 'completed', title: 'trk_completed', sub: 'trk_completed_sub', chip: 'trk_chip_completed' },
];

const indexOfStage = (stage) => TRACKING_STEPS.findIndex((s) => s.key === stage);

const dateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${formatDisplayDate(iso).replace(/ \d{4}$/, '')} ${time}`;
};

// Where a request stands: the step it is on (0-4) and whether it was cancelled there.
export function trackingPosition(request) {
  const events = request?.case?.stageEvents || [];
  if (request?.status === 'cancelled') {
    const reached = events.map((e) => indexOfStage(e.stage)).filter((i) => i >= 0);
    return { index: reached.length ? Math.max(...reached) : 0, cancelled: true };
  }
  const index = indexOfStage(request?.status);
  return { index: index >= 0 ? index : 0, cancelled: false };
}

// Everything the screen draws: the chip, the progress segments and the five timeline rows.
export function trackingView(request) {
  const { index, cancelled } = trackingPosition(request);
  const events = request?.case?.stageEvents || [];
  const done = request?.status === 'completed';
  const timeFor = (step, i) => {
    const event = [...events].reverse().find((e) => e.stage === step.key);
    if (event) return dateTime(event.occurredAt);
    return i === 0 ? dateTime(request?.createdAt) : '';
  };
  const steps = TRACKING_STEPS.map((step, i) => {
    let state = 'todo';
    if (done || i < index) state = 'done';
    else if (i === index) state = cancelled ? 'bad' : 'now';
    return { ...step, state, time: state === 'todo' ? '' : timeFor(step, i) };
  });
  return {
    index,
    cancelled,
    chip: cancelled ? 'trk_chip_cancelled' : TRACKING_STEPS[index].chip,
    steps,
    segments: steps.map((s) => (s.state === 'done' ? 'done' : s.state === 'now' ? 'now' : s.state === 'bad' ? 'bad' : 'todo')),
  };
}

// Where the line between the two cities sits: 0 at the first step, 1 at the last, halfway for a cancelled request.
export const routeProgress = (view) => (view.cancelled ? 0.5 : view.index / (TRACKING_STEPS.length - 1));

// The city part of "Mumbai, Maharashtra, India".
export const cityName = (place) => String(place || '').split(',')[0].trim();
