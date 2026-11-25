import { useEffect } from 'react';
import { Tabs } from 'expo-router/js-tabs';
import { registerTabs } from '../../lib/nav';

// The four bottom-tab screens (Home, Tracking, Requests, Profile; Cases for a corporate account) live in this one navigator, so they STAY MOUNTED while you move between them:
// switching a tab shows the screen that is already there, with its scroll position, its loaded data and its state, instead of unmounting one screen and building the next (and asking the
// server for its data again). The route group "(tabs)" is not part of any address: the routes are still /home, /active-tracking, /my-requests, /profile and /corporate-dashboard.
//
//   - The bar is NOT drawn here: every tab screen draws the same BottomNav itself (components/layout.js), as before, so no screen's layout changes. `tabBar` is switched off.
//   - A tab is built the first time it is opened (`lazy`), never all at once at start-up.
//   - `freezeOnBlur`: a tab that is not in front is not re-rendered (a toast, a language change, a form keystroke elsewhere) until it is shown again.
//   - `backBehavior="none"`: the tabs keep no history of their own. The Android back button on a tab goes to Home, then leaves the app, exactly as before (lib/systemBack.js, components/SystemBack.js).
//   - No transition between tabs: the switch is immediate.
export default function TabsLayout() {
  // lib/nav.js needs to know a tab navigator is on screen: tabs are then switched in place (navigate) instead of cleared and rebuilt (dismissAll + replace).
  useEffect(() => registerTabs(), []);
  return (
    <Tabs
      initialRouteName="home"
      backBehavior="none"
      tabBar={() => null}
      screenOptions={{ headerShown: false, lazy: true, freezeOnBlur: true, animation: 'none' }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="active-tracking" />
      <Tabs.Screen name="my-requests" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="corporate-dashboard" />
    </Tabs>
  );
}
