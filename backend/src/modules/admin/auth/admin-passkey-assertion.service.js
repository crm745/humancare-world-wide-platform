// The cryptographic half of a passkey assertion for an Admin, shared by every flow that needs one:
// the password + passkey sign-in (admin-login.service.js) and the recovery approvers' step-up.
// It proves "this Admin's own registered credential just signed THIS challenge, with the user
// present and verified" and nothing more:
//   - it creates no session, token, cookie or ticket and writes nothing except the best-effort
//     counter-regression audit row;
//   - it does not consume the challenge, update the stored signature counter, or decide what the
//     proof is worth. The caller consumes the challenge FIRST (so a failed assertion burns it),
//     passes the stored challenge string in, and - inside its own transaction, after re-validating
//     the account - advances the counter with advanceAdminPasskeyCounter.
//
// Checks, in this order (the reason is a short internal code for the caller's audit trail; no
// caller should reveal it to a client):
//   response shape and sizes            invalid_response
//   credential scoped to THIS Admin     unknown_credential   (another Admin's, unknown or revoked)
//   userHandle, when present            wrong_user_handle
//   signature counter                   counter_regression   (audited by name; the credential is
//                                                             deliberately NOT revoked)
//   the library: signature, challenge,
//     origin, RP ID, type, UP and UV    verification_failed
//   the result's own invariants         invalid_result
const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { isoBase64URL, parseAuthenticatorData } = require('@simplewebauthn/server/helpers');
const { prisma } = require('../../../db/prisma');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const {
  deriveAdminWebAuthnUserHandle,
  hashCredentialId,
  normalizeTransports,
} = require('./admin-webauthn.helpers');

const UINT32_MAX = 4294967295;

// Any refusal of the assertion itself. `reason` is internal; it is not enumerable, so it is never
// serialised.
class PasskeyAssertionError extends Error {
  constructor(reason = 'refused') {
    super('Passkey assertion refused');
    this.name = 'PasskeyAssertionError';
    this.code = 'invalid_assertion';
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
  }
}

const B64 = /^[A-Za-z0-9_-]+$/;
const isB64 = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && B64.test(v);

// Copies only the known fields of the browser's AuthenticationResponseJSON after checking their
// shape and size; everything else the browser sent is dropped. Safe to apply twice.
function sanitizeAdminAssertionResponse(response) {
  const inner = response && response.response;
  const handle = inner && inner.userHandle;
  if (
    !response || typeof response !== 'object' || !inner || typeof inner !== 'object'
    || !isB64(response.id, 2048) || !isB64(response.rawId, 2048) || response.type !== 'public-key'
    || !isB64(inner.clientDataJSON, 8192) || !isB64(inner.authenticatorData, 4096) || !isB64(inner.signature, 2048)
    || !(handle === undefined || handle === null || handle === '' || isB64(handle, 512))
  ) {
    throw new PasskeyAssertionError('invalid_response');
  }
  return {
    id: response.id,
    rawId: response.rawId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: inner.clientDataJSON,
      authenticatorData: inner.authenticatorData,
      signature: inner.signature,
      ...(handle ? { userHandle: handle } : {}),
    },
  };
}

// A non-zero counter that did not increase: audited by name (ids and the two numbers only - no
// credential material). Best-effort: nothing is enforced from this row.
async function recordCounterRegression(db, adminId, passkey, reported, ipAddress) {
  try {
    await recordAdminAuditEvent({
      actorType: 'admin',
      actorId: adminId,
      event: 'admin_passkey_counter_regression',
      ipAddress,
      detail: { passkeyId: passkey.id, storedCount: passkey.signCount, reportedCount: reported },
      db,
    });
  } catch (err) {
    console.error(`Could not record a passkey counter regression (${err.code || err.name}).`);
  }
}

// Verifies `response` for `adminId` against `expectedChallenge` (the string stored with the
// challenge row the caller just consumed). `rpId` and `origin` come from validated configuration.
// Returns { passkey, newCounter } - the stored credential row (as read) and the counter to store.
// Throws PasskeyAssertionError for a refused assertion; any other error (a database failure while
// looking the credential up) is passed on unchanged for the caller to treat as it sees fit.
async function verifyAdminPasskeyAssertion({
  adminId, response, expectedChallenge, rpId, origin, ipAddress = null, db = prisma,
} = {}) {
  const safeResponse = sanitizeAdminAssertionResponse(response);

  // Scoped to THIS Admin: another Admin's credential is simply not found.
  const credentialIdHash = hashCredentialId(safeResponse.id);
  const passkey = await db.adminPasskey.findFirst({ where: { adminId, credentialIdHash, revokedAt: null } });
  if (!passkey) throw new PasskeyAssertionError('unknown_credential');

  const expectedHandle = isoBase64URL.fromBuffer(deriveAdminWebAuthnUserHandle(adminId));
  if (safeResponse.response.userHandle && safeResponse.response.userHandle !== expectedHandle) {
    throw new PasskeyAssertionError('wrong_user_handle');
  }

  // Counter: zero on both sides is normal (synced passkeys); otherwise it must strictly increase.
  // Checked here as well as inside the library so a regression can be audited by name.
  const reported = parseAuthenticatorData(isoBase64URL.toBuffer(safeResponse.response.authenticatorData)).counter;
  if ((reported > 0 || passkey.signCount > 0) && reported <= passkey.signCount) {
    await recordCounterRegression(db, adminId, passkey, reported, ipAddress);
    throw new PasskeyAssertionError('counter_regression');
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: safeResponse,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      expectedType: 'webauthn.get',
      requireUserVerification: true,
      credential: {
        id: isoBase64URL.fromBuffer(passkey.credentialId),
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.signCount,
        transports: normalizeTransports(passkey.transports),
      },
    });
  } catch {
    throw new PasskeyAssertionError('verification_failed');
  }

  const info = verification && verification.authenticationInfo;
  const newCounter = info && info.newCounter;
  if (
    !verification || verification.verified !== true || !info || info.userVerified !== true
    || !Number.isInteger(newCounter) || newCounter < 0 || newCounter > UINT32_MAX
    || info.credentialID !== isoBase64URL.fromBuffer(passkey.credentialId)
  ) {
    throw new PasskeyAssertionError('invalid_result');
  }
  return { passkey, newCounter };
}

// Stores the new counter and last-used time, but only if the credential is still live and still
// holds the value that was verified against - so two assertions racing on one credential cannot
// both advance it. Call inside the caller's transaction. Returns true if this call advanced it.
async function advanceAdminPasskeyCounter(tx, { adminId, passkey, newCounter, now }) {
  const advanced = await tx.adminPasskey.updateMany({
    where: { id: passkey.id, adminId, revokedAt: null, signCount: passkey.signCount },
    data: { signCount: newCounter, lastUsedAt: now },
  });
  return advanced.count === 1;
}

module.exports = {
  verifyAdminPasskeyAssertion,
  advanceAdminPasskeyCounter,
  sanitizeAdminAssertionResponse,
  PasskeyAssertionError,
};
