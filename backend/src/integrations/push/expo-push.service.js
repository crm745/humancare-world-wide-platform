// Sends push notifications through Expo's push service — the free bridge Expo
// provides to APNs (iOS) and FCM (Android), so we never talk to Apple/Google directly.
// No API key needed for this HTTP API; only a per-device Expo push token.
const { pushDataFromNotification } = require('../../modules/notifications/notification-catalogue');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// `data` (optional) lets the app open the right screen when the push is tapped. It is re-checked here, whatever the caller
// passes: only { screen, serviceRequestId } survives (see pushDataFromNotification), so nothing else can ride along.
function safePushData(data) {
  if (!data || typeof data !== 'object') return undefined;
  return pushDataFromNotification({ data: { screen: data.screen }, serviceRequestId: data.serviceRequestId });
}

async function sendExpoPush(pushToken, { title, body, data } = {}) {
  if (!pushToken) return;
  const safe = safePushData(data);
  await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: pushToken, title, body, sound: 'default', ...(safe ? { data: safe } : {}) }),
  }).catch(() => {}); // Best-effort — a failed push should never fail the request that triggered it.
}

module.exports = { sendExpoPush, safePushData };
