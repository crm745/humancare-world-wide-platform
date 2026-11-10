// The GeoNames "dump" file format and which of its records Private Charter accepts as a city.
// Pure: shared by the importer (scripts/import-geonames.js) and the tests.
//
// Source: https://download.geonames.org/export/dump/ (readme.txt there describes the columns).
// A dump line is 19 tab-separated columns:
//   0 geonameid  1 name  2 asciiname  3 alternatenames  4 latitude  5 longitude
//   6 feature class  7 feature code  8 country code  9 cc2  10 admin1 code  11 admin2  12 admin3
//   13 admin4  14 population  15 elevation  16 dem  17 timezone  18 modification date
// The data is licensed CC BY 4.0: see GEONAMES_ATTRIBUTION and backend/GEONAMES-DATASET.md.
const { isValidTimeZone } = require('../../common/utils/local-date');

const GEONAMES_ATTRIBUTION = {
  text: 'City data from GeoNames (geonames.org), licensed under CC BY 4.0.',
  url: 'https://www.geonames.org',
  license: 'https://creativecommons.org/licenses/by/4.0/',
};

// Every populated place (feature class P) is a city for this form except:
//   - the ones that no longer exist: PPLH historical, PPLCH historical capital, PPLQ abandoned,
//     PPLW destroyed;
//   - PPLX, a section of a populated place (a district or neighbourhood inside a city, such as
//     "Zürich (Kreis 3)"): the picker is for the city or town itself.
// Names and meanings from https://www.geonames.org/export/codes.html.
const HISTORICAL_FEATURE_CODES = new Set(['PPLH', 'PPLCH', 'PPLQ', 'PPLW']);
const SUBDIVISION_FEATURE_CODES = new Set(['PPLX']);
const EXCLUDED_FEATURE_CODES = new Set([...HISTORICAL_FEATURE_CODES, ...SUBDIVISION_FEATURE_CODES]);
const isAcceptablePlace = (featureClass, featureCode) => featureClass === 'P' && Boolean(featureCode) && !EXCLUDED_FEATURE_CODES.has(featureCode);

const MAX_INT = 2147483647; // geoname_id and population are INT columns

// "Code.Admin1" -> name, from admin1CodesASCII.txt (columns: code, name, ascii name, geonameid).
function parseAdmin1Names(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [code, name, asciiName] = line.split('\t');
    if (code && (asciiName || name)) names.set(code, (asciiName || name).slice(0, 200));
  }
  return names;
}

// --- Alternate names -----------------------------------------------------------------------
// Column 3 of the dump lists the other names of a place, comma-separated: translations, local
// spellings in other scripts, old names and plain-ASCII transliterations ("München", "Muenchen",
// "Monaco di Baviera", "Bombay", "Москва", "東京"). It is the same data as the separate
// alternateNamesV2 file, already inside the file that is imported anyway. A name is kept for
// searching unless it is clearly not a name:
const MAX_ALTERNATE_NAMES = 150; // per place; the 99th percentile is under 60
const MIN_ALTERNATE_LENGTH = 2;
const MAX_ALTERNATE_LENGTH = 200;
const NOT_A_NAME = [
  /^(https?:\/\/|www\.)/i, // a link
  /^Q\d+$/, // a Wikidata id
  /^[\d\s.\-+/]+$/, // only digits and punctuation (postal codes, ids)
];

// The same key for names that differ only in case or accents, which the table's collation
// (utf8mb4_unicode_ci) also treats as one name; it keeps the import from sending rows that
// would collide.
const dedupeKey = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// -> the other names worth searching, without repeats and without the place's own names.
function cleanAlternateNames(raw, ownNames) {
  if (!raw) return [];
  const seen = new Set(ownNames.map(dedupeKey));
  const kept = [];
  for (const part of raw.split(',')) {
    const name = part.trim().normalize('NFC');
    if (name.length < MIN_ALTERNATE_LENGTH || name.length > MAX_ALTERNATE_LENGTH) continue;
    if (NOT_A_NAME.some((pattern) => pattern.test(name))) continue;
    const key = dedupeKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
    if (kept.length >= MAX_ALTERNATE_NAMES) break;
  }
  return kept;
}

// One dump line -> { row } for a record to keep, or { skip: reason } with the reason counted by the importer.
function parseGeonamesLine(line, admin1Names = new Map()) {
  const columns = line.replace(/\r$/, '').split('\t');
  if (columns.length < 18) return { skip: 'malformed' };

  const geonameId = Number(columns[0]);
  if (!Number.isInteger(geonameId) || geonameId < 1 || geonameId > MAX_INT) return { skip: 'malformed' };

  const [featureClass, featureCode] = [columns[6], columns[7]];
  if (featureClass !== 'P') return { skip: 'not-a-populated-place' };
  if (HISTORICAL_FEATURE_CODES.has(featureCode)) return { skip: 'historical-or-abandoned' };
  if (SUBDIVISION_FEATURE_CODES.has(featureCode)) return { skip: 'subdivision' };
  if (!isAcceptablePlace(featureClass, featureCode)) return { skip: 'not-a-populated-place' };

  const name = columns[1].trim().slice(0, 200);
  const countryCode = columns[8];
  if (!name) return { skip: 'malformed' };
  if (!/^[A-Z]{2}$/.test(countryCode)) return { skip: 'bad-country' };

  // No usable timezone, no city: the "no past date" rule needs the city's own zone.
  const timezone = columns[17].trim();
  if (!timezone) return { skip: 'no-timezone' };
  if (!isValidTimeZone(timezone)) return { skip: 'unknown-timezone' };

  const population = Math.min(Math.max(Number.parseInt(columns[14], 10) || 0, 0), MAX_INT);
  const asciiName = (columns[2].trim() || name).slice(0, 200);
  return {
    row: {
      geonameId,
      name,
      asciiName,
      admin1Name: admin1Names.get(`${countryCode}.${columns[10]}`) || null,
      countryCode,
      featureCode,
      population,
      timezone,
      alternateNames: cleanAlternateNames(columns[3], [name, asciiName]),
    },
  };
}

module.exports = {
  GEONAMES_ATTRIBUTION, HISTORICAL_FEATURE_CODES, SUBDIVISION_FEATURE_CODES, EXCLUDED_FEATURE_CODES, isAcceptablePlace,
  parseAdmin1Names, parseGeonamesLine, cleanAlternateNames, MAX_INT, MAX_ALTERNATE_NAMES,
};
