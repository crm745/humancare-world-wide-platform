// How the Private Charter tracking model is drawn (no React, no native modules, no network).
//
// Input: the object buildPrivateCharterTracking returns. This file decides nothing about the journey: it only
// chooses what to show for what the model already says (which rows, which dot, which text key, which time).
// Nothing is invented: a time is shown only when the model carries one, and there is no ETA, distance,
// aircraft or coordinator anywhere.
import { MILESTONE_STATE } from './privateCharterTracking';
import { COLORS as BRAND } from '../../theme/colors';

// UI-only colours for these screens. (tracking/palette.js and the Tailwind theme are left as they are.)
export const COLORS = Object.freeze({
  PRIMARY: BRAND.primary,
  SECONDARY: '#2F2A62',
  CANCEL: '#C23B3B',
  CANCEL_SOFT: '#FBE9E9',
  PRIMARY_SOFT: BRAND.primarySoft,
  NEUTRAL_SOFT: '#EEF1F6',
  WARNING: '#B4740D',
  WARNING_SOFT: '#FDF0DA',
  TEXT: '#17233D',
  MUTED: '#5B6B84',
  FAINT: '#97A4B8',
  LINE: '#E4E9F2',
  WHITE: '#FFFFFF',
});

export const DOT_SIZE = 26;

// Status chip colours by the model's status tone.
const TONES = {
  neutral: { fg: COLORS.MUTED, bg: COLORS.NEUTRAL_SOFT },
  info: { fg: COLORS.PRIMARY, bg: COLORS.PRIMARY_SOFT },
  attention: { fg: COLORS.WARNING, bg: COLORS.WARNING_SOFT },
  done: { fg: COLORS.PRIMARY, bg: COLORS.PRIMARY_SOFT },
  cancelled: { fg: COLORS.CANCEL, bg: COLORS.CANCEL_SOFT },
};
export const toneColors = (tone) => TONES[tone] || TONES.neutral;

const two = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "03 Nov 2026, 11:00" in the device's own time zone, or '' when there is no usable time. Never "now".
export function formatTime(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const DOT = {
  [MILESTONE_STATE.COMPLETED]: 'completed',
  [MILESTONE_STATE.ACTIVE]: 'active',
  [MILESTONE_STATE.PENDING]: 'pending',
  [MILESTONE_STATE.CANCELLED]: 'cancelled',
};

// The rows of the timeline, in the model's order, without the steps that do not apply to this request.
//   dot       'completed' | 'active' | 'pending' | 'cancelled'
//   time      the formatted time of a reached step; the stop row of a cancelled request uses the cancellation time
//   showPendingLabel  a step that has not been reached reads "Pending" in place of a time
//   titleKey  the title key; the stop row of a cancelled request reads "Cancelled" (the row keeps its place)
//   stepTitleKey  the milestone's own title key, always (a cancelled row is announced by the step it stopped at)
//   subKey    the supporting text key; a cancelled stop row says it was closed
export function timelineRows(model) {
  const milestones = Array.isArray(model?.milestones) ? model.milestones : [];
  const shown = milestones.filter((m) => m && m.state !== MILESTONE_STATE.NOT_APPLICABLE && DOT[m.state]);
  return shown.map((m, i) => {
    const cancelled = m.state === MILESTONE_STATE.CANCELLED;
    const pending = m.state === MILESTONE_STATE.PENDING;
    return {
      key: m.key,
      titleKey: cancelled ? 'tcp_cancelled_label' : m.titleKey,
      stepTitleKey: m.titleKey,
      subKey: cancelled ? 'tcp_cancelled_sub' : m.subKey,
      dot: DOT[m.state],
      time: pending ? '' : formatTime(cancelled ? model?.cancellation?.cancelledAt : m.occurredAt),
      showPendingLabel: pending,
      last: i === shown.length - 1,
    };
  });
}

// What a screen reader says for a row: the step, where it stands, its supporting text and its time. Only
// translated fixed text and a real time: nothing from the request's own free text.
const STATE_TEXT_KEY = { completed: 'status_completed', active: 'tcp_state_active', pending: 'timeline_pending', cancelled: 'status_cancelled' };
export const rowAccessibilityLabel = (row, t) => [t(row.stepTitleKey), t(STATE_TEXT_KEY[row.dot]), t(row.subKey), row.time].filter(Boolean).join(', ');

// Right-to-left languages mirror a direction arrow, as the back button in TopBar does.
export const mirrorStyle = (isRTL) => (isRTL ? { transform: [{ scaleX: -1 }] } : null);

// The two ends of the route: the city, or null when the request has none (the screen shows a dash).
export const routeEnds = (model) => ({
  origin: model?.origin?.city || null,
  destination: model?.destination?.city || null,
});

// The Admin's message, shown only while changes are requested (the model already withholds it otherwise).
export const changesMessage = (model) => {
  const detail = model?.status?.detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
};

// Whether the "open request" action is offered: only when the patient has something to do.
export const showOpenRequest = (model) => model?.review?.actionNeeded === true;

// Every translation key the model can put on screen, so a test can check them all in every language.
export const MODEL_TEXT_KEYS = Object.freeze([
  ...['request_received', 'documents_review', 'documents_review_awaiting_documents', 'documents_review_in_review', 'documents_review_changes_requested',
    'request_approved', 'flight_scheduled', 'flight_scheduling', 'mission_in_progress', 'completed']
    .flatMap((k) => [`tcp_m_${k}`, `tcp_m_${k}_sub`]),
  ...['received', 'awaiting_documents', 'in_review', 'changes_requested', 'approved', 'scheduled', 'in_progress', 'completed', 'cancelled'].map((k) => `tcp_status_${k}`),
  'tcp_cancelled_label', 'tcp_cancelled_sub', 'tcp_route_heading', 'tcp_timeline_heading', 'tcp_changes_label', 'tcp_open_request', 'tcp_state_active',
]);
