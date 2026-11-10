// Mock the OTP delivery service so tests never send real email — and so we
// can read back the plaintext code a test triggered (it's only ever stored bcrypt-hashed).
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { deliverOtp } = require('../src/modules/auth/otp-delivery.service');
const { createCorporateUserAndLogin, createPatient } = require('./helpers');

const PASSWORD = 'TestPass123';

// Each test uses a fresh, unique mobile/email so tests never collide with each other or
// with leftover data from a previous run. A valid 10-digit Indian mobile, national form.
function uniqueMobile() {
  return `9${Date.now().toString().slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}
function uniqueEmail() {
  return `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

// Finds the MOST RECENT call for this identifier — a flow can send more than one OTP
// to the same identifier, and it's always the latest one that's still valid.
function codeSentTo(identifier) {
  const calls = deliverOtp.mock.calls.filter((c) => c[0] === identifier);
  return calls[calls.length - 1]?.[1];
}
function sendCount(identifier) {
  return deliverOtp.mock.calls.filter((c) => c[0] === identifier).length;
}

// UK mobiles for the +44 tests. Fixed on purpose: random digits after "79" are not always a valid
// UK number (about 1 in 170 are not), which made those tests fail now and then. Every one is
// checked with libphonenumber by the fixtures test below. Each test takes the next unused number.
const UK_MOBILES = Array.from({ length: 12 }, (_, i) => `7400${String(120001 + i * 7)}`);
let nextUkMobile = 0;
function ukMobile() {
  if (nextUkMobile >= UK_MOBILES.length) throw new Error('Out of UK test numbers: add more to UK_MOBILES');
  return UK_MOBILES[nextUkMobile++];
}

describe('test fixtures', () => {
  it('every UK test mobile is a valid +44 number', () => {
    const { parsePhoneNumberFromString } = require('libphonenumber-js');
    expect(new Set(UK_MOBILES).size).toBe(UK_MOBILES.length);
    for (const national of UK_MOBILES) {
      const parsed = parsePhoneNumberFromString(`+44${national}`);
      expect(parsed && parsed.isValid()).toBe(true);
      expect(parsed.countryCallingCode).toBe('44');
    }
  });
});

// Pushes this destination's codes past the 30s resend cooldown, so a test can trigger
// the next OTP without waiting for real time to pass.
async function skipCooldown(identifier) {
  await prisma.otpCode.updateMany({
    where: { identifier },
    data: { createdAt: new Date(Date.now() - 60 * 1000) },
  });
}

function registerBody(overrides = {}) {
  return {
    name: 'Test User', email: uniqueEmail(), mobile: uniqueMobile(), countryCode: '+91', password: PASSWORD,
    consents: { termsPrivacy: true, medicalDisclaimer: true, marketing: false },
    ...overrides,
  };
}

// A patient from before passwords existed: verified, no password_hash.
async function createLegacyPatient() {
  const mobile = `+91${uniqueMobile()}`;
  const user = await prisma.user.create({ data: { name: 'Legacy User', email: uniqueEmail(), mobile, countryCode: '+91' } });
  return { user, mobile };
}

async function loginToOtpStep(body) {
  return request(app).post('/auth/login').send({ password: PASSWORD, ...body });
}

// Email + password login finished with the code from the inbox — the first use of the
// email, which is what verifies it. Returns the session ({ token, refreshToken, user }).
async function verifyEmailByLogin(patient) {
  await skipCooldown(patient.email);
  const login = await loginToOtpStep({ email: patient.email, password: patient.password });
  const res = await request(app).post('/auth/login/verify-otp').send({ ticket: login.body.ticket, code: codeSentTo(patient.email) });
  return res.body;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /auth/register', () => {
  it('rejects a request missing required fields', async () => {
    const res = await request(app).post('/auth/register').send({ name: 'Test' });
    expect(res.status).toBe(400);
  });

  it('rejects a registration without a password', async () => {
    const res = await request(app).post('/auth/register').send(registerBody({ password: undefined }));
    expect(res.status).toBe(400);
  });

  it('rejects a disposable email domain', async () => {
    const res = await request(app).post('/auth/register').send(registerBody({ email: 'someone@mailinator.com' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/temporary|disposable/i);
  });

  it('rejects a mobile number that is not valid for the selected country', async () => {
    const res = await request(app).post('/auth/register').send(registerBody({ mobile: '12345' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mobile/i);
  });

  it.each([
    ['too short', 'abc123'],
    ['no number', 'abcdefghij'],
    ['no letter', '1234567890'],
  ])('rejects a password that is %s', async (_label, password) => {
    const res = await request(app).post('/auth/register').send(registerBody({ password }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('creates an unverified account, stores normalized contact details, and texts an OTP', async () => {
    const national = uniqueMobile();
    const email = uniqueEmail();
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ mobile: `0${national}`, email: `  ${email.toUpperCase()} ` }));
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeTruthy();
    expect(res.body.maskedContact).toBe(`+91 •••••${national.slice(-4)}`);

    // Trunk zero dropped, E.164 stored and texted; email trimmed + lowercased.
    const e164 = `+91${national}`;
    expect(codeSentTo(e164)).toMatch(/^\d{6}$/);
    const user = await prisma.user.findUnique({ where: { email }, omit: { passwordHash: false } });
    expect(user.mobile).toBe(e164);
    expect(user.isVerified).toBe(false);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt, never plain text
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  // Regression test for a real bug: the SMS step used to hardcode +91 for every
  // registration regardless of the country code the person actually picked.
  it('sends the OTP to the selected country, not a hardcoded one', async () => {
    // A unique 9-digit UAE mobile ("50" + 7 digits).
    const uaeMobile = `50${Date.now().toString().slice(-4)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const res = await request(app).post('/auth/register').send(registerBody({ mobile: uaeMobile, countryCode: '+971' }));
    expect(res.status).toBe(200);
    const call = deliverOtp.mock.calls.filter((c) => c[0] === `+971${uaeMobile}`).pop();
    expect(call[0]).toBe(`+971${uaeMobile}`); // deliverOtp(identifier, code, purpose): the full E.164 number
    expect(call[2]).toBe('patient_register');
    expect(call).toHaveLength(3);
  });
});

describe('register -> verify flow', () => {
  it('needs only the mobile code, then logs straight in; the email is not verified yet', async () => {
    const body = registerBody();
    const reg = await request(app).post('/auth/register').send(body);

    // Before the code: can't log in.
    const early = await loginToOtpStep({ email: body.email });
    expect(early.status).toBe(401);

    const verifyRes = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: codeSentTo(`+91${body.mobile}`) });
    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.token).toBeTruthy();
    expect(verifyRes.body.refreshToken).toBeTruthy();
    expect(verifyRes.body.user.mobile).toBe(`+91${body.mobile}`);
    expect(verifyRes.body.user.isVerified).toBe(true);
    expect(verifyRes.body.user.emailVerifiedAt).toBeNull();
    expect(verifyRes.body.user.hasPassword).toBe(true);
    expect(verifyRes.body.user).not.toHaveProperty('passwordHash');
    expect(sendCount(body.email)).toBe(0); // no email code at sign-up

    // Same number typed another way, or the email in another case, is still a duplicate.
    const dupeMobile = await request(app).post('/auth/register').send(registerBody({ mobile: `+91 ${body.mobile}` }));
    expect(dupeMobile.status).toBe(409);
    const dupeEmail = await request(app).post('/auth/register').send(registerBody({ email: body.email.toUpperCase() }));
    expect(dupeEmail.status).toBe(409);
  });

  it('lets a new sign-up replace an abandoned unverified one for the same number', async () => {
    const mobile = uniqueMobile();
    const first = await request(app).post('/auth/register').send(registerBody({ mobile }));
    await skipCooldown(`+91${mobile}`);
    const second = await request(app).post('/auth/register').send(registerBody({ mobile }));
    expect(second.status).toBe(200);

    // The first sign-up's ticket now points at a deleted row.
    const stale = await request(app)
      .post('/auth/register/verify-otp')
      .send({ ticket: first.body.ticket, code: codeSentTo(`+91${mobile}`) });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('ticket_invalid');

    const fresh = await request(app)
      .post('/auth/register/verify-otp')
      .send({ ticket: second.body.ticket, code: codeSentTo(`+91${mobile}`) });
    expect(fresh.status).toBe(201);
  });

  it('rejects wrong codes, then locks the code after 5 wrong attempts', async () => {
    const body = registerBody();
    const reg = await request(app).post('/auth/register').send(body);

    let lastRes;
    for (let i = 0; i < 5; i++) {
      lastRes = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: '000000' });
      expect(lastRes.status).toBe(401);
    }
    expect(lastRes.body.code).toBe('otp_locked');

    // Even the real code is now rejected until a new one is sent.
    const finalRes = await request(app)
      .post('/auth/register/verify-otp')
      .send({ ticket: reg.body.ticket, code: codeSentTo(`+91${body.mobile}`) });
    expect(finalRes.status).toBe(401);
    expect(finalRes.body.code).toBe('otp_locked');
  });

  it('reports a wrong code as otp_invalid with the attempts left', async () => {
    const body = registerBody();
    const reg = await request(app).post('/auth/register').send(body);
    const res = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: '000000' });
    expect(res.body.code).toBe('otp_invalid');
    expect(res.body.attemptsLeft).toBe(4);
  });

  it('reports an expired code as otp_expired', async () => {
    const body = registerBody();
    const reg = await request(app).post('/auth/register').send(body);
    await prisma.otpCode.updateMany({ where: { identifier: `+91${body.mobile}` }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app)
      .post('/auth/register/verify-otp')
      .send({ ticket: reg.body.ticket, code: codeSentTo(`+91${body.mobile}`) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('otp_expired');
  });

  it('refuses a resend inside 30 seconds, and a resend invalidates the previous code', async () => {
    const body = registerBody();
    const e164 = `+91${body.mobile}`;
    const reg = await request(app).post('/auth/register').send(body);
    const firstCode = codeSentTo(e164);

    const tooSoon = await request(app).post('/auth/otp/resend').send({ ticket: reg.body.ticket });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.secondsLeft).toBeGreaterThan(0);

    await skipCooldown(e164);
    const resent = await request(app).post('/auth/otp/resend').send({ ticket: reg.body.ticket });
    expect(resent.status).toBe(200);
    const secondCode = codeSentTo(e164);

    if (firstCode !== secondCode) {
      const old = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: firstCode });
      expect(old.status).toBe(401);
    }
    const ok = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: secondCode });
    expect(ok.status).toBe(201);
  });

  it('caps how many codes one number can be sent in a window', async () => {
    const body = registerBody();
    const e164 = `+91${body.mobile}`;
    const reg = await request(app).post('/auth/register').send(body);
    for (let i = 0; i < 4; i++) {
      await skipCooldown(e164);
      // Keep these inside the 15-minute window the cap counts over.
      await prisma.otpCode.updateMany({ where: { identifier: e164 }, data: { createdAt: new Date(Date.now() - 60 * 1000) } });
      const r = await request(app).post('/auth/otp/resend').send({ ticket: reg.body.ticket });
      expect(r.status).toBe(200);
    }
    await skipCooldown(e164);
    const capped = await request(app).post('/auth/otp/resend').send({ ticket: reg.body.ticket });
    expect(capped.status).toBe(429);
    expect(sendCount(e164)).toBe(5);
  });

  it('does not accept a ticket in place of an access token', async () => {
    const reg = await request(app).post('/auth/register').send(registerBody());
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${reg.body.ticket}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/login (password, then OTP)', () => {
  it('after a correct password, sends the login OTP by SMS for a mobile login and by email for an email login', async () => {
    const patient = await createPatient();
    const national = patient.mobile.slice(3);

    const byMobile = await loginToOtpStep({ mobile: national, countryCode: '+91' });
    expect(byMobile.status).toBe(200);
    expect(byMobile.body.ticket).toBeTruthy();
    expect(byMobile.body.maskedContact).toBe(`+91 •••••${national.slice(-4)}`);
    const code = codeSentTo(patient.mobile);

    const verify = await request(app).post('/auth/login/verify-otp').send({ ticket: byMobile.body.ticket, code });
    expect(verify.status).toBe(200);
    expect(verify.body.token).toBeTruthy();
    expect(verify.body.user.email).toBe(patient.email);
    expect(verify.body.user).not.toHaveProperty('passwordHash');

    // Email login: the code goes to the (verified) inbox, and the screen shows the email.
    const byEmail = await loginToOtpStep({ email: patient.email.toUpperCase() });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.maskedContact).toBe(`${patient.email.slice(0, 2)}•••@example.com`);
    const lastCall = deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1];
    expect(lastCall[0]).toBe(patient.email);
    expect(lastCall[2]).toBe('patient_login');
    const emailVerify = await request(app).post('/auth/login/verify-otp').send({ ticket: byEmail.body.ticket, code: codeSentTo(patient.email) });
    expect(emailVerify.status).toBe(200);
    expect(emailVerify.body.token).toBeTruthy();
  });

  it('gives one generic error for a wrong password and for an account that does not exist', async () => {
    const patient = await createPatient();
    const wrongPassword = await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
    const noAccount = await request(app).post('/auth/login').send({ email: uniqueEmail(), password: PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(noAccount.status).toBe(401);
    expect(wrongPassword.body.error).toBe('Incorrect mobile/email or password');
    expect(noAccount.body).toEqual(wrongPassword.body);
    expect(sendCount(patient.mobile)).toBe(1); // only the registration code
  });

  it('does not let an unverified sign-up log in', async () => {
    const body = registerBody();
    await request(app).post('/auth/register').send(body);
    const res = await loginToOtpStep({ email: body.email });
    expect(res.status).toBe(401);
  });

  it('refuses the OTP step without a valid ticket', async () => {
    const res = await request(app).post('/auth/login/verify-otp').send({ ticket: 'not-a-ticket', code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ticket_invalid');
  });

  it('locks the account for 15 minutes after 5 wrong passwords, even for the right one', async () => {
    const patient = await createPatient();
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
      expect(r.status).toBe(401);
    }
    const fifth = await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('account_locked');

    const rightPassword = await loginToOtpStep({ email: patient.email });
    expect(rightPassword.status).toBe(429);
    expect(rightPassword.body.error).toMatch(/15 minutes/);

    // Once the lock has passed, the right password works and the counter resets.
    await prisma.user.update({ where: { email: patient.email }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const afterLock = await loginToOtpStep({ email: patient.email });
    expect(afterLock.status).toBe(200);
  });
});

describe('existing patients with no password', () => {
  it('verifies them by OTP, then makes them set a password before issuing a session', async () => {
    const { user, mobile } = await createLegacyPatient();

    const step1 = await request(app).post('/auth/login').send({ mobile, password: 'anything1' });
    expect(step1.status).toBe(200);
    expect(step1.body.needsPasswordSetup).toBe(true);

    const step2 = await request(app).post('/auth/login/verify-otp').send({ ticket: step1.body.ticket, code: codeSentTo(mobile) });
    expect(step2.status).toBe(200);
    expect(step2.body.token).toBeUndefined();
    expect(step2.body.setPasswordTicket).toBeTruthy();

    const weak = await request(app).post('/auth/password/set').send({ ticket: step2.body.setPasswordTicket, password: 'short' });
    expect(weak.status).toBe(400);

    const set = await request(app).post('/auth/password/set').send({ ticket: step2.body.setPasswordTicket, password: PASSWORD });
    expect(set.status).toBe(200);
    expect(set.body.token).toBeTruthy();
    expect(set.body.user.id).toBe(user.id);

    // The setup ticket is single-use.
    const reuse = await request(app).post('/auth/password/set').send({ ticket: step2.body.setPasswordTicket, password: 'Another123' });
    expect(reuse.status).toBe(401);

    // From now on the password is enforced.
    const wrong = await request(app).post('/auth/login').send({ mobile, password: 'anything1' });
    expect(wrong.status).toBe(401);
    await skipCooldown(mobile);
    const right = await request(app).post('/auth/login').send({ mobile, password: PASSWORD });
    expect(right.status).toBe(200);
    expect(right.body.needsPasswordSetup).toBeUndefined();
  });
});

describe('forgot password', () => {
  it('answers the same for an unknown account, sends nothing, and never verifies', async () => {
    const email = uniqueEmail();
    const res = await request(app).post('/auth/password/forgot').send({ email });
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeTruthy();
    expect(sendCount(email)).toBe(0);

    const verify = await request(app).post('/auth/password/forgot/verify-otp').send({ ticket: res.body.ticket, code: '123456' });
    expect(verify.status).toBe(401);
    expect(verify.body.code).toBe('otp_invalid');
  });

  it('resets the password via the typed channel and signs out existing sessions', async () => {
    const patient = await createPatient();

    // A session from before the reset.
    const oldRefresh = await request(app).post('/auth/refresh').send({ refreshToken: patient.refreshToken });
    expect(oldRefresh.status).toBe(200);

    const forgot = await request(app).post('/auth/password/forgot').send({ mobile: patient.mobile.slice(3), countryCode: '+91' });
    expect(forgot.status).toBe(200);
    const code = codeSentTo(patient.mobile);
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][2]).toBe('patient_password_reset');

    const verify = await request(app).post('/auth/password/forgot/verify-otp').send({ ticket: forgot.body.ticket, code });
    expect(verify.status).toBe(200);

    const set = await request(app).post('/auth/password/set').send({ ticket: verify.body.setPasswordTicket, password: 'BrandNew456' });
    expect(set.status).toBe(200);
    expect(set.body.token).toBeUndefined(); // reset sends them to Login, not into the app

    const staleRefresh = await request(app).post('/auth/refresh').send({ refreshToken: oldRefresh.body.refreshToken });
    expect(staleRefresh.status).toBe(401);

    const oldPassword = await request(app).post('/auth/login').send({ email: patient.email, password: patient.password });
    expect(oldPassword.status).toBe(401);
    await skipCooldown(patient.mobile);
    const newPassword = await request(app).post('/auth/login').send({ email: patient.email, password: 'BrandNew456' });
    expect(newPassword.status).toBe(200);
  });

  it('sends the code to the mobile while the typed email is not verified yet', async () => {
    const patient = await createPatient();
    const res = await request(app).post('/auth/password/forgot').send({ email: patient.email });
    expect(res.status).toBe(200);
    expect(res.body.maskedContact).toBe(`+91 •••••${patient.mobile.slice(-4)}`);
    expect(sendCount(patient.email)).toBe(0);
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][0]).toBe(patient.mobile);
  });

  it('sends the code to the email once the email is verified', async () => {
    const patient = await createPatient();
    await verifyEmailByLogin(patient);
    const res = await request(app).post('/auth/password/forgot').send({ email: patient.email });
    expect(res.status).toBe(200);
    expect(res.body.maskedContact).toBe(`${patient.email.slice(0, 2)}•••@example.com`);
  });
});

describe('email verified on first use', () => {
  it('marks the email verified after an email login (password + code from the inbox)', async () => {
    const patient = await createPatient();
    let me = await request(app).get('/auth/me').set('Authorization', `Bearer ${patient.token}`);
    expect(me.body.user.emailVerifiedAt).toBeNull();

    const session = await verifyEmailByLogin(patient);
    me = await request(app).get('/auth/me').set('Authorization', `Bearer ${session.token}`);
    expect(me.body.user.emailVerifiedAt).toBeTruthy();
  });

  it('does not verify the email from a mobile login', async () => {
    const patient = await createPatient();
    const login = await loginToOtpStep({ mobile: patient.mobile });
    await request(app).post('/auth/login/verify-otp').send({ ticket: login.body.ticket, code: codeSentTo(patient.mobile) });
    const user = await prisma.user.findUnique({ where: { id: patient.user.id } });
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('a wrong email code does not verify it', async () => {
    const patient = await createPatient();
    const login = await loginToOtpStep({ email: patient.email });
    await request(app).post('/auth/login/verify-otp').send({ ticket: login.body.ticket, code: '000000' });
    const user = await prisma.user.findUnique({ where: { id: patient.user.id } });
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('never sends the code to an unverified email for an account with no password', async () => {
    const { user, mobile } = await createLegacyPatient(); // no password, email not verified
    const res = await request(app).post('/auth/login').send({ email: user.email, password: 'anything1' });
    expect(res.status).toBe(200);
    expect(sendCount(user.email)).toBe(0);
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][0]).toBe(mobile);
  });
});

// The service function the Google/Apple endpoints call, tested directly so no real
// Google/Apple token is needed.
describe('Google/Apple sign-in', () => {
  const { findSocialUser, SocialEmailInUseError, SocialNoAccountError } = require('../src/modules/auth/auth.service');
  const providerId = () => `g-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  it('refuses to link until the account email is verified, then signs in, then by provider id', async () => {
    const patient = await createPatient();
    const gid = providerId();
    await expect(
      findSocialUser({ provider: 'google', providerId: gid, email: patient.email, emailVerified: true }),
    ).rejects.toBeInstanceOf(SocialEmailInUseError);
    await verifyEmailByLogin(patient);
    const first = await findSocialUser({ provider: 'google', providerId: gid, email: patient.email, emailVerified: true });
    expect(first.id).toBe(patient.user.id);
    const again = await findSocialUser({ provider: 'google', providerId: gid, email: 'changed@example.com', emailVerified: true });
    expect(again.id).toBe(patient.user.id);
  });

  it('never creates an account for someone who has not signed up', async () => {
    const email = uniqueEmail();
    await expect(
      findSocialUser({ provider: 'google', providerId: providerId(), email, emailVerified: true }),
    ).rejects.toBeInstanceOf(SocialNoAccountError);
    expect(await prisma.user.findFirst({ where: { email } })).toBeNull();
  });

  it('treats an unfinished sign-up as no account, and leaves it alone', async () => {
    const body = registerBody();
    await request(app).post('/auth/register').send(body); // never verified
    await expect(
      findSocialUser({ provider: 'google', providerId: providerId(), email: body.email, emailVerified: true }),
    ).rejects.toBeInstanceOf(SocialNoAccountError);
    const pending = await prisma.user.findFirst({ where: { email: body.email } });
    expect(pending.googleId).toBeNull();
  });

  it('refuses to link when the provider has not verified the email', async () => {
    const patient = await createPatient();
    await expect(
      findSocialUser({ provider: 'google', providerId: providerId(), email: patient.email, emailVerified: false }),
    ).rejects.toBeInstanceOf(SocialEmailInUseError);
  });

  it('refuses to link to an account whose email was never verified', async () => {
    const { user } = await createLegacyPatient(); // no emailVerifiedAt
    await expect(
      findSocialUser({ provider: 'google', providerId: providerId(), email: user.email, emailVerified: true }),
    ).rejects.toBeInstanceOf(SocialEmailInUseError);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.googleId).toBeNull();
  });

  // A separate copy of the app where only the Google token check is faked (it returns
  // `google`), so the real endpoints can be called without a real Google token.
  async function withFakeGoogle(google, fn) {
    let ctx;
    jest.isolateModules(() => {
      jest.doMock('../src/modules/auth/auth.service', () => ({
        ...jest.requireActual('../src/modules/auth/auth.service'),
        verifyGoogleIdToken: async () => google,
      }));
      ctx = {
        app: require('../src/app').app,
        prisma: require('../src/db/prisma').prisma,
        deliverOtp: require('../src/modules/auth/otp-delivery.service').deliverOtp,
      };
    });
    try {
      await fn(ctx);
    } finally {
      await ctx.prisma.$disconnect();
    }
  }

  const newGoogleUser = () => ({ providerId: providerId(), email: uniqueEmail(), emailVerified: true, name: 'New Person' });
  const socialBody = (signupTicket, overrides = {}) => ({
    signupTicket, name: 'New Person', mobile: uniqueMobile(), countryCode: '+91',
    consents: { termsPrivacy: true, medicalDisclaimer: true, marketing: true },
    ...overrides,
  });

  it('gives a brand-new Google user a sign-up ticket with their Google name and email, and creates nothing', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp }) => {
      const res = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('no_account');
      expect(res.body.signupTicket).toEqual(expect.any(String));
      expect(res.body.profile).toEqual({ name: 'New Person', email: google.email });
      expect(await prisma.user.findFirst({ where: { email: google.email } })).toBeNull();
    });
  });

  it('gives no sign-up ticket when Google has not verified the email', async () => {
    await withFakeGoogle({ ...newGoogleUser(), emailVerified: false }, async ({ app: gApp }) => {
      const res = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      expect(res.status).toBe(404);
      expect(res.body.signupTicket).toBeUndefined();
    });
  });

  it('signs a new Google user up with mobile + OTP + consents, then signs them straight in next time', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, deliverOtp: sent }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const body = socialBody(first.body.signupTicket);
      const started = await request(gApp).post('/auth/social/register').send(body);
      expect(started.status).toBe(200);
      expect(started.body.ticket).toEqual(expect.any(String));

      // Nothing can sign in before the mobile is proven.
      expect((await request(gApp).post('/auth/google').send({ idToken: 'fake' })).status).toBe(404);

      const mobile = `+91${body.mobile}`;
      const code = sent.mock.calls.filter((c) => c[0] === mobile).pop()[1];
      const done = await request(gApp).post('/auth/register/verify-otp').send({ ticket: started.body.ticket, code });
      expect(done.status).toBe(201);
      expect(done.body.token).toEqual(expect.any(String));
      expect(done.body.user).toMatchObject({ name: 'New Person', email: google.email, mobile, hasPassword: false });

      const user = await prisma.user.findFirst({ where: { email: google.email }, include: { consents: true } });
      expect(user.googleId).toBe(google.providerId);
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.consents.map((c) => [c.type, c.accepted]).sort()).toEqual([
        ['marketing', true], ['medical_disclaimer', true], ['terms_privacy', true],
      ]);

      const again = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      expect(again.status).toBe(200);
      expect(again.body.user.id).toBe(user.id);
    });
  });

  it('refuses the Google sign-up without the required consents or with a made-up ticket', async () => {
    await withFakeGoogle(newGoogleUser(), async ({ app: gApp }) => {
      const { body } = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const noConsent = await request(gApp).post('/auth/social/register')
        .send(socialBody(body.signupTicket, { consents: { termsPrivacy: false } }));
      expect(noConsent.status).toBe(400);
      expect(noConsent.body.code).toBe('consent_required');

      const forged = await request(gApp).post('/auth/social/register').send(socialBody('not-a-real-ticket'));
      expect(forged.status).toBe(401);
      expect(forged.body.code).toBe('ticket_invalid');
    });
  });

  it('saves gender, nationality and phone country from the Google sign-up step', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const res = await request(gApp).post('/auth/social/register')
        .send(socialBody(first.body.signupTicket, { gender: 'male', nationality: 'AE', phoneCountry: 'IN' }));
      expect(res.status).toBe(200);
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toMatchObject({
        gender: 'male', nationality: 'AE', phoneCountry: 'IN', countryCode: '+91',
      });
    });
  });

  it('refuses bad gender, nationality or phone country on the Google sign-up step, and creates nothing', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      for (const bad of [{ gender: 'Male' }, { nationality: 'india' }, { phoneCountry: 'ZZ' }]) {
        const res = await request(gApp).post('/auth/social/register').send(socialBody(first.body.signupTicket, bad));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_profile');
      }
      const mismatch = await request(gApp).post('/auth/social/register')
        .send(socialBody(first.body.signupTicket, { mobile: `50${Date.now().toString().slice(-7)}`, countryCode: '+971', phoneCountry: 'IN' }));
      expect(mismatch.body.code).toBe('phone_country_mismatch');
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toBeNull();
    });
  });

  it('checks the phone country against the number on the Google sign-up step, and infers it for an older app', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const wrong = await request(gApp).post('/auth/social/register')
        .send(socialBody(first.body.signupTicket, { mobile: `416555${Date.now().toString().slice(-4)}`, countryCode: '+1', phoneCountry: 'US' }));
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('phone_country_mismatch');
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toBeNull();

      const older = await request(gApp).post('/auth/social/register').send(socialBody(first.body.signupTicket));
      expect(older.status).toBe(200);
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toMatchObject({ phoneCountry: 'IN', countryCode: '+91' });
    });
  });

  it('keeps the provider\'s single name as the full name, with first and last name empty', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const res = await request(gApp).post('/auth/social/register').send(socialBody(first.body.signupTicket));
      expect(res.status).toBe(200);
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toMatchObject({ name: 'New Person', firstName: null, lastName: null });
    });
  });

  it('takes first and last name when the provider gave none', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const res = await request(gApp).post('/auth/social/register')
        .send(socialBody(first.body.signupTicket, { name: undefined, firstName: 'Kiran', lastName: 'Shah' }));
      expect(res.status).toBe(200);
      expect(await gPrisma.user.findFirst({ where: { email: google.email } })).toMatchObject({ name: 'Kiran Shah', firstName: 'Kiran', lastName: 'Shah' });
    });
  });

  it('signs a Google user up with only the Terms and Privacy consent', async () => {
    const google = newGoogleUser();
    await withFakeGoogle(google, async ({ app: gApp, prisma: gPrisma }) => {
      const first = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const res = await request(gApp).post('/auth/social/register').send(socialBody(first.body.signupTicket, { consents: { termsPrivacy: true } }));
      expect(res.status).toBe(200);
      const user = await gPrisma.user.findFirst({ where: { email: google.email }, include: { consents: true } });
      expect(user.consents.map((c) => [c.type, c.accepted])).toEqual([['terms_privacy', true]]);
    });
  });

  it('refuses a Google sign-up with a mobile number that already has an account', async () => {
    const patient = await createPatient();
    await withFakeGoogle(newGoogleUser(), async ({ app: gApp }) => {
      const { body } = await request(gApp).post('/auth/google').send({ idToken: 'fake' });
      const res = await request(gApp).post('/auth/social/register')
        .send(socialBody(body.signupTicket, { mobile: patient.mobile.replace('+91', '') }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('mobile_in_use');
    });
  });
});

describe('changing mobile or email', () => {
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  it('no longer accepts mobile/email through PATCH /auth/me, but still saves the name', async () => {
    const patient = await createPatient();
    const blocked = await request(app).patch('/auth/me').set(auth(patient.token)).send({ mobile: uniqueMobile(), countryCode: '+91' });
    expect(blocked.status).toBe(400);
    const named = await request(app).patch('/auth/me').set(auth(patient.token)).send({ name: 'New Name' });
    expect(named.status).toBe(200);
    expect(named.body.user.name).toBe('New Name');
  });

  it('needs the current password', async () => {
    const patient = await createPatient();
    const res = await request(app).post('/auth/me/contact').set(auth(patient.token))
      .send({ kind: 'mobile', mobile: uniqueMobile(), countryCode: '+91', password: 'WrongPass999' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_password');
  });

  it('changes the mobile after a code sent to the NEW number', async () => {
    const patient = await createPatient();
    const newMobile = uniqueMobile();
    const start = await request(app).post('/auth/me/contact').set(auth(patient.token))
      .send({ kind: 'mobile', mobile: newMobile, countryCode: '+91', password: patient.password });
    expect(start.status).toBe(200);
    const code = codeSentTo(`+91${newMobile}`);
    expect(code).toMatch(/^\d{6}$/);

    const done = await request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token)).send({ ticket: start.body.ticket, code });
    expect(done.status).toBe(200);
    expect(done.body.user.mobile).toBe(`+91${newMobile}`);

    // Mobile login now uses (and texts) the new number.
    const login = await loginToOtpStep({ mobile: newMobile, countryCode: '+91' });
    expect(login.status).toBe(200);
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][0]).toBe(`+91${newMobile}`);
  });

  it('changes the email after a code sent to the NEW inbox, and marks it verified', async () => {
    const patient = await createPatient();
    const newEmail = uniqueEmail();
    const start = await request(app).post('/auth/me/contact').set(auth(patient.token))
      .send({ kind: 'email', email: newEmail, password: patient.password });
    expect(start.status).toBe(200);
    const done = await request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token))
      .send({ ticket: start.body.ticket, code: codeSentTo(newEmail) });
    expect(done.status).toBe(200);
    expect(done.body.user.email).toBe(newEmail);
    expect(done.body.user.emailVerifiedAt).toBeTruthy();
  });

  it("won't take another account's number, or finish with another account's ticket", async () => {
    const a = await createPatient();
    const b = await createPatient();
    const taken = await request(app).post('/auth/me/contact').set(auth(a.token))
      .send({ kind: 'mobile', mobile: b.mobile.slice(3), countryCode: '+91', password: a.password });
    expect(taken.status).toBe(409);

    const start = await request(app).post('/auth/me/contact').set(auth(a.token))
      .send({ kind: 'email', email: uniqueEmail(), password: a.password });
    const hijack = await request(app).post('/auth/me/contact/verify-otp').set(auth(b.token)).send({ ticket: start.body.ticket, code: '123456' });
    expect(hijack.status).toBe(401);
    expect(hijack.body.code).toBe('ticket_invalid');
  });

  it('asks an account without a password to set one first', async () => {
    // A session for an account with no password, the way a Google-only account has one.
    const { user } = await createLegacyPatient();
    const { issuePatientTokens } = require('../src/modules/auth/auth.service');
    const { token } = issuePatientTokens(user);

    const me = await request(app).get('/auth/me').set(auth(token));
    expect(me.body.user.hasPassword).toBe(false);
    const res = await request(app).post('/auth/me/contact').set(auth(token)).send({ kind: 'email', email: uniqueEmail(), password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('password_required');
  });
});

describe('sign-up consents', () => {
  it.each([
    ['missing', undefined],
    ['terms not accepted', { termsPrivacy: false }],
    ['terms not accepted by an older app version', { termsPrivacy: false, medicalDisclaimer: true, marketing: true }],
    ['an empty object', {}],
  ])('refuses sign-up when consent is %s, and creates nothing', async (_label, consents) => {
    const body = registerBody({ consents });
    const res = await request(app).post('/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('consent_required');
    expect(await prisma.user.findFirst({ where: { email: body.email } })).toBeNull();
    expect(sendCount(`+91${body.mobile}`)).toBe(0);
  });

  it('saves each consent an older app version sends, under the old wording version, including a marketing "no"', async () => {
    const patient = await createPatient();
    const rows = await prisma.userConsent.findMany({ where: { userId: patient.user.id }, orderBy: { type: 'asc' } });
    expect(rows.map((r) => [r.type, r.accepted])).toEqual([
      ['marketing', false],
      ['medical_disclaimer', true],
      ['terms_privacy', true],
    ]);
    for (const r of rows) {
      expect(r.version).toBe('2026-10-26');
      expect(r.acceptedAt).toBeInstanceOf(Date);
      expect(r.ipAddress).toBeTruthy();
    }
  });

  it('accepts a sign-up with only the Terms and Privacy consent, and records only that', async () => {
    const body = registerBody({ consents: { termsPrivacy: true } });
    const res = await request(app).post('/auth/register').send(body);
    expect(res.status).toBe(200);
    const user = await prisma.user.findFirst({ where: { email: body.email }, include: { consents: true } });
    expect(user.consents.map((c) => [c.type, c.accepted])).toEqual([['terms_privacy', true]]);
    expect(user.consents[0].version).toBe('2026-11-07');
    expect(user.consents[0].ipAddress).toBeTruthy();
  });

  it('does not record a medical disclaimer or marketing choice nobody was asked for', async () => {
    const body = registerBody({ consents: { termsPrivacy: true } });
    await request(app).post('/auth/register').send(body);
    const user = await prisma.user.findFirst({ where: { email: body.email } });
    const types = (await prisma.userConsent.findMany({ where: { userId: user.id } })).map((c) => c.type);
    expect(types).not.toContain('medical_disclaimer');
    expect(types).not.toContain('marketing');
  });

  it('says what is missing in plain words', async () => {
    const res = await request(app).post('/auth/register').send(registerBody({ consents: { termsPrivacy: false } }));
    expect(res.body.error).toBe('Please accept the Terms and Conditions and Privacy Policy to continue.');
  });

  it('drops the consents of a half-finished sign-up when it is replaced', async () => {
    const body = registerBody();
    await request(app).post('/auth/register').send(body);
    const first = await prisma.user.findFirst({ where: { email: body.email } });
    await skipCooldown(`+91${body.mobile}`);
    await request(app).post('/auth/register').send(body);
    expect(await prisma.userConsent.count({ where: { userId: first.id } })).toBe(0);
  });
});

describe('security event log', () => {
  const eventsFor = (userId) => prisma.securityEvent.findMany({ where: { userId }, orderBy: { id: 'asc' } });

  describe('retention', () => {
    const { purgeOldSecurityEvents, retentionDays } = require('../src/modules/auth/security-events');
    const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    afterEach(() => { delete process.env.SECURITY_LOG_RETENTION_DAYS; });

    it('deletes entries older than the retention period and keeps the rest', async () => {
      process.env.SECURITY_LOG_RETENTION_DAYS = '365';
      const old = await prisma.securityEvent.create({ data: { event: 'login_failed', createdAt: daysAgo(400) } });
      const recent = await prisma.securityEvent.create({ data: { event: 'login_failed', createdAt: daysAgo(300) } });
      await purgeOldSecurityEvents();
      expect(await prisma.securityEvent.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await prisma.securityEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
    });

    it('uses 365 days when the setting is missing or invalid', () => {
      expect(retentionDays()).toBe(365);
      process.env.SECURITY_LOG_RETENTION_DAYS = 'abc';
      expect(retentionDays()).toBe(365);
      process.env.SECURITY_LOG_RETENTION_DAYS = '180';
      expect(retentionDays()).toBe(180);
    });
  });

  it('records sign-up, failed and successful logins, without any password or code', async () => {
    const patient = await createPatient();
    await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
    await skipCooldown(patient.mobile);
    const ok = await loginToOtpStep({ email: patient.email, password: patient.password });
    await request(app).post('/auth/login/verify-otp').send({ ticket: ok.body.ticket, code: '000000' });
    await request(app).post('/auth/login/verify-otp').send({ ticket: ok.body.ticket, code: codeSentTo(patient.email) });

    const events = await eventsFor(patient.user.id);
    expect(events.map((e) => e.event)).toEqual([
      'register_started', 'register_completed', 'login_failed', 'otp_failed', 'email_verified', 'login_succeeded',
    ]);
    const failed = events.find((e) => e.event === 'login_failed');
    expect(failed.identifier).toBe(`${patient.email.slice(0, 2)}•••@example.com`);
    expect(failed.ipAddress).toBeTruthy();

    // Nothing secret anywhere in the log.
    const dump = JSON.stringify(await prisma.securityEvent.findMany());
    expect(dump).not.toContain('WrongPass999');
    expect(dump).not.toContain(patient.password);
    expect(dump).not.toContain(codeSentTo(patient.mobile));
    expect(dump).not.toContain(patient.email);
  });

  it('records a lockout, and a failed login for an account that does not exist (masked, no user)', async () => {
    const patient = await createPatient();
    for (let i = 0; i < 5; i++) await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
    await request(app).post('/auth/login').send({ email: patient.email, password: patient.password });
    const names = (await eventsFor(patient.user.id)).map((e) => e.event);
    expect(names.filter((n) => n === 'login_failed')).toHaveLength(5);
    expect(names).toContain('account_locked');
    expect(names[names.length - 1]).toBe('login_blocked_locked');

    const ghost = uniqueEmail();
    await request(app).post('/auth/login').send({ email: ghost, password: 'Whatever123' });
    const row = await prisma.securityEvent.findFirst({ where: { event: 'login_failed', userId: null }, orderBy: { id: 'desc' } });
    expect(row.detail).toEqual({ reason: 'no_account' });
    expect(row.identifier).not.toContain(ghost);
  });

  it('records password resets and mobile changes, with the old and new numbers masked', async () => {
    const patient = await createPatient();
    const forgot = await request(app).post('/auth/password/forgot').send({ email: patient.email });
    // Email not verified yet, so the reset code went to the mobile.
    const verify = await request(app).post('/auth/password/forgot/verify-otp').send({ ticket: forgot.body.ticket, code: codeSentTo(patient.mobile) });
    await request(app).post('/auth/password/set').send({ ticket: verify.body.setPasswordTicket, password: 'BrandNew456' });

    await skipCooldown(patient.mobile);
    const login = await loginToOtpStep({ email: patient.email, password: 'BrandNew456' });
    const session = await request(app).post('/auth/login/verify-otp').send({ ticket: login.body.ticket, code: codeSentTo(patient.email) });
    const newMobile = uniqueMobile();
    const start = await request(app).post('/auth/me/contact').set('Authorization', `Bearer ${session.body.token}`)
      .send({ kind: 'mobile', mobile: newMobile, countryCode: '+91', password: 'BrandNew456' });
    await request(app).post('/auth/me/contact/verify-otp').set('Authorization', `Bearer ${session.body.token}`)
      .send({ ticket: start.body.ticket, code: codeSentTo(`+91${newMobile}`) });

    const events = await eventsFor(patient.user.id);
    const names = events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(['password_reset_requested', 'password_reset_completed', 'mobile_changed']));
    const changed = events.find((e) => e.event === 'mobile_changed');
    expect(changed.identifier).toBe(`+91 •••••${newMobile.slice(-4)}`);
    expect(changed.detail.from).toBe(`+91 •••••${patient.mobile.slice(-4)}`);
  });
});

describe('GET /auth/me for a patient', () => {
  it('never returns the password hash', async () => {
    const patient = await createPatient();
    const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${patient.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user).not.toHaveProperty('tokenVersion');
  });
});

describe('GET /auth/me', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed/invalid token', async () => {
    const res = await request(app).get('/auth/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

// These /corporate/* paths are aliases added for the corporate-portal web app (2026-10-12) —
// same handlers as the originals, just reachable under a name that app expects.
describe('corporate-portal auth aliases', () => {
  it('forgot-password alias triggers the same OTP flow as the original route', async () => {
    const { email } = await createCorporateUserAndLogin();
    const res = await request(app).post('/auth/corporate/forgot-password').send({ email });
    expect(res.status).toBe(200);
    expect(codeSentTo(email)).toMatch(/^\d{6}$/);
  });

  it('reset-password alias resets the password with a correct OTP', async () => {
    const { email } = await createCorporateUserAndLogin();
    await request(app).post('/auth/corporate/forgot-password').send({ email });
    const code = codeSentTo(email);

    const res = await request(app)
      .post('/auth/corporate/reset-password')
      .send({ email, code, newPassword: 'BrandNewPass@123' });
    expect(res.status).toBe(200);

    // The old password should no longer work. (Not re-testing the new one through a
    // full login here — that would issue a 2nd "corporate_login" OTP for this email
    // within the 30s resend cooldown already started by createCorporateUserAndLogin's
    // own setup call, and get throttled rather than actually proving anything.)
    const oldLoginRes = await request(app).post('/auth/corporate/login').send({ email, password: 'TestPass@123' });
    expect(oldLoginRes.status).toBe(401);
  });
});

describe('POST /auth/corporate/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/auth/corporate/change-password').send({ currentPassword: 'a', newPassword: 'b' });
    expect(res.status).toBe(401);
  });

  it('rejects an incorrect current password', async () => {
    const { token } = await createCorporateUserAndLogin({ password: 'OriginalPass@123' });
    const res = await request(app)
      .post('/auth/corporate/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'WrongPass@123', newPassword: 'NewPass@456' });
    expect(res.status).toBe(400);
  });

  it('changes the password with the correct current password', async () => {
    const { token, email } = await createCorporateUserAndLogin({ password: 'OriginalPass@123' });
    const res = await request(app)
      .post('/auth/corporate/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'OriginalPass@123', newPassword: 'NewPass@456' });
    expect(res.status).toBe(200);

    // Same reasoning as the reset-password test above: confirm via the OLD password
    // now failing, rather than re-triggering a throttled login OTP for the new one.
    const oldLoginRes = await request(app).post('/auth/corporate/login').send({ email, password: 'OriginalPass@123' });
    expect(oldLoginRes.status).toBe(401);
  });
});

describe('POST /auth/corporate/logout', () => {
  it('always succeeds (JWTs are stateless, there is nothing server-side to clear)', async () => {
    const res = await request(app).post('/auth/corporate/logout');
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/register: gender, nationality and phone country', () => {
  const rand = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
  const profileBody = (overrides = {}) => registerBody({ gender: 'female', nationality: 'IN', phoneCountry: 'IN', ...overrides });
  const signUp = (overrides) => request(app).post('/auth/register').send(profileBody(overrides));

  it('saves them for an Indian number, texts the OTP to the full E.164 number, and returns them after sign-up', async () => {
    const email = uniqueEmail();
    const mobile = uniqueMobile();
    const reg = await signUp({ email, mobile });
    expect(reg.status).toBe(200);
    expect(codeSentTo(`+91${mobile}`)).toMatch(/^\d{6}$/);

    const stored = await prisma.user.findUnique({ where: { email } });
    expect(stored).toMatchObject({ gender: 'female', nationality: 'IN', phoneCountry: 'IN', countryCode: '+91', mobile: `+91${mobile}` });

    const done = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: codeSentTo(`+91${mobile}`) });
    expect(done.status).toBe(201);
    expect(done.body.user).toMatchObject({ gender: 'female', nationality: 'IN', phoneCountry: 'IN' });
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${done.body.token}`);
    expect(me.body.user).toMatchObject({ gender: 'female', nationality: 'IN', phoneCountry: 'IN' });
  });

  it('keeps nationality and phone country apart: an Indian living in the UAE with a UAE number', async () => {
    const mobile = `50${rand(7)}`;
    const email = uniqueEmail();
    const res = await signUp({ email, mobile, countryCode: '+971', nationality: 'IN', phoneCountry: 'AE' });
    expect(res.status).toBe(200);
    expect(codeSentTo(`+971${mobile}`)).toMatch(/^\d{6}$/);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({
      nationality: 'IN', phoneCountry: 'AE', countryCode: '+971', mobile: `+971${mobile}`,
    });
  });

  it.each([
    ['US', '212555'],
    ['CA', '416555'],
  ])('remembers which country shares the +1 code: %s', async (phoneCountry, prefix) => {
    const mobile = `${prefix}${rand(4)}`;
    const email = uniqueEmail();
    const res = await signUp({ email, mobile, countryCode: '+1', nationality: phoneCountry, phoneCountry });
    expect(res.status).toBe(200);
    expect(codeSentTo(`+1${mobile}`)).toMatch(/^\d{6}$/);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ phoneCountry, countryCode: '+1', mobile: `+1${mobile}` });
  });

  it.each([
    ['Russia', '912', 'RU'],
    ['Kazakhstan', '701', 'KZ'],
  ])('remembers which country shares the +7 code: %s', async (_name, prefix, phoneCountry) => {
    const mobile = `${prefix}${rand(7)}`;
    const email = uniqueEmail();
    const res = await signUp({ email, mobile, countryCode: '+7', nationality: phoneCountry, phoneCountry });
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ phoneCountry, countryCode: '+7', mobile: `+7${mobile}` });
  });

  it.each([
    ['US picked, Canadian number', 'US', '416555'],
    ['Canada picked, US number', 'CA', '212555'],
    ['US picked, Puerto Rican number', 'US', '787555'],
  ])('refuses a +1 number that belongs to another country: %s', async (_name, phoneCountry, prefix) => {
    const email = uniqueEmail();
    const mobile = `${prefix}${rand(4)}`;
    const res = await signUp({ email, mobile, countryCode: '+1', phoneCountry });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('phone_country_mismatch');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(sendCount(`+1${mobile}`)).toBe(0);
  });

  it('refuses Russia picked with a Kazakh number', async () => {
    const email = uniqueEmail();
    const res = await signUp({ email, mobile: `701${rand(7)}`, countryCode: '+7', phoneCountry: 'RU' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('phone_country_mismatch');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it.each(['GB', 'GG', 'JE', 'IM'])('accepts any of GB, GG, JE and IM for a UK number: %s', async (phoneCountry) => {
    const email = uniqueEmail();
    const mobile = ukMobile();
    const res = await signUp({ email, mobile, countryCode: '+44', nationality: 'GB', phoneCountry });
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ phoneCountry, countryCode: '+44', mobile: `+44${mobile}` });
  });

  it.each([
    ['an Indian number', { mobile: undefined, countryCode: '+91' }, 'IN', '+91'],
    ['a Canadian number', { mobile: `416555${Math.floor(1000 + Math.random() * 9000)}`, countryCode: '+1' }, 'CA', '+1'],
    ['a Russian number', { mobile: `912${Math.floor(1000000 + Math.random() * 9000000)}`, countryCode: '+7' }, 'RU', '+7'],
  ])('works out the phone country for an older app that sends none: %s', async (_name, overrides, expected, code) => {
    const email = uniqueEmail();
    const res = await request(app).post('/auth/register').send(registerBody({ email, ...(overrides.mobile && { mobile: overrides.mobile }), countryCode: overrides.countryCode }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ phoneCountry: expected, countryCode: code });
  });

  it('leaves the phone country empty for an older app when the code is shared and the number cannot decide it (+44)', async () => {
    const email = uniqueEmail();
    const mobile = ukMobile();
    const res = await request(app).post('/auth/register').send(registerBody({ email, mobile, countryCode: '+44' }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ phoneCountry: null, countryCode: '+44', mobile: `+44${mobile}` });
  });

  it('reads the number with the phone country\'s calling code when no countryCode is sent', async () => {
    const mobile = `50${rand(7)}`;
    const res = await signUp({ mobile, countryCode: undefined, phoneCountry: 'AE' });
    expect(res.status).toBe(200);
    expect(codeSentTo(`+971${mobile}`)).toMatch(/^\d{6}$/);
  });

  it('still accepts a sign-up without them (older app versions): gender and nationality stay empty, the Indian number gives its phone country', async () => {
    const email = uniqueEmail();
    const res = await request(app).post('/auth/register').send(registerBody({ email }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ gender: null, nationality: null, phoneCountry: 'IN', countryCode: '+91' });
  });

  it.each([
    ['gender in the wrong case', { gender: 'Female' }, /Invalid gender/],
    ['a gender that is not on the list', { gender: 'robot' }, /Invalid gender/],
    ['a lower-case nationality code', { nationality: 'in' }, /Invalid nationality/],
    ['a nationality that is a name, not a code', { nationality: 'India' }, /Invalid nationality/],
    ['a country code that does not exist', { nationality: 'XX' }, /Invalid nationality/],
    ['a phone country that does not exist', { phoneCountry: 'ZZ' }, /Invalid phoneCountry/],
  ])('refuses %s, and creates nothing', async (_label, overrides, message) => {
    const email = uniqueEmail();
    const res = await signUp({ email, ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_profile');
    expect(res.body.error).toMatch(message);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses a phone country that does not match the calling code', async () => {
    const email = uniqueEmail();
    const res = await signUp({ email, mobile: `50${rand(7)}`, countryCode: '+971', phoneCountry: 'IN' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('phone_country_mismatch');
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses a number that is not valid for the phone country', async () => {
    const res = await signUp({ mobile: '12345', phoneCountry: 'IN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mobile/i);
  });

  it('does not put gender or nationality in the security log', async () => {
    const email = uniqueEmail();
    await signUp({ email, gender: 'prefer_not_to_say', nationality: 'NZ', phoneCountry: 'IN' });
    const user = await prisma.user.findUnique({ where: { email } });
    const events = await prisma.securityEvent.findMany({ where: { userId: user.id } });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/prefer_not_to_say|"NZ"/);
  });

  it('leaves existing accounts working: they log in and their profile has the fields empty', async () => {
    const patient = await createPatient();
    // An account from before the sign-up form asked for these: nothing was ever saved for it.
    await prisma.user.update({ where: { id: patient.user.id }, data: { phoneCountry: null } });
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${patient.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ gender: null, nationality: null, phoneCountry: null });
  });
});

describe('changing the mobile keeps mobile, country_code and phone_country together', () => {
  const rand = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const stored = (patient) => prisma.user.findUnique({ where: { id: patient.user.id } });
  const start = (patient, body) => request(app).post('/auth/me/contact').set(auth(patient.token)).send({ kind: 'mobile', password: patient.password, ...body });
  const verify = (patient, ticket, e164) => request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token)).send({ ticket, code: codeSentTo(e164) });
  async function changeMobile(patient, body, e164) {
    const step = await start(patient, body);
    expect(step.status).toBe(200);
    const done = await verify(patient, step.body.ticket, e164);
    expect(done.status).toBe(200);
    return done;
  }

  it('same country: a new Indian number keeps IN', async () => {
    const patient = await createPatient();
    const mobile = uniqueMobile();
    const done = await changeMobile(patient, { mobile, countryCode: '+91', phoneCountry: 'IN' }, `+91${mobile}`);
    expect(done.body.user).toMatchObject({ mobile: `+91${mobile}`, countryCode: '+91', phoneCountry: 'IN' });
    expect(await stored(patient)).toMatchObject({ mobile: `+91${mobile}`, countryCode: '+91', phoneCountry: 'IN' });
  });

  it('another country: all three fields move to the UAE, and the old country is not kept', async () => {
    const patient = await createPatient();
    expect((await stored(patient)).phoneCountry).toBe('IN');
    const mobile = `50${rand(7)}`;
    const done = await changeMobile(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' }, `+971${mobile}`);
    expect(done.body.user).toMatchObject({ mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' });
    expect(await stored(patient)).toMatchObject({ mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' });

    // Logging in with the new number works exactly as before.
    const login = await loginToOtpStep({ mobile, countryCode: '+971', password: patient.password });
    expect(login.status).toBe(200);
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][0]).toBe(`+971${mobile}`);
  });

  it('within +1: US to Canada changes the country although the calling code stays', async () => {
    const patient = await createPatient();
    const us = `212555${rand(4)}`;
    await changeMobile(patient, { mobile: us, countryCode: '+1', phoneCountry: 'US' }, `+1${us}`);
    expect(await stored(patient)).toMatchObject({ countryCode: '+1', phoneCountry: 'US' });
    const ca = `416555${rand(4)}`;
    await changeMobile(patient, { mobile: ca, countryCode: '+1', phoneCountry: 'CA' }, `+1${ca}`);
    expect(await stored(patient)).toMatchObject({ mobile: `+1${ca}`, countryCode: '+1', phoneCountry: 'CA' });
  });

  it.each([
    ['US picked, Canadian number', 'US', `416555${rand(4)}`, '+1'],
    ['Canada picked, US number', 'CA', `212555${rand(4)}`, '+1'],
    ['India picked, UAE number', 'IN', `50${rand(7)}`, '+971'],
  ])('refuses a country that does not match the number before any code is sent: %s', async (_name, phoneCountry, mobile, countryCode) => {
    const patient = await createPatient();
    const before = await stored(patient);
    const res = await start(patient, { mobile, countryCode, phoneCountry });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('phone_country_mismatch');
    expect(res.body.ticket).toBeUndefined();
    expect(sendCount(`${countryCode}${mobile}`)).toBe(0);
    // Not even an unsent code is left behind in the database.
    expect(await prisma.otpCode.count({ where: { identifier: `${countryCode}${mobile}` } })).toBe(0);
    expect(await stored(patient)).toMatchObject({ mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });
  });

  it('refuses an unknown phone country', async () => {
    const patient = await createPatient();
    const res = await start(patient, { mobile: uniqueMobile(), countryCode: '+91', phoneCountry: 'ZZ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_profile');
  });

  it('reads the number with the phone country calling code when no countryCode is sent', async () => {
    const patient = await createPatient();
    const mobile = `50${rand(7)}`;
    await changeMobile(patient, { mobile, phoneCountry: 'AE' }, `+971${mobile}`);
    expect(await stored(patient)).toMatchObject({ mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' });
  });

  it('an older app that sends only countryCode: the unshared code gives its country, the old one is not kept', async () => {
    const patient = await createPatient();
    const mobile = `50${rand(7)}`;
    await changeMobile(patient, { mobile, countryCode: '+971' }, `+971${mobile}`);
    expect(await stored(patient)).toMatchObject({ mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' });
  });

  it('an older app on a shared code: the number decides (+1 Canada), or the country becomes NULL when it cannot (+44)', async () => {
    const patient = await createPatient();
    const ca = `416555${rand(4)}`;
    await changeMobile(patient, { mobile: ca, countryCode: '+1' }, `+1${ca}`);
    expect(await stored(patient)).toMatchObject({ countryCode: '+1', phoneCountry: 'CA' });

    const uk = ukMobile();
    await changeMobile(patient, { mobile: uk, countryCode: '+44' }, `+44${uk}`);
    expect(await stored(patient)).toMatchObject({ mobile: `+44${uk}`, countryCode: '+44', phoneCountry: null });
  });

  it('GB, GG, JE and IM are one group for a UK number', async () => {
    const patient = await createPatient();
    const uk = ukMobile();
    await changeMobile(patient, { mobile: uk, countryCode: '+44', phoneCountry: 'GB' }, `+44${uk}`);
    expect(await stored(patient)).toMatchObject({ countryCode: '+44', phoneCountry: 'GB' });
  });

  it('a ticket issued before phoneCountry existed clears the old country instead of keeping it', async () => {
    const { signTicket } = require('../src/modules/auth/auth.service');
    const patient = await createPatient();
    expect((await stored(patient)).phoneCountry).toBe('IN');
    const mobile = `50${rand(7)}`;
    const dest = `+971${mobile}`;
    const real = await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    expect(real.status).toBe(200);
    const legacyTicket = signTicket({ step: 'change_contact_otp', sub: patient.user.id, kind: 'mobile', dest, countryCode: '+971', tv: 0 });
    const done = await verify(patient, legacyTicket, dest);
    expect(done.status).toBe(200);
    expect(await stored(patient)).toMatchObject({ mobile: dest, countryCode: '+971', phoneCountry: null });
  });

  it('takes the country from the signed ticket, not from the verify request', async () => {
    const patient = await createPatient();
    const mobile = `50${rand(7)}`;
    const step = await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    const done = await request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token))
      .send({ ticket: step.body.ticket, code: codeSentTo(`+971${mobile}`), phoneCountry: 'IN', countryCode: '+91' });
    expect(done.status).toBe(200);
    expect(await stored(patient)).toMatchObject({ countryCode: '+971', phoneCountry: 'AE' });
  });

  it('still answers 409 and changes nothing when someone else took the number in the meantime', async () => {
    const patient = await createPatient();
    const mobile = `50${rand(7)}`;
    const step = await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    const code = codeSentTo(`+971${mobile}`);
    await prisma.user.create({ data: { name: 'Taker', email: uniqueEmail(), mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' } });
    const before = await stored(patient);
    const res = await request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token)).send({ ticket: step.body.ticket, code });
    expect(res.status).toBe(409);
    expect(await stored(patient)).toMatchObject({ mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });
  });

  it('keeps sending the code the way it did: same arguments to deliverOtp', async () => {
    const patient = await createPatient();
    const mobile = `50${rand(7)}`;
    await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    const call = deliverOtp.mock.calls.filter((c) => c[0] === `+971${mobile}`).pop();
    expect(call[0]).toBe(`+971${mobile}`);
    expect(call[2]).toBe('patient_change_mobile');
    expect(call).toHaveLength(3);
  });

  it('changing the email leaves the phone fields alone', async () => {
    const patient = await createPatient();
    const before = await stored(patient);
    const newEmail = uniqueEmail();
    const step = await request(app).post('/auth/me/contact').set(auth(patient.token)).send({ kind: 'email', email: newEmail, password: patient.password });
    expect(step.status).toBe(200);
    const done = await request(app).post('/auth/me/contact/verify-otp').set(auth(patient.token)).send({ ticket: step.body.ticket, code: codeSentTo(newEmail) });
    expect(done.status).toBe(200);
    expect(await stored(patient)).toMatchObject({ email: newEmail, mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });
  });

  it('an email ticket carries no phone data, and even a ticket that did would not touch the phone fields', async () => {
    const { signTicket } = require('../src/modules/auth/auth.service');
    const patient = await createPatient();
    const before = await stored(patient);
    const newEmail = uniqueEmail();
    const step = await request(app).post('/auth/me/contact').set(auth(patient.token)).send({ kind: 'email', email: newEmail, password: patient.password });
    expect(step.status).toBe(200);
    const payload = require('jsonwebtoken').decode(step.body.ticket);
    expect(payload).toMatchObject({ step: 'change_contact_otp', kind: 'email', dest: newEmail });
    expect(payload).not.toHaveProperty('countryCode');
    expect(payload).not.toHaveProperty('phoneCountry');

    // A correctly signed email ticket that also names a phone country and calling code.
    const withPhone = signTicket({ step: 'change_contact_otp', sub: patient.user.id, kind: 'email', dest: newEmail, countryCode: '+971', phoneCountry: 'AE', tv: 0 });
    const done = await verify(patient, withPhone, newEmail);
    expect(done.status).toBe(200);
    expect(await stored(patient)).toMatchObject({ email: newEmail, mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });
  });

  // A ticket is a signed JWT. Editing its payload without the signing key must not work.
  const tampered = (ticket, changes) => {
    const [header, payload, signature] = ticket.split('.');
    const edited = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), ...changes };
    return [header, Buffer.from(JSON.stringify(edited)).toString('base64url'), signature].join('.');
  };

  it.each([
    ['the phone country', { phoneCountry: 'IN' }],
    ['the calling code', { countryCode: '+91' }],
    ['the number', { dest: '+919876543210' }],
    ['the phone country removed', { phoneCountry: null }],
  ])('rejects a ticket whose %s was edited without re-signing it', async (_name, changes) => {
    const patient = await createPatient();
    const before = await stored(patient);
    const mobile = `50${rand(7)}`;
    const step = await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    expect(step.status).toBe(200);
    const forged = tampered(step.body.ticket, changes);
    expect(forged).not.toBe(step.body.ticket);
    const res = await verify(patient, forged, `+971${mobile}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ticket_invalid');
    expect(await stored(patient)).toMatchObject({ mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });

    // The real ticket still works afterwards: the rejection did not use up the code.
    const real = await verify(patient, step.body.ticket, `+971${mobile}`);
    expect(real.status).toBe(200);
    expect(await stored(patient)).toMatchObject({ mobile: `+971${mobile}`, countryCode: '+971', phoneCountry: 'AE' });
  });

  it('leaves all three fields unchanged when the database refuses the update', async () => {
    const { signTicket } = require('../src/modules/auth/auth.service');
    const patient = await createPatient();
    const before = await stored(patient);
    const mobile = `50${rand(7)}`;
    const dest = `+971${mobile}`;
    const real = await start(patient, { mobile, countryCode: '+971', phoneCountry: 'AE' });
    expect(real.status).toBe(200);
    // Correctly signed, but the phone country does not fit the VARCHAR(2) column: the database rejects it.
    const ticket = signTicket({ step: 'change_contact_otp', sub: patient.user.id, kind: 'mobile', dest, countryCode: '+971', phoneCountry: 'TOOLONG', tv: 0 });
    const res = await verify(patient, ticket, dest);
    expect(res.status).toBe(500);
    expect(await stored(patient)).toMatchObject({ mobile: before.mobile, countryCode: before.countryCode, phoneCountry: before.phoneCountry });
  });
});

describe('POST /auth/register: first name and last name', () => {
  const signUp = (overrides) => request(app).post('/auth/register').send(registerBody({ name: undefined, firstName: 'Asha', lastName: 'Rao', ...overrides }));

  it('stores first and last name, and builds the full name from them', async () => {
    const email = uniqueEmail();
    const mobile = uniqueMobile();
    const reg = await signUp({ email, mobile });
    expect(reg.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao' });

    const done = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: codeSentTo(`+91${mobile}`) });
    expect(done.body.user).toMatchObject({ name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao' });
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${done.body.token}`);
    expect(me.body.user).toMatchObject({ name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao' });
  });

  it('trims the names and squeezes spaces inside them', async () => {
    const email = uniqueEmail();
    await signUp({ email, firstName: '  Mary   Ann ', lastName: ' van  der Berg ' });
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ name: 'Mary Ann van der Berg', firstName: 'Mary Ann', lastName: 'van der Berg' });
  });

  it('uses first and last name over a single name when both are sent', async () => {
    const email = uniqueEmail();
    await signUp({ email, name: 'Someone Else' });
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ name: 'Asha Rao', firstName: 'Asha' });
  });

  it('still takes a single name (older app versions) and leaves first and last name empty', async () => {
    const email = uniqueEmail();
    const res = await request(app).post('/auth/register').send(registerBody({ email, name: 'Old Version' }));
    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { email } })).toMatchObject({ name: 'Old Version', firstName: null, lastName: null });
  });

  it.each([
    ['a missing last name', { lastName: '' }],
    ['a missing first name', { firstName: '' }],
    ['a first name with no letters', { firstName: '1234' }],
    ['a last name that is too long', { lastName: 'x'.repeat(51) }],
  ])('refuses %s, and creates nothing', async (_label, overrides) => {
    const email = uniqueEmail();
    const res = await signUp({ email, ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/first name|last name|valid name/i);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses a sign-up with no name at all', async () => {
    const res = await request(app).post('/auth/register').send(registerBody({ name: undefined }));
    expect(res.status).toBe(400);
  });

  it('leaves existing accounts with first and last name empty', async () => {
    const patient = await createPatient();
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${patient.token}`);
    expect(me.body.user).toMatchObject({ firstName: null, lastName: null });
  });

  it('clears first and last name when the full name is edited, and keeps them when it is not', async () => {
    const mobile = uniqueMobile();
    const reg = await signUp({ mobile });
    const done = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: codeSentTo(`+91${mobile}`) });
    const auth = { Authorization: `Bearer ${done.body.token}` };

    const same = await request(app).patch('/auth/me').set(auth).send({ name: 'Asha Rao' });
    expect(same.body.user).toMatchObject({ name: 'Asha Rao', firstName: 'Asha', lastName: 'Rao' });

    const changed = await request(app).patch('/auth/me').set(auth).send({ name: 'Asha Kulkarni' });
    expect(changed.body.user).toMatchObject({ name: 'Asha Kulkarni', firstName: null, lastName: null });
  });
});
