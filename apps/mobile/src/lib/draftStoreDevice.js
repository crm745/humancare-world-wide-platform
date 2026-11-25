// Phase 6: the app's one draft store and manager, on the phone's secure storage and private document directory. NOTHING is persisted on the web preview (no secure storage there, and
// plaintext medical text must never reach localStorage): there the manager does nothing and no draft is ever offered.
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState, Platform } from 'react-native';
import { currentAccountId } from './pendingSubmissionStore';
import { createDraftStore } from './draftStore';
import { createDraftManager } from './draftManager';
import { deviceCipher, deviceHash } from './draftCryptoDevice';

export const draftsSupported = Platform.OS !== 'web' && !!FileSystem.documentDirectory;

// The key is readable once the phone has been unlocked after a restart, and never leaves this device (no iCloud/Google backup of the key).
const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const secure = {
  get: (name) => SecureStore.getItemAsync(name, SECURE_OPTIONS),
  set: (name, value) => SecureStore.setItemAsync(name, value, SECURE_OPTIONS),
  del: (name) => SecureStore.deleteItemAsync(name, SECURE_OPTIONS),
};

const files = {
  dir: FileSystem.documentDirectory || '',
  read: async (path) => {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? FileSystem.readAsStringAsync(path) : null;
  },
  write: (path, text) => FileSystem.writeAsStringAsync(path, text),
  remove: (path) => FileSystem.deleteAsync(path, { idempotent: true }),
  // No move/rename: a replacement overwrites the OLDER of two slot files in place and the newest authenticated slot wins (lib/draftStore.js), so nothing depends on how a platform's move treats an existing target.
};

const disabledStore = { load: async () => ({ status: 'none' }), save: async () => ({ ok: false, reason: 'unsupported' }), discard: async () => true };

export const draftStore = draftsSupported ? createDraftStore({ secure, files, cipher: deviceCipher, hash: deviceHash }) : disabledStore;

// Going to the background writes what is waiting at once (the app may be killed there). Returns the unsubscribe.
export const flushOnBackground = (manager) => {
  const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') manager.flush(); });
  return () => sub.remove();
};

// `defaults` (the form's empty draft) is supplied by AppContext when it creates the manager, so this module does not import the screen state.
export const makeDraftManager = (defaults) => createDraftManager({ store: draftStore, getAccountId: currentAccountId, defaults });
