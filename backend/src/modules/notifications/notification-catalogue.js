// Notification System, Step 1: the PATIENT notification catalogue and its PURE validators.
//
// Pure on purpose: no Prisma, no network, no push, no clock, no environment. Nothing here creates, reads or sends a
// notification; the (later) notification core and its callers use these rules. The corporate recipient type is NOT
// supported yet and is rejected on purpose: the corporate side is a separate, later step.
//
// The catalogue is the ONLY source of `isMandatory`. A caller or a client never supplies it: `classifyMandatory` and
// `validateNotificationInput` derive it from the kind and ignore any `isMandatory` they are handed.
//
// Legacy kinds (system, stage_update, quotation_ready, document) stay creatable by the existing call sites and, like any
// stored `kind` string, stay READABLE: reading never consults this catalogue (`isReadableKind` accepts every string).
// Placeholder kinds (security, payment) are reserved names only: no event is wired to them and nothing is sent.

const RECIPIENT_TYPES = Object.freeze({ PATIENT: 'patient' });
const SUPPORTED_RECIPIENT_TYPES = Object.freeze([RECIPIENT_TYPES.PATIENT]);

// Deep-link screens a notification may point the app at. There is deliberately NO "tickets" screen: the patient app has
// no ticket route (support tickets exist only in the corporate portal and the admin portal).
const ALLOWED_SCREENS = Object.freeze(['case', 'request', 'quotation', 'payment', 'home']);
// What `data.entityType` may name.
const ALLOWED_ENTITY_TYPES = Object.freeze(['case', 'service_request', 'quotation', 'payment']);
// The entityType each screen requires. `home` takes no entity reference at all (null).
const SCREEN_ENTITY_TYPE = Object.freeze({ case: 'case', request: 'service_request', quotation: 'quotation', payment: 'payment', home: null });

// Current PATIENT navigation (documentation only; the mobile app owns the real routes and this module changes none):
//   home                                  -> /home
//   case | request | quotation | payment  -> /request-details?id={serviceRequestId}
// Every patient destination is keyed by the ServiceRequest id, so a notification that deep-links to any of these screens
// must carry `serviceRequestId`. There are no separate case, quotation or payment routes in the patient app.
//
// References a deep-link SCREEN requires, for notifications created through the (future) notification core. Applies only
// when `data.screen` is set: historical rows without references or `data` stay valid and readable, and reading never
// consults this table. `caseId` (case screen) and `quotationId` (quotation screen) are recommended but not enforced.
const SCREEN_REQUIRED_REFS = Object.freeze({
  home: Object.freeze([]),
  case: Object.freeze(['serviceRequestId']),
  request: Object.freeze(['serviceRequestId']),
  quotation: Object.freeze(['serviceRequestId']),
  payment: Object.freeze(['serviceRequestId', 'quotationId']),
});

// Which reference `data.entityId` must equal, per screen. `payment` is null: there is no payment-record column on a
// notification, so that relationship is validated by the future notification core (it needs the database). `home` has no entity.
const SCREEN_ENTITY_REF = Object.freeze({ case: 'caseId', request: 'serviceRequestId', quotation: 'quotationId', payment: null, home: null });

// Fixed, safe notification texts. Never copy staff free text (case notes, ticket replies) into a body or a push.
// (There is no patient ticket feature yet, so there is no ticket text and no ticket kind.)
const SAFE_BODIES = Object.freeze({
  caseStatusUpdated: 'Your case status has been updated.',
});
// The only keys `data` may carry. Safe navigation metadata only; never medical details.
const DATA_KEYS = Object.freeze(['screen', 'entityType', 'entityId']);
// The optional context references a notification row may carry (the Notification columns).
const REF_FIELDS = Object.freeze(['caseId', 'serviceRequestId', 'quotationId']);

// Size limits (proposed defaults; the columns are TEXT for body and JSON for data, so these are policy, not DB limits).
const LIMITS = Object.freeze({
  titleMax: 150,
  bodyMax: 1000,
  dataMaxBytes: 512, // UTF-8 bytes of the JSON-serialised `data`
  idempotencyKeyMax: 191, // notifications.idempotency_key is VARCHAR(191)
  eventRefMax: 80,
});

const CATEGORIES = Object.freeze({
  GENERAL: 'general',
  CASE: 'case',
  QUOTATION: 'quotation',
  DOCUMENT: 'document',
  SECURITY: 'security',
  PAYMENT: 'payment',
});

function kind(def) {
  return Object.freeze({
    legacy: false,
    placeholder: false,
    ...def,
    recipientTypes: Object.freeze([...def.recipientTypes]),
    allowedScreens: Object.freeze([...def.allowedScreens]),
    requiredRefs: Object.freeze([...(def.requiredRefs || [])]),
  });
}

const PATIENT = [RECIPIENT_TYPES.PATIENT];

// Legacy kinds require no references: the existing call sites pass none, and their stored rows must stay valid.
// Mandatory: security and payment only.
const CATALOGUE = Object.freeze({
  system: kind({ title: 'HumanCare notification', category: CATEGORIES.GENERAL, mandatory: false, legacy: true, recipientTypes: PATIENT, allowedScreens: ['home'] }),
  stage_update: kind({ title: 'Your case has been updated', category: CATEGORIES.CASE, mandatory: false, legacy: true, recipientTypes: PATIENT, allowedScreens: ['case', 'request'] }),
  quotation_ready: kind({ title: 'Your quotation is ready', category: CATEGORIES.QUOTATION, mandatory: false, legacy: true, recipientTypes: PATIENT, allowedScreens: ['quotation', 'case'] }),
  document: kind({ title: 'A document has been updated', category: CATEGORIES.DOCUMENT, mandatory: false, legacy: true, recipientTypes: PATIENT, allowedScreens: ['case', 'request'] }),

  // Placeholders: reserved names for future events. No integration exists.
  security_password_changed: kind({ title: 'Your password was changed', category: CATEGORIES.SECURITY, mandatory: true, placeholder: true, recipientTypes: PATIENT, allowedScreens: ['home'] }),
  security_new_login: kind({ title: 'New sign-in to your account', category: CATEGORIES.SECURITY, mandatory: true, placeholder: true, recipientTypes: PATIENT, allowedScreens: ['home'] }),
  payment_received: kind({ title: 'Payment received', category: CATEGORIES.PAYMENT, mandatory: true, placeholder: true, recipientTypes: PATIENT, allowedScreens: ['payment', 'quotation', 'case'], requiredRefs: ['quotationId'] }),
  payment_failed: kind({ title: 'Payment failed', category: CATEGORIES.PAYMENT, mandatory: true, placeholder: true, recipientTypes: PATIENT, allowedScreens: ['payment', 'quotation', 'case'], requiredRefs: ['quotationId'] }),
  payment_refunded: kind({ title: 'Payment refunded', category: CATEGORIES.PAYMENT, mandatory: true, placeholder: true, recipientTypes: PATIENT, allowedScreens: ['payment', 'quotation', 'case'], requiredRefs: ['quotationId'] }),
});

class NotificationValidationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'NotificationValidationError';
    this.code = code;
  }
}

const ok = (extra) => ({ ok: true, ...(extra || {}) });
const fail = (code, message) => ({ ok: false, code, message: message || code });

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

// ---- catalogue lookups -------------------------------------------------------------------------------------------
function getKindDefinition(k) {
  return typeof k === 'string' && has(CATALOGUE, k) ? CATALOGUE[k] : null;
}

// The fixed title of a kind (see `title` in the catalogue), or null for an unknown kind. Titles are never caller-supplied
// by the notification core: fixed text, with no patient, case or medical details.
function getKindTitle(k) {
  const def = getKindDefinition(k);
  return def ? def.title : null;
}

function isKnownKind(k) {
  return getKindDefinition(k) !== null;
}

// Reading is never restricted by the catalogue: any stored kind string (including ones removed later) stays readable.
function isReadableKind(k) {
  return typeof k === 'string';
}

// The ONLY way to learn whether a notification is mandatory. Unknown kinds are never mandatory (and cannot be created).
function classifyMandatory(k) {
  const def = getKindDefinition(k);
  return def ? def.mandatory : false;
}

// ---- field validators --------------------------------------------------------------------------------------------
function validateRecipientType(recipientType) {
  return SUPPORTED_RECIPIENT_TYPES.includes(recipientType)
    ? ok()
    : fail('unsupported_recipient_type', 'Only the patient recipient type is supported.');
}

function validateRecipientId(recipientId) {
  return isPositiveInt(recipientId) ? ok() : fail('invalid_recipient_id', 'recipientId must be a positive integer.');
}

function validateKind(k) {
  return isKnownKind(k) ? ok() : fail('unknown_kind', 'Unknown notification kind.');
}

function validateKindForRecipient(k, recipientType) {
  const def = getKindDefinition(k);
  if (!def) return fail('unknown_kind', 'Unknown notification kind.');
  return def.recipientTypes.includes(recipientType)
    ? ok()
    : fail('kind_not_allowed_for_recipient', 'This kind is not allowed for this recipient type.');
}

function validateScreen(screen, k) {
  if (typeof screen !== 'string' || !ALLOWED_SCREENS.includes(screen)) return fail('invalid_screen', 'Not an allowed deep-link screen.');
  if (k !== undefined) {
    const def = getKindDefinition(k);
    if (!def) return fail('unknown_kind', 'Unknown notification kind.');
    if (!def.allowedScreens.includes(screen)) return fail('screen_not_allowed_for_kind', 'This screen is not allowed for this kind.');
  }
  return ok();
}

function validateText(value, field, max, { required }) {
  if (value === undefined || value === null) return required ? fail(`${field}_required`, `${field} is required.`) : ok();
  if (typeof value !== 'string') return fail(`${field}_invalid`, `${field} must be a string.`);
  if (required && value.trim().length === 0) return fail(`${field}_required`, `${field} is required.`);
  if (value.length > max) return fail(`${field}_too_long`, `${field} is longer than ${max} characters.`);
  return ok();
}

// `data` is optional (null/undefined is fine). When present: a plain object with only screen / entityType / entityId.
function validateData(data, k) {
  if (data === undefined || data === null) return ok();
  if (!isPlainObject(data)) return fail('data_invalid', 'data must be an object.');
  for (const key of Object.keys(data)) {
    if (!DATA_KEYS.includes(key)) return fail('data_key_not_allowed', `data.${key} is not an allowed key.`);
  }
  if (has(data, 'screen')) {
    const r = validateScreen(data.screen, k);
    if (!r.ok) return r;
  }
  if (has(data, 'entityType') && !ALLOWED_ENTITY_TYPES.includes(data.entityType)) {
    return fail('invalid_entity_type', 'data.entityType is not allowed.');
  }
  if (has(data, 'entityId') && !isPositiveInt(data.entityId)) return fail('invalid_entity_id', 'data.entityId must be a positive integer.');
  // entityType and entityId only make sense together.
  if (has(data, 'entityType') !== has(data, 'entityId')) return fail('data_entity_incomplete', 'data.entityType and data.entityId go together.');
  // The entity must be the kind the screen opens; `home` opens no entity.
  if (has(data, 'screen')) {
    const expected = SCREEN_ENTITY_TYPE[data.screen];
    if (expected === null && has(data, 'entityType')) return fail('entity_not_allowed_for_screen', 'The home screen takes no entity reference.');
    if (expected && has(data, 'entityType') && data.entityType !== expected) return fail('entity_type_screen_mismatch', `The ${data.screen} screen needs entityType ${expected}.`);
  }
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > LIMITS.dataMaxBytes) return fail('data_too_large', `data is larger than ${LIMITS.dataMaxBytes} bytes.`);
  return ok();
}

// Shape and kind-rule check of the Case / ServiceRequest / CaseQuotation ids. Whether they EXIST or belong to the
// recipient needs the database and is the (later) core's job, not this module's.
function validateRefs(refs, k) {
  const def = getKindDefinition(k);
  if (!def) return fail('unknown_kind', 'Unknown notification kind.');
  const r = refs === undefined || refs === null ? {} : refs;
  if (!isPlainObject(r)) return fail('refs_invalid', 'References must be an object.');
  for (const key of Object.keys(r)) {
    if (!REF_FIELDS.includes(key)) return fail('ref_not_allowed', `${key} is not an allowed reference.`);
  }
  for (const field of REF_FIELDS) {
    if (r[field] !== undefined && r[field] !== null && !isPositiveInt(r[field])) return fail('ref_invalid', `${field} must be a positive integer.`);
  }
  for (const field of def.requiredRefs) {
    if (!isPositiveInt(r[field])) return fail('ref_required', `${field} is required for ${k}.`);
  }
  return ok();
}

// The references a deep-link screen needs (SCREEN_REQUIRED_REFS). Shape only; existence and ownership are the core's job.
function validateScreenRefs(screen, refs) {
  if (!has(SCREEN_REQUIRED_REFS, screen)) return fail('invalid_screen', 'Not an allowed deep-link screen.');
  const r = refs === undefined || refs === null ? {} : refs;
  for (const field of SCREEN_REQUIRED_REFS[screen]) {
    if (!isPositiveInt(r[field])) return fail('screen_ref_required', `${field} is required for the ${screen} screen.`);
  }
  return ok();
}

// When `data.entityId` is given, it must equal the matching reference (case -> caseId, request -> serviceRequestId,
// quotation -> quotationId), and that reference must be present. Without an entityId, caseId / quotationId stay optional.
// Payment is deferred to the notification core. Pure: compares the numbers it is given, checks nothing in a database.
function validateEntityConsistency(data, refs) {
  if (!data || !has(data, 'entityId') || !has(data, 'screen')) return ok();
  const refField = SCREEN_ENTITY_REF[data.screen];
  if (!refField) return ok();
  const r = refs === undefined || refs === null ? {} : refs;
  if (!isPositiveInt(r[refField])) return fail('entity_ref_missing', `${refField} is required when data.entityId is given for the ${data.screen} screen.`);
  if (data.entityId !== r[refField]) return fail('entity_ref_mismatch', `data.entityId must equal ${refField}.`);
  return ok();
}

// ---- whole-input validator ---------------------------------------------------------------------------------------
// Validates one notification to be created and returns the sanitised value. `isMandatory` always comes from the
// catalogue; one in `input` is ignored (and not copied). Any other unlisted field is not copied either.
function validateNotificationInput(input) {
  if (!isPlainObject(input)) return fail('input_invalid', 'Input must be an object.');
  const steps = [
    () => validateRecipientType(input.recipientType),
    () => validateRecipientId(input.recipientId),
    () => validateKindForRecipient(input.kind, input.recipientType),
    () => validateText(input.title, 'title', LIMITS.titleMax, { required: true }),
    () => validateText(input.body, 'body', LIMITS.bodyMax, { required: false }),
    () => validateRefs({ caseId: input.caseId, serviceRequestId: input.serviceRequestId, quotationId: input.quotationId }, input.kind),
    () => validateData(input.data, input.kind),
    () => (input.data && has(input.data, 'screen')
      ? validateScreenRefs(input.data.screen, { caseId: input.caseId, serviceRequestId: input.serviceRequestId, quotationId: input.quotationId })
      : ok()),
    () => validateEntityConsistency(input.data, { caseId: input.caseId, serviceRequestId: input.serviceRequestId, quotationId: input.quotationId }),
  ];
  for (const step of steps) {
    const r = step();
    if (!r.ok) return r;
  }
  const value = {
    recipientType: input.recipientType,
    recipientId: input.recipientId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    caseId: input.caseId ?? null,
    serviceRequestId: input.serviceRequestId ?? null,
    quotationId: input.quotationId ?? null,
    data: input.data ? { ...input.data } : null,
    isMandatory: classifyMandatory(input.kind),
  };
  return ok({ value });
}

// ---- direct push data ----------------------------------------------------------------------------------------------
// The ONLY data a direct push may carry so the app can open the right screen when it is tapped: the deep-link `screen` and,
// for the request-related screens, the `serviceRequestId` (the patient app has no other destination). Nothing else, and
// never a medical, patient or case detail. Returns undefined when there is nothing safe to send (the push then carries no
// data and a tap just opens the app). `notification` is a stored notification (its `data.screen` and `serviceRequestId`).
function pushDataFromNotification(notification) {
  if (!notification || typeof notification !== 'object') return undefined;
  const screen = notification.data && typeof notification.data === 'object' ? notification.data.screen : undefined;
  if (typeof screen !== 'string' || !ALLOWED_SCREENS.includes(screen)) return undefined;
  if (screen === 'home') return { screen };
  return isPositiveInt(notification.serviceRequestId) ? { screen, serviceRequestId: notification.serviceRequestId } : undefined;
}

// ---- idempotency key ---------------------------------------------------------------------------------------------
// Format:  <kind>:<recipientType>:<recipientId>:<eventRef>
// e.g.     quotation_ready:patient:42:q17
// The recipient is part of the key because notifications.idempotency_key is GLOBALLY unique: the same event for two
// patients must produce two keys. `eventRef` is a stable id of the triggering event (a quotation id, an inbox event
// id, a payment id...), never a time, a random value or message text, so a repeat of the same event gives the same key.
const EVENT_REF_PATTERN = /^[A-Za-z0-9_.-]+$/; // no ":" so the four parts can never run together

function validateEventRef(eventRef) {
  const s = typeof eventRef === 'number' && Number.isSafeInteger(eventRef) && eventRef >= 0 ? String(eventRef) : eventRef;
  if (typeof s !== 'string' || s.length === 0 || s.length > LIMITS.eventRefMax || !EVENT_REF_PATTERN.test(s)) {
    return fail('invalid_event_ref', 'eventRef must be 1-80 characters of letters, digits, "_", "." or "-".');
  }
  return ok({ value: s });
}

function buildIdempotencyKey({ recipientType, recipientId, kind: k, eventRef }) {
  const checks = [validateRecipientType(recipientType), validateRecipientId(recipientId), validateKind(k), validateEventRef(eventRef)];
  const bad = checks.find((c) => !c.ok);
  if (bad) throw new NotificationValidationError(bad.code, bad.message);
  const key = `${k}:${recipientType}:${recipientId}:${checks[3].value}`;
  if (key.length > LIMITS.idempotencyKeyMax) throw new NotificationValidationError('idempotency_key_too_long', 'Idempotency key is too long.');
  return key;
}

module.exports = {
  RECIPIENT_TYPES,
  SUPPORTED_RECIPIENT_TYPES,
  ALLOWED_SCREENS,
  ALLOWED_ENTITY_TYPES,
  SCREEN_ENTITY_TYPE,
  SCREEN_REQUIRED_REFS,
  SCREEN_ENTITY_REF,
  SAFE_BODIES,
  DATA_KEYS,
  REF_FIELDS,
  LIMITS,
  CATEGORIES,
  CATALOGUE,
  NotificationValidationError,
  getKindDefinition,
  getKindTitle,
  isKnownKind,
  isReadableKind,
  classifyMandatory,
  validateRecipientType,
  validateRecipientId,
  validateKind,
  validateKindForRecipient,
  validateScreen,
  validateData,
  validateRefs,
  validateScreenRefs,
  validateEntityConsistency,
  validateEventRef,
  pushDataFromNotification,
  validateNotificationInput,
  buildIdempotencyKey,
};
