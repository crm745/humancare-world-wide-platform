const disposableDomains = require("disposable-email-domains");
const { prisma } = require("../../db/prisma");
const { normalizeMobile, normalizeEmail, maskContact } = require("../../common/utils/phone");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  issueOtp,
  verifyOtp,
  issuePatientTokens,
  signTicket,
  readTicket,
  passwordProblem,
  DUMMY_PASSWORD_HASH,
  verifyGoogleIdToken,
  verifyAppleIdToken,
  findSocialUser,
  SocialEmailInUseError,
  SocialNoAccountError,
} = require("./auth.service");
const { EVENTS, recordSecurityEvent } = require("./security-events");
const { PASSWORD_CHANGE_REQUIRED } = require("../../common/constants/auth.constants");
const { isFirebasePhoneEnabled, verifyPhoneProof } = require("../../integrations/firebase/firebase");
const { readNameFields } = require("../../common/utils/person-name");
const { readProfileFields, callingCodeFor, resolvePhoneCountry } = require("../../common/utils/signup-profile");

const disposableDomainSet = new Set(disposableDomains);
function isDisposableEmail(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && disposableDomainSet.has(domain);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const INVALID_CREDENTIALS = "Incorrect mobile/email or password";
const TICKET_EXPIRED = "This step has expired. Please start again.";
const DUPLICATE_ACCOUNT = "An account with that email or mobile number already exists.";
// Which wording of the sign-up consents the app shows. Bump this whenever the consent
// text in mobile/src/app/register.js changes, so each saved consent says what was agreed.
const CONSENT_VERSION = "2026-10-26"; // company name spelling fixed in the marketing consent

// Only the fields the app needs — never the hash, lockout counters or token version.
// `hasPassword` is included when the row was loaded with its hash, so Edit Profile knows
// whether a Google-only account must set a password before changing mobile/email.

function publicUser(user) {
  const { passwordHash, failedLoginCount: _count, lockedUntil: _lock, tokenVersion: _tv, ...safe } = user;
  return "passwordHash" in user ? { ...safe, hasPassword: !!passwordHash } : safe;
}
//the function for getting the session for the user after the login and registration and social login and also for the corporate login and refreshing the access token and also for the getMe
// Tokens + profile for a freshly signed-in patient.
async function sessionFor(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { passwordHash: false } });
  return { ...issuePatientTokens(user), user: publicUser(user) };
}

function throttledResponse(res, result) {
  return res.status(429).json({
    error: `Please wait ${result.secondsLeft}s before requesting another code.`,
    code: "otp_throttled",
    secondsLeft: result.secondsLeft,
  });
}
// 
async function otpFailure(req, res, result, { userId = null, step } = {}) {
  await recordSecurityEvent(req, EVENTS.OTP_FAILED, { userId, detail: { step, reason: result.code } });
  return res.status(401).json({ error: result.reason, code: result.code, attemptsLeft: result.attemptsLeft });
}

function ticketFailure(res) {
  return res.status(401).json({ error: TICKET_EXPIRED, code: "ticket_invalid" });
}

// --- Sending and checking codes -------------------------------------------------------
// Email codes are always ours (src/lib/mailer.js). Mobile codes are ours by default (only
// printed to the log in development — see otp-delivery.service.js); with
// PHONE_OTP_PROVIDER=firebase the app asks Firebase to send and check them, and sends us
// Firebase's signed proof (firebaseIdToken) instead of the code. Everything else — tickets,
// passwords, which number a step is for — stays here either way.
function viaFirebase(dest) {
  return isFirebasePhoneEnabled() && !String(dest).includes("@");
}

// Step 1. In Firebase mode there's nothing to send from here for a mobile: the app does it.
async function sendCode(dest, purpose) {
  if (viaFirebase(dest)) return { throttled: false };
  return issueOtp(dest, purpose);
}

// What the code screen needs. The full number is only handed back in Firebase mode, and
// only for numbers the person typed themselves (callers make sure of that).
function codeStep(ticket, dest) {
  return {
    ticket,
    maskedContact: maskContact(dest),
    ...(viaFirebase(dest) && { phoneVerification: "firebase", phoneNumber: dest }),
  };
}

function hasProof(body) {
  return !!(body.code || body.firebaseIdToken);
}

// Step 2. Same result shape as verifyOtp. A Firebase proof only counts if it is for the
// exact number this step was started for.
async function checkCode(dest, purpose, body) {
  if (!viaFirebase(dest)) return verifyOtp(dest, purpose, body.code);
  try {
    const phone = await verifyPhoneProof(body.firebaseIdToken);
    if (phone !== dest) return { ok: false, code: "otp_invalid", reason: "That code was for a different mobile number." };
    return { ok: true };
  } catch (err) {
    if (!err.code || !String(err.code).startsWith("otp_")) throw err;
    return { ok: false, code: err.code, reason: err.message };
  }
}

// Firebase sends the SMS from the app, so the app must know the full number. When the
// person typed their email but the code would go to their (unshown) mobile, ask them to
// use the mobile instead rather than reveal the number.
function useMobileInstead(res, message) {
  return res.status(400).json({ error: message, code: "use_mobile" });
}

// Login and forgot-password take either an email or a mobile + its calling code.
// Returns the Prisma `where` for it and the normalized value, or null if invalid.
function parseIdentifier({ email, mobile, countryCode }) {
  if (email) {
    const clean = normalizeEmail(email);
    return EMAIL_RE.test(clean) ? { where: { email: clean }, value: clean } : null;
  }
  const parsed = normalizeMobile(mobile, countryCode);
  return parsed ? { where: { mobile: parsed.e164 }, value: parsed.e164 } : null;
}

// The picked phone country must belong to the number (+971 with "AE", not "IN"; "US" for a
// +1 number that is really Canadian). An older app sends none, and gets the country the number
// reliably belongs to, or none.
function phoneCountryFailure(res, country) {
  return country.error === "phone_country_mismatch"
    ? res.status(400).json({ error: "The phone country does not match the mobile number.", code: "phone_country_mismatch" })
    : res.status(400).json({ error: "Enter a valid mobile number for the selected country." });
}

// Both sign-ups (the form, and Google/Apple + mobile) refuse to go on without the two
// required consents, and save all three as proof of what was agreed.
function hasRequiredConsents(consents) {
  return consents.termsPrivacy === true && consents.medicalDisclaimer === true;
}

function consentRequired(res) {
  return res.status(400).json({
    error: "Please accept the Terms & Privacy Policy and the medical disclaimer to continue.",
    code: "consent_required",
  });
}

function consentRows(req, consents) {
  return [
    { type: "terms_privacy", accepted: true },
    { type: "medical_disclaimer", accepted: true },
    { type: "marketing", accepted: consents.marketing === true },
  ].map((c) => ({ ...c, version: CONSENT_VERSION, ipAddress: req.ip || null }));
}

// Step 1 of registration: the account is created straight away but unverified, with the
// password already hashed, and an OTP goes to the mobile. Step 2 (registerVerifyOtp)
// checks it and only then flips isVerified, so nothing can log in to it before the
// mobile is proven. The email is verified later, on first use (markEmailVerified).
async function register(req, res) {
  const { email, mobile, password } = req.body;
  const names = readNameFields(req.body);
  if (names.missing || !email || !mobile || !password) {
    return res.status(400).json({ error: "name, email, mobile and password are required" });
  }
  if (names.error) return res.status(400).json({ error: names.error });
  const cleanEmail = normalizeEmail(email);
  if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: "Enter a valid email address." });
  if (isDisposableEmail(cleanEmail)) {
    return res
      .status(400)
      .json({ error: "Please use a permanent email address, not a temporary/disposable one." });
  }
  const profile = readProfileFields(req.body);
  if (profile.error) return res.status(400).json({ error: profile.error, code: "invalid_profile" });
  const phone = normalizeMobile(mobile, callingCodeFor(req.body, profile));
  if (!phone) return res.status(400).json({ error: "Enter a valid mobile number for the selected country." });
  const country = resolvePhoneCountry(phone.e164, profile.phoneCountry);
  if (!country.ok) return phoneCountryFailure(res, country);
  const passwordError = passwordProblem(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const consents = req.body.consents || {};
  if (!hasRequiredConsents(consents)) return consentRequired(res);

  const existing = await prisma.user.findMany({
    where: { OR: [{ email: cleanEmail }, { mobile: phone.e164 }] },
  });
  if (existing.some((u) => u.isVerified)) return res.status(409).json({ error: DUPLICATE_ACCOUNT });
  // Half-finished registrations hold no data and can't log in, so a new attempt replaces
  // them — otherwise anyone could block a number or email by starting a sign-up with it.
  if (existing.length) {
    await prisma.user.deleteMany({ where: { id: { in: existing.map((u) => u.id) }, isVerified: false } });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        name: names.name,
        firstName: names.firstName,
        lastName: names.lastName,
        email: cleanEmail,
        mobile: phone.e164,
        countryCode: phone.countryCode,
        gender: profile.gender,
        nationality: profile.nationality,
        phoneCountry: country.phoneCountry,
        passwordHash: await hashPassword(password),
        isVerified: false,
        consents: { create: consentRows(req, consents) },
      },
    });
  } catch (err) {
    // Two sign-ups for the same email/mobile racing each other: the unique index decides.
    if (err.code === "P2002") return res.status(409).json({ error: DUPLICATE_ACCOUNT });
    throw err;
  }

  await recordSecurityEvent(req, EVENTS.REGISTER_STARTED, { userId: user.id, identifier: phone.e164 });
  const result = await sendCode(phone.e164, "patient_register");
  if (result.throttled) return throttledResponse(res, result);
  res.json(codeStep(signTicket({ step: "register_otp", sub: user.id, dest: phone.e164 }), phone.e164));
}

async function registerVerifyOtp(req, res) {
  const { ticket } = req.body;
  if (!ticket || !hasProof(req.body)) return res.status(400).json({ error: "ticket and code are required" });

  const step = readTicket(ticket, "register_otp");
  if (!step) return ticketFailure(res);
  // Gone if a newer sign-up replaced it; verified if this is a repeated submit.
  const pending = await prisma.user.findUnique({ where: { id: step.sub } });
  if (!pending || pending.isVerified) return ticketFailure(res);

  const result = await checkCode(step.dest, "patient_register", req.body);
  if (!result.ok) return otpFailure(req, res, result, { userId: pending.id, step: "register_mobile" });

  // The mobile is proven, so the account is done and they're signed straight in. The
  // email is verified later, the first time a code sent to it is used (see
  // markEmailVerified); until then it's never used to reset the password.
  await prisma.user.update({ where: { id: pending.id }, data: { isVerified: true } });
  await recordSecurityEvent(req, EVENTS.REGISTER_COMPLETED, { userId: pending.id });
  res.status(201).json(await sessionFor(pending.id));
}

// Called when a code sent to the account's email was just entered correctly — that
// proves the inbox is theirs. Only email login and email change reach this: both start
// from someone who already proved they own the account (password, or a signed-in
// session + password), so a stranger's inbox can't claim someone else's account.
async function markEmailVerified(req, user) {
  if (user.emailVerifiedAt) return;
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  await recordSecurityEvent(req, EVENTS.EMAIL_VERIFIED, { userId: user.id, identifier: user.email });
}

async function recordFailedLogin(user) {
  const { failedLoginCount } = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (failedLoginCount < MAX_FAILED_LOGINS) return false;
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) },
  });
  return true;
}

function lockedResponse(res, lockedUntil) {
  const minutes = Math.max(Math.ceil((lockedUntil.getTime() - Date.now()) / 60000), 1);
  return res.status(429).json({
    error: `Too many failed attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    code: "account_locked",
  });
}

// Step 1 of login: the password is the first factor. Only once it checks out does an OTP
// go out — to the registered email if they logged in with their email, otherwise to the
// registered mobile (both were verified at sign-up) — and the ticket returned here is
// the only way to reach the OTP step. Accounts from before passwords existed (and Google/Apple accounts)
// have no password: they get the OTP alone and are then made to set one.
async function login(req, res) {
  const { password } = req.body;
  if (!password || (!req.body.email && !req.body.mobile)) {
    return res.status(400).json({ error: "email or mobile, and password, are required" });
  }

  const id = parseIdentifier(req.body);
  const user = id
    ? await prisma.user.findFirst({ where: { ...id.where, isVerified: true }, omit: { passwordHash: false } })
    : null;

  const typed = id?.value || req.body.email || req.body.mobile;
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    await recordSecurityEvent(req, EVENTS.LOGIN_BLOCKED_LOCKED, { userId: user.id, identifier: typed });
    return lockedResponse(res, user.lockedUntil);
  }

  // The code goes where they said they are: email login -> email, mobile login -> SMS.
  // Accounts without a mobile (older Google/Apple ones) always get it by email. One
  // exception: an account with no password whose email isn't verified yet gets it on the
  // mobile, since for them the code is the only check and the inbox isn't proven theirs.
  const emailIsSafe = user && (user.emailVerifiedAt || user.passwordHash || !user.mobile);
  const dest = user ? (req.body.email && emailIsSafe ? user.email : user.mobile || user.email) : null;

  if (user && !user.passwordHash) {
    if (req.body.email && viaFirebase(dest)) return useMobileInstead(res, "Please log in with your mobile number.");
    const result = await sendCode(dest, "patient_login");
    if (result.throttled) return throttledResponse(res, result);
    return res.json({
      ...codeStep(signTicket({ step: "login_otp", sub: user.id, dest, needsPassword: true }), dest),
      needsPasswordSetup: true,
    });
  }

  const matches = await comparePassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user || !matches) {
    await recordSecurityEvent(req, EVENTS.LOGIN_FAILED, {
      userId: user?.id ?? null,
      identifier: typed,
      detail: { reason: user ? "wrong_password" : "no_account" },
    });
    if (user && (await recordFailedLogin(user))) {
      await recordSecurityEvent(req, EVENTS.ACCOUNT_LOCKED, { userId: user.id, detail: { minutes: LOCKOUT_MINUTES } });
      return lockedResponse(res, new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000));
    }
    return res.status(401).json({ error: INVALID_CREDENTIALS, code: "invalid_credentials" });
  }

  if (user.failedLoginCount || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
  }

  // Only possible for an email login whose account has no email on file — not today.
  if (req.body.email && viaFirebase(dest)) return useMobileInstead(res, "Please log in with your mobile number.");
  const result = await sendCode(dest, "patient_login");
  if (result.throttled) return throttledResponse(res, result);
  res.json(codeStep(signTicket({ step: "login_otp", sub: user.id, dest }), dest));
}

// Step 2 of login. Normally issues the session; for an account that still has no
// password it instead hands back a set-password ticket, so there's no way into the app
// without one.
async function loginVerifyOtp(req, res) {
  const { ticket } = req.body;
  if (!ticket || !hasProof(req.body)) return res.status(400).json({ error: "ticket and code are required" });

  const step = readTicket(ticket, "login_otp");
  if (!step) return ticketFailure(res);
  const user = await prisma.user.findFirst({
    where: { id: step.sub, isVerified: true },
    omit: { passwordHash: false },
  });
  if (!user) return ticketFailure(res);

  const result = await checkCode(step.dest, "patient_login", req.body);
  if (!result.ok) return otpFailure(req, res, result, { userId: user.id, step: "login" });
  // Password + code from the inbox: proves both the account and the email are theirs.
  if (step.dest === user.email && user.passwordHash) await markEmailVerified(req, user);

  if (!user.passwordHash) {
    return res.json({
      needsPasswordSetup: true,
      setPasswordTicket: signTicket({ step: "set_password", sub: user.id, reason: "setup", tv: user.tokenVersion }),
    });
  }
  await recordSecurityEvent(req, EVENTS.LOGIN_SUCCEEDED, { userId: user.id, detail: { method: "password_otp" } });
  res.json(await sessionFor(user.id));
}

// Forgot password, step 1. The code goes to whichever channel was typed (mobile or
// email), proving the person controls it. The same response comes back whether or not
// an account exists; a ticket without an account just never verifies.
async function forgotPassword(req, res) {
  if (!req.body.email && !req.body.mobile) {
    return res.status(400).json({ error: "email or mobile is required" });
  }
  const id = parseIdentifier(req.body);
  if (!id) return res.status(400).json({ error: "Enter a valid mobile number or email address." });

  const user = await prisma.user.findFirst({ where: { ...id.where, isVerified: true } });
  // An email nobody has proven yet can't be trusted to reset the password (it may be a
  // stranger's inbox typed at sign-up), so the code goes to the verified mobile instead.
  const dest = user && req.body.email && !user.emailVerifiedAt && user.mobile ? user.mobile : id.value;
  if (req.body.email && viaFirebase(dest)) {
    return useMobileInstead(res, "Your email isn't verified yet. Please reset your password with your mobile number.");
  }
  if (user) {
    const result = await sendCode(dest, "patient_password_reset");
    if (result.throttled) return throttledResponse(res, result);
  }
  await recordSecurityEvent(req, EVENTS.PASSWORD_RESET_REQUESTED, {
    userId: user?.id ?? null,
    identifier: id.value,
    detail: { accountFound: !!user },
  });
  res.json(codeStep(signTicket({ step: "reset_otp", sub: user?.id ?? null, dest }), dest));
}

async function verifyPasswordResetOtp(req, res) {
  const { ticket } = req.body;
  if (!ticket || !hasProof(req.body)) return res.status(400).json({ error: "ticket and code are required" });

  const step = readTicket(ticket, "reset_otp");
  if (!step) return ticketFailure(res);
  // No account behind this ticket: answer exactly like a wrong code would.
  if (!step.sub) return otpFailure(req, res, { code: "otp_invalid", reason: "Incorrect code." }, { step: "password_reset" });

  const result = await checkCode(step.dest, "patient_password_reset", req.body);
  if (!result.ok) return otpFailure(req, res, result, { userId: step.sub, step: "password_reset" });

  const user = await prisma.user.findFirst({ where: { id: step.sub, isVerified: true } });
  if (!user) return ticketFailure(res);
  res.json({
    setPasswordTicket: signTicket({ step: "set_password", sub: user.id, reason: "reset", tv: user.tokenVersion }),
  });
}

// Final step of both forgot-password ("reset") and the first-login setup for accounts
// that had no password ("setup"). Bumping tokenVersion signs out every existing
// session and also makes this ticket single-use, since it carries the old version.
async function setPassword(req, res) {
  const { ticket, password } = req.body;
  if (!ticket || !password) return res.status(400).json({ error: "ticket and password are required" });

  const step = readTicket(ticket, "set_password");
  if (!step) return ticketFailure(res);
  const passwordError = passwordProblem(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const updated = await prisma.user.updateMany({
    where: { id: step.sub, isVerified: true, tokenVersion: step.tv },
    data: {
      passwordHash: await hashPassword(password),
      tokenVersion: { increment: 1 },
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  if (updated.count === 0) return ticketFailure(res);

  await recordSecurityEvent(req, step.reason === "reset" ? EVENTS.PASSWORD_RESET_COMPLETED : EVENTS.PASSWORD_SET, {
    userId: step.sub,
  });
  if (step.reason === "reset") {
    return res.json({ message: "Password updated. Please log in with your new password." });
  }
  await recordSecurityEvent(req, EVENTS.LOGIN_SUCCEEDED, { userId: step.sub, detail: { method: "otp_then_new_password" } });
  res.json(await sessionFor(step.sub));
}

// Codes from any patient step can be resent with that step's ticket.
const TICKET_PURPOSE = {
  register_otp: "patient_register",
  login_otp: "patient_login",
  reset_otp: "patient_password_reset",
  change_contact_otp: (step) => (step.kind === "mobile" ? "patient_change_mobile" : "patient_change_email"),
};
const REGISTRATION_STEPS = ["register_otp"];

function purposeFor(step) {
  const purpose = TICKET_PURPOSE[step.step];
  return typeof purpose === "function" ? purpose(step) : purpose;
}

async function resendOtp(req, res) {
  const step = readTicket(req.body.ticket, Object.keys(TICKET_PURPOSE));
  if (!step) return ticketFailure(res);
  if (viaFirebase(step.dest)) {
    return res.status(400).json({ error: "Request a new code from the app.", code: "resend_in_app" });
  }
  const sent = { message: "A new code has been sent." };
  if (!step.sub) return res.json(sent); // forgot-password for an account that doesn't exist

  const user = await prisma.user.findUnique({ where: { id: step.sub } });
  const stillValid = user
    && (REGISTRATION_STEPS.includes(step.step) ? !user.isVerified : user.isVerified)
    && (step.tv === undefined || step.tv === user.tokenVersion);
  if (!stillValid) return ticketFailure(res);

  const result = await issueOtp(step.dest, purposeFor(step));
  if (result.throttled) return throttledResponse(res, result);
  res.json(sent);
}

// Google and Apple have already authenticated the person, so an existing account is
// signed straight in (see findSocialUser). Someone new gets a signed sign-up ticket
// carrying what the provider vouched for (its id, email, name); socialRegister turns it
// into an account once they add a mobile (proven by OTP) and accept the consents.
function socialNoAccount(res) {
  return res.status(404).json({ error: "No account found for this email. Please sign up first.", code: "no_account" });
}

function socialEmailInUse(res) {
  return res.status(409).json({
    error: "An account already uses this email. Log in with your mobile/email and password instead.",
    code: "email_in_use",
  });
}

async function socialSignIn(req, res, provider, payload) {
  let user;
  try {
    user = await findSocialUser({ provider, ...payload });
  } catch (err) {
    if (!(err instanceof SocialEmailInUseError || err instanceof SocialNoAccountError)) throw err;
    const noAccount = err instanceof SocialNoAccountError;
    await recordSecurityEvent(req, EVENTS.SOCIAL_LOGIN_REFUSED, {
      identifier: payload.email,
      detail: { provider, reason: noAccount ? "no_account" : "email_not_verified" },
    });
    if (!noAccount) return socialEmailInUse(res);
    // Only an email the provider has verified can become the account's (already verified) email.
    if (!payload.email || !payload.emailVerified) return socialNoAccount(res);
    return res.status(404).json({
      error: "Finish creating your account.",
      code: "no_account",
      signupTicket: signTicket({
        step: "social_signup",
        provider,
        providerId: payload.providerId,
        email: normalizeEmail(payload.email),
        name: payload.name || "",
      }),
      profile: { name: payload.name || "", email: normalizeEmail(payload.email) },
    });
  }
  await recordSecurityEvent(req, EVENTS.SOCIAL_LOGIN_SUCCEEDED, { userId: user.id, detail: { provider } });
  res.json(await sessionFor(user.id));
}

async function googleLogin(req, res) {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken is required" });

  let payload;
  try {
    payload = await verifyGoogleIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid Google token" });
  }
  return socialSignIn(req, res, "google", payload);
}

async function appleLogin(req, res) {
  const { idToken, name } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken is required" });

  let payload;
  try {
    payload = await verifyAppleIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid Apple token" });
  }
  return socialSignIn(req, res, "apple", { ...payload, name });
}

// Google/Apple sign-up, step 1: name (editable), mobile and consents on top of what the
// provider vouched for. Like the form sign-up, the account is created unverified and the
// mobile gets a code; registerVerifyOtp finishes it. No password: they sign in with
// Google/Apple, and are asked to set one if they ever log in with mobile/email instead.
async function socialRegister(req, res) {
  const { signupTicket, mobile } = req.body;
  const names = readNameFields(req.body);
  if (!signupTicket || names.missing || !mobile) {
    return res.status(400).json({ error: "signupTicket, name and mobile are required" });
  }
  const step = readTicket(signupTicket, "social_signup");
  if (!step) return ticketFailure(res);
  if (names.error) return res.status(400).json({ error: names.error });
  const profile = readProfileFields(req.body);
  if (profile.error) return res.status(400).json({ error: profile.error, code: "invalid_profile" });
  const phone = normalizeMobile(mobile, callingCodeFor(req.body, profile));
  if (!phone) return res.status(400).json({ error: "Enter a valid mobile number for the selected country." });
  const country = resolvePhoneCountry(phone.e164, profile.phoneCountry);
  if (!country.ok) return phoneCountryFailure(res, country);
  const consents = req.body.consents || {};
  if (!hasRequiredConsents(consents)) return consentRequired(res);

  const idField = step.provider === "google" ? "googleId" : "appleId";
  const existing = await prisma.user.findMany({
    where: { OR: [{ email: step.email }, { mobile: phone.e164 }, { [idField]: step.providerId }] },
  });
  const verified = existing.filter((u) => u.isVerified);
  if (verified.some((u) => u.mobile === phone.e164)) {
    return res.status(409).json({
      error: "This mobile number already has an account. Log in with it instead.",
      code: "mobile_in_use",
    });
  }
  if (verified.length) return res.status(409).json({ error: DUPLICATE_ACCOUNT });
  // Same as the form: half-finished sign-ups can't log in and are simply replaced.
  if (existing.length) {
    await prisma.user.deleteMany({ where: { id: { in: existing.map((u) => u.id) }, isVerified: false } });
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        name: names.name,
        firstName: names.firstName,
        lastName: names.lastName,
        email: step.email,
        mobile: phone.e164,
        countryCode: phone.countryCode,
        gender: profile.gender,
        nationality: profile.nationality,
        phoneCountry: country.phoneCountry,
        [idField]: step.providerId,
        // The provider only issues the ticket for an email it has verified.
        emailVerifiedAt: new Date(),
        isVerified: false,
        consents: { create: consentRows(req, consents) },
      },
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: DUPLICATE_ACCOUNT });
    throw err;
  }

  await recordSecurityEvent(req, EVENTS.REGISTER_STARTED, {
    userId: user.id,
    identifier: phone.e164,
    detail: { provider: step.provider },
  });
  const result = await sendCode(phone.e164, "patient_register");
  if (result.throttled) return throttledResponse(res, result);
  res.json(codeStep(signTicket({ step: "register_otp", sub: user.id, dest: phone.e164 }), phone.e164));
}

// Step 1 of corporate login: password gets you an OTP, not a token — the actual
// token only comes from corporateVerifyOtp below. Same "don't reveal which accounts
// exist" shape as the patient OTP flow isn't needed here since a wrong password
// already tells you the account exists, so we just say "Invalid credentials" plainly.
async function corporateLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email and password are required" });

  const corporateUser = await prisma.corporateUser.findUnique({ where: { email } });
  if (!corporateUser)
    return res.status(401).json({ error: "Invalid credentials" });

  const matches = await comparePassword(password, corporateUser.passwordHash);
  if (!matches) return res.status(401).json({ error: "Invalid credentials" });

  const result = await issueOtp(email, "corporate_login");
  if (result.throttled) {
    return res
      .status(429)
      .json({
        error: `Please wait ${result.secondsLeft}s before requesting another code.`,
        secondsLeft: result.secondsLeft,
      });
  }
  res.json({ message: "OTP sent." });
}
// Step 2: the actual token issuance, once the OTP sent above checks out.
async function corporateVerifyOtp(req, res) {
  const { email, code } = req.body;
  if (!email || !code)
    return res.status(400).json({ error: "email and code are required" });

  const result = await verifyOtp(email, "corporate_login", code);
  if (!result.ok) return res.status(401).json({ error: result.reason, code: result.code });

  const corporateUser = await prisma.corporateUser.findUnique({
    where: { email },
    include: { corporate: true },
  });
  if (!corporateUser) return res.status(404).json({ error: "Account not found" });

  // A login whose password someone else chose gets a restricted session (`pwc`): it can
  // only change the password, until it does. See requireAuth.
  const claims = {
    sub: corporateUser.id,
    role: "corporate",
    corporateId: corporateUser.corporateId,
    ...(corporateUser.mustChangePassword && { pwc: true }),
  };
  const token = signAccessToken(claims);
  const refreshToken = signRefreshToken(claims);
  const { passwordHash: _omit, ...safeCorporateUser } = corporateUser;
  res.json({
    token,
    refreshToken,
    corporateUser: safeCorporateUser,
    ...(corporateUser.mustChangePassword && {
      mustChangePassword: true,
      code: PASSWORD_CHANGE_REQUIRED.code,
      message: PASSWORD_CHANGE_REQUIRED.error,
    }),
  });
}

async function refreshAccessToken(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return res.status(400).json({ error: "refreshToken is required" });

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }

  const claims = {
    sub: payload.sub,
    role: payload.role,
    ...(payload.corporateId != null && { corporateId: payload.corporateId }),
  };
  // A patient session dies once the password is reset (tokenVersion moves on). Tokens
  // minted before tokenVersion existed carry no `tv` and count as version 0.
  if (payload.role === "patient") {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, isVerified: true },
    });
    if (!user || !user.isVerified || user.tokenVersion !== (payload.tv ?? 0)) {
      return res.status(401).json({ error: "Your session has ended. Please log in again." });
    }
    claims.tv = user.tokenVersion;
  }
  // A corporate refresh reads the account, so the first-login restriction is decided by
  // the database and not by what the old token says: a restricted refresh token can never
  // produce an unrestricted access token while the flag is set, and a token issued before
  // the flag was set is restricted too. (Patient and admin refreshes are unchanged.)
  if (payload.role === "corporate") {
    const user = await prisma.corporateUser.findUnique({
      where: { id: payload.sub },
      select: { corporateId: true, mustChangePassword: true },
    });
    if (!user) return res.status(401).json({ error: "Your session has ended. Please log in again." });
    claims.corporateId = user.corporateId;
    if (user.mustChangePassword) claims.pwc = true;
  }
  const token = signAccessToken(claims);
  const newRefreshToken = signRefreshToken(claims);
  res.json({ token, refreshToken: newRefreshToken });
}
//the function for getting  the profile page
async function getMe(req, res) {
  if (req.user.role === "corporate") {
    const corporateUser = await prisma.corporateUser.findUnique({
      where: { id: req.user.id },
      include: { corporate: true },
    });
    if (!corporateUser)
      return res.status(404).json({ error: "Account not found" });
    const { passwordHash: _omit, ...safeCorporateUser } = corporateUser;
    return res.json({ corporateUser: safeCorporateUser });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id }, omit: { passwordHash: false } });
  if (!user) return res.status(404).json({ error: "Account not found" });
  res.json({ user: publicUser(user) });
}
// Name only. Mobile and email are where the login code and password resets go, so they
// change through requestContactChange/verifyContactChange (password + OTP) instead.
async function updateMe(req, res) {
  if (req.body.mobile !== undefined || req.body.email !== undefined || req.body.countryCode !== undefined) {
    return res.status(400).json({ error: "Mobile number and email are changed with a verification code, not here." });
  }
  const name = req.body.name === undefined ? undefined : String(req.body.name).trim();
  if (name !== undefined && name.length < 2) return res.status(400).json({ error: "Enter a valid name." });

  const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });
  const renamed = !!name && name !== current?.name;
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: renamed ? { name, firstName: null, lastName: null } : {},
    omit: { passwordHash: false },
  });
  res.json({ user: publicUser(user) });
}

// Change mobile/email, step 1: the current password, then a code to the NEW value. A
// stolen session alone (no password) can't move either login factor to someone else.
async function requestContactChange(req, res) {
  const { kind, password } = req.body;
  if (kind !== "mobile" && kind !== "email") return res.status(400).json({ error: 'kind must be "mobile" or "email"' });
  if (!password) return res.status(400).json({ error: "password is required" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id }, omit: { passwordHash: false } });
  if (!user || !user.isVerified) return res.status(404).json({ error: "Account not found" });
  if (!user.passwordHash) {
    return res.status(403).json({ error: "Set a password to change your mobile or email.", code: "password_required" });
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return lockedResponse(res, user.lockedUntil);
  if (!(await comparePassword(password, user.passwordHash))) {
    await recordSecurityEvent(req, EVENTS.CONTACT_CHANGE_FAILED, { userId: user.id, detail: { kind, reason: "wrong_password" } });
    if (await recordFailedLogin(user)) {
      await recordSecurityEvent(req, EVENTS.ACCOUNT_LOCKED, { userId: user.id, detail: { minutes: LOCKOUT_MINUTES } });
      return lockedResponse(res, new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000));
    }
    return res.status(401).json({ error: "Incorrect password.", code: "invalid_password" });
  }
  if (user.failedLoginCount) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
  }

  let dest;
  let countryCode;
  let phoneCountry;
  if (kind === "mobile") {
    const profile = readProfileFields({ phoneCountry: req.body.phoneCountry });
    if (profile.error) return res.status(400).json({ error: profile.error, code: "invalid_profile" });
    const phone = normalizeMobile(req.body.mobile, callingCodeFor(req.body, profile));
    if (!phone) return res.status(400).json({ error: "Enter a valid mobile number for the selected country." });
    const country = resolvePhoneCountry(phone.e164, profile.phoneCountry);
    if (!country.ok) return phoneCountryFailure(res, country);
    if (phone.e164 === user.mobile) return res.status(400).json({ error: "That is already your mobile number." });
    dest = phone.e164;
    countryCode = phone.countryCode;
    phoneCountry = country.phoneCountry;
  } else {
    dest = normalizeEmail(req.body.email);
    if (!EMAIL_RE.test(dest)) return res.status(400).json({ error: "Enter a valid email address." });
    if (isDisposableEmail(dest)) {
      return res.status(400).json({ error: "Please use a permanent email address, not a temporary/disposable one." });
    }
    if (dest === user.email) return res.status(400).json({ error: "That is already your email address." });
  }
  const taken = await prisma.user.findFirst({ where: { [kind]: dest, isVerified: true, NOT: { id: user.id } } });
  if (taken) {
    return res.status(409).json({
      error: kind === "mobile" ? "That mobile number is already in use by another account." : "That email is already in use by another account.",
    });
  }

  const result = await sendCode(dest, kind === "mobile" ? "patient_change_mobile" : "patient_change_email");
  if (result.throttled) return throttledResponse(res, result);
  res.json(codeStep(signTicket({ step: "change_contact_otp", sub: user.id, kind, dest, countryCode, phoneCountry, tv: user.tokenVersion }), dest));
}

// Change mobile/email, step 2: the code from the new number/inbox. Needs the same signed-in
// account that started it, and a ticket from before a password reset no longer works.
async function verifyContactChange(req, res) {
  const { ticket } = req.body;
  if (!ticket || !hasProof(req.body)) return res.status(400).json({ error: "ticket and code are required" });

  const step = readTicket(ticket, "change_contact_otp");
  if (!step || step.sub !== req.user.id) return ticketFailure(res);
  const current = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!current || !current.isVerified || current.tokenVersion !== step.tv) return ticketFailure(res);

  const result = await checkCode(step.dest, purposeFor(step), req.body);
  if (!result.ok) return otpFailure(req, res, result, { userId: req.user.id, step: "contact_change" });

  // A half-finished sign-up holding this number/email would otherwise trip the unique index.
  await prisma.user.deleteMany({ where: { [step.kind]: step.dest, isVerified: false } });
  let user;
  try {
    user = await prisma.user.update({
      where: { id: req.user.id },
      data: step.kind === "mobile"
        // A ticket from before phoneCountry existed has none: clear the old one rather than keep a country that no longer matches.
        ? { mobile: step.dest, countryCode: step.countryCode, phoneCountry: step.phoneCountry ?? null }
        : { email: step.dest, emailVerifiedAt: new Date() },
      omit: { passwordHash: false },
    });
  } catch (err) {
    // Someone else verified the same number/email in the meantime.
    if (err.code === "P2002") return res.status(409).json({ error: "That is now in use by another account." });
    throw err;
  }
  // Old value masked, new one masked too: enough to trace a takeover, no full numbers.
  await recordSecurityEvent(req, step.kind === "mobile" ? EVENTS.MOBILE_CHANGED : EVENTS.EMAIL_CHANGED, {
    userId: req.user.id,
    identifier: step.dest,
    detail: { from: maskContact(step.kind === "mobile" ? current.mobile || "" : current.email) || null },
  });
  res.json({ user: publicUser(user) });
}
// the function for saving the push token in the db for popup notification and we need ios account for it while doing the login task with it we'll do the notification task as well
async function savePushToken(req, res) {
  const { pushToken } = req.body;
  if (!pushToken) return res.status(400).json({ error: "pushToken is required" });

  await prisma.user.update({ where: { id: req.user.id }, data: { pushToken } });
  res.json({ message: "Push token saved." });
}

// Corporate forgot/reset password (email only). Patients have their own flow above:
// forgotPassword -> verifyPasswordResetOtp -> setPassword.
async function requestPasswordReset(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const corporateUser = await prisma.corporateUser.findUnique({ where: { email } });
  if (corporateUser) {
    const result = await issueOtp(email, "corporate_password_reset");
    if (result.throttled) {
      return res
        .status(429)
        .json({
          error: `Please wait ${result.secondsLeft}s before requesting another code.`,
          secondsLeft: result.secondsLeft,
        });
    }
  }
  // Same response whether or not the account exists, so we don't reveal which emails are registered.
  res.json({
    message:
      "If a corporate account exists for that email, a reset code has been sent.",
  });
}

async function resetPassword(req, res) {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res
      .status(400)
      .json({ error: "email, code and newPassword are required" });
  }
  if (newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }

  const result = await verifyOtp(email, "corporate_password_reset", code);
  if (!result.ok) return res.status(401).json({ error: result.reason });

  const corporateUser = await prisma.corporateUser.findUnique({ where: { email } });
  if (!corporateUser) return res.status(404).json({ error: "Account not found" });

  // They picked this password themselves (after proving the mailbox), so any
  // first-login restriction is satisfied.
  const passwordHash = await hashPassword(newPassword);
  await prisma.corporateUser.update({
    where: { id: corporateUser.id },
    data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
  });
  res.json({
    message: "Password updated. Please log in with your new password.",
  });
}

// For a corporate who's already logged in and knows their current password — different
// from resetPassword above, which is for someone locked out who verifies via OTP instead.
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res
      .status(400)
      .json({ error: "currentPassword and newPassword are required" });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  const corporateUser = await prisma.corporateUser.findUnique({ where: { id: req.user.id } });
  if (!corporateUser) return res.status(404).json({ error: "Account not found" });

  const matches = await comparePassword(currentPassword, corporateUser.passwordHash);
  if (!matches) return res.status(400).json({ error: "Current password is incorrect." });
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: "Choose a new password that is different from the current one." });
  }

  // This is also what completes the first-login change: it clears the restriction and
  // hands back a fresh, unrestricted token pair so the client can carry on.
  const passwordHash = await hashPassword(newPassword);
  await prisma.corporateUser.update({
    where: { id: corporateUser.id },
    data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
  });
  const claims = { sub: corporateUser.id, role: "corporate", corporateId: corporateUser.corporateId };
  res.json({
    message: "Password updated.",
    token: signAccessToken(claims),
    refreshToken: signRefreshToken(claims),
  });
}

// JWTs are stateless — there's no server-side session to end, so this is just a
// well-known endpoint for the frontend to call that always succeeds.
async function corporateLogout(req, res) {
  res.json({ message: "Logged out." });
}

module.exports = {
  register,
  registerVerifyOtp,
  login,
  loginVerifyOtp,
  forgotPassword,
  verifyPasswordResetOtp,
  setPassword,
  resendOtp,
  googleLogin,
  appleLogin,
  socialRegister,
  corporateLogin,
  corporateVerifyOtp,
  refreshAccessToken,
  getMe,
  updateMe,
  requestContactChange,
  verifyContactChange,
  savePushToken,
  requestPasswordReset,
  resetPassword,
  changePassword,
  corporateLogout,
};
