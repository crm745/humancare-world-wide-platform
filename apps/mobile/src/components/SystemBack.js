import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { router, usePathname } from 'expo-router';
import { navReplace } from '../lib/nav';
import { systemBackAction } from '../lib/systemBack';

// The ONE Android system-back listener of the app (rendered once, in app/_layout.js). It never sends people Home when there is somewhere to
// go back to: it returns false so the navigator pops, as the app's own back button does. See lib/systemBack.js for the rule.
//
// Why it is one listener at the root and not one per screen: a screen under another one stays mounted, so a listener that a screen adds
// (the tab bar used to add one) keeps running while a screen sits on top of it, and swallows the back press (it sent Profile ->
// My Documents -> back to Home). Registered once, it asks the navigator what is on top at the moment of the press.
export function SystemBack() {
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (systemBackAction({ pathname: pathRef.current, canGoBack: router.canGoBack() }) !== 'home') return false;
      navReplace('/home');
      return true;
    });
    return () => sub.remove();
  }, []);

  return null;
}
