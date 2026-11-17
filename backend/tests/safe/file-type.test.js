/* global describe, test, expect */
// What a file really is, from its own bytes. Only PDF, JPEG, PNG and WEBP may be shared with Bitrix24.
const { detectFileType, SHAREABLE_TYPES, EXTENSION } = require('../../src/modules/documents/file-type');

const pad = (head, total = 64) => Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length), 0x20)]);
const PDF = pad(Buffer.from('%PDF-1.7\n'));
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
const WEBP = pad(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ')]));

describe('detectFileType', () => {
  test.each([['a PDF', PDF, 'pdf'], ['a JPEG', JPEG, 'jpeg'], ['a PNG', PNG, 'png'], ['a WEBP', WEBP, 'webp']])('recognises %s', (_name, buffer, type) => {
    expect(detectFileType(buffer)).toBe(type);
    expect(SHAREABLE_TYPES).toContain(type);
    expect(EXTENSION[type]).toMatch(/^\.[a-z]+$/);
  });

  test.each([
    ['a Word .docx (a zip)', pad(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
    ['an old Word .doc', pad(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))],
    ['a GIF', pad(Buffer.from('GIF89a'))],
    ['a RIFF file that is not WEBP (a WAV)', pad(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt ')]))],
    ['an HTML file', pad(Buffer.from('<html><script>alert(1)</script>'))],
    ['an executable', pad(Buffer.from('MZ'))],
    ['a text file named like a PDF', pad(Buffer.from('this is not a pdf'))],
  ])('refuses %s', (_name, buffer) => {
    expect(detectFileType(buffer)).toBeNull();
  });

  test('refuses a buffer that is too short, empty or not a buffer', () => {
    expect(detectFileType(Buffer.from('%PDF-'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    for (const value of [null, undefined, 'PDF', 5, {}, [0x25]]) expect(detectFileType(value)).toBeNull();
  });

  test('the type comes from the bytes only: the list of shareable types is exactly four', () => {
    expect(SHAREABLE_TYPES).toEqual(['pdf', 'jpeg', 'png', 'webp']);
  });
});
