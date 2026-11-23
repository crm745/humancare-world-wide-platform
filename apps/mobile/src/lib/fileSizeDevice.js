// Reads the size of a picked file from the device (the real read behind lib/fileSize.js). On a phone it asks expo-file-system (the legacy API, as the rest of the app uses it); in a browser the
// picked file is a blob: address, so it is fetched back and measured. Returns a number of bytes, or null when the file cannot be found; it may throw, and the caller treats that as "unknown".
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

export async function readFileSize(uri) {
  if (typeof uri !== 'string' || uri === '') return null;
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    const blob = await response.blob();
    return blob.size;
  }
  const info = await FileSystem.getInfoAsync(uri);
  return info && info.exists ? info.size : null;
}
