// When a bottom sheet is dragged down far enough, or flicked down fast enough, it closes (the same as Cancel); otherwise it springs back. Pure, so the rule is unit-tested.
export const DRAG_DISMISS_DISTANCE = 80; // px
export const DRAG_DISMISS_VELOCITY = 0.8; // px per ms
export const DRAG_FLICK_MIN = 20; // a flick must also have moved this far

export const shouldDismissSheet = ({ dy = 0, vy = 0 } = {}) => dy >= DRAG_DISMISS_DISTANCE || (dy >= DRAG_FLICK_MIN && vy >= DRAG_DISMISS_VELOCITY);
// How far the sheet follows the finger: only downwards.
export const sheetOffset = (dy) => Math.max(0, Number.isFinite(dy) ? dy : 0);
