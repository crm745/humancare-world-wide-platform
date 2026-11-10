// Loads a GeoNames dump file into geonames_cities (and the other names of each city into
// geonames_city_names). Used by scripts/import-geonames.js; the procedure is in
// backend/GEONAMES-DATASET.md.
//
// Safe to run again and again with a newer dump:
//   - every accepted place is inserted or updated, and gets this run's `verified_at`;
//   - the other names of a place are replaced by the ones in this file, so a name GeoNames dropped
//     stops matching;
//   - a place the dump now lists as historical, abandoned, destroyed or as a subdivision of a city
//     is removed straight away (its other names go with it);
//   - a place that has vanished from the dump is left alone and simply ages out: after
//     GEONAMES_MAX_AGE_DAYS (180 at most) it stops being accepted (see geo.service.js).
// The file is streamed line by line, so the full allCountries.txt (over 1 GB) is fine.
const fs = require('fs');
const readline = require('readline');
const { Prisma } = require('@prisma/client');
const { parseAdmin1Names, parseGeonamesLine } = require('./geonames-format');

const SNIFF_LINES = 50;
const NAME_ROWS_PER_INSERT = 5000; // 3 placeholders per row, far under MySQL's 65,535
// Skip reasons that also mean "make sure it is gone from the table".
const REMOVE_REASONS = new Set(['historical-or-abandoned', 'subdivision']);
// Other names are kept for places with at least this many people. In the full dump about 4.5 million
// of the 5 million places have no recorded population (mostly hamlets) and carry 4.8 million of the
// 5.9 million other names; the 474,000 with a population carry 1.0 million. Their own name and
// plain-ASCII name stay searchable either way. Pass 0 to keep every place's names.
const DEFAULT_ALT_MIN_POPULATION = 1;

async function upsertCities(prisma, rows, verifiedAt) {
  const values = rows.map((r) => Prisma.sql`(${r.geonameId}, ${r.name}, ${r.asciiName}, ${r.admin1Name}, ${r.countryCode}, ${r.featureCode}, ${r.population}, ${r.timezone}, ${verifiedAt})`);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO geonames_cities (geoname_id, name, ascii_name, admin1_name, country_code, feature_code, population, timezone, verified_at)
    VALUES ${Prisma.join(values)} AS new_row
    ON DUPLICATE KEY UPDATE
      name = new_row.name, ascii_name = new_row.ascii_name, admin1_name = new_row.admin1_name,
      country_code = new_row.country_code, feature_code = new_row.feature_code,
      population = new_row.population, timezone = new_row.timezone, verified_at = new_row.verified_at`);
}

// Replaces the other names of these cities with the ones in the file. Returns how many were written.
async function replaceNames(prisma, rows) {
  await prisma.geonamesCityName.deleteMany({ where: { geonameId: { in: rows.map((r) => r.geonameId) } } });
  const names = rows.flatMap((r) => r.alternateNames.map((name) => [r.geonameId, name, r.population]));
  for (let i = 0; i < names.length; i += NAME_ROWS_PER_INSERT) {
    const values = names.slice(i, i + NAME_ROWS_PER_INSERT).map(([id, name, population]) => Prisma.sql`(${id}, ${name}, ${population})`);
    // ON DUPLICATE KEY: two spellings the table's collation treats as one (ß and ss) are one row.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO geonames_city_names (geoname_id, name, population) VALUES ${Prisma.join(values)} AS new_row
      ON DUPLICATE KEY UPDATE population = new_row.population`);
  }
  return names.length;
}

// A file that is not a GeoNames dump (wrong file, an HTML error page saved as .txt...) must not
// reach the database: at least half of its first lines have to look like dump rows (a dump with a
// stray bad line still loads, and that line is counted as skipped).
async function looksLikeDump(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let seen = 0;
  let wellFormed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    seen += 1;
    if (line.split('\t').length >= 18 && /^\d+$/.test(line.split('\t')[0])) wellFormed += 1;
    if (seen >= SNIFF_LINES) break;
  }
  rl.close();
  return seen > 0 && wellFormed > 0 && wellFormed / seen >= 0.5;
}

// `altMinPopulation`: places smaller than this keep no other names (their own name and plain-ASCII
// name are always searchable). Default DEFAULT_ALT_MIN_POPULATION (1); 0 keeps every place's names.
async function importDump({
  prisma, file, admin1File, batchSize = 1000, dryRun = false, now = new Date(), altMinPopulation = DEFAULT_ALT_MIN_POPULATION, onProgress = () => {},
}) {
  if (!(await looksLikeDump(file))) throw new Error(`${file} does not look like a GeoNames dump (19 tab-separated columns per line).`);

  const admin1Names = admin1File ? parseAdmin1Names(fs.readFileSync(admin1File, 'utf8')) : new Map();
  const stats = {
    linesRead: 0, accepted: 0, written: 0, alternateNames: 0, alternateNamesWritten: 0, removedExcluded: 0,
    skipped: {}, admin1NamesLoaded: admin1Names.size, altMinPopulation, dryRun,
  };

  let batch = [];
  let excludedIds = [];
  const flush = async () => {
    if (batch.length && !dryRun) {
      await upsertCities(prisma, batch, now);
      stats.alternateNamesWritten += await replaceNames(prisma, batch);
      stats.written += batch.length;
    }
    batch = [];
    if (excludedIds.length && !dryRun) {
      const { count } = await prisma.geonamesCity.deleteMany({ where: { geonameId: { in: excludedIds } } });
      stats.removedExcluded += count;
    }
    excludedIds = [];
    onProgress(stats);
  };

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    stats.linesRead += 1;
    const parsed = parseGeonamesLine(line, admin1Names);
    if (parsed.skip) {
      stats.skipped[parsed.skip] = (stats.skipped[parsed.skip] || 0) + 1;
      if (REMOVE_REASONS.has(parsed.skip)) excludedIds.push(Number(line.slice(0, line.indexOf('\t'))));
    } else {
      if (parsed.row.population < altMinPopulation) parsed.row.alternateNames = [];
      stats.accepted += 1;
      stats.alternateNames += parsed.row.alternateNames.length;
      batch.push(parsed.row);
    }
    if (batch.length >= batchSize || excludedIds.length >= batchSize) await flush();
  }
  await flush();
  return stats;
}

module.exports = { importDump, upsertCities, replaceNames, looksLikeDump, DEFAULT_ALT_MIN_POPULATION };
