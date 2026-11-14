// The ONE rule for "there is nothing to show here". Pure. Used by Request Details (textOf) and the New Request review step (reviewView), so a
// value is hidden, label and all, the same way on both pages.
//
// Empty: null, undefined, a blank or whitespace-only text, the text "null" / "undefined", a lone dash ("—"), and a list with nothing in it
// (or only empty things). NOT empty: 0, false, and any real text (an age of 0 is shown; whether a false flag is shown is for the screen to say).
const EMPTY_TEXT = new Set(['', 'null', 'undefined', '—']);

export function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every(isEmptyValue);
  if (typeof value === 'string') return EMPTY_TEXT.has(value.trim());
  return false;
}

export const hasValue = (value) => !isEmptyValue(value);
