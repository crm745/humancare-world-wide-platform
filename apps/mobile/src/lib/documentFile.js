import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { apiDownload } from './api';
import { removeDownloadedFile, removeStaleDownloads, safeDownloadName } from './download';
import { mimeTypeFor } from './documentPreview';

// Getting a document's file for the preview, and sharing it when (and only when) the person taps Share.
//
// Security: the file is fetched from GET /documents/:id/file with the person's sign-in (apiDownload renews an expired session once and sends the
// Authorization header), so the BACKEND decides who may read it, exactly as before. There is no link in the page to a private file, nothing is
// put in a public place, and no address or token is ever logged. On a phone the file is a temporary copy in the app's cache (named hcdoc-<time>-<name>,
// the only shape download.js ever deletes) that is removed when the preview closes; on the web it is an in-memory blob that is released.

// -> { uri, blob?, dispose() }. Throws what apiDownload throws (the screen turns it into a message of ours with downloadErrorInfo).
export async function fetchDocumentFile(id, name, onProgress) {
  const path = `/documents/${id}/file`;
  if (Platform.OS === 'web') {
    const { blob } = await apiDownload(path, { onProgress });
    const type = mimeTypeFor(name);
    const shown = type !== 'application/octet-stream' && blob.type !== type ? new Blob([blob], { type }) : blob;
    const uri = window.URL.createObjectURL(shown);
    return { uri, blob: shown, dispose: () => window.URL.revokeObjectURL(uri) };
  }
  if (!FileSystem.cacheDirectory) throw new Error('Download failed. Please try again.');
  await removeStaleDownloads(); // copies an earlier run left behind
  const destination = `${FileSystem.cacheDirectory}hcdoc-${Date.now()}-${safeDownloadName(name)}`;
  const { uri } = await apiDownload(path, { destination, onProgress });
  return { uri, dispose: () => { removeDownloadedFile(uri); } };
}

// The Share button. Explicit only: nothing else in the app calls this.
//   phone: the phone's share sheet, for the file that is already downloaded
//   web:   the browser's share (when it can share files), otherwise the file is saved
export async function shareDocumentFile({ uri, blob, name }) {
  const type = mimeTypeFor(name);
  if (Platform.OS === 'web') {
    const file = blob && typeof File !== 'undefined' ? new File([blob], safeDownloadName(name), { type: blob.type || type }) : null;
    if (file && typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: safeDownloadName(name) });
      return;
    }
    const a = document.createElement('a');
    a.href = uri;
    a.download = safeDownloadName(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw Object.assign(new Error('Sharing is not available on this device.'), { code: 'share_unavailable' });
  }
  await Sharing.shareAsync(uri, { mimeType: type, dialogTitle: safeDownloadName(name) });
}
