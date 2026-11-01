import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { authService } from '@/services/authService';
import { getSession, isPasswordChangeRequired, updateSessionUser } from '@/services/session';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getSession());

  // The HTTP client fires this on a 401 so every tab drops to the login page.
  useEffect(() => {
    const onUnauthorized = () => setSession(null);
    window.addEventListener('hcw:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hcw:unauthorized', onUnauthorized);
  }, []);

  // The HTTP client fires this when the backend refuses a call because the account still
  // has to change its temporary password; pick up the restriction it just stored.
  useEffect(() => {
    const onPasswordChangeRequired = () => setSession(getSession());
    window.addEventListener('hcw:password-change-required', onPasswordChangeRequired);
    return () => window.removeEventListener('hcw:password-change-required', onPasswordChangeRequired);
  }, []);

  // Expire the session on its deadline even if the tab stays open.
  useEffect(() => {
    if (!session) return;
    const ms = session.expiresAt - Date.now();
    const t = setTimeout(
      () => {
        authService.logout();
        setSession(null);
      },
      Math.min(Math.max(ms, 0), 2 ** 31 - 1),
    );
    return () => clearTimeout(t);
  }, [session]);

  const login = useCallback(async (identifier, password, remember) => {
    const s = await authService.login(identifier, password, remember);
    // The real backend's login only confirms the password and sends an OTP — that's
    // not a signed-in session yet, so don't treat it as one. See authService.login().
    if (!s.otpRequired) setSession(s);
    return s;
  }, []);

  const verifyOtp = useCallback(async (identifier, code, remember) => {
    const s = await authService.verifyOtp(identifier, code, remember);
    setSession(s);
    return s;
  }, []);

  // First-login password change: on success the session now holds the unrestricted tokens.
  // On any failure the restricted session is kept (or cleared, if the browser lost it).
  const completeFirstLogin = useCallback(async (currentPassword, newPassword) => {
    try {
      const s = await authService.completeFirstLoginPasswordChange(currentPassword, newPassword);
      setSession(s);
      return s;
    } catch (e) {
      setSession(getSession());
      throw e;
    }
  }, []);

  const logout = useCallback(() => {
    authService.logout();
    setSession(null);
  }, []);

  const updateUser = useCallback((patch) => {
    setSession((s) => {
      if (!s) return s;
      const user = { ...s.user, ...patch };
      updateSessionUser(user);
      return { ...s, user };
    });
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: !!session,
      passwordChangeRequired: isPasswordChangeRequired(session),
      login,
      verifyOtp,
      completeFirstLogin,
      logout,
      updateUser,
    }),
    [session, login, verifyOtp, completeFirstLogin, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
