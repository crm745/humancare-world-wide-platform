// What one card on My Requests shows, worked out from the fields the list API already returns. Pure (no React, no
// native modules), so it can be unit-tested.
//
// The step comes from the request's status the same way the Tracking screen does it (trackingPosition in
// requestTracking.js), and the stage names are the Tracking screen's own (TRACKING_STEPS), so the list and Tracking
// always agree. The list has no stage events, so a cancelled request has no step here.
import SERVICES from '../data/services.json';
import { SERVICE_TILES } from '../data/mock';
import { serviceKeyFromTitle } from './requestShape';
import { TRACKING_STEPS, cityName, trackingPosition } from './requestTracking';

export const STEP_COUNT = TRACKING_STEPS.length; // 5

// The service whose icon and name the request shows: its own service key first (the base before any "_stretcher" /
// "_domestic" suffix), then the title it was saved with (as before), then the generic Air Ambulance.
export function serviceKeyOf(request) {
  const base = String((request && request.serviceKey) || '').split('_')[0];
  if (Object.prototype.hasOwnProperty.call(SERVICES, base)) return base;
  return serviceKeyFromTitle(request && request.serviceType);
}

// The i18n key of that service's name, the same one Home uses (null when there is none).
export function serviceTitleKey(key) {
  if (key === 'air') return 'svc_air';
  const tile = SERVICE_TILES.find((s) => s.key === key);
  return tile ? tile.title : null;
}

// Badge colours: [background, text].
const BADGE = {
  submitted: ['#FDF0DA', '#8F4C08'],
  progress: ['#E7F0FE', '#1A5FC4'],
  completed: ['#E0F5F4', '#0B6564'],
};
const BADGE_OTHER = ['#EEF1F6', '#5B6B84'];
export const SEGMENT_DONE = '#1A73E8';
export const SEGMENT_COMPLETED = '#0B6564';
export const SEGMENT_TODO = '#E4E9F2';

// "Mumbai" from "Mumbai, Maharashtra, India"; '' for nothing.
export const shortPlace = (place) => cityName(place);

// Where the request stands, as the card draws it.
//   { kind: 'step', step, filled, color, stageKey }   submitted / in progress: "Step n of 5 · <stage>"
//   { kind: 'completed', filled: 5, color }           "Completed"
//   { kind: 'cancelled', filled: 0 }                  "Cancelled", all segments grey
export function progressOf(rawStatus) {
  if (rawStatus === 'cancelled') return { kind: 'cancelled', filled: 0, color: SEGMENT_TODO };
  if (rawStatus === 'completed') return { kind: 'completed', filled: STEP_COUNT, color: SEGMENT_COMPLETED };
  const { index } = trackingPosition({ status: rawStatus });
  return { kind: 'step', step: index + 1, filled: index + 1, color: SEGMENT_DONE, stageKey: TRACKING_STEPS[index].title };
}

// Everything a card needs. `item` is a list item from toListItem (lib/requestShape.js); `t` is the app's translate function.
export function cardView(item, t) {
  const key = serviceKeyOf(item);
  const titleKey = serviceTitleKey(key);
  const name = titleKey ? t(titleKey) : item.serviceType || '';
  const statusKey = `status_${item.status}`;
  const statusLabel = t(statusKey) === statusKey ? String(item.status || '') : t(statusKey);
  const [badgeBg, badgeFg] = BADGE[item.status] || BADGE_OTHER;
  const progress = progressOf(item.rawStatus || item.status);
  const from = shortPlace(item.origin);
  const to = shortPlace(item.destination);
  const fullFrom = String(item.origin || '').trim();
  const fullTo = String(item.destination || '').trim();
  const sub = [item.id, item.display].filter(Boolean).join(' · ');

  // For a screen reader: everything, with the full place names.
  const stepPhrase = progress.kind === 'cancelled' ? '' : t('mr_a11y_step', { n: progress.kind === 'completed' ? STEP_COUNT : progress.step, total: STEP_COUNT });
  let route = '';
  if (fullFrom && fullTo) route = t('mr_a11y_route', { from: fullFrom, to: fullTo });
  else route = fullFrom || fullTo;
  const label = [name, item.id, statusLabel, stepPhrase, route].filter(Boolean).join(', ');

  return {
    key, name, sub, statusLabel, badge: { bg: badgeBg, fg: badgeFg },
    route: from || to ? { from, to } : null,
    progress, label,
  };
}

// On a narrow screen, or with large system text, the text column beside the badge gets too narrow for a word like
// "Ambulance" and the name would break in the middle. Then the badge goes under the date instead of beside the name.
// The design is unchanged from 350 up (at normal text size).
export const BADGE_BESIDE_MIN_WIDTH = 350;
export const badgeBelowFor = (screenWidth, fontScale = 1) => screenWidth < BADGE_BESIDE_MIN_WIDTH * Math.max(1, fontScale || 1);

// The counts on the chips, from the whole loaded list (not from the search or the filter).
export function statusCounts(items) {
  const counts = { all: items.length, submitted: 0, progress: 0, completed: 0, cancelled: 0 };
  for (const item of items) if (Object.prototype.hasOwnProperty.call(counts, item.status) && item.status !== 'all') counts[item.status] += 1;
  return counts;
}
