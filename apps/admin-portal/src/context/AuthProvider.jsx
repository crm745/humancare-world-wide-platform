import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './authContext';
import { fetchSession, loginRequest, logoutRequest } from '@/features/auth/api';
import { UNAUTHORIZED_EVENT } from '@/services/config';
import { ADMIN_ROLES } from '@/utils/constants';

// Returning to the tab re-checks the session, but never more often than this.
const REVALIDATE_MIN_INTERVAL_MS = 30_000;

// Session state lives in React memory only. The cookie is HTTP-only, so the browser
// holds the credential and this app can't (and doesn't try to) read it. Nothing is
// written to localStorage or sessionStorage.
//
// endReason says why there is no session: null (never signed in), 'logout' (the user
// chose to), 'expired' (the server answered 401 while signed in) or 'unreachable' (the
// first /admin/me could not reach the server at all).
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading'); // loading | authenticated | unauthenticated
  const [admin, setAdmin] = useState(null);
  const [endReason, setEndReason] = useState(null);

  const authedRef = useRef(false);
  const bootedRef = useRef(false);
  const revalidatingRef = useRef(false);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    authedRef.current = status === 'authenticated';
  }, [status]);

  const clear = useCallback((reason) => {
    setAdmin(null);
    setStatus('unauthenticated');
    setEndReason(reason);
  }, []);

  // Ask the server whether the cookie is still a valid session. A 401 is a normal
  // "signed out"; a network failure (no HTTP status) is reported as unreachable.
  const boot = useCallback(async () => {
    setStatus('loading');
    try {
      const session = await fetchSession();
      lastCheckRef.current = Date.now();
      setAdmin(session);
      setEndReason(null);
      setStatus('authenticated');
    } catch (err) {
      clear(err.status === 0 ? 'unreachable' : null);
    }
  }, [clear]);

  useEffect(() => {
    // StrictMode mounts effects twice in development; one probe is enough.
    if (bootedRef.current) return;
    bootedRef.current = true;
    boot();
  }, [boot]);

  // Any later 401 on a normal request means the session expired mid-use. Ignored if the
  // user already signed out (a late response must not relabel that as "expired").
  useEffect(() => {
    const onUnauthorized = () => {
      if (authedRef.current) clear('expired');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [clear]);

  // When the tab becomes active again, confirm the session is still valid and refresh the
  // role. Skipped if a check is already running or one succeeded recently, because focus
  // and visibilitychange usually fire together.
  const revalidate = useCallback(async () => {
    if (!authedRef.current || revalidatingRef.current || document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckRef.current < REVALIDATE_MIN_INTERVAL_MS) return;
    revalidatingRef.current = true;
    try {
      const session = await fetchSession();
      lastCheckRef.current = Date.now();
      // Keep the in-memory name from login; /admin/me does not return one.
      setAdmin((prev) => (prev ? { ...prev, ...session } : session));
    } catch (err) {
      // A network blip must not sign anyone out; only the server saying 401 does.
      if (err.status === 401) clear('expired');
    } finally {
      revalidatingRef.current = false;
    }
  }, [clear]);

  useEffect(() => {
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [revalidate]);

  const login = useCallback(async (email, password) => {
    const profile = await loginRequest(email, password);
    // /admin/me is the source of truth for role and corporateReview. It has no name,
    // so the name from the login response is kept in memory for the header.
    const session = await fetchSession();
    lastCheckRef.current = Date.now();
    setAdmin({ ...session, name: profile.name, email: profile.email });
    setEndReason(null);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      /* the cookie may already be gone */
    }
    clear('logout');
  }, [clear]);

  const value = useMemo(() => {
    const isSuperadmin = admin?.adminRole === ADMIN_ROLES.SUPERADMIN;
    return {
      status,
      admin,
      isAuthenticated: status === 'authenticated',
      endReason,
      sessionExpired: endReason === 'expired',
      serverUnreachable: endReason === 'unreachable',
      isSuperadmin,
      // Superadmins are always corporate reviewers (the backend reports this too).
      canReviewCorporates: isSuperadmin || admin?.corporateReview === true,
      login,
      logout,
      retry: boot,
    };
  }, [status, admin, endReason, login, logout, boot]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
