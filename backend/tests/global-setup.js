// Runs once before each `jest` run: empties the test database so leftover rows from
// earlier runs never pile up or leak into a test. Upload files belonging to the test
// rows go too (uploads/ is shared with the dev server, so only files a test-DB row
// points at are touched).
//
// Refuses to run unless the DATABASE_URL names `humancare_test` on this machine with a test user
// (checked BEFORE connecting) and the server then confirms it (checked before wiping), so a wrong
// DATABASE_URL can never wipe the dev or any real database. Uploads are cleaned only from
// backend/.e2e-uploads, never the shared development folder.
const fs = require('fs');
const path = require('path');

const {
  assertTestDatabaseUrl,
  assertSafeTestEnvironment,
  verifyLiveDatabase,
  TEST_UPLOADS_DIR: UPLOADS_DIR,
} = require('../src/common/safety/test-database-guard');

module.exports = async function globalSetup() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true, quiet: true });
  // Before anything connects: the URL, the mail and uploads settings.
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  assertSafeTestEnvironment(process.env);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await verifyLiveDatabase(prisma); // the server itself must say humancare_test, as a test user

    const files = await prisma.$queryRawUnsafe('SELECT file_url AS f FROM documents UNION SELECT file_url FROM corporate_documents');
    // Corporate registration uploads live in a JSON list rather than their own table.
    const registrations = await prisma.$queryRawUnsafe('SELECT documents AS d FROM corporate_registrations');
    for (const { d } of registrations) {
      const docs = typeof d === 'string' ? JSON.parse(d) : d;
      for (const doc of Array.isArray(docs) ? docs : []) if (doc?.fileUrl) files.push({ f: doc.fileUrl });
    }
    const tables = await prisma.$queryRawUnsafe(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME <> '_prisma_migrations'",
    );

    // One connection for the whole wipe: FOREIGN_KEY_CHECKS is per session.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      for (const { t } of tables) await tx.$executeRawUnsafe(`DELETE FROM \`${t}\``);
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
    }, { timeout: 60000 });

    for (const { f } of files) {
      const file = path.join(UPLOADS_DIR, path.basename(String(f)));
      fs.rmSync(file, { force: true });
    }
  } finally {
    await prisma.$disconnect();
  }
};
