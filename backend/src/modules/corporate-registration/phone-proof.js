// Firebase phone proofs for the corporate registration flows.
//
// The applicant confirms an SMS code with Firebase in their browser; Firebase gives them
// a signed ID token, which they send in the `X-Firebase-Id-Token` header. The phone number
// we use is ONLY the one in that verified token — never one typed into a form. A token
// carries no purpose and no unique id, so single use is enforced here: each sign-in
// (Firebase uid + auth_time) may be consumed once, ever, by a ledger row with a UNIQUE key
// written in the same transaction as whatever the proof authorises. There is no bypass:
// if Firebase phone verification isn't configured, these flows are unavailable.
const crypto = require('crypto');
const { isFirebasePhoneEnabled, verifyPhoneProofDetails, PhoneProofError } = require('../../integrations/firebase/firebase');

const PURPOSES = {
  REGISTER: 'corporate_registration',
  EMAIL_CHANGE: 'corporate_registration_email_change',
  LEGACY_MOBILE: 'corporate_registration_legacy_mobile',
};

// Domain-separated hash of the sign-in. Case or token-refresh differences can't change it.
function proofKey(uid, authTime) {
  return crypto.createHash('sha256').update(`fbphone:v1:${uid}:${authTime}`).digest('hex');
}

// Verifies the header and puts { phone, uid, authTime, key } on req.phoneProof. Does NOT
// consume it — that happens inside the caller's transaction (consumePhoneProof).
async function requirePhoneProof(req, res, next) {
  if (!isFirebasePhoneEnabled()) {
    return res.status(503).json({
      error: 'Mobile verification is not available right now. Please try again later.',
      code: 'phone_verification_unavailable',
    });
  }
  try {
    const details = await verifyPhoneProofDetails(req.get('x-firebase-id-token'));
    req.phoneProof = { ...details, key: proofKey(details.uid, details.authTime) };
    next();
  } catch (err) {
    if (err instanceof PhoneProofError) return res.status(400).json({ error: err.message, code: err.code });
    next(err);
  }
}

// Marks the proof used. Call inside the same $transaction as the change it authorises: the
// UNIQUE proof_key makes a second use fail atomically, and if the transaction rolls back
// the proof is not spent (nothing it authorised happened).
async function consumePhoneProof(tx, proof, purpose, registrationId = null) {
  try {
    await tx.phoneProof.create({
      data: { proofKey: proof.key, purpose, phoneE164: proof.phone, registrationId },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      const e = new Error('That mobile verification has already been used. Please verify your mobile number again.');
      e.statusCode = 409;
      e.publicCode = 'proof_already_used';
      throw e;
    }
    throw err;
  }
}

module.exports = { requirePhoneProof, consumePhoneProof, proofKey, PURPOSES };
