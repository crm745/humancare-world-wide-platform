// Reports how fresh the local GeoNames city data is, for a person or a scheduled check.
//
//   node scripts/geonames-status.js [--env-file .env] [--json]
//
// Exit code:  0 ok (imported less than 90 days ago)
//             1 refresh due (90 to 180 days: records are still accepted, refresh now)
//             2 stale or empty (over 180 days, or nothing imported: Private Charter requests fail)
//             3 the status could not be read (database unreachable...)
// Run it from a scheduler and alert on a non-zero code to get the 90-day reminder. See
// backend/GEONAMES-DATASET.md.
const path = require('path');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  // dotenv first: the Prisma client reads DATABASE_URL when it is first loaded.
  require('dotenv').config({ path: path.resolve(args['env-file'] || '.env'), override: true, quiet: true });
  const { prisma } = require('../src/db/prisma');
  const { getDatasetStatus } = require('../src/modules/geo/geo.service');
  try {
    const status = await getDatasetStatus({ withCounts: true });
    if (args.json) {
      console.log(JSON.stringify(status));
    } else {
      console.log(`State: ${status.state}`);
      if (status.lastImportAt) console.log(`Last import: ${status.lastImportAt} (${status.ageDays} days ago)`);
      console.log(`Refresh recommended after ${status.refreshRecommendedAfterDays} days; records refused after ${status.maxAgeDays} days.`);
      if (status.cities !== undefined) console.log(`Cities: ${status.cities}, other names: ${status.alternateNames}, cities already past the limit: ${status.citiesPastLimit}`);
      if (status.state === 'refresh_due') console.log('ACTION: refresh the data now (backend/GEONAMES-DATASET.md).');
      if (status.state === 'stale' || status.state === 'empty') console.log('ACTION: Private Charter requests are failing: import the data now (backend/GEONAMES-DATASET.md).');
    }
    process.exitCode = { ok: 0, refresh_due: 1, stale: 2, empty: 2 }[status.state];
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Could not read the city data status:', err.message);
  process.exit(3);
});
