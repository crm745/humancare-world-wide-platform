// What an authorised Admin does with a corporate registration: list and view it, approve or
// reject it, provision the initial Owner, send the mobile-verification link to an older
// registration, and decide what to do about a contact email that changed after submission.
// Who may call these is decided by requireCorporateReviewer (admin/corporate-reviewer.js);
// the callers pass the verified Admin as `admin` ({ id, role }) so every change is
// attributed to an individual account.
const { prisma } = require('../../db/prisma');
const { sendMail } = require('../../lib/mailer');
const { normalizeEmail, maskEmail } = require('../../lib/phone');
const { randomPassword } = require('../../lib/random-password');
const { hashPassword, passwordProblem } = require('../auth/auth.service');
const { signMobileLink } = require('./registration-proof');
const {
  httpError,
  EMAIL_RE,
  getRegistrationOr404,
  toAdminRegistration,
  normalizeFormPhone,
  needsEmailReview,
  isLocked,
  sendVerificationEmail,
  newVerifyToken,
  verifyExpiry,
} = require('./corporate-registration.service');

const MOBILE_LINK_COOLDOWN_SECONDS = 60;
const isSuperadmin = (admin) => admin.role === 'superadmin';
const view = (reg, admin) => toAdminRegistration(reg, { viewerIsSuperadmin: isSuperadmin(admin) });

async function listPendingRegistrations(admin) {
  const regs = await prisma.corporateRegistration.findMany({
    where: { credentialsCreated: false, rejectedAt: null },
    orderBy: { submittedAt: 'asc' },
  });
  return regs.map((reg) => view(reg, admin));
}

async function getRegistrationForAdmin(id, admin) {
  return view(await getRegistrationOr404(id), admin);
}

// Approval needs both identity checks done first: the applicant's email and mobile.
async function approveRegistration(id, admin) {
  const reg = await getRegistrationOr404(id);
  if (reg.rejectedAt) throw httpError(409, 'This registration was already rejected.', 'registration_rejected');
  if (reg.credentialsCreated) throw httpError(409, 'This registration has already been provisioned.', 'registration_provisioned');
  if (!reg.emailVerified) throw httpError(409, 'The applicant has not verified their email yet.', 'email_not_verified');
  if (!reg.mobileVerifiedAt) throw httpError(409, 'The applicant has not verified their mobile number yet.', 'mobile_not_verified');
  if (reg.approved) return view(reg, admin);

  const done = await prisma.corporateRegistration.updateMany({
    where: { id: reg.id, rejectedAt: null, credentialsCreated: false, emailVerified: true, mobileVerifiedAt: { not: null } },
    data: { approved: true, approvedBy: admin.id, approvedAt: new Date() },
  });
  if (done.count === 0) throw httpError(409, 'This registration changed while you were approving it. Please reload.', 'registration_changed');
  return view(await getRegistrationOr404(id), admin);
}

async function rejectRegistration(id, admin, reason) {
  // Checked before anything is read or written: a rejection without a stated reason is not valid.
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (!cleanReason) throw httpError(400, 'A reason is required to reject a registration.', 'rejection_reason_required');

  const reg = await getRegistrationOr404(id);
  if (reg.credentialsCreated) {
    throw httpError(409, 'This registration has already been provisioned and cannot be rejected.', 'registration_provisioned');
  }
  const updated = await prisma.corporateRegistration.update({
    where: { id: reg.id },
    data: { approved: false, rejectedAt: reg.rejectedAt || new Date(), rejectedBy: reg.rejectedBy ?? admin.id, rejectionReason: cleanReason },
  });
  return view(updated, admin);
}

// A password that satisfies the shared policy; the random one can occasionally lack a digit.
function generateTemporaryPassword() {
  for (let i = 0; i < 50; i += 1) {
    const candidate = randomPassword(16);
    if (!passwordProblem(candidate)) return candidate;
  }
  throw new Error('Could not generate a temporary password');
}

// Creates the company and its initial Owner login from an approved registration. This is
// the ONLY way a registration becomes an account, and it works once: the first statement
// claims the registration atomically, the rest happen in the same transaction, and a
// conflict (e.g. a login with that email already exists) rolls the whole thing back.
// The temporary password is returned to the Admin once and is never stored or logged in
// clear; the Owner must change it at first login (mustChangePassword).
async function provisionOwner(id, admin) {
  const reg = await getRegistrationOr404(id);
  if (reg.rejectedAt) throw httpError(409, 'This registration was rejected.', 'registration_rejected');
  if (reg.credentialsCreated) throw httpError(409, 'This registration has already been provisioned.', 'registration_provisioned');
  if (!reg.approved) throw httpError(409, 'Approve the registration before provisioning the Owner.', 'not_approved');
  if (!reg.emailVerified) throw httpError(409, 'The applicant has not verified their email yet.', 'email_not_verified');
  if (!reg.mobileVerifiedAt) {
    throw httpError(409, 'The applicant has not verified their mobile number yet. Send them the mobile verification link first.', 'mobile_not_verified');
  }
  const c = reg.company || {};
  // The company type is required to create the company. Never guess it: stop before
  // anything is claimed or created, so the registration stays untouched.
  if (typeof c.companyType !== 'string' || !c.companyType.trim()) {
    throw httpError(409, 'This registration has no company type, so the company cannot be created. Please contact the developers; nothing was changed.', 'company_type_missing');
  }
  if (await prisma.corporateUser.findUnique({ where: { email: reg.email } })) {
    throw httpError(409, 'A login with that email already exists.', 'login_exists');
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.corporateRegistration.updateMany({
        where: { id: reg.id, approved: true, emailVerified: true, rejectedAt: null, credentialsCreated: false, mobileVerifiedAt: { not: null } },
        data: { credentialsCreated: true, provisionedBy: admin.id, provisionedAt: new Date() },
      });
      if (claim.count === 0) throw httpError(409, 'This registration is not ready to provision, or was provisioned just now.', 'not_provisionable');

      const corporate = await tx.corporate.create({
        data: {
          companyName: c.companyName,
          type: c.companyType,
          registrationNumber: c.registrationNumber || null,
          companyType: c.companyType,
          country: c.country || null,
          state: c.state || null,
          city: c.city || null,
          address: c.address || null,
          pincode: c.pincode || null,
          officialEmail: c.officialEmail || null,
          officialPhone: c.officialPhone || null,
          website: c.website || null,
          contactName: c.contactName || null,
          contactDesignation: c.contactDesignation || null,
          contactEmail: c.contactEmail || null,
          contactPhone: c.contactPhone || null,
        },
      });
      const owner = await tx.corporateUser.create({
        data: { corporateId: corporate.id, email: reg.email, passwordHash, mustChangePassword: true },
      });
      await tx.corporateRegistration.update({
        where: { id: reg.id },
        data: { corporateId: corporate.id, corporateUserId: owner.id },
      });
    });
  } catch (err) {
    if (err.code === 'P2002') throw httpError(409, 'A login with that email already exists.', 'login_exists');
    throw err;
  }

  return { registration: view(await getRegistrationOr404(id), admin), email: reg.email, temporaryPassword };
}

// For a registration made before mobile verification existed: emails the applicant a link
// (bound to the registration and its current email) to confirm their contact mobile with
// Firebase. Refused while the contact email looks changed and no Admin has reviewed it.
async function sendMobileVerificationLink(id, admin) {
  const reg = await getRegistrationOr404(id);
  if (isLocked(reg)) throw httpError(409, 'This registration can no longer be changed.', 'registration_locked');
  if (reg.mobileE164) throw httpError(409, 'The mobile number for this registration is already verified.', 'mobile_already_verified');
  if (needsEmailReview(reg)) {
    throw httpError(409, 'The contact email changed after submission. Review it before sending the link.', 'email_review_required');
  }
  if (!normalizeFormPhone(reg.company?.contactPhone, reg.company?.country)) {
    throw httpError(409, 'The contact phone on this registration cannot be read automatically, so it cannot be verified with a link.', 'phone_unparseable');
  }
  const recent = await prisma.securityEvent.findFirst({
    where: {
      event: 'registration_mobile_link_sent',
      identifier: `registration:${reg.id}`,
      createdAt: { gte: new Date(Date.now() - MOBILE_LINK_COOLDOWN_SECONDS * 1000) },
    },
  });
  if (recent) throw httpError(429, 'A link was just sent. Please wait a minute before sending another.', 'link_cooldown');

  const portalUrl = process.env.CORPORATE_PORTAL_URL || 'http://localhost:5173';
  const link = `${portalUrl}/register/verify-mobile?token=${signMobileLink(reg)}`;
  await sendMail({
    to: reg.email,
    subject: 'Verify your mobile number — HumanCare corporate registration',
    text: `To keep your HumanCare corporate registration (Corporate ID ${reg.corporateRefId}) moving, please confirm the contact mobile number you entered: ${link}\nThe link expires in 24 hours. You will receive an SMS code on the contact number from your application.`,
    html: `<p>To keep your HumanCare corporate registration (Corporate ID <strong>${reg.corporateRefId}</strong>) moving, please confirm the contact mobile number you entered:</p><p><a href="${link}">${link}</a></p><p>The link expires in 24 hours. You will receive an SMS code on the contact number from your application.</p>`,
  });
  return { sentTo: maskEmail(reg.email) };
}

// An Admin's decision about a registration whose contact email differs from the one
// submitted (possible before email corrections were protected). Nothing is rejected: they
// choose which email the applicant continues with, give a reason, and the applicant gets a
// fresh verification link there. Approval is cleared and the applicant still has to prove
// the originally entered mobile before anything can be approved or provisioned.
async function reviewContactEmail(id, admin, { action, email, reason }) {
  if (!['restore_original', 'keep_current', 'set_email'].includes(action)) {
    throw httpError(400, 'action must be restore_original, keep_current or set_email.');
  }
  if (!reason || String(reason).trim().length < 5) throw httpError(400, 'Give a reason (at least 5 characters) for this decision.');

  const reg = await getRegistrationOr404(id);
  if (isLocked(reg)) throw httpError(409, 'This registration can no longer be changed.', 'registration_locked');
  if (!needsEmailReview(reg)) throw httpError(409, 'This registration does not need a contact-email review.', 'email_review_not_needed');

  const target =
    action === 'restore_original' ? normalizeEmail(reg.company?.officialEmail)
    : action === 'keep_current' ? normalizeEmail(reg.email)
    : normalizeEmail(email);
  if (!EMAIL_RE.test(target)) throw httpError(400, 'A valid email address is required.');
  if (await prisma.corporateUser.findUnique({ where: { email: target } })) {
    throw httpError(409, 'A login with that email already exists.', 'login_exists');
  }

  const done = await prisma.corporateRegistration.updateMany({
    where: { id: reg.id, rejectedAt: null, credentialsCreated: false, mobileVerifiedAt: null, emailReviewedAt: null },
    data: {
      email: target,
      emailVerified: false,
      emailVerifyToken: newVerifyToken(),
      emailVerifyExpiresAt: verifyExpiry(),
      approved: false,
      approvedBy: null,
      approvedAt: null,
      emailReviewedBy: admin.id,
      emailReviewedAt: new Date(),
    },
  });
  if (done.count === 0) throw httpError(409, 'This registration changed while you were reviewing it. Please reload.', 'registration_changed');

  const updated = await getRegistrationOr404(id);
  try {
    await sendVerificationEmail(updated);
  } catch (err) {
    console.error(`Verification email failed after contact-email review for ${updated.corporateRefId}:`, err.message);
  }
  return view(updated, admin);
}

// The stored document for a download. The bank proof shows the full account number, so only
// a superadmin may open it — the same rule that masks the bank details in the JSON view.
async function getRegistrationDocument(id, key, admin) {
  const reg = await getRegistrationOr404(id);
  const docs = Array.isArray(reg.documents) ? reg.documents : [];
  const doc = docs.find((d) => d.key === key);
  if (!doc) throw httpError(404, 'Document not found');
  if (key === 'bankProof' && !isSuperadmin(admin)) {
    throw httpError(403, 'Only a superadmin can open the bank proof.', 'superadmin_required');
  }
  return doc;
}

module.exports = {
  listPendingRegistrations,
  getRegistrationForAdmin,
  approveRegistration,
  rejectRegistration,
  provisionOwner,
  sendMobileVerificationLink,
  reviewContactEmail,
  getRegistrationDocument,
};
