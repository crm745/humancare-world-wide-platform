// The service detail screen asks GET /services/<key> for editable text (name, description,
// "provides") and merges it over its bundled content. The app's service keys (privatecharter,
// ground, hospital...) are not the backend catalog's slugs (air_ambulance, ground_ambulance...), so
// a 404 simply means "no editable text for this service": the bundled content is used and nothing
// is shown. Any other failure (server down, no network) is still reported.
export const isMissingLiveService = (err) => !!err && err.status === 404;
