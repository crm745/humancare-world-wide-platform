// Synthetic, harmless documents for the structure / policy tests. Nothing here is real or personal; the "dangerous" ones only contain the
// STRUCTURE the validators look for (an empty JavaScript string, a dummy vbaProject.bin, a flag bit), never working code.
const zlib = require('zlib');
const { PDFDocument, PDFName, PDFString, PDFHexString } = require('pdf-lib');
const { crc32 } = require('../../src/storage/structure/images');

// ---- images
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function validPng({ width = 1, height = 1 } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function validJpeg({ width = 1, height = 1 } = {}) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  const data = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]); // 0xFF00 is a stuffed byte
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), sof, sos, data, Buffer.from([0xff, 0xd9])]);
}
function validWebp() {
  const chunk = Buffer.concat([Buffer.from('VP8L', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10, 7)]);
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), chunk]);
}

// ---- PDF (built with pdf-lib, so the parser accepts them)
async function validPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}
async function pdfWith(feature) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  const js = () => ctx.obj({ S: 'JavaScript', JS: PDFString.of('') });
  if (feature === 'openaction') doc.catalog.set(PDFName.of('OpenAction'), js());
  if (feature === 'names-javascript') doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: { Names: [PDFString.of('a'), js()] } }));
  if (feature === 'launch') page.node.set(PDFName.of('Annots'), ctx.obj([ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1], A: { S: 'Launch', F: PDFString.of('x') } })]));
  if (feature === 'aa') page.node.set(PDFName.of('AA'), ctx.obj({ O: js() }));
  if (feature === 'richmedia') page.node.set(PDFName.of('Annots'), ctx.obj([ctx.obj({ Type: 'Annot', Subtype: 'RichMedia', Rect: [0, 0, 1, 1] })]));
  if (feature === 'embedded') await doc.attach(Buffer.from('synthetic attachment'), 'a.txt', { mimeType: 'text/plain' });
  if (feature === 'xfa') doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [], XFA: PDFString.of('') }));
  if (feature === 'encrypted') doc.context.trailerInfo.Encrypt = ctx.register(ctx.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 }));
  return Buffer.from(await doc.save({ useObjectStreams: feature === 'in-object-stream' }));
}

// ---- ZIP / DOCX
function zip(entries, { trailing = null, comment = null } = {}) {
  const locals = []; const centrals = []; let offset = 0;
  for (const entry of entries) {
    const { name, data, flags = 0, method = 8, rawSize, compressed } = entry;
    const body = compressed || (method === 8 ? zlib.deflateRawSync(data) : data);
    const n = Buffer.from(name, 'utf8');
    const usize = rawSize !== undefined ? rawSize : data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    const local = Buffer.concat([lh, n, body]);
    locals.push(local); centrals.push(Buffer.concat([cd, n])); offset += local.length;
  }
  const L = Buffer.concat(locals); const C = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(C.length, 12); end.writeUInt32LE(L.length, 16);
  if (comment) end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([L, C, end, comment || Buffer.alloc(0), trailing || Buffer.alloc(0)]);
}
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const DOC = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>synthetic</w:t></w:r></w:p></w:body></w:document>';
function docxEntries(over = {}) {
  return [
    { name: '[Content_Types].xml', data: Buffer.from(over.contentTypes || CT) },
    { name: '_rels/.rels', data: Buffer.from(RELS) },
    { name: 'word/document.xml', data: Buffer.from(DOC) },
    ...(over.extra || []),
  ];
}
const validDocx = (over, opts) => zip(docxEntries(over), opts);

module.exports = { validPng, validJpeg, validWebp, validPdf, pdfWith, zip, docxEntries, validDocx, CT, RELS };
