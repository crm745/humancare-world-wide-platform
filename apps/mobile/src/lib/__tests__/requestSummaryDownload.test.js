/* global describe, test, expect, jest, beforeEach, afterAll, __dirname */
// "Download PDF" on Request Details: the summary the server builds (always English) is downloaded with the person's sign-in, handed to the phone's share sheet (or saved by the browser) under a safe
// name, and the temporary copy is removed. The button, the toasts and the file name rules, in every language. The platform, file system, sharing, session and apiDownload are fakes: no device, no network.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
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
const { apiDownload } = require('../api');
const I18N = require('../../data/i18n.json');
const { downloadDocument, downloadErrorInfo, ANDROID_REMOVE_DELAY_MS } = require('../download');

const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SUMMARY = (id) => `/requests/me/${id}/summary`;
let anchor;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  apiDownload.mockReset();
  Platform.OS = 'ios';
  mockCacheDirectory = 'file:///cache/';
  anchor = { click: jest.fn(), remove: jest.fn() };
  global.window = { URL: { createObjectURL: jest.fn(() => 'blob:summary'), revokeObjectURL: jest.fn() } };
  global.document = { createElement: jest.fn(() => anchor), body: { appendChild: jest.fn() } };
  Sharing.isAvailableAsync.mockResolvedValue(true);
  Sharing.shareAsync.mockResolvedValue(undefined);
  FileSystem.deleteAsync.mockResolvedValue(undefined);
  FileSystem.readDirectoryAsync.mockResolvedValue([]);
});
afterAll(() => { jest.useRealTimers(); });

describe('the summary is downloaded and shared on a phone', () => {
  test('iOS: the PDF is fetched from the summary endpoint into a uniquely named cache file, the share sheet opens once on it, and the copy is removed straight after', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    await downloadDocument(SUMMARY(5), 'REQ-1042-summary.pdf');
    expect(apiDownload).toHaveBeenCalledTimes(1);
    expect(apiDownload.mock.calls[0][0]).toBe('/requests/me/5/summary');
    const { destination } = apiDownload.mock.calls[0][1];
    expect(destination).toMatch(/^file:\/\/\/cache\/hcdoc-\d{13}-REQ-1042-summary\.pdf$/);
    expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(destination);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(destination, { idempotent: true });
  });
  test('Android: the share sheet returns as soon as an app is picked, so the copy is removed a couple of minutes later (not while it may still be read)', async () => {
    jest.useFakeTimers();
    Platform.OS = 'android';
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    await downloadDocument(SUMMARY(5), 'REQ-1042-summary.pdf');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith(expect.stringMatching(/REQ-1042/), expect.anything());
    jest.advanceTimersByTime(ANDROID_REMOVE_DELAY_MS + 1);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(apiDownload.mock.calls[0][1].destination, { idempotent: true });
  });
  test('the file is named after the request, with only safe characters, whatever the reference contains', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    await downloadDocument(SUMMARY(5), '../REQ 1/2"x-summary.pdf');
    const { destination } = apiDownload.mock.calls[0][1];
    expect(destination).toMatch(/^file:\/\/\/cache\/hcdoc-\d{13}-_REQ 1_2_x-summary\.pdf$/);
    expect(destination).not.toMatch(/\.\.\//);
  });
  test('a failed download opens nothing and leaves nothing; a missing share sheet is a clear error and the copy is removed', async () => {
    apiDownload.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await expect(downloadDocument(SUMMARY(5), 'REQ-1-summary.pdf')).rejects.toMatchObject({ status: 500 });
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    apiDownload.mockReset();
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    Sharing.isAvailableAsync.mockResolvedValue(false);
    await expect(downloadDocument(SUMMARY(5), 'REQ-1-summary.pdf')).rejects.toMatchObject({ code: 'share_unavailable' });
    expect(FileSystem.deleteAsync).toHaveBeenCalled();
  });
  test('a share sheet that fails removes the copy at once and tells the person', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    Sharing.shareAsync.mockRejectedValue(new Error('cancelled by the system'));
    await expect(downloadDocument(SUMMARY(5), 'REQ-1-summary.pdf')).rejects.toThrow('cancelled');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(apiDownload.mock.calls[0][1].destination, { idempotent: true });
  });
  test('two downloads (two requests) use two different files', async () => {
    apiDownload.mockImplementation(async (p, { destination }) => ({ uri: destination }));
    await downloadDocument(SUMMARY(5), 'REQ-1-summary.pdf');
    await downloadDocument(SUMMARY(6), 'REQ-2-summary.pdf');
    const names = apiDownload.mock.calls.map((c) => c[1].destination);
    expect(new Set(names).size).toBe(2);
  });
});

describe('and in a browser', () => {
  test('the PDF blob is saved as a .pdf file named after the request, and the temporary address is released', async () => {
    Platform.OS = 'web';
    const blob = { type: 'application/pdf', size: 1234 };
    apiDownload.mockResolvedValue({ blob });
    await downloadDocument(SUMMARY(5), 'REQ-1042-summary.pdf');
    expect(global.window.URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.download).toBe('REQ-1042-summary.pdf');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(global.window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:summary');
  });
});

describe('what the person is told when it goes wrong (every message exists in all six languages)', () => {
  const CASES = [
    [{ code: 'network' }, 'docs_err_network'], [{ name: 'TypeError' }, 'docs_err_network'], [{ code: 'session_expired' }, 'docs_err_session'], [{ status: 401 }, 'docs_err_session'],
    [{ status: 403 }, 'docs_err_denied'], [{ status: 404 }, 'docs_err_missing'], [{ status: 409 }, 'docs_err_blocked'], [{ code: 'share_unavailable' }, 'docs_err_share'], [{ status: 500 }, 'docs_err_generic'], [{}, 'docs_err_generic'],
  ];
  test.each(CASES)('%j -> %s', (error, key) => { expect(downloadErrorInfo(Object.assign(new Error('server text must never be shown'), error)).key).toBe(key); });
  test('each of those texts, the "downloading" toast and the button label exist in EN, HI, MR, GU, TE and AR (and are not the English text in the other five)', () => {
    for (const key of ['docs_err_network', 'docs_err_session', 'docs_err_denied', 'docs_err_missing', 'docs_err_blocked', 'docs_err_share', 'docs_err_generic', 'rd_downloading', 'rd_download', 'net_offline_text']) {
      for (const lang of LANGS) {
        expect({ key, lang, ok: typeof I18N[lang][key] === 'string' && I18N[lang][key].trim() !== '' }).toEqual({ key, lang, ok: true });
        if (lang !== 'EN') expect({ key, lang, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ key, lang, same: false });
      }
    }
  });
});

describe('the Request Details wiring', () => {
  const screen = read('app/request-details.js');
  test('the button downloads this request\'s summary, named after its reference, with the authenticated download', () => {
    expect(screen).toContain('downloadDocument(`/requests/me/${request.id}/summary`, `${request.referenceNumber}-summary.pdf`)');
    expect(screen).toContain("<Action Icon={Download} label={t('rd_download')} onPress={onDownload} disabled={offline}");
  });
  test('offline it says why instead of failing, a failure shows OUR message (never the server\'s), and nothing sends the person\'s data anywhere else', () => {
    expect(screen).toContain("if (isOffline) { toast(t('net_offline_text')); return; }");
    expect(screen).toContain('toast(t(downloadErrorInfo(err).key));');
    expect(screen).toContain("toast(t('rd_downloading'));");
    expect(screen).not.toMatch(/\/summary[^`'"]*\?/); // no query string: nothing about the language or the person goes along
  });
  test('the request is asked for by its own id: no language, no other person\'s data is part of the download call', () => {
    const call = /downloadDocument\(([^)]*)\)/.exec(screen)[1];
    expect(call).not.toMatch(/lang|locale|language|token|email|mobile/i);
  });
});
