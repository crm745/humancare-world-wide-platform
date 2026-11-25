// The phone's binding of the unresolved-submission vault (lib/unresolvedSubmissionVault.js): the same Keychain / Keystore options, private document directory and AES-256-GCM as the
// encrypted drafts, with its OWN key slot and files. NOTHING is persisted on the web preview (no secure storage there, and the payload is medical data): the vault is then disabled and the
// submission only lives in memory. (It does not import draftStoreDevice.js: that file reads the account from pendingSubmissionStore.js, which uses this one.)
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { deviceCipher, deviceHash } from './draftCryptoDevice';
import { PENDING_TTL_MS } from './submissionKey';
import { createSubmissionVault } from './unresolvedSubmissionVault';

const supported = Platform.OS !== 'web' && !!FileSystem.documentDirectory;
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const secure = {
  get: (name) => SecureStore.getItemAsync(name, SECURE_OPTIONS),
  set: (name, value) => SecureStore.setItemAsync(name, value, SECURE_OPTIONS),
  del: (name) => SecureStore.deleteItemAsync(name, SECURE_OPTIONS),
};
const files = {
  dir: FileSystem.documentDirectory || '',
  read: async (path) => { const info = await FileSystem.getInfoAsync(path); return info.exists ? FileSystem.readAsStringAsync(path) : null; },
  write: (path, text) => FileSystem.writeAsStringAsync(path, text),
  remove: (path) => FileSystem.deleteAsync(path, { idempotent: true }),
};

export const submissionVault = supported
  ? createSubmissionVault({ secure, files, cipher: deviceCipher, hash: deviceHash, ttlMs: PENDING_TTL_MS })
  : { save: async () => false, load: async () => null, remove: async () => true };
