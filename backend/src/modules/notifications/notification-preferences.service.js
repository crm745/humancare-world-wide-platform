// Patient notification preferences: in-app ON/OFF and push ON/OFF, one NotificationPreference row per patient.
//
// Patient only. The owner type is fixed to "patient" and the owner id is always the authenticated patient's User id,
// handed in by the controller from `req.user.id`; no function here reads an owner from a request body, query or route.
// Corporate preferences (CorporateUser.settings) are a separate mechanism and are not touched.
//
// A patient with no row has the defaults (in-app ON, push ON), the same as the database column defaults. Reading never
// creates a row. The first update creates it with only the supplied fields, so the database default applies to the other.
//
// Storing `pushEnabled` has no effect yet: there is no device registration or push delivery in this stage. `inAppEnabled`
// is enforced by the patient notification list (notifications.service.js), which hides non-mandatory notifications while it
// is OFF. Mandatory notifications (security, payment) ignore both switches.

const { prisma } = require('../../db/prisma');

const OWNER_TYPE = 'patient';
const DEFAULT_PREFERENCES = Object.freeze({ inAppEnabled: true, pushEnabled: true });
const PREFERENCE_SELECT = Object.freeze({ inAppEnabled: true, pushEnabled: true });
const ALLOWED_FIELDS = Object.freeze(['inAppEnabled', 'pushEnabled']);

function preferenceError(statusCode, message, publicCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

// Only { inAppEnabled?: boolean, pushEnabled?: boolean }, at least one, strict booleans. Anything else is a 400.
// Returns a new object holding just the supplied fields.
function validatePreferencePatch(body) {
  const invalid = (message) => preferenceError(400, message, 'invalid_preferences');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send an object with inAppEnabled and/or pushEnabled.');
  const keys = Object.keys(body);
  if (keys.length === 0) throw invalid('Send at least one of inAppEnabled or pushEnabled.');
  if (keys.some((k) => !ALLOWED_FIELDS.includes(k))) throw invalid('Only inAppEnabled and pushEnabled can be set.');
  const patch = {};
  for (const key of keys) {
    if (typeof body[key] !== 'boolean') throw invalid(`${key} must be true or false.`);
    patch[key] = body[key];
  }
  return patch;
}

const ownerKey = (patientId) => ({ ownerType_ownerId: { ownerType: OWNER_TYPE, ownerId: patientId } });

// No row means the defaults. Never writes.
async function getPatientPreferences(patientId) {
  const row = await prisma.notificationPreference.findUnique({ where: ownerKey(patientId), select: PREFERENCE_SELECT });
  return row ? { inAppEnabled: row.inAppEnabled, pushEnabled: row.pushEnabled } : { ...DEFAULT_PREFERENCES };
}

async function updatePatientPreferences(patientId, body) {
  const patch = validatePreferencePatch(body);

  // `ownerId` has no foreign key, so make sure the patient exists: a deleted account must not leave an orphan row.
  const user = await prisma.user.findUnique({ where: { id: patientId }, select: { id: true } });
  if (!user) throw preferenceError(404, 'Patient not found');

  const upsert = () => prisma.notificationPreference.upsert({
    where: ownerKey(patientId),
    // Only the supplied fields: an omitted one takes the database default on create and is left alone on update.
    create: { ownerType: OWNER_TYPE, ownerId: patientId, ...patch },
    update: { ...patch },
    select: PREFERENCE_SELECT,
  });

  let row;
  try {
    row = await upsert();
  } catch (err) {
    // Two first updates can race: both see no row and both insert; the loser gets a unique-key conflict (P2002). The row
    // exists now, so one retry takes the update path. This table has no other unique index, and any other error is rethrown.
    if (!err || err.code !== 'P2002') throw err;
    row = await upsert();
  }
  return { inAppEnabled: row.inAppEnabled, pushEnabled: row.pushEnabled };
}

module.exports = { DEFAULT_PREFERENCES, validatePreferencePatch, getPatientPreferences, updatePatientPreferences };
