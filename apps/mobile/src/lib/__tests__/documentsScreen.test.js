/* global describe, test, expect, __dirname */
// The My Documents screen, its card, and that the other download users and the shared DocRow are as they were.
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/my-documents.js');
const card = read('../../components/documents/DocumentCard.js');
const widgets = read('../../components/widgets.js');
const i18n = JSON.parse(read('../../data/i18n.json'));

const KEYS = ['docs_search_ph', 'docs_empty_title', 'docs_empty_sub', 'docs_no_match', 'docs_clear_search', 'docs_load_failed',
  'docs_try_again', 'docs_download', 'docs_downloading', 'docs_downloaded', 'docs_tap_retry', 'docs_err_session', 'docs_err_missing', 'docs_err_blocked',
  'docs_err_network', 'docs_err_share', 'docs_err_generic', 'docs_err_unverified', 'docs_err_denied'];

describe('the My Documents screen', () => {
  test('still loads from the same endpoint (the API contract is unchanged)', () => {
    expect(screen.match(/apiGet\(/g)).toHaveLength(1);
    expect(screen).toContain("apiGet('/requests/me/documents')");
    // the file itself is fetched by the preview screen (app/document-preview.js), from GET /documents/:id/file, with the person's sign-in
  });
  test('uses the dedicated card and opens the in-app preview, not the shared DocRow, not downloadAndShare, and never the share sheet', () => {
    expect(screen).toContain("from '../components/documents/DocumentCard'");
    expect(screen).toContain("import { openDocumentPreview } from '../lib/documentPreview'");
    expect(screen).toContain('openDocumentPreview(router.push, doc)');
    expect(screen).not.toMatch(/DocRow|downloadAndShare|downloadDocument|Sharing|Share\.share|shareAsync/);
  });
  test('shared TopBar and Body; a count, a search, a retry, an empty state and a no-match state', () => {
    expect(screen).toContain("<TopBar title={t('prof_documents')} />");
    expect(screen).not.toContain('lbl_medical_records'); // no "Medical records (n)" heading above the list
    expect(screen).not.toContain('countLabel');
    expect(screen).toContain('filterDocuments(docs, query)');
    expect(screen).toContain('onRetry={retry}');
    expect(screen).toContain("t('docs_empty_title')");
    expect(screen).toContain("t('docs_no_match')");
    expect(screen).toContain("t('docs_clear_search')");
  });
  test('a double tap opens one preview (the guard is lib/documentPreview.js); the loading and the failure are shown by the preview screen', () => {
    expect(screen).toContain("const start = (doc) => { if (isOffline) return; openDocumentPreview(router.push, doc); };"); // offline: nothing starts (the bottom message says why)
    expect(read('../../app/document-preview.js')).toContain('downloadErrorInfo(file.error).key');
  });
  test('the date is never presented as an upload date', () => {
    expect(card).toContain('documentDate(doc.uploadedAt)');
    for (const lang of Object.keys(i18n)) expect(i18n[lang].docs_added_to_case).toBeUndefined(); // no caption at all
    expect(card).not.toMatch(new RegExp('Added to case|Uploaded\\b', 'i')); // the words, not the field name uploadedAt
    expect(card).not.toMatch(/new Date\(\)|Date\.now/); // never the device's date
  });
  test('official brand blue from the palette, with no hard-coded app blue', () => {
    expect(card).toContain("from '../../lib/tracking/palette'");
    expect(card + screen).not.toMatch(/#1A73E8/i);
  });
  test('the card is an accessible 44-point button with a label', () => {
    expect(card).toContain('accessibilityRole="button"');
    expect(card).toContain('accessibilityLabel={documentAccessibilityLabel(doc, state, t)}');
    expect(card).toContain('w-14 items-center justify-center self-stretch'); // the download button: a fixed 56-wide area, centred, at least 48 high
    expect(card).toContain('minHeight: 48');
  });
  test('the download button is its own button beside the card: it SAVES the file (no share sheet), with progress, a message and a retry', () => {
    expect(card).toContain('onPress={onDownload}');
    expect(card).toContain("accessibilityLabel={`${t('docs_download')} ${doc.name}`}");
    expect(screen).toContain('onDownload={() => download(d)}');
    expect(screen).toContain('await saveDocumentToDevice(doc.id, doc.name,');
    expect(screen).toContain("toast(t('docs_saved').replace('{name}', saved.name));");
    expect(screen).toContain('if (isSaveCancelled(err))');
    expect(screen).toContain('state={downloads[d.id]}');
    expect(screen).toContain('if (downloading.current) return;'); // a second tap starts nothing
    expect(screen).not.toMatch(/shareDocumentFile|Sharing/);
  });

});

describe('translations', () => {
  test('every new label exists in all six languages', () => {
    expect(Object.keys(i18n)).toHaveLength(6);
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).toBeTruthy();
  });
  test('the templates keep their placeholders in every language', () => {
    for (const lang of Object.keys(i18n)) {
      expect(i18n[lang].docs_downloaded).toContain('{name}');
    }
  });
  test('the error messages of Group 1 are translated in every language, not copies of English', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of ['docs_err_unverified', 'docs_err_denied', 'docs_err_share']) expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
    }
  });
  test('the sharing message no longer claims the file was saved (the temporary copy is removed)', () => {
    expect(i18n.EN.docs_err_share).not.toMatch(/saved/i);
    expect(i18n.EN.docs_err_share).toContain('could not be opened');
  });
  test('the unverified-document message sends the person to Humancare World Wide, in every language', () => {
    for (const lang of Object.keys(i18n)) expect(i18n[lang].docs_err_unverified).toContain('Humancare World Wide');
  });
  test('English is the default and the others are translated', () => {
    expect(i18n.EN.docs_empty_title).toBe('No documents yet');
    expect(i18n.HI.docs_empty_title).not.toBe(i18n.EN.docs_empty_title);
    expect(i18n.AR.docs_empty_title).not.toBe(i18n.EN.docs_empty_title);
  });
});

describe('what was left alone', () => {
  test('the shared DocRow is exactly as it was', () => {
    const doc = widgets.slice(widgets.indexOf('export function DocRow'), widgets.indexOf('export function Toast'));
    expect(doc).toContain("export function DocRow({ label, meta, onPress, className = '', offline = false }) {"); // (offline: pale, with the reason)
    expect(doc).toContain('<FileText size={16} color="#D64545" />');
    expect(doc).toContain('<Download size={15} color={COLORS.primary} />');
    expect(doc).toContain("rounded-[14px] border border-line bg-white p-3 ${offline ? 'opacity-45' : 'active:opacity-80'} ${className}");
  });
  test('the corporate tracking page still uses DocRow, and downloads through the authenticated downloadDocument', () => {
    const tracking = read('../../app/tracking.js');
    expect(tracking).toContain("import { DocRow } from '../components/widgets'");
    expect(tracking).toContain("import { downloadDocument, downloadErrorInfo } from '../lib/download'");
    expect(tracking).toMatch(/downloadDocument\(`\/documents\/\$\{d\.id\}\/file`, d\.name\)/);
  });
  test('Request Details downloads its summary with the authenticated downloadDocument', () => {
    const details = read('../../app/request-details.js');
    expect(details).toContain("import { downloadDocument, downloadErrorInfo } from '../lib/download'");
    expect(details).toMatch(/downloadDocument\(`\/requests\/me\/\$\{request\.id\}\/summary`/);
  });
  test('no backend, session or guard file was touched by this feature (their markers are intact)', () => {
    const session = read('../session.js');
    expect(session).toContain('export async function compareAndClearTokens');
    expect(read('../api.js')).toContain('export async function apiUpload');
  });
});

describe('Download saves the document: lib/documentSave.js and its rules', () => {
  const rules = require('../documentSaveRules');
  const save = read('../documentSave.js');
  test('uniqueName keeps the name and extension, and numbers a name only when the folder already has it', () => {
    expect(rules.uniqueName('Report.pdf', [])).toBe('Report.pdf');
    expect(rules.uniqueName('Report.pdf', ['report.pdf'])).toBe('Report (1).pdf');
    expect(rules.uniqueName('Report.pdf', ['Report.pdf', 'Report (1).pdf'])).toBe('Report (2).pdf');
    expect(rules.uniqueName('scan', ['scan'])).toBe('scan (1)');
    expect(rules.uniqueName('a.b.jpeg', new Set(['a.b.jpeg']))).toBe('a.b (1).jpeg');
  });
  test('closing the folder picker is a cancel, not a failure; a real error is not', () => {
    expect(rules.isSaveCancelled({ code: 'save_cancelled' })).toBe(true);
    expect(rules.isSaveCancelled({ name: 'AbortError' })).toBe(true);
    expect(rules.isSaveCancelled({ message: 'User cancelled the picker' })).toBe(true);
    expect(rules.isSaveCancelled({ status: 401 })).toBe(false);
    expect(rules.isSaveCancelled(null)).toBe(false);
  });
  test('Android 10+: straight into public Downloads through the native module, no folder picker; the notification only after the save; the temporary copy is removed', () => {
    expect(save).toContain('HumancareDownloads.saveToDownloads(temp.uri, wanted, mime)');
    expect(save.indexOf('saveToDownloads(')).toBeLessThan(save.indexOf('notifyDownloadComplete('));
    expect(save).toContain('if (canNotify) {');
    expect(save).toContain('temp.dispose();');
    expect(save).not.toMatch(/pickDirectoryAsync|Sharing|shareAsync|shareDocumentFile/); // no picker, no share sheet
    expect(save).toContain('fetchDocumentFile(id, name, onProgress)'); // the sign-in and its renewal are the existing ones
  });
  test('the notification permission is asked for on Android 13+ (a channel first), and a refusal falls back to the in-app message', () => {
    expect(save).toContain('HumancareDownloads.ensureChannel(channelName)');
    expect(save).toContain('Notifications.requestPermissionsAsync()');
    expect(save).toContain('if (current.canAskAgain === false) return false;');
    expect(read('../../app/my-documents.js')).toContain('else if (!saved.notified) setDone(');
  });
  test('iOS, Android 9 and older, and a build without the module: the own persistent storage of the app (Documents/Downloads), numbered names, no promise of a public folder', () => {
    expect(save).toContain("new Directory(Paths.document, 'Downloads')");
    expect(save).toContain('uniqueName(wanted, taken)');
    expect(save).toContain("location: 'app'");
    expect(save).toContain('if (!publicDownloads) return await saveInsideApp(temp, wanted, mime);');
    expect(save).toContain("a.download = wanted;"); // the web
  });
  test('Open: public Downloads opens in the installed viewer (a message when there is none); the app copy opens in the app preview as the saved file', () => {
    const screen2 = read('../../app/my-documents.js');
    expect(screen2).toContain("if (!(await openSavedDownload(saved))) toast(t('docs_no_viewer'));");
    expect(screen2).toContain("params: { id: String(doc.id), name: saved.name, localUri: saved.uri }");
    expect(read('../../app/document-preview.js')).toContain("const localUri = first(params.localUri) || '';");
  });
  test('a save that fails has its own message in every language, and so do the new texts', () => {
    expect(read('../download.js')).toContain("if (code === 'save_failed') return { key: 'docs_err_save' };");
    expect(save).toContain("code: 'save_failed'");
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of ['docs_saved', 'docs_err_save', 'docs_dl_title', 'docs_dl_complete', 'docs_open', 'docs_no_viewer', 'docs_dismiss']) expect({ lang, key, ok: typeof i18n[lang][key] === 'string' && i18n[lang][key].length > 1 }).toEqual({ lang, key, ok: true });
    expect(i18n.EN.docs_saved).toContain('{name}');
  });
  test('the in-app message shows the file name, "Download complete" and an OPEN button, and can be dismissed', () => {
    const banner = read('../../components/documents/DownloadDone.js');
    expect(banner).toContain('{done.name}');
    expect(banner).toContain("t('docs_dl_complete')");
    expect(banner).toContain('onPress={done.onOpen}');
    expect(banner).toContain('onPress={onDismiss}');
  });
  test('the Android native module: MediaStore.Downloads, marked finished only after writing, removed on failure, an OPEN action, only when allowed', () => {
    const kt = fs.readFileSync(path.join(__dirname, '../../../modules/humancare-downloads/android/src/main/java/expo/modules/humancaredownloads/HumancareDownloadsModule.kt'), 'utf8');
    expect(kt).toContain('MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)');
    expect(kt).toContain('Environment.DIRECTORY_DOWNLOADS');
    expect(kt.indexOf('IS_PENDING, 1')).toBeLessThan(kt.indexOf('IS_PENDING, 0'));
    expect(kt).toContain('resolver.delete(uri, null, null)');
    expect(kt).toContain('areNotificationsEnabled()');
    expect(kt).toContain('FLAG_GRANT_READ_URI_PERMISSION');
    expect(kt).toContain('builder.addAction(');
    expect(kt).toContain('setAutoCancel(true)');
    expect(JSON.parse(fs.readFileSync(path.join(__dirname, '../../../modules/humancare-downloads/expo-module.config.json'), 'utf8')).platforms).toEqual(['android']);
  });
  test('long names wrap inside the text column and cannot run under the download button', () => {
    const card2 = read('../../components/documents/DocumentCard.js');
    expect(card2).toContain('style={{ minWidth: 0 }}');
    expect(card2).toContain('numberOfLines={offline ? 1 : 3}');
  });
});
