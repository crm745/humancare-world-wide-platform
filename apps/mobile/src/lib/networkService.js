// Switches the network service on and off. Pure (no React, no native modules), so it can be unit-tested.
//
// activateNetworkService(store) starts the store (which attaches its one NetInfo listener and its one AppState listener) and registers it as the
// receiver of the API client's outcomes (networkReporter.js). It returns the function that undoes both. Calling it twice for the same store (React
// Strict Mode mounts effects twice in development) leaves exactly one set of listeners, because the first call is undone before the second starts
// and store.start() is itself idempotent.
import { setApiOutcomeListener } from './networkReporter';

export function activateNetworkService(store) {
  setApiOutcomeListener(store.reportOutcome);
  store.start();
  let active = true;
  return function deactivate() {
    if (!active) return;
    active = false;
    setApiOutcomeListener(null);
    store.stop();
  };
}
