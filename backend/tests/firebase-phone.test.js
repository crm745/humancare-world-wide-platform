// PHONE_OTP_PROVIDER=firebase: mobile codes are sent and checked by Firebase in the app,
// and the app sends us Firebase's ID token instead of the code. firebase-admin is
// replaced by a stand-in whose "tokens" describe what Firebase would have verified:
//   "phone:+919876543210"  a fresh phone sign-in for that number
//   "stale:+91…"           the same, but the SMS was confirmed 20 minutes ago
//   "google:+91…"          a token from a non-phone sign-in
//   anything else          rejected by Firebase
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('firebase-admin/app', () => ({ getApps: () => [{}], initializeApp: jest.fn(), cert: jest.fn() }));
const mockVerifyIdToken = jest.fn(async (token) => {
  const [kind, phone] = String(token).split(':');
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'phone') return { firebase: { sign_in_provider: 'phone' }, phone_number: phone, auth_time: now };
  if (kind === 'stale') return { firebase: { sign_in_provider: 'phone' }, phone_number: phone, auth_time: now - 20 * 60 };
  if (kind === 'google') return { firebase: { sign_in_provider: 'google.com' }, phone_number: phone, auth_time: now };
  const err = new Error('Decoding Firebase ID token failed.');
  err.code = 'auth/argument-error';
  throw err;
});
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mockVerifyIdToken }) }));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { deliverOtp } = require('../src/modules/auth/otp-delivery.service');

const PASSWORD = 'TestPass123';
const CONSENTS = { termsPrivacy: true, medicalDisclaimer: true, marketing: false };
const uniqueMobile = () => `9${Date.now().toString().slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
const uniqueEmail = () => `fb-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
const smsSentTo = (e164) => deliverOtp.mock.calls.filter((c) => c[0] === e164).length;

beforeAll(() => { process.env.PHONE_OTP_PROVIDER = 'firebase'; });
afterAll(async () => {
  delete process.env.PHONE_OTP_PROVIDER;
  await prisma.$disconnect();
});

async function registerViaFirebase() {
  const national = uniqueMobile();
  const mobile = `+91${national}`;
  const email = uniqueEmail();
  const reg = await request(app).post('/auth/register')
    .send({ name: 'Firebase User', email, mobile: national, countryCode: '+91', password: PASSWORD, consents: CONSENTS });
  const done = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, firebaseIdToken: `phone:${mobile}` });
  return { reg, done, mobile, national, email, token: done.body.token };
}

describe('sign-up with Firebase phone verification', () => {
  it('sends no SMS itself, tells the app to use Firebase, and finishes with a matching proof', async () => {
    const { reg, done, mobile } = await registerViaFirebase();
    expect(reg.status).toBe(200);
    expect(reg.body.phoneVerification).toBe('firebase');
    expect(reg.body.phoneNumber).toBe(mobile);
    expect(reg.body.maskedContact).toBe(`+91 •••••${mobile.slice(-4)}`);
    expect(smsSentTo(mobile)).toBe(0);
    expect(done.status).toBe(201);
    expect(done.body.token).toBeTruthy();
    expect(done.body.user.isVerified).toBe(true);
  });

  it.each([
    ['a proof for a different number', (m) => `phone:+919999999999${m.slice(-1)}`, 'otp_invalid'],
    ['a stale proof', (m) => `stale:${m}`, 'otp_expired'],
    ['a non-phone sign-in', (m) => `google:${m}`, 'otp_invalid'],
    ['a forged token', () => 'not-a-real-token', 'otp_invalid'],
  ])('rejects %s', async (_label, makeToken, expectedCode) => {
    const national = uniqueMobile();
    const mobile = `+91${national}`;
    const reg = await request(app).post('/auth/register')
      .send({ name: 'Firebase User', email: uniqueEmail(), mobile: national, countryCode: '+91', password: PASSWORD, consents: CONSENTS });
    const res = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, firebaseIdToken: makeToken(mobile) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(expectedCode);
    const user = await prisma.user.findUnique({ where: { mobile } });
    expect(user.isVerified).toBe(false);
  });

  it('does not accept a 6-digit code in place of the Firebase proof', async () => {
    const national = uniqueMobile();
    const reg = await request(app).post('/auth/register')
      .send({ name: 'Firebase User', email: uniqueEmail(), mobile: national, countryCode: '+91', password: PASSWORD, consents: CONSENTS });
    const res = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: '123456' });
    expect(res.status).toBe(401);
  });

  it('leaves resending to the app', async () => {
    const national = uniqueMobile();
    const reg = await request(app).post('/auth/register')
      .send({ name: 'Firebase User', email: uniqueEmail(), mobile: national, countryCode: '+91', password: PASSWORD, consents: CONSENTS });
    const res = await request(app).post('/auth/otp/resend').send({ ticket: reg.body.ticket });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('resend_in_app');
  });
});

describe('login and password reset with Firebase', () => {
  it('mobile login: password, then a Firebase proof for that number', async () => {
    const { mobile, national } = await registerViaFirebase();
    const step = await request(app).post('/auth/login').send({ mobile: national, countryCode: '+91', password: PASSWORD });
    expect(step.status).toBe(200);
    expect(step.body.phoneVerification).toBe('firebase');
    expect(step.body.phoneNumber).toBe(mobile);
    const done = await request(app).post('/auth/login/verify-otp').send({ ticket: step.body.ticket, firebaseIdToken: `phone:${mobile}` });
    expect(done.status).toBe(200);
    expect(done.body.token).toBeTruthy();
  });

  it('email login still uses an email code (not Firebase)', async () => {
    const { email } = await registerViaFirebase();
    const step = await request(app).post('/auth/login').send({ email, password: PASSWORD });
    expect(step.status).toBe(200);
    expect(step.body.phoneVerification).toBeUndefined();
    expect(deliverOtp.mock.calls[deliverOtp.mock.calls.length - 1][0]).toBe(email);
  });

  it('wrong password never reaches the Firebase step', async () => {
    const { national } = await registerViaFirebase();
    const step = await request(app).post('/auth/login').send({ mobile: national, countryCode: '+91', password: 'Wrong12345' });
    expect(step.status).toBe(401);
    expect(step.body.phoneNumber).toBeUndefined();
  });

  it('forgot password by mobile goes through Firebase', async () => {
    const { mobile, national } = await registerViaFirebase();
    const step = await request(app).post('/auth/password/forgot').send({ mobile: national, countryCode: '+91' });
    expect(step.body.phoneVerification).toBe('firebase');
    const done = await request(app).post('/auth/password/forgot/verify-otp').send({ ticket: step.body.ticket, firebaseIdToken: `phone:${mobile}` });
    expect(done.status).toBe(200);
    expect(done.body.setPasswordTicket).toBeTruthy();
  });

  it('forgot password by an unverified email asks for the mobile instead of revealing it', async () => {
    const { email, mobile } = await registerViaFirebase();
    const res = await request(app).post('/auth/password/forgot').send({ email });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('use_mobile');
    expect(JSON.stringify(res.body)).not.toContain(mobile.slice(-6));
  });
});

describe('changing the mobile with Firebase', () => {
  it('needs a Firebase proof for the NEW number', async () => {
    const { token, mobile } = await registerViaFirebase();
    const newNational = uniqueMobile();
    const newMobile = `+91${newNational}`;
    const auth = { Authorization: `Bearer ${token}` };
    const step = await request(app).post('/auth/me/contact').set(auth)
      .send({ kind: 'mobile', mobile: newNational, countryCode: '+91', password: PASSWORD });
    expect(step.body.phoneVerification).toBe('firebase');
    expect(step.body.phoneNumber).toBe(newMobile);

    const withOld = await request(app).post('/auth/me/contact/verify-otp').set(auth).send({ ticket: step.body.ticket, firebaseIdToken: `phone:${mobile}` });
    expect(withOld.status).toBe(401);
    const withNew = await request(app).post('/auth/me/contact/verify-otp').set(auth).send({ ticket: step.body.ticket, firebaseIdToken: `phone:${newMobile}` });
    expect(withNew.status).toBe(200);
    expect(withNew.body.user.mobile).toBe(newMobile);
  });

  it('in Firebase mode too, the picked country is checked before any proof is asked for and then saved with the number', async () => {
    const { token } = await registerViaFirebase();
    const auth = { Authorization: `Bearer ${token}` };
    const uae = `50${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

    const wrong = await request(app).post('/auth/me/contact').set(auth)
      .send({ kind: 'mobile', mobile: uae, countryCode: '+971', phoneCountry: 'IN', password: PASSWORD });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('phone_country_mismatch');
    expect(wrong.body.ticket).toBeUndefined();

    const step = await request(app).post('/auth/me/contact').set(auth)
      .send({ kind: 'mobile', mobile: uae, countryCode: '+971', phoneCountry: 'AE', password: PASSWORD });
    expect(step.status).toBe(200);
    expect(step.body.phoneVerification).toBe('firebase');
    expect(step.body.phoneNumber).toBe(`+971${uae}`);
    const done = await request(app).post('/auth/me/contact/verify-otp').set(auth).send({ ticket: step.body.ticket, firebaseIdToken: `phone:+971${uae}` });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ mobile: `+971${uae}`, countryCode: '+971', phoneCountry: 'AE' });
  });
});
