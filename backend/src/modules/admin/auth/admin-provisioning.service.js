// Operator-side Admin provisioning (used by scripts/admin-create.js; there is deliberately no
// HTTP route). Creates an invited Admin with no password, a hashed activation invitation, and
// the audit event in ONE transaction, then emails the invitation link after the commit.
//
// The raw invitation token exists only in memory in this function: it is hashed for storage and
// placed in the emailed link, and is never logged, returned, audited or put in a query string.
const crypto = require('crypto');
const os = require('os');
const { prisma } = require('../../../db/prisma');
const { sendMail } = require('../../../lib/mailer');
const { hashToken } = require('../../../common/utils/token-hash');
const { loadAdminLockConfig, assertPortalUrlConfig } = require('./admin-lock.config');
const { recordAdminAuditEvent } = require('./admin-audit.service');
const { ADMIN_ROLES } = require('./admin-token.service');

const MAX_EMAIL_LENGTH = 191; // AdminUser.email is a default-length VARCHAR
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

class ProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
  }
}

// The same normalisation used for storage and for the duplicate check.
function normalizeAdminEmail(value) {
  if (typeof value !== 'string') throw new ProvisioningError('invalid_email', 'Email is required.');
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new ProvisioningError('invalid_email', 'Email is not a valid address.');
  }
  return email;
}

function normalizeAdminName(value) {
  if (typeof value !== 'string') throw new ProvisioningError('invalid_name', 'Name is required.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) {
    throw new ProvisioningError('invalid_name', 'Name must be between 2 and 100 characters.');
  }
  if (/[\p{Cc}<>]/u.test(name)) {
    throw new ProvisioningError('invalid_name', 'Name must not contain control characters, "<" or ">".');
  }
  return name;
}

function validateAdminRole(value) {
  if (!ADMIN_ROLES.includes(value)) {
    throw new ProvisioningError('invalid_role', `Role must be one of: ${ADMIN_ROLES.join(', ')}.`);
  }
  return value;
}

// What the operator must type to create a superadmin.
function superadminConfirmationPhrase(email) {
  return `CREATE SUPERADMIN ${email}`;
}

// Non-secret facts about who ran the script, for the audit record.
function operatorIdentity() {
  let username = null;
  try { username = os.userInfo().username; } catch { /* no passwd entry; leave null */ }
  return { username, hostname: os.hostname() };
}

function buildInvitationUrl(portalUrl, token, path = '/accept-invite') {
  // Fragment, not query string: the fragment is never sent to a server or written to access logs.
  return `${portalUrl.replace(/\/+$/, '')}${path}#token=${token}`;
}

function invitationMessage({ to, name, role, url, expiresAt }) {
  const roleLabel = role === 'superadmin' ? 'a superadmin' : 'an admin';
  const expires = expiresAt.toUTCString();
  const text = [
    `Hello ${name},`,
    '',
    `You have been invited to join the HumanCare World Wide Admin portal as ${roleLabel}.`,
    'Open this link to set up your account:',
    url,
    '',
    `The link can be used once and expires on ${expires}.`,
    'If you were not expecting this invitation, ignore this email.',
  ].join('\n');
  const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<p>Hello ${escape(name)},</p>`
    + `<p>You have been invited to join the HumanCare World Wide Admin portal as ${roleLabel}.</p>`
    + `<p><a href="${escape(url)}">Set up your account</a></p>`
    + `<p>The link can be used once and expires on ${escape(expires)}.<br>If you were not expecting this invitation, ignore this email.</p>`;
  // sensitive: the console mail provider must never print this message's content.
  return { to, subject: 'Your HumanCare Admin portal invitation', text, html, sensitive: true };
}

function isEmailUniqueViolation(err) {
  if (err?.code !== 'P2002') return false;
  const target = err.meta?.target;
  return target === undefined || [].concat(target).some((t) => String(t).includes('email'));
}

// Returns { admin, invitation, emailDelivered, emailError }. Throws ProvisioningError for bad
// input, a duplicate email, or a missing superadmin confirmation; any other failure (database,
// audit) propagates and nothing has been committed.
async function provisionAdmin({ name, email, role, superadminConfirmation, now = new Date() } = {}) {
  const cleanName = normalizeAdminName(name);
  const cleanEmail = normalizeAdminEmail(email);
  const cleanRole = validateAdminRole(role);
  if (cleanRole === 'superadmin' && superadminConfirmation !== superadminConfirmationPhrase(cleanEmail)) {
    throw new ProvisioningError('superadmin_not_confirmed', 'Creating a superadmin requires the exact typed confirmation.');
  }

  // Fail before creating anything if the invitation link could not be built.
  const config = loadAdminLockConfig();
  assertPortalUrlConfig(config);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + config.invitationTtlMs);
  const operator = operatorIdentity();

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const admin = await tx.adminUser.create({
        data: {
          name: cleanName,
          email: cleanEmail,
          role: cleanRole,
          status: 'invited',
          passwordHash: null,
          failedLoginCount: 0,
        },
      });
      const invitation = await tx.adminInvitation.create({
        data: {
          adminId: admin.id,
          purpose: 'activation',
          tokenHash,
          sentToEmail: cleanEmail,
          expiresAt,
        },
      });
      await recordAdminAuditEvent({
        actorType: 'operator',
        event: 'admin_provisioned',
        identifier: cleanEmail,
        detail: {
          adminId: admin.id,
          role: cleanRole,
          invitationId: invitation.id,
          invitationExpiresAt: expiresAt.toISOString(),
          operator,
        },
        db: tx,
      });
      return { admin, invitation };
    });
  } catch (err) {
    // The database's unique index is the real guard against duplicates (and races).
    if (isEmailUniqueViolation(err)) {
      throw new ProvisioningError('duplicate_email', 'An admin with that email already exists.');
    }
    throw err;
  }

  const result = {
    admin: { id: created.admin.id, name: cleanName, email: cleanEmail, role: cleanRole, status: 'invited' },
    invitation: { id: created.invitation.id, expiresAt },
    emailDelivered: false,
    emailError: null,
  };

  // Committed. A failed email must not undo or hide the account.
  try {
    await sendMail(invitationMessage({
      to: cleanEmail,
      name: cleanName,
      role: cleanRole,
      url: buildInvitationUrl(config.portalUrl, token),
      expiresAt,
    }));
    result.emailDelivered = true;
  } catch (err) {
    result.emailError = String(err?.message || 'unknown error').slice(0, 200);
  }
  return result;
}

module.exports = {
  provisionAdmin,
  ProvisioningError,
  normalizeAdminEmail,
  normalizeAdminName,
  validateAdminRole,
  superadminConfirmationPhrase,
  buildInvitationUrl,
  invitationMessage,
  operatorIdentity,
};
