// Stops a request for Teleconsultation, Medical Value Travel, Marine Medical Safety or Corporate Medical Solutions (the patient's own request) from skipping that service's own validator.
//
// Each of those validators is chosen by the fields the body carries (consultationScope / treatmentScope / serviceScope / companyName ...), because the app used to send the plain generic body for
// them. The generic validator only checks type and size: no phone number, no date rule, none of the service's required fields. So a body with the service key but none of the structured fields, or
// one that names the service in serviceType with another (or no) key, used to go through it and be saved as an incomplete request. The current app always sends the structured body, so the
// generic form of these four services is no longer accepted for NEW requests. Requests already stored in the generic format are untouched (they are rows, not submissions).
//
// Pure: no database, no network. The controller calls it only after every structured branch has declined the body, so a body that carries structured fields never gets here.
// Home Healthcare and Mortal Remains already refuse the generic body (isHomeKey / isMortalKey decide by key alone); Private Charter has its own serviceType check.

const STRICT_SERVICES = Object.freeze({
  tele: 'Tele Consultation & House Call',
  medvalue: 'Medical Value Travel',
  marine: 'Marine Medical Safety',
  corporate: 'Corporate Medical Solutions',
});

const SERVICE_BY_TYPE = new Map(Object.entries(STRICT_SERVICES).map(([key, type]) => [type.toLowerCase(), key]));
const normalizedType = (value) => (typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '');

const UPDATE_MESSAGE = 'This version of the app can no longer send this request. Please update the app and try again.';

// null when the body may continue to the generic path; otherwise { status: 400, body } to send back.
function legacyBypassProblem(body) {
  if (body === null || typeof body !== 'object') return null;
  const { serviceKey } = body;
  // 1. The service's own key without any of its structured fields: the old generic body.
  if (typeof serviceKey === 'string' && Object.hasOwn(STRICT_SERVICES, serviceKey)) {
    return { status: 400, body: { error: UPDATE_MESSAGE, code: 'app_update_required', fields: { serviceKey: `A ${STRICT_SERVICES[serviceKey]} request must use the current request form.` } } };
  }
  // 2. The service named in serviceType while the key says something else (or nothing): relabelling would skip the service's rules, so it is refused, never relabelled.
  const named = SERVICE_BY_TYPE.get(normalizedType(body.serviceType));
  if (named) {
    return { status: 400, body: { error: 'Please correct the highlighted fields.', fields: { serviceKey: `serviceKey must be "${named}" for the ${STRICT_SERVICES[named]} service.` } } };
  }
  return null;
}

module.exports = { legacyBypassProblem, STRICT_SERVICES, UPDATE_MESSAGE };
