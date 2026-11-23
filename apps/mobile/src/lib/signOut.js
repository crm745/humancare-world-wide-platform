// The real wiring of lib/sessionEnd.js: the saved refresh token, the server call and the token store. Used by Profile > Log out and by the idle timeout (components/IdleSessionGuard.js).
import { API_BASE_URL } from './api';
import { clearTokens, getRefreshToken } from './session';
import { revokeServerSession } from './serverLogout';
import { endSession } from './sessionEnd';

export const signOutSession = ({ isCorporate = false, beforeClear = null } = {}) => endSession({
  isCorporate,
  beforeClear,
  readRefreshToken: getRefreshToken,
  revoke: (refreshToken) => revokeServerSession({ refreshToken, baseUrl: API_BASE_URL }),
  clear: clearTokens,
});
