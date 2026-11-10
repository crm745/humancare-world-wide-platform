// City search and verification for Private Charter, against the local GeoNames tables
// (geonames_cities and geonames_city_names). No GeoNames account and no network call at runtime.
//
// A city is "verified" when its geonameId is in that table, it is an allowed kind of populated
// place, and the record is not older than GEONAMES_MAX_AGE_DAYS (180 at most). Everything the
// request stores about the city (name, country, timezone) comes from this table, never from the
// client.
//
// Fail closed: an id that is not in the table is simply not a valid city (a 400 for the field),
// but an empty table or records past their age limit mean the DATA is not available, which is a
// 503 for the caller and an alert for the operator, never a pass.
//
// Freshness: refresh the data every 90 days (a reminder is logged from then on, see
// checkDatasetAge); a record older than 180 days is refused.
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../db/prisma');
const { COUNTRIES } = require('../../common/constants/countries');
const { isAcceptablePlace } = require('./geonames-format');
const { readCityRef } = require('./city-ref');

const DAY_MS = 24 * 60 * 60 * 1000;
const APPROVED_MAX_AGE_DAYS = 180;
const REFRESH_RECOMMENDED_DAYS = 90;
const SEARCH_MAX_RESULTS = 10;
// A one- or two-letter start would match a huge part of the table, so it is limited to places
// with a real population until more letters narrow it down.
const SHORT_QUERY_LENGTH = 3;
const SHORT_QUERY_MIN_POPULATION = 5000;

const COUNTRY_NAME = new Map(COUNTRIES.map((country) => [country.code, country.name]));

class CityDataUnavailableError extends Error {
  constructor(publicCode, detail) {
    super('City verification is temporarily unavailable. Please try again later.');
    this.name = 'CityDataUnavailableError';
    this.statusCode = 503;
    this.publicCode = publicCode;
    this.detail = detail; // for the log only: never sent to the client
  }
}

// A whole number of days, 180 at most. Anything else in the setting ("", "abc", "0", "1.5x") is
// ignored rather than half-read.
function maxAgeDays() {
  const setting = process.env.GEONAMES_MAX_AGE_DAYS;
  if (typeof setting !== 'string' || !/^[1-9]\d{0,4}$/.test(setting)) return APPROVED_MAX_AGE_DAYS;
  return Math.min(Number(setting), APPROVED_MAX_AGE_DAYS);
}

// The reminder starts at 90 days, or earlier if the limit was set stricter than that.
const refreshAfterDays = () => Math.min(REFRESH_RECOMMENDED_DAYS, maxAgeDays());

// LIKE treats % and _ as wildcards and a backslash as its escape character, and Prisma's
// startsWith passes them through unchanged on MySQL: without this, a search for "%%" would return
// every city.
const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

const isStale = (city, now) => now - city.verifiedAt.getTime() > maxAgeDays() * DAY_MS;

// "Mumbai, Maharashtra, India". The text that fills the request's readable origin / destination.
function cityLabel(city) {
  const parts = [city.name];
  if (city.admin1Name && city.admin1Name !== city.name) parts.push(city.admin1Name);
  parts.push(COUNTRY_NAME.get(city.countryCode) || city.countryCode);
  return parts.join(', ').slice(0, 191);
}

const toPublic = (city) => ({ geonameId: city.geonameId, name: city.name, label: cityLabel(city), countryCode: city.countryCode });
const toVerified = (city) => ({ ...toPublic(city), timezone: city.timezone });

async function assertDataLoaded() {
  const any = await prisma.geonamesCity.findFirst({ select: { geonameId: true } });
  if (!any) throw new CityDataUnavailableError('city_data_not_loaded', 'geonames_cities is empty: run scripts/import-geonames.js');
}

function assertFresh(cities, now) {
  const stale = cities.find((city) => isStale(city, now));
  if (stale) {
    throw new CityDataUnavailableError('city_data_stale', `geonames_cities records are older than ${maxAgeDays()} days: re-run scripts/import-geonames.js`);
  }
}

// --- Freshness reminder and status -------------------------------------------------------------
// "Last import" is the newest verified_at in the table: every import stamps everything it saw with
// its own time. Records the file no longer lists keep their old stamp and age out one by one (they
// are refused after 180 days); that does not make the data set "old".
//   ok            under 90 days since the last import
//   refresh_due   90 days or more: refresh now (records are still accepted until 180 days)
//   stale         over 180 days: every record is refused
//   empty         nothing imported
async function getDatasetStatus({ now = Date.now(), withCounts = false } = {}) {
  const base = { refreshRecommendedAfterDays: refreshAfterDays(), maxAgeDays: maxAgeDays() };
  const latest = await prisma.geonamesCity.findFirst({ orderBy: { verifiedAt: 'desc' }, select: { verifiedAt: true } });
  if (!latest) return { state: 'empty', lastImportAt: null, ageDays: null, ...base };

  const ageDays = (now - latest.verifiedAt.getTime()) / DAY_MS;
  let state = 'ok';
  if (ageDays > base.maxAgeDays) state = 'stale';
  else if (ageDays >= base.refreshRecommendedAfterDays) state = 'refresh_due';

  const status = { state, lastImportAt: latest.verifiedAt.toISOString(), ageDays: Math.round(ageDays * 10) / 10, ...base };
  if (withCounts) {
    // Full-table counts: fine for the status command, not for a request.
    const cutoff = new Date(now - base.maxAgeDays * DAY_MS);
    status.cities = await prisma.geonamesCity.count();
    status.alternateNames = await prisma.geonamesCityName.count();
    status.citiesPastLimit = await prisma.geonamesCity.count({ where: { verifiedAt: { lt: cutoff } } });
  }
  return status;
}

const CHECK_EVERY_MS = 60 * 60 * 1000; // look at the data's age at most once an hour
const WARN_EVERY_MS = DAY_MS; // and repeat the reminder at most once a day
let lastChecked = 0;
let lastWarned = 0;

// The operational reminder: when the data is 90 days old or more it logs "refresh it" (a warning),
// and over 180 days, or when nothing is imported, an error, at most once a day per process. Called
// at start-up and (without waiting) from lookups; it never throws and never blocks a request.
async function checkDatasetAge({ now = Date.now(), force = false } = {}) {
  if (!force && now - lastChecked < CHECK_EVERY_MS) return null;
  lastChecked = now;
  let status;
  try {
    status = await getDatasetStatus({ now });
  } catch {
    return null;
  }
  if (status.state === 'ok' || (!force && now - lastWarned < WARN_EVERY_MS)) return status;
  lastWarned = now;
  if (status.state === 'refresh_due') {
    console.warn(`[geonames] City data was last imported ${Math.floor(status.ageDays)} days ago. Refresh it (every ${status.refreshRecommendedAfterDays} days is recommended); records are refused after ${status.maxAgeDays} days. See backend/GEONAMES-DATASET.md.`);
  } else if (status.state === 'stale') {
    console.error(`[geonames] City data was last imported ${Math.floor(status.ageDays)} days ago, over the ${status.maxAgeDays}-day limit: Private Charter requests are being refused (503). Run scripts/import-geonames.js now. See backend/GEONAMES-DATASET.md.`);
  } else {
    console.error('[geonames] No city data is loaded: Private Charter requests are being refused (503). Run scripts/import-geonames.js. See backend/GEONAMES-DATASET.md.');
  }
  return status;
}

// For tests: forget when the data was last looked at and when the reminder was last logged.
function resetFreshnessReminder() {
  lastChecked = 0;
  lastWarned = 0;
}

// --- Search ------------------------------------------------------------------------------------
// Cities whose name, plain-ASCII name or any other name (translations, local spellings, old names)
// starts with `query`, biggest first. The tables' collation ignores case and accents, so "zurich"
// finds "Zürich" and "munchen" finds München. `query` is matched literally. A city is returned
// once, under its own canonical name and id, whichever of its names matched.
//
// Speed on the full dataset (about 5 million places): each of the three name lists is asked only
// for ITS best matches (the top few by population, read from an index that carries the population),
// and the three small answers are merged. The overall top few are always among them: a city that
// ranks in the top n overall ranks at least that high inside the list where it matched. Asking for
// every match and sorting them all took seconds on a short prefix.
async function searchCities(query, { limit = 8, now = Date.now() } = {}) {
  void checkDatasetAge({ now });
  const take = Math.min(Math.max(Number(limit) || 8, 1), SEARCH_MAX_RESULTS);
  const prefix = `${escapeLike(query.normalize('NFC'))}%`;
  const floor = Array.from(query).length <= SHORT_QUERY_LENGTH ? Prisma.sql`AND population >= ${SHORT_QUERY_MIN_POPULATION}` : Prisma.empty;
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT c.geoname_id AS geonameId, c.name, c.admin1_name AS admin1Name, c.country_code AS countryCode,
           c.feature_code AS featureCode, c.population, c.timezone, c.verified_at AS verifiedAt
    FROM geonames_cities c
    JOIN (
      SELECT geoname_id, population FROM (
        (SELECT geoname_id, population FROM geonames_cities WHERE name LIKE ${prefix} ${floor}
           ORDER BY population DESC, geoname_id ASC LIMIT ${take})
        UNION
        (SELECT geoname_id, population FROM geonames_cities WHERE ascii_name LIKE ${prefix} ${floor}
           ORDER BY population DESC, geoname_id ASC LIMIT ${take})
        UNION
        (SELECT geoname_id, population FROM geonames_city_names WHERE name LIKE ${prefix} ${floor}
           ORDER BY population DESC, geoname_id ASC LIMIT ${take})
      ) candidates
      ORDER BY population DESC, geoname_id ASC LIMIT ${take}
    ) matched ON matched.geoname_id = c.geoname_id
    ORDER BY c.population DESC, c.geoname_id ASC`);
  if (!rows.length) await assertDataLoaded();
  assertFresh(rows, now);
  return rows.filter((city) => isAcceptablePlace('P', city.featureCode)).map(toPublic);
}

// The verified city for an id, or null when there is no such allowed city.
async function getVerifiedCity(geonameId, { now = Date.now() } = {}) {
  void checkDatasetAge({ now });
  const city = await prisma.geonamesCity.findUnique({ where: { geonameId } });
  if (!city) {
    await assertDataLoaded();
    return null;
  }
  if (!isAcceptablePlace('P', city.featureCode)) return null;
  assertFresh([city], now);
  return toVerified(city);
}

// For a request body: the verified city behind `origin` and `destination` where each is a
// well-formed { geonameId }. A malformed reference or an unknown id gives null here (the
// validator words the error); data that is missing or stale throws a 503 error.
async function resolveCityRefs(body, { now = Date.now() } = {}) {
  const resolved = {};
  for (const field of ['origin', 'destination']) {
    const ref = readCityRef(body[field]);
    resolved[field] = ref.id ? await getVerifiedCity(ref.id, { now }) : null;
  }
  return resolved;
}

module.exports = {
  CityDataUnavailableError, searchCities, getVerifiedCity, resolveCityRefs, cityLabel,
  getDatasetStatus, checkDatasetAge, resetFreshnessReminder,
  SEARCH_MAX_RESULTS, SHORT_QUERY_LENGTH, SHORT_QUERY_MIN_POPULATION, APPROVED_MAX_AGE_DAYS, REFRESH_RECOMMENDED_DAYS,
};
