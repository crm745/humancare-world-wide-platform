/* global describe, test, expect, jest, beforeEach */
// Stage B: hosted Razorpay payment. Real lib/payments.js and lib/paymentAttempts.js; only the network (api.js), the system
// browser, the key store (AsyncStorage) and the random id are faked.
const mockStore = new Map();
let mockUuid = 0;
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k) => (mockStore.has(k) ? mockStore.get(k) : null)),
    setItem: jest.fn(async (k, v) => { mockStore.set(k, v); }),
    removeItem: jest.fn(async (k) => { mockStore.delete(k); }),
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../api', () => ({ API_BASE_URL: 'https://api.example.test/', apiGet: jest.fn(), apiPost: jest.fn() }));

const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const WebBrowser = require('expo-web-browser');
const { apiGet, apiPost } = require('../api');
const attempts = require('../paymentAttempts');
const pay = require('../payments');

const INVOICE = { id: 761, balance: '1500.00' };
const noSleep = async () => {};
const apiError = (status, code) => Object.assign(new Error(code || 'x'), { status, code });
const orderOk = (over = {}) => ({ paymentId: 55, invoiceId: 761, status: 'pending', amount: '1500.00', currency: 'INR', razorpay: { keyId: 'rzp_test_x', orderId: 'order_1', amount: 150000, currency: 'INR' }, ...over });
const session = { checkoutPath: '/checkout/abcdefghijklmnop', expiresAt: '2026-11-19T10:00:00.000Z' };
const invoiceWith = (paymentStatus, balance, id = 55) => ({ invoice: { id: 761, balance, paid: '0.00', payments: [{ id, kind: 'payment', status: paymentStatus, amount: '1500.00' }] } });

// Routes the two POSTs; `order` and `checkout` are functions or values (a thrown Error is rejected).
function routePosts({ order = orderOk(), checkout = session } = {}) {
  apiPost.mockImplementation(async (path, body, opts) => {
    const pick = path.endsWith('/payment-orders') ? order : checkout;
    const value = typeof pick === 'function' ? await pick(path, body, opts) : pick;
    if (value instanceof Error) throw value;
    return value;
  });
}
const orderCalls = () => apiPost.mock.calls.filter(([p]) => p.endsWith('/payment-orders'));
const sessionCalls = () => apiPost.mock.calls.filter(([p]) => p.endsWith('/checkout-sessions'));

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockUuid = 0;
  apiGet.mockReset();
  apiPost.mockReset();
  WebBrowser.openAuthSessionAsync.mockReset();
});

describe('pure helpers', () => {
  test('parsePaymentReturn reads the invoice and an allow-listed result word only', () => {
    expect(pay.parsePaymentReturn('humancare://payment-return?invoice=761&result=submitted')).toEqual({ invoiceId: '761', result: 'submitted' });
    expect(pay.parsePaymentReturn('humancare://payment-return?invoice=761&result=PAID_OK')).toEqual({ invoiceId: '761', result: 'returned' });
    expect(pay.parsePaymentReturn('humancare://payment-return?result=unavailable')).toEqual({ invoiceId: null, result: 'unavailable' });
    expect(pay.parsePaymentReturn('humancare://payment-return?invoice=abc&result=cancelled')).toEqual({ invoiceId: null, result: 'cancelled' });
    expect(pay.parsePaymentReturn(undefined)).toEqual({ invoiceId: null, result: 'returned' });
  });

  test('checkoutUrl builds the absolute URL from the configured base and refuses anything but /checkout/<token>', () => {
    expect(pay.checkoutUrl('/checkout/abcdefghijklmnop')).toBe('https://api.example.test/checkout/abcdefghijklmnop');
    expect(pay.checkoutUrl('/checkout/abcdefghijklmnop', 'http://10.0.0.2:4000')).toBe('http://10.0.0.2:4000/checkout/abcdefghijklmnop');
    for (const bad of ['https://evil.test/checkout/abcdefghijklmnop', '//evil.test/x', '/other/abcdefghijklmnop', '/checkout/', '/checkout/a/b', undefined, 5]) {
      expect(() => pay.checkoutUrl(bad)).toThrow();
    }
  });

  test('compareDecimal compares exact decimal text', () => {
    expect(pay.compareDecimal('750.00', '1500.00')).toBe(-1);
    expect(pay.compareDecimal('1500.00', '1500')).toBe(0);
    expect(pay.compareDecimal('0.00', '0')).toBe(0);
    expect(pay.compareDecimal('1500.01', '1500.00')).toBe(1);
    expect(pay.compareDecimal('abc', '1')).toBeNull();
  });

  test('evaluateInvoice: paid needs a completed payment AND a lower balance', () => {
    const ctx = { paymentId: 55, baselineBalance: '1500.00' };
    expect(pay.evaluateInvoice(invoiceWith('completed', '0.00').invoice, ctx)).toEqual({ state: 'paid', fullyPaid: true });
    expect(pay.evaluateInvoice(invoiceWith('completed', '500.00').invoice, ctx)).toEqual({ state: 'paid', fullyPaid: false });
    expect(pay.evaluateInvoice(invoiceWith('completed', '1500.00').invoice, ctx)).toEqual({ state: 'pending' }); // balance not updated yet
    expect(pay.evaluateInvoice(invoiceWith('pending', '1500.00').invoice, ctx)).toEqual({ state: 'pending' });
    expect(pay.evaluateInvoice(invoiceWith('failed', '1500.00').invoice, ctx)).toEqual({ state: 'failed' });
    expect(pay.evaluateInvoice(invoiceWith('completed', '0.00', 99).invoice, ctx)).toEqual({ state: 'pending' }); // somebody else's payment
  });
});

describe('payable and non-payable invoices', () => {
  test('a refused order (invoice not payable) makes no checkout session, opens no browser and ends the attempt', async () => {
    routePosts({ order: apiError(409, 'invoice_not_payable') });
    const result = await pay.startPayment({ invoice: INVOICE, requestId: 7, sleep: noSleep });
    expect(result).toEqual({ outcome: 'error', messageKey: 'payable_reason_invoice_not_payable', refresh: true });
    expect(sessionCalls()).toHaveLength(0);
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect(await attempts.loadAttempt(761)).toBeNull(); // a refused request created nothing, so its key is dropped
  });

  test.each([['invoice_overdue', 'payable_reason_invoice_overdue'], ['quotation_not_active', 'payable_reason_quotation_not_active'], ['currency_unsupported', 'payable_reason_currency_unsupported'], ['payments_disabled', 'payable_reason_payments_disabled']])('%s is explained with the existing reason text', async (code, key) => {
    routePosts({ order: apiError(code === 'payments_disabled' ? 503 : 409, code) });
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).messageKey).toBe(key);
  });
});

describe('idempotency persistence and retries', () => {
  test('the order is created with the full mode and a valid Idempotency-Key that was saved BEFORE the request', async () => {
    let savedBeforeRequest = null;
    routePosts({ order: async (_p, _b, opts) => { savedBeforeRequest = (await attempts.loadAttempt(761)).key; expect(opts.headers['Idempotency-Key']).toBe(savedBeforeRequest); return orderOk(); } });
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValue(invoiceWith('completed', '0.00'));
    await pay.startPayment({ invoice: INVOICE, requestId: 7, sleep: noSleep });
    const [path, body, opts] = orderCalls()[0];
    expect(path).toBe('/invoices/761/payment-orders');
    expect(body).toEqual({ mode: 'full' });
    expect(opts.headers['Idempotency-Key']).toMatch(attempts.KEY_PATTERN);
    expect(opts.headers['Idempotency-Key']).toBe(savedBeforeRequest);
  });

  test('a timeout does NOT make a new key: the retry reuses the saved one, even after an app restart', async () => {
    routePosts({ order: new Error('The request was cancelled.') }); // no status: no answer
    expect((await pay.startPayment({ invoice: INVOICE, requestId: 7, sleep: noSleep })).outcome).toBe('uncertain');
    const firstKey = orderCalls()[0][2].headers['Idempotency-Key'];
    expect((await attempts.loadAttempt(761)).key).toBe(firstKey);

    // "app restart": module state is gone, only the stored record remains.
    jest.resetModules();
    const fresh = require('../payments');
    const freshApi = require('../api');
    freshApi.apiPost.mockRejectedValueOnce(apiError(502, 'gateway_unavailable'));
    expect((await fresh.startPayment({ invoice: INVOICE, requestId: 7, sleep: noSleep })).outcome).toBe('uncertain');
    expect(freshApi.apiPost.mock.calls[0][2].headers['Idempotency-Key']).toBe(firstKey);
  });

  test('202 gateway_uncertain, 502, 500 and 429 all keep the key and show a retry message', async () => {
    for (const reply of [{ code: 'gateway_uncertain', paymentId: 55, invoiceId: 761 }, apiError(502, 'gateway_unavailable'), apiError(500), apiError(429, 'rate_limited')]) {
      mockStore.clear();
      apiPost.mockReset();
      routePosts({ order: reply });
      const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
      expect(result.outcome).toBe('uncertain');
      expect(await attempts.loadAttempt(761)).not.toBeNull();
      expect(sessionCalls()).toHaveLength(0);
    }
  });

  test('if the key cannot be saved no order request is made at all', async () => {
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    routePosts();
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).outcome).toBe('error');
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('a brand new attempt gets a different key', async () => {
    const a = await attempts.getOrCreateAttempt(1);
    await attempts.clearAttempt(1);
    const b = await attempts.getOrCreateAttempt(1);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toMatch(attempts.KEY_PATTERN);
  });
});

describe('existing open order', () => {
  test('open_order_exists adopts the open payment from the invoice and creates nothing', async () => {
    routePosts({ order: apiError(409, 'open_order_exists') });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00', 77));
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValueOnce(invoiceWith('pending', '1500.00', 77)).mockResolvedValue(invoiceWith('completed', '0.00', 77));
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(orderCalls()).toHaveLength(1);
    expect(sessionCalls()).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'paid', fullyPaid: true });
  });

  test('replaying a pending order (same key) goes straight on to a checkout session', async () => {
    routePosts({ order: orderOk({ paymentId: 55 }) });
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    const keys = orderCalls().map((c) => c[2].headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });

  test('the server answering that this attempt already ended (closed order) ends it and asks for a new tap', async () => {
    routePosts({ order: { paymentId: 55, invoiceId: 761, status: 'failed', amount: '1500.00', currency: 'INR' } });
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(result).toMatchObject({ outcome: 'failed', messageKey: 'payment_order_closed' });
    expect(sessionCalls()).toHaveLength(0);
    expect(await attempts.loadAttempt(761)).toBeNull();
  });
});

describe('checkout session errors and browser launch', () => {
  test('a failed session request keeps the order and attempt; no browser', async () => {
    routePosts({ checkout: apiError(500) });
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(result).toEqual({ outcome: 'error', messageKey: 'payment_checkout_failed', refresh: false });
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
    expect((await attempts.loadAttempt(761)).phase).toBe('order');
  });

  test('no_open_payment drops the attempt and says to start again', async () => {
    routePosts({ checkout: apiError(409, 'no_open_payment') });
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toEqual({ outcome: 'error', messageKey: 'payment_no_open', refresh: true });
    expect(await attempts.loadAttempt(761)).toBeNull();
  });

  test('a checkout path that is not /checkout/<token> is never opened', async () => {
    routePosts({ checkout: { checkoutPath: 'https://evil.test/pay', expiresAt: 'x' } });
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).messageKey).toBe('payment_checkout_failed');
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });

  test('Checkout opens on the configured API base with humancare://payment-return as the return URL', async () => {
    routePosts();
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://api.example.test/checkout/abcdefghijklmnop', 'humancare://payment-return');
  });

  test('a browser that cannot launch shows a message; the order and key stay for the retry', async () => {
    routePosts();
    WebBrowser.openAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toEqual({ outcome: 'error', messageKey: 'payment_browser_failed' });
    expect((await attempts.loadAttempt(761)).phase).toBe('order');
  });
});

describe('return handling, cancellation, failure, delayed webhook, completion', () => {
  beforeEach(() => routePosts());

  test('the redirect alone never means paid: "submitted" with a pending invoice stays confirming (bounded polling)', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(result).toEqual({ outcome: 'confirming' });
    expect(apiGet).toHaveBeenCalledTimes(pay.POLLS_AFTER_RETURN);
    expect(apiGet).toHaveBeenCalledWith('/invoices/761');
    expect((await attempts.loadAttempt(761)).phase).toBe('checkout'); // kept so the app can pick it up again
  });

  test('a delayed webhook: pending for a while, then completed with a lower balance -> paid, attempt cleared', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValueOnce(invoiceWith('pending', '1500.00')).mockResolvedValueOnce(invoiceWith('pending', '1500.00')).mockResolvedValue(invoiceWith('completed', '0.00'));
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(result).toMatchObject({ outcome: 'paid', fullyPaid: true });
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(await attempts.loadAttempt(761)).toBeNull();
  });

  test('a completed payment whose balance has not changed is not shown as paid', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValue(invoiceWith('completed', '1500.00'));
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).outcome).toBe('confirming');
  });

  test('a partly paid invoice is paid but not fullyPaid', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValue(invoiceWith('completed', '500.00'));
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toMatchObject({ outcome: 'paid', fullyPaid: false });
  });

  test('cancellation (closing the browser) shows cancelled after a short check and keeps the open order resumable', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toEqual({ outcome: 'cancelled' });
    expect(apiGet).toHaveBeenCalledTimes(pay.POLLS_AFTER_CANCEL);
    expect(await attempts.loadAttempt(761)).not.toBeNull();
  });

  test('closing the browser right after paying still ends as paid once the backend says so', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });
    apiGet.mockResolvedValueOnce(invoiceWith('pending', '1500.00')).mockResolvedValue(invoiceWith('completed', '0.00'));
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).outcome).toBe('paid');
  });

  test('a failed payment (backend status failed) shows failed and ends the attempt so the next tap is a new one', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=failed' });
    apiGet.mockResolvedValue(invoiceWith('failed', '1500.00'));
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toMatchObject({ outcome: 'failed', messageKey: 'payment_failed' });
    expect(await attempts.loadAttempt(761)).toBeNull();
  });

  test('a reported failure while the order is still open shows failed but keeps the attempt (Pay Now resumes the same order)', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=failed' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    expect(await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).toMatchObject({ outcome: 'failed', open: true });
    expect(await attempts.loadAttempt(761)).not.toBeNull();
  });

  test('failed polls (network) are skipped, not fatal', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(apiError(429, 'rate_limited')).mockResolvedValue(invoiceWith('completed', '0.00'));
    expect((await pay.startPayment({ invoice: INVOICE, sleep: noSleep })).outcome).toBe('paid');
  });

  test('polling stops when the screen is left, keeping the attempt', async () => {
    WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'humancare://payment-return?invoice=761&result=submitted' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    let n = 0;
    const result = await pay.startPayment({ invoice: INVOICE, sleep: noSleep, shouldStop: () => ++n > 2 });
    expect(result.stopped).toBe(true);
    expect(apiGet.mock.calls.length).toBeLessThan(pay.POLLS_AFTER_RETURN);
    expect(await attempts.loadAttempt(761)).not.toBeNull();
  });
});

describe('deep-link return handling', () => {
  test('the link records the browser word on the saved attempt and tells which request to show', async () => {
    await attempts.getOrCreateAttempt(761, { requestId: 7 });
    await attempts.updateAttempt(761, { phase: 'checkout', paymentId: 55 });
    expect(await pay.handlePaymentReturn('humancare://payment-return?invoice=761&result=cancelled')).toEqual({ invoiceId: '761', requestId: 7 });
    expect((await attempts.loadAttempt(761)).hint).toBe('cancelled');
  });

  test('a link with no attempt or no invoice changes nothing', async () => {
    expect(await pay.handlePaymentReturn('humancare://payment-return?invoice=999&result=submitted')).toEqual({ invoiceId: '999', requestId: null });
    expect(await pay.handlePaymentReturn('humancare://payment-return')).toEqual({ invoiceId: null, requestId: null });
    expect(mockStore.size).toBe(0);
  });
});

describe('app restart recovery', () => {
  test('an attempt left in Checkout is verified when the app comes back, and paid clears it', async () => {
    await attempts.getOrCreateAttempt(761, { requestId: 7, baselineBalance: '1500.00' });
    await attempts.updateAttempt(761, { phase: 'checkout', paymentId: 55, hint: 'submitted' });
    apiGet.mockResolvedValue(invoiceWith('completed', '0.00'));
    expect(await pay.resumePayment({ invoiceId: 761, sleep: noSleep })).toMatchObject({ outcome: 'paid', fullyPaid: true });
    expect(await attempts.loadAttempt(761)).toBeNull();
  });

  test('a still-pending one stays "confirming" and is bounded', async () => {
    await attempts.getOrCreateAttempt(761, { baselineBalance: '1500.00' });
    await attempts.updateAttempt(761, { phase: 'checkout', paymentId: 55, hint: 'submitted' });
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    expect(await pay.resumePayment({ invoiceId: 761, sleep: noSleep })).toEqual({ outcome: 'confirming' });
    expect(apiGet).toHaveBeenCalledTimes(pay.POLLS_ON_RESUME);
  });

  test('nothing to resume (no attempt, or Checkout was never opened) makes no request', async () => {
    expect(await pay.resumePayment({ invoiceId: 761, sleep: noSleep })).toBeNull();
    await attempts.getOrCreateAttempt(761);
    expect(await pay.resumePayment({ invoiceId: 761, sleep: noSleep })).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('duplicate tap prevention', () => {
  test('a second Pay Now while one is running does nothing: one order, one session, one browser', async () => {
    routePosts();
    let release;
    WebBrowser.openAuthSessionAsync.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ type: 'cancel' }); }));
    apiGet.mockResolvedValue(invoiceWith('pending', '1500.00'));
    const first = pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    const second = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    const third = await pay.startPayment({ invoice: INVOICE, sleep: noSleep });
    expect(second).toEqual({ outcome: 'busy' });
    expect(third).toEqual({ outcome: 'busy' });
    expect(pay.isRunning(761)).toBe(true);
    while (!release) await new Promise((r) => setImmediate(r));
    release();
    await first;
    expect(orderCalls()).toHaveLength(1);
    expect(sessionCalls()).toHaveLength(1);
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(pay.isRunning(761)).toBe(false);
  });

  test('resuming does not start while a payment is running, and a different invoice is independent', async () => {
    const hold = pay.runExclusive(761, () => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'confirming' }), 10)));
    expect(await pay.resumePayment({ invoiceId: 761, sleep: noSleep })).toBeNull();
    expect(await pay.runExclusive(762, async () => ({ outcome: 'confirming' }))).toEqual({ outcome: 'confirming' });
    await hold;
  });
});
