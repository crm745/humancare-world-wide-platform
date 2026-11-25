/* global describe, test, expect, jest, beforeEach */
// Signing out removes a PATIENT's phone from their push notifications, before the tokens are cleared, for Log out and for the idle timeout alike (both go through signOutSession).
// Merge of the notification system (device registry) with the login frontend (signOutSession / sessionEnd).
const calls = [];

jest.mock('../api', () => ({ API_BASE_URL: 'https://example.invalid' }));
jest.mock('../session', () => ({
  getRefreshToken: jest.fn(async () => 'refresh-token'),
  clearTokens: jest.fn(async () => { calls.push('clearTokens'); }),
}));
jest.mock('../serverLogout', () => ({ revokeServerSession: jest.fn(async () => { calls.push('revoke'); }) }));
jest.mock('../pushNotifications', () => ({ unregisterThisDevice: jest.fn() }));

const { signOutSession } = require('../signOut');
const { unregisterThisDevice } = require('../pushNotifications');

beforeEach(() => {
  calls.length = 0;
  unregisterThisDevice.mockReset();
  unregisterThisDevice.mockImplementation(async () => { calls.push('unregister'); return { ok: true }; });
});

describe('signOutSession and the push device', () => {
  test('a patient: the draft goes first, then the phone is unregistered, then the tokens are cleared', async () => {
    const beforeClear = jest.fn(async () => { calls.push('draft'); });
    const result = await signOutSession({ isCorporate: false, beforeClear });
    expect(calls.indexOf('unregister')).toBeGreaterThan(-1);
    expect(calls.indexOf('unregister')).toBeLessThan(calls.indexOf('clearTokens'));
    expect(calls.indexOf('draft')).toBeLessThan(calls.indexOf('clearTokens'));
    expect(result).toEqual({ push: { ok: true } });
  });

  test('a patient whose phone could not be unregistered is still signed out, and the caller is told', async () => {
    unregisterThisDevice.mockImplementation(async () => { calls.push('unregister'); return { ok: false, reason: 'network' }; });
    const result = await signOutSession({ isCorporate: false });
    expect(calls).toContain('clearTokens');
    expect(result.push).toEqual({ ok: false, reason: 'network' });
  });

  test('an unregister that throws never stops the sign-out', async () => {
    unregisterThisDevice.mockImplementation(async () => { throw new Error('boom'); });
    const result = await signOutSession({ isCorporate: false });
    expect(calls).toContain('clearTokens');
    expect(result.push.ok).toBe(false);
  });

  test('corporate sign-out never touches the push device', async () => {
    const result = await signOutSession({ isCorporate: true });
    expect(unregisterThisDevice).not.toHaveBeenCalled();
    expect(calls).toContain('clearTokens');
    expect(result).toEqual({ push: { ok: true } });
  });

  test('the idle timeout (no beforeClear) unregisters the patient\'s phone as well', async () => {
    await signOutSession({ isCorporate: false });
    expect(unregisterThisDevice).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('unregister')).toBeLessThan(calls.indexOf('clearTokens'));
  });
});
