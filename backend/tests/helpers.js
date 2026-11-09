// Shared helpers so every test file doesn't re-implement "create a logged-in patient".
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { deliverOtp } = require('../src/modules/auth/otp-delivery.service');

// A valid 10-digit Indian mobile (registration validates numbers per country now).
function uniqueMobile() {
  return `9${Date.now().toString().slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
}
function uniqueEmail(tag = 'test') {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

function codeSentTo(identifier) {
  const call = deliverOtp.mock.calls.find((c) => c[0] === identifier);
  return call?.[call.length > 0 ? 1 : 0];
}

// Registers a brand-new patient through the real password + OTP flow and returns their
// token. `mobile` comes back in E.164, the form it's stored and sent to in.
async function createPatient({ name = 'Test Patient', password = 'TestPass123' } = {}) {
  const mobile = `+91${uniqueMobile()}`;
  const email = uniqueEmail('patient');
  const reg = await request(app).post('/auth/register').send({
    name, email, mobile, countryCode: '+91', password,
    consents: { termsPrivacy: true, medicalDisclaimer: true, marketing: false },
  });
  const res = await request(app).post('/auth/register/verify-otp').send({ ticket: reg.body.ticket, code: codeSentTo(mobile) });
  return { token: res.body.token, refreshToken: res.body.refreshToken, user: res.body.user, mobile, email, password };
}

// Creates a corporate + corporate login directly (there's no public corporate sign-up endpoint —
// real corporate accounts are created by an admin), then logs in through the real
// password+OTP flow to get a token, same as the app does.
async function createCorporateUserAndLogin({ companyName = 'Test Corporate Co', type = 'corporate', password = 'TestPass@123' } = {}) {
  const corporate = await prisma.corporate.create({ data: { companyName, type } });
  const email = uniqueEmail('corporate');
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.corporateUser.create({ data: { corporateId: corporate.id, email, passwordHash } });

  await request(app).post('/auth/corporate/login').send({ email, password });
  const code = codeSentTo(email);
  const res = await request(app).post('/auth/corporate/otp/verify').send({ email, code });
  return { token: res.body.token, corporateUser: res.body.corporateUser, corporate, email };
}

async function createAdminAndLogin({ password = 'TestAdminPass@123', role = 'admin' } = {}) {
  const email = uniqueEmail('admin');
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.adminUser.create({ data: { name: 'Test Admin', email, passwordHash, role } });
  // This helper hands out a legacy password-login Admin token, for suites that need an Admin session for some
  // other feature. With ADMIN_PASSKEY_ENFORCEMENT on (the Admin Lock rule, and the value in .env.test.example)
  // the login is refused AND every later request with such a token is rejected (admin-session.middleware.js),
  // so the setting is switched off for the rest of the calling test file (Jest gives each file its own copy of
  // process.env, so this never reaches another suite). Suites that test enforcement itself do not use this helper.
  delete process.env.ADMIN_PASSKEY_ENFORCEMENT;
  const res = await request(app).post('/admin/login').send({ email, password });
  return { token: res.body.token, email };
}

module.exports = {
  uniqueMobile,
  uniqueEmail,
  codeSentTo,
  createPatient,
  createCorporateUserAndLogin,
  createAdminAndLogin,
};
