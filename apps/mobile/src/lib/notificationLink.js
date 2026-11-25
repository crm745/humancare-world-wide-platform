// Where a notification leads. ONE mapping, used for a tap on a row in the Notifications list and for a tap on a push, so the two
// can never disagree. Pure: no navigation happens here, it only answers with a route (or null).
//
// The patient app has no separate case, quotation or payment screens: all four open the request's own page, keyed by the
// SERVICE REQUEST id. So `request`, `case`, `quotation` and `payment` all go to /request-details?id={serviceRequestId}.
// `home` goes to /home. A notification with no usable screen or no valid serviceRequestId (every notification created before
// deep links existed) leads nowhere: null means "do not navigate", never a guess.
const REQUEST_SCREENS = new Set(['request', 'case', 'quotation', 'payment']);

// A positive integer id, given as a number or as the digits of one (a push delivers whatever the server sent).
function idOf(value) {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function notificationTarget({ screen, serviceRequestId } = {}) {
  if (screen === 'home') return { pathname: '/home' };
  if (REQUEST_SCREENS.has(screen)) {
    const id = idOf(serviceRequestId);
    if (id !== null) return { pathname: '/request-details', params: { id: String(id) } };
  }
  return null;
}

// A notification from GET /notifications: { data: { screen } | null, serviceRequestId }.
export function targetFromNotification(notification) {
  if (!notification || typeof notification !== 'object') return null;
  const data = notification.data && typeof notification.data === 'object' ? notification.data : {};
  return notificationTarget({ screen: data.screen, serviceRequestId: notification.serviceRequestId });
}

// A tap on a push (an expo-notifications response): the data the server sent is { screen, serviceRequestId } and nothing else.
// Only these two values are ever read, so no other field of a push can choose a route.
export function targetFromPushResponse(response) {
  const request = response && response.notification && response.notification.request;
  const data = request && request.content && request.content.data;
  if (!data || typeof data !== 'object') return null;
  return notificationTarget({ screen: data.screen, serviceRequestId: data.serviceRequestId });
}
