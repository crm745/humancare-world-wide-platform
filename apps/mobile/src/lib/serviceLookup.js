// The service detail screen asks GET /services/<key> for editable text (name, description,
// "provides") and merges it over its bundled content. The app's service keys (privatecharter,
// ground, hospital...) are not the backend catalog's slugs (air_ambulance, ground_ambulance...), so
// a 404 simply means "no editable text for this service": the bundled content is used and nothing
// is shown. Any other failure (server down, no network) is still reported.
export const isMissingLiveService = (err) => !!err && err.status === 404;

// The app's service key and the backend catalog's slug differ for Teleconsultation ("tele" / "teleconsultation"). Only Teleconsultation is mapped
// here; every other key is asked as it is (and, as before, simply is not found).
export const LIVE_SLUGS = { tele: 'teleconsultation' };
export const liveSlugFor = (key) => (Object.prototype.hasOwnProperty.call(LIVE_SLUGS, key) ? LIVE_SLUGS[key] : key);

// A service whose approved name stays whatever the catalog says: Teleconsultation is "Tele Consultation & House Call". Its catalog entry (name
// "Teleconsultation") may fill in the description and "what we provide" but never renames it.
const KEEP_OWN_TITLE = new Set(['tele']);

// What the detail page shows: the bundled content with the live (admin-editable) text merged over it, as before; except the title of a service
// that keeps its own.
export function detailContent(local, live, key) {
  return {
    title: KEEP_OWN_TITLE.has(key) ? local.title : (live && live.name) || local.title,
    desc: (live && live.description) || local.desc,
    features: live && live.provides && live.provides.length ? live.provides : local.features,
  };
}
