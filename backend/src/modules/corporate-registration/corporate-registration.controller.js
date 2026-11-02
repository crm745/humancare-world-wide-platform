const fs = require('fs');
const path = require('path');
const {
  createRegistration,
  resendVerificationEmail,
  changeRegistrationEmail,
  verifyEmailToken,
  verifyLegacyMobile,
  toPublicRegistration,
} = require('./corporate-registration.service');
const { signRegistrationProof, readMobileLink } = require('./registration-proof');
const { recordAuditEvent, ACTOR } = require('../../common/audit/audit-log');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');

// Keys the corporate-portal's DocumentsStep uploads under — see
// corporate-portal/src/data/constants.js#REGISTRATION_DOCUMENTS.
const DOCUMENT_KEYS = ['registration', 'tax', 'bankProof', 'pan', 'msme', 'other'];
const DOCUMENT_LABELS = {
  registration: 'Company Registration Certificate',
  tax: 'Tax / GST Certificate',
  bankProof: 'Bank Proof',
  pan: 'Company PAN',
  msme: 'MSME / Udyam Registration Certificate',
  other: 'Other Supporting Document',
};

// A registrant's response is the public view plus a fresh registration proof for the
// registration's current email (see registration-proof.js).
const withProof = (reg) => ({ ...toPublicRegistration(reg), accessToken: signRegistrationProof(reg) });
const audit = (req, event, reg, detail) =>
  recordAuditEvent(req, event, { actorType: ACTOR.REGISTRANT, actorId: reg.id, subject: `registration:${reg.id}`, detail });

// Files multer already wrote are useless if the submission is refused afterwards.
function discardUploads(files) {
  Object.values(files || {}).flat().forEach((file) => fs.unlink(path.join(UPLOAD_DIR, file.filename), () => {}));
}

// company/bank arrive as JSON-stringified form fields (multipart can't nest JSON
// directly); documents arrive as real files, one field per document key. By the time this
// runs, requirePhoneProof has verified the Firebase proof in req.phoneProof.
function postRegister(req, res, next) {
  (async () => {
    let company, bank;
    try {
      company = JSON.parse(req.body.company);
      bank = JSON.parse(req.body.bank);
    } catch {
      discardUploads(req.files);
      return res.status(400).json({ error: 'company and bank must be valid JSON.' });
    }
    if (!company?.companyName || !company?.officialEmail) {
      discardUploads(req.files);
      return res.status(400).json({ error: 'company is missing required fields.' });
    }

    const documents = DOCUMENT_KEYS.flatMap((key) => {
      const file = req.files?.[key]?.[0];
      if (!file) return [];
      return [{ key, label: DOCUMENT_LABELS[key], fileName: file.originalname, fileUrl: `/uploads/${file.filename}`, size: file.size, status: 'Uploaded' }];
    });

    let registration;
    try {
      registration = await createRegistration({ company, bank, documents }, req.phoneProof);
    } catch (err) {
      discardUploads(req.files);
      throw err;
    }
    audit(req, 'registration_submitted', registration);
    res.status(201).json(withProof(registration));
  })().catch(next);
}

// req.registration was loaded and checked by requireRegistrationProof.
function getRegistration(req, res) {
  res.json(toPublicRegistration(req.registration));
}

async function postResendVerification(req, res, next) {
  try {
    res.json(toPublicRegistration(await resendVerificationEmail(req.registration)));
  } catch (err) {
    next(err);
  }
}

// The registered mobile is fixed: any phone field in the body is refused outright rather
// than quietly ignored, so a client can never believe it changed the number.
const PHONE_FIELDS = ['mobile', 'phone', 'mobileE164', 'contactPhone', 'officialPhone', 'countryCode', 'phoneNumber'];

async function patchEmail(req, res, next) {
  try {
    if (PHONE_FIELDS.some((field) => field in (req.body || {}))) {
      return res.status(400).json({ error: 'The registered mobile number cannot be changed here.', code: 'phone_change_not_allowed' });
    }
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required.' });
    const wasApproved = req.registration.approved;
    const updated = await changeRegistrationEmail(req.registration, email, req.phoneProof);
    audit(req, 'registration_email_changed', updated, { approvalCleared: wasApproved });
    res.json(withProof(updated));
  } catch (err) {
    next(err);
  }
}

async function getVerifyEmail(req, res, next) {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token is required.' });
    const registration = await verifyEmailToken(token);
    audit(req, 'registration_email_verified', registration);
    res.json(withProof(registration));
  } catch (err) {
    next(err);
  }
}

// Older registrations (made before mobile verification): the link an Admin emailed plus a
// Firebase proof of the contact mobile.
async function postVerifyLegacyMobile(req, res, next) {
  try {
    const link = readMobileLink(req.body?.token);
    if (!link) {
      return res.status(403).json({ error: 'This link is no longer valid. Please ask HumanCare for a new one.', code: 'link_invalid' });
    }
    const registration = await verifyLegacyMobile(link, req.phoneProof);
    audit(req, 'registration_mobile_verified', registration, { via: 'legacy_link' });
    res.json(withProof(registration));
  } catch (err) {
    next(err);
  }
}

module.exports = { postRegister, getRegistration, postResendVerification, patchEmail, getVerifyEmail, postVerifyLegacyMobile, DOCUMENT_KEYS };
