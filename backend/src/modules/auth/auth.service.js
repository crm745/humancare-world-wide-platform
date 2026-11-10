const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const appleSignin = require('apple-signin-auth');
const { prisma } = require('../../db/prisma');
const { deliverOtp } = require('./otp-delivery.service');

const googleClient = new OAuth2Client();

const OTP_TTL_MINUTES = 5;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_VERIFY_ATTEMPTS = 5;
// Per destination (a phone or inbox), across every purpose — the per-IP limiter alone
// wouldn't stop someone spraying one victim's phone from many IPs.
const MAX_SENDS_PER_DESTINATION = 5;
const SEND_WINDOW_MINUTES = 15;

function generateOtp() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

async function issueOtp(identifier, purpose) {
  const lastCode = await prisma.otpCode.findFirst({
    where: { identifier, purpose },
    orderBy: { createdAt: 'desc' },
  });

  if (lastCode) {
    const secondsSinceLast = (Date.now() - lastCode.createdAt.getTime()) / 1000;
    if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
      const secondsLeft = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast);
      return { throttled: true, secondsLeft };
    }
  }

  const windowStart = new Date(Date.now() - SEND_WINDOW_MINUTES * 60 * 1000);
  const recentSends = await prisma.otpCode.findMany({
    where: { identifier, createdAt: { gte: windowStart } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (recentSends.length >= MAX_SENDS_PER_DESTINATION) {
    const freesAt = recentSends[0].createdAt.getTime() + SEND_WINDOW_MINUTES * 60 * 1000;
    return { throttled: true, secondsLeft: Math.max(Math.ceil((freesAt - Date.now()) / 1000), 1) };
  }

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  // A resend replaces the previous code — otherwise an older, still-unexpired code
  // would become valid again the moment the newer one is used up.
  await prisma.otpCode.updateMany({
    where: { identifier, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.otpCode.create({
    data: { identifier, codeHash, purpose, expiresAt },
  });

  await deliverOtp(identifier, code, purpose);
  return { throttled: false, expiresAt };
}
const TOO_MANY = 'Too many incorrect attempts. Please request a new code.';

// `code` on a failure lets the app show the right inline message; `reason` stays the
// human-readable text the corporate portal already displays as-is.
async function verifyOtp(identifier, purpose, code) {
  const record = await prisma.otpCode.findFirst({
    where: { identifier, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return { ok: false, code: 'otp_missing', reason: 'No pending code for this identifier.' };
  if (record.expiresAt < new Date()) return { ok: false, code: 'otp_expired', reason: 'Code expired.' };

  // Claim the attempt before comparing, in one conditional write, so parallel guesses
  // can't each read "4 attempts used" and slip past the cap together.
  const claimed = await prisma.otpCode.updateMany({
    where: { id: record.id, consumedAt: null, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { ok: false, code: 'otp_locked', reason: TOO_MANY };

  const matches = await bcrypt.compare(String(code ?? ''), record.codeHash);
  if (!matches) {
    const attemptsLeft = MAX_VERIFY_ATTEMPTS - (record.attempts + 1);
    return attemptsLeft > 0
      ? { ok: false, code: 'otp_invalid', reason: 'Incorrect code.', attemptsLeft }
      : { ok: false, code: 'otp_locked', reason: TOO_MANY };
  }

  // Conditional again: two requests with the right code must not both succeed.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) return { ok: false, code: 'otp_missing', reason: 'No pending code for this identifier.' };
  return { ok: true };
}

function signAccessToken(payload) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
  return jwt.sign(payload, secret, { expiresIn: '15m' });
}

function signRefreshToken(payload) {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not set');
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

function verifyRefreshToken(token) {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error('JWT_REFRESH_SECRET is not set');
  return jwt.verify(token, secret);
}

// `tv` ties the session to the account's current tokenVersion; /auth/refresh refuses
// a refresh token whose tv is behind (i.e. issued before a password reset).
function issuePatientTokens(user) {
  const claims = { sub: user.id, role: 'patient', tv: user.tokenVersion };
  return { token: signAccessToken(claims), refreshToken: signRefreshToken(claims) };
}

// A ticket is short-lived proof that an earlier step of a multi-step flow passed
// (password checked, OTP sent) and which step it unlocks next, so the OTP endpoint
// can't be reached for an account without first getting past the password. It is
// signed with a key derived from the access secret, never the secret itself, so a
// ticket can never be passed off as an access token.
const TICKET_TTL = '15m';
const TICKET_AUDIENCE = 'humancare-auth-ticket';

function ticketKey() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(TICKET_AUDIENCE).digest();
}

function signTicket(payload) {
  return jwt.sign(payload, ticketKey(), { expiresIn: TICKET_TTL, audience: TICKET_AUDIENCE });
}

// The payload if the ticket is valid and for one of `steps`, else null.
function readTicket(ticket, steps) {
  try {
    const payload = jwt.verify(String(ticket || ''), ticketKey(), { audience: TICKET_AUDIENCE });
    return [].concat(steps).includes(payload.step) ? payload : null;
  } catch {
    return null;
  }
}

// Same rule the app shows under the field. bcrypt only reads the first 72 bytes, so
// anything longer would quietly accept a different password with the same prefix.
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 characters.';
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Password must include at least one letter and one number.';
  return null;
}

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(String(plain ?? ''), hash);
}

// Compared against when no account matches, so "no such account" takes as long as
// "wrong password" and response time doesn't reveal which emails/mobiles exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('no-account-placeholder', BCRYPT_ROUNDS);

// Verifies a Google ID token against whichever of our client IDs (iOS/Android/Web) is set,
// and pulls out the bits we need to identify the person.
async function verifyGoogleIdToken(idToken) {
  const audience = [
    process.env.GOOGLE_CLIENT_ID_IOS,
    process.env.GOOGLE_CLIENT_ID_ANDROID,
    process.env.GOOGLE_CLIENT_ID_WEB,
  ].filter(Boolean);
  if (!audience.length) throw new Error('No GOOGLE_CLIENT_ID_* is set');

  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  return { providerId: payload.sub, email: payload.email, name: payload.name, emailVerified: payload.email_verified === true };
}

// Verifies an Apple identity token. Apple only sends the person's name on their very first
// sign-in (in the client SDK response, not the token) — the caller passes it through if present.
async function verifyAppleIdToken(idToken) {
  const audience = process.env.APPLE_CLIENT_ID;
  if (!audience) throw new Error('APPLE_CLIENT_ID is not set');

  const payload = await appleSignin.verifyIdToken(idToken, { audience });
  // Apple sends email_verified as a boolean or the string "true" depending on the flow.
  return { providerId: payload.sub, email: payload.email, emailVerified: String(payload.email_verified) === 'true' };
}

// Shared by the Google and Apple login controllers. Google/Apple only LOG IN to an
// account that already exists — matched by provider id, or by email the first time
// (which then links the provider to it). They never create one here: someone new gets a
// sign-up ticket instead and finishes in socialRegister (mobile + OTP + consents).
//
// Linking by email needs BOTH sides to have verified that email; otherwise whoever
// registered the address first (possibly not its owner) would share an account with
// the real owner. Unverified (half-finished) sign-ups never count as an account.
class SocialEmailInUseError extends Error {}
class SocialNoAccountError extends Error {}
async function findSocialUser({ provider, providerId, email, emailVerified }) {
  const idField = provider === 'google' ? 'googleId' : 'appleId';

  const existing = await prisma.user.findFirst({ where: { [idField]: providerId, isVerified: true } });
  if (existing) return existing;

  const byEmail = email ? await prisma.user.findFirst({ where: { email, isVerified: true } }) : null;
  if (!byEmail) throw new SocialNoAccountError();
  if (!byEmail.emailVerifiedAt || !emailVerified) throw new SocialEmailInUseError();
  return prisma.user.update({ where: { id: byEmail.id }, data: { [idField]: providerId } });
}

module.exports = {
  issueOtp,
  verifyOtp,
  issuePatientTokens,
  signTicket,
  readTicket,
  passwordProblem,
  DUMMY_PASSWORD_HASH,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  findSocialUser,
  SocialEmailInUseError,
  SocialNoAccountError,
};
