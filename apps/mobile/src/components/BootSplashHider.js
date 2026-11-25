import { useEffect } from 'react';
import { usePathname } from 'expo-router';
import { hideBootSplash } from '../lib/bootSplash';

// The browser's boot picture (public/index.html) goes once the first screen is on screen: at once for any screen but the splash (a reload on Login, Home ...); the splash itself removes it when
// its pictures have loaded (app/index.js). Renders nothing.
export function BootSplashHider() {
  const pathname = usePathname();
  useEffect(() => { if (pathname !== '/') hideBootSplash(); }, [pathname]);
  return null;
}
