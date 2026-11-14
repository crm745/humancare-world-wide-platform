// Where Google's reCAPTCHA badge may show (web build). Pure (no React, no native modules), so it can be unit-tested.
//
// Firebase phone sign-in puts an invisible reCAPTCHA on the page the first time a code is sent (lib/phoneAuth.web.js). Google
// adds its badge (.grecaptcha-badge, fixed bottom-right) to <body>, and the app is a single page, so the badge outlives the
// sign-in screens: it is still there after login, under the floating SOS button. The script cannot be unloaded safely (removing
// the verifier breaks a send still in flight), so the badge is hidden with CSS everywhere except the sign-in screens, and
// the notice Google asks for when the badge is hidden is shown on every screen that uses reCAPTCHA.
const normalise = (pathname) => {
  const path = String(pathname || '/').split('?')[0].split('#')[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

// The sign-in screens: login, create account, the code screens and forgot password.
export const BADGE_ROUTES = ['/login', '/login-otp', '/choose-login', '/register', '/register-otp', '/forgot-password', '/forgot-password-otp'];

export const recaptchaBadgeVisible = (pathname) => BADGE_ROUTES.includes(normalise(pathname));

export const BADGE_STYLE_ID = 'hc-recaptcha-badge-style';
export const BADGE_ATTRIBUTE = 'data-recaptcha-badge';
// Hidden unless the page says it is on a sign-in screen. (visibility, not display: the script keeps working.)
export const BADGE_CSS = `html:not([${BADGE_ATTRIBUTE}="visible"]) .grecaptcha-badge { visibility: hidden !important; }`;

// Google's own links, for the notice.
export const RECAPTCHA_PRIVACY_URL = 'https://policies.google.com/privacy';
export const RECAPTCHA_TERMS_URL = 'https://policies.google.com/terms';
