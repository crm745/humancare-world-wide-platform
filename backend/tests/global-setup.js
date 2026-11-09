// Runs once before each `jest` run: empties the test database so leftover rows from
// earlier runs never pile up or leak into a test. Upload files belonging to the test
// rows go too (uploads/ is shared with the dev server, so only files a test-DB row
// points at are touched).
//
// Refuses to run unless the connected database is literally `humancare_test`, so a
// wrong DATABASE_URL can never wipe the dev or any real database.
const fs = require('fs');
const path = require('path');

const EXPECTED_DB = 'humancare_test';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// While a manual integration session uses `humancare_test` (real patient, Admin and uploads), this file
// exists and no Jest run may empty the database. Created by hand when the session starts and deleted when
// it ends; it is in .gitignore. Checked before anything else, so a refused run touches nothing.
const INTEGRATION_LOCK = path.join(__dirname, '..', '.integration-session.lock');

function assertNoIntegrationSession(lockFile = INTEGRATION_LOCK) {
  if (fs.existsSync(lockFile)) {
    throw new Error(
      `An integration session is active (${lockFile} exists), so the tests will not run: they would empty every table of ` +
        'humancare_test, including the accounts, requests and uploads of that session. ' +
        'Finish the session and delete the lock file, then run the tests again. Nothing was changed.',
    );
  }
}

async function globalSetup() {
  assertNoIntegrationSession();
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true, quiet: true });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const [{ db }] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db');
    if (db !== EXPECTED_DB) {
      throw new Error(`Refusing to wipe database "${db}": tests only run against "${EXPECTED_DB}". Check .env.test.`);
    }

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
}

module.exports = globalSetup;
module.exports.assertNoIntegrationSession = assertNoIntegrationSession;
module.exports.INTEGRATION_LOCK = INTEGRATION_LOCK;
