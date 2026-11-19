// What one card on My Requests shows, worked out from the fields the list API already returns. Pure (no React, no
// native modules), so it can be unit-tested.
//
// The step comes from the request's status the same way the Tracking screen does it (trackingPosition in
// requestTracking.js), and the stage names are the Tracking screen's own (TRACKING_STEPS), so the list and Tracking
// always agree. The list has no stage events, so a cancelled request has no step here.
import SERVICES from '../data/services.json';
import { SERVICE_TILES } from '../data/mock';
import { isMortalRequest, serviceKeyFromTitle } from './requestShape';
import { TRACKING_STEPS, cityName, trackingPosition } from './requestTracking';
import { isNewTeleRequest } from './teleConsultation';
import { corporateText } from './corporateMedical';
import { COLORS } from '../theme/colors';

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
  progress: [COLORS.primarySoft, COLORS.primary],
  completed: ['#E0F5F4', '#0B6564'],
};
const BADGE_OTHER = ['#EEF1F6', '#5B6B84'];
export const SEGMENT_DONE = COLORS.primary;
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
  // A new-format Teleconsultation has an address and no destination: no route is drawn on its card.
  // A new-format Home Healthcare request has a home address, not a trip: no route either (item.homeFormat is set by toListItem).
  // A new-format Corporate Medical Solutions request has an Office Address in its origin, not a trip: no route either (item.corporateCompany is set by toListItem for it).
  const tele = isNewTeleRequest(item) || item.homeFormat === true || typeof item.corporateCompany === 'string';
  const from = tele ? '' : shortPlace(item.origin);
  const to = tele ? '' : shortPlace(item.destination);
  const fullFrom = tele ? '' : String(item.origin || '').trim();
  const fullTo = tele ? '' : String(item.destination || '').trim();
  const sub = [item.id, item.display].filter(Boolean).join(' · ');
  // Mortal Remains: the card shows the service name, the Deceased Person's Name and the request number (in `sub`). No other service has this line.
  const personName = isMortalRequest(item) ? String(item.patientName || '').trim() : '';
  // A new-format Corporate Medical Solutions request: the card names the company (item.corporateCompany is set by toListItem); it has no route.
  const company = typeof item.corporateCompany === 'string' && item.corporateCompany.trim() !== '' ? { label: corporateText(t, 'corp_company'), name: item.corporateCompany.trim() } : null;
  const person = personName ? { label: t('lbl_deceased_name'), name: personName } : company;

  // For a screen reader: everything, with the full place names.
  const stepPhrase = progress.kind === 'cancelled' ? '' : t('mr_a11y_step', { n: progress.kind === 'completed' ? STEP_COUNT : progress.step, total: STEP_COUNT });
  let route = '';
  if (fullFrom && fullTo) route = t('mr_a11y_route', { from: fullFrom, to: fullTo });
  else route = fullFrom || fullTo;
  const label = [name, person ? `${person.label}: ${person.name}` : '', item.id, statusLabel, stepPhrase, route].filter(Boolean).join(', ');

  return {
    key, name, sub, person, statusLabel, badge: { bg: badgeBg, fg: badgeFg },
    route: from || to ? { from, to } : null,
    progress, label,
  };
}

// The counts on the chips, from the whole loaded list (not from the search or the filter).
export function statusCounts(items) {
  const counts = { all: items.length, submitted: 0, progress: 0, completed: 0, cancelled: 0 };
  for (const item of items) if (Object.prototype.hasOwnProperty.call(counts, item.status) && item.status !== 'all') counts[item.status] += 1;
  return counts;
}
