import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './authContext';
import { fetchSession, loginPassword, loginPasskey, logoutRequest, LOGOUT_FAILED_MESSAGE } from '@/features/auth/api';
import { getPasskeyAssertion } from '@/services/webauthn';
import { UNAUTHORIZED_EVENT } from '@/services/config';
import { ADMIN_ROLES } from '@/utils/constants';

// Pages opened from an emailed link (see routes/AppRoutes.jsx).
const PUBLIC_LINK_PATHS = ['/accept-invite', '/enroll-passkey', '/recover-passkey'];

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
  const [logoutError, setLogoutError] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const authedRef = useRef(false);
  const bootedRef = useRef(false);
  const revalidatingRef = useRef(false);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    authedRef.current = status === 'authenticated';
  }, [status]);

  const loggingOutRef = useRef(false);

  const clear = useCallback((reason) => {
    setLogoutError(null);
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
    // The emailed-link pages are for people with no session. Probing (and renewing) a session
    // there would only add traffic, so they start signed out; every other page asks the server.
    if (PUBLIC_LINK_PATHS.includes(window.location.pathname)) {
      setStatus('unauthenticated');
      return;
    }
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

  // Two factors, in order: the password (the server answers with a short-lived ticket and the
  // passkey request), then the passkey. `onStage('passkey')` tells the page when the browser's
  // passkey prompt is about to appear. Nothing is signed in until the second step succeeds, and
  // the session is the cookies the server sets then; no token ever reaches this code.
  const login = useCallback(async (email, password, { onStage } = {}) => {
    const { loginTicket, options } = await loginPassword(email, password);
    onStage?.('passkey');
    const assertion = await getPasskeyAssertion(options);
    const profile = await loginPasskey(loginTicket, assertion);
    // /admin/me is the source of truth for role and corporateReview. It has no name,
    // so the name from the login response is kept in memory for the header.
    const session = await fetchSession();
    lastCheckRef.current = Date.now();
    setAdmin({ ...session, name: profile.name, email: profile.email });
    setEndReason(null);
    setStatus('authenticated');
  }, []);

  // Local state is cleared only once the server has confirmed the session is over (logout done, or
  // it says the session was already invalid). Any other failure keeps the user signed in and says so.
  const logout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logoutRequest();
      clear('logout');
    } catch {
      setLogoutError(LOGOUT_FAILED_MESSAGE);
    } finally {
      loggingOutRef.current = false;
      setLoggingOut(false);
    }
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
      logoutError,
      loggingOut,
      retry: boot,
    };
  }, [status, admin, endReason, logoutError, loggingOut, login, logout, boot]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
