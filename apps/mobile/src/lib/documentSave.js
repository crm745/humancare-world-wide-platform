import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { fetchDocumentFile } from './documentFile';
import { mimeTypeFor } from './documentPreview';
import { safeDownloadName } from './download';
import { uniqueName } from './documentSaveRules';
import { HumancareDownloads } from './humancareDownloads';

// "Download" on Documents & Reports: the document is SAVED, never shared, and the person is told when it is done. No folder is ever asked for.
//
//   Android 10+ (the native module in modules/humancare-downloads): into the phone's public Downloads folder under its own name and extension (the system adds " (1)" for a name that is taken). Then a native
//     notification "<file name> / Download complete" with an OPEN action, but only AFTER the file is saved, and only when notifications are allowed (the permission is asked for here, on Android 13+).
//     With notifications refused the screen shows an in-app message with an Open button instead.
//   iOS, and Android where the module or Android 10 is missing: into the app's own persistent storage (Documents/Downloads), numbered when the name is taken. The screen shows the in-app message with an
//     Open button, which opens the saved file in the app's own preview. This is NOT a public Downloads folder, and the app does not say it is.
//   Web: the browser saves the file in its own Downloads folder.
// The file is fetched with the person's sign-in (documentFile.js: the session is renewed once if it expired), and the temporary copy in the cache is removed afterwards. Whatever fails is thrown for the
// screen to turn into a message of ours (download.js downloadErrorInfo): the network and sign-in errors as they are, a failed write as code 'save_failed'.
//
// -> { name, location: 'downloads' | 'app' | 'browser', uri, mime, notified }

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const saveFailed = (cause) => Object.assign(new Error('The file could not be saved.'), { code: 'save_failed', cause });

// Whether the "download complete" notification may be shown, asking once on Android 13+. Never throws.
export async function ensureNotificationPermission(channelName) {
  if (!HumancareDownloads) return false;
  try {
    if (HumancareDownloads.areNotificationsEnabled()) return true;
    if (isExpoGo) return false;
    HumancareDownloads.ensureChannel(channelName); // Android 13+ asks for the permission only once the app has a channel
    const Notifications = await import('expo-notifications');
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'granted') return HumancareDownloads.areNotificationsEnabled();
    if (current.canAskAgain === false) return false;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.status === 'granted' && HumancareDownloads.areNotificationsEnabled();
  } catch {
    return false;
  }
}

async function saveInsideApp(temp, wanted, mime) {
  try {
    const { Directory, File, Paths } = require('expo-file-system');
    const folder = new Directory(Paths.document, 'Downloads');
    if (!folder.exists) folder.create({ idempotent: true, intermediates: true });
    let taken = [];
    try { taken = folder.list().map((entry) => entry.name); } catch { /* an unreadable folder: the write below says so */ }
    const finalName = uniqueName(wanted, taken);
    const bytes = await new File(temp.uri).bytes();
    const target = new File(folder, finalName);
    target.create();
    target.write(bytes);
    return { name: finalName, location: 'app', uri: target.uri, mime, notified: false };
  } catch (err) {
    throw saveFailed(err);
  }
}

// `t`: the app's translate function (the notification's texts). `onProgress(0..1)`: the download's progress.
export async function saveDocumentToDevice(id, name, onProgress, t) {
  const wanted = safeDownloadName(name);
  const mime = mimeTypeFor(name);

  if (Platform.OS === 'web') {
    const file = await fetchDocumentFile(id, name, onProgress);
    try {
      const a = document.createElement('a');
      a.href = file.uri;
      a.download = wanted;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => file.dispose(), 1000); // after the browser has started reading it
    }
    return { name: wanted, location: 'browser', uri: '', mime, notified: false };
  }

  const publicDownloads = Boolean(HumancareDownloads) && HumancareDownloads.isPublicDownloadsSupported();
  const canNotify = publicDownloads ? await ensureNotificationPermission(t('docs_dl_title')) : false;
  const temp = await fetchDocumentFile(id, name, onProgress);
  try {
    if (!publicDownloads) return await saveInsideApp(temp, wanted, mime);
    let saved;
    try {
      saved = await HumancareDownloads.saveToDownloads(temp.uri, wanted, mime);
    } catch (err) {
      throw saveFailed(err);
    }
    let notified = false;
    if (canNotify) {
      // Only now: the file is saved. A notification that cannot be shown is not a failed download.
      try {
        notified = await HumancareDownloads.notifyDownloadComplete(saved.name, saved.uri, mime, t('docs_dl_title'), t('docs_dl_complete'), String(t('docs_open')).toUpperCase(), t('docs_dl_title'));
      } catch { notified = false; }
    }
    return { name: saved.name, location: 'downloads', uri: saved.uri, mime, notified };
  } finally {
    temp.dispose();
  }
}

// The Open button of the in-app message (Android public Downloads only; the iOS / in-app copy opens in the app's own preview, see my-documents.js). false when no installed app can open the file.
export async function openSavedDownload(saved) {
  if (!HumancareDownloads || saved.location !== 'downloads') return false;
  try { return Boolean(await HumancareDownloads.openFile(saved.uri, saved.mime)); } catch { return false; }
}
