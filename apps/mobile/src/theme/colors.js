// The app's colours that carry the brand, in one place. CommonJS on purpose: tailwind.config.js reads it too, so the class
// names (bg-primary, text-primary, bg-primary-soft ...) and the colours written in code (COLORS.primary) can never drift apart.
//
// #303A8F is the royal blue of the logo and the one brand blue of the whole app: buttons, links, the active tab, progress,
// timeline markers, selected states, toggles, and the dark cards and banners. Neutrals (page and card backgrounds, borders,
// text greys), the SOS red and the status colours other than "In progress" are not here: they are not brand blue.
const primary = '#303A8F'; // brand blue
const primaryPressed = '#252D6F'; // pressed / active state
const primarySoft = '#EAEBF4'; // light tint backgrounds: selected rows, chips, the "In progress" badge
const primaryMuted = '#ACB0D2'; // light dots, focus rings, a disabled blue
const onPrimaryMuted = 'rgba(255,255,255,0.72)'; // secondary text on a primary-coloured background

const COLORS = { primary, primaryPressed, primarySoft, primaryMuted, onPrimaryMuted };

// The brand blue with an alpha, for shadows and overlays: primaryAlpha(0.72) is rgba(48,58,143,0.72).
const primaryAlpha = (alpha) => `rgba(48,58,143,${alpha})`;

module.exports = { COLORS, primaryAlpha };
