/* global describe, test, expect */
const { fileTypeOf, formatFileSize, fileMeta, documentDate, filterDocuments, countLabel } = require('../documentsView');

describe('fileTypeOf (a display hint from the extension)', () => {
  test.each([
    ['report.pdf', 'pdf', 'PDF'], ['REPORT.PDF', 'pdf', 'PDF'], ['scan.png', 'image', 'PNG'], ['photo.jpg', 'image', 'JPG'],
    ['photo.JPEG', 'image', 'JPG'], ['pic.webp', 'image', 'WEBP'], ['letter.doc', 'word', 'DOC'], ['letter.docx', 'word', 'DOCX'],
    ['my.report.final.pdf', 'pdf', 'PDF'],
  ])('%s', (name, kind, label) => {
    expect(fileTypeOf(name)).toEqual({ kind, label });
  });
  test('an unknown extension shows itself, as upper case, in the "other" style', () => {
    expect(fileTypeOf('data.xyz')).toEqual({ kind: 'other', label: 'XYZ' });
    expect(fileTypeOf('archive.verylongext')).toEqual({ kind: 'other', label: 'VERYL' });
  });
  test('no extension, a trailing dot, a hidden file, an empty or missing name', () => {
    for (const name of ['report', 'report.', '.pdf', '', null, undefined, '   ']) expect(fileTypeOf(name)).toEqual({ kind: 'other', label: '' });
  });
  test('"toString"-style names cannot reach the prototype', () => {
    expect(fileTypeOf('x.constructor')).toEqual({ kind: 'other', label: 'CONST' });
    expect(fileTypeOf('x.__proto__').kind).toBe('other');
  });
});

describe('formatFileSize', () => {
  test('KB below a megabyte (never less than 1 KB), MB with one decimal above', () => {
    expect(formatFileSize(1)).toBe('1 KB');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(43 * 1024)).toBe('43 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe('1.4 MB');
  });
  test('nothing when the size is not known', () => {
    for (const v of [null, undefined, 0, -5, NaN, 'abc']) expect(formatFileSize(v)).toBe('');
  });
});

describe('fileMeta', () => {
  test('type and size, or whichever is known', () => {
    expect(fileMeta({ name: 'a.pdf', fileSizeBytes: 43008 })).toBe('PDF · 42 KB');
    expect(fileMeta({ name: 'a.pdf', fileSizeBytes: null })).toBe('PDF');
    expect(fileMeta({ name: 'a', fileSizeBytes: 2048 })).toBe('2 KB');
    expect(fileMeta({ name: 'a', fileSizeBytes: null })).toBe('');
    expect(fileMeta(null)).toBe('');
  });
});

describe('documentDate (a plain date, no caption; never the device date)', () => {
  test('a real date is shown in the day month year form', () => {
    expect(documentDate('2026-11-03T04:42:00.000Z')).toBe('03 Nov 2026');
  });
  test('missing or invalid dates give nothing, not today\'s date', () => {
    for (const v of [null, undefined, '', 'not a date', 'undefined']) expect(documentDate(v)).toBe('');
  });
  test('it is only the date: no words, so it is never called an upload date', () => {
    expect(documentDate('2026-11-03T04:42:00.000Z')).not.toMatch(/[a-z]{4,}/i);
  });
});

describe('filterDocuments (file name or case reference)', () => {
  const docs = [
    { id: 1, name: 'Blood-Report.pdf', case: { referenceNumber: 'CASE-1005' } },
    { id: 2, name: 'scan.png', case: { referenceNumber: 'CASE-1007' } },
    { id: 3, name: 'discharge summary.docx', case: null },
  ];
  test('an empty or blank search keeps everything, in the same order', () => {
    expect(filterDocuments(docs, '')).toBe(docs);
    expect(filterDocuments(docs, '   ')).toBe(docs);
    expect(filterDocuments(docs, null)).toBe(docs);
  });
  test('by file name, case-insensitively, ignoring spaces at the ends', () => {
    expect(filterDocuments(docs, ' blood ').map((d) => d.id)).toEqual([1]);
    expect(filterDocuments(docs, 'SUMMARY').map((d) => d.id)).toEqual([3]);
  });
  test('by the case reference', () => {
    expect(filterDocuments(docs, 'case-1007').map((d) => d.id)).toEqual([2]);
    expect(filterDocuments(docs, '1005').map((d) => d.id)).toEqual([1]);
    expect(filterDocuments(docs, 'case').map((d) => d.id)).toEqual([1, 2]);
  });
  test('no match, a missing case, and an odd row do not throw', () => {
    expect(filterDocuments(docs, 'zzz')).toEqual([]);
    expect(filterDocuments([...docs, null, {}], 'scan').map((d) => d && d.id)).toEqual([2]);
  });
});

describe('countLabel', () => {
  test('the total, or "n of total" while a search narrows the list', () => {
    expect(countLabel(6, 6)).toBe('6');
    expect(countLabel(2, 6)).toBe('2 of 6');
    expect(countLabel(0, 6)).toBe('0 of 6');
  });
});
