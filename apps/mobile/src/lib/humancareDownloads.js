import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

// The Android-only native module in modules/humancare-downloads (public Downloads saving, the "download complete" notification, opening a saved file). `null` everywhere it does not exist: on iOS and the
// web, in Expo Go, and in a development build made before the module was added. Callers use `null` as "save inside the app instead" (lib/documentSave.js), so nothing breaks without it.
export const HumancareDownloads = Platform.OS === 'android' ? requireOptionalNativeModule('HumancareDownloads') : null;
