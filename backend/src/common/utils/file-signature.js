// A light content check for uploaded files: do the first bytes look like the kind of file the client SAID it was?
// Pure (no I/O, no dependency). It is a stronger check than trusting the declared MIME type, not a complete one: a ZIP header cannot tell a
// DOCX from another ZIP-based file, and it says nothing about whether a file is harmless (no malware scanning is done here).
const KINDS = {
  pdf: { mime: ['application/pdf'], ext: ['.pdf'] },
  jpeg: { mime: ['image/jpeg'], ext: ['.jpg', '.jpeg'] },
  png: { mime: ['image/png'], ext: ['.png'] },
  webp: { mime: ['image/webp'], ext: ['.webp'] },
  doc: { mime: ['application/msword'], ext: ['.doc'] },
  docx: { mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ext: ['.docx'] },
};

// How many leading bytes detectFileKind needs.
const SIGNATURE_BYTES = 12;

const startsWith = (buffer, bytes) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

// 'pdf' | 'jpeg' | 'png' | 'webp' | 'doc' | 'docx' | null (anything else), from the first bytes of the file.
function detectFileKind(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12 && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc'; // OLE2 container
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // ZIP container
  return null;
}

const extensionOf = (name) => {
  const text = String(name || '').toLowerCase();
  const dot = text.lastIndexOf('.');
  return dot === -1 ? '' : text.slice(dot);
};

// True when the content, the declared MIME type and the file name's extension all name the same kind.
function contentMatchesDeclared(buffer, mimetype, filename) {
  const kind = detectFileKind(buffer);
  if (!kind) return false;
  const rule = KINDS[kind];
  return rule.mime.includes(mimetype) && rule.ext.includes(extensionOf(filename));
}

module.exports = { SIGNATURE_BYTES, detectFileKind, contentMatchesDeclared, extensionOf };
