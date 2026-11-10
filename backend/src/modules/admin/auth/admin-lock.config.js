// Admin Lock configuration: fixed policy values plus the environment-driven WebAuthn
// settings. Nothing here has a hostname default - the Admin portal host is deployment-specific,
// so those settings must be supplied explicitly. Loading never throws; each feature validates
// what it needs (WebAuthn ceremony, invitation link, login enforcement) when it is used.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Approved policy values (milliseconds unless the name says otherwise).
const ADMIN_LOCK_POLICY = Object.freeze({
  loginChallengeTtlMs: 120 * SECOND,
  unlockChallengeTtlMs: 120 * SECOND,
  // WebAuthn registration challenge, and the ticket that lets a pending Admin start one.
  registrationChallengeTtlMs: 120 * SECOND,
  enrollmentTicketTtlMs: 10 * MINUTE,
  accessTokenTtlMs: 15 * MINUTE,
  invitationTtlMs: 72 * HOUR,
  recoveryInvitationTtlMs: 24 * HOUR,
  recoveryRequestTtlMs: 7 * DAY,
  // Passkey step-up of a recovery approver (approve or reject), and the ticket that lets the
  // Admin being recovered start their new passkey registration.
  recoveryStepUpChallengeTtlMs: 120 * SECOND,
  recoveryTicketTtlMs: 10 * MINUTE,
  failedLoginThreshold: 5,
  accountLockoutMs: 15 * MINUTE,
  refreshTokenReuseGraceMs: 10 * SECOND,
  // Dashboard sessions. Idle expiry ends the session (there is no unlock step yet).
  sessionIdleTimeoutMs: 30 * MINUTE,
  sessionAbsoluteLifetimeMs: 7 * DAY,
  maxConcurrentSessions: 2,
});

function readString(env, name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value) {
  // Enabled only on an explicit "true", like BITRIX_SYNC_ENABLED.
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function loadAdminLockConfig(env = process.env) {
  return {
    passkeyEnforcement: parseBoolean(env.ADMIN_PASSKEY_ENFORCEMENT),
    portalUrl: readString(env, 'ADMIN_PORTAL_URL'),
    webauthn: {
      rpId: readString(env, 'ADMIN_WEBAUTHN_RP_ID'),
      origin: readString(env, 'ADMIN_WEBAUTHN_ORIGIN'),
      rpName: readString(env, 'ADMIN_WEBAUTHN_RP_NAME'),
    },
    ...ADMIN_LOCK_POLICY,
  };
}

function checkUrl(name, value, { env, bareOrigin = false }) {
  const problems = [];
  const url = parseUrl(value);
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    return [`${name} must be an absolute http(s) URL`];
  }
  if (bareOrigin && url.origin !== value) {
    problems.push(`${name} must be a bare origin (scheme, host, optional port; no path or trailing slash)`);
  }
  if (env.NODE_ENV === 'production' && (url.protocol !== 'https:' || isLocalHost(url.hostname))) {
    problems.push(`${name} must be an https, non-localhost URL in production`);
  }
  return problems;
}

// Each validator returns a list of problems (variable names only - never values); empty =
// valid. They are independent of ADMIN_PASSKEY_ENFORCEMENT, which only controls whether
// login requires a passkey. Enrollment works with enforcement off.

// Needed whenever a WebAuthn registration or authentication ceremony is initiated.
function getWebAuthnConfigProblems(config, { env = process.env } = {}) {
  const { rpId, origin, rpName } = config.webauthn;
  const problems = [];
  if (!rpId) problems.push('ADMIN_WEBAUTHN_RP_ID is required');
  if (!origin) problems.push('ADMIN_WEBAUTHN_ORIGIN is required');
  if (!rpName) problems.push('ADMIN_WEBAUTHN_RP_NAME is required');

  if (origin) problems.push(...checkUrl('ADMIN_WEBAUTHN_ORIGIN', origin, { env, bareOrigin: true }));

  if (rpId) {
    if (/[/:@\s]/.test(rpId)) {
      problems.push('ADMIN_WEBAUTHN_RP_ID must be a bare domain (no scheme, port or path)');
    } else if (env.NODE_ENV === 'production' && isLocalHost(rpId)) {
      problems.push('ADMIN_WEBAUTHN_RP_ID must not be localhost in production');
    }
    const originUrl = origin ? parseUrl(origin) : null;
    if (originUrl && !(originUrl.hostname === rpId || originUrl.hostname.endsWith(`.${rpId}`))) {
      problems.push('ADMIN_WEBAUTHN_RP_ID must equal, or be a parent domain of, the ADMIN_WEBAUTHN_ORIGIN host');
    }
  }
  return problems;
}

// Needed whenever an invitation / recovery link is built.
function getPortalUrlConfigProblems(config, { env = process.env } = {}) {
  if (!config.portalUrl) return ['ADMIN_PORTAL_URL is required'];
  return checkUrl('ADMIN_PORTAL_URL', config.portalUrl, { env });
}

// Needed only for startup validation of login enforcement: enforcing passkeys is
// meaningless without a working WebAuthn configuration.
function getEnforcementConfigProblems(config, options) {
  return config.passkeyEnforcement ? getWebAuthnConfigProblems(config, options) : [];
}

function throwIfProblems(label, problems) {
  if (problems.length > 0) {
    throw new Error(`Invalid Admin Lock ${label} configuration: ${problems.join('; ')}`);
  }
}

function assertWebAuthnConfig(config, options) {
  throwIfProblems('WebAuthn', getWebAuthnConfigProblems(config, options));
  return config.webauthn;
}

function assertPortalUrlConfig(config, options) {
  throwIfProblems('portal URL', getPortalUrlConfigProblems(config, options));
  return config.portalUrl;
}

function assertEnforcementConfig(config, options) {
  throwIfProblems('enforcement', getEnforcementConfigProblems(config, options));
  return config;
}

module.exports = {
  ADMIN_LOCK_POLICY,
  loadAdminLockConfig,
  getWebAuthnConfigProblems,
  getPortalUrlConfigProblems,
  getEnforcementConfigProblems,
  assertWebAuthnConfig,
  assertPortalUrlConfig,
  assertEnforcementConfig,
};
