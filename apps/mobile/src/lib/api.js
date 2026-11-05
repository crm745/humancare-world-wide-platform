import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getAccessToken, getRefreshToken, saveTokens, clearTokens } from './session';
import { navReplace } from './nav';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

// De-dupes concurrent refresh attempts: if three requests all hit an expired access
// token at once, only one actual /auth/refresh call goes out; the other two just wait
// on the same promise instead of racing each other.
let refreshPromise = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) throw new Error('Not logged in');
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Session expired');
      await saveTokens({ token: data.token, refreshToken: data.refreshToken });
      return data.token;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function apiFetch(path, options = {}, isRetry = false) {
  const token = await getAccessToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // Only an expired *access* token should trigger a silent refresh — `token` being
  // set means this was actually an authenticated call, not a login attempt that
  // failed for its own reason (wrong password/OTP), which also returns 401.
  if (res.status === 401 && token && !isRetry) {
    try {
      await refreshAccessToken();
      return apiFetch(path, options, true);
    } catch {
      // The session can't be renewed (expired, or signed out by a password reset). They
      // already have an account, so send them to Login rather than Get Started.
      await clearTokens();
      navReplace('/login');
      throw new Error('Your session expired. Please log in again.');
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `code` / `secondsLeft` let auth screens show the specific inline
    // message (wrong vs expired OTP, account locked) instead of a generic toast.
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.code = data.code;
    err.secondsLeft = data.secondsLeft;
    err.data = data;
    throw err;
  }
  return data;
}

export function apiGet(path) {
  return apiFetch(path);
}

export function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

export function apiPatch(path, body) {
  return apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
}

// File uploads go through FormData, which needs its own multipart boundary in the
// Content-Type header — fetch sets that automatically, but only if we don't also set
// 'Content-Type': 'application/json' like apiFetch does for everything else.
//
// `onProgress(fraction)` is called with a 0–1 value as the upload advances, so the
// caller can show a real percentage instead of a silent 10-15s wait on a big medical
// PDF over a slow connection. Plain fetch has no upload-progress event on any
// platform, so this branches: native uses expo-file-system's upload task (which
// reports progress natively), web uses XMLHttpRequest (whose `upload.onprogress` is
// the one place that web API still beats fetch).
export async function apiUpload(path, file, isRetry = false, onProgress) {
  const token = await getAccessToken();
  const url = `${API_URL}${path}`;

  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = async () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* no/invalid body */ }

        if (xhr.status === 401 && token && !isRetry) {
          try {
            await refreshAccessToken();
            resolve(await apiUpload(path, file, true, onProgress));
          } catch {
            await clearTokens();
            navReplace('/login');
            reject(new Error('Your session expired. Please log in again.'));
          }
          return;
        }

        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || 'Upload failed. Please try again.'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Please try again.'));
      // A browser needs the file itself in the form: the { uri, name, type } object that React
      // Native accepts there turns into the text "[object Object]" and the server sees no file.
      // The picked file's uri is a blob: URL, so fetch it back into a Blob.
      fetch(file.uri)
        .then((res) => res.blob())
        .then((blob) => {
          const form = new FormData();
          const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType || 'application/octet-stream');
          form.append('file', typed, file.name);
          xhr.send(form);
        })
        .catch(() => reject(new Error('Upload failed. Please try again.')));
    });
  }

  const task = FileSystem.createUploadTask(
    url,
    file.uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType: file.mimeType || 'application/octet-stream',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    (progress) => {
      if (onProgress && progress.totalBytesExpectedToSend > 0) {
        onProgress(progress.totalBytesSent / progress.totalBytesExpectedToSend);
      }
    },
  );

  const result = await task.uploadAsync();
  let data = {};
  try { data = JSON.parse(result.body); } catch { /* no/invalid body */ }

  if (result.status === 401 && token && !isRetry) {
    try {
      await refreshAccessToken();
      return apiUpload(path, file, true, onProgress);
    } catch {
      await clearTokens();
      navReplace('/login');
      throw new Error('Your session expired. Please log in again.');
    }
  }

  if (result.status < 200 || result.status >= 300) throw new Error(data.error || 'Upload failed. Please try again.');
  return data;
}
