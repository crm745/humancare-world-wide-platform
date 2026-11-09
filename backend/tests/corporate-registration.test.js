// Corporate registration through the secure flow:
//   - submitting needs a verified Firebase phone proof (X-Firebase-Id-Token), and the verified number must be
//     the contact phone in the form;
//   - everything about an existing application needs the registration proof the API returned as `accessToken`
//     (X-Registration-Token), bound to that registration and its current email;
//   - correcting the email needs that registration proof AND a fresh Firebase proof of the registered mobile;
//   - accounts are never created by the applicant: an Admin provisions an approved registration.
// firebase-admin is replaced by a stand-in whose "tokens" describe what Firebase would have verified (see
// firebase-phone.test.js for the same pattern); the real proof checks in integrations/firebase run on top of it.
//   "phone:+919876543210:uid-1"  a fresh phone sign-in for that number, Firebase uid "uid-1"
//   "google:+91…:uid"            a token from a non-phone sign-in
//   anything else                rejected by Firebase
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/lib/mailer', () => ({
  sendMail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('firebase-admin/app', () => ({ getApps: () => [{}], initializeApp: jest.fn(), cert: jest.fn() }));
const mockVerifyIdToken = jest.fn(async (token) => {
  const [kind, phone, uid] = String(token).split(':');
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'phone') return { firebase: { sign_in_provider: 'phone' }, phone_number: phone, uid, auth_time: now };
  if (kind === 'google') return { firebase: { sign_in_provider: 'google.com' }, phone_number: phone, uid, auth_time: now };
  const err = new Error('Decoding Firebase ID token failed.');
  err.code = 'auth/argument-error';
  throw err;
});
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mockVerifyIdToken }) }));

const request = require('supertest');
const { sendMail } = require('../src/lib/mailer');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createAdminAndLogin, uniqueEmail } = require('./helpers');

beforeAll(() => {
  process.env.PHONE_OTP_PROVIDER = 'firebase';
});
afterAll(async () => {
  delete process.env.PHONE_OTP_PROVIDER;
  await prisma.$disconnect();
});

beforeEach(() => {
  sendMail.mockClear();
});

// A different mobile number and Firebase sign-in for every call: the API allows only a few registrations per
// mobile per day, and each Firebase sign-in can be used once.
let counter = 0;
const uniqueMobile = () => `+919${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
const firebaseToken = (phone) => {
  counter += 1;
  return `phone:${phone}:uid-${Date.now()}-${counter}`;
};

function sampleCompany(email, phone) {
  return {
    companyName: 'Acme Assist Pvt Ltd',
    companyType: 'tpa',
    country: 'IN',
    city: 'Mumbai',
    officialEmail: email,
    officialPhone: '+91 9876543210',
    contactName: 'Priya Sharma',
    contactDesignation: 'Operations Head',
    contactEmail: email,
    contactPhone: phone,
  };
}

const sampleBank = {
  bankType: 'Domestic',
  bankName: 'HDFC Bank',
  accountHolder: 'Acme Assist Pvt Ltd',
  accountNumber: '123456789012',
  ifsc: 'HDFC0001234',
  branchName: 'Andheri',
  branchAddress: 'Andheri East, Mumbai',
};

// Submits with a valid Firebase proof of `phone` (also the contact phone in the form) unless told otherwise.
// `idToken: null` sends no proof header at all.
async function submitRegistration(email = uniqueEmail('acme'), { withDocument = false, phone = uniqueMobile(), idToken } = {}) {
  const req = request(app)
    .post('/corporates/register')
    .field('company', JSON.stringify(sampleCompany(email, phone)))
    .field('bank', JSON.stringify(sampleBank));
  const proof = idToken === undefined ? firebaseToken(phone) : idToken;
  if (proof !== null) req.set('X-Firebase-Id-Token', proof);
  if (withDocument) {
    req.attach('registration', Buffer.from('%PDF-1.4 fake'), { filename: 'cert.pdf', contentType: 'application/pdf' });
  }
  return req;
}

// A registration created through the real endpoint: { body, phone, proof } where body.accessToken is the
// registration proof the API issued.
async function register(email, options = {}) {
  const phone = options.phone || uniqueMobile();
  const res = await submitRegistration(email, { ...options, phone });
  expect(res.status).toBe(201);
  return { body: res.body, phone, access: res.body.accessToken };
}

const withAccess = (req, access) => req.set('X-Registration-Token', access);

function tokenFromLastEmail() {
  const html = sendMail.mock.calls.at(-1)[0].html;
  return new URL(html.match(/href="([^"]+)"/)[1]).searchParams.get('token');
}

const DENIED = { error: 'Registration access required.', code: 'registration_access_required' };

describe('POST /corporates/register', () => {
  it('creates a pending registration, emails a verification link and issues a registration proof', async () => {
    const email = uniqueEmail('acme');
    const res = await submitRegistration(email);
    expect(res.status).toBe(201);
    expect(res.body.corporateId).toMatch(/^HCW-COR-\d{4}-\d+$/);
    expect(res.body.status).toBe('Pending Verification');
    expect(res.body.emailVerified).toBe(false);
    expect(res.body.approved).toBe(false);
    expect(typeof res.body.accessToken).toBe('string');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe(email);
  });

  it('masks the bank account number in the public response', async () => {
    const res = await submitRegistration();
    expect(res.status).toBe(201);
    expect(res.body.bank.accountLast4).toBe('9012');
    expect(res.body.bank.accountNumber).toBeUndefined();
  });

  it('rejects a submission missing required company fields', async () => {
    const phone = uniqueMobile();
    const res = await request(app)
      .post('/corporates/register')
      .set('X-Firebase-Id-Token', firebaseToken(phone))
      .field('company', JSON.stringify({ companyType: 'tpa' }))
      .field('bank', JSON.stringify(sampleBank));
    expect(res.status).toBe(400);
  });

  describe('the Firebase phone proof is required', () => {
    it('refuses a submission with no proof, and nothing is created', async () => {
      const email = uniqueEmail('noproof');
      const res = await submitRegistration(email, { idToken: null });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('otp_invalid');
      expect(await prisma.corporateRegistration.count({ where: { email } })).toBe(0);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it.each([['a token Firebase rejects', 'not-a-firebase-token'], ['a sign-in that is not a phone sign-in', 'google:+919876543210:uid-g']])(
      'refuses %s',
      async (_label, idToken) => {
        const email = uniqueEmail('badproof');
        const res = await submitRegistration(email, { idToken });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('otp_invalid');
        expect(await prisma.corporateRegistration.count({ where: { email } })).toBe(0);
      },
    );

    it('refuses a proof for a different number than the contact phone in the form', async () => {
      const email = uniqueEmail('mismatch');
      const res = await submitRegistration(email, { phone: uniqueMobile(), idToken: firebaseToken(uniqueMobile()) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('phone_mismatch');
      expect(await prisma.corporateRegistration.count({ where: { email } })).toBe(0);
    });

    it('accepts each Firebase sign-in once: reusing the same proof is refused', async () => {
      const phone = uniqueMobile();
      const idToken = `phone:${phone}:uid-reuse-${Date.now()}`;
      const first = await submitRegistration(uniqueEmail('first'), { phone, idToken });
      expect(first.status).toBe(201);
      // The same token verifies to the same uid and sign-in time (same second): the ledger refuses it.
      const second = await submitRegistration(uniqueEmail('second'), { phone, idToken });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('proof_already_used');
    });

    it('is unavailable while Firebase phone verification is not configured', async () => {
      process.env.PHONE_OTP_PROVIDER = 'console';
      try {
        const res = await submitRegistration(uniqueEmail('off'));
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('phone_verification_unavailable');
      } finally {
        process.env.PHONE_OTP_PROVIDER = 'firebase';
      }
    });
  });
});

describe('GET /corporates/registrations/:id', () => {
  it('returns the registration by id to the holder of its registration proof', async () => {
    const { body: created, access } = await register();
    const res = await withAccess(request(app).get(`/corporates/registrations/${created.id}`), access);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
  });

  it('answers the same 403 for an unknown id, so a registration cannot be probed', async () => {
    const { access } = await register();
    const res = await withAccess(request(app).get('/corporates/registrations/999999999'), access);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DENIED);
  });

  it('refuses a request with no registration proof', async () => {
    const { body: created } = await register();
    const res = await request(app).get(`/corporates/registrations/${created.id}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DENIED);
  });

  it('refuses a malformed proof', async () => {
    const { body: created } = await register();
    const res = await withAccess(request(app).get(`/corporates/registrations/${created.id}`), 'not-a-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DENIED);
  });

  it("refuses another registration's proof", async () => {
    const { body: created } = await register();
    const { access: otherAccess } = await register();
    const res = await withAccess(request(app).get(`/corporates/registrations/${created.id}`), otherAccess);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DENIED);
  });
});

describe('email verification', () => {
  it('verifies via the emailed link token', async () => {
    const { body: created } = await register();
    const token = tokenFromLastEmail();
    const res = await request(app).get(`/corporates/verify-email?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.id).toBe(created.id);
    expect(typeof res.body.accessToken).toBe('string'); // a fresh registration proof
  });

  it('rejects an invalid token', async () => {
    const res = await request(app).get('/corporates/verify-email?token=not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('blocks an immediate resend (same cooldown the UI countdown enforces)', async () => {
    const { body: created, access } = await register();
    const res = await withAccess(request(app).post(`/corporates/registrations/${created.id}/resend-verification`), access);
    expect(res.status).toBe(429);
  });

  it('resend issues a new email once the cooldown has passed', async () => {
    const { body: created, access } = await register();
    // Back-date updatedAt instead of sleeping — simulates the cooldown having elapsed.
    await prisma.corporateRegistration.update({ where: { id: created.id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const res = await withAccess(request(app).post(`/corporates/registrations/${created.id}/resend-verification`), access);
    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2); // initial submit + this resend
  });

  it('refuses a resend with no registration proof, even after the cooldown', async () => {
    const { body: created } = await register();
    await prisma.corporateRegistration.update({ where: { id: created.id }, data: { updatedAt: new Date(Date.now() - 60_000) } });
    const res = await request(app).post(`/corporates/registrations/${created.id}/resend-verification`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual(DENIED);
    expect(sendMail).toHaveBeenCalledTimes(1); // only the initial submit
  });

  describe('changing the email', () => {
    const patchEmail = (id, access, body, idToken) => {
      const req = withAccess(request(app).patch(`/corporates/registrations/${id}/email`), access);
      if (idToken) req.set('X-Firebase-Id-Token', idToken);
      return req.send(body);
    };

    it('resets verification and sends a new link, given the registration proof and a fresh proof of the registered mobile', async () => {
      const { body: created, access, phone } = await register();
      const newEmail = uniqueEmail('acme-new');
      const res = await patchEmail(created.id, access, { email: newEmail }, firebaseToken(phone));
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(newEmail);
      expect(res.body.emailVerified).toBe(false);
      expect(typeof res.body.accessToken).toBe('string');
      expect(sendMail.mock.calls.at(-2)[0].to).toBe(newEmail); // the new link (the previous address is told afterwards)

      // The old registration proof was bound to the old email and is dead now; the new one works.
      const stale = await withAccess(request(app).get(`/corporates/registrations/${created.id}`), access);
      expect(stale.status).toBe(403);
      const fresh = await withAccess(request(app).get(`/corporates/registrations/${created.id}`), res.body.accessToken);
      expect(fresh.status).toBe(200);
    });

    it('needs the Firebase proof as well as the registration proof', async () => {
      const { body: created, access } = await register();
      const newEmail = uniqueEmail('acme-nofb');
      const res = await patchEmail(created.id, access, { email: newEmail });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('otp_invalid');
      const unchanged = await prisma.corporateRegistration.findUnique({ where: { id: created.id } });
      expect(unchanged.email).not.toBe(newEmail);
    });

    it('refuses a Firebase proof of a different mobile than the registered one', async () => {
      const { body: created, access } = await register();
      const res = await patchEmail(created.id, access, { email: uniqueEmail('acme-other') }, firebaseToken(uniqueMobile()));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('phone_mismatch');
    });

    it('needs the registration proof, whatever Firebase proof is sent', async () => {
      const { body: created, phone } = await register();
      const res = await request(app)
        .patch(`/corporates/registrations/${created.id}/email`)
        .set('X-Firebase-Id-Token', firebaseToken(phone))
        .send({ email: uniqueEmail('acme-noreg') });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(DENIED);
    });

    it('never changes the registered mobile: a phone field in the body is refused', async () => {
      const { body: created, access, phone } = await register();
      const res = await patchEmail(created.id, access, { email: uniqueEmail('acme-ph'), mobile: '+919999999999' }, firebaseToken(phone));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('phone_change_not_allowed');
    });
  });
});

describe('registration document download', () => {
  it('stores the uploaded file and superadmin can download it; a regular admin cannot', async () => {
    const created = (await register(undefined, { withDocument: true })).body;
    expect(created.documents).toHaveLength(1);
    expect(created.documents[0].key).toBe('registration');

    const { token: superToken } = await createAdminAndLogin({ role: 'superadmin' });
    const ok = await request(app)
      .get(`/admin/corporate-registrations/${created.id}/documents/registration`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body).toString()).toContain('%PDF-1.4 fake');

    const { token: adminToken } = await createAdminAndLogin({ role: 'admin' });
    const blocked = await request(app)
      .get(`/admin/corporate-registrations/${created.id}/documents/registration`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(blocked.status).toBe(403);
  });

  it('404s for a document key that was never uploaded', async () => {
    const created = (await register()).body; // no documents attached
    const { token } = await createAdminAndLogin({ role: 'superadmin' });
    const res = await request(app)
      .get(`/admin/corporate-registrations/${created.id}/documents/registration`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('admin approval is superadmin-only', () => {
  it('a regular admin cannot see or approve pending registrations', async () => {
    const { token } = await createAdminAndLogin({ role: 'admin' });
    const list = await request(app).get('/admin/corporate-registrations').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);
  });

  it('a superadmin can list, approve, and reject registrations', async () => {
    const { token: adminToken } = await createAdminAndLogin({ role: 'superadmin' });
    const created = (await register()).body;
    await request(app).get(`/corporates/verify-email?token=${tokenFromLastEmail()}`); // approval needs a verified email

    const list = await request(app).get('/admin/corporate-registrations').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.registrations.some((r) => r.id === created.id)).toBe(true);

    const detail = await request(app).get(`/admin/corporate-registrations/${created.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.registration.bank.accountNumber).toBe('123456789012'); // unmasked for admin

    const approve = await request(app).post(`/admin/corporate-registrations/${created.id}/approve`).set('Authorization', `Bearer ${adminToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.registration.approved).toBe(true);

    const other = (await register()).body;
    const reject = await request(app)
      .post(`/admin/corporate-registrations/${other.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Documents unclear' });
    expect(reject.status).toBe(200);
    expect(reject.body.registration.status).toBe('Rejected');
  });
});

// An applicant can no longer create their own login (there is no /credentials endpoint): an Admin provisions the
// Owner of an approved registration, and gets a one-time temporary password.
describe('POST /admin/corporate-registrations/:id/provision', () => {
  const provision = (id, token) => request(app).post(`/admin/corporate-registrations/${id}/provision`).set('Authorization', `Bearer ${token}`);

  it('an applicant cannot create a login for themselves any more', async () => {
    const { body: created, access } = await register();
    const res = await withAccess(request(app).post(`/corporates/registrations/${created.id}/credentials`), access).send({ password: 'StrongPass@123' });
    expect(res.status).toBe(404);
    expect(await prisma.corporateUser.count({ where: { email: created.email } })).toBe(0);
  });

  it('refuses before the email is verified and the registration approved', async () => {
    const { body: created } = await register();
    const { token } = await createAdminAndLogin({ role: 'superadmin' });
    const res = await provision(created.id, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_approved');
  });

  it('cannot approve, and so cannot provision, a registration whose email is not verified yet', async () => {
    const { body: created } = await register();
    const { token } = await createAdminAndLogin({ role: 'superadmin' });
    const approve = await request(app).post(`/admin/corporate-registrations/${created.id}/approve`).set('Authorization', `Bearer ${token}`);
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe('email_not_verified');
    const res = await provision(created.id, token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_approved');
    expect(await prisma.corporateUser.count({ where: { email: created.email } })).toBe(0);
  });

  it('creates a real, working corporate login once verified and approved', async () => {
    const email = uniqueEmail('acme-activate');
    const { body: created } = await register(email);
    await request(app).get(`/corporates/verify-email?token=${tokenFromLastEmail()}`);

    const { token: adminToken } = await createAdminAndLogin({ role: 'superadmin' });
    await request(app).post(`/admin/corporate-registrations/${created.id}/approve`).set('Authorization', `Bearer ${adminToken}`);

    const res = await provision(created.id, adminToken);
    expect(res.status).toBe(201);
    expect(res.body.credentials.email).toBe(email);
    expect(res.body.registration.credentialsCreated).toBe(true);
    const { temporaryPassword } = res.body.credentials;
    expect(typeof temporaryPassword).toBe('string');

    // The real Corporate + CorporateUser exist and this email/temporary password now logs in for real.
    const loginRes = await request(app).post('/auth/corporate/login').send({ email, password: temporaryPassword });
    expect(loginRes.status).toBe(200);

    const corporate = await prisma.corporate.findFirst({ where: { companyName: 'Acme Assist Pvt Ltd', officialEmail: email } });
    expect(corporate).not.toBeNull();
    const owner = await prisma.corporateUser.findUnique({ where: { email } });
    expect(owner.mustChangePassword).toBe(true);
  });

  it('rejects a second provisioning of the same registration', async () => {
    const email = uniqueEmail('acme-dup');
    const { body: created } = await register(email);
    await request(app).get(`/corporates/verify-email?token=${tokenFromLastEmail()}`);
    const { token: adminToken } = await createAdminAndLogin({ role: 'superadmin' });
    await request(app).post(`/admin/corporate-registrations/${created.id}/approve`).set('Authorization', `Bearer ${adminToken}`);
    expect((await provision(created.id, adminToken)).status).toBe(201);

    const again = await provision(created.id, adminToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('registration_provisioned');
  });
});
