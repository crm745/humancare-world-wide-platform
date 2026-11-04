// Admin provisioning (Step 7.5): the service behind scripts/admin-create.js and the mailer's
// sensitive-message handling. No database: Prisma is an in-memory stand-in whose $transaction
// commits or rolls back its rows, and nodemailer is never reached.
const mockDb = { admins: [], invitations: [], audits: [], events: [], failAudit: false };

function mockSnapshot() {
  return { admins: [...mockDb.admins], invitations: [...mockDb.invitations], audits: [...mockDb.audits] };
}

function mockMakeTx() {
  return {
    adminUser: {
      create: jest.fn(async ({ data }) => {
        if (mockDb.admins.some((a) => a.email.toLowerCase() === data.email.toLowerCase())) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002', meta: { target: ['email'] } });
        }
        const row = { id: mockDb.admins.length + 1, ...data };
        mockDb.admins.push(row);
        mockDb.events.push('admin.create');
        return row;
      }),
    },
    adminInvitation: {
      create: jest.fn(async ({ data }) => {
        const row = { id: mockDb.invitations.length + 1, usedAt: null, revokedAt: null, ...data };
        mockDb.invitations.push(row);
        mockDb.events.push('invitation.create');
        return row;
      }),
    },
    securityEvent: {
      create: jest.fn(async ({ data }) => {
        if (mockDb.failAudit) throw new Error('audit write failed');
        mockDb.audits.push(data);
        mockDb.events.push('audit.create');
        return { id: mockDb.audits.length };
      }),
    },
  };
}

const mockTxClients = [];
jest.mock('../src/db/prisma', () => ({
  prisma: {
    $transaction: jest.fn(async (fn) => {
      const before = mockSnapshot();
      const tx = mockMakeTx();
      mockTxClients.push(tx);
      try {
        const result = await fn(tx);
        mockDb.events.push('commit');
        return result;
      } catch (err) {
        Object.assign(mockDb, before); // roll back
        mockDb.events.push('rollback');
        throw err;
      }
    }),
    adminUser: { create: jest.fn(() => { throw new Error('global client used outside the transaction'); }) },
    securityEvent: { create: jest.fn(() => { throw new Error('global client used outside the transaction'); }) },
  },
}));

jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn() }) }));

const crypto = require('crypto');
const {
  provisionAdmin,
  ProvisioningError,
  normalizeAdminEmail,
  superadminConfirmationPhrase,
} = require('../src/modules/admin/auth/admin-provisioning.service');
const { parseArgs } = require('../scripts/admin-create');
const mailer = require('../src/lib/mailer');

const ENV_KEYS = ['ADMIN_PORTAL_URL', 'EMAIL_PROVIDER', 'NODE_ENV', 'SMTP_USER', 'SMTP_PASS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const NOW = new Date('2027-03-01T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const PORTAL = 'https://admin.example.org';

beforeEach(() => {
  Object.assign(mockDb, { admins: [], invitations: [], audits: [], events: [], failAudit: false });
  mockTxClients.length = 0;
  process.env.ADMIN_PORTAL_URL = PORTAL;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// The service captured `sendMail` by destructuring, so stub the module it actually holds.
jest.mock('../src/lib/mailer', () => {
  const real = jest.requireActual('../src/lib/mailer');
  const wrapper = { sendMail: jest.fn(real.sendMail), __real: real };
  return wrapper;
});

const valid = { name: 'Asha Rao', email: 'asha@example.org', role: 'admin' };
const provision = (overrides = {}) => provisionAdmin({ ...valid, now: NOW, ...overrides });

describe('provisionAdmin', () => {
  beforeEach(() => {
    mailer.sendMail.mockReset().mockImplementation(async () => { mockDb.events.push('email'); });
  });

  it('creates an invited admin with no password and a hashed activation invitation', async () => {
    const result = await provision();
    expect(mockDb.admins).toHaveLength(1);
    expect(mockDb.admins[0]).toMatchObject({
      name: 'Asha Rao', email: 'asha@example.org', role: 'admin', status: 'invited', passwordHash: null, failedLoginCount: 0,
    });
    expect(mockDb.admins[0]).not.toHaveProperty('password');
    expect(result).toMatchObject({ admin: { id: 1, status: 'invited', role: 'admin' }, emailDelivered: true, emailError: null });
    expect(mockDb.invitations).toHaveLength(1);
    expect(mockDb.invitations[0]).toMatchObject({
      adminId: 1, purpose: 'activation', sentToEmail: 'asha@example.org', usedAt: null, revokedAt: null,
    });
  });

  it('expires the invitation exactly 72 hours after creation', async () => {
    const result = await provision();
    expect(mockDb.invitations[0].expiresAt).toEqual(new Date(NOW.getTime() + 72 * HOUR));
    expect(result.invitation.expiresAt).toEqual(new Date(NOW.getTime() + 72 * HOUR));
  });

  it('generates 32 random bytes, stores only their SHA-256, and mails the raw token only in a fragment', async () => {
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    await provision();
    expect(randomBytes).toHaveBeenCalledWith(32);
    const raw = randomBytes.mock.results.find((r) => r.value.length === 32).value;
    const token = raw.toString('base64url');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const stored = mockDb.invitations[0];
    expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(mockDb)).not.toContain(token); // not in any stored row, audit included

    const message = mailer.sendMail.mock.calls[0][0];
    expect(message.text).toContain(`${PORTAL}/accept-invite#token=${token}`);
    expect(message.html).toContain(`${PORTAL}/accept-invite#token=${token}`);
    expect(message.text).not.toContain('?token');
    expect(message.sensitive).toBe(true);
    expect(message.to).toBe('asha@example.org');
  });

  it('gives each invitation a different token', async () => {
    await provision();
    await provision({ email: 'second@example.org' });
    expect(mockDb.invitations[0].tokenHash).not.toBe(mockDb.invitations[1].tokenHash);
  });

  it('normalises the email (trim, lower case) before storing', async () => {
    await provision({ email: '  Asha.RAO@Example.ORG ' });
    expect(mockDb.admins[0].email).toBe('asha.rao@example.org');
    expect(mockDb.invitations[0].sentToEmail).toBe('asha.rao@example.org');
    expect(normalizeAdminEmail(' A@B.Co ')).toBe('a@b.co');
  });

  it('rejects a duplicate email, including case variants, without a second row or email', async () => {
    await provision();
    mailer.sendMail.mockClear();
    for (const email of ['asha@example.org', 'ASHA@EXAMPLE.ORG', ' Asha@Example.org ']) {
      await expect(provision({ email })).rejects.toMatchObject({ name: 'ProvisioningError', code: 'duplicate_email' });
    }
    expect(mockDb.admins).toHaveLength(1);
    expect(mockDb.invitations).toHaveLength(1);
    expect(mockDb.audits).toHaveLength(1);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('writes the audit event through the same transaction client, with operator identity and no secrets', async () => {
    await provision();
    expect(mockTxClients).toHaveLength(1);
    expect(mockTxClients[0].securityEvent.create).toHaveBeenCalledTimes(1);
    expect(mockDb.events.slice(0, 4)).toEqual(['admin.create', 'invitation.create', 'audit.create', 'commit']);
    const audit = mockDb.audits[0];
    expect(audit).toMatchObject({ event: 'admin_provisioned', actorType: 'operator', actorId: null, identifier: 'asha@example.org' });
    expect(audit.detail).toMatchObject({ adminId: 1, role: 'admin', invitationId: 1 });
    expect(audit.detail.operator).toEqual({ username: expect.anything(), hostname: expect.any(String) });
    expect(Object.keys(audit.detail.operator).sort()).toEqual(['hostname', 'username']);
    expect(JSON.stringify(audit)).not.toMatch(/token/i);
  });

  it('rolls back the account and invitation when the audit write fails, and sends nothing', async () => {
    mockDb.failAudit = true;
    await expect(provision()).rejects.toThrow('audit write failed');
    expect(mockDb.admins).toHaveLength(0);
    expect(mockDb.invitations).toHaveLength(0);
    expect(mockDb.events).toContain('rollback');
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('sends the email only after the transaction commits', async () => {
    await provision();
    expect(mockDb.events).toEqual(['admin.create', 'invitation.create', 'audit.create', 'commit', 'email']);
  });

  it('keeps the committed account and invitation when the email fails, and reports it', async () => {
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));
    const result = await provision();
    expect(result.emailDelivered).toBe(false);
    expect(result.emailError).toBe('SMTP connection refused');
    expect(mockDb.admins).toHaveLength(1);
    expect(mockDb.invitations).toHaveLength(1);
    expect(mockDb.events).not.toContain('rollback');
  });

  it('never logs the raw token or the invitation URL', async () => {
    const spies = ['log', 'error', 'warn', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    mailer.sendMail.mockRejectedValue(new Error('boom'));
    const result = await provision();
    const token = randomBytes.mock.results.find((r) => r.value.length === 32).value.toString('base64url');
    const output = spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n') + JSON.stringify(result);
    expect(output).not.toContain(token);
    expect(output).not.toContain('accept-invite');
  });

  it('refuses a missing or invalid ADMIN_PORTAL_URL before creating anything', async () => {
    delete process.env.ADMIN_PORTAL_URL;
    await expect(provision()).rejects.toThrow('ADMIN_PORTAL_URL is required');
    process.env.ADMIN_PORTAL_URL = 'http://admin.example.org';
    process.env.NODE_ENV = 'production';
    await expect(provision()).rejects.toThrow('https');
    expect(mockDb.admins).toHaveLength(0);
    expect(mockDb.events).toEqual([]);
  });

  describe('input validation', () => {
    it.each([
      ['missing name', { name: undefined }, 'invalid_name'],
      ['one-letter name', { name: 'A' }, 'invalid_name'],
      ['over-long name', { name: 'x'.repeat(101) }, 'invalid_name'],
      ['name with markup', { name: 'Asha <b>' }, 'invalid_name'],
      ['name with a control character', { name: 'Asha\u0007Rao' }, 'invalid_name'],
      ['missing email', { email: undefined }, 'invalid_email'],
      ['email without a domain', { email: 'asha' }, 'invalid_email'],
      ['email with spaces inside', { email: 'a sha@example.org' }, 'invalid_email'],
      ['two emails', { email: 'a@example.org,b@example.org' }, 'invalid_email'],
      ['over-long email', { email: `${'a'.repeat(190)}@example.org` }, 'invalid_email'],
      ['missing role', { role: undefined }, 'invalid_role'],
      ['unknown role', { role: 'owner' }, 'invalid_role'],
      ['role in the wrong case', { role: 'Admin' }, 'invalid_role'],
      ['the patient role', { role: 'patient' }, 'invalid_role'],
    ])('rejects %s without writing anything', async (_name, overrides, code) => {
      await expect(provision(overrides)).rejects.toMatchObject({ name: 'ProvisioningError', code });
      expect(mockDb.events).toEqual([]);
      expect(mailer.sendMail).not.toHaveBeenCalled();
    });

    it('collapses whitespace in names', async () => {
      await provision({ name: '  Asha   Rao ' });
      expect(mockDb.admins[0].name).toBe('Asha Rao');
    });
  });

  describe('superadmin', () => {
    const superValid = { role: 'superadmin' };
    const phrase = superadminConfirmationPhrase('asha@example.org');

    it.each([
      ['no confirmation', undefined],
      ['an empty confirmation', ''],
      ['"yes"', 'yes'],
      ['the phrase in lower case', phrase.toLowerCase()],
      ['the phrase for another email', superadminConfirmationPhrase('other@example.org')],
    ])('is refused with %s', async (_name, confirmation) => {
      await expect(provision({ ...superValid, superadminConfirmation: confirmation }))
        .rejects.toMatchObject({ code: 'superadmin_not_confirmed' });
      expect(mockDb.events).toEqual([]);
    });

    it('is created with the exact typed confirmation, matched against the normalised email', async () => {
      await provision({ ...superValid, email: 'ASHA@example.org', superadminConfirmation: phrase });
      expect(mockDb.admins[0]).toMatchObject({ role: 'superadmin', status: 'invited', passwordHash: null });
      expect(mockDb.audits[0].detail.role).toBe('superadmin');
    });

    it('does not ask for confirmation to create a plain admin', async () => {
      await expect(provision({ role: 'admin' })).resolves.toBeDefined();
    });
  });
});

describe('admin-create argument parsing', () => {
  const args = ['--name', 'Asha Rao', '--email', 'Asha@Example.org', '--role', 'admin'];

  it('parses and normalises valid arguments, in either form', () => {
    expect(parseArgs(args)).toEqual({ name: 'Asha Rao', email: 'asha@example.org', role: 'admin' });
    expect(parseArgs(['--name=Asha Rao', '--email=asha@example.org', '--role=superadmin']))
      .toEqual({ name: 'Asha Rao', email: 'asha@example.org', role: 'superadmin' });
  });

  it.each([
    ['no arguments', []],
    ['a missing option', args.slice(0, 4)],
    ['a missing value', ['--name', '--email', 'a@b.co', '--role', 'admin']],
    ['a trailing option', [...args.slice(0, 4), '--role']],
    ['an unknown option', [...args, '--password', 'secret']],
    ['a repeated option', [...args, '--role', 'superadmin']],
    ['a stray positional', [...args, 'extra']],
    ['an invalid role', ['--name', 'Asha', '--email', 'a@b.co', '--role', 'root']],
    ['an invalid email', ['--name', 'Asha', '--email', 'nope', '--role', 'admin']],
  ])('rejects %s', (_name, argv) => {
    expect(() => parseArgs(argv)).toThrow(ProvisioningError);
  });

  it('does not echo a rejected password option value', () => {
    try { parseArgs([...args, '--password', 'hunter2hunter2']); } catch (err) { expect(err.message).not.toContain('hunter2'); }
  });
});

describe('console mail provider', () => {
  it('prints a sensitive message without its content', async () => {
    const real = mailer.__real;
    process.env.EMAIL_PROVIDER = 'console';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await real.sendMail({
      to: 'asha@example.org',
      subject: 'Invitation',
      text: 'Open https://admin.example.org/accept-invite#token=SECRETVALUE',
      html: '<a href="https://admin.example.org/accept-invite#token=SECRETVALUE">x</a>',
      sensitive: true,
    });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('asha@example.org');
    expect(output).toContain('Invitation');
    expect(output).not.toContain('SECRETVALUE');
    expect(output).not.toContain('accept-invite');
  });

  it('still prints ordinary messages in full (OTP and registration emails are unchanged)', async () => {
    process.env.EMAIL_PROVIDER = 'console';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await mailer.__real.sendMail({ to: 'a@b.co', subject: 'Code', text: 'Your code is 123456' });
    expect(log.mock.calls.flat().join('\n')).toContain('Your code is 123456');
  });

  it('is still refused in production', async () => {
    process.env.EMAIL_PROVIDER = 'console';
    process.env.NODE_ENV = 'production';
    await expect(mailer.__real.sendMail({ to: 'a@b.co', subject: 's', text: 't', sensitive: true })).rejects.toThrow('production');
  });
});
