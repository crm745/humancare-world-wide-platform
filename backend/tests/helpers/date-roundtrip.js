// Child-process helper (see in-timezone.js): saves a request with a preferred date through the
// real service and Prisma, then reads it back every way the system can, so a test can prove the
// calendar day never shifts whatever timezone the server runs in. Test database only.
//
//   node -e "require('./tests/helpers/date-roundtrip').main().then((r) => console.log(JSON.stringify(r)))" -- <userId> <YYYY-MM-DD>
require('dotenv').config({ path: '.env.test', override: true, quiet: true });

async function main() {
  const [userId, preferredDate] = process.argv.slice(1); // node -e puts the arguments after the program name
  const { prisma } = require('../../src/db/prisma');
  const { createRequest } = require('../../src/modules/requests/requests.service');
  try {
    const [{ db }] = await prisma.$queryRawUnsafe('SELECT DATABASE() AS db');
    if (db !== 'humancare_test') throw new Error(`refusing to run against ${db}`);

    const created = await createRequest(Number(userId), {
      serviceType: 'Ground Ambulance (GA)', serviceKey: 'ground', patientName: 'Timezone Tester', origin: 'a', destination: 'b', preferredDate,
    });
    const read = await prisma.serviceRequest.findUnique({ where: { id: created.id } });
    const [raw] = await prisma.$queryRawUnsafe('SELECT DATE_FORMAT(preferred_date, "%Y-%m-%d") AS day, CAST(preferred_date AS CHAR) AS text FROM service_requests WHERE id = ?', created.id);
    return {
      offsetMinutes: new Date(2031, 5, 1).getTimezoneOffset(),
      sqlDay: raw.day,
      sqlText: raw.text,
      returnedFromCreate: created.preferredDate && created.preferredDate.toISOString(),
      readBack: read.preferredDate.toISOString(),
      json: JSON.parse(JSON.stringify({ d: read.preferredDate })).d,
      utcDay: read.preferredDate.toISOString().slice(0, 10),
      localDay: [read.preferredDate.getFullYear(), String(read.preferredDate.getMonth() + 1).padStart(2, '0'), String(read.preferredDate.getDate()).padStart(2, '0')].join('-'),
    };
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { main };
