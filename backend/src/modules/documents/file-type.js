// What a file REALLY is, from its own first bytes (never from the name or the type the client declared). Only these four
// kinds may be shared with Bitrix24: PDF, JPEG, PNG and WEBP. Everything else (Word documents included) gives null.
const SHAREABLE_TYPES = Object.freeze(['pdf', 'jpeg', 'png', 'webp']);
const EXTENSION = Object.freeze({ pdf: '.pdf', jpeg: '.jpg', png: '.png', webp: '.webp' });

function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

module.exports = { detectFileType, SHAREABLE_TYPES, EXTENSION };
