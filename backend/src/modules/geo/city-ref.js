// The city a Private Charter request names, in one of two forms:
//   { "geonameId": <positive whole number> }  a city picked from the GeoNames list. Nothing else is accepted inside
//                                             it: the name, country and timezone are looked up by the server.
//   { "name": "<text>", "countryCode": "AE" } a city typed by hand because GeoNames has no match. `countryCode` is
//                                             optional (the form's country is used when it is left out). A manual
//                                             city never carries a geonameId: one is never invented for it.
const { MAX_INT } = require('./geonames-format');
const { CITY_NAME_MIN, CITY_NAME_MAX } = require('../../common/constants/request.constants');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const length = (text) => Array.from(text).length;
// Letters (any script), marks, digits, spaces and the punctuation real place names use.
const MANUAL_NAME = /^[\p{L}\p{M}\p{N} .,'\u2019()\-\/&]+$/u;

// -> { id } for a picked city, { manual: { name, countryCode } } for a typed one (countryCode may be null),
// or { problem } (a message for the field). The text is trimmed and its inner spaces are collapsed.
function readCityRef(raw) {
  if (!isObject(raw)) return { problem: 'Select a city from the list, or enter the city name.' };
  const keys = Object.keys(raw);
  if (keys.includes('name') || keys.includes('countryCode')) {
    if (keys.some((key) => key !== 'name' && key !== 'countryCode')) {
      return { problem: 'A city entered by hand takes only a name and an optional countryCode (never a geonameId).' };
    }
    if (typeof raw.name !== 'string') return { problem: 'City name must be text.' };
    const name = raw.name.replace(/\s+/g, ' ').trim();
    if (length(name) < CITY_NAME_MIN || length(name) > CITY_NAME_MAX || !/\p{L}/u.test(name) || !MANUAL_NAME.test(name)) {
      return { problem: `City name must be ${CITY_NAME_MIN} to ${CITY_NAME_MAX} characters, contain a letter, and use only letters, numbers, spaces and . , ' ( ) - / &.` };
    }
    const code = raw.countryCode;
    if (code !== undefined && code !== null && (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) {
      return { problem: 'City countryCode must be a two-letter ISO 3166-1 code, for example "AE".' };
    }
    return { manual: { name, countryCode: code || null } };
  }
  if (keys.length !== 1 || keys[0] !== 'geonameId') {
    return { problem: 'A listed city takes only { "geonameId": <number> }; a city entered by hand takes { "name": "<city>" }.' };
  }
  const id = raw.geonameId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_INT) {
    return { problem: 'geonameId must be a positive whole number.' };
  }
  return { id };
}

module.exports = { readCityRef };
