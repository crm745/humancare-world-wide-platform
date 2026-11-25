// Imported once, first thing in the root layout (app/_layout.js): puts the navigation guard (lib/navGuard.js) on expo-router's `router`, so every router.push / navigate / replace in the app
// is covered without changing a single screen. Kept apart from lib/nav.js so a test that mocks `router` and loads nav.js gets its own mock back, untouched.
import { router } from 'expo-router';
import { guardRouter } from './navGuard';

guardRouter(router);
