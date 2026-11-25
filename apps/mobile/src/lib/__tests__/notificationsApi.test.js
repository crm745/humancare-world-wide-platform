/* global describe, test, expect, jest, beforeEach, __dirname */
// The calls the Notifications screen writes with, and apiDelete. The API client is a fake: no network.
jest.mock('../api', () => ({
  apiGet: jest.fn(),
  apiPost: jest.fn(),
  apiPatch: jest.fn(),
  apiDelete: jest.fn(),
}));

const api = require('../api');
const n = require('../notificationsApi');

beforeEach(() => jest.clearAllMocks());

describe('notification writes', () => {
  test('mark one read', async () => {
    api.apiPost.mockResolvedValue({ notification: { id: 7 } });
    await expect(n.markNotificationRead(7)).resolves.toEqual({ notification: { id: 7 } });
    expect(api.apiPost).toHaveBeenCalledWith('/notifications/7/read', {});
  });

  test('mark all read', async () => {
    api.apiPost.mockResolvedValue({ ok: true });
    await n.markAllNotificationsRead();
    expect(api.apiPost).toHaveBeenCalledWith('/notifications/read-all', {});
  });

  test('delete', async () => {
    api.apiDelete.mockResolvedValue({});
    await n.deleteNotification(7);
    expect(api.apiDelete).toHaveBeenCalledWith('/notifications/7');
  });

  test('an id is encoded into the path, never concatenated raw', async () => {
    api.apiDelete.mockResolvedValue({});
    await n.deleteNotification('7/../../auth');
    expect(api.apiDelete).toHaveBeenCalledWith('/notifications/7%2F..%2F..%2Fauth');
  });

  test('a failed write rejects, so the screen can leave everything unchanged', async () => {
    const err = Object.assign(new Error('Notification not found'), { status: 404 });
    api.apiPost.mockRejectedValue(err);
    api.apiDelete.mockRejectedValue(err);
    await expect(n.markNotificationRead(1)).rejects.toBe(err);
    await expect(n.markAllNotificationsRead()).rejects.toBe(err);
    await expect(n.deleteNotification(1)).rejects.toBe(err);
  });
});

describe('preferences', () => {
  test('load returns the saved values', async () => {
    api.apiGet.mockResolvedValue({ preferences: { inAppEnabled: false, pushEnabled: true } });
    await expect(n.fetchPreferences()).resolves.toEqual({ inAppEnabled: false, pushEnabled: true });
    expect(api.apiGet).toHaveBeenCalledWith('/notifications/preferences');
  });

  test('update sends only what changed and returns what the server saved', async () => {
    api.apiPatch.mockResolvedValue({ preferences: { inAppEnabled: true, pushEnabled: false } });
    await expect(n.updatePreferences({ pushEnabled: false })).resolves.toEqual({ inAppEnabled: true, pushEnabled: false });
    expect(api.apiPatch).toHaveBeenCalledWith('/notifications/preferences', { pushEnabled: false });
  });

  test('a failed load or update rejects', async () => {
    api.apiGet.mockRejectedValue(new Error('offline'));
    api.apiPatch.mockRejectedValue(new Error('offline'));
    await expect(n.fetchPreferences()).rejects.toThrow('offline');
    await expect(n.updatePreferences({ inAppEnabled: false })).rejects.toThrow('offline');
  });
});

describe('apiDelete in the real client', () => {
  test('is defined next to apiPatch, with the same conventions (apiFetch, DELETE, no body)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../api.js'), 'utf8');
    expect(src).toContain('export function apiDelete(path) {');
    expect(src).toContain("return apiFetch(path, { method: 'DELETE' });");
  });
});
