// Registration-bound proofs for the public corporate-registration endpoints.
//
// A registrant has no account, so what lets them look at their own application, resend
// the verification email or correct the email is a signed token issued to them when they
// submit (and again after email verification or a correction). It is NOT a login token:
//   - signed with a key derived from JWT_ACCESS_SECRET with its own label, so the access-
//     token verifier rejects it, and this verifier rejects access/refresh/ticket tokens;
//   - its own audience, HS256 only;
//   - carries `rid` (registration id) and `eh` (hash of the email it was issued for) —
//     deliberately no `sub` and no `role`, so there is nothing for an auth check to match.
// Changing the registration's email changes `eh`, which kills every earlier proof at once.
// Every failure answers the same 403, whether the id exists or not.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../db/prisma');
const { normalizeEmail } = require('../../lib/phone');

const PROOF_AUDIENCE = 'humancare-corporate-registration';
const LINK_AUDIENCE = 'humancare-corporate-registration-mobile-link';
const PROOF_LIFETIME = '24h';
const LINK_LIFETIME = '24h';
const DENIED = { error: 'Registration access required.', code: 'registration_access_required' };

function keyFor(label) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(label).digest();
}

function emailHash(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function sign(audience, typ, registration, expiresIn) {
  return jwt.sign(
    { rid: registration.id, eh: emailHash(registration.email), typ },
    keyFor(audience),
    { algorithm: 'HS256', audience, expiresIn },
  );
}

// The payload if the token is valid for this audience and type, else null.
function read(token, audience, typ) {
  try {
    const payload = jwt.verify(String(token || ''), keyFor(audience), { algorithms: ['HS256'], audience });
    return payload.typ === typ && Number.isInteger(payload.rid) && typeof payload.eh === 'string' ? payload : null;
  } catch {
    return null;
  }
}

const signRegistrationProof = (registration) => sign(PROOF_AUDIENCE, 'reg_access', registration, PROOF_LIFETIME);
const readRegistrationProof = (token) => read(token, PROOF_AUDIENCE, 'reg_access');

// Emailed to an applicant by an Admin so a registration made before mobile verification
// existed can bind its mobile (see verifyLegacyMobile). Same binding to registration + email.
const signMobileLink = (registration) => sign(LINK_AUDIENCE, 'legacy_mobile', registration, LINK_LIFETIME);
const readMobileLink = (token) => read(token, LINK_AUDIENCE, 'legacy_mobile');

// Express middleware for /registrations/:id/*: the proof must be valid, for this id, and
// for the email the registration has right now.
async function requireRegistrationProof(req, res, next) {
  try {
    const payload = readRegistrationProof(req.get('x-registration-token'));
    if (!payload) return res.status(403).json(DENIED);
    const registration = await prisma.corporateRegistration.findUnique({ where: { id: payload.rid } });
    if (
      !registration ||
      String(registration.id) !== String(req.params.id) ||
      payload.eh !== emailHash(registration.email)
    ) {
      return res.status(403).json(DENIED);
    }
    req.registration = registration;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  signRegistrationProof,
  readRegistrationProof,
  signMobileLink,
  readMobileLink,
  requireRegistrationProof,
  emailHash,
};
