/* global describe, test, expect, jest, beforeEach */
// The patient's invoice retry after an acceptance: the exact path and body, and that a failure never throws. api.js is mocked.
const mockApiPost = jest.fn();
jest.mock('../api', () => ({ apiPost: (...a) => mockApiPost(...a) }));
const { ensureInvoice, performEnsureInvoice } = require('../invoiceCreation');

beforeEach(() => mockApiPost.mockReset());

describe('invoice retry', () => {
  test('ensureInvoice posts to /quotations/:id/invoice with an empty body (no amount, no invoice id)', async () => {
    mockApiPost.mockResolvedValue({ invoice: { status: 'ready', invoiceNumber: 'INV-CASE-1-V1' } });
    await ensureInvoice(762);
    expect(mockApiPost).toHaveBeenCalledWith('/quotations/762/invoice', {});
  });
  test('performEnsureInvoice: ready, not ready, and a failure never throws', async () => {
    mockApiPost.mockResolvedValue({ invoice: { status: 'ready' } });
    expect(await performEnsureInvoice(762)).toEqual({ ok: true, ready: true });
    mockApiPost.mockResolvedValue({});
    expect(await performEnsureInvoice(762)).toEqual({ ok: true, ready: false });
    mockApiPost.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'quotation_not_accepted' }));
    expect(await performEnsureInvoice(762)).toEqual({ ok: false, ready: false });
  });
  test('it never touches payments, Razorpay or Bitrix', () => {
    const src = require('fs').readFileSync(require.resolve('../invoiceCreation.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/razorpay|bitrix|Checkout|openAuthSession|\/payment|orders/i);
  });
});
