// Patient "Delete account" (account retirement): POST /auth/me/delete/start and /confirm. PATIENT accounts only. The account is retired (anonymised, every sign-in
// and token refused at once), NOT deleted: its requests, cases, documents and consents stay, and nothing is sent to or removed from Bitrix24 or the upload folder.
// Needs the test database (migration 20261118100000_user_deleted_at).
// No password is asked for at any step: step 1 sends a code to the account's own contact, and step 2 needs that code, the step-1 ticket and the explicit confirmation.
// (This file was updated for the password-free flow WITHOUT being run: like every database-backed suite it empties humancare_test, which was not authorised.)
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/modules/bitrix/bitrix.service', () => ({
  createLead: jest.fn().mockResolvedValue(12345),
  sendMedicalReportToBitrix: jest.fn().mockResolvedValue(true),
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient, createCorporateUserAndLogin } = require('./helpers');
const { deliverOtp } = require('../src/modules/auth/otp-delivery.service');
const { createLead, sendMedicalReportToBitrix } = require('../src/modules/bitrix/bitrix.service');
const { UPLOAD_DIR } = require('../src/middleware/upload.middleware');

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const start = (token, body = {}) => request(app).post('/auth/me/delete/start').set(auth(token)).send(body);
const confirm = (token, body) => request(app).post('/auth/me/delete/confirm').set(auth(token)).send(body);
// The code the server last "sent" for this account's deletion (the delivery service is mocked).
const deleteCode = (identifier) => {
  const calls = deliverOtp.mock.calls.filter((c) => c[0] === identifier && c[2] === 'patient_delete_account');
  return calls.length ? calls[calls.length - 1][1] : undefined;
};
const deleteCodesSent = () => deliverOtp.mock.calls.filter((c) => c[2] === 'patient_delete_account').length;
const hospital = { serviceType: 'Hospitalization Assistance', serviceKey: 'hospital', patientName: 'John Doe', origin: 'Pune', destination: 'Pune', description: 'Needs a bed' };
const newRequest = (token, extra = {}) => request(app).post('/requests').set(auth(token)).send({ ...hospital, ...extra });
// A patient who has finished everything: their only request is completed (so nothing blocks deletion).
async function patientWithCompletedRequest() {
  const patient = await createPatient();
  const created = await newRequest(patient.token);
  await prisma.serviceRequest.update({ where: { id: created.body.request.id }, data: { status: 'completed' } });
  return { ...patient, requestId: created.body.request.id };
}
// The code goes to the verified email, or to the mobile when the email was never verified (the test sign-up verifies the mobile).
const destOf = (patient) => patient.mobile;
async function retire(patient) {
  const first = await start(patient.token);
  expect(first.status).toBe(200);
  return confirm(patient.token, { ticket: first.body.ticket, code: deleteCode(destOf(patient)), confirm: true });
}

describe('who may use it', () => {
  it('needs a signed-in patient: no token is 401, and a corporate account is refused (403) on both steps', async () => {
    expect((await request(app).post('/auth/me/delete/start').send({})).status).toBe(401);
    expect((await request(app).post('/auth/me/delete/confirm').send({})).status).toBe(401);
    const corporate = await createCorporateUserAndLogin();
    expect((await start(corporate.token)).status).toBe(403);
    expect((await confirm(corporate.token, { ticket: 'x', code: '123456', confirm: true })).status).toBe(403);
    expect(await prisma.corporateUser.count({ where: { email: corporate.email } })).toBe(1);
  });
});

describe('step 1: no password is asked for', () => {
  it('an account with a password starts the deletion with no password: a code is sent to its own contact and nothing else changes', async () => {
    const patient = await createPatient();
    const before = deleteCodesSent();
    const res = await start(patient.token); // no password sent
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ticket: expect.any(String), maskedContact: expect.any(String) });
    expect(res.body.code).toBeUndefined();
    expect(deleteCodesSent()).toBe(before + 1);
    expect(deleteCode(destOf(patient))).toMatch(/^\d{6}$/);
    expect(await prisma.securityEvent.count({ where: { userId: patient.user.id, event: 'account_delete_started' } })).toBe(1);
    expect(await prisma.securityEvent.count({ where: { userId: patient.user.id, event: 'account_delete_failed' } })).toBe(0);
    const started = await prisma.securityEvent.findFirst({ where: { userId: patient.user.id, event: 'account_delete_started' } });
    expect(started.detail).toEqual({ method: 'code' });
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
  });

  it('a password in the request is neither required nor checked: a wrong one cannot block the flow, and a right one is not needed or logged', async () => {
    const patient = await createPatient();
    for (const body of [{}, { password: 'WrongPass999' }, { password: patient.password }, { password: '' }]) {
      const res = await start(patient.token, body);
      expect({ body, status: res.status }).toEqual({ body, status: 200 });
      expect(res.body.code).not.toBe('password_required');
      expect(res.body.code).not.toBe('invalid_password');
    }
    expect(await prisma.securityEvent.count({ where: { userId: patient.user.id, event: 'account_delete_failed' } })).toBe(0);
    const logged = JSON.stringify(await prisma.securityEvent.findMany({ where: { userId: patient.user.id } }));
    expect(logged).not.toContain('WrongPass999');
    expect(logged).not.toContain(patient.password);
    // and a wrong password never counts towards the sign-in lockout here
    expect(await prisma.user.findUnique({ where: { id: patient.user.id } })).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('an account without a password (Google, Apple or older OTP-only) starts and finishes the same way', async () => {
    const patient = await createPatient();
    await prisma.user.update({ where: { id: patient.user.id }, data: { passwordHash: null, googleId: `google-${patient.user.id}` } });
    const first = await start(patient.token);
    expect(first.status).toBe(200);
    const done = await confirm(patient.token, { ticket: first.body.ticket, code: deleteCode(destOf(patient)), confirm: true });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ deleted: true });
    expect(await prisma.user.findUnique({ where: { id: patient.user.id }, omit: { passwordHash: false } })).toMatchObject({ googleId: null, passwordHash: null });
  });

  it('an account locked out by failed logins still cannot start a deletion (429), with no code sent', async () => {
    const patient = await createPatient();
    await prisma.user.update({ where: { id: patient.user.id }, data: { lockedUntil: new Date(Date.now() + 10 * 60 * 1000) } });
    const before = deleteCodesSent();
    const res = await start(patient.token);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('account_locked');
    expect(deleteCodesSent()).toBe(before);
  });
});

describe('the code is mandatory, and goes only to the account\'s own contact', () => {
  it('nothing is deleted by step 1 alone, or by step 2 without the code', async () => {
    const patient = await createPatient();
    const first = await start(patient.token);
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    expect((await confirm(patient.token, { ticket: first.body.ticket, confirm: true })).status).toBe(400); // no code
    expect((await confirm(patient.token, { confirm: true })).status).toBe(400); // no ticket and no code
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
  });

  it('a verified email is where the code goes when there is one', async () => {
    const patient = await createPatient();
    await prisma.user.update({ where: { id: patient.user.id }, data: { emailVerifiedAt: new Date() } });
    expect((await start(patient.token)).status).toBe(200);
    expect(deleteCode(patient.email)).toMatch(/^\d{6}$/);
    expect(deleteCode(patient.mobile)).toBeUndefined();
  });

  it('an email that was never verified falls back to the registered mobile', async () => {
    const patient = await createPatient();
    await prisma.user.update({ where: { id: patient.user.id }, data: { emailVerifiedAt: null } });
    expect((await start(patient.token)).status).toBe(200);
    expect(deleteCode(patient.mobile)).toMatch(/^\d{6}$/);
    expect(deleteCode(patient.email)).toBeUndefined();
  });

  it('never sends a code to anyone but the signed-in account (the destination comes from the account, not the request)', async () => {
    const patient = await createPatient();
    const res = await start(patient.token, { dest: '+919000000001', email: 'attacker@example.com', mobile: '+919000000001', contact: 'attacker@example.com' });
    expect(res.status).toBe(200);
    expect(deliverOtp.mock.calls.filter((c) => c[2] === 'patient_delete_account').every((c) => c[0] !== '+919000000001' && c[0] !== 'attacker@example.com')).toBe(true);
    expect(deleteCode(destOf(patient))).toBeDefined();
  });

  it('a wrong code, an expired code and a code that was already used are all refused, and the account stays', async () => {
    const patient = await createPatient();
    const first = await start(patient.token);
    const code = deleteCode(destOf(patient));
    // wrong
    expect((await confirm(patient.token, { ticket: first.body.ticket, code: code === '000000' ? '111111' : '000000', confirm: true })).status).toBe(401);
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    // expired: the stored code's life is over (the code itself is right)
    await prisma.otpCode.updateMany({ where: { identifier: destOf(patient), purpose: 'patient_delete_account' }, data: { expiresAt: new Date(Date.now() - 60 * 1000) } });
    expect((await confirm(patient.token, { ticket: first.body.ticket, code, confirm: true })).status).toBe(401);
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    // used: a fresh code works once; the second use (same ticket, same code) is refused and cannot delete again
    const second = await start(patient.token);
    const fresh = deleteCode(destOf(patient));
    const done = await confirm(patient.token, { ticket: second.body.ticket, code: fresh, confirm: true });
    expect(done.status).toBe(200);
    expect((await confirm(patient.token, { ticket: second.body.ticket, code: fresh, confirm: true })).status).toBeGreaterThanOrEqual(401);
    expect(await prisma.securityEvent.count({ where: { userId: patient.user.id, event: 'account_deleted' } })).toBe(1);
  });
});

describe('the confirmation step', () => {
  it('needs the explicit confirmation before it even looks at the code, so a missing confirmation never burns the code', async () => {
    const patient = await createPatient();
    const first = await start(patient.token);
    const code = deleteCode(destOf(patient));
    for (const confirmValue of [undefined, false, 'true', 1, 'DELETE']) {
      const res = await confirm(patient.token, { ticket: first.body.ticket, code, confirm: confirmValue });
      expect({ value: confirmValue, status: res.status, code: res.body.code }).toEqual({ value: confirmValue, status: 400, code: 'confirmation_required' });
    }
    expect((await confirm(patient.token, { ticket: first.body.ticket, code, confirm: true })).status).toBe(200);
  });

  it('refuses a wrong code, a missing ticket or code, a garbage ticket, and another account\'s ticket', async () => {
    const patient = await createPatient();
    const other = await createPatient();
    const first = await start(patient.token);
    const code = deleteCode(destOf(patient));
    expect((await confirm(patient.token, { ticket: first.body.ticket, code: '000000'.replace(/./g, code === '000000' ? '1' : '0'), confirm: true })).status).toBe(401);
    expect((await confirm(patient.token, { confirm: true })).status).toBe(400);
    expect((await confirm(patient.token, { ticket: first.body.ticket, confirm: true })).status).toBe(400);
    expect((await confirm(patient.token, { ticket: 'not-a-ticket', code, confirm: true })).status).toBe(401);
    // the other patient cannot use this ticket, and this patient's ticket cannot retire the other account
    expect((await confirm(other.token, { ticket: first.body.ticket, code, confirm: true })).status).toBe(401);
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: other.user.id } })).deletedAt).toBeNull();
  });

  it('a ticket from another step (login, contact change) cannot be used here', async () => {
    const patient = await createPatient();
    const { signTicket } = require('../src/modules/auth/auth.service');
    const wrongStep = signTicket({ step: 'login_otp', sub: patient.user.id, dest: patient.mobile });
    expect((await confirm(patient.token, { ticket: wrongStep, code: '123456', confirm: true })).status).toBe(401);
  });

  it('the code can be resent for this step', async () => {
    const patient = await createPatient();
    const first = await start(patient.token);
    const before = deleteCodesSent();
    const resent = await request(app).post('/auth/otp/resend').send({ ticket: first.body.ticket });
    expect([200, 429]).toContain(resent.status); // 429 only when the resend cooldown is still running
    if (resent.status === 200) expect(deleteCodesSent()).toBe(before + 1);
  });
});

describe('retirement: what changes and what is kept', () => {
  it('anonymises the account and ends every session at once', async () => {
    const patient = await patientWithCompletedRequest();
    await prisma.userConsent.create({ data: { userId: patient.user.id, type: 'terms_privacy', accepted: true, version: 'test' } });
    await prisma.notification.create({ data: { recipientType: 'patient', recipientId: patient.user.id, title: 'Update', body: 'Your request moved on' } });
    const before = await prisma.user.findUnique({ where: { id: patient.user.id } });
    const res = await retire(patient);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    const after = await prisma.user.findUnique({ where: { id: patient.user.id }, omit: { passwordHash: false } });
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(after).toMatchObject({
      name: 'Deleted account', firstName: null, lastName: null, mobile: null, gender: null, nationality: null, phoneCountry: null, passwordHash: null, googleId: null, appleId: null,
      pushToken: null, isVerified: false, emailVerifiedAt: null, failedLoginCount: 0, lockedUntil: null,
    });
    expect(after.email).toMatch(/^deleted-\d+-[0-9a-f]{12}@deleted\.invalid$/);
    expect(after.email).not.toBe(before.email);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    // the person's own inbox and old login codes are gone; their consents (the proof of what they agreed to) are kept
    expect(await prisma.notification.count({ where: { recipientType: 'patient', recipientId: patient.user.id } })).toBe(0);
    expect(await prisma.otpCode.count({ where: { identifier: { in: [before.email, before.mobile] } } })).toBe(0);
    expect(await prisma.userConsent.count({ where: { userId: patient.user.id } })).toBeGreaterThan(0);
    // audited, with no secret in it
    const event = await prisma.securityEvent.findFirst({ where: { userId: patient.user.id, event: 'account_deleted' } });
    expect(event).toBeTruthy();
    expect(JSON.stringify(event)).not.toContain(patient.password);
    expect(JSON.stringify(event)).not.toContain(before.email);
  });

  it('keeps the requests, the cases, the documents and the uploaded file, and sends nothing to (or removes nothing from) Bitrix24', async () => {
    createLead.mockClear();
    sendMedicalReportToBitrix.mockClear();
    const patient = await createPatient();
    const created = await newRequest(patient.token);
    const upload = await request(app).post(`/requests/me/${created.body.request.id}/documents`).set(auth(patient.token))
      .attach('file', Buffer.from('%PDF-1.4 keep me'), { filename: 'report.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    await prisma.serviceRequest.update({ where: { id: created.body.request.id }, data: { status: 'completed' } });
    const row = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: { include: { documents: true } } } });
    const stored = path.join(UPLOAD_DIR, path.basename(row.case.documents[0].fileUrl));
    expect(fs.existsSync(stored)).toBe(true);
    createLead.mockClear();
    sendMedicalReportToBitrix.mockClear();

    expect((await retire(patient)).status).toBe(200);

    const kept = await prisma.serviceRequest.findUnique({ where: { id: created.body.request.id }, include: { case: { include: { documents: true } } } });
    expect(kept).toMatchObject({ userId: patient.user.id, patientName: 'John Doe', serviceKey: 'hospital', status: 'completed' });
    expect(kept.case).toBeTruthy();
    expect(kept.case.documents.map((d) => d.name)).toEqual(['report.pdf']);
    expect(fs.existsSync(stored)).toBe(true);
    expect(createLead).not.toHaveBeenCalled();
    expect(sendMedicalReportToBitrix).not.toHaveBeenCalled();
  });

  it('does not touch any other patient', async () => {
    const patient = await patientWithCompletedRequest();
    const other = await createPatient();
    await newRequest(other.token);
    expect((await retire(patient)).status).toBe(200);
    expect((await request(app).get('/auth/me').set(auth(other.token))).status).toBe(200);
    expect((await request(app).get('/requests/me').set(auth(other.token))).body.requests).toHaveLength(1);
    expect((await prisma.user.findUnique({ where: { id: other.user.id } })).deletedAt).toBeNull();
  });
});

describe('after retirement: nothing works any more', () => {
  it('an access token the person still holds is refused AT ONCE (not after 15 minutes), on every patient route', async () => {
    const patient = await patientWithCompletedRequest();
    expect((await request(app).get('/auth/me').set(auth(patient.token))).status).toBe(200);
    expect((await retire(patient)).status).toBe(200);
    for (const route of ['/auth/me', '/requests/me', '/requests/me/documents', '/notifications']) {
      const res = await request(app).get(route).set(auth(patient.token));
      expect({ route, status: res.status }).toEqual({ route, status: 401 });
      expect(res.body.error).toBe('Your session has ended. Please log in again.');
    }
    expect((await newRequest(patient.token)).status).toBe(401);
    expect((await request(app).patch('/auth/me').set(auth(patient.token)).send({ name: 'Someone' })).status).toBe(401);
    expect((await start(patient.token)).status).toBe(401);
  });

  it('the refresh token no longer refreshes', async () => {
    const patient = await patientWithCompletedRequest();
    expect((await request(app).post('/auth/refresh').send({ refreshToken: patient.refreshToken })).status).toBe(200);
    expect((await retire(patient)).status).toBe(200);
    const res = await request(app).post('/auth/refresh').send({ refreshToken: patient.refreshToken });
    expect(res.status).toBe(401);
  });

  it('the old email, mobile and password cannot sign in, and the retired row cannot be reached through any login', async () => {
    const patient = await patientWithCompletedRequest();
    expect((await retire(patient)).status).toBe(200);
    for (const identity of [{ email: patient.email }, { mobile: patient.mobile }]) {
      const res = await request(app).post('/auth/login').send({ ...identity, password: patient.password });
      expect({ identity, status: res.status }).toEqual({ identity, status: 401 });
    }
    const placeholder = (await prisma.user.findUnique({ where: { id: patient.user.id } })).email;
    expect((await request(app).post('/auth/login').send({ email: placeholder, password: patient.password })).status).toBe(401);
  });

  it('a second confirmation with the old session is refused, and the same email can sign up again as a new account', async () => {
    const patient = await patientWithCompletedRequest();
    const first = await start(patient.token);
    const body = { ticket: first.body.ticket, code: deleteCode(destOf(patient)), confirm: true };
    expect((await confirm(patient.token, body)).status).toBe(200);
    expect((await confirm(patient.token, body)).status).toBe(401);
    const register = await request(app).post('/auth/register').send({
      name: 'New Person', email: patient.email, mobile: patient.mobile, countryCode: '+91', password: 'AnotherPass123',
      consents: { termsPrivacy: true, medicalDisclaimer: true, marketing: false },
    });
    expect(register.status).toBe(200);
    expect(await prisma.user.count({ where: { id: patient.user.id } })).toBe(1); // the retired row is still there, untouched by the new sign-up
  });
});

describe('requests still in progress', () => {
  it('refuses at the first step, before any code is sent, with a clear message, and records it for Operations', async () => {
    const patient = await createPatient();
    await newRequest(patient.token);
    await newRequest(patient.token);
    const before = deleteCodesSent();
    const res = await start(patient.token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'active_requests', activeRequests: 2 });
    expect(res.body.error).toMatch(/2 requests in progress/);
    expect(res.body.error).toMatch(/contact support/i);
    expect(deleteCodesSent()).toBe(before);
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    const event = await prisma.securityEvent.findFirst({ where: { userId: patient.user.id, event: 'account_delete_blocked' } });
    expect(event.detail).toEqual({ step: 'start', activeRequests: 2 });
    // the account is fully usable
    expect((await request(app).get('/auth/me').set(auth(patient.token))).status).toBe(200);
  });

  it('a request that is in progress counts too, and a completed or cancelled one does not', async () => {
    const patient = await createPatient();
    const a = await newRequest(patient.token);
    const b = await newRequest(patient.token);
    await prisma.serviceRequest.update({ where: { id: a.body.request.id }, data: { status: 'in_progress' } });
    await prisma.serviceRequest.update({ where: { id: b.body.request.id }, data: { status: 'cancelled' } });
    expect((await start(patient.token)).body).toMatchObject({ code: 'active_requests', activeRequests: 1 });
    await prisma.serviceRequest.update({ where: { id: a.body.request.id }, data: { status: 'completed' } });
    expect((await start(patient.token)).status).toBe(200);
  });

  it('a request made between the two steps still blocks the second one, and the account stays intact', async () => {
    const patient = await patientWithCompletedRequest();
    const first = await start(patient.token);
    expect(first.status).toBe(200);
    await newRequest(patient.token);
    const res = await confirm(patient.token, { ticket: first.body.ticket, code: deleteCode(destOf(patient)), confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('active_requests');
    expect((await prisma.user.findUnique({ where: { id: patient.user.id } })).deletedAt).toBeNull();
    expect((await request(app).get('/auth/me').set(auth(patient.token))).status).toBe(200);
    expect((await prisma.securityEvent.findFirst({ where: { userId: patient.user.id, event: 'account_delete_blocked' } })).detail).toMatchObject({ step: 'confirm' });
  });

  it('a patient with no requests at all can delete straight away', async () => {
    const patient = await createPatient();
    expect((await retire(patient)).status).toBe(200);
  });
});

describe('a Private Charter request is counted like any other (this feature does not touch Private Charter itself)', () => {
  it('only its status is read: an open one blocks deletion, a completed one does not', async () => {
    const patient = await createPatient();
    const charter = await prisma.serviceRequest.create({
      data: { userId: patient.user.id, serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter', patientName: 'A B', origin: 'Pune', destination: 'Dubai', referenceNumber: `TEMP-${Date.now()}`, status: 'submitted' },
    });
    expect((await start(patient.token)).body.code).toBe('active_requests');
    await prisma.serviceRequest.update({ where: { id: charter.id }, data: { status: 'completed' } });
    expect((await start(patient.token)).status).toBe(200);
  });
});
