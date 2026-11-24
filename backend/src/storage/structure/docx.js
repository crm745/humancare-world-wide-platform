// DOCX structure policy (Office Open XML = a ZIP). Only used where a non-patient workflow accepts Word documents.
// The ZIP is parsed by hand from its central directory (no extraction to disk, nothing executed), and rejected when:
//   - it is malformed, ZIP64, has data before / between / after its structures, or its local headers disagree with the directory;
//   - any entry is encrypted, uses an unsupported compression method, has an unsafe name (path traversal, absolute, backslash,
//     drive letter, NUL, duplicate) or an excessive compression ratio / size / count;
//   - the expected Office parts are missing ([Content_Types].xml, _rels/.rels, word/document.xml);
//   - it carries macros (vbaProject.bin, macro-enabled content types), ActiveX, embedded OLE objects, external-link parts, or
//     executable / script payloads by extension;
//   - a relationship points outside the package (remote templates and linked objects); plain hyperlinks are allowed.
// Returns null when acceptable, or { code, reason }. Never throws.
const zlib = require('zlib');

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_RATIO = 100;
const MAX_XML_BYTES = 1024 * 1024;
const REQUIRED = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
const FORBIDDEN_PART = [/vbaproject/i, /vbadata\.xml/i, /^word\/embeddings\//i, /(^|\/)activex\//i, /oleobject/i, /externallinks\//i, /(^|\/)customui\//i, /\.(exe|dll|com|bat|cmd|scr|js|jse|vbs|vbe|ps1|msi|jar|lnk|hta)$/i];
const bad = (code, reason) => ({ code, reason });

function readEntryText(buf, entry) {
  const start = entry.localOffset + 30 + buf.readUInt16LE(entry.localOffset + 26) + buf.readUInt16LE(entry.localOffset + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_XML_BYTES });
  if (data.length > MAX_XML_BYTES) throw new Error('too large');
  return data.toString('utf8');
}

function validateDocx(buf) {
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return bad('zip_malformed', 'no end of central directory');
    const disk = buf.readUInt16LE(eocd + 4);
    const cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length) return bad('trailing_data', 'data after the end of the archive');
    if (disk !== 0 || cdDisk !== 0 || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return bad('zip_unsupported', 'multi-disk or ZIP64 archives are not accepted');
    if (count > MAX_ENTRIES) return bad('zip_bomb', 'too many entries');
    if (cdOffset + cdSize !== eocd) return bad('zip_malformed', 'central directory does not end at the archive end');

    const entries = new Map();
    let pos = cdOffset;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      if (pos + 46 > eocd || buf.readUInt32LE(pos) !== 0x02014b50) return bad('zip_malformed', 'bad central directory entry');
      const flags = buf.readUInt16LE(pos + 8);
      const method = buf.readUInt16LE(pos + 10);
      const compressedSize = buf.readUInt32LE(pos + 20);
      const size = buf.readUInt32LE(pos + 24);
      const nameLength = buf.readUInt16LE(pos + 28);
      const next = pos + 46 + nameLength + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      if (next > eocd) return bad('zip_malformed', 'directory entry exceeds the directory');
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
      if (flags & 0x1 || flags & 0x40 || flags & 0x2000) return bad('zip_encrypted', 'encrypted entry');
      if (method !== 0 && method !== 8) return bad('zip_unsupported', 'unsupported compression method');
      if (!name || name.length > 255 || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((s) => s === '..' || s === '.')) return bad('zip_path_traversal', 'unsafe entry name');
      if (entries.has(name.toLowerCase())) return bad('zip_malformed', 'duplicate entry name');
      if (size > MAX_ENTRY_BYTES || (size > 100 * 1024 && size / Math.max(compressedSize, 1) > MAX_RATIO)) return bad('zip_bomb', 'excessive compression ratio or entry size');
      total += size;
      if (total > MAX_TOTAL_BYTES) return bad('zip_bomb', 'excessive total size');
      if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) return bad('zip_malformed', 'bad local header');
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      if (buf.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength) !== name) return bad('zip_malformed', 'local header disagrees with the directory');
      const dataEnd = localOffset + 30 + localNameLength + buf.readUInt16LE(localOffset + 28) + compressedSize;
      if (dataEnd > cdOffset) return bad('zip_malformed', 'entry data exceeds the archive');
      entries.set(name.toLowerCase(), { name, method, compressedSize, localOffset });
      pos = next;
    }
    if (pos !== eocd) return bad('zip_malformed', 'unexpected data in the central directory');

    for (const required of REQUIRED) if (!entries.has(required.toLowerCase())) return bad('docx_malformed', `missing part ${required}`);
    for (const { name } of entries.values()) {
      if (FORBIDDEN_PART.some((rule) => rule.test(name))) return bad('docx_active_content', `forbidden part: ${name}`);
    }

    const contentTypes = readEntryText(buf, entries.get('[content_types].xml'));
    if (/macroEnabled|vbaProject|activeX|oleObject/i.test(contentTypes)) return bad('docx_active_content', 'macro, ActiveX or OLE content type');
    if (!/wordprocessingml\.(document|template)\.main\+xml/i.test(contentTypes) || /wordprocessingml\.template\.main/i.test(contentTypes)) return bad('docx_malformed', 'not a Word document');
    for (const entry of entries.values()) {
      if (!entry.name.toLowerCase().endsWith('.rels')) continue;
      const xml = readEntryText(buf, entry);
      for (const rel of xml.match(/<Relationship\b[^>]*>/gi) || []) {
        if (/TargetMode\s*=\s*"External"/i.test(rel) && !/Type\s*=\s*"[^"]*\/hyperlink"/i.test(rel)) return bad('docx_active_content', 'external relationship (remote template or linked object)');
      }
    }
    return null;
  } catch {
    return bad('docx_malformed', 'cannot be inspected');
  }
}

module.exports = { validateDocx };
