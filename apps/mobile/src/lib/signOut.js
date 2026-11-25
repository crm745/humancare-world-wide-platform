// The real wiring of lib/sessionEnd.js: the saved refresh token, the server call and the token store. Used by Profile > Log out and by the idle timeout (components/IdleSessionGuard.js).
//
// A PATIENT's phone is also removed from their push notifications here (lib/pushNotifications.js unregisterThisDevice), before the tokens are cleared (that call needs them), for BOTH ways of
// signing out. It is bounded (a few seconds) and never blocks signing out. Corporate sign-out is unchanged. Resolves { push: { ok, reason? } }: ok is false when the server did not confirm the
// removal, so the caller can tell the person.
//
// KNOWN LIMITATION (accepted, not solved here): the removal is a signed-in call. After the IDLE TIMEOUT the server has usually ended the session as well (it idles sessions out at the same 30
// minutes), so the call is refused and the phone STAYS registered for push until the patient signs in again, signs out by hand, or resets their password (which revokes every device). There is no
// link between a session and a device, so the server cannot revoke "the device of the session that just ended"; closing this needs a session-to-device relationship, a separate decision.
import { API_BASE_URL } from './api';
import { clearTokens, getRefreshToken } from './session';
import { revokeServerSession } from './serverLogout';
import { endSession } from './sessionEnd';
import { unregisterThisDevice } from './pushNotifications';

export const signOutSession = async ({ isCorporate = false, beforeClear = null } = {}) => {
  let push = { ok: true };
  await endSession({
    isCorporate,
    beforeClear: async () => {
      if (!isCorporate) {
        try { push = await unregisterThisDevice(); } catch { push = { ok: false, reason: 'unknown' }; }
      }
      if (beforeClear) await beforeClear();
    },
    readRefreshToken: getRefreshToken,
    revoke: (refreshToken) => revokeServerSession({ refreshToken, baseUrl: API_BASE_URL }),
    clear: clearTokens,
  });
  return { push };
};
