// Bitrix24 pipeline PROFILES. Two separate, frozen configurations that share nothing:
//
//   test    the existing Test Pipeline (Category 38). Its ids live, unchanged, in bitrix-deal.js and bitrix-deal-stages.js; this
//           file only POINTS at them, it does not copy or alter them.
//   actual  the real "Air Ambulance" pipeline (Category 0), shared by Private Charter and Commercial Charter. Only Private
//           Charter is implemented here (bitrix-deal-actual.js). Commercial Charter is not mapped and never uses this profile.
//
// Rules this file enforces:
//   * No implicit default. resolveProfile() returns the profile named by BITRIX_DEAL_PROFILE and NOTHING else: unset or unknown
//     gives null. No code path falls back from one profile to the other.
//   * An id of one profile is never valid in the other (assertDisjoint, and a test).
//   * Every outbox event is stamped with the profile it was queued for (payload.profile); a worker running a different profile
//     refuses it (eventProfileProblem). An event with no stamp is a legacy test-pipeline event: it is only ever accepted by the
//     test profile, never by the actual one.
//   * Option ids are the verified Bitrix enum ids. A value with no verified id is never guessed: mapping it fails closed with a
//     DealMappingError before anything is sent.
const { STAGES, STAGE_LOST } = require('./bitrix-deal-stages');
const { DEAL, FIELD, DOCUMENTS_FIELD } = require('./bitrix-deal');
const { QUOTATION_FIELD, quotationFieldsOf, quotationFieldsForProfile } = require('./quotation-outbox');

const PROFILE_TEST = 'test';
const PROFILE_ACTUAL = 'actual';

// ---- test profile (pointers only) ---------------------------------------------------------------------------------------------
const TEST_PROFILE = Object.freeze({
  name: PROFILE_TEST,
  categoryId: DEAL.CATEGORY_ID, // 38
  newStageId: DEAL.STAGE_ID, // C38:NEW
  documentsField: DOCUMENTS_FIELD,
  documentsMultiple: true, // the test pipeline's Documents field is a multiple file field
  referenceField: FIELD.REFERENCE, // the test Deal's Primary Deal Reference user field
  closedStageIds: Object.freeze(['C38:WON', 'C38:LOSE']),
  quotationFields: QUOTATION_FIELD,
  stageIds: Object.freeze([...Object.keys(STAGES), STAGE_LOST]),
});

// ---- actual profile: Air Ambulance, Category 0 --------------------------------------------------------------------------------
// The verified stage ids of the Air Ambulance pipeline, each with the HumanCare meaning it maps to:
//   key             the Private Charter stage written to cases.charter_stage (a free text column; "patient_details" is the one the review
//                   workflow already writes at approval, the others are new keys of the same kind)
//   status          the cases.status written with it, from the EXISTING vocabulary (submitted | scheduled | in_progress | completed |
//                   cancelled), or null = leave the Case status as it is (the stage is not one of those five)
//   mobileLabel     the patient-facing name of the stage (the app's tracking text for it is a separate, later step)
//   patientVisible  false for every actual stage: NO patient notification is sent for Activate or Case Completed (or any other) until separately approved
// "Activate" keeps its Bitrix label. Junk, Deal lost and Duplicate are NOT workflow stages: they carry no HumanCare meaning here and are
// quarantined by lookupActualStage (a lost Deal is not mapped to "cancelled": no lost-reason mapping has been approved for this pipeline).
const ACTUAL_STAGES = Object.freeze({
  NEW: Object.freeze({ label: 'Enquiry', workflow: true, key: 'patient_details', status: 'submitted', mobileLabel: 'Request Received', patientVisible: false }),
  UC_R55CKV: Object.freeze({ label: 'Quoted', workflow: true, key: 'quotation_ready', status: null, mobileLabel: 'Quotation Ready', patientVisible: false }),
  UC_9E9NRI: Object.freeze({ label: 'Confirmed', workflow: true, key: 'payment_confirmed', status: null, mobileLabel: 'Payment Confirmed', patientVisible: false }),
  UC_HS6O2F: Object.freeze({
    label: 'Activate', workflow: true, key: 'in_progress', status: 'in_progress', mobileLabel: 'Service In Progress', patientVisible: false,
  }),
  WON: Object.freeze({
    label: 'Case Completed', workflow: true, key: 'completed', status: 'completed', mobileLabel: 'Completed', patientVisible: false,
  }),
  UC_CFXC9U: Object.freeze({ label: 'Junk', workflow: false }),
  LOSE: Object.freeze({ label: 'Deal lost', workflow: false }),
  UC_ZSJGIL: Object.freeze({ label: 'Duplicate', workflow: false }),
});

// Private Charter application fields (Deal user fields) in the actual portal.
const ACTUAL_FIELD = Object.freeze({
  PATIENT_NAME: 'UF_CRM_1795169868',
  PATIENT_AGE: 'UF_CRM_1795169999',
  GENDER: 'UF_CRM_1795170359', // list
  TRAVEL_TYPE: 'UF_CRM_1795170598', // list
  ORIGIN_CITY: 'UF_CRM_1795170760',
  DESTINATION_CITY: 'UF_CRM_1795170810',
  MEDICAL_HISTORY: 'UF_CRM_1795170937',
  CRITICAL_LEVEL: 'UF_CRM_1795171046', // list, multi-select
  OXYGEN_REQUIRED: 'UF_CRM_1795171108', // list Yes / No
  OXYGEN_FLOW_LPM: 'UF_CRM_1795171175',
  MEDICAL_REPORT: 'UF_CRM_1795171237', // file, SINGLE (Multiple: No). Left untouched: never written or read by the document sharing any more
  MEDICAL_REPORTS: 'UF_CRM_1795447841', // "Medical Reports - Application": file, MULTIPLE (Multiple: Yes). The field the document sharing uses
  COUNTRY: 'UF_CRM_1795171275',
  CONTACT_NUMBER: 'UF_CRM_1795171315',
  PREFERRED_DATE: 'UF_CRM_1795171360',
  // HumanCare Case Reference: String, single line, not multiple, not required. Holds the exact Case reference; every lookup matches on it.
  CASE_REFERENCE: 'UF_CRM_1795176618',
});

// Enum option ids of the four List fields, VERIFIED against the live portal's field metadata (read-only). These are Bitrix enum ids,
// never the visible labels. A value with no entry here is refused before any write (see bitrix-deal-actual.js).
const ACTUAL_OPTIONS = Object.freeze({
  GENDER: Object.freeze({ male: 6038, female: 6040, other: 6042 }),
  TRAVEL_TYPE: Object.freeze({ patient_transfer: 6044, organ_transfer: 6046 }),
  CRITICAL_LEVEL: Object.freeze({ icu: 6048, ventilated: 6050, tracheostomy: 6052, ecmo: 6054 }),
  OXYGEN_REQUIRED: Object.freeze({ yes: 6056, no: 6058 }),
});

// Verified: Critical Level is USER_TYPE_ID=enumeration with MULTIPLE=Y, so it is sent as an array of option ids.
const ACTUAL_CRITICAL_LEVEL_MULTIPLE = true;

// The actual pipeline's quotation fields: the Quotation PDF - Application file field, and the Deal's STANDARD Amount and Currency (what Operations
// enter in Bitrix24's Amount and currency control). None of the test pipeline's quotation custom fields is used here.
const ACTUAL_QUOTATION_FIELD = Object.freeze({ FILE: 'UF_CRM_1795177914', AMOUNT: 'OPPORTUNITY', CURRENCY: 'CURRENCY_ID' });

const ACTUAL_PROFILE = Object.freeze({
  name: PROFILE_ACTUAL,
  categoryId: 0,
  newStageId: 'NEW',
  documentsField: ACTUAL_FIELD.MEDICAL_REPORTS,
  documentsMultiple: true, // Medical Reports - Application (UF_CRM_1795447841) is a File field, Multiple: Yes; the old single-file field UF_CRM_1795171237 is left alone
  // The dedicated HumanCare Case Reference field. Deal lookup, reconciliation, recovery and the inbound checks all match on it. There is NO
  // fallback to the Deal title: a profile whose reference field is missing or not a UF_CRM_ code is refused everywhere (see referenceFieldOf).
  referenceField: ACTUAL_FIELD.CASE_REFERENCE,
  closedStageIds: Object.freeze(['WON', 'LOSE']),
  quotationFields: ACTUAL_QUOTATION_FIELD,
  quotationFileMultiple: false, // verified: Quotation PDF - Application is a File field, Multiple: No, Required: No (exactly one file is read)
  stageIds: Object.freeze(Object.keys(ACTUAL_STAGES)),
  workflowStageIds: Object.freeze(Object.keys(ACTUAL_STAGES).filter((id) => ACTUAL_STAGES[id].workflow)),
  // Private Charter only. A Commercial Charter request is never built for this profile.
  services: Object.freeze(['privatecharter']),
});

const PROFILES = Object.freeze({ [PROFILE_TEST]: TEST_PROFILE, [PROFILE_ACTUAL]: ACTUAL_PROFILE });

// The profile named by BITRIX_DEAL_PROFILE, or null. There is deliberately no default.
function resolveProfile(env = process.env) {
  const name = typeof env.BITRIX_DEAL_PROFILE === 'string' ? env.BITRIX_DEAL_PROFILE.trim() : '';
  return Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
}

// The profile's Case reference field code, or null when it is missing or not a UF_CRM_ user field. Callers refuse (fail closed) on null: the
// Deal title, or any other field, is never substituted.
const REFERENCE_FIELD = /^UF_CRM_[A-Za-z0-9_]{1,60}$/;
const referenceFieldOf = (profile) => (profile && typeof profile.referenceField === 'string' && REFERENCE_FIELD.test(profile.referenceField) ? profile.referenceField : null);

// The profile named by BITRIX_DEAL_PROFILE as a bare name, or null.
const activeProfileName = (env = process.env) => { const profile = resolveProfile(env); return profile ? profile.name : null; };

// The profile a stored Bitrix category belongs to (BitrixDealLink.categoryId), or null when it is neither.
function profileForCategory(categoryId) {
  if (categoryId == null) return null;
  const text = String(categoryId);
  if (text === String(TEST_PROFILE.categoryId)) return TEST_PROFILE;
  if (text === String(ACTUAL_PROFILE.categoryId)) return ACTUAL_PROFILE;
  return null;
}

// The stamp written onto a new outbox event: the profile the event is queued for. Throws when none is configured, so an event is
// never written without one when Bitrix is going to be used; callers that run with Bitrix off pass nothing (see stampProfile).
function stampProfile(payload, env = process.env) {
  const profile = resolveProfile(env);
  return profile ? { ...payload, profile: profile.name } : { ...payload };
}

// null when `payload` may be processed by `active` (a profile object), otherwise a short code. A missing stamp is a legacy event: it
// belongs to the test pipeline only.
function eventProfileProblem(payload, active) {
  if (!active) return 'profile_not_configured';
  const stamped = payload && typeof payload === 'object' && typeof payload.profile === 'string' ? payload.profile : null;
  const eventProfile = stamped === null ? PROFILE_TEST : stamped;
  if (!Object.prototype.hasOwnProperty.call(PROFILES, eventProfile)) return 'event_profile_unknown';
  return eventProfile === active.name ? null : 'event_profile_mismatch';
}

// -> { ok: true, entry } for the five workflow stages, otherwise { ok: false, code } (the caller quarantines; nothing is guessed).
//   stage_missing  no stage id at all
//   non_workflow_stage  Junk, Deal lost or Duplicate
//   unknown_stage  any other id (including every test-pipeline id such as "C38:NEW")
function lookupActualStage(stageId) {
  if (typeof stageId !== 'string' || stageId === '') return { ok: false, code: 'stage_missing' };
  if (!Object.prototype.hasOwnProperty.call(ACTUAL_STAGES, stageId)) return { ok: false, code: 'unknown_stage' };
  const entry = ACTUAL_STAGES[stageId];
  if (!entry.workflow) return { ok: false, code: 'non_workflow_stage' };
  return { ok: true, entry };
}

// What a Deal-file call needs for a profile: the Documents field and whether it holds one file or several. null when the profile's
// metadata is missing or invalid (the caller then refuses; nothing is assumed).
function documentsConfig(profile) {
  if (!profile || typeof profile.documentsField !== 'string' || !/^UF_CRM_[A-Za-z0-9]{1,60}$/.test(profile.documentsField)) return null;
  if (typeof profile.documentsMultiple !== 'boolean') return null;
  return { documentsField: profile.documentsField, documentsMultiple: profile.documentsMultiple };
}

// Self-check used by tests and at load: nothing of the actual profile appears in the test profile or the other way round.
function assertDisjoint() {
  const testIds = new Set([String(TEST_PROFILE.categoryId), TEST_PROFILE.newStageId, TEST_PROFILE.documentsField, ...TEST_PROFILE.stageIds, ...Object.values(FIELD), ...Object.values(QUOTATION_FIELD)]);
  const actualIds = [String(ACTUAL_PROFILE.categoryId), ACTUAL_PROFILE.newStageId, ACTUAL_PROFILE.documentsField, ...ACTUAL_PROFILE.stageIds, ...Object.values(ACTUAL_FIELD), ...Object.values(ACTUAL_QUOTATION_FIELD)];
  const shared = actualIds.filter((id) => testIds.has(id));
  if (shared.length) throw new Error(`Bitrix profiles share ids: ${shared.join(', ')}`);
}
assertDisjoint();

module.exports = {
  PROFILE_TEST, PROFILE_ACTUAL, PROFILES, TEST_PROFILE, ACTUAL_PROFILE, ACTUAL_STAGES, ACTUAL_FIELD, ACTUAL_QUOTATION_FIELD, quotationFieldsOf, quotationFieldsForProfile, ACTUAL_OPTIONS,
  ACTUAL_CRITICAL_LEVEL_MULTIPLE,
  lookupActualStage, documentsConfig, referenceFieldOf, activeProfileName, resolveProfile, profileForCategory, stampProfile, eventProfileProblem, assertDisjoint,
};
