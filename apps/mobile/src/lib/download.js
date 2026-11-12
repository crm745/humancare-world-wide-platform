import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { getAccessToken } from './session';
import { apiDownload } from './api';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

// Downloads an authenticated file (PDF summary, a case document) and hands it to the
// person — a browser download on web, the native share sheet on a phone. Linking.openURL
// can't be used here since it can't attach the Authorization header these routes need.
export async function downloadAndShare(path, filename) {
  const token = await getAccessToken();
  const url = `${API_URL}${path}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  if (Platform.OS === 'web') {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error('Download failed.');
    const blob = await res.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
    return;
  }

  const { uri, status } = await FileSystem.downloadAsync(url, FileSystem.cacheDirectory + filename, { headers });
  if (status !== 200) throw new Error('Download failed.');
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri);
  }
}

// ---- documents: the same download, with progress and clear errors ------------------------------------------------
// downloadAndShare above is unchanged (Request Details' summary and the corporate tracking page use it). This one is
// for My Documents: it goes through apiDownload, so it renews an expired session once instead of failing, reports
// progress, and says what went wrong.

// Characters that change how a name reads, or hide part of it, and that no real file name needs: control characters
// (C0 and C1), the soft hyphen, every Unicode bidirectional control (the embeddings and overrides U+202A-202E that can
// turn "invoice-fdp.exe" around, the isolates U+2066-2069, the marks U+200E/200F/061C), the zero-width space, word
// joiner, invisible operators, BOM, line/paragraph separators and the tag characters.
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/gu;
// Spaces of every kind become one ordinary space.
const SPACES = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;
// The zero-width joiner and non-joiner are part of real spelling in Hindi, Marathi, Gujarati, Telugu and Arabic-script
// names, so they stay inside a word; next to a dot or at either end they can only hide an extension, so they go.
const JOINERS = '\\u200c\\u200d';
const JOINERS_AT_DOT = new RegExp(`[${JOINERS}]*\\.[${JOINERS}]*`, 'g');
const JOINERS_AT_ENDS = new RegExp(`^[${JOINERS}]+|[${JOINERS}]+$`, 'g');
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const MAX_NAME_LENGTH = 100;

// A file name that is safe as a name in the phone's cache and in a browser download: no path separators or characters a
// file system refuses, no ".." , no control, hidden or direction-changing characters, no leading or trailing dots or
// spaces, a reserved device name made ordinary, at most 100 characters with a short extension kept (and never cut in the
// middle of an emoji). A name that is only an extension (".pdf") becomes "document.pdf". Only a display name otherwise.
export function safeDownloadName(name) {
  let text = String(name == null ? '' : name)
    .replace(HIDDEN_CHARACTERS, '')
    .replace(SPACES, ' ')
    .replace(JOINERS_AT_DOT, '.')
    .replace(JOINERS_AT_ENDS, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/ +\./g, '.')
    .replace(/\.{2,}/g, '.')
    .trim();
  if (/^\.[A-Za-z0-9]{1,5}$/.test(text)) text = `document${text}`; // only an extension: keep it
  text = text.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!text) return 'document';
  if (RESERVED_NAME.test(text)) text = `_${text}`;
  if (text.length <= MAX_NAME_LENGTH) return text;
  const dot = text.lastIndexOf('.');
  const extension = dot > 0 && text.length - dot <= 10 ? text.slice(dot) : '';
  let base = text.slice(0, MAX_NAME_LENGTH - extension.length);
  if (/[\ud800-\udbff]$/.test(base)) base = base.slice(0, -1); // half an emoji
  base = base.replace(/[.\s]+$/, '');
  return (base || 'document') + extension;
}

// The server's error codes for a document (backend/src/modules/documents + request-review.files): 409 `document_not_clean`
// (not scanned clean and approved yet), 409 `file_changed` / `checksum_missing` / `not_verified` (the stored file cannot
// be proven to be the one that was scanned), 404 `file_missing`. Each has a message of ours in every language; the
// server's own English sentence is never shown.
const KEY_BY_CODE = {
  document_not_clean: 'docs_err_blocked',
  file_changed: 'docs_err_unverified',
  checksum_missing: 'docs_err_unverified',
  not_verified: 'docs_err_unverified',
  file_missing: 'docs_err_missing',
};

// What to tell the person: always an i18n key of ours. A known code decides first, then the status, then "generic".
export function downloadErrorInfo(err) {
  const code = err && err.code;
  const status = err && err.status;
  if (code === 'share_unavailable') return { key: 'docs_err_share' };
  if (code === 'network' || (err && err.name === 'TypeError')) return { key: 'docs_err_network' };
  if (code === 'session_expired' || code === 'not_signed_in' || code === 'session_unverified' || status === 401) return { key: 'docs_err_session' };
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(KEY_BY_CODE, code)) return { key: KEY_BY_CODE[code] };
  if (status === 403) return { key: 'docs_err_denied' };
  if (status === 404) return { key: 'docs_err_missing' };
  if (status === 409) return { key: 'docs_err_blocked' };
  return { key: 'docs_err_generic' };
}

// ---- the temporary copy of a document on the phone ---------------------------------------------------------------
// Each download is written into the cache as hcdoc-<13-digit time>-<name>. Only files with exactly that shape, directly
// in the cache folder, are ever deleted, so nothing else of the app's or the system's can be touched.
const DOWNLOAD_PREFIX = 'hcdoc';
const OWN_FILE = /^hcdoc-(\d{13})-[^/\\]+$/;
// A copy that is still here this long after it was made (the app was closed before it could be removed) is deleted
// the next time a document is downloaded.
export const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
// Android: sharing returns as soon as the person has picked an app, which may still be reading the file; it is removed
// this long after, not at once. iOS returns only when the share sheet is gone, so it is removed straight away.
export const ANDROID_REMOVE_DELAY_MS = 2 * 60 * 1000;

const ownFileName = (uri) => {
  const folder = FileSystem.cacheDirectory;
  if (!folder || typeof uri !== 'string' || !uri.startsWith(folder)) return null;
  const name = uri.slice(folder.length);
  return OWN_FILE.test(name) ? name : null;
};

// Deletes one of our own temporary copies. Never throws, never touches anything else.
export async function removeDownloadedFile(uri) {
  if (!ownFileName(uri)) return false;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    return true;
  } catch {
    return false; // a failed clean-up must not turn a finished share into an error
  }
}

// Deletes our own copies older than STALE_DOWNLOAD_MS. Best effort: a failure here changes nothing.
export async function removeStaleDownloads(now = Date.now()) {
  try {
    const folder = FileSystem.cacheDirectory;
    if (!folder) return;
    const names = await FileSystem.readDirectoryAsync(folder);
    await Promise.all(names.map((name) => {
      const match = OWN_FILE.exec(name);
      return match && now - Number(match[1]) > STALE_DOWNLOAD_MS ? removeDownloadedFile(`${folder}${name}`) : null;
    }));
  } catch { /* nothing to clean, or the folder cannot be read */ }
}

export async function downloadDocument(path, filename, { onProgress } = {}) {
  const safe = safeDownloadName(filename);

  if (Platform.OS === 'web') {
    const { blob } = await apiDownload(path, { onProgress });
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = safe;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
    return { saved: true };
  }

  if (!FileSystem.cacheDirectory) throw new Error('Download failed. Please try again.');
  await removeStaleDownloads(); // copies an earlier run left behind
  const { uri } = await apiDownload(path, { destination: `${FileSystem.cacheDirectory}${DOWNLOAD_PREFIX}-${Date.now()}-${safe}`, onProgress });

  // The file is only a way to hand the document to the share sheet: whatever happens, it does not stay on the phone.
  // It is removed after sharing has finished (so never while it is being read), or at once when sharing failed.
  let shared = false;
  try {
    if (!(await Sharing.isAvailableAsync())) {
      throw Object.assign(new Error('Sharing is not available on this device.'), { code: 'share_unavailable' });
    }
    await Sharing.shareAsync(uri);
    shared = true;
  } finally {
    if (shared && Platform.OS === 'android') setTimeout(() => { removeDownloadedFile(uri); }, ANDROID_REMOVE_DELAY_MS);
    else await removeDownloadedFile(uri);
  }
  return { saved: true };
}
