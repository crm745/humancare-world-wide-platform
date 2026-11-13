/* global describe, test, expect, jest, beforeEach, afterEach */
// My Documents, Group 1: the temporary copy is removed after sharing (Fix 1), file names are made safe (Fix 2) and a
// download error is always one of our own messages (Fix 3). Platform, file system, sharing and apiDownload are fakes.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
let mockCacheDirectory = 'file:///cache/';
jest.mock('expo-file-system/legacy', () => ({
  get cacheDirectory() { return mockCacheDirectory; }, downloadAsync: jest.fn(), deleteAsync: jest.fn(), readDirectoryAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('../session', () => ({ getAccessToken: jest.fn() }));
jest.mock('../api', () => ({ apiDownload: jest.fn() }));

const { Platform } = require('react-native');
const FileSystem = require('expo-file-system/legacy');
const Sharing = require('expo-sharing');
const { apiDownload } = require('../api');
const {
  downloadDocument, safeDownloadName, downloadErrorInfo, removeDownloadedFile, removeStaleDownloads, STALE_DOWNLOAD_MS, ANDROID_REMOVE_DELAY_MS,
} = require('../download');

beforeEach(() => {
  jest.clearAllMocks();
  apiDownload.mockReset();
  mockCacheDirectory = 'file:///cache/';
  Platform.OS = 'ios';
  Sharing.isAvailableAsync.mockResolvedValue(true);
  Sharing.shareAsync.mockResolvedValue(undefined);
  FileSystem.deleteAsync.mockReset();
  FileSystem.deleteAsync.mockResolvedValue(undefined);
  FileSystem.readDirectoryAsync.mockReset();
  FileSystem.readDirectoryAsync.mockResolvedValue([]);
});

const fromCodes = (...codes) => String.fromCharCode(...codes);

// ---- Fix 2 --------------------------------------------------------------------------------------------------------
describe('safeDownloadName: malicious and misleading Unicode', () => {
  test('every bidirectional control is removed, so a name cannot be shown back to front', () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
      expect(safeDownloadName(`invoice${fromCodes(code)}fdp.exe`)).toBe('invoicefdp.exe');
    }
    expect(safeDownloadName(`photo${fromCodes(0x202e)}gpj.exe`)).not.toContain(fromCodes(0x202e));
  });
  test('zero-width, invisible and format characters, the soft hyphen, the BOM and C0/C1 controls are removed', () => {
    for (const code of [0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x00ad, 0x180e, 0x2028, 0x2029, 0x0085, 0x009f, 0x007f, 0x0000, 0x001f]) {
      expect(safeDownloadName(`re${fromCodes(code)}port.pdf`)).toBe('report.pdf');
    }
    expect(safeDownloadName(`re${String.fromCodePoint(0xe0041)}port.pdf`)).toBe('report.pdf'); // a tag character
  });
  test('unusual spaces become one ordinary space', () => {
    expect(safeDownloadName(`blood${fromCodes(0xa0, 0x2003, 0x20, 0x3000)}report.pdf`)).toBe('blood report.pdf');
  });
  test('a joiner stays inside a word (real spelling in Indic and Arabic-script names) but cannot hide a dot', () => {
    const zwj = fromCodes(0x200d);
    const zwnj = fromCodes(0x200c);
    const hindi = `${fromCodes(0x915, 0x94d)}${zwj}${fromCodes(0x937)} report.pdf`;
    expect(safeDownloadName(hindi)).toBe(hindi);
    const persian = `${fromCodes(0x645, 0x6cc)}${zwnj}${fromCodes(0x62e, 0x648, 0x627, 0x647, 0x645)}.pdf`;
    expect(safeDownloadName(persian)).toBe(persian);
    expect(safeDownloadName(`scan.${zwj}exe`)).toBe('scan.exe');
    expect(safeDownloadName(`scan${zwnj}.pdf`)).toBe('scan.pdf');
    expect(safeDownloadName(`${zwj}${zwnj}scan.pdf${zwj}`)).toBe('scan.pdf');
  });
  test('a name in another script and emoji are kept', () => {
    const marathi = `${fromCodes(0x92e, 0x947, 0x921, 0x93f, 0x915, 0x932)} report.pdf`;
    expect(safeDownloadName(marathi)).toBe(marathi);
    expect(safeDownloadName('scan \u{1F642}.png')).toBe('scan \u{1F642}.png');
  });
});

describe('safeDownloadName: dots, spaces and extensions', () => {
  test('a name that is only an extension keeps it', () => {
    expect(safeDownloadName('.pdf')).toBe('document.pdf');
    expect(safeDownloadName('....pdf')).toBe('document.pdf');
    expect(safeDownloadName(' . .jpeg')).toBe('document.jpeg');
    expect(safeDownloadName('.docx')).toBe('document.docx');
  });
  test('leading dots and spaces go, a hidden-file name loses its dot', () => {
    expect(safeDownloadName('  ..report.pdf')).toBe('report.pdf');
    expect(safeDownloadName('..hidden')).toBe('hidden');
  });
  test('trailing dots and spaces go', () => {
    expect(safeDownloadName('report.pdf.')).toBe('report.pdf');
    expect(safeDownloadName('report.pdf ...  ')).toBe('report.pdf');
    expect(safeDownloadName('report   ')).toBe('report');
  });
  test('a space before the dot of the extension is closed up, and runs of spaces become one', () => {
    expect(safeDownloadName('report .pdf')).toBe('report.pdf');
    expect(safeDownloadName('blood   test   result.pdf')).toBe('blood test result.pdf');
  });
  test('a double extension is left as it is (it is only a name; the type is never trusted)', () => {
    expect(safeDownloadName('scan.pdf.exe')).toBe('scan.pdf.exe');
  });
  test('device names Windows reserves are made ordinary, ordinary names that start the same way are not', () => {
    for (const name of ['CON', 'nul.txt', 'Com1.pdf', 'LPT9']) expect(safeDownloadName(name)).toMatch(/^_/);
    expect(safeDownloadName('console.pdf')).toBe('console.pdf');
    expect(safeDownloadName('nullable.pdf')).toBe('nullable.pdf');
  });
  test('names with nothing usable get the neutral name', () => {
    const invisible = fromCodes(0x202e, 0x200b, 0xfeff, 0);
    for (const v of ['', '   ', '...', ' . . ', invisible, null, undefined]) expect(safeDownloadName(v)).toBe('document');
  });
});

describe('safeDownloadName: path traversal and length', () => {
  test('traversal in every form leaves no separator, no colon, no ".." and no leading dot', () => {
    const BS = fromCodes(92);
    for (const name of ['../../etc/passwd', `..${BS}..${BS}windows${BS}system32`, 'a/../../b.pdf', '%2e%2e/x', '....//....//x', '/etc/passwd', `C:${BS}x${BS}y.pdf`, `${BS}${BS}server${BS}share${BS}f.pdf`]) {
      const out = safeDownloadName(name);
      expect(out).not.toMatch(/[\\/:]/);
      expect(out).not.toContain('..');
      expect(out.startsWith('.')).toBe(false);
    }
  });
  test('the 100-character limit is kept for every kind of name, with a short extension', () => {
    for (const name of [`${'a'.repeat(300)}.pdf`, `${'b'.repeat(99)}.jpeg`, 'c'.repeat(250), `${'d'.repeat(200)}.${'e'.repeat(30)}`, `${fromCodes(0x92e).repeat(150)}.pdf`]) {
      expect(safeDownloadName(name).length).toBeLessThanOrEqual(100);
    }
    expect(safeDownloadName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf')).toBe(true);
    expect(safeDownloadName('x'.repeat(300))).toHaveLength(100);
  });
  test('a cut never leaves half an emoji, and never ends the base with a dot or space', () => {
    for (let prefix = 0; prefix < 3; prefix += 1) {
      const out = safeDownloadName(`${'a'.repeat(prefix)}${'\u{1F642}'.repeat(80)}.pdf`);
      expect(out.length).toBeLessThanOrEqual(100);
      expect(out.endsWith('.pdf')).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
    }
    expect(safeDownloadName(`${'a'.repeat(90)}. . . . . . . . . . . .pdf`)).toMatch(/[^. ]\.pdf$/);
  });
  test('sanitising a sanitised name changes nothing', () => {
    for (const name of ['../../x/y:z.pdf', `inv${fromCodes(0x202e)}fdp.exe`, '.pdf', 'report .pdf', 'CON', `${'a'.repeat(300)}.pdf`]) {
      const once = safeDownloadName(name);
      expect(safeDownloadName(once)).toBe(once);
    }
  });
});

// ---- Fix 3 --------------------------------------------------------------------------------------------------------
describe('downloadErrorInfo: the server codes of the API contract', () => {
  test.each([
    ['document_not_clean', 409, 'docs_err_blocked'], ['file_changed', 409, 'docs_err_unverified'], ['checksum_missing', 409, 'docs_err_unverified'],
    ['not_verified', 409, 'docs_err_unverified'], ['file_missing', 404, 'docs_err_missing'],
  ])('%s (HTTP %i) gives %s', (code, status, key) => {
    expect(downloadErrorInfo({ code, status, message: 'English text from the server' })).toEqual({ key });
  });
  test('a code decides before the status', () => {
    expect(downloadErrorInfo({ code: 'file_changed', status: 500 }).key).toBe('docs_err_unverified');
    expect(downloadErrorInfo({ code: 'document_not_clean', status: 404 }).key).toBe('docs_err_blocked');
  });
  test('403 is "no access"; 404 "no longer available"; 409 without a known code "cannot be opened yet"', () => {
    expect(downloadErrorInfo({ status: 403 }).key).toBe('docs_err_denied');
    expect(downloadErrorInfo({ status: 404 }).key).toBe('docs_err_missing');
    expect(downloadErrorInfo({ status: 409 }).key).toBe('docs_err_blocked');
  });
  test('a 409 with an unknown code is still ours: the server sentence is never part of the answer', () => {
    const info = downloadErrorInfo({ status: 409, code: 'something_new', message: 'This document has not passed its virus scan and approval, so it will not be opened.' });
    expect(info).toEqual({ key: 'docs_err_blocked' });
    expect(JSON.stringify(info)).not.toContain('virus');
  });
  test('an unknown code or status, an internal message and a prototype name are "generic" and leak nothing', () => {
    for (const err of [{ status: 500, message: 'ECONNRESET at db.js:44' }, { code: 'toString' }, { code: '__proto__' }, { code: 'constructor', status: 418 }, { status: 429 }]) {
      expect(downloadErrorInfo(err)).toEqual({ key: 'docs_err_generic' });
    }
  });
  test('the session, the network and sharing keep their own messages', () => {
    expect(downloadErrorInfo({ status: 401, code: 'file_changed' }).key).toBe('docs_err_session');
    expect(downloadErrorInfo({ code: 'network' }).key).toBe('docs_err_network');
    expect(downloadErrorInfo({ code: 'share_unavailable' })).toEqual({ key: 'docs_err_share' });
  });
  test('the answer only ever has a key (no server message, no flag)', () => {
    for (const err of [null, {}, { status: 409, message: 'x' }, { code: 'share_unavailable' }, { code: 'file_changed' }]) expect(Object.keys(downloadErrorInfo(err))).toEqual(['key']);
  });
});

// ---- Fix 1 --------------------------------------------------------------------------------------------------------
describe('the temporary copy is removed after sharing', () => {
  const copyUri = () => apiDownload.mock.calls[0][1].destination;
  beforeEach(() => {
    jest.useFakeTimers();
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
  });
  afterEach(() => { jest.useRealTimers(); });

  test('iOS: removed right after the share sheet is gone, and not before', async () => {
    const order = [];
    Sharing.shareAsync.mockImplementation(async () => { order.push('shared'); });
    FileSystem.deleteAsync.mockImplementation(async () => { order.push('deleted'); });
    await downloadDocument('/documents/7/file', 'a.pdf');
    expect(order).toEqual(['shared', 'deleted']);
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(copyUri(), { idempotent: true });
  });
  test('iOS: the copy is not removed while the share sheet is still open', async () => {
    let closeSheet;
    Sharing.shareAsync.mockImplementation(() => new Promise((resolve) => { closeSheet = resolve; }));
    const pending = downloadDocument('/documents/7/file', 'a.pdf');
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    closeSheet();
    await pending;
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });
  test('a share that fails removes the copy at once, on both platforms, and the error still reaches the caller', async () => {
    for (const os of ['ios', 'android']) {
      jest.clearAllMocks();
      FileSystem.deleteAsync.mockResolvedValue(undefined);
      FileSystem.readDirectoryAsync.mockResolvedValue([]);
      Platform.OS = os;
      const failure = new Error('Failed to share the file');
      Sharing.shareAsync.mockRejectedValue(failure);
      await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toBe(failure);
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(copyUri(), { idempotent: true });
    }
  });
  test('without a share sheet the copy is removed and the error is ours', async () => {
    Sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toMatchObject({ code: 'share_unavailable' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(copyUri(), { idempotent: true });
  });
  test('a share the person cancels (the sheet just closes) is removed like a finished one', async () => {
    Sharing.shareAsync.mockResolvedValue(undefined);
    await downloadDocument('/documents/7/file', 'a.pdf');
    expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(1);
  });
  test('Android: the copy stays while the chosen app may still be reading it, then is removed', async () => {
    Platform.OS = 'android';
    await downloadDocument('/documents/7/file', 'a.pdf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    jest.advanceTimersByTime(ANDROID_REMOVE_DELAY_MS - 1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(copyUri(), { idempotent: true });
  });
  test('a clean-up that fails does not turn a finished share into an error (iOS now, Android later)', async () => {
    FileSystem.deleteAsync.mockRejectedValue(new Error('EBUSY'));
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).resolves.toEqual({ saved: true });
    Platform.OS = 'android';
    await expect(downloadDocument('/documents/7/file', 'b.pdf')).resolves.toEqual({ saved: true });
    jest.advanceTimersByTime(ANDROID_REMOVE_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
  test('a failed download has no copy to clean: nothing is shared and nothing is deleted by this code', async () => {
    apiDownload.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'document_not_clean' }));
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toMatchObject({ code: 'document_not_clean' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });
  test('web: nothing is written to the phone, so nothing is removed', async () => {
    Platform.OS = 'web';
    const anchor = { click: jest.fn(), remove: jest.fn() };
    global.window = { URL: { createObjectURL: jest.fn(() => 'blob:x'), revokeObjectURL: jest.fn() } };
    global.document = { createElement: jest.fn(() => anchor), body: { appendChild: jest.fn() } };
    apiDownload.mockResolvedValue({ blob: new Blob(['x']) });
    await downloadDocument('/documents/7/file', 'a.pdf');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(FileSystem.readDirectoryAsync).not.toHaveBeenCalled();
  });
});

describe('only our own copies are ever deleted', () => {
  const now = 1800000000000;
  test('removeDownloadedFile refuses anything that is not hcdoc-<time>-<name> directly in the cache folder', async () => {
    for (const uri of ['file:///cache/photo.jpg', 'file:///cache/hcdoc-12-a.pdf', 'file:///cache/sub/hcdoc-1800000000000-a.pdf', 'file:///other/hcdoc-1800000000000-a.pdf',
      'file:///cache/hcdoc-1800000000000-', 'file:///cache/', 'file:///cache/hcdoc-1800000000000-../x', '', null, undefined, 42]) {
      expect(await removeDownloadedFile(uri)).toBe(false);
    }
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
    expect(await removeDownloadedFile(`file:///cache/hcdoc-${now}-a.pdf`)).toBe(true);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`file:///cache/hcdoc-${now}-a.pdf`, { idempotent: true });
  });
  test('without a cache folder nothing is deleted', async () => {
    mockCacheDirectory = null;
    expect(await removeDownloadedFile('file:///cache/hcdoc-1800000000000-a.pdf')).toBe(false);
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });
  test('a delete that fails is reported as false, not thrown', async () => {
    FileSystem.deleteAsync.mockRejectedValue(new Error('EACCES'));
    expect(await removeDownloadedFile(`file:///cache/hcdoc-${now}-a.pdf`)).toBe(false);
  });
  test('the sweep removes only our own copies older than the limit', async () => {
    FileSystem.readDirectoryAsync.mockResolvedValue([
      `hcdoc-${now - STALE_DOWNLOAD_MS - 1}-old.pdf`, `hcdoc-${now - STALE_DOWNLOAD_MS + 5000}-recent.pdf`, `hcdoc-${now}-new.pdf`,
      'photo.jpg', 'hcdoc-notatime-x.pdf', 'ExponentExperienceData', `hcdoc-${now - STALE_DOWNLOAD_MS - 1}`,
    ]);
    await removeStaleDownloads(now);
    expect(FileSystem.deleteAsync.mock.calls.map((c) => c[0])).toEqual([`file:///cache/hcdoc-${now - STALE_DOWNLOAD_MS - 1}-old.pdf`]);
  });
  test('a sweep that cannot read the folder, or cannot delete, does nothing and does not throw', async () => {
    FileSystem.readDirectoryAsync.mockRejectedValue(new Error('ENOENT'));
    await expect(removeStaleDownloads(now)).resolves.toBeUndefined();
    FileSystem.readDirectoryAsync.mockResolvedValue([`hcdoc-${now - STALE_DOWNLOAD_MS - 1}-old.pdf`]);
    FileSystem.deleteAsync.mockRejectedValue(new Error('EBUSY'));
    await expect(removeStaleDownloads(now)).resolves.toBeUndefined();
  });
  test('a download first sweeps earlier leftovers, and a failing sweep does not stop it', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    FileSystem.readDirectoryAsync.mockRejectedValue(new Error('ENOENT'));
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).resolves.toEqual({ saved: true });
    expect(FileSystem.readDirectoryAsync).toHaveBeenCalledTimes(1);
  });
});
