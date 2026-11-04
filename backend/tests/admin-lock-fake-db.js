// In-memory stand-in for the Prisma client, used by the Admin Lock tests so they never touch a
// database. Not a test file (no .test.js). It supports just the models/operations the Admin
// invitation code uses. Every operation yields to the event loop, so concurrent callers really
// interleave; updateMany is atomic (as a single SQL UPDATE is), and a failed transaction undoes
// only its own writes, so another transaction's committed work survives.
const db = { admins: [], invitations: [], challenges: [], passkeys: [], sessions: [], refreshTokens: [], audits: [], events: [], recoveryRequests: [], recoveryApprovals: [], failAudit: false, failCreate: null, afterRead: null, auditClock: null };

function reset() {
  Object.assign(db, { admins: [], invitations: [], challenges: [], passkeys: [], sessions: [], refreshTokens: [], audits: [], events: [], recoveryRequests: [], recoveryApprovals: [], failAudit: false, failCreate: null, afterRead: null, auditClock: null });
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond === null || typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, arg]) => {
      if (op === 'in') return arg.includes(value);
      if (op === 'gt') return value > arg;
      if (op === 'lt') return value < arg;
      if (op === 'lte') return value <= arg;
      if (op === 'gte') return value >= arg;
      if (op === 'not') return value !== arg;
      throw new Error(`fake db: unsupported operator ${op}`);
    });
  });
}

const tick = () => Promise.resolve();

// A row lock like InnoDB's: an UPDATE inside a transaction on a row keyed `key` holds it until
// that transaction commits or rolls back, and other transactions wanting it wait their turn.
const locks = new Map();
async function acquire(key, held) {
  if (held.has(key)) return;
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => gate));
  await previous;
  held.set(key, release);
}

function makeClient(undo) {
  const remember = (fn) => { if (undo) undo.push(fn); };

  function model(table, extra = {}) {
    const rows = () => db[table];
    return {
      async findUnique({ where, include }) {
        await tick();
        const row = rows().find((r) => matches(r, where));
        if (!row) return null;
        const copy = { ...row };
        if (include?.admin) copy.admin = db.admins.find((a) => a.id === row.adminId) ? { ...db.admins.find((a) => a.id === row.adminId) } : null;
        if (db.afterRead) await db.afterRead(table, copy);
        return copy;
      },
      async count({ where } = {}) {
        await tick();
        return rows().filter((r) => matches(r, where)).length;
      },
      async findFirst({ where, orderBy }) {
        await tick();
        let found = rows().filter((r) => matches(r, where));
        if (orderBy) {
          const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0]);
          found = [...found].sort((a, b) => {
            for (const [field, dir] of keys) {
              const cmp = (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1);
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        }
        return found[0] ? { ...found[0] } : null;
      },
      async findMany({ where }) {
        await tick();
        return rows().filter((r) => matches(r, where)).map((r) => ({ ...r }));
      },
      async create({ data }) {
        await tick();
        if (db.failCreate === table) throw new Error(`${table} create failed`);
        extra.beforeCreate?.(data);
        const row = { id: rows().length + 1, ...(extra.defaults || {}), ...data };
        rows().push(row);
        db.events.push(`${table}.create`);
        remember(() => { rows().splice(rows().indexOf(row), 1); });
        return { ...row };
      },
      async updateMany({ where, data }) {
        await tick();
        if (undo && extra.lockKey && typeof where.id === 'number') await acquire(extra.lockKey(where), undo.held);
        const targets = rows().filter((r) => matches(r, where));
        for (const row of targets) {
          const before = { ...row };
          Object.assign(row, data);
          remember(() => { Object.assign(row, before); });
        }
        if (targets.length) db.events.push(`${table}.update`);
        return { count: targets.length };
      },
    };
  }

  return {
    adminUser: model('admins', {
      lockKey: (where) => `admins:${where.id}`,
      beforeCreate(data) {
        if (db.admins.some((a) => a.email.toLowerCase() === data.email.toLowerCase())) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
        }
      },
    }),
    adminInvitation: model('invitations', { lockKey: (where) => `invitations:${where.id}`, defaults: { usedAt: null, revokedAt: null, createdAt: new Date() } }),
    adminSession: model('sessions', {
      lockKey: (where) => `sessions:${where.id}`,
      defaults: { revokedAt: null, revokedReason: null, revokedBy: null, ipAddress: null, userAgent: null },
    }),
    adminRefreshToken: model('refreshTokens', { defaults: { usedAt: null, replacedById: null, revokedAt: null } }),
    adminPasskey: model('passkeys', {
      defaults: { revokedAt: null },
      beforeCreate(data) {
        if (db.passkeys.some((p) => p.credentialIdHash === data.credentialIdHash)) {
          throw Object.assign(new Error('Unique constraint failed on credential_id_hash'), { code: 'P2002', meta: { target: ['credential_id_hash'] } });
        }
      },
    }),
    adminRecoveryRequest: model('recoveryRequests', {
      lockKey: (where) => `recoveryRequests:${where.id}`,
      defaults: { status: 'pending', approvalsRequired: 2, requestedByAdminId: null, requestIp: null, reason: null, approvedAt: null, completedAt: null },
    }),
    adminRecoveryApproval: model('recoveryApprovals', {
      defaults: { reason: null, ipAddress: null },
      beforeCreate(data) {
        if (db.recoveryApprovals.some((r) => r.requestId === data.requestId && r.approverId === data.approverId)) {
          throw Object.assign(new Error('Unique constraint failed on (request_id, approver_id)'), { code: 'P2002', meta: { target: ['request_id', 'approver_id'] } });
        }
      },
    }),
    adminWebAuthnChallenge: model('challenges', { defaults: { consumedAt: null, invitationId: null, recoveryRequestId: null, sessionId: null, ipAddress: null } }),
    securityEvent: {
      async create({ data }) {
        await tick();
        if (db.failAudit) throw new Error('audit write failed');
        const row = { ...data, createdAt: db.auditClock || new Date() };
        db.audits.push(row);
        db.events.push('audit.create');
        undo?.push(() => { db.audits.splice(db.audits.indexOf(row), 1); });
        return { id: db.audits.length };
      },
      async count({ where } = {}) {
        await tick();
        return db.audits.filter((a) => matches(a, where)).length;
      },
      async findMany({ where } = {}) {
        await tick();
        return db.audits.filter((a) => matches(a, where)).map((a) => ({ ...a }));
      },
      // The newest matching row (rows are appended in time order, so "newest" is the last one).
      async findFirst({ where } = {}) {
        await tick();
        const found = db.audits.filter((a) => matches(a, where));
        return found.length ? { ...found[found.length - 1] } : null;
      },
    },
  };
}

const prisma = {
  ...makeClient(null),
  async $transaction(fn) {
    const undo = [];
    undo.held = new Map();
    try {
      const result = await fn(makeClient(undo));
      db.events.push('commit');
      return result;
    } catch (err) {
      while (undo.length) undo.pop()();
      db.events.push('rollback');
      throw err;
    } finally {
      for (const release of undo.held.values()) release();
    }
  },
};

module.exports = { db, prisma, reset };
