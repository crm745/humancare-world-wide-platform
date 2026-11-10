// The city a Private Charter request names: exactly { "geonameId": <positive whole number> }.
// Nothing else is accepted inside it: the name, country and timezone are looked up by the server.
const { MAX_INT } = require('./geonames-format');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// -> { id } for a well-formed reference, or { problem } (a message for the field).
function readCityRef(raw) {
  if (!isObject(raw)) return { problem: 'Select a city from the list.' };
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'geonameId') {
    return { problem: 'Send only { "geonameId": <number> } for the selected city.' };
  }
  const id = raw.geonameId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_INT) {
    return { problem: 'geonameId must be a positive whole number.' };
  }
  return { id };
}

module.exports = { readCityRef };
