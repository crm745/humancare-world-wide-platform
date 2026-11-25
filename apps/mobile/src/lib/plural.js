// Plural forms for the languages of the app (the CLDR rules), so a count is never written as "1 files".
//   English, Marathi, Telugu   one: exactly 1; other: everything else
//   Hindi, Gujarati            one: 0 and 1; other: everything else
//   Arabic                     one: 1, two: 2, few: 3 to 10 (and 103 to 110 ...), many: 11 to 99 (and 111 to 199 ...), other: everything else (0, 100, 101, 102 ...)
// A translation file holds one key per form that the language needs (`<base>_one`, `<base>_two`, `<base>_few`, `<base>_many`, `<base>_other`); a form it does not have falls back to `_other`.
export function pluralCategory(lang, count) {
  const n = Math.abs(Number(count));
  if (lang === 'AR') {
    if (n === 1) return 'one';
    if (n === 2) return 'two';
    const m = n % 100;
    if (Number.isInteger(n) && m >= 3 && m <= 10) return 'few';
    if (Number.isInteger(n) && m >= 11 && m <= 99) return 'many';
    return 'other';
  }
  if (lang === 'HI' || lang === 'GU') return n === 0 || n === 1 ? 'one' : 'other';
  return n === 1 ? 'one' : 'other';
}

// The text of `<base>_<form>` for `count`, with {n} filled in. `t` is the app's translate function (it returns the key itself when there is no such key).
export function pluralText(t, lang, base, count, values = {}) {
  const form = `${base}_${pluralCategory(lang, count)}`;
  const direct = t(form, { n: count, ...values });
  return direct && direct !== form ? direct : t(`${base}_other`, { n: count, ...values });
}
