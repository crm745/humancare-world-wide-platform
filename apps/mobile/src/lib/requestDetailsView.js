// What the Request Details screen shows, worked out from the request the API returns (GET /requests/me/:id).
// Pure (no React, no native modules), so it can be unit-tested. The screen only draws what this returns.
//
// Rules in one place:
//   - a row whose value is empty (null, undefined, blank, or the text "null" / "undefined") is never returned;
//   - every stored key or English word is shown through i18n (gender, relation, travel and transfer type,
//     mobility, urgency, equipment, care level), and a value we do not know is shown as it was stored;
//   - a date-only value (preferredDate, dateOfDeath) is read in UTC, so it never moves to the day before;
//   - the step and stage name of a live case come from trackingPosition, the Tracking screen's own function.
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import SERVICES from '../data/services.json';
import { getDateLocale, formatDate, formatDayMonth, formatTime } from './dateFormat';
import { nameOf } from './phoneCountry';
import { careLevelText } from './requestShape';
import { TRACKING_STEPS, trackingPosition } from './requestTracking';
import { documentHistory, reviewBanner, reviewState } from './requestDocuments';
import { formatSize } from './documentHistoryView';
import { serviceKeyOf, serviceTitleKey } from './myRequestsView';

export const STEP_COUNT = TRACKING_STEPS.length;

// ---- small helpers -------------------------------------------------------------------------------------------------

// The text of a value, or '' when there is nothing worth showing (never "null" or "undefined").
export function textOf(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text === '' || text === 'null' || text === 'undefined' ? '' : text;
}

const baseKeyOf = (request) => String((request && request.serviceKey) || '').split('_')[0];
const suffixOf = (request) => String((request && request.serviceKey) || '').split('_').slice(1).join('_');

// ---- the status badge (same colours as My Requests) -----------------------------------------------------------------

const BADGE = {
  submitted: ['#FDF0DA', '#8F4C08'],
  in_progress: ['#E7F0FE', '#1A5FC4'],
  completed: ['#E0F5F4', '#0B6564'],
  cancelled: ['#EEF1F6', '#5B6B84'],
};
const STATUS_I18N = { submitted: 'status_submitted', in_progress: 'status_progress', completed: 'status_completed', cancelled: 'status_cancelled' };

export function statusBadge(request, t) {
  const status = request && request.status;
  const [bg, fg] = BADGE[status] || BADGE.cancelled;
  const key = STATUS_I18N[status];
  return { bg, fg, label: key ? t(key) : textOf(status) };
}

// ---- the service ------------------------------------------------------------------------------------------------------

// The service's name without the "— Stretcher (CAS)" / "— Within India" suffix, in the app's language.
export function baseServiceName(request, t) {
  const key = serviceKeyOf(request);
  const titleKey = key === 'privatecharter' ? 'air_opt_charter_title' : key === 'commercialair' ? 'air_opt_commercial_title' : serviceTitleKey(key);
  if (titleKey) return t(titleKey);
  if (SERVICES[key] && SERVICES[key].title) return SERVICES[key].title;
  return textOf(String((request && request.serviceType) || '').split(' — ')[0]);
}

export const isMortalKey = (request) => /^mortal(_|$)/.test((request && request.serviceKey) || '');
// Patient transport: the services that ask for care level, mobility and equipment.
export const isTransportRequest = (request) => ['air', 'privatecharter', 'commercialair', 'ground'].includes(baseKeyOf(request));

// "stretcher" / "wheelchair" from "commercialair_stretcher"; "domestic" / "international" from "mortal_domestic".
export function travelTypeKey(request) {
  if (baseKeyOf(request) !== 'commercialair') return null;
  const s = suffixOf(request);
  return s === 'stretcher' || s === 'wheelchair' ? `rd_travel_${s}` : null;
}
export function transferTypeKey(request) {
  if (baseKeyOf(request) !== 'mortal') return null;
  const s = suffixOf(request);
  return s === 'domestic' || s === 'international' ? `rd_transfer_${s}` : null;
}

// ---- values ----------------------------------------------------------------------------------------------------------

// Male / male / MALE -> the language's word; anything else as stored.
export function genderLabel(value, t) {
  const v = textOf(value).toLowerCase();
  if (['male', 'female', 'other', 'prefer_not_to_say'].includes(v)) return t(`gender_${v}`);
  return textOf(value);
}

// A country name as stored (non-Charter), or an ISO code ("AE", Charter) as its name.
export function countryLabel(value) {
  const v = textOf(value);
  if (/^[A-Za-z]{2}$/.test(v)) return nameOf(v.toUpperCase()) || v;
  return v;
}

// "+91 98765 43210" from "+919876543210" or "+91 9876543210"; the stored text when it cannot be read as a number.
export function phoneLabel(value) {
  const v = textOf(value);
  if (!v) return '';
  try {
    const parsed = parsePhoneNumberFromString(v.startsWith('+') ? v : `+${v.replace(/\D/g, '')}`);
    if (parsed && parsed.isValid()) return parsed.formatInternational();
  } catch {
    // not a phone number we can read: show it as stored
  }
  return v;
}

const RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];
export const relationLabel = (value, t) => {
  const v = textOf(value);
  return RELATIONS.includes(v) ? t(`rd_rel_${v.toLowerCase()}`) : v;
};

// A date with no time of day (preferredDate, dateOfDeath): read in UTC so it is the day that was picked.
export function formatDateOnly(value, locale) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const options = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale || getDateLocale(), options).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(date);
  }
}

// How urgent: the chip's colours and words. null for an older request that has none.
const URGENCY = {
  critical_6h: { bg: '#FDECEC', fg: '#C53030', alert: true },
  urgent_24h: { bg: '#FDF0DA', fg: '#8F4C08', alert: false },
  planned: { bg: '#EEF1F6', fg: '#5B6B84', alert: false },
};
export function urgencyView(value, t) {
  const v = textOf(value);
  return Object.prototype.hasOwnProperty.call(URGENCY, v) ? { ...URGENCY[v], label: t(`urgency_${v}`) } : null;
}

export const mobilityLabel = (value, t) => {
  const v = textOf(value);
  return ['bedridden', 'wheelchair', 'walking'].includes(v) ? t(`mobility_${v}`) : v;
};

// One chip per care level (careLevelText translates known keys and leaves older labels as stored).
export function careChips(value, t) {
  const text = careLevelText(textOf(value), t);
  return textOf(text) ? text.split(',').map((piece) => piece.trim()).filter(Boolean) : [];
}

const EQUIPMENT = [['equipOxygen', 'equip_oxygen'], ['equipCardiacMonitor', 'equip_cardiac_monitor'], ['equipVentilator', 'equip_ventilator']];
// What is needed on board: the labels of the true ones; none:true when all three are false; null (hide the row) when
// none of them was asked, as on older requests.
export function equipmentView(request, t) {
  const values = EQUIPMENT.map(([field]) => request && request[field]);
  if (values.every((v) => v === null || v === undefined)) return null;
  const items = EQUIPMENT.filter(([field]) => request[field] === true).map(([, key]) => t(key));
  return { items, none: items.length === 0 };
}

// The condition text is clamped to four lines; the "Show more" button appears only when it is longer than that.
export const CLAMP_LINES = 4;
export const needsClamp = (fullHeight, lineHeight = 21, lines = CLAMP_LINES) => Number.isFinite(fullHeight) && fullHeight > lineHeight * lines + 1;

// ---- the status card ----------------------------------------------------------------------------------------------------

// A live case: the Case exists and the team has started (scheduled or in progress).
export const isCaseActive = (request) => !!(request && request.case != null && ['scheduled', 'in_progress'].includes(request.case.status));

const events = (request) => (request && request.case && Array.isArray(request.case.stageEvents) ? request.case.stageEvents : []);
const time = (e) => { const ms = Date.parse(e && e.occurredAt); return Number.isNaN(ms) ? -Infinity : ms; };
const latest = (list) => list.reduce((best, e) => (best === null || time(e) >= time(best) ? e : best), null);

const dayAndTime = (iso) => {
  const day = formatDayMonth(iso);
  return day ? `${day}, ${formatTime(iso)}` : '';
};

// Exactly one of:
//   cancelled | completed | active | review (Charter banner) | approved | under_review
// `step` and `stageKey` of an active case come from trackingPosition, as the Tracking screen's do.
export function statusCard(request) {
  if (!request) return { kind: 'under_review' };
  if (request.status === 'cancelled') return { kind: 'cancelled' };
  if (request.status === 'completed' || (request.case && request.case.status === 'completed')) {
    const done = latest(events(request).filter((e) => e.stage === 'completed'));
    return { kind: 'completed', date: done ? formatDate(done.occurredAt) : '' };
  }
  if (isCaseActive(request)) {
    const { index } = trackingPosition(request);
    const last = latest(events(request));
    return { kind: 'active', step: index + 1, total: STEP_COUNT, stageKey: TRACKING_STEPS[index].title, updated: last ? dayAndTime(last.occurredAt) : '' };
  }
  const banner = reviewBanner(request);
  if (banner && banner.key !== 'approved') return { kind: 'review', banner };
  if (request.reviewStatus === 'approved') return { kind: 'approved' };
  return { kind: 'under_review' };
}

// ---- documents ---------------------------------------------------------------------------------------------------------

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp'];
export const extOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(textOf(name));
  return m ? m[1].toLowerCase() : '';
};

const typeLabel = (type, t) => {
  const v = textOf(type);
  if (!v || v === 'Medical Report') return t('lbl_medical_report');
  if (v === 'Death Certificate') return t('lbl_death_certificate');
  return v;
};

// Every file of the request, one row each. A review-workflow request lists its CURRENT documents (replaced versions
// stay in Document history) and they are display-only; any other request lists its Case documents, which open.
export function documentRows(request, t) {
  const workflow = reviewState(request) !== null;
  const rows = workflow
    ? documentHistory(request.requestDocuments).filter((d) => d.isCurrent).map((d) => ({
      id: d.id, name: d.name, type: typeLabel('Medical Report', t), size: d.sizeBytes, at: d.uploadedAt, openable: false,
      status: d.status, statusLabel: d.statusLabel, reason: d.rejectionReason || d.guidance || null,
    }))
    : ((request && request.case && request.case.documents) || []).map((d) => ({
      id: d.id, name: textOf(d.name) || 'Document', type: typeLabel(d.type, t), size: d.fileSizeBytes, at: d.uploadedAt, openable: true, status: null, statusLabel: null, reason: null,
    }));
  return rows.map((r) => {
    const ext = extOf(r.name);
    return {
      ...r,
      ext: ext.toUpperCase(),
      isImage: IMAGE_EXT.includes(ext),
      meta: [r.type, ext.toUpperCase(), Number.isFinite(r.size) && r.size > 0 ? formatSize(r.size) : '', r.at ? formatDayMonth(r.at) : ''].filter(Boolean).join(' · '),
    };
  });
}

// ---- the whole screen ---------------------------------------------------------------------------------------------------

const field = (key, label, value, full) => (textOf(value) ? { key, label, value: textOf(value), full: !!full } : null);
const compact = (list) => list.filter(Boolean);

// Everything the screen draws, in order. `t` is the app's translate function.
export function detailsView(request, t) {
  const mortal = isMortalKey(request);
  const transport = isTransportRequest(request);
  const travel = travelTypeKey(request);
  const transfer = transferTypeKey(request);
  const equipment = transport ? equipmentView(request, t) : null;
  const urgency = urgencyView(request.urgency, t);
  const care = transport ? careChips(request.careLevel, t) : [];
  const mobility = transport ? mobilityLabel(request.mobility, t) : '';
  const docs = documentRows(request, t);

  return {
    header: {
      reference: textOf(request.referenceNumber),
      serviceKey: serviceKeyOf(request),
      name: baseServiceName(request, t),
      badge: statusBadge(request, t),
      requested: formatDate(request.createdAt),
    },
    status: statusCard(request),
    patient: {
      titleKey: mortal ? 'rd_deceased' : 'rd_patient',
      fields: compact([
        field('name', t(mortal ? 'lbl_deceased_name' : 'lbl_name'), request.patientName, true),
        field('age', t('rd_age'), request.patientAge),
        field('gender', t('field_gender'), genderLabel(request.patientGender, t)),
        field('country', t('field_country'), countryLabel(request.country)),
        field('contact', t('rd_contact'), phoneLabel(request.patientContact)),
        ...(mortal ? [
          field('relation', t('rd_relation'), relationLabel(request.deceasedRelation, t), true),
          field('deathPlace', t('field_place_of_death'), request.placeOfDeath, true),
          field('deathDate', t('field_date_of_death'), formatDateOnly(request.dateOfDeath), true),
        ] : []),
      ]),
    },
    trip: {
      from: textOf(request.origin),
      to: textOf(request.destination),
      rows: compact([
        field('date', t(mortal ? 'rd_date_transfer' : 'rd_date_service'), formatDateOnly(request.preferredDate)),
        field('travel', t('field_airline_mode'), travel ? t(travel) : ''),
        field('transfer', t('field_mortal_transfer'), transfer ? t(transfer) : ''),
      ]),
    },
    medical: {
      urgency,
      conditionLabel: t(mortal ? 'req_details' : 'req_condition'),
      condition: textOf(request.description),
      care,
      mobility,
      equipment,
    },
    documents: docs,
    // The bottom bar (and only it) opens live tracking.
    showTrackingBar: isCaseActive(request) && request.status !== 'cancelled' && request.status !== 'completed',
  };
}
