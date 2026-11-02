// Audit trail for actions that are not a patient's: an Admin working a corporate
// registration or login, the registrant acting on their own application. Written to the
// same SecurityEvent table as the patient events, but with the actor in `actor_type` /
// `actor_id` so an admin id can never be mistaken for a patient id.
//
// Never pass a password, an OTP, a token or a full mobile number in `detail`. Writing the
// log must not break the action it describes, so a failure is reported and swallowed.
const { prisma } = require('../../db/prisma');

const ACTOR = { ADMIN: 'admin', REGISTRANT: 'registrant', SYSTEM: 'system' };

// `subject` names what the action was about (e.g. "registration:42"), so it can be looked up.
async function recordAuditEvent(req, event, { actorType, actorId = null, subject = null, detail = null } = {}) {
  try {
    await prisma.securityEvent.create({
      data: {
        event,
        actorType,
        actorId,
        identifier: subject,
        ipAddress: (req && req.ip) || null,
        userAgent: String((req && req.get && req.get('user-agent')) || '').slice(0, 255) || null,
        detail: detail || undefined,
      },
    });
  } catch (err) {
    console.error(`Could not record audit event "${event}":`, err.message);
  }
}

module.exports = { recordAuditEvent, ACTOR };
