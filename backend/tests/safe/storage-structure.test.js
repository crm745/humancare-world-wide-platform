/* global describe, test, expect */
// Structural validation of the accepted formats, with synthetic files only.
const zlib = require('zlib');
const { validateStructure } = require('../../src/storage/structure');
const fx = require('./document-fixtures');

const code = async (type, buf) => { const r = await validateStructure(type, buf); return r ? r.code : null; };

describe('images', () => {
  test('well-formed PNG, JPEG and WEBP are accepted', async () => {
    expect(await code('png', fx.validPng())).toBeNull();
    expect(await code('jpeg', fx.validJpeg())).toBeNull();
    expect(await code('webp', fx.validWebp())).toBeNull();
  });
  test.each([
    ['png', () => Buffer.concat([fx.validPng(), Buffer.from('PK\x03\x04payload')])],
    ['jpeg', () => Buffer.concat([fx.validJpeg(), Buffer.from('<script>x</script>')])],
    ['webp', () => Buffer.concat([fx.validWebp(), Buffer.from('payload')])],
  ])('%s with a payload appended is rejected as trailing data', async (type, make) => {
    expect(await code(type, make())).toBe('trailing_data');
  });
  test('malformed images are rejected', async () => {
    const png = fx.validPng();
    const corrupt = Buffer.from(png); corrupt[corrupt.length - 20] ^= 0xff; // flips a byte inside IDAT: checksum no longer matches
    expect(await code('png', corrupt)).toBe('png_malformed');
    expect(await code('png', png.subarray(0, png.length - 12))).toBe('png_malformed'); // no IEND
    expect(await code('png', fx.validPng({ width: 100000, height: 100000 }))).toBe('image_too_large');
    expect(await code('jpeg', fx.validJpeg().subarray(0, 20))).toBe('jpeg_malformed');
    expect(await code('jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(30)]))).toBe('jpeg_malformed');
    expect(await code('webp', fx.validWebp().subarray(0, 24))).toBe('webp_malformed');
    expect(await code('png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 1)]))).toBe('png_malformed'); // magic bytes only
  });
  test('an image/ZIP polyglot (a ZIP appended to a JPEG) is rejected', async () => {
    expect(await code('jpeg', Buffer.concat([fx.validJpeg(), fx.validDocx()]))).toBe('trailing_data');
  });
});

describe('PDF', () => {
  test('a normal PDF (object streams included) is accepted', async () => {
    expect(await code('pdf', await fx.validPdf())).toBeNull();
  });
  test.each([
    ['openaction'], ['names-javascript'], ['launch'], ['aa'], ['richmedia'], ['embedded'], ['xfa'],
  ])('active or embedded content "%s" is rejected', async (feature) => {
    expect(await code('pdf', await fx.pdfWith(feature))).toBe('pdf_active_content');
  });
  test('an encrypted PDF is rejected', async () => {
    expect(await code('pdf', await fx.pdfWith('encrypted'))).toBe('pdf_encrypted');
  });
  test('malformed PDFs and trailing data are rejected', async () => {
    const pdf = await fx.validPdf();
    expect(await code('pdf', Buffer.concat([pdf, fx.validDocx()]))).toBe('trailing_data'); // PDF + ZIP polyglot
    expect(await code('pdf', Buffer.concat([pdf, Buffer.from('\n'.repeat(5))]))).toBeNull(); // harmless line breaks are fine
    expect(await code('pdf', pdf.subarray(0, Math.floor(pdf.length / 2)))).toMatch(/pdf_malformed/);
    expect(await code('pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 65), Buffer.from('\nstartxref\n0\n%%EOF\n')]))).toBe('pdf_malformed');
    expect(await code('pdf', Buffer.from('%PDF-1.7 not really a pdf'))).toBe('pdf_malformed');
  });
  test('a hex-escaped name (/J#61vaScript) is decoded and caught; the same hand-written file without it is accepted', async () => {
    // a small PDF written by hand, with a correct cross-reference table
    const handWritten = (action) => {
      const objs = [
        `<< /Type /Catalog /Pages 2 0 R${action ? ` /OpenAction << /S ${action} /JS () >>` : ''} >>`,
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
      ];
      const NL = String.fromCharCode(10);
      let out = '%PDF-1.4' + NL;
      const offsets = [];
      objs.forEach((body, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj' + NL + body + NL + 'endobj' + NL; });
      const xref = out.length;
      out += 'xref' + NL + '0 4' + NL + '0000000000 65535 f ' + NL + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n ' + NL).join('');
      out += 'trailer' + NL + '<< /Size 4 /Root 1 0 R >>' + NL + 'startxref' + NL + xref + NL + '%%EOF' + NL;
      return Buffer.from(out, 'latin1');
    };
    expect(await code('pdf', handWritten(null))).toBeNull();
    expect(await code('pdf', handWritten('/JavaScript'))).toBe('pdf_active_content');
    expect(await code('pdf', handWritten('/J#61vaScript'))).toBe('pdf_active_content');
  });
});

describe('DOCX', () => {
  test('a plain Word package is accepted (stored and deflated)', async () => {
    expect(await code('docx', fx.validDocx())).toBeNull();
    expect(await code('docx', fx.zip(fx.docxEntries().map((e) => ({ ...e, method: 0 }))))).toBeNull();
  });
  test('hyperlinks are allowed, other external relationships are not', async () => {
    const link = (type) => `<Relationships><Relationship Id="r9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://example.invalid/" TargetMode="External"/></Relationships>`;
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'word/_rels/document.xml.rels', data: Buffer.from(link('hyperlink')) }] }))).toBeNull();
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'word/_rels/document.xml.rels', data: Buffer.from(link('attachedTemplate')) }] }))).toBe('docx_active_content');
  });
  test('encrypted entries are rejected', async () => {
    const entries = fx.docxEntries(); entries[2] = { ...entries[2], flags: 0x1 };
    expect(await code('docx', fx.zip(entries))).toBe('zip_encrypted');
  });
  test.each([
    ['macro project', { name: 'word/vbaProject.bin', data: Buffer.from('dummy') }],
    ['embedded object', { name: 'word/embeddings/oleObject1.bin', data: Buffer.from('dummy') }],
    ['ActiveX', { name: 'word/activeX/activeX1.xml', data: Buffer.from('<x/>') }],
    ['external link part', { name: 'word/externalLinks/externalLink1.xml', data: Buffer.from('<x/>') }],
    ['executable payload', { name: 'word/media/run.exe', data: Buffer.from('MZ') }],
  ])('a %s is rejected', async (_name, entry) => {
    expect(await code('docx', fx.validDocx({ extra: [entry] }))).toBe('docx_active_content');
  });
  test('a macro-enabled content type is rejected', async () => {
    expect(await code('docx', fx.validDocx({ contentTypes: fx.CT.replace('document.main+xml', 'document.macroEnabled.main+xml') }))).toMatch(/docx_(active_content|malformed)/);
  });
  test('path traversal, duplicate names and missing parts are rejected', async () => {
    expect(await code('docx', fx.validDocx({ extra: [{ name: '../evil.txt', data: Buffer.from('x') }] }))).toBe('zip_path_traversal');
    expect(await code('docx', fx.validDocx({ extra: [{ name: '/abs.txt', data: Buffer.from('x') }] }))).toBe('zip_path_traversal');
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'a\\b.txt', data: Buffer.from('x') }] }))).toBe('zip_path_traversal');
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'WORD/document.xml', data: Buffer.from('x') }] }))).toBe('zip_malformed');
    expect(await code('docx', fx.zip(fx.docxEntries().slice(0, 2)))).toBe('docx_malformed');
    expect(await code('docx', fx.zip([{ name: 'hello.txt', data: Buffer.from('not office') }]))).toBe('docx_malformed');
  });
  test('compression bombs are rejected', async () => {
    const zeros = Buffer.alloc(5 * 1024 * 1024);
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'word/media/zeros.bin', data: zeros }] }))).toBe('zip_bomb');
    expect(await code('docx', fx.validDocx({ extra: [{ name: 'a.txt', data: Buffer.from('x'), rawSize: 80 * 1024 * 1024 }] }))).toBe('zip_bomb');
  });
  test('malformed archives and appended data fail closed', async () => {
    const docx = fx.validDocx();
    expect(await code('docx', Buffer.concat([docx, Buffer.from('trailing payload')]))).toBe('trailing_data');
    expect(await code('docx', docx.subarray(0, docx.length - 30))).toBe('zip_malformed');
    expect(await code('docx', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 1)]))).toBe('zip_malformed');
    expect(await code('docx', zlib.deflateSync(Buffer.from('x')))).toBe('zip_malformed');
  });
});

test('a type without a validator is refused', async () => {
  expect(await code('doc', Buffer.alloc(100))).toBe('file_type_not_allowed');
  expect(await code('exe', Buffer.alloc(100))).toBe('file_type_not_allowed');
});
