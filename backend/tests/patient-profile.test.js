// A patient's own personal details: GET /auth/me (what an account looks like in a response) and PATCH /auth/me
// (the name, first/last name, gender and nationality). Mobile and email stay on their own OTP-only flow (tests/contact-change-otp.test.js), and
// nothing else in a request body can change anything.
jest.mock('../src/modules/auth/otp-delivery.service', () => ({
  deliverOtp: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { prisma } = require('../src/db/prisma');
const { createPatient, createCorporateUserAndLogin } = require('./helpers');

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const dbUser = (id) => prisma.user.findUnique({ where: { id } });
const get = (token) => request(app).get('/auth/me').set(auth(token));
const patch = (token, body) => request(app).patch('/auth/me').set(auth(token)).send(body);

// Nothing in a response may carry any of these, wherever it appears.
const SECRET_FIELDS = ['passwordHash', 'tokenVersion', 'failedLoginCount', 'lockedUntil', 'googleId', 'appleId', 'pushToken'];
const expectNoSecrets = (body) => {
  const text = JSON.stringify(body);
  for (const field of SECRET_FIELDS) expect(text).not.toContain(field);
};

describe('GET /auth/me', () => {
  it('needs a login: no token, a bad token and a refresh token are all refused', async () => {
    expect((await request(app).get('/auth/me')).status).toBe(401);
    expect((await get('not-a-token')).status).toBe(401);
    const patient = await createPatient();
    expect((await get(patient.refreshToken)).status).toBe(401);
  });

  it('gives a patient their own account, and the fields the app shows', async () => {
    const patient = await createPatient({ name: 'Asha Verma' });
    const res = await get(patient.token);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: patient.user.id, name: 'Asha Verma', email: patient.email, mobile: patient.mobile, isVerified: true, hasPassword: true });
    expect(Object.keys(res.body.user).sort()).toEqual([
      'countryCode', 'createdAt', 'email', 'emailVerifiedAt', 'firstName', 'gender', 'hasPassword', 'id', 'isVerified', 'lastName', 'mobile', 'name', 'nationality', 'phoneCountry',
    ].sort());
  });

  it('missing optional details come back as null, not invented values', async () => {
    const patient = await createPatient(); // registered with a single name, no gender or nationality
    const { user } = (await get(patient.token)).body;
    expect(user.firstName).toBeNull();
    expect(user.lastName).toBeNull();
    expect(user.gender).toBeNull();
    expect(user.nationality).toBeNull();
  });

  it('never carries the hash, the lockout counters, the token version, the Google/Apple ids or the push token', async () => {
    const patient = await createPatient();
    await prisma.user.update({ where: { id: patient.user.id }, data: { googleId: `g-${Date.now()}`, appleId: `a-${Date.now()}`, pushToken: 'ExponentPushToken[secret]' } });
    const me = await get(patient.token);
    expect(me.status).toBe(200);
    expectNoSecrets(me.body);
    expect(me.body.user).toHaveProperty('hasPassword', true);
    // ...in a PATCH answer, a login answer and the account's other responses too
    expectNoSecrets((await patch(patient.token, { gender: 'female' })).body);
    const login = await request(app).post('/auth/login').send({ email: patient.email, password: patient.password });
    expectNoSecrets(login.body);
  });

  it('a patient only ever sees their own account: two patients, two different answers', async () => {
    const a = await createPatient({ name: 'Patient A' });
    const b = await createPatient({ name: 'Patient B' });
    expect((await get(a.token)).body.user.id).toBe(a.user.id);
    expect((await get(b.token)).body.user.id).toBe(b.user.id);
    expect((await get(a.token)).body.user.email).not.toBe(b.email);
  });

  it('there is no way to ask for someone else: ids in the query or body are ignored', async () => {
    const a = await createPatient();
    const b = await createPatient();
    const res = await request(app).get(`/auth/me?id=${b.user.id}&userId=${b.user.id}`).set(auth(a.token)).send({ id: b.user.id });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(a.user.id);
  });

  it('a corporate login gets the corporate account, never a patient one', async () => {
    const corporate = await createCorporateUserAndLogin();
    const res = await get(corporate.token);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeUndefined();
    expect(res.body.corporateUser).toBeTruthy();
  });
});

describe('PATCH /auth/me', () => {
  it('needs a login', async () => {
    expect((await request(app).patch('/auth/me').send({ name: 'Nobody' })).status).toBe(401);
    expect((await patch('not-a-token', { name: 'Nobody' })).status).toBe(401);
  });

  it('a corporate login cannot use it', async () => {
    const corporate = await createCorporateUserAndLogin();
    expect((await patch(corporate.token, { name: 'Nobody' })).status).toBe(403);
  });

  describe('name', () => {
    it('saves first and last name together, and keeps the full name in step', async () => {
      const patient = await createPatient();
      const res = await patch(patient.token, { firstName: '  Asha ', lastName: 'Verma  ' });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ name: 'Asha Verma', firstName: 'Asha', lastName: 'Verma' });
      expect(await dbUser(patient.user.id)).toMatchObject({ name: 'Asha Verma', firstName: 'Asha', lastName: 'Verma' });
    });

    it('needs both parts, letters in each, and at most 50 characters', async () => {
      const patient = await createPatient({ name: 'Keep Me' });
      for (const body of [{ firstName: 'Asha' }, { lastName: 'Verma' }, { firstName: 'Asha', lastName: '' }, { firstName: '123', lastName: 'Verma' }, { firstName: 'Asha', lastName: 'V'.repeat(51) }]) {
        const res = await patch(patient.token, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
      }
      expect(await dbUser(patient.user.id)).toMatchObject({ name: 'Keep Me', firstName: null, lastName: null });
    });

    it('a single full name still works as before: changed, it clears the stored parts; unchanged, it leaves them', async () => {
      const patient = await createPatient();
      await patch(patient.token, { firstName: 'Asha', lastName: 'Verma' });
      const same = await patch(patient.token, { name: 'Asha Verma' });
      expect(same.status).toBe(200);
      expect(same.body.user).toMatchObject({ name: 'Asha Verma', firstName: 'Asha', lastName: 'Verma' });
      const renamed = await patch(patient.token, { name: 'Asha K Verma' });
      expect(renamed.body.user).toMatchObject({ name: 'Asha K Verma', firstName: null, lastName: null });
    });

    it('refuses a name that is too short, and changes nothing', async () => {
      const patient = await createPatient({ name: 'Keep Me' });
      expect((await patch(patient.token, { name: 'A' })).status).toBe(400);
      expect((await patch(patient.token, { name: '   ' })).status).toBe(400);
      expect((await dbUser(patient.user.id)).name).toBe('Keep Me');
    });
  });

  describe('gender and nationality', () => {
    it('saves the values the sign-up form accepts', async () => {
      const patient = await createPatient();
      for (const gender of ['male', 'female', 'other', 'prefer_not_to_say']) {
        expect((await patch(patient.token, { gender })).body.user.gender).toBe(gender);
      }
      const res = await patch(patient.token, { nationality: 'IN' });
      expect(res.body.user.nationality).toBe('IN');
      expect(await dbUser(patient.user.id)).toMatchObject({ gender: 'prefer_not_to_say', nationality: 'IN' });
    });

    it('refuses anything else, exactly as sign-up does ("Male", "in", unknown codes)', async () => {
      const patient = await createPatient();
      for (const body of [{ gender: 'Male' }, { gender: 'x' }, { nationality: 'in' }, { nationality: 'ZZ' }, { nationality: 'India' }, { gender: ['male'] }]) {
        expect((await patch(patient.token, body)).status).toBe(400);
      }
      expect(await dbUser(patient.user.id)).toMatchObject({ gender: null, nationality: null });
    });

    it('an empty value leaves the stored one alone (nothing is cleared by accident)', async () => {
      const patient = await createPatient();
      await patch(patient.token, { gender: 'female', nationality: 'IN' });
      const res = await patch(patient.token, { gender: '', nationality: null });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ gender: 'female', nationality: 'IN' });
    });
  });

  describe('a refused request changes nothing', () => {
    it('one bad field cancels the whole update', async () => {
      const patient = await createPatient({ name: 'Keep Me' });
      await patch(patient.token, { gender: 'female' });
      const res = await patch(patient.token, { firstName: 'Asha', lastName: 'Verma', gender: 'female', nationality: 'ZZ' });
      expect(res.status).toBe(400);
      expect(await dbUser(patient.user.id)).toMatchObject({ name: 'Keep Me', firstName: null, lastName: null, gender: 'female', nationality: null });
    });

    it('a bad first and last name cancels a valid gender sent with them', async () => {
      const patient = await createPatient();
      expect((await patch(patient.token, { firstName: 'A', lastName: '', gender: 'male' })).status).toBe(400);
      expect((await dbUser(patient.user.id)).gender).toBeNull();
    });
  });

  describe('mobile, email and everything an ordinary update must not touch', () => {
    it('mobile, email, calling code and phone country are refused here (they need a password and a code)', async () => {
      const patient = await createPatient();
      for (const body of [{ mobile: '+919876543210' }, { email: 'new@example.com' }, { countryCode: '+44' }, { phoneCountry: 'GB' }]) {
        const res = await patch(patient.token, { ...body, name: 'Changed Name' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/verification code/);
      }
      expect(await dbUser(patient.user.id)).toMatchObject({ name: 'Test Patient', email: patient.email, mobile: patient.mobile });
    });

    it('verification flags, ids, tokens and the push token in the body are never read', async () => {
      const patient = await createPatient();
      await prisma.user.update({ where: { id: patient.user.id }, data: { emailVerifiedAt: null } });
      const before = await dbUser(patient.user.id);
      const res = await patch(patient.token, {
        gender: 'female',
        isVerified: false, emailVerifiedAt: '2026-01-01T00:00:00.000Z', googleId: 'g-evil', appleId: 'a-evil', tokenVersion: 99,
        pushToken: 'ExponentPushToken[evil]', passwordHash: 'x', failedLoginCount: 7, lockedUntil: '2099-01-01T00:00:00.000Z',
        id: patient.user.id + 1000, userId: 1, createdAt: '2000-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(200);
      expect(res.body.user.gender).toBe('female'); // the one real change
      const after = await dbUser(patient.user.id);
      for (const field of ['isVerified', 'emailVerifiedAt', 'googleId', 'appleId', 'tokenVersion', 'pushToken', 'passwordHash', 'failedLoginCount', 'lockedUntil', 'id', 'createdAt']) {
        expect(after[field]).toEqual(before[field]);
      }
    });

    it('a patient cannot mark their email verified: it stays pending until a code proves it', async () => {
      const patient = await createPatient();
      await prisma.user.update({ where: { id: patient.user.id }, data: { emailVerifiedAt: null } });
      const res = await patch(patient.token, { emailVerifiedAt: new Date().toISOString(), isVerified: true });
      expect(res.status).toBe(200);
      expect(res.body.user.emailVerifiedAt).toBeNull();
      expect((await dbUser(patient.user.id)).emailVerifiedAt).toBeNull();
    });

    it('an id in the body cannot reach another patient: only the account in the token is written', async () => {
      const a = await createPatient({ name: 'Patient A' });
      const b = await createPatient({ name: 'Patient B' });
      const res = await patch(a.token, { id: b.user.id, userId: b.user.id, name: 'Renamed A' });
      expect(res.status).toBe(200);
      expect((await dbUser(a.user.id)).name).toBe('Renamed A');
      expect((await dbUser(b.user.id)).name).toBe('Patient B');
    });
  });

  it('an update leaves the session intact: the same tokens still work and refresh', async () => {
    const patient = await createPatient();
    expect((await patch(patient.token, { gender: 'male' })).status).toBe(200);
    expect((await get(patient.token)).status).toBe(200);
    const refreshed = await request(app).post('/auth/refresh').send({ refreshToken: patient.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.token).toBeTruthy();
  });

  it('an empty body changes nothing and succeeds', async () => {
    const patient = await createPatient({ name: 'Keep Me' });
    const res = await patch(patient.token, {});
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Keep Me');
  });

  it('the personal data is never written to the console', async () => {
    const patient = await createPatient();
    const spies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    await patch(patient.token, { firstName: 'Zzyzx', lastName: 'Quillfeather', gender: 'female', nationality: 'IN' });
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/Zzyzx|Quillfeather/);
    spies.forEach((spy) => spy.mockRestore());
  });
});
