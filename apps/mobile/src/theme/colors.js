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

// Loading skeletons (components/skeleton): a block, the highlight that sweeps across it, and the colour a new item flashes from.
const SKELETON = { block: '#E3E9F2', highlight: '#F5F8FC', newItem: '#E2E3EF' };

// Notices (network banner, warning / success / info cards): the one set of colours every network-related message uses.
//   warning  something to be careful about (no internet, a request that may not have gone through)
//   success  all good (back online, the saved session is safe, a request was received)
//   info     neutral information (a request that was already sent, a note after a check)
//   slow     the quiet look of the "slow connection" banner
const NOTICE = {
  warning: { bg: '#FDF0DA', border: '#F1D9AE', title: '#6B3A06', text: '#8F4C08' },
  success: { bg: '#E0F5F4', border: '#BFE8E4', text: '#0B6564' },
  info: { bg: '#EAEBF4', border: '#D6D9EE', title: '#0D2340', text: '#5B6B84' },
  slow: { bg: '#EEF2FB', border: '#DCE3F5', title: '#0D2340', text: '#5B6B84' },
};

module.exports = { COLORS, SKELETON, NOTICE, primaryAlpha };
