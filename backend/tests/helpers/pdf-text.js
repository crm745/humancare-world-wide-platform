// Renders the request summary PDF and gives back its text, for tests.
//
// The PDF embeds subset TrueType fonts (Noto Sans for every script), so pdfkit writes each line as "[<glyph ids> kerning <glyph ids> ...] TJ" inside a deflated content stream: the glyph ids are
// not characters. The text is rebuilt the way a PDF reader does it: each font has a ToUnicode map (glyph id -> text), and the content stream says which font is current ("/F2 10.5 Tf").
// A fixed-font PDF (no ToUnicode map) is still read as Latin-1, so older fixtures keep working. A "label: value" row is two pieces: the label, then the value (see valueAfter).
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { streamRequestSummaryPdf } = require('../../src/modules/requests/request-summary.pdf');

const latin = (buffer) => buffer.toString('latin1');

// Every stream of the PDF, inflated when it is deflated: { objectNumber -> Buffer } for the object that owns it.
function streamsOf(pdf) {
  const streams = new Map();
  const text = latin(pdf);
  for (const match of text.matchAll(/(\d+) 0 obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    let body = pdf.subarray(start, end);
    try { body = zlib.inflateSync(body); } catch { /* not deflated: keep as it is */ }
    streams.set(Number(match[1]), { dictionary: match[2], body });
  }
  return streams;
}

const hexToText = (hex) => {
  const bytes = Buffer.from(hex, 'hex');
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
  return out;
};

// A ToUnicode CMap: Map(code -> text).
function parseCMap(source) {
  const map = new Map();
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(pair[1], 16), hexToText(pair[2]));
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // the array form (what pdfkit writes): <first> <last> [<text of first> <text of next> ...]
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
      const from = parseInt(range[1], 16);
      // an item can hold several code units separated by a space ("<0066 006c>" is "fl"): reading it as nothing would shift every glyph after it
      [...range[3].matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((item, offset) => map.set(from + offset, hexToText(item[1].replace(/\s+/g, ''))));
    }
    // the incrementing form: <first> <last> <text of first> (the array ranges are taken out first, or their items would read as ranges)
    for (const range of block[1].replace(/<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\[[^\]]*\]/g, '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = parseInt(range[1], 16);
      const to = parseInt(range[2], 16);
      const startText = hexToText(range[3]);
      for (let code = from; code <= to; code += 1) map.set(code, startText.slice(0, -1) + String.fromCharCode(startText.charCodeAt(startText.length - 1) + (code - from)));
    }
  }
  return map;
}

function pdfLines(pdf) {
  const streams = streamsOf(pdf);
  const objects = latin(pdf);
  // font resource name (F1, F2, ...) -> its ToUnicode map
  const fontMaps = new Map();
  for (const match of objects.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
    const dict = new RegExp(`(?:^|\\n)${match[2]} 0 obj\\s*<<([\\s\\S]*?)>>\\s*endobj`).exec(objects);
    const toUnicode = dict && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dict[1]);
    const stream = toUnicode && streams.get(Number(toUnicode[1]));
    if (stream) fontMaps.set(match[1], parseCMap(latin(stream.body)));
  }
  const lines = [];
  for (const { body } of streams.values()) {
    const content = latin(body);
    if (!/\bTJ\b/.test(content)) continue;
    let current = null;
    for (const token of content.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (token[1]) { current = token[1]; continue; }
      const map = current && fontMaps.get(current);
      const pieces = [...token[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => {
        if (!map) return Buffer.from(hex[1], 'hex').toString('latin1');
        let out = '';
        for (let i = 0; i + 3 < hex[1].length + 1; i += 4) out += map.get(parseInt(hex[1].slice(i, i + 4), 16)) ?? '';
        return out;
      });
      lines.push(pieces.join(''));
    }
  }
  return lines;
}

// Which glyphs each embedded font actually draws: { "NotoSansDevanagari-Regular": Set(glyph ids) }. Glyph 0 is the font's ".notdef" (the empty box): a script drawn with its own font and no glyph 0
// proves that every character of it was found in the font.
function fontUsage(pdf) {
  const streams = streamsOf(pdf);
  const objects = latin(pdf);
  const names = new Map();
  for (const match of objects.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
    const dict = new RegExp(`(?:^|\\n)${match[2]} 0 obj\\s*<<([\\s\\S]*?)>>\\s*endobj`).exec(objects);
    const base = dict && /\/BaseFont\s+\/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/.exec(dict[1]);
    if (base) names.set(match[1], base[1]);
  }
  const usage = {};
  for (const { body } of streams.values()) {
    const content = latin(body);
    let current = null;
    for (const token of content.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (token[1]) { current = names.get(token[1]) || null; continue; }
      if (!current) continue;
      usage[current] = usage[current] || new Set();
      for (const hex of token[2].matchAll(/<([0-9a-fA-F]*)>/g)) for (let i = 0; i + 3 < hex[1].length + 1; i += 4) usage[current].add(parseInt(hex[1].slice(i, i + 4), 16));
    }
  }
  return usage;
}

function renderPdfLines(request) {
  return new Promise((resolve, reject) => {
    const res = new PassThrough();
    res.setHeader = () => {};
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(pdfLines(Buffer.concat(chunks))));
    res.on('error', reject);
    Promise.resolve(streamRequestSummaryPdf(res, request)).catch(reject);
  });
}

// The whole PDF as a Buffer (for the checks on the file itself: its header, its size, its fonts, its metadata).
function renderPdfBuffer(request) {
  return new Promise((resolve, reject) => {
    const res = new PassThrough();
    const headers = {};
    res.setHeader = (name, value) => { headers[name] = value; };
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers }));
    res.on('error', reject);
    Promise.resolve(streamRequestSummaryPdf(res, request)).catch(reject);
  });
}

// The text printed after a row's label ("Date Of Service:" -> "Tue Nov 10 2026"), or undefined.
const valueAfter = (lines, label) => {
  const at = lines.indexOf(label);
  return at === -1 ? undefined : (lines[at + 1] || '').trim();
};

module.exports = { pdfLines, renderPdfLines, renderPdfBuffer, fontUsage, valueAfter };
