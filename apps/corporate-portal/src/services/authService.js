import { sha256 } from '@/utils/crypto';
import { ApiError, USE_MOCK_API, mockDelay } from './config';
import { http } from './http';
import { REMEMBER_DAYS, SESSION_HOURS, clearSession, completePasswordChange, getSession, saveSession } from './session';
import { listUsers, saveUsers } from './registrationStore';

/**
 * Sample account that exists ONLY in mock mode so the portal can be explored without registering.
 * It is not a real credential and is never used when VITE_USE_MOCK_API=false.
 */
export const MOCK_DEMO_ACCOUNT = { username: 'demo.corporate', password: 'Demo@2026' };

async function ensureDemoUser() {
  const users = listUsers();
  if (users.some((u) => u.username === MOCK_DEMO_ACCOUNT.username)) return;
  users.push({
    corporateId: 'HCW-COR-00125',
    username: MOCK_DEMO_ACCOUNT.username,
    email: 'ananya.mehta@medicorpglobal.com',
    passwordHash: await sha256(MOCK_DEMO_ACCOUNT.password),
    companyName: 'MediCorp Global Assistance Pvt. Ltd.',
    contactName: 'Ananya Mehta',
  });
  saveUsers(users);
}

const toUser = (u) => ({
  corporateId: u.corporateId,
  username: u.username,
  email: u.email,
  companyName: u.companyName,
  contactName: u.contactName,
});

// Shapes the real backend's CorporateUser (id, corporateId, email, role, corporate: {...}) into
// the same `user` shape the rest of the app already expects from toUser() above —
// there's no `username` or `contactName` field on CorporateUser itself; contactName lives
// on the company profile (Corporate.contactName) and may not be filled in yet.
const toUserFromBackend = (corporateUser) => ({
  corporateId: `HCW-COR-${String(corporateUser.corporateId).padStart(5, '0')}`,
  username: corporateUser.email,
  email: corporateUser.email,
  companyName: corporateUser.corporate?.companyName ?? '',
  contactName: corporateUser.corporate?.contactName || corporateUser.corporate?.companyName || corporateUser.email,
});

const findUser = (identifier) => {
  const id = identifier.trim().toLowerCase();
  return listUsers().find((u) => u.username === id || u.email.toLowerCase() === id);
};

// Simple client-side throttle in mock mode; the real API rate-limits on the server.
let failedAttempts = 0;
let lockedUntil = 0;

export const authService = {
  // The real backend is two-factor (password, then a separate OTP step) — this call
  // only confirms the password and triggers an OTP send, so there's no session yet.
  // Returns { otpRequired: true } instead; the caller (useAuth's login) knows not to
  // treat that as a signed-in session. verifyOtp() below completes the actual login.
  async login(identifier, password, remember) {
    if (!USE_MOCK_API) {
      await http.post('/auth/corporate/login', { email: identifier, password });
      return { otpRequired: true, identifier, remember };
    }
    await ensureDemoUser();
    await mockDelay(600, 400);
    if (Date.now() < lockedUntil) {
      throw new ApiError(`Too many failed attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)} seconds.`, 429);
    }
    const user = findUser(identifier);
    const ok = user && user.passwordHash === (await sha256(password));
    if (!user || !ok) {
      failedAttempts += 1;
      if (failedAttempts >= 5) {
        lockedUntil = Date.now() + 30000;
        failedAttempts = 0;
      }
      throw new ApiError('Invalid username or password.', 401);
    }
    failedAttempts = 0;
    const ttl = remember ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000;
    const session = {
      // Opaque mock token; the real API issues a signed JWT.
      token: `mock.${btoa(user.corporateId)}.${Date.now().toString(36)}`,
      user: toUser(user),
      expiresAt: Date.now() + ttl,
    };
    saveSession(session, remember);
    return session;
  },

  // Completes the login that login() above started — exchanges the OTP for the real
  // token. Only meaningful against the real backend; mock mode never calls this since
  // login() already returns a full session there.
  async verifyOtp(identifier, code, remember) {
    if (!USE_MOCK_API) {
      const { data } = await http.post('/auth/corporate/otp/verify', { email: identifier, code });
      const ttl = remember ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000;
      // A login with a temporary password comes back restricted (mustChangePassword /
      // code password_change_required): keep that on the session so the portal can send
      // the person to the first-login password change instead of the dashboard.
      const passwordChangeRequired =
        data.mustChangePassword === true || data.code === 'password_change_required' || data.corporateUser?.mustChangePassword === true;
      const session = {
        token: data.token,
        refreshToken: data.refreshToken,
        user: toUserFromBackend(data.corporateUser),
        expiresAt: Date.now() + ttl,
        ...(passwordChangeRequired && { passwordChangeRequired: true }),
      };
      saveSession(session, remember);
      return session;
    }
    throw new ApiError('OTP verification is not available in demo mode.', 400);
  },

  logout() {
    if (!USE_MOCK_API) http.post('/auth/corporate/logout').catch(() => undefined);
    clearSession();
  },

  /** Always resolves, so the response never reveals whether an email is registered. */
  async forgotPassword(email) {
    if (!USE_MOCK_API) {
      await http.post('/auth/corporate/forgot-password', { email });
      return {};
    }
    await ensureDemoUser();
    await mockDelay(700);
    const user = findUser(email);
    // Mock only: hand the token back so the demo can open the reset page without real email.
    return { resetToken: user ? btoa(`${user.username}:${Date.now()}`) : undefined };
  },

  // The real backend verifies an OTP code rather than a clicked email link — identifier
  // and code are only meaningful (and only sent) when !USE_MOCK_API; mock mode ignores
  // them and decodes its own token instead (2nd positional arg doubles as the token).
  async resetPassword(identifier, codeOrToken, password) {
    if (!USE_MOCK_API) {
      await http.post('/auth/corporate/reset-password', { email: identifier, code: codeOrToken, newPassword: password });
      return;
    }
    await mockDelay(700);
    let username = '';
    let issuedAt = 0;
    try {
      const [u, t] = atob(codeOrToken).split(':');
      username = u;
      issuedAt = Number(t);
    } catch {
      /* invalid token */
    }
    const users = listUsers();
    const user = users.find((u) => u.username === username);
    if (!user || !issuedAt || Date.now() - issuedAt > 3600000) throw new ApiError('This reset link is invalid or has expired.', 400);
    user.passwordHash = await sha256(password);
    saveUsers(users);
  },

  // Real backend: resolves to { message, token, refreshToken } — a fresh, unrestricted pair.
  async changePassword(currentPassword, newPassword) {
    if (!USE_MOCK_API) {
      const { data } = await http.post('/auth/corporate/change-password', { currentPassword, newPassword });
      return data;
    }
    await ensureDemoUser();
    await mockDelay(700);
    const session = getSession();
    const users = listUsers();
    const user = users.find((u) => u.username === session?.user.username);
    if (!user) throw new ApiError('Your session has expired. Please sign in again.', 401);
    if (user.passwordHash !== (await sha256(currentPassword))) throw new ApiError('Current password is incorrect.', 400);
    if (currentPassword === newPassword) throw new ApiError('New password must be different from the current password.', 400);
    user.passwordHash = await sha256(newPassword);
    saveUsers(users);
  },

  // The mandatory first-login change. Only after the backend accepts it AND the new
  // unrestricted tokens are stored does this resolve with the upgraded session; otherwise
  // it throws and the restricted session is left exactly as it was.
  async completeFirstLoginPasswordChange(currentPassword, newPassword) {
    const data = await authService.changePassword(currentPassword, newPassword);
    if (!data?.token || !data?.refreshToken) throw new ApiError('Unexpected response from the server. Please try again.', 502);
    const session = completePasswordChange(data.token, data.refreshToken);
    if (!session) {
      // The password HAS changed, but this browser would not keep the new session.
      clearSession();
      throw new ApiError('Your password was changed, but this browser could not save the new session. Please sign in again with your new password.', 500);
    }
    return session;
  },
};
