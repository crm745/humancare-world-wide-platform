// Renders the request summary PDF and gives back its text, for tests.
//
// pdfkit writes each line as "[<hex> kerning <hex> ...] TJ" inside a deflated content stream, so
// the text is rebuilt from the hex groups. A "label: value" row is two pieces: the label, then
// the value (see valueAfter).
const zlib = require('zlib');
const { PassThrough } = require('stream');
const { streamRequestSummaryPdf } = require('../../src/modules/requests/request-summary.pdf');

function pdfLines(pdf) {
  const lines = [];
  let from = 0;
  for (;;) {
    const at = pdf.indexOf('stream', from);
    if (at === -1) break;
    const end = pdf.indexOf('endstream', at + 6);
    if (end === -1) break;
    let start = at + 6;
    if (pdf[start] === 13) start += 1;
    if (pdf[start] === 10) start += 1;
    from = end + 9;
    let content;
    try { content = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1'); } catch { continue; }
    for (const array of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      lines.push([...array[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join(''));
    }
  }
  return lines;
}

function renderPdfLines(request) {
  return new Promise((resolve, reject) => {
    const res = new PassThrough();
    res.setHeader = () => {};
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(pdfLines(Buffer.concat(chunks))));
    res.on('error', reject);
    streamRequestSummaryPdf(res, request);
  });
}

// The text printed after a row's label ("Date Of Service:" -> "Tue Nov 10 2026"), or undefined.
const valueAfter = (lines, label) => {
  const at = lines.indexOf(label);
  return at === -1 ? undefined : (lines[at + 1] || '').trim();
};

module.exports = { pdfLines, renderPdfLines, valueAfter };
