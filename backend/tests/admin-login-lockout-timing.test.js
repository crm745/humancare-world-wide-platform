// Admin sign-in lockout timing (Step 7.8.2.1): five failed attempts, and the 15-minute lock starts
// AT the fifth failure (wrong password, or failed passkey assertion) - not at the sixth request.
// No database: Prisma is the in-memory stand-in; the real WebAuthn library verifies assertions.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));

const bcrypt = require('bcryptjs');
const kit = require('./admin-login-test-kit');
const { AdminLoginError } = require('../src/modules/admin/auth/admin-login.service');

const {
  db, fake, NOW, PASSWORD_HASH, later, seedAdmin, seedPasskey, begin, login, makeAssertionResponse, completeAdminPasskeyLogin,
} = kit;

const LOCK_MS = 15 * 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);

beforeEach(() => {
  fake.reset();
  db.auditClock = NOW;
  kit.setEnv();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  kit.restoreEnv();
});

async function expectRefused(promise) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(AdminLoginError);
  expect(error).toMatchObject({ code: 'invalid_credentials', message: 'Invalid credentials' });
  return error;
}

// An Admin with a passkey whose counter already stands at `failedLoginCount`.
function setup(failedLoginCount) {
  const admin = seedAdmin({ failedLoginCount });
  const passkey = seedPasskey(admin);
  return { admin, passkey };
}

// The password step done, ready for the passkey step; `answer` builds an assertion for its challenge.
async function pending(failedLoginCount, { now = NOW } = {}) {
  const { admin, passkey } = setup(failedLoginCount);
  const { loginTicket, options } = await begin(admin, { now });
  const answer = (overrides = {}) => makeAssertionResponse({ challenge: options.challenge, registered: passkey.reg, counter: 1, ...overrides });
  const complete = (response, when) => completeAdminPasskeyLogin({ loginTicket, response, now: when });
  return { admin, passkey, loginTicket, options, answer, complete };
}

const lockEvents = () => db.audits.filter((a) => a.event === 'admin.account_locked');
const realHashChecks = (compare) => compare.mock.calls.filter(([, hash]) => hash === PASSWORD_HASH).length;

describe('the fifth failure starts the lock', () => {
  it('a wrong fifth password locks immediately, for fifteen minutes from that moment', async () => {
    const { admin } = setup(4);
    await expectRefused(begin(admin, { password: 'WrongPass2027-5' }));
    expect(admin.failedLoginCount).toBe(5);
    expect(admin.lockedUntil).toEqual(at(LOCK_MS));
    expect(lockEvents()).toHaveLength(1);
    expect(db.challenges).toHaveLength(0);
    await expectRefused(begin(admin, { now: at(1000) })); // the right password no longer gets a ticket
    expect(db.challenges).toHaveLength(0);
  });

  it('earlier failures do not lock', async () => {
    const { admin } = setup(0);
    for (let i = 1; i <= 4; i += 1) {
      await expectRefused(begin(admin, { password: `WrongPass2027-${i}` }));
      expect(admin.failedLoginCount).toBe(i);
      expect(admin.lockedUntil).toBeNull();
    }
    expect(lockEvents()).toHaveLength(0);
  });

  it('a correct fifth password followed by a wrong passkey locks immediately', async () => {
    const t = await pending(4);
    expect(t.admin.failedLoginCount).toBe(5);
    expect(t.admin.lockedUntil).toBeNull(); // the fifth attempt is still open
    await expectRefused(t.complete(t.answer({ origin: 'https://evil.example' }), later(10)));
    expect(t.admin.failedLoginCount).toBe(5); // the attempt was counted once, at the password step
    expect(t.admin.lockedUntil).toEqual(at(10_000 + LOCK_MS));
    expect(lockEvents()).toHaveLength(1);
    await expectRefused(begin(t.admin, { now: later(11) })); // locked: no new password attempt
  });

  it('a correct fifth password and a correct passkey succeed, and clear the counter', async () => {
    const t = await pending(4);
    await expect(t.complete(t.answer(), later(10))).resolves.toHaveProperty('accessToken');
    expect(t.admin.failedLoginCount).toBe(0);
    expect(t.admin.lockedUntil).toBeNull();
    expect(lockEvents()).toHaveLength(0);
  });

  it('a failed passkey before the fifth attempt does not lock', async () => {
    const t = await pending(2);
    await expectRefused(t.complete(t.answer({ origin: 'https://evil.example' }), later(10)));
    expect(t.admin.failedLoginCount).toBe(3);
    expect(t.admin.lockedUntil).toBeNull();
  });
});

describe('while locked', () => {
  it('a sixth password attempt is refused without checking the password or moving anything', async () => {
    const { admin } = setup(4);
    await expectRefused(begin(admin, { password: 'WrongPass2027-5' }));
    const compare = jest.spyOn(bcrypt, 'compare');
    for (const secs of [1, 60, 14 * 60]) {
      await expectRefused(begin(admin, { now: later(secs) }));
    }
    expect(realHashChecks(compare)).toBe(0);
    expect(admin.failedLoginCount).toBe(5);
    expect(admin.lockedUntil).toEqual(at(LOCK_MS)); // never extended
    expect(lockEvents()).toHaveLength(1);
    expect(db.challenges).toHaveLength(0);
  });

  it('expires after exactly fifteen minutes, then counting starts afresh', async () => {
    const { admin } = setup(4);
    await expectRefused(begin(admin, { password: 'WrongPass2027-5' }));
    await expectRefused(begin(admin, { now: at(LOCK_MS - 1) })); // one millisecond early
    expect(admin.lockedUntil).toEqual(at(LOCK_MS));
    await expect(begin(admin, { now: at(LOCK_MS) })).resolves.toHaveProperty('loginTicket');
    expect(admin.failedLoginCount).toBe(1);
    expect(admin.lockedUntil).toBeNull();
  });

  it('a lock that started at a failed passkey also lasts exactly fifteen minutes', async () => {
    const t = await pending(4);
    await expectRefused(t.complete(t.answer({ origin: 'https://evil.example' }), later(10)));
    const end = at(10_000 + LOCK_MS);
    await expectRefused(begin(t.admin, { now: new Date(end.getTime() - 1) }));
    await expect(begin(t.admin, { now: end })).resolves.toHaveProperty('loginTicket');
  });

  it('refuses a ticket from before the lock, even with a genuine assertion', async () => {
    const t = await pending(3);
    t.admin.lockedUntil = later(600); // locked meanwhile
    await expectRefused(t.complete(t.answer(), later(10)));
    expect(t.admin.failedLoginCount).toBe(4);
    expect(t.admin.lockedUntil).toEqual(later(600));
  });
});

describe('an unfinished fifth attempt', () => {
  it('is never an open window: the next password attempt locks and is refused, without a ticket', async () => {
    const t = await pending(4);
    const compare = jest.spyOn(bcrypt, 'compare');
    await expectRefused(begin(t.admin, { now: later(500) })); // right password, long after the ticket died
    expect(realHashChecks(compare)).toBe(0);
    expect(t.admin.failedLoginCount).toBe(5);
    expect(t.admin.lockedUntil).toEqual(later(500 + 15 * 60));
    expect(db.challenges.filter((c) => c.consumedAt === null && c.expiresAt > later(500))).toHaveLength(0);
  });

  it('cannot be completed once the ticket has expired, and the late attempt changes no counter', async () => {
    const t = await pending(4);
    await expectRefused(t.complete(t.answer(), later(121)));
    expect(t.admin.failedLoginCount).toBe(5);
    expect(t.admin.lockedUntil).toBeNull(); // an expired ticket is not a failure
    expect(lockEvents()).toHaveLength(0);
  });
});

describe('replayed and expired challenges leave the counter alone', () => {
  it('a replayed failed exchange does not add to the lock or the counter', async () => {
    const t = await pending(2);
    const bad = t.answer({ origin: 'https://evil.example' });
    await expectRefused(t.complete(bad, later(10)));
    await expectRefused(t.complete(bad, later(11))); // challenge already burned
    expect(t.admin.failedLoginCount).toBe(3);
    expect(t.admin.lockedUntil).toBeNull();
  });

  it('a replay at the threshold neither locks nor extends a lock', async () => {
    const t = await pending(4);
    const good = t.answer();
    await expect(t.complete(good, later(10))).resolves.toHaveProperty('accessToken');
    t.admin.failedLoginCount = 5; // as if five attempts were pending again
    await expectRefused(t.complete(good, later(11))); // replay: challenge consumed
    expect(t.admin.failedLoginCount).toBe(5);
    expect(t.admin.lockedUntil).toBeNull();
    expect(lockEvents()).toHaveLength(0);
  });

  it('an older ticket whose challenge was retired by a newer password step cannot lock the account', async () => {
    const { admin, passkey } = setup(3);
    const first = await begin(admin);
    await begin(admin, { now: later(1) }); // attempt 5; retires the first challenge
    const stale = makeAssertionResponse({ challenge: first.options.challenge, registered: passkey.reg, counter: 1, origin: 'https://evil.example' });
    await expectRefused(completeAdminPasskeyLogin({ loginTicket: first.loginTicket, response: stale, now: later(2) }));
    expect(admin.failedLoginCount).toBe(5);
    expect(admin.lockedUntil).toBeNull();
  });
});

describe('concurrency', () => {
  it('twenty parallel wrong passwords evaluate at most five and end locked', async () => {
    const { admin } = setup(0);
    const compare = jest.spyOn(bcrypt, 'compare');
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => begin(admin, { password: `WrongPass2027-${i}` })));
    results.forEach((r) => expect(r.status).toBe('rejected'));
    expect(admin.failedLoginCount).toBe(5);
    expect(admin.lockedUntil).toEqual(at(LOCK_MS));
    expect(realHashChecks(compare)).toBe(5);
    expect(lockEvents()).toHaveLength(1);
  });

  it('twenty parallel right passwords yield at most five attempts and never a sixth evaluation', async () => {
    const { admin } = setup(0);
    const compare = jest.spyOn(bcrypt, 'compare');
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => begin(admin)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(15);
    expect(admin.failedLoginCount).toBe(5);
    expect(realHashChecks(compare)).toBeLessThanOrEqual(5);
    expect(admin.lockedUntil).toEqual(at(LOCK_MS)); // the surplus attempts started the lock
    expect(db.challenges.filter((c) => c.consumedAt === null).length).toBeLessThanOrEqual(1); // one newest challenge at most
  });

  it('parallel guesses cannot start from a half-finished fifth attempt and slip a sixth through', async () => {
    const t = await pending(4);
    const compare = jest.spyOn(bcrypt, 'compare');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => begin(t.admin, { now: later(5) })));
    results.forEach((r) => expect(r.status).toBe('rejected'));
    expect(realHashChecks(compare)).toBe(0);
    expect(t.admin.failedLoginCount).toBe(5);
    expect(t.admin.lockedUntil).toEqual(later(5 + 15 * 60));
  });
});

describe('a full login resets the counter', () => {
  it('clears the count and the lock after both factors', async () => {
    const { admin, passkey } = setup(3);
    await login(admin, passkey);
    expect(admin.failedLoginCount).toBe(0);
    expect(admin.lockedUntil).toBeNull();
    expect(admin.lastLoginAt).toEqual(NOW);
  });

  it('a password alone never resets it', async () => {
    const { admin } = setup(3);
    await begin(admin);
    expect(admin.failedLoginCount).toBe(4);
  });

  it('after a reset a user gets a full set of five attempts again', async () => {
    const { admin, passkey } = setup(4);
    await login(admin, passkey);
    for (let i = 1; i <= 4; i += 1) {
      await expectRefused(begin(admin, { password: `WrongPass2027-${i}` }));
      expect(admin.lockedUntil).toBeNull();
    }
  });
});

describe('audit failure never bypasses the lock', () => {
  it('a wrong fifth password locks even though the lock cannot be audited, and the error is loud', async () => {
    const { admin } = setup(4);
    db.failAudit = true;
    const error = await begin(admin, { password: 'WrongPass2027-5' }).then(() => null, (e) => e);
    expect(error.message).toBe('audit write failed');
    expect(admin.lockedUntil).toEqual(at(LOCK_MS));
    db.failAudit = false;
    await expectRefused(begin(admin, { now: later(1) }));
    expect(db.challenges).toHaveLength(0);
  });

  it('a failed fifth passkey locks even though the lock cannot be audited', async () => {
    const t = await pending(4);
    db.failAudit = true;
    const error = await t.complete(t.answer({ origin: 'https://evil.example' }), later(10)).then(() => null, (e) => e);
    expect(error.message).toBe('audit write failed');
    expect(t.admin.lockedUntil).toEqual(at(10_000 + LOCK_MS));
    db.failAudit = false;
    await expectRefused(begin(t.admin, { now: later(11) }));
  });

  it('a refused attempt whose refusal cannot be audited still counts and still locks', async () => {
    const { admin } = setup(3);
    db.failAudit = true;
    await expectRefused(begin(admin, { password: 'WrongPass2027-4' })); // refusal audit is best-effort
    expect(admin.failedLoginCount).toBe(4);
    const error = await begin(admin, { password: 'WrongPass2027-5' }).then(() => null, (e) => e);
    expect(error.message).toBe('audit write failed'); // the lock audit is not best-effort
    expect(admin.lockedUntil).toEqual(at(LOCK_MS));
  });
});
