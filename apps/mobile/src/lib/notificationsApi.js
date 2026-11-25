// The patient notification endpoints the Notifications screen writes with. The list itself is read by the screen (useResource).
// Each call resolves only when the server accepted it and throws (apiFetch's error) when it did not, so a caller can update the
// screen only after a real success.
import { apiDelete, apiGet, apiPatch, apiPost } from './api';

export const markNotificationRead = (id) => apiPost(`/notifications/${encodeURIComponent(id)}/read`, {});
export const markAllNotificationsRead = () => apiPost('/notifications/read-all', {});
export const deleteNotification = (id) => apiDelete(`/notifications/${encodeURIComponent(id)}`);

// { inAppEnabled, pushEnabled }
export const fetchPreferences = () => apiGet('/notifications/preferences').then(({ preferences }) => preferences);
// `patch`: { inAppEnabled?: boolean, pushEnabled?: boolean }. Resolves to the saved values the server returns.
export const updatePreferences = (patch) => apiPatch('/notifications/preferences', patch).then(({ preferences }) => preferences);

// Push devices (patient only). One app installation, identified by its own UUID; the owner is the signed-in patient (the server
// reads it from the token). The server never returns the Expo token. Unregister answers 204 whether or not the device was theirs.
// `device`: { deviceId, expoPushToken, platform }
export const registerDevice = (device) => apiPost('/notifications/devices', device);
export const unregisterDevice = (deviceId) => apiDelete(`/notifications/devices/${encodeURIComponent(deviceId)}`);
