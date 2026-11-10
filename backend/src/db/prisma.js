const { PrismaClient } = require('@prisma/client');
const { assertTestDatabaseUrl } = require('../common/safety/test-database-guard');

// In the test environment the client may only ever be built for the dedicated test database.
// This runs before the client exists, so a wrong DATABASE_URL (a missing backend/.env.test, an ad-hoc
// Jest config, a script) stops here instead of connecting to the development database.
if (process.env.NODE_ENV === 'test') assertTestDatabaseUrl(process.env.DATABASE_URL);

// Patient password hashes are left out of every query by default, so no endpoint can
// leak one by returning a whole user row. Auth code that needs it opts back in with
// `omit: { passwordHash: false }`.
const prisma = new PrismaClient({ omit: { user: { passwordHash: true } } });

module.exports = { prisma };
