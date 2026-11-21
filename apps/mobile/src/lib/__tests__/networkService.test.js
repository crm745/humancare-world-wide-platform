/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
// Phase 1 (network foundation): the /health probe, switching the service on and off, and the device adapter (NetInfo + AppState).
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => {
  const listeners = new Set();
  return {
    Platform: { OS: 'ios' },
    AppState: {
      __listeners: listeners,
      addEventListener: jest.fn((type, cb) => { listeners.add(cb); return { remove: jest.fn(() => listeners.delete(cb)) }; }),
    },
  };
});
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));
jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), getItemAsync: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => {
  const listeners = new Set();
  return {
    __esModule: true,
    default: {
      __listeners: listeners,
      addEventListener: jest.fn((cb) => { listeners.add(cb); return () => listeners.delete(cb); }),
    },
  };
});

const fs = require('fs');
const path = require('path');
const NetInfo = require('@react-native-community/netinfo').default;
const { AppState } = require('react-native');
const { createHealthProbe, PROBE_TIMEOUT_MS } = require('../healthProbe');
const { createNetworkStore, NET } = require('../network');
const { activateNetworkService } = require('../networkService');
const { reportApiOutcome, setApiOutcomeListener } = require('../networkReporter');
const { subscribeLink, subscribeAppActive, createDeviceNetworkStore } = require('../networkDevice');

const reply = (status) => ({ ok: status >= 200 && status < 300, status });

describe('createHealthProbe', () => {
  afterEach(() => jest.useRealTimers());

  test('asks GET <base>/health with no token and no body', async () => {
    const fetchImpl = jest.fn(async () => reply(200));
    const result = await createHealthProbe({ baseUrl: 'https://api.example.test', fetchImpl })();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/health');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers || {})).not.toMatch(/authorization|bearer/i);
    expect(result).toMatchObject({ ok: true, status: 200 });
  });
  test('a 2xx is ok; its body is not needed (it proves the server answers, not that every dependency works)', async () => {
    const out = await createHealthProbe({ baseUrl: 'x', fetchImpl: async () => ({ ok: true, status: 200, json: () => { throw new Error('body must not be read'); } }) })();
    expect(out.ok).toBe(true);
  });
  test.each([500, 502, 503, 404])('an answer of %i is "answered, but not OK"', async (status) => {
    const out = await createHealthProbe({ baseUrl: 'x', fetchImpl: async () => reply(status) })();
    expect(out).toMatchObject({ ok: false, status });
  });
  test('a failure to connect is "no answer", not a throw', async () => {
    const out = await createHealthProbe({ baseUrl: 'x', fetchImpl: async () => { throw new TypeError('Network request failed'); } })();
    expect(out).toMatchObject({ ok: false, timedOut: false });
    expect(out.status).toBeUndefined();
  });
  test('gives up after the time limit and says it timed out; the request is aborted', async () => {
    jest.useFakeTimers();
    let signal;
    const fetchImpl = jest.fn((url, init) => new Promise((_, reject) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pending = createHealthProbe({ baseUrl: 'x', fetchImpl, timeoutMs: 1000 })();
    await jest.advanceTimersByTimeAsync(999);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: false, timedOut: true });
    expect(signal.aborted).toBe(true);
  });
  test('the timer is cleared when it answers (nothing is left running)', async () => {
    jest.useFakeTimers();
    await createHealthProbe({ baseUrl: 'x', fetchImpl: async () => reply(200) })();
    expect(jest.getTimerCount()).toBe(0);
  });
  test('the default limit is bounded', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
  test('reports its own duration', async () => {
    let t = 1000;
    const out = await createHealthProbe({ baseUrl: 'x', fetchImpl: async () => { t += 250; return reply(200); }, now: () => t })();
    expect(out.ms).toBe(250);
  });
});

describe('activateNetworkService', () => {
  beforeEach(() => setApiOutcomeListener(null));
  afterEach(() => setApiOutcomeListener(null));

  const fakeStore = () => {
    const calls = { start: 0, stop: 0, outcomes: [] };
    return { calls, start: () => { calls.start += 1; }, stop: () => { calls.stop += 1; }, reportOutcome: (o) => calls.outcomes.push(o) };
  };

  test('starts the store and routes the API client\'s outcomes to it', () => {
    const store = fakeStore();
    activateNetworkService(store);
    reportApiOutcome('network');
    reportApiOutcome('ok');
    expect(store.calls.start).toBe(1);
    expect(store.calls.outcomes).toEqual(['network', 'ok']);
  });
  test('the returned function stops it and unplugs the outcomes; calling it twice is harmless', () => {
    const store = fakeStore();
    const off = activateNetworkService(store);
    off();
    off();
    reportApiOutcome('network');
    expect(store.calls.stop).toBe(1);
    expect(store.calls.outcomes).toEqual([]);
  });
  test('Strict Mode (activate, deactivate, activate) leaves exactly one live subscription', () => {
    const linkSubs = new Set();
    const store = createNetworkStore({
      probe: async () => ({ ok: true, status: 200, ms: 10 }),
      subscribeLink: (cb) => { linkSubs.add(cb); return () => linkSubs.delete(cb); },
    });
    const first = activateNetworkService(store);
    first();
    const second = activateNetworkService(store);
    expect(linkSubs.size).toBe(1);
    second();
    expect(linkSubs.size).toBe(0);
  });
  test('the real store receives the real outcome words', async () => {
    jest.useFakeTimers();
    const probe = jest.fn(async () => ({ ok: true, status: 200, ms: 10 }));
    const store = createNetworkStore({ probe, subscribeLink: (cb) => { cb({ isConnected: true, isInternetReachable: true, type: 'wifi' }); return () => {}; } });
    const off = activateNetworkService(store);
    await jest.advanceTimersByTimeAsync(0);
    expect(store.getState().status).toBe(NET.ONLINE);
    off();
    jest.useRealTimers();
  });
});

describe('the device adapter', () => {
  beforeEach(() => {
    NetInfo.__listeners.clear();
    AppState.__listeners.clear();
    jest.clearAllMocks();
  });

  test('subscribeLink uses NetInfo\'s listener and returns its unsubscribe', () => {
    const cb = jest.fn();
    const off = subscribeLink(cb);
    expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    expect(NetInfo.__listeners.size).toBe(1);
    off();
    expect(NetInfo.__listeners.size).toBe(0);
  });
  test('subscribeAppActive tells true for "active" and false for "background" and "inactive"; its unsubscribe removes the listener', () => {
    const cb = jest.fn();
    const off = subscribeAppActive(cb);
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    [...AppState.__listeners].forEach((l) => { l('active'); l('background'); l('inactive'); });
    expect(cb.mock.calls.map(([v]) => v)).toEqual([true, false, false]);
    off();
    expect(AppState.__listeners.size).toBe(0);
  });
  test('a device store, started twice, attaches ONE NetInfo listener and ONE AppState listener', () => {
    const store = createDeviceNetworkStore();
    store.start();
    store.start();
    expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
    store.stop();
    expect(NetInfo.__listeners.size).toBe(0);
    expect(AppState.__listeners.size).toBe(0);
  });
  test('two device stores are two independent stores (the provider makes exactly one)', () => {
    expect(createDeviceNetworkStore()).not.toBe(createDeviceNetworkStore());
  });
});

describe('where the app listens (static guards)', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const sourceFiles = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(rel);
    return /\.js$/.test(entry.name) ? [rel] : [];
  });

  test('NetInfo is imported in exactly one file (the adapter), so there is one source of link events', () => {
    const importers = ['app', 'components', 'lib', 'state'].flatMap(sourceFiles).filter((f) => /@react-native-community\/netinfo/.test(read(f)));
    expect(importers).toEqual(['lib/networkDevice.js']);
  });
  test('AppState listeners for the network are only added by the adapter', () => {
    const files = ['app', 'components', 'lib', 'state'].flatMap(sourceFiles).filter((f) => /AppState\.addEventListener/.test(read(f)));
    // Phase 6 adds one unrelated listener (writes a waiting draft when the app goes to the background); it is not a network listener and lives in its own adapter.
    expect(files).toEqual(['lib/draftStoreDevice.js', 'lib/networkDevice.js']);
  });
  test('the /health probe is only built in the adapter (one place asks the backend)', () => {
    const files = ['app', 'components', 'lib', 'state'].flatMap(sourceFiles).filter((f) => f !== 'lib/healthProbe.js' && /createHealthProbe\(/.test(read(f)));
    expect(files).toEqual(['lib/networkDevice.js']);
  });
  test('the provider is mounted once, above AppProvider, and (de)activates in an effect', () => {
    const layout = read('app/_layout.js');
    expect((layout.match(/<NetworkProvider>/g) || []).length).toBe(1);
    expect(layout.indexOf('<NetworkProvider>')).toBeLessThan(layout.indexOf('<AppProvider>'));
    const context = read('state/NetworkContext.js');
    expect(context).toMatch(/useEffect\(\(\) => activateNetworkService\(store\), \[store\]\)/);
    expect(context).toMatch(/useState\(createDeviceNetworkStore\)/);
  });
  test('useNetwork() outside the provider reports "unknown", which is not offline', () => {
    const context = read('state/NetworkContext.js');
    expect(context).toMatch(/isOnline: state\.status === NET\.ONLINE \|\| state\.status === NET\.UNKNOWN/);
  });
  test('only the shared offline pieces read the network state (Phase 2): the provider, the banner, the shared failure view, Button, the OTP screen, the social buttons on Login and the Can\'t Connect screen (Phase 3)', () => {
    const users = ['app', 'components'].flatMap(sourceFiles).filter((f) => /useNetwork|NetworkContext/.test(read(f)));
    // Phase 5 adds the three screens that start a document preview or download: offline they stop at the shared offline message instead of starting a fetch that cannot finish.
    expect(users.sort()).toEqual(['app/_layout.js', 'app/cant-connect.js', 'app/document-preview.js', 'app/my-documents.js', 'app/request-details.js', 'app/request/step1.js', 'app/tracking.js', 'components/AuthGate.js', 'components/LoadFailure.js', 'components/OtpScreen.js', 'components/network/BannerDriver.js', 'components/network/CachedNote.js', 'components/network/NeedsInternet.js', 'components/request/RequestFrame.js', 'components/ui.js']);
  });
  test('the API client does not import the network service (no import cycle: it only reports through networkReporter)', () => {
    const api = read('lib/api.js');
    expect(api).toMatch(/from '\.\/networkReporter'/);
    expect(api).not.toMatch(/from '\.\/network(Service|Device)?'/);
  });
});
