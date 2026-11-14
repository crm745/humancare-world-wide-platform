import { useEffect } from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { BADGE_ATTRIBUTE, BADGE_CSS, BADGE_STYLE_ID, recaptchaBadgeVisible } from '../lib/recaptcha';

// Web only. Keeps Google's reCAPTCHA badge (added to the page by Firebase phone sign-in) on the sign-in screens and hides it on
// every other screen, so it never sits under the floating SOS button after login. It does not touch how reCAPTCHA works. It
// renders nothing: it adds one small style rule and sets one attribute on <html> for the current route.
export function RecaptchaBadgeGate() {
  const pathname = usePathname();
  const visible = recaptchaBadgeVisible(pathname);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (!document.getElementById(BADGE_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = BADGE_STYLE_ID;
      style.textContent = BADGE_CSS;
      document.head.appendChild(style);
    }
    document.documentElement.setAttribute(BADGE_ATTRIBUTE, visible ? 'visible' : 'hidden');
  }, [visible]);
  return null;
}
