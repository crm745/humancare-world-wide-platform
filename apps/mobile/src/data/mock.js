// Mock data mirroring interactive-prototype/app.html. Replace with API calls
// (see docs/ROADMAP.md §3) once the mobile app is wired to the backend.
import { COUNTRY_NAME_BY_ISO } from './countries';

// Home / Select Service grid. Private Charter and Commercial Escort used to be
// combined under one "Air Ambulance" tile that opened a sub-menu picking between the
// two — now shown as their own top-level tiles instead, one tap to either.
export const SERVICE_TILES = [
  { key: 'privatecharter', img: 'IMG_AIR', title: 'air_opt_charter_title', sub: 'air_opt_charter_sub' },
  { key: 'commercialair', img: 'IMG_COMMERCIALAIR', title: 'air_opt_commercial_title', sub: 'air_opt_commercial_sub' },
  { key: 'ground', img: 'IMG_GROUND', title: 'svc_ground', sub: 'svc_ground_sub' },
  { key: 'hospital', img: 'IMG_HOSPITAL', title: 'svc_hospital', sub: 'svc_hospital_sub' },
  { key: 'mortal', img: 'IMG_MORTAL', title: 'svc_mortal', sub: 'svc_mortal_sub' },
  { key: 'homecare', img: 'IMG_HOMECARE', title: 'svc_homecare', sub: 'svc_homecare_sub' },
  { key: 'tele', img: 'IMG_TELE', title: 'svc_tele', sub: 'svc_tele_sub' },
  { key: 'corporate', img: 'IMG_CORPORATE', title: 'svc_corporate', sub: 'svc_corporate_sub' },
];

// Commercial Airlines is booked either way; each is its own service in Bitrix
// (Commercial Airline Stretcher (CAS) / Wheelchair (CAW)), so the request has to say which.
export const AIRLINE_MODES = ['stretcher', 'wheelchair'];
export const AIRLINE_MODE_LABELS = { stretcher: 'Stretcher (CAS)', wheelchair: 'Wheelchair (CAW)' };
export const needsAirlineMode = (serviceKey) => serviceKey === 'commercialair';

// Mortal Remains asks about the deceased instead of a patient, and whether the transfer
// stays within India or crosses borders (two separate pipelines in Bitrix).
export const isMortal = (serviceKey) => serviceKey === 'mortal';
export const MORTAL_TRANSFERS = ['domestic', 'international'];
export const MORTAL_TRANSFER_LABELS = { domestic: 'Within India', international: 'International' };
export const DECEASED_RELATIONS = ['Father', 'Mother', 'Brother', 'Sister', 'Spouse', 'Son', 'Daughter', 'Friend', 'Other'];

// What a request is submitted as: the name people see, and the key the backend maps to
// Bitrix's "Required Service" (backend src/modules/bitrix/bitrix-lead.js).
export function requestService(draft, services) {
  const title = (services[draft.service] || services.air).title;
  if (needsAirlineMode(draft.service) && draft.airlineMode) {
    return { title: `${title} — ${AIRLINE_MODE_LABELS[draft.airlineMode]}`, key: `${draft.service}_${draft.airlineMode}` };
  }
  if (isMortal(draft.service) && draft.mortalTransfer) {
    return { title: `${title} — ${MORTAL_TRANSFER_LABELS[draft.mortalTransfer]}`, key: `${draft.service}_${draft.mortalTransfer}` };
  }
  return { title, key: draft.service };
}

// Label keys for each service filter value.
export const SERVICE_LABELS = {
  air: 'svc_air',
  ground: 'svc_ground',
  hospital: 'filter_svc_hospital',
  escort: 'filter_svc_escort',
  mortal: 'filter_svc_mortal',
  homecare: 'filter_svc_homecare',
  tele: 'svc_tele',
  corporate: 'filter_svc_corporate',
};

export const NOTIFICATIONS = [
  { kind: 'submitted', title: 'notif_request_submitted_title', body: 'notif_request_submitted_body', ago: '2h ago' },
  { kind: 'progress', title: 'notif_request_progress_title', body: 'notif_request_progress_body', ago: '10m ago' },
  { kind: 'completed', title: 'notif_request_completed_title', body: 'notif_request_completed_body', ago: '1d ago' },
  { kind: 'cancelled', title: 'notif_request_cancelled_title', body: 'notif_request_cancelled_body', ago: '3d ago' },
];

export const REGIONAL_NUMBERS = [
  { label: 'country_india', display: '+91 9699999065', tel: '+919699999065' },
  { label: 'country_uae_global', display: '+971 585787878', tel: '+971585787878' },
  { label: 'country_oman', display: '+968 92402959', tel: '+96892402959' },
  { label: 'country_bangladesh', display: '+880 1314968067', tel: '+8801314968067' },
  { label: 'country_uk', display: '+44 7557070702', tel: '+447557070702' },
];

export const FAQS = [
  { q: 'faq_q1', a: 'For critical cases, our team can have an aircraft airborne within 2–4 hours of confirmed clearance.' },
  { q: 'faq_q2', a: 'We work directly with most major TPAs and insurers on a Guarantee of Payment basis.' },
  { q: 'faq_q3', a: 'Open My Requests, tap a request, then View Live Tracking — no separate app needed.' },
  { q: 'faq_q4', a: 'We have offices across 8 regions — India, UAE, Oman, Turkey, Canada, Kenya, Bangladesh and Singapore — plus a global network of 3,500+ partner hospitals.' },
];

export const LANGUAGES = [
  { code: 'EN', name: 'English', label: 'English (EN)' },
  { code: 'HI', name: 'हिंदी (Hindi)', label: 'हिंदी (HI)' },
  { code: 'MR', name: 'मराठी (Marathi)', label: 'मराठी (MR)' },
  { code: 'GU', name: 'ગુજરાતી (Gujarati)', label: 'ગુજરાતી (GU)' },
  { code: 'TE', name: 'తెలుగు (Telugu)', label: 'తెలుగు (TE)' },
  { code: 'AR', name: 'العربية (Arabic)', label: 'العربية (AR)' },
];

// Full set of ITU-T E.164 international calling codes, so the country selector isn't
// limited to a handful of markets. India/UAE/UK/US lead the list since they're our
// primary markets and the app's defaults; the rest follow in numeric order.
export const COUNTRY_CODES = [
  '+91', '+971', '+44', '+1',
  '+7', '+20', '+27', '+30', '+31', '+32', '+33', '+34', '+36', '+39', '+40', '+41', '+43',
  '+45', '+46', '+47', '+48', '+49', '+51', '+52', '+53', '+54', '+55', '+56', '+57', '+58',
  '+60', '+61', '+62', '+63', '+64', '+65', '+66', '+81', '+82', '+84', '+86', '+90', '+92',
  '+93', '+94', '+95', '+98',
  '+211', '+212', '+213', '+216', '+218', '+220', '+221', '+222', '+223', '+224', '+225',
  '+226', '+227', '+228', '+229', '+230', '+231', '+232', '+233', '+234', '+235', '+236',
  '+237', '+238', '+239', '+240', '+241', '+242', '+243', '+244', '+245', '+246', '+248',
  '+249', '+250', '+251', '+252', '+253', '+254', '+255', '+256', '+257', '+258', '+260',
  '+261', '+262', '+263', '+264', '+265', '+266', '+267', '+268', '+269',
  '+290', '+291', '+297', '+298', '+299',
  '+350', '+351', '+352', '+353', '+354', '+355', '+356', '+357', '+358', '+359',
  '+370', '+371', '+372', '+373', '+374', '+375', '+376', '+377', '+378', '+380', '+381',
  '+382', '+383', '+385', '+386', '+387', '+389',
  '+420', '+421', '+423',
  '+500', '+501', '+502', '+503', '+504', '+505', '+506', '+507', '+508', '+509',
  '+590', '+591', '+592', '+593', '+594', '+595', '+596', '+597', '+598', '+599',
  '+670', '+672', '+673', '+674', '+675', '+676', '+677', '+678', '+679', '+680', '+681',
  '+682', '+683', '+685', '+686', '+687', '+688', '+689', '+690', '+691', '+692',
  '+850', '+852', '+853', '+855', '+856', '+880', '+886',
  '+960', '+961', '+962', '+963', '+964', '+965', '+966', '+967', '+968', '+970', '+972',
  '+973', '+974', '+975', '+976', '+977',
  '+992', '+993', '+994', '+995', '+996', '+998',
];

// ISO 3166-1 alpha-2 for each calling code above, so the country selector can show a
// short, reliable text label (e.g. "IN +91") instead of a bare code — flag emoji were
// tried here before and dropped because they don't render as flags on some platforms
// (shows as literal letters instead), so plain text is the deliberate choice, not a
// placeholder. A calling code can be shared by several countries (+1 is also Canada
// and the Caribbean, +44 is also the Isle of Man, etc.) — this picks the one the code
// is most commonly associated with, same convention every phone-number picker uses.
const CALLING_CODE_COUNTRY = {
  '+91': 'IN', '+971': 'AE', '+44': 'GB', '+1': 'US',
  '+7': 'RU', '+20': 'EG', '+27': 'ZA', '+30': 'GR', '+31': 'NL', '+32': 'BE', '+33': 'FR', '+34': 'ES', '+36': 'HU', '+39': 'IT', '+40': 'RO', '+41': 'CH', '+43': 'AT',
  '+45': 'DK', '+46': 'SE', '+47': 'NO', '+48': 'PL', '+49': 'DE', '+51': 'PE', '+52': 'MX', '+53': 'CU', '+54': 'AR', '+55': 'BR', '+56': 'CL', '+57': 'CO', '+58': 'VE',
  '+60': 'MY', '+61': 'AU', '+62': 'ID', '+63': 'PH', '+64': 'NZ', '+65': 'SG', '+66': 'TH', '+81': 'JP', '+82': 'KR', '+84': 'VN', '+86': 'CN', '+90': 'TR', '+92': 'PK',
  '+93': 'AF', '+94': 'LK', '+95': 'MM', '+98': 'IR',
  '+211': 'SS', '+212': 'MA', '+213': 'DZ', '+216': 'TN', '+218': 'LY', '+220': 'GM', '+221': 'SN', '+222': 'MR', '+223': 'ML', '+224': 'GN', '+225': 'CI',
  '+226': 'BF', '+227': 'NE', '+228': 'TG', '+229': 'BJ', '+230': 'MU', '+231': 'LR', '+232': 'SL', '+233': 'GH', '+234': 'NG', '+235': 'TD', '+236': 'CF',
  '+237': 'CM', '+238': 'CV', '+239': 'ST', '+240': 'GQ', '+241': 'GA', '+242': 'CG', '+243': 'CD', '+244': 'AO', '+245': 'GW', '+246': 'IO', '+248': 'SC',
  '+249': 'SD', '+250': 'RW', '+251': 'ET', '+252': 'SO', '+253': 'DJ', '+254': 'KE', '+255': 'TZ', '+256': 'UG', '+257': 'BI', '+258': 'MZ', '+260': 'ZM',
  '+261': 'MG', '+262': 'RE', '+263': 'ZW', '+264': 'NA', '+265': 'MW', '+266': 'LS', '+267': 'BW', '+268': 'SZ', '+269': 'KM',
  '+290': 'SH', '+291': 'ER', '+297': 'AW', '+298': 'FO', '+299': 'GL',
  '+350': 'GI', '+351': 'PT', '+352': 'LU', '+353': 'IE', '+354': 'IS', '+355': 'AL', '+356': 'MT', '+357': 'CY', '+358': 'FI', '+359': 'BG',
  '+370': 'LT', '+371': 'LV', '+372': 'EE', '+373': 'MD', '+374': 'AM', '+375': 'BY', '+376': 'AD', '+377': 'MC', '+378': 'SM', '+380': 'UA', '+381': 'RS',
  '+382': 'ME', '+383': 'XK', '+385': 'HR', '+386': 'SI', '+387': 'BA', '+389': 'MK',
  '+420': 'CZ', '+421': 'SK', '+423': 'LI',
  '+500': 'FK', '+501': 'BZ', '+502': 'GT', '+503': 'SV', '+504': 'HN', '+505': 'NI', '+506': 'CR', '+507': 'PA', '+508': 'PM', '+509': 'HT',
  '+590': 'GP', '+591': 'BO', '+592': 'GY', '+593': 'EC', '+594': 'GF', '+595': 'PY', '+596': 'MQ', '+597': 'SR', '+598': 'UY', '+599': 'CW',
  '+670': 'TL', '+672': 'NF', '+673': 'BN', '+674': 'NR', '+675': 'PG', '+676': 'TO', '+677': 'SB', '+678': 'VU', '+679': 'FJ', '+680': 'PW', '+681': 'WF',
  '+682': 'CK', '+683': 'NU', '+685': 'WS', '+686': 'KI', '+687': 'NC', '+688': 'TV', '+689': 'PF', '+690': 'TK', '+691': 'FM', '+692': 'MH',
  '+850': 'KP', '+852': 'HK', '+853': 'MO', '+855': 'KH', '+856': 'LA', '+880': 'BD', '+886': 'TW',
  '+960': 'MV', '+961': 'LB', '+962': 'JO', '+963': 'SY', '+964': 'IQ', '+965': 'KW', '+966': 'SA', '+967': 'YE', '+968': 'OM', '+970': 'PS', '+972': 'IL',
  '+973': 'BH', '+974': 'QA', '+975': 'BT', '+976': 'MN', '+977': 'NP',
  '+992': 'TJ', '+993': 'TM', '+994': 'AZ', '+995': 'GE', '+996': 'KG', '+998': 'UZ',
};

// A handful of ISO codes don't match what people actually type/look for — "AE" reads
// as nothing to most people searching for "UAE", same for "GB" vs "UK". Override just
// the display text for these; CALLING_CODE_COUNTRY itself stays the correct ISO data.
const DISPLAY_OVERRIDE = { AE: 'UAE', GB: 'UK' };
const countryLabel = (iso2) => DISPLAY_OVERRIDE[iso2] || iso2;

// "+91" -> "IN +91", for any UI that wants the country label without changing what's
// actually stored/sent as the calling code.
export const COUNTRY_CODE_LABELS = Object.fromEntries(
  COUNTRY_CODES.map((code) => [code, `${countryLabel(CALLING_CODE_COUNTRY[code])} ${code}`])
);

// Full country names, deduped and sorted — same countries as the phone country-code
// picker above, but for the standalone "Country" field on the request/new-case forms
// (where the patient/case actually is, unrelated to anyone's phone number). The name
// itself is what gets saved and shown in the admin portal.
export const COUNTRY_NAMES = [...new Set(COUNTRY_CODES.map((code) => COUNTRY_NAME_BY_ISO[CALLING_CODE_COUNTRY[code]]))]
  .sort((a, b) => a.localeCompare(b, 'en'));

// 24/7 emergency line used by the Home SOS button and Help & Support "Call Alarm Desk".
export const EMERGENCY_TEL = '+919699999065';
export const EMERGENCY_DISPLAY = '+91 96999 99065';
export const OPS_EMAIL = 'ops@humancareworldwide.com';

// "How did you hear about us?" options. Picking SOURCE_OTHER asks the user to type the answer.
export const SOURCE_OTHER = 'Other';
export const SOURCES = ['Google Search', 'Referral', 'Insurance Provider', 'Social Media', SOURCE_OTHER];

// New Request form, medical page. Same values the backend accepts (backend
// src/common/constants/request.constants.js); the labels come from i18n (`mobility_*`, `urgency_*`).
export const MOBILITY_OPTIONS = ['bedridden', 'wheelchair', 'walking'];
export const URGENCY_OPTIONS = ['critical_6h', 'urgent_24h', 'planned'];
// [draft field, API field, i18n label key]
export const EQUIPMENT_OPTIONS = [
  ['equipOxygen', 'equipOxygen', 'equip_oxygen'],
  ['equipCardiac', 'equipCardiacMonitor', 'equip_cardiac_monitor'],
  ['equipVentilator', 'equipVentilator', 'equip_ventilator'],
];
// Reports attached to one request (the backend takes them one upload at a time).
export const MAX_REPORT_FILES = 10;
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
