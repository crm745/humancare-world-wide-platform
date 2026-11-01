// Server-side script: lets a regular admin review corporate registrations (list, approve,
// reject, provision), or takes that away again. Superadmins always can and need nothing.
// It is a script, not an API, on purpose: the permission is granted by someone with access
// to the server, never by a request.
//
//   node src/grant-corporate-review.js admin@example.com          grant
//   node src/grant-corporate-review.js admin@example.com --revoke  revoke
const { prisma } = require('./db/prisma');

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email || (flag && flag !== '--revoke')) {
    console.error('Usage: node src/grant-corporate-review.js <admin email> [--revoke]');
    process.exit(1);
  }
  const admin = await prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!admin) {
    console.error('No admin with that email.');
    process.exit(1);
  }
  const grant = flag !== '--revoke';
  await prisma.adminUser.update({ where: { id: admin.id }, data: { corporateReview: grant } });
  console.log(`${grant ? 'Granted' : 'Revoked'} corporate registration review for`, { id: admin.id, email: admin.email, role: admin.role });
  if (admin.role === 'superadmin') console.log('Note: superadmins can always review corporate registrations.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
