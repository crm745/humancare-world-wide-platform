// Brand colours for the tracking screens, in one place (no React, no native modules).
// Navy / blue / light blue / white are the theme; green is deliberately not part of it.

export const NAVY = '#0D2340';
export const BLUE = '#2457A7';
export const LIGHT = '#EDF2F9';
export const WHITE = '#FFFFFF';

// Neutrals, taken from the app's existing text and border tones (tailwind.config.js: ink, muted, faint, line).
export const TEXT = '#17233D';
export const MUTED = '#5B6B84';
export const FAINT = '#97A4B8';
export const BORDER = '#E4E9F2';

// Only for a cancelled request and for errors (the app's existing "cancel" red).
export const CANCELLED = '#C23B3B';

export const PALETTE = Object.freeze({ NAVY, BLUE, LIGHT, WHITE, TEXT, MUTED, FAINT, BORDER, CANCELLED });
