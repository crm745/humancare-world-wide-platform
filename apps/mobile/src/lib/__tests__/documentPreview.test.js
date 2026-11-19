/* global describe, test, expect, jest, beforeEach, __dirname */
// Tapping a document opens the in-app preview; the share sheet opens ONLY from the preview's Share button. Fakes stand in for the phone, the
// file system, the share sheet and the backend: these tests prove the app's logic, not a real Android device (see the report).
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
let mockCache = 'file:///cache/';
jest.mock('expo-file-system/legacy', () => ({ get cacheDirectory() { return mockCache; }, deleteAsync: jest.fn(), readDirectoryAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('../api', () => ({ apiDownload: jest.fn() }));
jest.mock('../download', () => ({
  removeDownloadedFile: jest.fn(async () => true), removeStaleDownloads: jest.fn(async () => {}), safeDownloadName: (n) => String(n || 'document'),
}));

const fs = require('fs');
const path = require('path');
const { Platform } = require('react-native');
const Sharing = require('expo-sharing');
const { apiDownload } = require('../api');
const download = require('../download');
const preview = require('../documentPreview');
const { fetchDocumentFile, shareDocumentFile } = require('../documentFile');
const { systemBackAction } = require('../systemBack');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').split('\r\n').join('\n');
const code = (rel) => read(rel).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  mockCache = 'file:///cache/';
  Sharing.isAvailableAsync.mockResolvedValue(true);
});

describe('which files are previewed (image and PDF), and which are not', () => {
  test.each([
    ['scan.jpg', 'image'], ['scan.JPEG', 'image'], ['report.png', 'image'], ['photo.webp', 'image'], ['anim.gif', 'image'], ['summary.pdf', 'pdf'], ['SUMMARY.PDF', 'pdf'],
    ['letter.docx', 'unsupported'], ['letter.doc', 'unsupported'], ['notes.txt', 'unsupported'], ['archive.zip', 'unsupported'], ['scan.heic', 'unsupported'], ['noextension', 'unsupported'], ['', 'unsupported'],
  ])('%s is %s', (name, kind) => expect(preview.previewKind(name)).toBe(kind));
  test('a name without an extension falls back to the mime type', () => {
    expect(preview.previewKind('scan', 'image/png')).toBe('image');
    expect(preview.previewKind('scan', 'application/pdf')).toBe('pdf');
    expect(preview.previewKind('scan', 'application/zip')).toBe('unsupported');
    expect(preview.previewKind('scan.docx', 'application/pdf')).toBe('unsupported'); // the name wins
  });
  test('the type handed to the viewer and to the share sheet', () => {
    expect(preview.mimeTypeFor('a.pdf')).toBe('application/pdf');
    expect(preview.mimeTypeFor('a.jpg')).toBe('image/jpeg');
    expect(preview.mimeTypeFor('a.png')).toBe('image/png');
    expect(preview.mimeTypeFor('a.docx')).toBe('application/octet-stream');
  });
});

describe('1-2. a tap opens the preview (Request Details and My Documents use the same function)', () => {
  test('it pushes the preview route with the document id and name, and nothing else', () => {
    const push = jest.fn();
    const guard = preview.createTapGuard(() => 1000);
    expect(preview.openDocumentPreview(push, { id: 42, name: 'scan.png' }, guard)).toBe(true);
    expect(push).toHaveBeenCalledWith({ pathname: '/document-preview', params: { id: '42', name: 'scan.png' } });
  });
  test('no link, token or signed address travels in the route', () => {
    const target = preview.previewTarget({ id: 1, name: 'a.pdf', fileUrl: 'https://private.example/x?sig=SECRET', token: 'T' });
    expect(Object.keys(target.params).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(target)).not.toMatch(/SECRET|private\.example|token/i);
  });
  test('a document with no id opens nothing', () => {
    const push = jest.fn();
    [null, undefined, {}, { id: '' }, { id: '  ' }].forEach((doc) => expect(preview.openDocumentPreview(push, doc, preview.createTapGuard())).toBe(false));
    expect(push).not.toHaveBeenCalled();
  });
  test('both screens call it', () => {
    expect(read('app/request-details.js')).toContain('onOpen={() => openDocumentPreview(router.push, doc)}');
    expect(read('app/my-documents.js')).toContain('openDocumentPreview(router.push, doc)');
  });
  test('9. and neither screen can reach the share sheet: no Sharing, no Share.share for a document, no download-and-share', () => {
    const documents = code('app/my-documents.js');
    expect(documents).not.toMatch(/Sharing|shareAsync|Share\.share|downloadDocument|downloadAndShare|openDocument\(/);
    const details = code('app/request-details.js').replace(/const shareRequest[\s\S]*?\n {2}};\n/, ''); // the request's own "Share" action is a different feature
    expect(details).not.toMatch(/Sharing\.|shareAsync|downloadDocument/);
    expect(details).not.toMatch(/openDocument\(`/);
    expect(code('lib/documentPreview.js')).not.toMatch(/Sharing|shareAsync|Share\.share/);
  });
  test('a double tap opens ONE preview (the same tap), a later tap opens another', () => {
    let clock = 1000;
    const guard = preview.createTapGuard(() => clock);
    const push = jest.fn();
    expect(preview.openDocumentPreview(push, { id: 1, name: 'a.png' }, guard)).toBe(true);
    clock += 100;
    expect(preview.openDocumentPreview(push, { id: 1, name: 'a.png' }, guard)).toBe(false);
    clock += preview.DOUBLE_TAP_MS;
    expect(preview.openDocumentPreview(push, { id: 1, name: 'a.png' }, guard)).toBe(true);
    expect(push).toHaveBeenCalledTimes(2);
  });
});

describe('3-4. image and PDF: the file is fetched securely, then shown', () => {
  test('on a phone: from GET /documents/:id/file with the sign-in (apiDownload), into the app\'s own cache, in the only name download.js ever deletes', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    const onProgress = jest.fn();
    const file = await fetchDocumentFile(42, 'scan.png', onProgress);
    const [requestPath, options] = apiDownload.mock.calls[0];
    expect(requestPath).toBe('/documents/42/file');
    expect(options.destination).toMatch(/^file:\/\/\/cache\/hcdoc-\d{13}-scan\.png$/);
    expect(options.onProgress).toBe(onProgress);
    expect(file.uri).toBe(options.destination);
    expect(download.removeStaleDownloads).toHaveBeenCalled();
  });
  test('the temporary copy is removed when the preview closes', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    const file = await fetchDocumentFile(1, 'a.pdf');
    file.dispose();
    expect(download.removeDownloadedFile).toHaveBeenCalledWith(file.uri);
  });
  test('on the web: the file is a blob with the right type (so the browser shows it), released when the preview closes', async () => {
    Platform.OS = 'web';
    const urls = { createObjectURL: jest.fn(() => 'blob:shown'), revokeObjectURL: jest.fn() };
    global.window = { URL: urls };
    global.Blob = class { constructor(parts, o) { this.type = (o && o.type) || ''; } };
    apiDownload.mockResolvedValue({ blob: { type: 'application/octet-stream' } });
    const file = await fetchDocumentFile(7, 'summary.pdf');
    expect(urls.createObjectURL.mock.calls[0][0].type).toBe('application/pdf');
    file.dispose();
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:shown');
  });
  test('the backend decides who may read the file: a refusal (403/404/409) is thrown as it is, so the preview shows our message for it', async () => {
    const refusal = Object.assign(new Error('x'), { status: 403 });
    apiDownload.mockRejectedValue(refusal);
    await expect(fetchDocumentFile(1, 'a.png')).rejects.toBe(refusal);
  });
  test('no address, token or document data is logged anywhere in the preview code', () => {
    ['lib/documentFile.js', 'lib/useDocumentFile.js', 'lib/documentPreview.js', 'app/document-preview.js', 'components/documents/PdfViewer.js'].forEach((f) => {
      expect(code(f)).not.toMatch(/console\.(log|warn|error|info|debug)/);
    });
  });
  test('the preview keeps the PDF and the image inside the app: an image view, and a PDF viewer', () => {
    const screen = read('app/document-preview.js');
    expect(screen).toContain('<Image source={{ uri }} resizeMode="contain"');
    expect(screen).toContain('maximumZoomScale={4}');
    expect(screen).toContain('<PdfViewer uri={file.file.uri}');
    expect(read('components/documents/PdfViewer.js')).toContain("createElement('iframe'");
    expect(read('components/documents/PdfViewer.js')).toContain("require('react-native-pdf')");
  });
});

describe('5-6. loading, and a document that cannot be loaded', () => {
  const screen = read('app/document-preview.js');
  test('while it loads: a spinner and "Opening document…" with the percent', () => {
    expect(screen).toContain("accessibilityRole=\"progressbar\" accessibilityLabel={t('dp_loading')}");
    expect(screen).toContain('<Spinner size={30}');
    expect(screen).toContain('`${t(\'dp_loading\')} ${percent}%`');
  });
  test('when it fails: our message for the reason (never the server\'s sentence), and Try again', () => {
    expect(screen).toContain("body = (\n      <Message title={t(downloadErrorInfo(file.error).key)}>");
    expect(screen).toContain("<ActionButton label={t('docs_try_again')} onPress={() => { setBroken(false); file.retry(); }} />");
  });
  test('a file that downloaded but cannot be drawn is an error too, not a blank screen', () => {
    expect(screen).toContain('onFailed={() => setBroken(true)}');
    expect(screen).toContain("t(kind === 'image' ? 'dp_image_failed' : 'docs_err_generic')");
  });
  test('the hook: loading, then ready; an error keeps the error; Try again fetches again', () => {
    const hook = read('lib/useDocumentFile.js');
    expect(hook).toContain("setState({ status: 'loading', progress: 0, file: null, error: null });");
    expect(hook).toContain("setState({ status: 'ready', progress: 1, file, error: null });");
    expect(hook).toContain("setState({ status: 'error', progress: 0, file: null, error });");
    expect(hook).toContain('retry: () => setAttempt((n) => n + 1)');
    expect(hook).toContain('if (cancelled) { file.dispose(); return; }'); // a file that arrives after the preview closed is thrown away
  });
});

describe('7. a format that cannot be previewed', () => {
  const screen = read('app/document-preview.js');
  test('it says so, and offers Share: nothing is downloaded and the share sheet does not open by itself', () => {
    expect(screen).toContain("enabled: kind !== 'unsupported' && Boolean(id)");
    expect(screen).toContain("body = <Message title={t('dp_unsupported_title')} text={t('dp_unsupported_text')}><ActionButton label={t('dp_share')} onPress={share} busy={sharing} /></Message>;");
  });
  test('without a PDF viewer in the build (a phone build made before it was added) the PDF says so, and Share is the intentional way out', () => {
    expect(screen).toContain("body = <Message title={t('dp_unsupported_title')} text={t('dp_pdf_unavailable')} />;");
    expect(screen).toContain('const canShare = Boolean(id) && (kind === \'unsupported\' ? false : file.status === \'ready\');');
  });
});

describe('8. Share: only when the person taps it', () => {
  test('the share sheet opens for the downloaded file, with its type', async () => {
    await shareDocumentFile({ uri: 'file:///cache/hcdoc-1-a.png', name: 'a.png' });
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/hcdoc-1-a.png', { mimeType: 'image/png', dialogTitle: 'a.png' });
  });
  test('no share sheet on this phone: a clear error, nothing opens', async () => {
    Sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(shareDocumentFile({ uri: 'file:///x', name: 'a.png' })).rejects.toMatchObject({ code: 'share_unavailable' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
  test('opening a document, fetching its file and closing the preview never touch the share sheet', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    const file = await fetchDocumentFile(1, 'a.png');
    file.dispose();
    preview.openDocumentPreview(jest.fn(), { id: 1, name: 'a.png' }, preview.createTapGuard());
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(Sharing.isAvailableAsync).not.toHaveBeenCalled();
  });
  test('the preview\'s Share is a separate, labelled button, shown only when there is something to share; its press is the only caller', () => {
    const screen = read('app/document-preview.js');
    expect(screen).toContain("accessibilityRole=\"button\" accessibilityLabel={t('dp_share')} onPress={share} disabled={sharing}");
    expect(screen.match(/shareDocumentFile\(/g)).toHaveLength(1);
    expect(screen.match(/onPress=\{share\}/g)).toHaveLength(2); // the header button, and the one for a file that cannot be previewed
    expect(screen).toContain('if (sharing) return;'); // one share at a time
  });
  test('a share that is cancelled by the person is not an error', () => {
    expect(read('app/document-preview.js')).toContain("err.name === 'AbortError' || err.code === 'ERR_SHARING_CANCELLED'");
  });
  test('only the preview\'s Share and the request-summary download use the share sheet', () => {
    const users = ['app', 'components', 'lib'].flatMap((d) => {
      const walk = (dir) => fs.readdirSync(path.join(__dirname, '../..', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
      return walk(d);
    }).filter((f) => !f.includes('__tests__') && /Sharing\.shareAsync|shareAsync\(/.test(read(f)));
    expect(users.sort()).toEqual(['lib/documentFile.js', 'lib/download.js']);
  });
});

describe('10. Android back and the app\'s back button', () => {
  test('the system back pops the preview (there is a screen to go back to), never Home', () => {
    expect(systemBackAction({ pathname: '/document-preview', canGoBack: true })).toBe('default');
  });
  test('opened with nothing behind it, the app\'s own fallback applies (Home), as its back button does', () => {
    expect(systemBackAction({ pathname: '/document-preview', canGoBack: false })).toBe('home');
  });
  test('the preview\'s back button is the app\'s own goBack, and the route is pushed (history is kept)', () => {
    expect(read('app/document-preview.js')).toContain("accessibilityLabel={t('home_back')} onPress={goBack}");
    expect(read('lib/documentPreview.js')).toContain('push(target);');
  });
  test('the temporary file is released when the preview closes (the hook\'s cleanup)', () => {
    expect(read('lib/useDocumentFile.js')).toContain('if (dispose.current) { dispose.current(); dispose.current = null; }');
  });
});

describe('the rest of the app is as it was', () => {
  test('the request summary download, document upload and the download of other things are untouched', () => {
    expect(read('lib/download.js')).toContain('export async function downloadAndShare(path, filename) {');
    expect(read('lib/download.js')).toContain('export async function downloadDocument(path, filename');
    expect(read('app/request-details.js')).toContain("downloadAndShare(`/requests/me/${request.id}/summary`");
  });
  test('the preview is a protected route (signed-in only) and the floating SOS button stays off it', () => {
    expect(read('lib/authGuard.js')).not.toContain("'/document-preview'");
    expect(read('lib/sos.js')).toContain("'/document-preview',");
  });
  test('the new strings exist in all six languages', () => {
    const i18n = JSON.parse(read('data/i18n.json'));
    ['dp_loading', 'dp_share', 'dp_unsupported_title', 'dp_unsupported_text', 'dp_pdf_unavailable', 'dp_image_failed'].forEach((k) => {
      Object.keys(i18n).forEach((l) => expect(typeof i18n[l][k]).toBe('string'));
    });
  });
});
