// Whole-file structure checks for PNG, JPEG and WEBP. Magic bytes alone are not enough: these walk every chunk / segment, check
// lengths (and the PNG CRCs), require the file to end exactly where the format says it ends (so nothing can be appended, which also
// rules out image + archive / script polyglots) and cap the pixel count (decompression bombs).
// Each validator returns null when the file is well-formed, or { code, reason }. They never throw.
const MAX_PIXELS = 100 * 1024 * 1024;
const bad = (code, reason) => ({ code, reason });

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buf) {
  if (buf.length < 8 + 25 + 12 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return bad('png_malformed', 'bad signature');
  let pos = 8;
  let index = 0;
  let sawData = false;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) return bad('png_malformed', 'truncated chunk');
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return bad('png_malformed', 'bad chunk type');
    const end = pos + 12 + length;
    if (length > 0x7fffffff || end > buf.length) return bad('png_malformed', 'chunk exceeds file');
    if (buf.readUInt32BE(pos + 8 + length) !== crc32(buf.subarray(pos + 4, pos + 8 + length))) return bad('png_malformed', 'chunk checksum mismatch');
    if (index === 0) {
      if (type !== 'IHDR' || length !== 13) return bad('png_malformed', 'IHDR must be first');
      const width = buf.readUInt32BE(pos + 8);
      const height = buf.readUInt32BE(pos + 12);
      if (!width || !height || width * height > MAX_PIXELS) return bad('image_too_large', 'pixel count out of range');
    } else if (type === 'IHDR') return bad('png_malformed', 'second IHDR');
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData) return bad('png_malformed', 'bad IEND');
      return end === buf.length ? null : bad('trailing_data', 'bytes after IEND');
    }
    pos = end;
    index += 1;
  }
  return bad('png_malformed', 'missing IEND');
}

function validateJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return bad('jpeg_malformed', 'bad signature');
  let pos = 2;
  let sawFrame = false;
  let sawScan = false;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return bad('jpeg_malformed', 'expected a marker');
    while (buf[pos] === 0xff && pos < buf.length) pos += 1; // fill bytes
    const marker = buf[pos];
    pos += 1;
    if (marker === undefined) return bad('jpeg_malformed', 'truncated');
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) return bad('jpeg_malformed', 'EOI without image data');
      return pos === buf.length ? null : bad('trailing_data', 'bytes after EOI');
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length
    if (pos + 2 > buf.length) return bad('jpeg_malformed', 'truncated segment');
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) return bad('jpeg_malformed', 'segment exceeds file');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return bad('jpeg_malformed', 'bad frame header');
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      if (!width || !height || width * height > MAX_PIXELS) return bad('image_too_large', 'pixel count out of range');
      sawFrame = true;
    }
    pos += length;
    if (marker === 0xda) {
      if (!sawFrame) return bad('jpeg_malformed', 'scan before frame');
      sawScan = true;
      // entropy-coded data runs until the next real marker (not a stuffed 0xFF00 and not a restart marker)
      while (pos < buf.length) {
        if (buf[pos] === 0xff && pos + 1 < buf.length && buf[pos + 1] !== 0x00 && !(buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7) && buf[pos + 1] !== 0xff) break;
        pos += 1;
      }
    }
  }
  return bad('jpeg_malformed', 'missing EOI');
}

function validateWebp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return bad('webp_malformed', 'bad signature');
  if (buf.readUInt32LE(4) + 8 !== buf.length) return buf.readUInt32LE(4) + 8 < buf.length ? bad('trailing_data', 'bytes after the RIFF container') : bad('webp_malformed', 'RIFF size exceeds file');
  let pos = 12;
  let index = 0;
  while (pos < buf.length) {
    if (pos + 8 > buf.length) return bad('webp_malformed', 'truncated chunk');
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2);
    if (end > buf.length) return bad('webp_malformed', 'chunk exceeds file');
    if (index === 0 && !['VP8 ', 'VP8L', 'VP8X'].includes(fourcc)) return bad('webp_malformed', 'unexpected first chunk');
    if (index === 0 && fourcc === 'VP8X' && size >= 10) {
      const width = 1 + (buf[pos + 12] | (buf[pos + 13] << 8) | (buf[pos + 14] << 16));
      const height = 1 + (buf[pos + 15] | (buf[pos + 16] << 8) | (buf[pos + 17] << 16));
      if (width * height > MAX_PIXELS) return bad('image_too_large', 'pixel count out of range');
    }
    pos = end;
    index += 1;
  }
  return pos === buf.length && index > 0 ? null : bad('webp_malformed', 'chunks do not fill the container');
}

module.exports = { validatePng, validateJpeg, validateWebp, crc32 };
