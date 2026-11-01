import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { passwordChangeRedirect, protectedRedirect, publicOnlyRedirect } from './guardLogic';

/** Signed-in only; remembers where the user was going so login can send them back.
 * A session that still has to change its temporary password goes to that screen instead. */
export function ProtectedRoute({ children }) {
  const auth = useAuth();
  const location = useLocation();
  const redirect = protectedRedirect(auth, location.pathname + location.search);
  if (redirect) return <Navigate to={redirect.to} replace state={redirect.state} />;
  return <>{children}</>;
}

/** Login / registration: signed-in users go straight to the dashboard (or, if they still
 * have to change a temporary password, to that screen). */
export function PublicOnlyRoute({ children }) {
  const auth = useAuth();
  const redirect = publicOnlyRedirect(auth);
  if (redirect) return <Navigate to={redirect.to} replace />;
  return <>{children}</>;
}

/** The first-login password change: only for a signed-in session that is restricted. */
export function PasswordChangeRoute({ children }) {
  const auth = useAuth();
  const redirect = passwordChangeRedirect(auth);
  if (redirect) return <Navigate to={redirect.to} replace />;
  return <>{children}</>;
}
