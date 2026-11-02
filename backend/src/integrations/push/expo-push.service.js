// Sends push notifications through Expo's push service — the free bridge Expo
// provides to APNs (iOS) and FCM (Android), so we never talk to Apple/Google directly.
// No API key needed for this HTTP API; only a per-device Expo push token.
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendExpoPush(pushToken, { title, body }) {
  if (!pushToken) return;
  await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: pushToken, title, body, sound: 'default' }),
  }).catch(() => {}); // Best-effort — a failed push should never fail the request that triggered it.
}

module.exports = { sendExpoPush };
