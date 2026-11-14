// The rules for Current Location and Destination on the New Request form: which text is acceptable, and whether a city picked from the
// suggestions belongs to the selected country. Pure (no React, no native modules), so they can be unit-tested.
//
// TWO KINDS OF LOCATION, kept apart:
//   manual    text the person typed. `city` is null. It is never treated as a verified GeoNames city and no identifier is invented for it. It is
//             kept EXACTLY as typed (spaces and punctuation included; only whether it is empty is judged on the trimmed text).
//   selected  a suggestion the person tapped. `city` is { geonameId, name, label, countryCode } from the verified list. Its countryCode (an ISO
//             3166-1 alpha-2 code from GeoNames) is compared with the form's selected country (its ISO code): an exact match of codes, never a
//             name match and never a substring.
//
// Where a verified city is REQUIRED: Private Charter (`structured`). Its backend takes a city only as { geonameId } and refuses anything else (and
// needs the verified city's timezone), so a typed city cannot be sent without a backend change. Every other service sends the text as it always did.

// THE POLICY (approved): the form's Country is the patient's, and ONLY the Current Location must belong to it. The Destination may be in any
// country (an international transfer: a patient in India flown to Dubai or London), so it is never compared with the Country. A selected
// destination keeps its own country (countryCode) and its own geonameId: nothing here, or anywhere else, gives it the patient's country.

const code = (value) => String(value == null ? '' : value).trim().toUpperCase();
export const hasText = (text) => String(text == null ? '' : text).trim() !== '';

// Does this selected city belong to the selected country? true when there is nothing to compare (no selection, or no country chosen yet).
export function cityInCountry(city, countryIso) {
  if (!city || !code(countryIso)) return true;
  return code(city.countryCode) === code(countryIso);
}

// What is wrong with one location field, or null.
//   'required'       nothing was entered
//   'pick_city'      (Private Charter) text was entered but no verified city was picked
//   'wrong_country'  a city was picked that is not in the selected country
export function locationProblem({ text, city, countryIso, structured = false, checkCountry = true }) {
  if (structured) {
    if (!city) return hasText(text) ? 'pick_city' : 'required';
  } else if (!city && !hasText(text)) {
    return 'required';
  }
  if (city && checkCountry && !cityInCountry(city, countryIso)) return 'wrong_country';
  return null;
}

// The two fields, each judged on its own. `draft` is the form's draft; `charter` is whether the service is Private Charter.
// Current Location: held to the selected Country. Destination: not (`checkCountry: false`): any country, still a verified city for Private Charter.
export function locationProblems(draft, charter) {
  const d = draft || {};
  return {
    location: locationProblem({ text: d.location, city: d.originCity, countryIso: d.countryIso, structured: charter }),
    dest: locationProblem({ text: d.dest, city: d.destCity, countryIso: d.countryIso, structured: charter, checkCountry: false }),
  };
}

// The suggestions to show for a field: those of the selected country when the field is held to it, otherwise all (at most `max`).
export function suggestionsFor(cities, { countryIso, restrict, max = 8 }) {
  const list = Array.isArray(cities) ? cities : [];
  const shown = restrict && code(countryIso) ? list.filter((c) => code(c.countryCode) === code(countryIso)) : list;
  return shown.slice(0, max);
}
