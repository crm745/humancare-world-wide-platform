/* global describe, test, expect, jest, beforeEach, afterAll, __dirname */
// download.js: the new downloadDocument (My Documents) and, unchanged, downloadAndShare (Request Details' summary and the
// corporate tracking page). The platform, file system, sharing, session and apiDownload are fakes.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
let mockCacheDirectory = 'file:///cache/';
jest.mock('expo-file-system/legacy', () => ({
  get cacheDirectory() { return mockCacheDirectory; }, downloadAsync: jest.fn(), deleteAsync: jest.fn(), readDirectoryAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('../session', () => ({ getAccessToken: jest.fn() }));
jest.mock('../api', () => ({ apiDownload: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { Platform } = require('react-native');
const FileSystem = require('expo-file-system/legacy');
const Sharing = require('expo-sharing');
const session = require('../session');
const { apiDownload } = require('../api');
const { downloadAndShare, downloadDocument, safeDownloadName, downloadErrorInfo } = require('../download');

const realFetch = global.fetch;
let anchor;
beforeEach(() => {
  jest.clearAllMocks();
  apiDownload.mockReset();
  Platform.OS = 'web';
  mockCacheDirectory = 'file:///cache/';
  anchor = { click: jest.fn(), remove: jest.fn() };
  global.window = { URL: { createObjectURL: jest.fn(() => 'blob:x'), revokeObjectURL: jest.fn() } };
  global.document = { createElement: jest.fn(() => anchor), body: { appendChild: jest.fn() } };
  session.getAccessToken.mockResolvedValue('tok');
  Sharing.isAvailableAsync.mockResolvedValue(true);
  global.fetch = jest.fn();
  FileSystem.deleteAsync.mockResolvedValue(undefined);
  FileSystem.readDirectoryAsync.mockResolvedValue([]);
});
afterAll(() => { global.fetch = realFetch; });

describe('safeDownloadName', () => {
  test('keeps an ordinary name', () => {
    expect(safeDownloadName('Blood report (final).pdf')).toBe('Blood report (final).pdf');
  });
  test('removes path separators, "..", control characters and characters a file system refuses', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('_._etc_passwd');
    expect(safeDownloadName('a\\b/c:d*e?f"g<h>i|j.pdf')).toBe('a_b_c_d_e_f_g_h_i_j.pdf');
    expect(safeDownloadName('re\u0000po\u001frt.pdf')).toBe('report.pdf');
    expect(safeDownloadName('..hidden')).toBe('hidden');
    expect(safeDownloadName('scan..pdf')).toBe('scan.pdf');
  });
  test('an empty or missing name gets a neutral one', () => {
    for (const v of ['', '   ', null, undefined, '...', '///']) expect(safeDownloadName(v)).toMatch(/^(document|_+)$/);
  });
  test('a very long name is shortened to 100 characters, keeping its extension', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const out = safeDownloadName(long);
    expect(out).toHaveLength(100);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  test('the result never contains a separator', () => {
    for (const name of ['a/b', 'a\\b', '/abs/path.pdf', 'C:\\Windows\\x.pdf']) expect(safeDownloadName(name)).not.toMatch(/[\\/]/);
  });
});

describe('downloadErrorInfo (what to tell the person)', () => {
  test.each([
    [{ code: 'session_expired' }, 'docs_err_session'], [{ code: 'not_signed_in' }, 'docs_err_session'],
    [{ code: 'session_unverified' }, 'docs_err_session'], [{ status: 401 }, 'docs_err_session'],
    [{ status: 404 }, 'docs_err_missing'], [{ code: 'network' }, 'docs_err_network'],
    [{ name: 'TypeError' }, 'docs_err_network'], [{ status: 500 }, 'docs_err_generic'], [{}, 'docs_err_generic'], [null, 'docs_err_generic'],
  ])('%j', (err, key) => {
    expect(downloadErrorInfo(err).key).toBe(key);
  });
  test('a refusal by the server (409) is our own message, never the server\'s English sentence', () => {
    expect(downloadErrorInfo({ status: 409, message: 'This document has not passed its virus scan and approval, so it will not be opened.' }))
      .toEqual({ key: 'docs_err_blocked' });
  });
  test('"cannot share" is a failure of ours (see documentDownloadSafety.test.js for the codes and the clean-up)', () => {
    expect(downloadErrorInfo({ code: 'share_unavailable' })).toEqual({ key: 'docs_err_share' });
  });
});

describe('downloadDocument on web', () => {
  test('downloads through apiDownload (the shared session handling) and saves it under a safe name', async () => {
    apiDownload.mockResolvedValue({ blob: new Blob(['x']) });
    const onProgress = jest.fn();
    await expect(downloadDocument('/documents/7/file', 'my/report.pdf', { onProgress })).resolves.toEqual({ saved: true });
    expect(apiDownload).toHaveBeenCalledWith('/documents/7/file', { onProgress });
    expect(anchor.download).toBe('my_report.pdf');
    expect(anchor.href).toBe('blob:x');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(global.window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
  test('a failure from apiDownload is passed on untouched, and nothing is saved', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    apiDownload.mockRejectedValue(err);
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toBe(err);
    expect(anchor.click).not.toHaveBeenCalled();
  });
});

describe('downloadDocument on a phone', () => {
  beforeEach(() => { Platform.OS = 'ios'; });

  test('writes to a safe, unique name in the cache and opens the share sheet', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    await downloadDocument('/documents/7/file', '../../x/y:z.pdf', {});
    const { destination } = apiDownload.mock.calls[0][1];
    expect(destination).toMatch(/^file:\/\/\/cache\/hcdoc-\d{13}-_\._x_y_z\.pdf$/);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(destination);
  });
  test('without a share sheet the person gets an error (the copy is removed: see documentDownloadSafety.test.js)', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    Sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toMatchObject({ code: 'share_unavailable' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
  test('a failed download opens nothing', async () => {
    apiDownload.mockRejectedValue(Object.assign(new Error('x'), { code: 'network' }));
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toMatchObject({ code: 'network' });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });
  test('no cache folder: a clear failure, and nothing is requested', async () => {
    mockCacheDirectory = null;
    await expect(downloadDocument('/documents/7/file', 'a.pdf')).rejects.toThrow('Download failed');
    expect(apiDownload).not.toHaveBeenCalled();
  });
});

describe('downloadAndShare is unchanged (Request Details, corporate tracking)', () => {
  test('web: still a plain authenticated fetch with the saved token; apiDownload is not involved', async () => {
    global.fetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    await downloadAndShare('/requests/me/5/summary', 'REQ-1005-summary.pdf');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/requests\/me\/5\/summary$/), { headers: { Authorization: 'Bearer tok' } });
    expect(anchor.download).toBe('REQ-1005-summary.pdf');
    expect(apiDownload).not.toHaveBeenCalled();
  });
  test('web: a failed answer is still the plain "Download failed."', async () => {
    global.fetch.mockResolvedValue({ ok: false });
    await expect(downloadAndShare('/x', 'a.pdf')).rejects.toThrow('Download failed.');
  });
  test('phone: still downloads into the cache with the token and shares', async () => {
    Platform.OS = 'ios';
    FileSystem.downloadAsync.mockResolvedValue({ uri: 'file:///cache/a.pdf', status: 200 });
    await downloadAndShare('/x', 'a.pdf');
    expect(FileSystem.downloadAsync).toHaveBeenCalledWith(expect.stringMatching(/\/x$/), 'file:///cache/a.pdf', { headers: { Authorization: 'Bearer tok' } });
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/a.pdf');
  });
  test('its source is the code it was before this change (the new code is only added after it)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../download.js'), 'utf8');
    const original = source.slice(source.indexOf('export async function downloadAndShare'), source.indexOf('// ---- documents:'));
    expect(original).toContain("const token = await getAccessToken();");
    expect(original).toContain("if (!res.ok) throw new Error('Download failed.');");
    expect(original).toContain("if (status !== 200) throw new Error('Download failed.');");
    expect(original).not.toMatch(/apiDownload/);
  });
});
