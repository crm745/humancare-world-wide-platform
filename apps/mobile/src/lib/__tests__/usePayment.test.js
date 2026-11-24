/* global describe, test, expect, jest, beforeEach */
// The Pay Now hook with the REAL lib/payments.js and lib/paymentAttempts.js. React is replaced by a tiny hook runtime (no renderer is
// installed in this project) so "render again" and "unmount / mount" can be done by hand. Only the network, the key store and the browser are faked.
const mockStore = new Map();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k) => (mockStore.has(k) ? mockStore.get(k) : null)),
    setItem: jest.fn(async (k, v) => { mockStore.set(k, v); }),
    removeItem: jest.fn(async (k) => { mockStore.delete(k); }),
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } })); // no AppState on purpose: the hook must not need it
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../api', () => ({ API_BASE_URL: 'https://api.example.test/', apiGet: jest.fn(), apiPost: jest.fn() }));

const mockRt = { slots: [], i: 0, queue: [] };
jest.mock('react', () => {
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, n) => Object.is(x, b[n]));
  const slot = (make) => { const k = mockRt.i++; if (!mockRt.slots[k]) mockRt.slots[k] = make(); return mockRt.slots[k]; };
  return {
    useState: (init) => { const s = slot(() => ({ v: typeof init === 'function' ? init() : init })); return [s.v, (n) => { s.v = typeof n === 'function' ? n(s.v) : n; }]; },
    useRef: (init) => slot(() => ({ ref: { current: init } })).ref,
    useCallback: (fn, deps) => { const s = slot(() => ({ fn, deps })); if (!same(s.deps, deps)) { s.fn = fn; s.deps = deps; } return s.fn; },
    useEffect: (fn, deps) => {
      const s = slot(() => ({ deps: null, first: true }));
      if (s.first || deps === undefined || !same(s.deps, deps)) { s.first = false; s.deps = deps; s.run = fn; mockRt.queue.push(s); }
    },
  };
});

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const { apiGet, apiPost } = require('../api');
const attempts = require('../paymentAttempts');
const { usePayment, CHECK_TIMEOUT_MS } = require('../usePayment');

let current;
let onChanged;
const flush = () => new Promise((resolve) => setImmediate(resolve));
function render(props = {}) {
  mockRt.i = 0;
  current = usePayment({ invoice: { id: 1, balance: '100.00' }, requestId: 7, onChanged, ...props });
  const queued = mockRt.queue.splice(0);
  for (const s of queued) { if (typeof s.cleanup === 'function') s.cleanup(); s.cleanup = s.run(); }
  return current;
}
const unmount = () => { for (const s of mockRt.slots) if (s && typeof s.cleanup === 'function') s.cleanup(); mockRt.slots = []; mockRt.queue = []; };
const pendingInvoice = { invoice: { id: 1, balance: '100.00', paid: '0.00', payments: [{ id: 1, kind: 'payment', status: 'pending', amount: '100.00' }] } };
const KEY = 'hc_00000000000040008000000000000001';

function seed(extra = {}) {
  mockStore.set(attempts.attemptKeyFor(1), JSON.stringify({ key: KEY, requestId: 7, phase: 'checkout', paymentId: 1, baselineBalance: '100.00', hint: null, startedAt: 1, ...extra }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  unmount();
  apiGet.mockReset();
  apiPost.mockReset();
  onChanged = jest.fn();
});

describe('usePayment: a stale checkout attempt is settled once and never restarted', () => {
  test('mount looks once; re-renders cannot restart it; Pay Now ends up enabled with payment 1, its key and no POST', async () => {
    seed();
    apiGet.mockResolvedValue(pendingInvoice);
    render();
    expect(render().phase).toBe('working'); // the mount check is running
    await flush();
    for (let n = 0; n < 6; n += 1) render(); // re-renders with new props objects and new callbacks
    await flush();
    render();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
    expect(current.phase).toBe('cancelled');
    expect(current.working).toBe(false);
    expect(current.payNowOffered).toBe(true); // Pay Now shown AND enabled (it is disabled only while working)
    expect(await attempts.loadAttempt(1)).toMatchObject({ phase: 'order', paymentId: 1, key: KEY, baselineBalance: '100.00' });
  });

  test('focus events cannot restart it: the hook listens to none, and a settled attempt makes no request even if asked again', async () => {
    seed();
    apiGet.mockResolvedValue(pendingInvoice);
    render();
    await flush();
    await current.check(); // an explicit re-check on a settled attempt: nothing to look at
    await current.check();
    render();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(current.working).toBe(false);
  });

  test('a remount (the screen reloading its data) after settling asks nothing', async () => {
    seed();
    apiGet.mockResolvedValue(pendingInvoice);
    render();
    await flush();
    unmount();
    render();
    await flush();
    render();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(current.phase).not.toBe('working');
  });

  test('the backend completed it: paid, attempt cleared', async () => {
    seed();
    apiGet.mockResolvedValue({ invoice: { id: 1, balance: '0.00', paid: '100.00', payments: [{ id: 1, kind: 'payment', status: 'completed' }] } });
    render();
    await flush();
    render();
    expect(current.phase).toBe('paid');
    expect(await attempts.loadAttempt(1)).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('usePayment: errors never leave the button spinning', () => {
  test('a storage failure while settling ends in "error", not "working"', async () => {
    seed();
    apiGet.mockResolvedValue(pendingInvoice);
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('quota'));
    render();
    await flush();
    render();
    expect(current.phase).toBe('error');
    expect(current.messageKey).toBe('payment_error_generic');
    expect(current.working).toBe(false);
  });

  test('an unreadable invoice shows "confirming" with Check again, not a spinner, and keeps the attempt', async () => {
    seed();
    apiGet.mockRejectedValue(Object.assign(new Error('x'), { status: 503 }));
    render();
    await flush();
    render();
    expect(current.phase).toBe('confirming');
    expect((await attempts.loadAttempt(1)).phase).toBe('checkout');
  });
});

describe('usePayment: a hung look cannot keep the row working', () => {
  test('if the single request never answers, the row ends in "error" after the timeout and Pay Now is enabled', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      seed();
      apiGet.mockReturnValue(new Promise(() => {})); // never settles
      render();
      await flush();
      expect(render().phase).toBe('working');
      jest.advanceTimersByTime(CHECK_TIMEOUT_MS + 1);
      await flush();
      render();
      expect(current.phase).toBe('error');
      expect(current.working).toBe(false);
      expect(current.payNowOffered).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});
