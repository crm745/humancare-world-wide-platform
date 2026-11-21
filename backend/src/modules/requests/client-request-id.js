// Idempotency for patient request submission (Phase 4 of the network work).
//
// The mobile app generates one random UUID (`clientRequestId`) for each logical submission and sends it with POST /requests, reusing it for every retry of
// that same submission. Together with the signed-in patient it identifies the submission: the database holds a UNIQUE index on (user_id, client_request_id),
// so however many times (and however concurrently) the same submission arrives, at most one request, and one Case, exists for it.
//
//   - the key is OPTIONAL: an older app build sends none, and its requests are saved exactly as before (the column stays NULL; MySQL's unique index allows many NULLs)
//   - the key is scoped to the user: two patients may use the same key without meeting
//   - the key is not a secret and is not patient data, and it is never sent back to anyone but its owner
//
// This file holds only the pure parts and the one lookup, so the controller, the service and the review workflow share them.

// An RFC 4122 UUID as written by crypto.randomUUID() / the app (versions 1 to 8, the usual variant), 36 characters.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// What a request body says about the key.
//   { present: false }                       none sent (an older app build): nothing about idempotency applies
//   { present: true, valid: false }          sent but not a UUID: refused (400), never guessed at
//   { present: true, valid: true, id }       the key, lower-cased so the same UUID is always the same key
// `null` counts as "none sent" (a client that serialises an unset field as null is not sending a key).
function parseClientRequestId(value) {
  if (value === undefined || value === null) return { present: false };
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return { present: true, valid: false };
  return { present: true, valid: true, id: value.toLowerCase() };
}

// The patient's own request saved for this key, or null. `db` is Prisma (or a transaction client). Never looks across users.
function findOwnedByClientRequestId(db, userId, clientRequestId) {
  return db.serviceRequest.findFirst({ where: { userId, clientRequestId } });
}

// A unique-constraint failure (Prisma P2002). With a key present, the only way an insert can lose to another is that the same submission was saved first
// (the reference number carries a random suffix and the Case's request link is unique per new request), so the caller then returns that request.
const isUniqueViolation = (err) => !!err && err.code === 'P2002';

module.exports = { UUID_PATTERN, parseClientRequestId, findOwnedByClientRequestId, isUniqueViolation };
