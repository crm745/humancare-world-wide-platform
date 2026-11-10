// Admin WebAuthn challenge lifecycle (Step 7.7.3): issue and single-use consumption. No database:
// Prisma is the in-memory stand-in from admin-lock-fake-db.js, with deterministic clocks.
jest.mock('../src/db/prisma', () => require('./admin-lock-fake-db'));

const crypto = require('crypto');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const fake = require('./admin-lock-fake-db');
const {
  issueAdminWebAuthnChallenge,
  consumeAdminWebAuthnChallenge,
  ADMIN_WEBAUTHN_PURPOSES,
  CHALLENGE_BYTES,
} = require('../src/modules/admin/auth/admin-webauthn-challenge.service');
const { ADMIN_LOCK_POLICY } = require('../src/modules/admin/auth/admin-lock.config');

const db = fake.db;
const NOW = new Date('2027-03-01T10:00:00.000Z');
const SECOND = 1000;
const later = (seconds) => new Date(NOW.getTime() + seconds * SECOND);

function seedAdmin(id = 1) {
  const admin = { id, name: `Admin ${id}`, email: `admin${id}@example.org`, role: 'admin', status: 'pending_passkey', updatedAt: null };
  db.admins.push(admin);
  return admin;
}

const issue = (overrides = {}) => issueAdminWebAuthnChallenge({ adminId: 1, purpose: 'registration', now: NOW, ...overrides });
const consume = (overrides = {}) => consumeAdminWebAuthnChallenge({ adminId: 1, purpose: 'registration', now: later(5), ...overrides });
const stored = (id) => db.challenges.find((c) => c.id === id);

beforeEach(() => {
  fake.reset();
  seedAdmin(1);
  seedAdmin(2);
});

afterEach(() => jest.restoreAllMocks());

describe('issueAdminWebAuthnChallenge', () => {
  it('generates 32 random bytes as canonical unpadded base64url', async () => {
    const result = await issue();
    expect(CHALLENGE_BYTES).toBe(32);
    expect(result.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.challenge).not.toContain('=');
    const bytes = isoBase64URL.toBuffer(result.challenge);
    expect(bytes).toHaveLength(32);
    expect(isoBase64URL.fromBuffer(bytes)).toBe(result.challenge); // canonical round trip
    expect(Buffer.from(result.challengeBytes).equals(Buffer.from(bytes))).toBe(true);
    expect(result.challengeBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(result.challengeBytes)).toBe(false);
  });

  it('draws from the secure random source, 32 bytes at a time', async () => {
    const spy = jest.spyOn(crypto, 'randomBytes');
    await issue();
    expect(spy).toHaveBeenCalledWith(32);
  });

  it('never repeats a challenge', async () => {
    const values = new Set();
    for (let i = 0; i < 25; i += 1) values.add((await issue()).challenge);
    expect(values.size).toBe(25);
  });

  it('stores exactly the value it returns', async () => {
    const result = await issue();
    expect(stored(result.challengeId).challenge).toBe(result.challenge);
  });

  it('uses the approved 120-second lifetime', async () => {
    const result = await issue();
    expect(result.expiresAt).toEqual(later(120));
    expect(stored(result.challengeId).expiresAt).toEqual(later(120));
    expect(ADMIN_LOCK_POLICY.registrationChallengeTtlMs).toBe(120000);
    for (const purpose of ADMIN_WEBAUTHN_PURPOSES) {
      const recoveryStepUp = { recoveryRequestId: 4, sessionId: 3 };
      const extra = {
        unlock: { sessionId: 3 },
        recovery_registration: { recoveryRequestId: 4 },
        recovery_approval: recoveryStepUp,
        recovery_rejection: recoveryStepUp,
      }[purpose] || {};
      expect((await issue({ purpose, ...extra })).expiresAt).toEqual(later(120));
    }
  });

  it('binds the Admin, the exact purpose, and records the IP', async () => {
    const result = await issue({ ipAddress: ' 203.0.113.7 ' });
    expect(stored(result.challengeId)).toMatchObject({
      adminId: 1, purpose: 'registration', consumedAt: null, ipAddress: '203.0.113.7',
      invitationId: null, recoveryRequestId: null, sessionId: null,
    });
    expect(result.purpose).toBe('registration');
    expect(JSON.stringify(Object.keys(result).sort())).toBe(JSON.stringify(['challenge', 'challengeBytes', 'challengeId', 'expiresAt', 'purpose']));
  });

  it('binds an invitation, a session, or a recovery request when given and allowed', async () => {
    const withInvitation = await issue({ invitationId: 7 });
    expect(stored(withInvitation.challengeId)).toMatchObject({ invitationId: 7, sessionId: null, recoveryRequestId: null });
    const withSession = await issue({ sessionId: 8 });
    expect(stored(withSession.challengeId)).toMatchObject({ sessionId: 8, invitationId: null });
    const recovery = await issue({ purpose: 'recovery_registration', recoveryRequestId: 9 });
    expect(stored(recovery.challengeId)).toMatchObject({ purpose: 'recovery_registration', recoveryRequestId: 9, invitationId: null });
    const unlock = await issue({ purpose: 'unlock', sessionId: 10 });
    expect(stored(unlock.challengeId)).toMatchObject({ purpose: 'unlock', sessionId: 10 });
  });

  it('stores an over-long IP truncated and a blank one as null', async () => {
    expect(stored((await issue({ ipAddress: 'x'.repeat(200) })).challengeId).ipAddress).toHaveLength(64);
    expect(stored((await issue({ ipAddress: '   ' })).challengeId).ipAddress).toBeNull();
    expect(stored((await issue({ ipAddress: undefined })).challengeId).ipAddress).toBeNull();
  });

  describe('input validation', () => {
    it.each([[undefined], [null], [0], [-1], [1.5], ['1'], [NaN]])('rejects admin id %p', async (adminId) => {
      await expect(issue({ adminId })).rejects.toThrow(TypeError);
      expect(db.challenges).toHaveLength(0);
    });

    it.each([[undefined], [null], [''], ['Registration'], ['login'], ['admin'], ['__proto__'], ['toString'], ['constructor'], [5], [{}]])(
      'rejects purpose %p', async (purpose) => {
        await expect(issue({ purpose })).rejects.toThrow(TypeError);
        expect(db.challenges).toHaveLength(0);
      },
    );

    it.each([['invitationId'], ['recoveryRequestId'], ['sessionId']])('rejects a bad %s', async (field) => {
      const purpose = field === 'recoveryRequestId' ? 'recovery_registration' : 'registration';
      for (const bad of [0, -2, 1.5, '3', null, NaN]) {
        await expect(issue({ purpose, [field]: bad })).rejects.toThrow(TypeError);
      }
      expect(db.challenges).toHaveLength(0);
    });

    it('rejects a binding the purpose does not allow', async () => {
      await expect(issue({ purpose: 'registration', recoveryRequestId: 3 })).rejects.toThrow('not allowed');
      await expect(issue({ purpose: 'recovery_registration', invitationId: 3 })).rejects.toThrow('not allowed');
      await expect(issue({ purpose: 'authentication', sessionId: 3 })).rejects.toThrow('not allowed');
      await expect(issue({ purpose: 'unlock', invitationId: 3 })).rejects.toThrow('not allowed');
    });

    it('rejects an invalid clock', async () => {
      await expect(issue({ now: 'yesterday' })).rejects.toThrow(TypeError);
      await expect(issue({ now: new Date('nope') })).rejects.toThrow(TypeError);
    });

    it('rejects an Admin that does not exist, creating nothing', async () => {
      await expect(issue({ adminId: 99 })).rejects.toThrow('Admin not found');
      expect(db.challenges).toHaveLength(0);
    });
  });

  describe('invalidating earlier challenges', () => {
    it('retires the same Admin and purpose only', async () => {
      const mine = await issue();
      const mineOtherPurpose = await issue({ purpose: 'authentication' });
      const other = await issue({ adminId: 2 });
      const fresh = await issue({ now: later(10) });

      expect(stored(mine.challengeId).consumedAt).toEqual(later(10));
      expect(stored(mineOtherPurpose.challengeId).consumedAt).toBeNull(); // other purpose untouched
      expect(stored(other.challengeId).consumedAt).toBeNull(); // other Admin untouched
      expect(stored(fresh.challengeId).consumedAt).toBeNull();
    });

    it('leaves exactly one open challenge per Admin and purpose', async () => {
      for (let i = 0; i < 5; i += 1) await issue({ now: later(i) });
      const open = db.challenges.filter((c) => c.adminId === 1 && c.purpose === 'registration' && c.consumedAt === null);
      expect(open).toHaveLength(1);
      expect(db.challenges).toHaveLength(5); // history is kept, nothing deleted
    });

    it('keeps already-consumed history exactly as it was', async () => {
      const first = await issue();
      await consume();
      const consumedAt = stored(first.challengeId).consumedAt;
      await issue({ now: later(30) });
      expect(stored(first.challengeId).consumedAt).toEqual(consumedAt); // not re-stamped
      expect(db.challenges).toHaveLength(2);
    });

    it('makes the previous challenge unusable', async () => {
      const first = await issue();
      await issue({ now: later(1) });
      const claimed = await consume({ now: later(2) });
      expect(claimed.challenge).not.toBe(first.challenge);
    });

    it('does all of it atomically: when creation fails the earlier challenge is still open', async () => {
      const first = await issue();
      db.failCreate = 'challenges';
      await expect(issue({ now: later(10) })).rejects.toThrow('create failed');
      expect(db.events).toContain('rollback');
      expect(stored(first.challengeId).consumedAt).toBeNull(); // invalidation rolled back
      expect(db.challenges).toHaveLength(1);
      db.failCreate = null;
      expect(await consume({ now: later(11) })).toMatchObject({ challenge: first.challenge });
    });

    it('commits invalidation and creation together in one transaction', async () => {
      await issue();
      db.events.length = 0;
      await issue({ now: later(1) });
      expect(db.events).toEqual(['admins.update', 'challenges.update', 'challenges.create', 'commit']);
    });

    it('joins the caller\'s transaction when given a client, so the caller decides the outcome', async () => {
      const first = await issue();
      await expect(fake.prisma.$transaction(async (tx) => {
        await issue({ now: later(10), db: tx });
        throw new Error('caller failed later');
      })).rejects.toThrow('caller failed later');
      expect(stored(first.challengeId).consumedAt).toBeNull();
      expect(db.challenges).toHaveLength(1);
    });

    it('serialises concurrent issues for one Admin: exactly one challenge stays open', async () => {
      const results = await Promise.all([issue({ now: later(1) }), issue({ now: later(2) }), issue({ now: later(3) }), issue({ now: later(4) })]);
      expect(db.challenges).toHaveLength(4);
      const open = db.challenges.filter((c) => c.consumedAt === null);
      expect(open).toHaveLength(1);
      // and it is the one issued last under the lock, so consume finds it
      const claimed = await consume({ now: later(5) });
      expect(claimed.challengeId).toBe(open[0].id);
      expect(results.map((r) => r.challenge)).toContain(claimed.challenge);
    });

    it('does not let concurrent issues for different Admins interfere', async () => {
      await Promise.all([issue({ adminId: 1 }), issue({ adminId: 2 }), issue({ adminId: 1, now: later(1) }), issue({ adminId: 2, now: later(1) })]);
      for (const adminId of [1, 2]) {
        expect(db.challenges.filter((c) => c.adminId === adminId && c.consumedAt === null)).toHaveLength(1);
      }
    });
  });
});

describe('consumeAdminWebAuthnChallenge', () => {
  it('returns the challenge and its trusted metadata, and marks it consumed', async () => {
    const issued = await issue({ invitationId: 7 });
    const claimed = await consume({ invitationId: 7 });
    expect(claimed).toEqual({
      challengeId: issued.challengeId,
      adminId: 1,
      purpose: 'registration',
      challenge: issued.challenge,
      invitationId: 7,
      recoveryRequestId: null,
      sessionId: null,
      expiresAt: later(120),
      consumedAt: later(5),
    });
    expect(stored(issued.challengeId).consumedAt).toEqual(later(5));
  });

  it('works without any binding supplied (binding not checked)', async () => {
    const issued = await issue({ invitationId: 7 });
    expect((await consume()).challenge).toBe(issued.challenge);
  });

  it('is returned only once', async () => {
    await issue();
    expect(await consume()).not.toBeNull();
    expect(await consume()).toBeNull();
    expect(await consume({ now: later(6) })).toBeNull();
  });

  it('rejects when there is no challenge', async () => {
    expect(await consume()).toBeNull();
  });

  it('rejects an expired challenge, at and after the expiry instant, but not a moment before', async () => {
    await issue();
    expect(await consume({ now: later(120) })).toBeNull(); // expiresAt > now is required
    expect(await consume({ now: later(500) })).toBeNull();
    expect(db.challenges[0].consumedAt).toBeNull(); // an expired row is simply never claimable
    expect(await consume({ now: later(119) })).not.toBeNull();
  });

  it('rejects another Admin\'s challenge', async () => {
    await issue({ adminId: 2 });
    expect(await consume({ adminId: 1 })).toBeNull();
    expect(db.challenges[0].consumedAt).toBeNull(); // untouched
    expect(await consume({ adminId: 2 })).not.toBeNull();
  });

  it('rejects another purpose', async () => {
    await issue();
    for (const purpose of ['authentication', 'recovery_registration', 'unlock']) {
      expect(await consume({ purpose })).toBeNull();
    }
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  describe('bindings', () => {
    it('rejects a wrong or missing invitation, session or recovery binding, without consuming', async () => {
      await issue({ invitationId: 7 });
      expect(await consume({ invitationId: 8 })).toBeNull();
      expect(await consume({ invitationId: null })).toBeNull(); // must be unbound, but it is bound
      await issue({ sessionId: 3 });
      expect(await consume({ sessionId: 4 })).toBeNull();
      expect(await consume({ invitationId: 7 })).toBeNull(); // this one is session-bound now
      await issue({ purpose: 'recovery_registration', recoveryRequestId: 5 });
      expect(await consume({ purpose: 'recovery_registration', recoveryRequestId: 6 })).toBeNull();
      expect(db.challenges.filter((c) => c.consumedAt === null && c.purpose === 'registration')).toHaveLength(1);
    });

    it('accepts the matching binding, and null for an unbound challenge', async () => {
      await issue({ sessionId: 3 });
      expect(await consume({ sessionId: 3 })).toMatchObject({ sessionId: 3 });
      await issue({ now: later(1) });
      expect(await consume({ sessionId: null, now: later(2) })).toMatchObject({ sessionId: null });
    });

    it('rejects invalid binding values and bindings the purpose does not allow', async () => {
      await expect(consume({ invitationId: 0 })).rejects.toThrow(TypeError);
      await expect(consume({ sessionId: '3' })).rejects.toThrow(TypeError);
      await expect(consume({ recoveryRequestId: 3 })).rejects.toThrow('not allowed');
      await expect(consume({ purpose: 'authentication', sessionId: 3 })).rejects.toThrow('not allowed');
    });
  });

  it.each([[undefined], [null], [0], ['1'], [1.5]])('rejects admin id %p', async (adminId) => {
    await expect(consume({ adminId })).rejects.toThrow(TypeError);
  });

  it.each([[undefined], ['nope'], ['__proto__'], [7]])('rejects purpose %p', async (purpose) => {
    await expect(consume({ purpose })).rejects.toThrow(TypeError);
  });

  it('never takes a challenge id or value from the caller', async () => {
    const issued = await issue();
    const claimed = await consumeAdminWebAuthnChallenge({
      adminId: 2, purpose: 'registration', now: later(1), challengeId: issued.challengeId, challenge: issued.challenge,
    });
    expect(claimed).toBeNull(); // a known id/value does not help another Admin
    expect(db.challenges[0].consumedAt).toBeNull();
  });

  describe('concurrency and replay', () => {
    it('lets exactly one of several simultaneous consumers win', async () => {
      const issued = await issue();
      const results = await Promise.all(Array.from({ length: 8 }, () => consume()));
      const winners = results.filter(Boolean);
      expect(winners).toHaveLength(1);
      expect(winners[0].challenge).toBe(issued.challenge);
      expect(db.challenges.filter((c) => c.consumedAt !== null)).toHaveLength(1);
    });

    it('claims with a conditional update, not a read followed by a blind write', async () => {
      const issued = await issue();
      // Another request consumes it between this request's read and its update.
      const original = fake.prisma.adminWebAuthnChallenge.findFirst;
      fake.prisma.adminWebAuthnChallenge.findFirst = async (args) => {
        const row = await original(args);
        stored(issued.challengeId).consumedAt = later(1); // the rival wins the race after our read
        return row;
      };
      try {
        expect(await consume()).toBeNull();
      } finally {
        fake.prisma.adminWebAuthnChallenge.findFirst = original;
      }
      expect(stored(issued.challengeId).consumedAt).toEqual(later(1)); // still the rival's stamp
    });

    it('does not claim a challenge that expires between the read and the update', async () => {
      const issued = await issue();
      const original = fake.prisma.adminWebAuthnChallenge.findFirst;
      fake.prisma.adminWebAuthnChallenge.findFirst = async (args) => {
        const row = await original(args);
        stored(issued.challengeId).expiresAt = later(1); // pretend the clock passed expiry meanwhile
        return row;
      };
      try {
        expect(await consume()).toBeNull();
      } finally {
        fake.prisma.adminWebAuthnChallenge.findFirst = original;
      }
      expect(stored(issued.challengeId).consumedAt).toBeNull();
    });

    it('consumption is final: a failed verification cannot reuse the challenge', async () => {
      await issue();
      const claimed = await consume();
      expect(claimed).not.toBeNull();
      // The caller's WebAuthn verification now fails. The contract offers no way to undo it:
      expect(await consume({ now: later(6) })).toBeNull();
      expect(await consume({ now: later(7), invitationId: null })).toBeNull();
      expect(stored(claimed.challengeId).consumedAt).toEqual(later(5));
      // Only a freshly issued challenge (a new ceremony) can be consumed again.
      const fresh = await issue({ now: later(10) });
      expect((await consume({ now: later(11) })).challenge).toBe(fresh.challenge);
      expect(fresh.challenge).not.toBe(claimed.challenge);
    });

    it('re-issuing never revives a consumed challenge', async () => {
      const first = await issue();
      await consume();
      await issue({ now: later(10) });
      expect(stored(first.challengeId).consumedAt).toEqual(later(5));
    });
  });

  it('exports no restore or reopen function', () => {
    const exported = Object.keys(require('../src/modules/admin/auth/admin-webauthn-challenge.service')).join(' ');
    expect(exported).not.toMatch(/restore|reopen|unconsume|reset|release/i);
  });
});

describe('library compatibility of the stored value', () => {
  it('decoded bytes re-encode to the stored challenge (what generateRegistrationOptions will emit when given challengeBytes)', async () => {
    const issued = await issue();
    expect(isoBase64URL.fromBuffer(issued.challengeBytes)).toBe(issued.challenge);
    // whereas a string challenge would be UTF-8 encoded by the library and would NOT round-trip:
    expect(isoBase64URL.fromBuffer(Buffer.from(issued.challenge, 'utf8'))).not.toBe(issued.challenge);
  });
});
