// Which push-registration failures a working connection can fix (pure, so it is unit-tested; lib/pushNotifications.js uses it).
export function isRetryablePushFailure(err) {
  if (!err) return false;
  if (err.code === 'network' || err.code === 'timeout') return true;
  if (Number(err.status) >= 500) return true;
  return !err.status && /network|offline|timed? ?out|unreachable|fetch/i.test(String(err.message || ''));
}
