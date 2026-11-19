import SERVICES from '../data/services.json';
import { formatDate } from './dateFormat';
import { isNewHomeRequest } from './homeHealthcare';
import { isNewCorporateRequest } from './corporateMedical';

// Backend uses 'in_progress'; the UI (Pill, filters, i18n keys) uses 'progress'.
const STATUS_TO_UI = { submitted: 'submitted', in_progress: 'progress', completed: 'completed', cancelled: 'cancelled' };
const TITLE_TO_KEY = Object.fromEntries(Object.entries(SERVICES).map(([key, s]) => [s.title, key]));

// Mortal Remains requests name the deceased, not a patient ("mortal" from older builds,
// "mortal_domestic" / "mortal_international" now).
export const isMortalRequest = (request) => /^mortal(_|$)/.test(request?.serviceKey || '');

export function toUiStatus(backendStatus) {
  return STATUS_TO_UI[backendStatus] || backendStatus;
}

export function serviceKeyFromTitle(title) {
  return TITLE_TO_KEY[title] || 'air';
}

// "05 Oct 2026" in the language the app is showing (or the locale passed); '' for a missing or invalid date.
export function formatDisplayDate(iso, locale) {
  return formatDate(iso, locale);
}

// Shapes one backend ServiceRequest into what the My Requests list / filters expect. The first six fields are what the
// list has always had; the rest (the backend's own status, service key and type, the two places and the creation time)
// are added for the cards and change nothing for the filters.
export function toListItem(request) {
  return {
    id: request.referenceNumber,
    rawId: request.id,
    service: serviceKeyFromTitle(request.serviceType),
    status: toUiStatus(request.status),
    date: (request.createdAt || '').slice(0, 10),
    display: formatDisplayDate(request.createdAt),
    rawStatus: request.status,
    serviceKey: request.serviceKey || null,
    serviceType: request.serviceType || '',
    origin: request.origin || '',
    destination: request.destination || '',
    createdAt: request.createdAt || null,
    // Mortal Remains only: the card names the deceased person (the request's patient name). Every other service's item is exactly as before.
    ...(isMortalRequest(request) ? { patientName: request.patientName || '' } : {}),
    // Home Healthcare only: whether this is a NEW-format request (key homecare and a complete v1 description), so its card draws no route. Every other
    // service's item is exactly as before.
    ...(request.serviceKey === 'homecare' ? { homeFormat: isNewHomeRequest(request) } : {}),
    // Corporate Medical Solutions only: the company of a NEW-format request, so its card can name it (an older one has none). Every other service's item is exactly as before.
    ...(request.serviceKey === 'corporate' && isNewCorporateRequest(request) ? { corporateCompany: request.companyName } : {}),
  };
}

// How a stored care level reads on screen. The backend stores machine keys ("care_icu,care_stable")
// for Private Charter; older requests hold the labels of the language they were made in, and
// anything else is free text. Only a piece that is exactly a known key is translated (into the
// language the app is showing now); everything else is left as stored, byte for byte, so an old
// label, a typed note or an odd comma is never reworded. Same rule as the backend's
// care-level.js (PDF and Bitrix). `t` is the app's translate function.
// Plus Commercial Air's own four (ICU, Ventilated, Tracheostomy, ECMO).
const CARE_LEVEL_KEYS = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na', 'crit_icu', 'crit_ventilated', 'crit_tracheostomy', 'crit_ecmo'];

export function careLevelText(value, t) {
  if (typeof value !== 'string' || value === '') return value;
  const pieces = value.split(',');
  const keys = pieces.map((piece) => (CARE_LEVEL_KEYS.includes(piece.trim()) ? piece.trim() : null));
  if (keys.every(Boolean)) return keys.map((key) => t(key)).join(', ');
  return pieces.map((piece, i) => {
    if (!keys[i]) return piece;
    return `${piece.match(/^\s*/)[0]}${t(keys[i])}${piece.match(/\s*$/)[0]}`;
  }).join(',');
}
