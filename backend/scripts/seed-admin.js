// One-time script to create the first admin account for local testing.
// Run from backend/ with: node scripts/seed-admin.js
// Set INITIAL_ADMIN_PASSWORD in .env to pick the password yourself — otherwise a
// fresh random one is generated and printed below. Never hardcode a password here;
// this file (and its history) ends up in Git.
const bcrypt = require('bcryptjs');
const { prisma } = require('../src/db/prisma');
const { randomPassword } = require('../src/common/utils/random-password');

async function main() {
  const email = 'admin@humancareworldwide.com';
  // A plain upsert with an empty `update` would silently skip re-hashing on a
  // second run, but we'd still print the newly-generated password as if it had
  // been saved — so re-running against an existing admin is a no-op instead.
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.log('Admin login already exists, password unchanged:', { email });
    return;
  }

  const password = process.env.INITIAL_ADMIN_PASSWORD || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  // Bootstrap account is always superadmin — otherwise nobody could create the
  // first additional admin login.
  const admin = await prisma.adminUser.create({
    data: { name: 'HumanCare Admin', email, passwordHash, role: 'superadmin' },
  });

  console.log('Admin login created:', { email: admin.email, password, role: admin.role });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
