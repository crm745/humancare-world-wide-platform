const { searchCities, SEARCH_MAX_RESULTS } = require('./geo.service');
const { GEONAMES_ATTRIBUTION } = require('./geonames-format');

const QUERY_MIN = 2;
const QUERY_MAX = 80;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// GET /geo/cities?q=mumb&limit=8 -> { cities: [{ geonameId, name, label, countryCode }], attribution }
// The client picks one and sends back only its geonameId; the server looks the rest up again.
async function getCities(req, res, next) {
  try {
    const { q, limit } = req.query;
    if (typeof q !== 'string' || CONTROL_CHARACTERS.test(q)) {
      return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: { q: 'Enter the first letters of a city.' } });
    }
    const query = q.trim();
    const length = Array.from(query).length;
    if (length < QUERY_MIN || length > QUERY_MAX) {
      return res.status(400).json({
        error: 'Please correct the highlighted fields.',
        fields: { q: `Enter between ${QUERY_MIN} and ${QUERY_MAX} characters.` },
      });
    }
    let max = 8;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > SEARCH_MAX_RESULTS) {
        return res.status(400).json({
          error: 'Please correct the highlighted fields.',
          fields: { limit: `limit must be a whole number from 1 to ${SEARCH_MAX_RESULTS}.` },
        });
      }
      max = Number(limit);
    }
    const cities = await searchCities(query, { limit: max });
    // The data is CC BY: whoever shows these results should show this credit.
    res.json({ cities, attribution: GEONAMES_ATTRIBUTION });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCities };
