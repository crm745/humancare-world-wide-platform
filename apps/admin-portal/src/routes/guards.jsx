import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { PageLoader } from '@/components/ui/Loading';
import { canAccess } from './navItems';
import { safeReturnPath } from './guardLogic';

/** Signed-in only. Remembers where the person was going so login can send them back —
 * except after an explicit log out, which must start from a clean login page. */
export function ProtectedRoute({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <PageLoader />;
  if (!auth.isAuthenticated) {
    const state = auth.endReason === 'logout' ? undefined : { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={state} />;
  }
  return children;
}

/** Login page: a signed-in admin goes straight to where they were headed (or the dashboard). */
export function PublicOnlyRoute({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') return <PageLoader />;
  if (auth.isAuthenticated) return <Navigate to={safeReturnPath(location.state?.from)} replace />;
  return children;
}

/** Role gate for a route (UI only; the backend still returns 403 for everyone else). */
export function RequireAccess({ access, children }) {
  const auth = useAuth();
  const location = useLocation();
  if (!canAccess(access, auth)) return <Navigate to="/forbidden" replace state={{ access, from: location.pathname }} />;
  return children;
}
