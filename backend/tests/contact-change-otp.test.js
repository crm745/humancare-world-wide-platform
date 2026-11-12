// Changing the mobile or email is OTP-only: the new value, then a code sent to the NEW value. No current password and
// no code to the old contact, for password, Google and Apple accounts alike. Everything else about the flow is
// unchanged: signed-in account from the token, validation, uniqueness, one-time code with an attempt cap, resend
// cooldown, expiry, security events.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { deliverOtp } = require('../src/modules/auth/otp-delivery.service');
const { issuePatientTokens } = require('../src/modules/auth/auth.service');
const { createPatient, createCorporateUserAndLogin } = require('./helpers');

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const rand = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
const newMobile = () => `9${Date.now().toString().slice(-6)}${rand(3)}`; // national, valid Indian number
const newEmail = () => `otp-only-${Date.now()}-${rand(6)}@example.com`;
const stored = (id) => prisma.user.findUnique({ where: { id }, omit: { passwordHash: false } });
const codeSentTo = (identifier) => {
  const calls = deliverOtp.mock.calls.filter((c) => c[0] === identifier);
  return calls[calls.length - 1]?.[1];
};
const skipCooldown = (identifier) => prisma.otpCode.updateMany({ where: { identifier }, data: { createdAt: new Date(Date.now() - 60 * 1000) } });
const start = (token, body) => request(app).post('/auth/me/contact').set(auth(token)).send(body);
const verify = (token, ticket, code) => request(app).post('/auth/me/contact/verify-otp').set(auth(token)).send({ ticket, code });
const events = (userId) => prisma.securityEvent.findMany({ where: { userId }, orderBy: { id: 'asc' } });

// A Google or Apple account: no password at all, and a session the way the app has one.
async function socialPatient(provider) {
  const stamp = `${Date.now()}-${rand(6)}`;
  const user = await prisma.user.create({
    data: { name: `${provider} User`, email: newEmail(), mobile: `+91${newMobile()}`, countryCode: '+91', isVerified: true, [`${provider}Id`]: `${provider}-${stamp}` },
  });
  const { token } = issuePatientTokens(user);
  return { user, token };
}

describe('no password is asked for', () => {
  it('a password account changes its email with the new value only', async () => {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email });
    expect(step.status).toBe(200);
    expect(step.body.ticket).toBeTruthy();
    const done = await verify(patient.token, step.body.ticket, codeSentTo(email));
    expect(done.status).toBe(200);
    expect(done.body.user.email).toBe(email);
    expect(done.body.user.emailVerifiedAt).toBeTruthy();
  });

  it('a password account changes its mobile with the new value only', async () => {
    const patient = await createPatient();
    const national = newMobile();
    const step = await start(patient.token, { kind: 'mobile', mobile: national, countryCode: '+91' });
    expect(step.status).toBe(200);
    const done = await verify(patient.token, step.body.ticket, codeSentTo(`+91${national}`));
    expect(done.status).toBe(200);
    expect(done.body.user.mobile).toBe(`+91${national}`);
  });

  it.each(['google', 'apple'])('a %s account with no password can change its email', async (provider) => {
    const { user, token } = await socialPatient(provider);
    expect((await stored(user.id)).passwordHash).toBeNull();
    const email = newEmail();
    const step = await start(token, { kind: 'email', email });
    expect(step.status).toBe(200);
    const done = await verify(token, step.body.ticket, codeSentTo(email));
    expect(done.status).toBe(200);
    expect(done.body.user.email).toBe(email);
    expect((await stored(user.id)).email).toBe(email);
  });

  it.each(['google', 'apple'])('a %s account with no password can change its mobile', async (provider) => {
    const { user, token } = await socialPatient(provider);
    const national = newMobile();
    const step = await start(token, { kind: 'mobile', mobile: national, countryCode: '+91' });
    expect(step.status).toBe(200);
    const done = await verify(token, step.body.ticket, codeSentTo(`+91${national}`));
    expect(done.status).toBe(200);
    expect((await stored(user.id)).mobile).toBe(`+91${national}`);
  });

  it('a password sent anyway is ignored: a wrong one is not refused, and no lockout counter moves', async () => {
    const patient = await createPatient();
    for (let i = 0; i < 7; i += 1) {
      const res = await start(patient.token, { kind: 'email', email: newEmail(), password: 'definitely-wrong' });
      expect(res.status).toBe(200);
      expect(res.body.code).not.toBe('invalid_password');
    }
    const row = await stored(patient.user.id);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe('the code goes to the NEW contact only, and nothing changes before it is verified', () => {
  it('delivers one code, to the new email, never to the old email or mobile', async () => {
    const patient = await createPatient();
    const before = deliverOtp.mock.calls.length;
    const email = newEmail();
    await start(patient.token, { kind: 'email', email });
    const sent = deliverOtp.mock.calls.slice(before);
    expect(sent.map((c) => c[0])).toEqual([email]);
    expect(sent.some((c) => c[0] === patient.email || c[0] === patient.mobile)).toBe(false);
  });

  it('delivers one code, to the new mobile, never to the old mobile or email', async () => {
    const patient = await createPatient();
    const before = deliverOtp.mock.calls.length;
    const national = newMobile();
    await start(patient.token, { kind: 'mobile', mobile: national, countryCode: '+91' });
    const sent = deliverOtp.mock.calls.slice(before);
    expect(sent.map((c) => c[0])).toEqual([`+91${national}`]);
  });

  it('the account keeps its old email and mobile until the code is verified', async () => {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email });
    expect(step.status).toBe(200);
    const row = await stored(patient.user.id);
    expect(row.email).toBe(patient.email);
    expect(row.mobile).toBe(patient.mobile);
  });

  it('the code is stored only as a hash', async () => {
    const patient = await createPatient();
    const email = newEmail();
    await start(patient.token, { kind: 'email', email });
    const code = codeSentTo(email);
    const record = await prisma.otpCode.findFirst({ where: { identifier: email }, orderBy: { createdAt: 'desc' } });
    expect(record.codeHash).not.toBe(code);
    expect(record.codeHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(record)).not.toContain(code);
  });
});

describe('the code: wrong, expired, reused, capped', () => {
  async function pending() {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email });
    return { patient, email, ticket: step.body.ticket, code: codeSentTo(email) };
  }
  const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

  it('a wrong code is refused and changes nothing', async () => {
    const { patient, ticket, code } = await pending();
    const res = await verify(patient.token, ticket, wrongCode(code));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('otp_invalid');
    expect(res.body.attemptsLeft).toBe(4);
    expect((await stored(patient.user.id)).email).toBe(patient.email);
  });

  it('five wrong codes lock that code: the right one no longer works', async () => {
    const { patient, ticket, code } = await pending();
    let last;
    for (let i = 0; i < 5; i += 1) last = await verify(patient.token, ticket, wrongCode(code));
    expect(last.body.code).toBe('otp_locked');
    const right = await verify(patient.token, ticket, code);
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('otp_locked');
    expect((await stored(patient.user.id)).email).toBe(patient.email);
  });

  it('wrong codes do not count as failed logins or lock the account', async () => {
    const { patient, ticket, code } = await pending();
    for (let i = 0; i < 5; i += 1) await verify(patient.token, ticket, wrongCode(code));
    const row = await stored(patient.user.id);
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    const login = await request(app).post('/auth/login').send({ email: patient.email, password: patient.password });
    expect(login.status).toBe(200);
  });

  it('an expired code is refused and changes nothing', async () => {
    const { patient, email, ticket, code } = await pending();
    await prisma.otpCode.updateMany({ where: { identifier: email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(patient.token, ticket, code);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('otp_expired');
    expect((await stored(patient.user.id)).email).toBe(patient.email);
  });

  it('a code works once: the same ticket and code a second time is refused', async () => {
    const { patient, email, ticket, code } = await pending();
    expect((await verify(patient.token, ticket, code)).status).toBe(200);
    const again = await verify(patient.token, ticket, code);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('otp_missing');
    expect((await stored(patient.user.id)).email).toBe(email);
  });

  it('a second request for the same new contact right away is throttled, and sends no second code', async () => {
    const patient = await createPatient();
    const email = newEmail();
    await start(patient.token, { kind: 'email', email });
    const before = deliverOtp.mock.calls.length;
    const again = await start(patient.token, { kind: 'email', email });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('otp_throttled');
    expect(again.body.secondsLeft).toBeGreaterThan(0);
    expect(deliverOtp.mock.calls.length).toBe(before);
  });

  it('after the cooldown a new code can be requested, and the old code stops working', async () => {
    const { patient, email, ticket, code } = await pending();
    await skipCooldown(email);
    const second = await start(patient.token, { kind: 'email', email });
    expect(second.status).toBe(200);
    const fresh = codeSentTo(email);
    expect(fresh).not.toBe(code);
    expect((await verify(patient.token, ticket, code)).status).toBe(401);
    expect((await verify(patient.token, second.body.ticket, fresh)).status).toBe(200);
  });
});

describe('what the new value must be', () => {
  it('an email or mobile that another account already has is refused (409) and not sent a code', async () => {
    const a = await createPatient();
    const b = await createPatient();
    const before = deliverOtp.mock.calls.length;
    const email = await start(a.token, { kind: 'email', email: b.email });
    expect(email.status).toBe(409);
    const mobile = await start(a.token, { kind: 'mobile', mobile: b.mobile.slice(3), countryCode: '+91' });
    expect(mobile.status).toBe(409);
    expect(deliverOtp.mock.calls.length).toBe(before);
    expect((await stored(a.user.id)).email).toBe(a.email);
  });

  it('the refusal is a security event that never carries the full address or number', async () => {
    const a = await createPatient();
    const b = await createPatient();
    await start(a.token, { kind: 'email', email: b.email });
    const failed = (await events(a.user.id)).filter((e) => e.event === 'contact_change_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toEqual({ kind: 'email', reason: 'already_in_use' });
    expect(JSON.stringify(failed[0])).not.toContain(b.email);
  });

  it('an invalid email, an invalid mobile and a disposable email are refused (400)', async () => {
    const patient = await createPatient();
    const before = deliverOtp.mock.calls.length;
    expect((await start(patient.token, { kind: 'email', email: 'not-an-email' })).status).toBe(400);
    expect((await start(patient.token, { kind: 'mobile', mobile: '123', countryCode: '+91' })).status).toBe(400);
    expect((await start(patient.token, { kind: 'email', email: `x${rand(5)}@mailinator.com` })).status).toBe(400);
    expect((await start(patient.token, { kind: 'phone', email: newEmail() })).status).toBe(400);
    expect((await start(patient.token, {})).status).toBe(400);
    expect(deliverOtp.mock.calls.length).toBe(before);
  });

  it('the account\'s own current email or mobile is refused as "already yours"', async () => {
    const patient = await createPatient();
    expect((await start(patient.token, { kind: 'email', email: patient.email })).status).toBe(400);
    expect((await start(patient.token, { kind: 'mobile', mobile: patient.mobile.slice(3), countryCode: '+91' })).status).toBe(400);
  });
});

describe('who can do it, and for which account', () => {
  it('needs a signed-in patient: no token, a bad token and a corporate token are refused', async () => {
    expect((await request(app).post('/auth/me/contact').send({ kind: 'email', email: newEmail() })).status).toBe(401);
    expect((await start('garbage', { kind: 'email', email: newEmail() })).status).toBe(401);
    const corporate = await createCorporateUserAndLogin();
    expect([401, 403]).toContain((await start(corporate.token, { kind: 'email', email: newEmail() })).status);
    expect((await request(app).post('/auth/me/contact/verify-otp').send({ ticket: 'x', code: '123456' })).status).toBe(401);
  });

  it('the account is the signed-in one: ids in the body change nothing about who is edited', async () => {
    const a = await createPatient();
    const b = await createPatient();
    const email = newEmail();
    const step = await start(a.token, { kind: 'email', email, userId: b.user.id, id: b.user.id, sub: b.user.id, user: { id: b.user.id } });
    expect(step.status).toBe(200);
    const done = await verify(a.token, step.body.ticket, codeSentTo(email));
    expect(done.status).toBe(200);
    expect((await stored(a.user.id)).email).toBe(email);
    expect((await stored(b.user.id)).email).toBe(b.email);
  });

  it('another account cannot finish a change it did not start', async () => {
    const a = await createPatient();
    const b = await createPatient();
    const email = newEmail();
    const step = await start(a.token, { kind: 'email', email });
    const hijack = await verify(b.token, step.body.ticket, codeSentTo(email));
    expect(hijack.status).toBe(401);
    expect(hijack.body.code).toBe('ticket_invalid');
    expect((await stored(a.user.id)).email).toBe(a.email);
    expect((await stored(b.user.id)).email).toBe(b.email);
  });

  it('the body cannot carry other changes along: only the new contact is applied', async () => {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email, name: 'Hacked', isVerified: false, passwordHash: 'x', mobile: '+910000000000' });
    await verify(patient.token, step.body.ticket, codeSentTo(email));
    const row = await stored(patient.user.id);
    expect(row.email).toBe(email);
    expect(row.name).toBe('Test Patient');
    expect(row.mobile).toBe(patient.mobile);
    expect(row.isVerified).toBe(true);
  });
});

describe('concurrency', () => {
  it('two verifications at the same moment with the same ticket and code apply the change once', async () => {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email });
    const code = codeSentTo(email);
    const results = await Promise.all([verify(patient.token, step.body.ticket, code), verify(patient.token, step.body.ticket, code), verify(patient.token, step.body.ticket, code)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(2);
    expect((await stored(patient.user.id)).email).toBe(email);
    const changed = (await events(patient.user.id)).filter((e) => e.event === 'email_changed');
    expect(changed).toHaveLength(1);
  });

  it('two pending changes: a ticket and code only ever apply their own new value', async () => {
    const patient = await createPatient();
    const first = newEmail();
    const second = newEmail();
    const one = await start(patient.token, { kind: 'email', email: first });
    const two = await start(patient.token, { kind: 'email', email: second });
    const codeOne = codeSentTo(first);
    const codeTwo = codeSentTo(second);
    // the second ticket with the first code does nothing; the first ticket with its own code applies the first value only
    expect((await verify(patient.token, two.body.ticket, codeOne)).status).toBe(401);
    expect((await stored(patient.user.id)).email).toBe(patient.email);
    expect((await verify(patient.token, one.body.ticket, codeOne)).status).toBe(200);
    expect((await stored(patient.user.id)).email).toBe(first);
    // finishing the other one later sets that one: each change is its own, never a mix
    expect((await verify(patient.token, two.body.ticket, codeTwo)).status).toBe(200);
    expect((await stored(patient.user.id)).email).toBe(second);
  });

  it('two accounts verifying the same new email at once: one gets it, the other is told it is in use', async () => {
    const a = await createPatient();
    const b = await createPatient();
    const email = newEmail();
    const stepA = await start(a.token, { kind: 'email', email });
    const codeA = codeSentTo(email);
    await skipCooldown(email);
    const stepB = await start(b.token, { kind: 'email', email });
    const codeB = codeSentTo(email);
    const [ra, rb] = await Promise.all([verify(a.token, stepA.body.ticket, codeA), verify(b.token, stepB.body.ticket, codeB)]);
    const owners = [(await stored(a.user.id)).email, (await stored(b.user.id)).email].filter((e) => e === email);
    expect(owners).toHaveLength(1);
    expect([ra.status, rb.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
  });
});

describe('security events', () => {
  it('a successful change is recorded with masked values, and a wrong code is recorded without the code', async () => {
    const patient = await createPatient();
    const email = newEmail();
    const step = await start(patient.token, { kind: 'email', email });
    const code = codeSentTo(email);
    await verify(patient.token, step.body.ticket, code === '000000' ? '111111' : '000000');
    await verify(patient.token, step.body.ticket, code);
    const log = await events(patient.user.id);
    expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(['otp_failed', 'email_changed']));
    const failed = log.find((e) => e.event === 'otp_failed' && e.detail && e.detail.step === 'contact_change');
    expect(failed).toBeTruthy();
    const everything = JSON.stringify(log);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(email);
    expect(everything).not.toContain(patient.email);
    expect(everything).not.toMatch(/password/i);
  });
});

describe('what did not change', () => {
  it('login lockout still works: five wrong passwords lock the account', async () => {
    const patient = await createPatient();
    let last;
    for (let i = 0; i < 5; i += 1) last = await request(app).post('/auth/login').send({ email: patient.email, password: 'WrongPass999' });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('account_locked');
    const right = await request(app).post('/auth/login').send({ email: patient.email, password: patient.password });
    expect(right.status).toBe(429);
  });

  it('the password-reset flow still works', async () => {
    const patient = await createPatient();
    const forgot = await request(app).post('/auth/password/forgot').send({ email: patient.email });
    expect(forgot.status).toBe(200);
    expect(forgot.body.ticket).toBeTruthy();
  });
});
