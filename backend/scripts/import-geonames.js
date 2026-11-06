// Loads (or refreshes) the local GeoNames city table that Private Charter origin and destination
// cities are searched and verified against. See backend/GEONAMES-DATASET.md for the whole procedure.
//
//   node scripts/import-geonames.js --file <dump.txt> [--admin1 <admin1CodesASCII.txt>]
//        [--env-file .env] --confirm-database <database name> [--batch 1000]
//        [--alt-min-population <n>] [--dry-run]
//
// Loads each city and the other names it is known by (translations, local spellings...), so a city
// is found by any of them. --alt-min-population n keeps those other names only for places with at
// least n people (default 1: places with a known population; 0 keeps every place's names).
//
// --dry-run reads and counts but writes nothing (no database name needed).
// Without --dry-run the script only runs when --confirm-database names the database in the chosen
// env file's DATABASE_URL, so a wrong env file or a copy-pasted command cannot fill the wrong one.
const path = require('path');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--')) { args[arg.slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: node scripts/import-geonames.js --file <dump.txt> [--admin1 <admin1CodesASCII.txt>] [--env-file .env] --confirm-database <name> [--dry-run]');
    process.exit(2);
  }

  // dotenv first: the Prisma client reads DATABASE_URL when it is first loaded.
  require('dotenv').config({ path: path.resolve(args['env-file'] || '.env'), override: true, quiet: true });
  let target;
  try {
    const url = new URL(process.env.DATABASE_URL);
    target = { host: `${url.hostname}:${url.port || '3306'}`, database: url.pathname.replace(/^\//, '') };
  } catch {
    console.error('DATABASE_URL is missing or not a valid URL in the chosen env file.');
    process.exit(2);
  }
  console.log(`Target: database "${target.database}" on ${target.host} (env file: ${args['env-file'] || '.env'})`);

  if (!args.dryRun && args['confirm-database'] !== target.database) {
    console.error(`Refusing to write: pass --confirm-database ${target.database} to confirm this is the database you mean.`);
    process.exit(2);
  }

  if (args['alt-min-population'] !== undefined && !/^\d+$/.test(args['alt-min-population'])) {
    console.error('--alt-min-population must be a whole number (0 keeps every place\'s other names).');
    process.exit(2);
  }

  const { prisma } = require('../src/db/prisma');
  const { importDump } = require('../src/modules/geo/geonames-import');
  const started = Date.now();
  try {
    const stats = await importDump({
      prisma,
      file: path.resolve(args.file),
      admin1File: args.admin1 ? path.resolve(args.admin1) : undefined,
      batchSize: Number(args.batch) || 1000,
      altMinPopulation: args['alt-min-population'] === undefined ? undefined : Number(args['alt-min-population']),
      dryRun: Boolean(args.dryRun),
      onProgress: (s) => process.stdout.write(`\r${s.linesRead} lines read, ${s.accepted} accepted`),
    });
    console.log(`\n${stats.dryRun ? 'DRY RUN (nothing written)' : 'Done'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(stats, null, 2));
    if (!stats.dryRun) {
      const total = await prisma.geonamesCity.count();
      const names = await prisma.geonamesCityName.count();
      const oldest = await prisma.geonamesCity.findFirst({ orderBy: { verifiedAt: 'asc' }, select: { verifiedAt: true } });
      console.log(`geonames_cities now holds ${total} records and geonames_city_names ${names}; the oldest city was last seen ${oldest && oldest.verifiedAt.toISOString()}.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
