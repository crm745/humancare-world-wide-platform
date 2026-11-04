// Admin Lock audit events (SecurityEvent rows) are kept on their own fixed schedule. The shared
// security-log purge skips them and the Admin audit purge handles only them, so
// SECURITY_LOG_RETENTION_DAYS can never shorten or lengthen it.
//
// An event is an Admin audit event when EITHER
//  - its actor_type is admin or operator, OR
//  - its actor_type is system AND its event name starts with "admin." (the explicit
//    discriminator for Admin Lock system events, e.g. "admin.account_locked"; the audit writer
//    refuses system events without it). The prefix deliberately avoids "_" and "%", which are
//    wildcards in SQL LIKE, so the database matches exactly what isAdminAuditEvent matches.
// Every other row (patient rows with no actor, registrant, any other system event) belongs to
// the shared, configurable retention. The two where-clauses below are exact complements.
const ADMIN_AUDIT_ACTOR_TYPES = Object.freeze(['admin', 'operator']);
const ADMIN_SYSTEM_EVENT_PREFIX = 'admin.';
const SYSTEM_ACTOR_TYPE = 'system';
const ADMIN_AUDIT_RETENTION_DAYS = 365;

function isAdminAuditEvent({ actorType, event }) {
  if (ADMIN_AUDIT_ACTOR_TYPES.includes(actorType)) return true;
  return actorType === SYSTEM_ACTOR_TYPE && typeof event === 'string' && event.startsWith(ADMIN_SYSTEM_EVENT_PREFIX);
}

// Prisma `where` (without the age cut-off) matching exactly the rows isAdminAuditEvent accepts.
function adminAuditEventWhere() {
  return {
    OR: [
      { actorType: { in: [...ADMIN_AUDIT_ACTOR_TYPES] } },
      { actorType: SYSTEM_ACTOR_TYPE, event: { startsWith: ADMIN_SYSTEM_EVENT_PREFIX } },
    ],
  };
}

// Prisma `where` matching exactly the rows isAdminAuditEvent rejects. The explicit null branch
// matters: "actor_type NOT IN (...)" alone would skip patient rows, whose actor_type is NULL.
function sharedAuditEventWhere() {
  return {
    OR: [
      { actorType: null },
      { actorType: { notIn: [...ADMIN_AUDIT_ACTOR_TYPES, SYSTEM_ACTOR_TYPE] } },
      { actorType: SYSTEM_ACTOR_TYPE, event: { not: { startsWith: ADMIN_SYSTEM_EVENT_PREFIX } } },
    ],
  };
}

module.exports = {
  ADMIN_AUDIT_ACTOR_TYPES,
  ADMIN_SYSTEM_EVENT_PREFIX,
  ADMIN_AUDIT_RETENTION_DAYS,
  isAdminAuditEvent,
  adminAuditEventWhere,
  sharedAuditEventWhere,
};
