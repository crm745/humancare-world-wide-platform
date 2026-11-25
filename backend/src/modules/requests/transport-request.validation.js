// Strict rules for the two patient-transport services that go through the GENERIC create path: Ground Ambulance ("ground") and Commercial Air ("commercialair_stretcher" / "commercialair_wheelchair").
// The generic validator (generic-request.validation.js) only checks the type and size of each key; these services have no validator of their own, so until now a request could be saved with a
// made-up phone number, a date in the past, a blank origin or destination or a name of spaces. The mobile form already refuses all of those; this is the same rule on the server.
//
// Pure: no database, no network. The controller calls it after its existing generic checks (required keys, serviceKey, the medical page: care level, oxygen, equipment, the Ground issue) and
// before validateGenericRequest, so a valid current mobile body passes through unchanged and is stored exactly as before (this never changes a value, it only refuses).
//
// The rules (first problem wins, like the other validators):
//   patientName       required text with a letter in it, no control characters
//   patientContact    required; "+<country code><number>" that libphonenumber accepts for that country (as for Teleconsultation, Home Healthcare, Mortal Remains, Marine, Medical Value Travel).
//                     Stored exactly as the app sent it ("+91 98765 43210"), not reformatted.
//   origin            required text, not blank, no control characters
//   destination       required text, not blank, no control characters
//   preferredDate     required, "YYYY-MM-DD" (what the date picker sends; a time is not accepted), a real day, and not in the past. The app does not tell the server the patient's time
//                     zone for these services, so "past" is judged with a one-day allowance: a day earlier than yesterday (UTC) is past for everyone on Earth, yesterday is allowed because for
//                     a patient in the far west it can still be today. (The date picker's own minimum, the patient's today, is stricter on the phone.)
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { hasDisallowedControl, hasUnpairedSurrogate } = require('./home-healthcare.validation');

const TRANSPORT_KEYS = new Set(['ground', 'commercialair_stretcher', 'commercialair_wheelchair']);
const isTransportRequestKey = (serviceKey) => typeof serviceKey === 'string' && TRANSPORT_KEYS.has(serviceKey);

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (date) => date.toISOString().slice(0, 10);
// The earliest day still acceptable: yesterday in UTC.
const earliestDay = (now) => isoDay(new Date(now.getTime() - DAY_MS));

const realDay = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
};

const badCharacters = (text) => hasDisallowedControl(text) || hasUnpairedSurrogate(text);

// A required one-line-ish text: present, not blank, clean.
function requiredText(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') return `${field} is required`;
  if (badCharacters(value)) return `${field} contains characters that are not allowed`;
  return null;
}

// null when the body is acceptable; otherwise { error } (a 400). Only for the keys above: any other service returns null.
function validateTransportRequest(body, { now = new Date() } = {}) {
  if (body === null || typeof body !== 'object' || !isTransportRequestKey(body.serviceKey)) return null;

  const nameProblem = requiredText(body, 'patientName');
  if (nameProblem) return { error: nameProblem };
  if (!/\p{L}/u.test(body.patientName)) return { error: 'patientName must include a letter' };

  const contact = body.patientContact;
  const phone = typeof contact === 'string' && contact.trim().startsWith('+') ? parsePhoneNumberFromString(contact.trim()) : null;
  if (!phone || !phone.isValid()) return { error: 'patientContact must be a valid phone number with its country code' };

  const originProblem = requiredText(body, 'origin');
  if (originProblem) return { error: originProblem };
  const destinationProblem = requiredText(body, 'destination');
  if (destinationProblem) return { error: destinationProblem };

  const date = body.preferredDate;
  if (typeof date !== 'string' || date.trim() === '') return { error: 'preferredDate is required' };
  if (!realDay(date)) return { error: 'preferredDate must be a valid date (YYYY-MM-DD)' };
  if (date < earliestDay(now)) return { error: 'preferredDate cannot be in the past' };

  return null;
}

module.exports = { validateTransportRequest, isTransportRequestKey, TRANSPORT_KEYS, earliestDay };
