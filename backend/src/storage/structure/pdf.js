// PDF structure and active-content policy. The file is parsed with pdf-lib (a real parser: cross-reference tables, object streams and
// all), then EVERY indirect object is inspected, so names hidden in compressed object streams or written with #-escapes are seen too.
//
// Rejected: malformed / unparsable files, encrypted files (they cannot be inspected), data after the final %%EOF (polyglots), and
// active or embedding features: JavaScript, Launch and other executing / remote actions, OpenAction, additional actions (AA), XFA forms,
// embedded files and file attachments, RichMedia / 3D / movie / sound / screen content.
// Returns null when acceptable, or { code, reason }. Never throws.
const { PDFDocument, PDFDict, PDFArray, PDFName, PDFStream } = require('pdf-lib');

const MAX_OBJECTS = 100000;
const MAX_TRAILING = 16;
const bad = (code, reason) => ({ code, reason });

// Dictionary keys that never belong in a medical document.
const FORBIDDEN_KEYS = new Set(['JS', 'JavaScript', 'Launch', 'OpenAction', 'AA', 'XFA', 'EmbeddedFiles', 'EF', 'RichMedia', 'RichMediaContent', 'RichMediaSettings', 'AF']);
// /S (action type) values.
const FORBIDDEN_ACTIONS = new Set(['JavaScript', 'Launch', 'GoToR', 'GoToE', 'ImportData', 'SubmitForm', 'ResetForm', 'Rendition', 'Movie', 'Sound', 'SetOCGState', 'Trans', 'GoTo3DView', 'RichMediaExecute']);
// /Subtype of annotations and /Type values.
const FORBIDDEN_SUBTYPES = new Set(['FileAttachment', 'Movie', 'Sound', 'Screen', '3D', 'RichMedia']);
const FORBIDDEN_TYPES = new Set(['EmbeddedFile', 'Filespec', 'RichMediaInstance']);

const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : null);

function inspect(object, depth, seen) {
  if (depth > 12 || object === undefined || object === null) return null;
  let dict = null;
  if (object instanceof PDFStream) dict = object.dict;
  else if (object instanceof PDFDict) dict = object;
  if (dict) {
    if (seen.has(dict)) return null;
    seen.add(dict);
    for (const [key, value] of dict.entries()) {
      const k = nameOf(key);
      if (k && FORBIDDEN_KEYS.has(k)) return bad('pdf_active_content', `/${k}`);
      if (k === 'S' && FORBIDDEN_ACTIONS.has(nameOf(value))) return bad('pdf_active_content', `action /${nameOf(value)}`);
      if (k === 'Subtype' && FORBIDDEN_SUBTYPES.has(nameOf(value))) return bad('pdf_active_content', `/Subtype /${nameOf(value)}`);
      if (k === 'Type' && FORBIDDEN_TYPES.has(nameOf(value))) return bad('pdf_active_content', `/Type /${nameOf(value)}`);
      const inner = inspect(value, depth + 1, seen);
      if (inner) return inner;
    }
    return null;
  }
  if (object instanceof PDFArray) {
    for (const item of object.asArray()) {
      const inner = inspect(item, depth + 1, seen);
      if (inner) return inner;
    }
  }
  return null;
}

async function validatePdf(buf) {
  try {
    if (!/^%PDF-[12]\.\d/.test(buf.toString('latin1', 0, 8))) return bad('pdf_malformed', 'bad header');
    const eof = buf.lastIndexOf('%%EOF');
    if (eof < 0) return bad('pdf_malformed', 'missing %%EOF');
    const tail = buf.subarray(eof + 5);
    if (tail.length > MAX_TRAILING || !tail.every((byte) => byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x00)) return bad('trailing_data', 'data after %%EOF');
    if (buf.lastIndexOf('startxref', eof) < 0) return bad('pdf_malformed', 'missing startxref');

    let doc;
    try {
      doc = await PDFDocument.load(buf, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    } catch (err) {
      return /encrypt/i.test(`${err && err.name} ${err && err.message}`) ? bad('pdf_encrypted', 'encrypted') : bad('pdf_malformed', 'cannot be parsed');
    }
    if (doc.isEncrypted) return bad('pdf_encrypted', 'encrypted');
    if (doc.getPageCount() < 1) return bad('pdf_malformed', 'no pages');

    const objects = doc.context.enumerateIndirectObjects();
    if (objects.length > MAX_OBJECTS) return bad('pdf_malformed', 'too many objects');
    const seen = new Set();
    for (const [, object] of objects) {
      const found = inspect(object, 0, seen);
      if (found) return found;
    }
    const trailer = inspect(doc.context.trailerInfo.Root && doc.context.lookup(doc.context.trailerInfo.Root), 0, seen);
    return trailer || null;
  } catch {
    return bad('pdf_malformed', 'cannot be inspected');
  }
}

module.exports = { validatePdf };
