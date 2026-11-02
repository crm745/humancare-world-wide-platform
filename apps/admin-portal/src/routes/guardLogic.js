// Where to send someone after signing in. Only same-app paths are honoured, so a crafted
// router state can never redirect to another site, and pages that make no sense as a
// destination fall back to the dashboard.
export function safeReturnPath(from) {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/dashboard';
  const pathname = from.split(/[?#]/)[0];
  if (pathname === '/' || pathname === '/login' || pathname === '/forbidden') return '/dashboard';
  return from;
}
