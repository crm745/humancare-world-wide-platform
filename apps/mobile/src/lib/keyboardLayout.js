// The rules of keyboard handling, with no React and no native code, so they can be unit-tested. components/keyboard/ applies them.

// How much room the focused field keeps above the keyboard (and above a bar that rides the keyboard).
export const FOCUS_GAP = 24;

// `bottomOffset` for the keyboard-aware scroll view: the field's bottom edge ends FOCUS_GAP above the keyboard, plus the height of a bar
// that rides on top of the keyboard (a Submit / Continue bar), so the field is never hidden behind that bar.
export const scrollBottomOffset = (barHeight = 0) => FOCUS_GAP + Math.max(0, Math.round(barHeight) || 0);

// The offset for a bar that rides the keyboard. The bar has the screen's bottom safe-area inset as its own padding while the keyboard is
// closed; the keyboard's height already includes that inset, so with the keyboard open the bar moves up by (keyboard height - inset)
// and its own padding sits behind the keyboard. Without this the inset would be counted twice: an empty gap above the keyboard.
export const stickyOffset = (insetBottom = 0) => ({ closed: 0, opened: Math.max(0, Math.round(insetBottom) || 0) });

// The height a list inside a modal may have while the keyboard is open: what is left of the window above the keyboard, minus what the
// modal shows above the list (`reserved`), kept between `min` and `max`.
export function listMaxHeight({ windowHeight, keyboardHeight = 0, reserved = 0, min = 120, max = Infinity }) {
  const room = (windowHeight || 0) - Math.max(0, keyboardHeight || 0) - Math.max(0, reserved);
  return Math.max(min, Math.min(max, Math.round(room)));
}

// ---- Next / Done ----------------------------------------------------------------------------------------------------
// The fields of a form, in reading order: top to bottom; fields whose tops are within ROW_TOLERANCE of each other are one row and are
// read left to right (right to left in an RTL language); then the order they appeared in. `fields`: [{ id, x, y, seq }].
export const ROW_TOLERANCE = 8;
export function orderFields(fields, rtl = false) {
  const list = [...fields];
  list.sort((a, b) => {
    if (Math.abs(a.y - b.y) > ROW_TOLERANCE) return a.y - b.y;
    if (a.x !== b.x) return rtl ? b.x - a.x : a.x - b.x;
    return a.seq - b.seq;
  });
  return list.map((f) => f.id);
}

// The field after `id`, or null when `id` is the last one (or unknown).
export function nextFieldId(order, id) {
  const i = order.indexOf(id);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}

// The keyboard's return key for a field: the caller's own choice wins (a search box says "search"); a multiline field keeps its default,
// where Return adds a new line; every other field says "next", and the last one "done".
export function returnKeyFor({ multiline = false, isLast = true, explicit }) {
  if (explicit) return explicit;
  if (multiline) return undefined;
  return isLast ? 'done' : 'next';
}

// ---- an open suggestion list under a field ----------------------------------------------------------------------------------------
// How far to scroll so the bottom of `box` (the field's suggestion list) is FOCUS_GAP above the keyboard and above a bar that rides on it.
// `top`/`height` are the box's place in the window; 0 means it already fits.
export function revealDelta({ top, height, windowHeight, keyboardHeight = 0, keyboardTop, footerHeight = 0, gap = FOCUS_GAP }) {
  // `keyboardTop` (the keyboard's real top edge) wins when it is known
  const edge = Number.isFinite(keyboardTop) ? keyboardTop : (windowHeight || 0) - Math.max(0, keyboardHeight || 0);
  const visibleBottom = edge - Math.max(0, footerHeight || 0) - gap;
  return Math.max(0, Math.ceil(top + height - visibleBottom));
}

// ---- keyboard geometry, without assuming anything about the window ---------------------------------------------------------------
// On Android the window does NOT shrink for the keyboard (the app draws edge to edge, so the keyboard is only an overlay and an inset). Nothing
// below adds "the keyboard's height" to anything: it compares where things ARE (in the window) with where the keyboard's top IS, so it is right
// on a phone where the window did shrink as well (then nothing overlaps and nothing is added).

// Where the keyboard's top edge is, in window coordinates: the system's own value when it gives one, else the screen's height minus the keyboard's.
export function keyboardTopOf({ screenY, height, screenHeight }) {
  if (Number.isFinite(screenY) && screenY > 0) return screenY;
  if (Number.isFinite(height) && height > 0 && Number.isFinite(screenHeight) && screenHeight > 0) return screenHeight - height;
  return Infinity;
}

// How far to scroll so a focused field's bottom edge is `gap` above the keyboard (and above a bar riding on it). 0 when it already is.
export function focusDelta({ fieldBottom, keyboardTop, footerHeight = 0, gap = FOCUS_GAP }) {
  if (!Number.isFinite(keyboardTop) || !Number.isFinite(fieldBottom)) return 0;
  return Math.max(0, Math.ceil(fieldBottom - (keyboardTop - Math.max(0, footerHeight) - gap)));
}

// The room to add under a scroll area's content while the keyboard is up, so the last field can be scrolled clear of the keyboard (and of a bar
// on it): how far the bottom of the scroll area reaches into the keyboard, plus the bar. 0 when the keyboard is closed or does not reach it.
export function contentPad({ scrollBottom, keyboardTop, footerHeight = 0 }) {
  if (!Number.isFinite(keyboardTop) || !Number.isFinite(scrollBottom)) return 0;
  return Math.max(0, Math.ceil(scrollBottom - (keyboardTop - Math.max(0, footerHeight))));
}

// How far a bar at the bottom of the screen moves up to sit on the keyboard. `baseBottom` is its bottom edge with the keyboard closed. It keeps
// the safe-area inset as its own bottom padding; the keyboard covers that inset, so the inset is not added on top (no empty gap above the keyboard).
export function barShift({ baseBottom, keyboardTop, insetBottom = 0 }) {
  if (!Number.isFinite(keyboardTop) || !Number.isFinite(baseBottom)) return 0;
  return Math.max(0, Math.ceil(baseBottom - keyboardTop - Math.max(0, insetBottom)));
}
