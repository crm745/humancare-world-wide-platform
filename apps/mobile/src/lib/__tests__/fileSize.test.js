/* global describe, test, expect, jest, beforeEach, afterAll, __dirname */
// M5: the 10 MB limit is applied to every file the person attaches, whether or not the picker (the camera above all) reported a size, and apiUpload stops a file known to be too big before sending
// anything. Pure: the size read, the platform, the session and the network are fakes.
jest.mock('expo/virtual/env', () => ({ env: process.env }));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-file-system/legacy', () => ({ createUploadTask: jest.fn(), getInfoAsync: jest.fn(), FileSystemUploadType: { MULTIPART: 1 } }));
jest.mock('../session', () => ({
  getAccessToken: jest.fn(), getRefreshToken: jest.fn(), saveTokens: jest.fn(), compareAndSaveTokens: jest.fn(), clearTokens: jest.fn(), compareAndClearTokens: jest.fn(),
}));
jest.mock('../nav', () => ({ navReplace: jest.fn() }));

const fs = require('fs');
const path = require('path');
const FileSystem = require('expo-file-system/legacy');
const { Platform } = require('react-native');
const session = require('../session');
const { setApiAuthStatus } = require('../authGuard');
const { apiUpload } = require('../api');
const { MAX_REPORT_BYTES } = require('../../data/mock');
const { translate } = require('../translate');
const I18N = require('../../data/i18n.json');
const { localizedUploadMessage } = require('../serverErrors');
const {
  MAX_UPLOAD_BYTES, FILE_TOO_BIG_MESSAGE, knownSize, sizeVerdict, resolveFileSize, withResolvedSize, oversizedUploadError, vetPickedFile,
} = require('../fileSize');
const { readFileSize } = require('../fileSizeDevice');

const MB = 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const SRC = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');

describe('the limit', () => {
  test('is 10 MB, the one the form, the upload and the server share', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * MB);
    expect(MAX_UPLOAD_BYTES).toBe(MAX_REPORT_BYTES);
    expect(FILE_TOO_BIG_MESSAGE).toBe('The file is larger than 10 MB.');
  });
});

describe('knownSize', () => {
  test.each([[0, 0], [1, 1], [2048, 2048], [10 * MB, 10 * MB], ['2048', 2048], [' 2048 ', 2048], ['0', 0]])('%j is a size: %i', (value, expected) => { expect(knownSize(value)).toBe(expected); });
  test.each([[undefined], [null], [NaN], [Infinity], [-Infinity], [-1], [1.5], ['abc'], [''], ['-5'], ['1.5'], ['1e3'], ['12 MB'], [{}], [[]], [true], [() => 1], ['9'.repeat(30)]])('%j is not a usable size', (value) => {
    expect(knownSize(value)).toBeNull();
  });
});

describe('sizeVerdict', () => {
  test('1 byte up to exactly 10 MB is fine; one byte more is too big; 0 is empty; anything else is unknown', () => {
    expect(sizeVerdict(1)).toBe('ok');
    expect(sizeVerdict(5 * MB)).toBe('ok');
    expect(sizeVerdict(10 * MB)).toBe('ok'); // the server accepts exactly 10 MB, so the form does too
    expect(sizeVerdict(10 * MB + 1)).toBe('too_big');
    expect(sizeVerdict(500 * MB)).toBe('too_big');
    expect(sizeVerdict(0)).toBe('empty');
    for (const value of [undefined, null, NaN, 'x', -3, 1.2]) expect(sizeVerdict(value)).toBe('unknown');
  });
  test('a text size is judged like a number', () => {
    expect(sizeVerdict(String(10 * MB))).toBe('ok');
    expect(sizeVerdict(String(10 * MB + 1))).toBe('too_big');
  });
});

describe('resolveFileSize: a missing size is read from the file', () => {
  test('a usable size from the picker is used as it is, and the file is not read', async () => {
    const readSize = jest.fn();
    expect(await resolveFileSize({ uri: 'file:///a.jpg', size: 4096 }, readSize)).toBe(4096);
    expect(readSize).not.toHaveBeenCalled();
  });
  test.each([[undefined], [null], [NaN], ['bad'], [-1]])('picker size %j: the size is read from the file', async (given) => {
    const readSize = jest.fn(async () => 123456);
    expect(await resolveFileSize({ uri: 'file:///camera.jpg', size: given }, readSize)).toBe(123456);
    expect(readSize).toHaveBeenCalledWith('file:///camera.jpg');
  });
  test('a picker size of 0 is read again before the file is called empty (some pickers say 0 for "unknown")', async () => {
    expect(await resolveFileSize({ uri: 'file:///a.pdf', size: 0 }, async () => 777)).toBe(777);
    expect(await resolveFileSize({ uri: 'file:///a.pdf', size: 0 }, async () => 0)).toBe(0);
    expect(await resolveFileSize({ uri: 'file:///a.pdf', size: 0 }, async () => { throw new Error('unreadable'); })).toBe(0);
  });
  test('a size that cannot be read stays unknown and never throws', async () => {
    for (const readSize of [async () => { throw new Error('no such file'); }, async () => null, async () => undefined, async () => 'garbage', async () => NaN, async () => -5, () => { throw new Error('sync failure'); }]) {
      expect(await resolveFileSize({ uri: 'file:///x.jpg' }, readSize)).toBeNull();
    }
    expect(await resolveFileSize({ uri: 'file:///x.jpg' }, undefined)).toBeNull();
    expect(await resolveFileSize({ size: undefined }, async () => 5)).toBeNull(); // no address to read
    expect(await resolveFileSize(null, async () => 5)).toBeNull();
  });
  test('withResolvedSize returns the same file with its size filled in, nothing else changed', async () => {
    const file = { uri: 'file:///c.jpg', name: 'report-1.jpg', mimeType: 'image/jpeg' };
    expect(await withResolvedSize(file, async () => 2048)).toEqual({ ...file, size: 2048 });
    expect(file).not.toHaveProperty('size'); // the input is not changed
    expect(await withResolvedSize(file, async () => { throw new Error('x'); })).toEqual({ ...file, size: null });
  });
});

describe('vetPickedFile: the same checks for the camera, the picker and added files', () => {
  const CAMERA = (extra = {}) => ({ uri: 'file:///cache/report-1.jpg', name: 'report-1.jpg', mimeType: 'image/jpeg', size: undefined, ...extra }); // what the camera path builds (a.fileSize is optional)
  test('a camera photo with NO size and a valid size on disk is accepted, with the size filled in', async () => {
    const { file, problem } = await vetPickedFile(CAMERA(), async () => 3 * MB, ALLOWED);
    expect(problem).toBeNull();
    expect(file.size).toBe(3 * MB);
  });
  test('a camera photo with NO size that is over 10 MB on disk is REFUSED (this used to skip the check)', async () => {
    expect((await vetPickedFile(CAMERA(), async () => 10 * MB + 1, ALLOWED)).problem).toBe('too_big');
    expect((await vetPickedFile(CAMERA({ size: NaN }), async () => 25 * MB, ALLOWED)).problem).toBe('too_big');
    expect((await vetPickedFile(CAMERA({ size: null }), async () => 25 * MB, ALLOWED)).problem).toBe('too_big');
  });
  test('a size the picker DID give is enforced the same way (gallery / document picker)', async () => {
    expect((await vetPickedFile({ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 * MB + 1 }, async () => 1, ALLOWED)).problem).toBe('too_big');
    expect((await vetPickedFile({ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 * MB }, async () => 1, ALLOWED)).problem).toBeNull();
    expect((await vetPickedFile({ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1 }, async () => 1, ALLOWED)).problem).toBeNull();
  });
  test('a picker that lies small does not hide a big file: the given size wins only when it is usable and positive, and a huge one is still refused', async () => {
    expect((await vetPickedFile({ uri: 'file:///a.pdf', mimeType: 'application/pdf', size: 12 * MB }, async () => 1, ALLOWED)).problem).toBe('too_big');
  });
  test('a size that cannot be known does NOT break a valid upload: accepted with an unknown size (the server still holds it to 10 MB)', async () => {
    for (const readSize of [async () => { throw new Error('unreadable'); }, async () => null]) {
      const { file, problem } = await vetPickedFile(CAMERA(), readSize, ALLOWED);
      expect(problem).toBeNull();
      expect(file.size).toBeNull();
    }
  });
  test('an empty file is refused; a type that is not allowed is refused before anything is read', async () => {
    expect((await vetPickedFile(CAMERA({ size: 0 }), async () => 0, ALLOWED)).problem).toBe('empty');
    const readSize = jest.fn(async () => 10);
    expect((await vetPickedFile({ uri: 'file:///a.exe', name: 'a.exe', mimeType: 'application/x-msdownload', size: 10 }, readSize, ALLOWED)).problem).toBe('type');
    expect(readSize).not.toHaveBeenCalled();
  });
  test('a file with no type is judged on its size alone (as before)', async () => {
    expect((await vetPickedFile({ uri: 'file:///a', size: 5 }, async () => 5, ALLOWED)).problem).toBeNull();
    expect((await vetPickedFile({ uri: 'file:///a', size: 11 * MB }, async () => 5, ALLOWED)).problem).toBe('too_big');
  });
  test('the dictionary text for each problem exists in all six languages', () => {
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) for (const key of ['req_file_type', 'req_file_big', 'srv_file_empty']) expect(translate(I18N, lang, key)).not.toBe(key);
  });
});

describe('the form wiring (source checks): every source of a file goes through one vetted path', () => {
  const fields = read('components/request/fields.js');
  test('both the picker and the camera call the one async add(), which vets every file with a resolved size', () => {
    expect(fields).toContain('const add = async (pickedFiles) => {');
    expect(fields).toContain('vetPickedFile(file, readFileSize, ALLOWED_MIME_TYPES)');
    expect(fields).toContain('await add(result.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size })));');
    expect(fields).toContain("await add([{ uri: a.uri, name: a.fileName || `report-${Date.now()}.jpg`, mimeType: a.mimeType || 'image/jpeg', size: a.fileSize }]);");
  });
  test('the old check that let a missing size through is gone, and each problem gets its own message', () => {
    expect(fields).not.toContain('file.size && file.size > MAX_REPORT_BYTES');
    expect(fields).toContain("if (problem === 'too_big') { toast(t('req_file_big')); continue; }");
    expect(fields).toContain("if (problem === 'empty') { toast(t('srv_file_empty')); continue; }");
    expect(fields).toContain("if (problem === 'type') { toast(t('req_file_type')); continue; }");
  });
  test('every place that attaches files uses ReportTiles (so there is no second, unchecked path)', () => {
    for (const file of ['app/request/step2.js', 'components/request/HomeStep2.js', 'components/request/MarineStep2.js', 'components/request/MortalStep2.js', 'components/request/AdditionalDocuments.js']) {
      expect(read(file)).toContain('<ReportTiles');
    }
    expect(read('app/request/step2.js') + read('components/request/AdditionalDocuments.js')).not.toContain('launchCameraAsync');
    const pickers = ['app', 'components', 'lib'].flatMap((dir) => {
      const walk = (d) => fs.readdirSync(path.join(SRC, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
      return walk(dir);
    }).filter((file) => /\.js$/.test(file) && /getDocumentAsync|launchCameraAsync|launchImageLibraryAsync/.test(read(file)));
    expect(pickers.map((p) => p.replace(/\\/g, '/'))).toEqual(['components/request/fields.js']); // the only file that opens a picker or the camera
  });
});

describe('readFileSize (the device read)', () => {
  beforeEach(() => { jest.clearAllMocks(); Platform.OS = 'ios'; });
  test('native: the size from the file system; a missing file is null; a bad address is null without reading', async () => {
    FileSystem.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 4321, uri: 'file:///a' });
    expect(await readFileSize('file:///a')).toBe(4321);
    FileSystem.getInfoAsync.mockResolvedValueOnce({ exists: false });
    expect(await readFileSize('file:///gone')).toBeNull();
    for (const uri of [undefined, null, '', 5]) expect(await readFileSize(uri)).toBeNull();
    expect(FileSystem.getInfoAsync).toHaveBeenCalledTimes(2);
  });
  test('native: a failing read throws (the caller treats it as unknown)', async () => {
    FileSystem.getInfoAsync.mockRejectedValueOnce(new Error('permission denied'));
    await expect(readFileSize('content://x')).rejects.toThrow('permission denied');
  });
  test('web: the picked blob is fetched and measured', async () => {
    Platform.OS = 'web';
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ blob: async () => ({ size: 999 }) }));
    try { expect(await readFileSize('blob:http://localhost/abc')).toBe(999); } finally { global.fetch = realFetch; }
  });
});

describe('apiUpload stops a file known to be too big before anything is sent', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'ios';
    session.getAccessToken.mockResolvedValue('tok');
    session.getRefreshToken.mockResolvedValue('rt');
    setApiAuthStatus('authed');
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  });
  afterAll(() => { global.fetch = realFetch; });
  const FILE = (extra = {}) => ({ uri: 'file:///cache/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', ...extra });

  test('over 10 MB: refused with the server\'s own wording and code, nothing sent, no session needed', async () => {
    await expect(apiUpload('/requests/me/5/documents', FILE({ size: 10 * MB + 1 }))).rejects.toMatchObject({ status: 400, code: 'file_too_large', message: 'The file is larger than 10 MB.' });
    expect(FileSystem.createUploadTask).not.toHaveBeenCalled();
    expect(session.getAccessToken).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('the refusal is recognised by the upload list and shown in the person\'s language', async () => {
    const error = await apiUpload('/requests/me/5/documents', FILE({ size: 20 * MB })).catch((e) => e);
    for (const lang of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) expect(localizedUploadMessage(error.message, (key, values) => translate(I18N, lang, key, values))).toBe(I18N[lang].req_file_big);
  });
  test('exactly 10 MB, a smaller file, and a file of unknown size all go on to the upload', async () => {
    for (const size of [10 * MB, 1, undefined, null, NaN]) {
      FileSystem.createUploadTask.mockReset();
      FileSystem.createUploadTask.mockImplementation(() => ({ uploadAsync: async () => ({ status: 201, body: JSON.stringify({ document: { id: 1 } }) }) }));
      await expect(apiUpload('/requests/me/5/documents', FILE({ size }))).resolves.toEqual({ document: { id: 1 } });
      expect(FileSystem.createUploadTask).toHaveBeenCalledTimes(1);
    }
  });
  test('oversizedUploadError: only a file KNOWN to be over the limit gives an error', () => {
    expect(oversizedUploadError({ size: 10 * MB + 1 })).toBeInstanceOf(Error);
    for (const file of [{ size: 10 * MB }, { size: 0 }, {}, null, undefined, { size: 'x' }]) expect(oversizedUploadError(file)).toBeNull();
  });
});
