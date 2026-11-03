// One-time script to create a test corporate account for local testing.
// Run from backend/ with: node scripts/seed-corporate.js
// Set INITIAL_CORPORATE_PASSWORD in .env to pick the password yourself — otherwise a
// fresh random one is generated and printed below. Never hardcode a password here;
// this file (and its history) ends up in Git.
const bcrypt = require('bcryptjs');
const { prisma } = require('../src/db/prisma');
const { randomPassword } = require('../src/common/utils/random-password');

async function main() {
  const corporate = await prisma.corporate.upsert({
    where: { id: 1 },
    update: {},
    create: {
      companyName: 'Meridian Global Assistance',
      type: 'tpa',
    },
  });
  console.log('Corporate created:', corporate);

  const email = 'ops@meridianglobal.com';
  // A plain upsert with an empty `update` would silently skip re-hashing on a second
  // run, but we'd still print the newly-generated password as if it had been
  // saved — so re-running against an existing login is a no-op instead.
  const existing = await prisma.corporateUser.findUnique({ where: { email } });
  if (existing) {
    console.log('Corporate login already exists, password unchanged:', { email });
    return;
  }

  const password = process.env.INITIAL_CORPORATE_PASSWORD || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const corporateUser = await prisma.corporateUser.create({
    data: { corporateId: corporate.id, email, passwordHash },
  });

  console.log('Corporate login created:', { email: corporateUser.email, password });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
