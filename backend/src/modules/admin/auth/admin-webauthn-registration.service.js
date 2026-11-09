// First-passkey registration for a newly invited Admin, in two halves that share one set of
// eligibility rules:
//   generateAdminPasskeyRegistrationOptions - validates the enrollment ticket and returns the
//     browser options (and stores their challenge);
//   verifyAdminPasskeyRegistration - consumes that challenge, verifies the authenticator's
//     response, stores the public credential, and moves the Admin to "active", all audited.
// Neither issues a token, cookie or session.
//
// Nothing about the Admin, invitation, challenge, RP or origin comes from the browser: the ticket
// supplies an Admin id and invitation id, and every fact behind them is re-read from the
// database. Every refusal that could reveal account state is one generic error.
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
const { isoBase64URL, decodeCredentialPublicKey, cose } = require('@simplewebauthn/server/helpers');
const { prisma } = require('../../../db/prisma');
const { maskEmail } = require('../../../common/utils/phone');
const { loadAdminLockConfig, assertWebAuthnConfig } = require('./admin-lock.config');
const { readAdminEnrollmentTicket, enrollmentTicketMatches } = require('./admin-enrollment-ticket.service');
const { issueAdminWebAuthnChallenge, consumeAdminWebAuthnChallenge } = require('./admin-webauthn-challenge.service');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const {
  ADMIN_REGISTRATION_SETTINGS,
  ADMIN_WEBAUTHN_ALGORITHMS,
  registrationAuthenticatorSelection,
  deriveAdminWebAuthnUserHandle,
  decodeCredentialId,
  hashCredentialId,
  normalizeTransports,
  normalizePasskeyLabel,
} = require('./admin-webauthn.helpers');

// The two invitations that may stand behind an enrollment ticket, both already USED: the original
// activation, or a passkey-enrollment invitation redeemed (with the current password) by an Admin
// who was left pending. "passkey_recovery" (lost-passkey recovery) is deliberately not accepted.
const ENROLLMENT_INVITATION_PURPOSES = Object.freeze(['activation', 'passkey_enrollment']);
const UINT32_MAX = 4294967295;

// The one error for every invalid enrollment context or failed registration. `reason` is a short
// internal code for the audit trail; it is not enumerable, so it is never serialized to a client.
class PasskeyRegistrationError extends Error {
  constructor(reason = 'invalid_context') {
    super('This passkey setup session is not valid. Please start again.');
    this.name = 'PasskeyRegistrationError';
    this.code = 'invalid_enrollment';
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
  }
}

// Reads (and with `lock`, locks) everything that makes an Admin eligible for a first passkey, and
// throws the generic error if any of it is off. With `lock` it first conditionally touches the
// Admin row (requiring status "pending_passkey") and the exact invitation row (requiring it used
// and not revoked): from then until the transaction ends, a concurrent disable, password change
// or invitation revocation must wait, so the reads below cannot be stale. Returns the fresh rows.
async function loadEnrollmentContext(client, claims, { lock, now }) {
  if (lock) {
    const adminHeld = await client.adminUser.updateMany({
      where: { id: claims.adminId, status: 'pending_passkey' },
      data: { updatedAt: now },
    });
    if (adminHeld.count !== 1) throw new PasskeyRegistrationError('state_changed');
    // A write of the value it already has: takes the row lock without changing anything.
    const invitationHeld = await client.adminInvitation.updateMany({
      where: { id: claims.invitationId, adminId: claims.adminId, purpose: { in: [...ENROLLMENT_INVITATION_PURPOSES] }, revokedAt: null, usedAt: { not: null } },
      data: { revokedAt: null },
    });
    if (invitationHeld.count !== 1) throw new PasskeyRegistrationError('state_changed');
  }

  const admin = await client.adminUser.findUnique({ where: { id: claims.adminId } });
  if (!admin || admin.status !== 'pending_passkey' || !(admin.passwordChangedAt instanceof Date)) {
    throw new PasskeyRegistrationError('state_changed');
  }

  // The exact invitation named by the ticket: this Admin's used activation or passkey-enrollment
  // invitation (used before it expired), not revoked.
  const invitation = await client.adminInvitation.findUnique({ where: { id: claims.invitationId } });
  if (
    !invitation
    || invitation.adminId !== admin.id
    || !ENROLLMENT_INVITATION_PURPOSES.includes(invitation.purpose)
    || !(invitation.usedAt instanceof Date)
    || invitation.revokedAt
    || invitation.usedAt > invitation.expiresAt
  ) {
    throw new PasskeyRegistrationError('state_changed');
  }

  // Admin id, invitation id and the password-state marker must all match what was signed.
  if (!enrollmentTicketMatches(claims, { admin, invitationId: invitation.id })) throw new PasskeyRegistrationError('state_changed');

  // First-passkey flow only: any live passkey means this is not the right path.
  const passkeys = await client.adminPasskey.findMany({
    where: { adminId: admin.id, revokedAt: null },
    select: { credentialId: true, transports: true },
  });
  if (passkeys.length > 0) throw new PasskeyRegistrationError('state_changed');

  return { admin, invitation, passkeys };
}

// The validated, browser-safe options for navigator.credentials.create (via
// @simplewebauthn/browser). Throws PasskeyRegistrationError for an invalid context; a server
// configuration problem (missing or invalid WebAuthn settings) throws its own, specific error.
async function generateAdminPasskeyRegistrationOptions({ ticket, ipAddress = null, now = new Date(), db = null } = {}) {
  // Server settings come from configuration only - checked before anything else is touched.
  const { rpId, rpName } = assertWebAuthnConfig(loadAdminLockConfig());

  const claims = readAdminEnrollmentTicket(ticket);
  if (!claims) throw new PasskeyRegistrationError('invalid_ticket');

  const run = async (tx) => {
    const { admin, invitation, passkeys } = await loadEnrollmentContext(tx, claims, { lock: true, now });

    // Joins this transaction: retires earlier open registration challenges and stores the new
    // one against this Admin and invitation. If anything below fails, all of it rolls back.
    const issued = await issueAdminWebAuthnChallenge({
      adminId: admin.id,
      purpose: 'registration',
      invitationId: invitation.id,
      ipAddress,
      now,
      db: tx,
    });

    // Never pass the base64url string: the library would UTF-8-encode it. The bytes make
    // options.challenge equal the stored value.
    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: admin.email,
      userDisplayName: admin.name,
      userID: deriveAdminWebAuthnUserHandle(admin.id),
      challenge: issued.challengeBytes,
      timeout: ADMIN_REGISTRATION_SETTINGS.timeoutMs,
      attestationType: ADMIN_REGISTRATION_SETTINGS.attestationType,
      authenticatorSelection: registrationAuthenticatorSelection(),
      supportedAlgorithmIDs: [...ADMIN_WEBAUTHN_ALGORITHMS],
      excludeCredentials: passkeys.map((p) => ({
        id: isoBase64URL.fromBuffer(p.credentialId),
        transports: normalizeTransports(p.transports),
      })),
    });

    // The browser must be handed exactly the challenge that was stored.
    if (options.challenge !== issued.challenge) throw new Error('Registration options do not match the stored challenge');
    return options;
  };

  return db ? run(db) : prisma.$transaction(run);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const isB64 = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && BASE64URL.test(v);

// Copies only the known fields of the browser's RegistrationResponseJSON, after checking their
// shape and size. Anything else the browser sent is dropped, so it can never reach the library.
function sanitizeRegistrationResponse(response) {
  const inner = response?.response;
  if (
    !response || typeof response !== 'object' || !inner || typeof inner !== 'object'
    || !isB64(response.id, 2048) || !isB64(response.rawId, 2048)
    || response.type !== 'public-key'
    || !isB64(inner.clientDataJSON, 8192) || !isB64(inner.attestationObject, 32768)
  ) {
    throw new PasskeyRegistrationError('invalid_response');
  }
  if (inner.transports !== undefined && !(Array.isArray(inner.transports) && inner.transports.length <= 32 && inner.transports.every((t) => typeof t === 'string'))) {
    throw new PasskeyRegistrationError('invalid_response');
  }
  return {
    id: response.id,
    rawId: response.rawId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: inner.clientDataJSON,
      attestationObject: inner.attestationObject,
      ...(inner.transports !== undefined ? { transports: inner.transports } : {}),
    },
  };
}

const AAGUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DEVICE_TYPES = ['singleDevice', 'multiDevice'];

// Turns the library's verified result into the exact record to store, re-validating every field
// (the library is trusted for the cryptography, not for our storage constraints). Anything
// unexpected is a generic failure.
function buildCredentialRecord(verification, response) {
  const bad = () => new PasskeyRegistrationError('invalid_credential_data');
  const info = verification?.registrationInfo;
  if (verification?.verified !== true || !info || typeof info !== 'object') throw bad();
  const { credential } = info;
  if (!credential || typeof credential !== 'object') throw bad();
  if (info.credentialType !== 'public-key' || info.userVerified !== true) throw bad();

  // The credential ID that was actually registered (from the authenticator data) must be the one
  // the browser claims, in both fields.
  let credentialId;
  let credentialIdHash;
  try {
    credentialId = decodeCredentialId(credential.id);
    credentialIdHash = hashCredentialId(credentialId);
  } catch {
    throw bad();
  }
  if (credential.id !== response.id || credential.id !== response.rawId) throw bad();

  const publicKey = credential.publicKey;
  if (!(publicKey instanceof Uint8Array) || publicKey.length < 16 || publicKey.length > 2048) throw bad();
  try {
    const algorithm = decodeCredentialPublicKey(publicKey).get(cose.COSEKEYS.alg);
    if (!ADMIN_WEBAUTHN_ALGORITHMS.includes(algorithm)) throw bad();
  } catch {
    throw bad();
  }

  const signCount = credential.counter;
  if (!Number.isInteger(signCount) || signCount < 0 || signCount > UINT32_MAX) throw bad();

  if (typeof info.aaguid !== 'string' || !AAGUID_PATTERN.test(info.aaguid)) throw bad();
  if (!DEVICE_TYPES.includes(info.credentialDeviceType) || typeof info.credentialBackedUp !== 'boolean') throw bad();
  if (info.credentialDeviceType === 'singleDevice' && info.credentialBackedUp) throw bad();

  let transports;
  try {
    transports = normalizeTransports(credential.transports);
  } catch {
    throw bad();
  }

  return {
    credentialId: Buffer.from(credentialId),
    credentialIdHash,
    publicKey: Buffer.from(publicKey),
    signCount,
    transports,
    aaguid: info.aaguid,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
  };
}

// Best-effort record of a refused registration: reason code and Admin id only. A failure to
// write it never changes the outcome - the registration stays refused.
async function auditRefusal(db, claims, reason, ipAddress) {
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: claims.adminId,
      event: 'admin_passkey_registration_failed',
      ipAddress,
      detail: { reason },
      db,
    });
  } catch (err) {
    console.error(`Could not record refused passkey registration (${err.code || err.name}).`);
  }
}

// Verifies the authenticator's response to the options from generateAdminPasskeyRegistrationOptions
// and, if valid, stores the credential and activates the Admin - or refuses with the generic error.
// Returns { status: 'active', nextStep: 'sign_in' }: no token, cookie or session.
//
// Order matters:
//  1. validate configuration, ticket, response shape, and the account state (read-only);
//  2. consume the stored challenge - a standalone committed update, BEFORE verification, never
//     undone: a failed verification burns it, and the Admin must request fresh options;
//  3. verify the response (CPU-bound, outside any transaction);
//  4. in one transaction, re-validate the account under row locks, insert the passkey, flip the
//     Admin to "active" (exactly one row), and write the audit event.
// `db` must be a root Prisma client (it needs $transaction), not a transaction client.
async function verifyAdminPasskeyRegistration({ ticket, response, label, ipAddress = null, now = new Date(), db = prisma } = {}) {
  if (!db || typeof db.$transaction !== 'function') throw new TypeError('db must be a root Prisma client');
  const { rpId, origin } = assertWebAuthnConfig(loadAdminLockConfig());

  const claims = readAdminEnrollmentTicket(ticket);
  if (!claims) throw new PasskeyRegistrationError('invalid_ticket');

  let safeResponse;
  let safeLabel;
  try {
    safeResponse = sanitizeRegistrationResponse(response);
    safeLabel = normalizePasskeyLabel(label);
  } catch (err) {
    if (err instanceof PasskeyRegistrationError) throw err;
    throw new PasskeyRegistrationError('invalid_response');
  }

  // 1. Account state, read-only. (Repeated under locks in step 4.)
  let invitationId;
  try {
    ({ invitation: { id: invitationId } } = await loadEnrollmentContext(db, claims, { lock: false, now }));
  } catch (err) {
    if (err instanceof PasskeyRegistrationError) await auditRefusal(db, claims, err.reason, ipAddress);
    throw err;
  }

  // 2. Consume the challenge, committed on its own. Registration challenges are unbound to any
  // session; the exact invitation must match.
  const consumed = await consumeAdminWebAuthnChallenge({
    adminId: claims.adminId,
    purpose: 'registration',
    invitationId,
    sessionId: null,
    now,
    db,
  });
  if (!consumed) {
    await auditRefusal(db, claims, 'challenge_unavailable', ipAddress);
    throw new PasskeyRegistrationError('challenge_unavailable');
  }

  // 3. Cryptographic verification against the stored challenge and the configured RP and origin.
  let record;
  try {
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: safeResponse,
        expectedChallenge: consumed.challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        expectedType: ADMIN_REGISTRATION_SETTINGS.expectedType,
        requireUserPresence: ADMIN_REGISTRATION_SETTINGS.requireUserPresence,
        requireUserVerification: ADMIN_REGISTRATION_SETTINGS.requireUserVerification,
        supportedAlgorithmIDs: [...ADMIN_WEBAUTHN_ALGORITHMS],
      });
    } catch {
      throw new PasskeyRegistrationError('verification_failed');
    }
    record = buildCredentialRecord(verification, safeResponse);
  } catch (err) {
    if (err instanceof PasskeyRegistrationError) await auditRefusal(db, claims, err.reason, ipAddress);
    throw err;
  }

  // 4. Store and activate, atomically.
  try {
    await db.$transaction(async (tx) => {
      const { admin, invitation } = await loadEnrollmentContext(tx, claims, { lock: true, now });

      const passkey = await tx.adminPasskey.create({
        data: {
          adminId: admin.id,
          credentialIdHash: record.credentialIdHash,
          credentialId: record.credentialId,
          publicKey: record.publicKey,
          signCount: record.signCount,
          transports: record.transports,
          aaguid: record.aaguid,
          deviceType: record.deviceType,
          backedUp: record.backedUp,
          label: safeLabel,
        },
      });

      const activated = await tx.adminUser.updateMany({
        where: { id: admin.id, status: 'pending_passkey', passwordChangedAt: admin.passwordChangedAt },
        data: { status: 'active' },
      });
      if (activated.count !== 1) throw new PasskeyRegistrationError('state_changed');

      await recordAdminAuditEvent({
        actorType: 'admin',
        actorId: admin.id,
        event: 'admin_passkey_registered',
        identifier: maskEmail(admin.email),
        ipAddress,
        detail: {
          passkeyId: passkey.id,
          invitationId: invitation.id,
          deviceType: record.deviceType,
          backedUp: record.backedUp,
          credentialCount: 1,
        },
        db: tx,
      });
    });
  } catch (err) {
    // A credential already registered (to anyone) is one more generic refusal.
    if (err?.code === 'P2002') {
      await auditRefusal(db, claims, 'duplicate_credential', ipAddress);
      throw new PasskeyRegistrationError('duplicate_credential');
    }
    if (err instanceof PasskeyRegistrationError) await auditRefusal(db, claims, err.reason, ipAddress);
    throw err; // database or audit failures surface as they are; nothing was committed
  }

  return { status: 'active', nextStep: 'sign_in' };
}

// sanitizeRegistrationResponse and buildCredentialRecord are shared with the passkey-recovery registration.
module.exports = {
  generateAdminPasskeyRegistrationOptions,
  verifyAdminPasskeyRegistration,
  sanitizeRegistrationResponse,
  buildCredentialRecord,
  PasskeyRegistrationError,
};
