// An in-memory stand-in for the parts of Prisma that the session code uses (users, corporate users, auth sessions), with the same where-clause behaviour for the shapes the code writes
// (equality, null, NOT, gt / lt, OR). Used by the safe session tests: no database, no network.
function matches(row, where) {
  return Object.entries(where || {}).every(([key, cond]) => {
    if (key === 'OR') return cond.some((c) => matches(row, c));
    if (key === 'NOT') return !matches(row, cond);
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      // SQL semantics: a comparison with NULL is never true (JS would coerce null to 0)
      if (('gt' in cond || 'lt' in cond) && value == null) return false;
      if ('gt' in cond && !(value > cond.gt)) return false;
      if ('lt' in cond && !(value < cond.lt)) return false;
      return true;
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });
}

function createFakePrisma() {
  const store = { users: [], corporateUsers: [], sessions: [] };
  const apply = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v; };
  const prisma = {
    __store: store,
    user: {
      findUnique: jest.fn(async ({ where }) => store.users.find((u) => u.id === where.id) || null),
      findFirst: jest.fn(async ({ where }) => store.users.find((u) => matches(u, where)) || null),
      updateMany: jest.fn(async ({ where, data }) => { const rows = store.users.filter((u) => matches(u, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; }),
    },
    corporateUser: {
      findUnique: jest.fn(async ({ where }) => store.corporateUsers.find((u) => u.id === where.id || u.email === where.email) || null),
    },
    authSession: {
      create: jest.fn(async ({ data }) => {
        const row = { previousHash: null, rotatedAt: null, revokedAt: null, revokedReason: null, userAgent: null, userId: null, corporateUserId: null, createdAt: new Date(), lastActivityAt: new Date(), ...data };
        store.sessions.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => store.sessions.find((r) => r.id === where.id) || null),
      findMany: jest.fn(async ({ where, orderBy, take }) => {
        let rows = store.sessions.filter((r) => matches(r, where));
        if (orderBy && orderBy.lastActivityAt === 'desc') rows = rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return rows.slice(0, take || rows.length);
      }),
      updateMany: jest.fn(async ({ where, data }) => { const rows = store.sessions.filter((r) => matches(r, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; }),
      deleteMany: jest.fn(async ({ where }) => { const keep = store.sessions.filter((r) => !matches(r, where)); const count = store.sessions.length - keep.length; store.sessions = keep; return { count }; }),
    },
  };
  return prisma;
}

module.exports = { createFakePrisma, matches };
