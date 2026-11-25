// What the Tracking Details banner says, as plain functions (no React, no native modules), so every rule can be unit-tested.
import { COLORS } from '../theme/colors';
import { badgeFor } from './myRequestsView';
import { toUiStatus } from './requestShape';
import { formatDate, formatDayMonth } from './dateFormat';

// ---- the title and the subtitle ----------------------------------------------------------------------------------------------

// With a route: "Mumbai → Delhi" (the arrow points the way the text reads: ← in a right-to-left language), the full service name below it.
// Without one (Home Healthcare, Teleconsultation ...): the short service name, and below it the patient's area / city when there is one, else the full service name.
//   hasRoute   both cities are known
//   shortName  the short service name ('' when the service has none: then the full name is the title)
// A subtitle that only repeats the chip next to the request number ("Ground Ambulance" under a "Ground Ambulance" chip) is left out: the line would say the same thing twice.
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// THE SERVICE IS NAMED ONCE. The chip carries its name when the title is the route; when there is no route the title IS the service's name and the chip shows only the service's icon (showChipLabel false).
// The second line is never another name of the service ("Medical Escort" over "Commercial Airlines"): it is the patient's area, or nothing.
export function bannerTexts({ hasRoute, from, to, shortName, serviceName, area, chipLabel }, rtl = false) {
  let title;
  let subtitle;
  let showChipLabel = true;
  if (hasRoute && from && to) { title = `${from} ${rtl ? '←' : '→'} ${to}`; subtitle = ''; } else { title = shortName || serviceName || ''; subtitle = area || ''; showChipLabel = !title; }
  if (subtitle && (same(subtitle, chipLabel) || same(subtitle, title))) subtitle = '';
  return { title, subtitle, showChipLabel };
}

// ---- the blue part ---------------------------------------------------------------------------------------------------------------

// A linear gradient at 135 degrees (top-left to bottom-right), and a soft white glow in the top corner: a radial fade from white 18% to nothing, never a solid shape.
export const GRADIENT = Object.freeze({
  colors: Object.freeze(['#4450B8', COLORS.primary, '#222A6E']), // the brand blue token
  locations: Object.freeze([0, 0.48, 1]),
  start: Object.freeze({ x: 0, y: 0 }),
  end: Object.freeze({ x: 1, y: 1 }),
});
export const GLOW = Object.freeze({ size: 240, opacity: 0.18 });

// ---- the time of the last update ---------------------------------------------------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// The relative time as a small description, or null when there is no (valid) time.
//   { kind: 'now' }                            under a minute (a time slightly in the future, from a clock that is a little off, counts as "just now")
//   { kind: 'min', n }                         under an hour
//   { kind: 'hr', n }                          under a day
//   { kind: 'yesterday' }                      the calendar day before today
//   { kind: 'date', iso, sameYear }            anything older: "19 Nov", with the year when it is another year
export function relativeParts(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const at = new Date(value);
  const ms = at.getTime();
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  const diff = nowMs - ms;
  if (diff < MIN) return { kind: 'now' };
  if (diff < HOUR) return { kind: 'min', n: Math.floor(diff / MIN) };
  if (diff < 24 * HOUR) return { kind: 'hr', n: Math.floor(diff / HOUR) };
  const now = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return { kind: 'yesterday' };
  return { kind: 'date', iso: at.toISOString(), sameYear: at.getFullYear() === now.getFullYear() };
}

// "Just now", "5 min ago", "2 hr ago", "Yesterday", "19 Nov" / "19 Nov 2025": what the banner shows.
export function relativeText(parts, t) {
  if (!parts) return '';
  switch (parts.kind) {
    case 'now': return t('tb_just_now');
    case 'min': return t('tb_min_ago', { n: parts.n });
    case 'hr': return t('tb_hr_ago', { n: parts.n });
    case 'yesterday': return t('tb_yesterday');
    default: return parts.sameYear ? formatDayMonth(parts.iso) : formatDate(parts.iso);
  }
}

// The same, written out for a screen reader ("5 minutes ago", never "5 min").
export function relativeSpoken(parts, t) {
  if (!parts) return '';
  switch (parts.kind) {
    case 'now': return t('tb_say_just_now');
    case 'min': return t(parts.n === 1 ? 'tb_say_min_one' : 'tb_say_min_other', { n: parts.n });
    case 'hr': return t(parts.n === 1 ? 'tb_say_hr_one' : 'tb_say_hr_other', { n: parts.n });
    case 'yesterday': return t('tb_say_yesterday');
    default: return t('tb_say_date', { date: parts.sameYear ? formatDayMonth(parts.iso) : formatDate(parts.iso) });
  }
}

// Calls `onTick` once a minute until stopped. The timer functions are injectable so a test can drive it with a fake clock.
export const TICK_MS = MIN;
export function startMinuteTicker(onTick, { setIntervalFn = setInterval, clearIntervalFn = clearInterval, everyMs = TICK_MS } = {}) {
  const id = setIntervalFn(onTick, everyMs);
  return () => clearIntervalFn(id);
}

// ---- the status colour ---------------------------------------------------------------------------------------------------------

// The colour of the status value: the text colour of the shared status mapping (lib/myRequestsView.js STATUS_BADGE: submitted soft blue, in progress amber, completed green, cancelled grey), so one status
// is one colour on Home, My Requests, Request Details and here. Anything else (an unknown status) is neutral grey.
export const statusColorOf = (status) => badgeFor(toUiStatus(status)).fg;

// ---- the spoken label ------------------------------------------------------------------------------------------------------------

// One label for the whole card: "Request REQ-1067, Mumbai to Delhi, Private Charter Air Ambulance Service, status In progress, updated 2 minutes ago".
export function bannerAccessibilityLabel({ reference, hasRoute, from, to, shortName, serviceName, status, whenSpoken }, t) {
  const place = hasRoute && from && to ? t('mr_a11y_route', { from, to }) : '';
  return [
    reference ? t('tb_a11y_request', { ref: reference }) : '',
    place,
    shortName || serviceName, // the service, named once
    status ? t('tb_a11y_status', { status }) : '',
    whenSpoken ? t('tb_a11y_updated', { when: whenSpoken }) : '',
  ].filter(Boolean).join(', ');
}
