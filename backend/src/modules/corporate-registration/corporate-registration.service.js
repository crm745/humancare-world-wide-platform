const crypto = require('crypto');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { prisma } = require('../../db/prisma');
const { sendMail } = require('../../lib/mailer');
const { normalizeEmail, maskMobile } = require('../../lib/phone');
const { consumePhoneProof, PURPOSES } = require('./phone-proof');
const { emailHash } = require('./registration-proof');

const EMAIL_VERIFY_TTL_HOURS = 24;
const RESEND_COOLDOWN_SECONDS = 45; // matches the corporate-portal's own countdown UI
const MAX_REGISTRATIONS_PER_MOBILE_PER_DAY = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Errors the global handler turns into a response: `statusCode` for the status, and
// `publicCode` (when set) as a machine-readable `code` the portal can branch on.
function httpError(statusCode, message, publicCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

// Full account number is kept in the DB (Finance needs it to actually pay the
// corporate later) but is never sent back to the unauthenticated registrant — only
// the admin-facing view of a superadmin gets the unmasked version. Mirrors the
// corporate-portal's own maskBank() so the shape the registrant sees is unchanged.
function maskBank(bank) {
  const domestic = bank.bankType === 'Domestic';
  const last4 = (v) => (v ? String(v).slice(-4) : '');
  return {
    bankType: bank.bankType,
    bankName: bank.bankName,
    accountHolder: bank.accountHolder,
    accountLast4: last4(bank.accountNumber),
    ...(domestic
      ? { ifsc: bank.ifsc, branchName: bank.branchName, branchAddress: bank.branchAddress }
      : { swift: bank.swift, ibanLast4: last4(bank.iban), bankCountry: bank.bankCountry, bankAddress: bank.bankAddress, currency: bank.currency }),
  };
}

function deriveStatus(reg) {
  if (reg.credentialsCreated) return 'Active';
  if (reg.rejectedAt) return 'Rejected';
  if (reg.approved && reg.emailVerified) return 'Verified';
  return 'Pending Verification';
}

// ---- phone numbers typed into the form (never trusted; only compared) --------------------

// E.164 for a number typed in the form, or null. A number without "+" is read in the
// company's own country (an ISO code like "IN").
function normalizeFormPhone(raw, country) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const region = /^[A-Za-z]{2}$/.test(String(country || '')) ? String(country).toUpperCase() : undefined;
  const parsed = text.startsWith('+')
    ? parsePhoneNumberFromString(text)
    : region ? parsePhoneNumberFromString(text, region) : null;
  return parsed && parsed.isValid() ? parsed.number : null;
}

// "98765 43210" -> "•••••3210": enough to recognise, not enough to use.
function maskTypedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••••${digits.slice(-4)}` : '';
}

// ---- contact-email review (registrations made before mobile verification existed) -------

const submittedEmailOf = (reg) => normalizeEmail(reg.company?.officialEmail);
const emailChangedSinceSubmission = (reg) => !!submittedEmailOf(reg) && normalizeEmail(reg.email) !== submittedEmailOf(reg);

// True while a registration without a verified mobile has an email different from the one
// submitted and no Admin has reviewed that yet. Such a registration cannot be sent the
// automatic mobile link: its email can't be trusted until an Admin decides.
function needsEmailReview(reg) {
  return !reg.mobileVerifiedAt && emailChangedSinceSubmission(reg) && !reg.emailReviewedAt;
}

const isLocked = (reg) => !!reg.rejectedAt || reg.credentialsCreated;

// ---- response shapes ---------------------------------------------------------------------

// Shape returned to the (not-yet-logged-in) registrant via /corporates/* — bank is masked,
// typed phone numbers are masked, the registered mobile is only ever shown masked, and no
// internal ids or file paths leak out.
function toPublicRegistration(reg) {
  const docs = Array.isArray(reg.documents) ? reg.documents : [];
  return {
    id: reg.id,
    corporateId: reg.corporateRefId,
    company: { ...reg.company, officialPhone: maskTypedPhone(reg.company?.officialPhone), contactPhone: maskTypedPhone(reg.company?.contactPhone) },
    bank: maskBank(reg.bank),
    documents: docs.map(({ fileUrl: _path, ...doc }) => doc),
    email: reg.email,
    emailVerified: reg.emailVerified,
    approved: reg.approved,
    credentialsCreated: reg.credentialsCreated,
    mobileMasked: reg.mobileE164 ? maskMobile(reg.mobileE164) : null,
    mobileVerified: !!reg.mobileVerifiedAt,
    submittedAt: reg.submittedAt,
    status: deriveStatus(reg),
  };
}

// Shape returned to an Admin. Bank details are unmasked only for a superadmin; other
// reviewers get the masked form, and the bank-proof document (which shows the full
// account number) is marked restricted for them. File paths never leave the server.
function toAdminRegistration(reg, { viewerIsSuperadmin = false } = {}) {
  const docs = Array.isArray(reg.documents) ? reg.documents : [];
  return {
    id: reg.id,
    corporateId: reg.corporateRefId,
    company: reg.company,
    bank: viewerIsSuperadmin ? reg.bank : maskBank(reg.bank),
    bankMasked: !viewerIsSuperadmin,
    documents: docs.map(({ fileUrl: _path, ...doc }) => ({ ...doc, restricted: doc.key === 'bankProof' && !viewerIsSuperadmin })),
    email: reg.email,
    submittedEmail: submittedEmailOf(reg) || null,
    emailChangedSinceSubmission: emailChangedSinceSubmission(reg),
    needsEmailReview: needsEmailReview(reg),
    emailReviewedBy: reg.emailReviewedBy,
    emailReviewedAt: reg.emailReviewedAt,
    emailVerified: reg.emailVerified,
    mobile: reg.mobileE164,
    mobileVerified: !!reg.mobileVerifiedAt,
    mobileVerifiedAt: reg.mobileVerifiedAt,
    approved: reg.approved,
    approvedBy: reg.approvedBy,
    approvedAt: reg.approvedAt,
    rejectedAt: reg.rejectedAt,
    rejectedBy: reg.rejectedBy,
    rejectionReason: reg.rejectionReason,
    credentialsCreated: reg.credentialsCreated,
    corporateDbId: reg.corporateId,
    corporateUserId: reg.corporateUserId,
    provisionedBy: reg.provisionedBy,
    provisionedAt: reg.provisionedAt,
    submittedAt: reg.submittedAt,
    status: deriveStatus(reg),
  };
}

// ---- email ------------------------------------------------------------------------------

async function sendVerificationEmail(reg) {
  const portalUrl = process.env.CORPORATE_PORTAL_URL || 'http://localhost:5173';
  const link = `${portalUrl}/register/verify-email?token=${reg.emailVerifyToken}`;

  await sendMail({
    to: reg.email,
    subject: 'Verify your email — HumanCare corporate registration',
    text: `Confirm your email to continue your HumanCare corporate registration (Corporate ID ${reg.corporateRefId}): ${link}\nThis link expires in ${EMAIL_VERIFY_TTL_HOURS} hours.`,
    html: `<p>Confirm your email to continue your HumanCare corporate registration (Corporate ID <strong>${reg.corporateRefId}</strong>):</p><p><a href="${link}">${link}</a></p><p>This link expires in ${EMAIL_VERIFY_TTL_HOURS} hours.</p>`,
  });
}

function newVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

const verifyExpiry = () => new Date(Date.now() + EMAIL_VERIFY_TTL_HOURS * 60 * 60 * 1000);

// ---- registration -----------------------------------------------------------------------

// `proof` is the verified Firebase phone sign-in (req.phoneProof). The registration's mobile
// comes from it alone; the form's contact phone must be that same number.
async function createRegistration({ company, bank, documents }, proof) {
  const email = normalizeEmail(company.officialEmail);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid official email address.');

  const formPhone = normalizeFormPhone(company.contactPhone, company.country);
  if (!formPhone) {
    throw httpError(400, 'Enter a valid mobile number for the contact person (include the country code if your country is not listed).', 'contact_phone_invalid');
  }
  if (formPhone !== proof.phone) {
    throw httpError(400, 'The mobile number you verified is not the contact phone entered in the form.', 'phone_mismatch');
  }

  const recent = await prisma.corporateRegistration.count({
    where: { mobileE164: proof.phone, submittedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (recent >= MAX_REGISTRATIONS_PER_MOBILE_PER_DAY) {
    throw httpError(429, 'Too many registrations from this mobile number today. Please try again tomorrow or contact HumanCare.', 'too_many_registrations');
  }

  // The proof, the registration and its reference number are one unit: if any step fails the
  // proof is not spent and nothing is left half-created.
  const reg = await prisma.$transaction(async (tx) => {
    await consumePhoneProof(tx, proof, PURPOSES.REGISTER, null);
    const created = await tx.corporateRegistration.create({
      data: {
        corporateRefId: `TEMP-${crypto.randomBytes(8).toString('hex')}`,
        company,
        bank,
        documents,
        email,
        emailVerifyToken: newVerifyToken(),
        emailVerifyExpiresAt: verifyExpiry(),
        mobileE164: proof.phone,
        mobileVerifiedAt: new Date(),
      },
    });
    const updated = await tx.corporateRegistration.update({
      where: { id: created.id },
      data: { corporateRefId: `HCW-COR-${new Date().getFullYear()}-${String(10000 + created.id)}` },
    });
    await tx.phoneProof.update({ where: { proofKey: proof.key }, data: { registrationId: created.id } });
    return updated;
  });

  try {
    await sendVerificationEmail(reg);
  } catch (err) {
    // The registration is already saved — a flaky email send shouldn't lose the
    // submission. The registrant can hit "resend" once they're on the next screen.
    console.error(`Verification email failed to send for ${reg.corporateRefId}:`, err.message);
  }
  return reg;
}

async function getRegistrationOr404(id) {
  const reg = await prisma.corporateRegistration.findUnique({ where: { id: Number(id) } });
  if (!reg) throw httpError(404, 'Registration not found.');
  return reg;
}

// `reg` was loaded by requireRegistrationProof, so the caller already proved it.
async function resendVerificationEmail(reg) {
  if (isLocked(reg)) throw httpError(409, 'This registration can no longer be changed.', 'registration_locked');
  if (reg.emailVerified) return reg;
  if (reg.updatedAt > new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000)) {
    throw httpError(429, 'Please wait before requesting another email.');
  }
  const updated = await prisma.corporateRegistration.update({
    where: { id: reg.id },
    data: { emailVerifyToken: newVerifyToken(), emailVerifyExpiresAt: verifyExpiry() },
  });
  await sendVerificationEmail(updated);
  return updated;
}

// Email correction. Needs the registration proof (the caller) AND a fresh Firebase proof
// for the mobile the registration already has — the number can't be replaced here. It
// resets email verification and any approval (an Admin must approve again), and the
// compare-and-swap on the current email means two racing corrections can't both win.
async function changeRegistrationEmail(reg, rawEmail, proof) {
  if (isLocked(reg)) throw httpError(409, 'This registration can no longer be changed.', 'registration_locked');
  if (!reg.mobileE164) {
    throw httpError(409, 'This registration has no verified mobile number yet. Please contact HumanCare to complete mobile verification first.', 'mobile_not_verified');
  }
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address.');
  if (email === normalizeEmail(reg.email)) throw httpError(409, 'This is already your registered email.');
  if (proof.phone !== reg.mobileE164) {
    throw httpError(403, 'That is not the mobile number registered for this application.', 'phone_mismatch');
  }

  const previousEmail = reg.email;
  await prisma.$transaction(async (tx) => {
    await consumePhoneProof(tx, proof, PURPOSES.EMAIL_CHANGE, reg.id);
    const swap = await tx.corporateRegistration.updateMany({
      where: { id: reg.id, email: reg.email, rejectedAt: null, credentialsCreated: false },
      data: {
        email,
        emailVerified: false,
        emailVerifyToken: newVerifyToken(),
        emailVerifyExpiresAt: verifyExpiry(),
        // The email an Admin approved is gone, so the approval goes with it.
        approved: false,
        approvedBy: null,
        approvedAt: null,
      },
    });
    if (swap.count === 0) throw httpError(409, 'This registration was changed by someone else. Please reload and try again.', 'registration_changed');
  });

  const updated = await getRegistrationOr404(reg.id);
  await sendVerificationEmail(updated);
  // Tell the previous address, best effort: if it wasn't the applicant who asked, this is
  // how they find out.
  sendMail({
    to: previousEmail,
    subject: 'The email on your HumanCare corporate registration was changed',
    text: `The email address on corporate registration ${updated.corporateRefId} was changed. If this was not you, contact HumanCare immediately.`,
    html: `<p>The email address on corporate registration <strong>${updated.corporateRefId}</strong> was changed.</p><p>If this was not you, contact HumanCare immediately.</p>`,
  }).catch((err) => console.error(`Could not notify the previous email for ${updated.corporateRefId}:`, err.message));
  return updated;
}

// Called when the registrant clicks the link in their email.
async function verifyEmailToken(token) {
  const reg = await prisma.corporateRegistration.findUnique({ where: { emailVerifyToken: token } });
  if (!reg) throw httpError(404, 'This verification link is invalid or has already been used.');
  if (reg.emailVerifyExpiresAt && reg.emailVerifyExpiresAt < new Date()) {
    throw httpError(410, 'This verification link has expired — request a new one.');
  }
  return prisma.corporateRegistration.update({
    where: { id: reg.id },
    data: { emailVerified: true, emailVerifyToken: null, emailVerifyExpiresAt: null },
  });
}

// Registrations made before mobile verification existed: the applicant opens the link an
// Admin sent, and confirms with Firebase the contact mobile they originally entered. The
// verified number must be exactly that one; it is then fixed on the registration, once.
async function verifyLegacyMobile(linkPayload, proof) {
  const reg = await prisma.corporateRegistration.findUnique({ where: { id: linkPayload.rid } });
  if (!reg || linkPayload.eh !== emailHash(reg.email)) throw httpError(403, 'This link is no longer valid. Please ask HumanCare for a new one.', 'link_invalid');
  if (isLocked(reg)) throw httpError(409, 'This registration can no longer be changed.', 'registration_locked');
  if (reg.mobileE164) throw httpError(409, 'The mobile number for this registration is already verified.', 'mobile_already_verified');
  if (needsEmailReview(reg)) throw httpError(409, 'HumanCare needs to review your contact email first.', 'email_review_required');

  const expected = normalizeFormPhone(reg.company?.contactPhone, reg.company?.country);
  if (!expected) throw httpError(409, 'Your contact phone could not be read automatically. Please contact HumanCare.', 'phone_unparseable');
  if (proof.phone !== expected) throw httpError(403, 'That is not the contact mobile number on this application.', 'phone_mismatch');

  await prisma.$transaction(async (tx) => {
    await consumePhoneProof(tx, proof, PURPOSES.LEGACY_MOBILE, reg.id);
    const bind = await tx.corporateRegistration.updateMany({
      where: { id: reg.id, mobileE164: null, rejectedAt: null, credentialsCreated: false },
      data: { mobileE164: proof.phone, mobileVerifiedAt: new Date() },
    });
    if (bind.count === 0) throw httpError(409, 'This registration was changed by someone else. Please reload and try again.', 'registration_changed');
  });
  return getRegistrationOr404(reg.id);
}

module.exports = {
  httpError,
  EMAIL_RE,
  createRegistration,
  resendVerificationEmail,
  changeRegistrationEmail,
  verifyEmailToken,
  verifyLegacyMobile,
  sendVerificationEmail,
  newVerifyToken,
  verifyExpiry,
  getRegistrationOr404,
  toPublicRegistration,
  toAdminRegistration,
  deriveStatus,
  maskBank,
  normalizeFormPhone,
  needsEmailReview,
  isLocked,
};
