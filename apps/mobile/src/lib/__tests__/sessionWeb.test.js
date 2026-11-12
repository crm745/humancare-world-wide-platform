/* global describe, test, expect, jest, beforeEach */
// The web preview keeps the tokens in localStorage instead of SecureStore; the same queue, the same
// compare-and-save and the same validation apply there.
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), getItemAsync: jest.fn() }));

const SecureStore = require('expo-secure-store');

const store = new Map();
global.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
};

const session = require('../session');

beforeEach(() => {
  store.clear();
  session.resetSessionStateForTests();
});

describe('the web localStorage fallback', () => {
  test('saves, reads and clears through localStorage, never SecureStore', async () => {
    await session.saveTokens({ token: 'a', refreshToken: 'b' });
    expect(await session.getAccessToken()).toBe('a');
    expect(await session.getRefreshToken()).toBe('b');
    expect(store.get('humancare_token')).toBe('a');
    await session.clearTokens();
    expect(await session.getAccessToken()).toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });
  test('a sign-in is announced only when asked for, and a sign-out always', async () => {
    const events = [];
    const off = session.onSessionChange((v) => events.push(v));
    await session.saveTokens({ token: 'a', refreshToken: 'b' });
    await session.saveTokens({ token: 'c', refreshToken: 'd' }, { signIn: true, attempt: session.beginSignIn() });
    await session.clearTokens();
    expect(events).toEqual([true, false]);
    off();
  });
  test('the refresh\'s compare-and-save writes only if the refresh token is still the saved one', async () => {
    await session.saveTokens({ token: 'a', refreshToken: 'b' });
    expect(await session.compareAndSaveTokens({ expectedRefreshToken: 'wrong', token: 'x', refreshToken: 'y' })).toBe(false);
    expect(store.get('humancare_token')).toBe('a');
    expect(await session.compareAndSaveTokens({ expectedRefreshToken: 'b', token: 'x', refreshToken: 'y' })).toBe(true);
    expect([store.get('humancare_token'), store.get('humancare_refresh_token')]).toEqual(['x', 'y']);
  });
  test('after a sign-out a late renewal saves nothing', async () => {
    await session.saveTokens({ token: 'a', refreshToken: 'b' });
    await session.clearTokens();
    expect(await session.compareAndSaveTokens({ expectedRefreshToken: 'b', token: 'x', refreshToken: 'y' })).toBe(false);
    expect(store.size).toBe(0);
  });
  test('missing or empty credentials are refused and nothing is stored', async () => {
    await expect(session.saveTokens({ token: 'a' })).rejects.toMatchObject({ code: 'invalid_credentials_response' });
    await expect(session.saveTokens({ token: '', refreshToken: 'b' })).rejects.toBeTruthy();
    expect(store.size).toBe(0);
  });
});
