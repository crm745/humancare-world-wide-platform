// The one submission tracker of the app, on the phone's secure storage (the same Keychain / Keystore the sign-in tokens use; the browser's localStorage on the web preview).
// Only { id, startedAt, userId } of submissions whose outcome is not confirmed is ever written there (see lib/submissionKey.js), so there is no patient data in it. `userId` is
// the account's id read from the access token's claims (lib/tokenIdentity.js): it says whose key it is, and grants nothing.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getAccessToken } from './session';
import { userIdFromToken } from './tokenIdentity';
import { createSubmissionTracker } from './submissionKey';
import { secureUuid } from './secureRandom';
import { submissionVault } from './unresolvedSubmissionVaultDevice';

const isWeb = Platform.OS === 'web';
export const deviceStorage = {
  get: async (key) => (isWeb ? window.localStorage.getItem(key) : SecureStore.getItemAsync(key)),
  set: async (key, value) => (isWeb ? window.localStorage.setItem(key, value) : SecureStore.setItemAsync(key, value)),
  del: async (key) => (isWeb ? window.localStorage.removeItem(key) : SecureStore.deleteItemAsync(key)),
};

// The signed-in account, from the saved access token (an EXPIRED one still names its owner: it is only read, never trusted for access). null when nobody is signed in.
export const currentAccountId = async () => userIdFromToken(await getAccessToken());

// Keys are made by the phone's secure generator (lib/secureRandom.js), the same one the upload ids use. The format is unchanged, so keys already stored stay valid.
export const submissionTracker = createSubmissionTracker({ storage: deviceStorage, getUserId: currentAccountId, generate: secureUuid, vault: submissionVault });
