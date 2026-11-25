// Draws the request summary PDF from the document model (summary-model.js): the Humancare World Wide header with the logo, the title, a meta panel (Request ID, status, generated and submitted
// dates), the sections as two-column tables with wrapping text, the uploaded documents, the timeline, and on every page a running header and "Page X of Y". A4, 48 pt margins.
//
// TEXT. Every text is cut into runs by script (pdf/fonts.js) and each run is drawn with the Noto font of its script, so what the patient typed in Hindi, Marathi, Gujarati, Telugu or Arabic is drawn,
// not turned into boxes. Lines are broken HERE, not by the PDF library: each line is measured with the real fonts and drawn as ONE piece, which is what lets a right-to-left (Arabic) phrase keep its
// word order and its spaces (the library's own wrapping draws each word separately and loses them). A word wider than the column is broken by characters. A row is kept together on one page when it
// fits on one; a longer text flows over as many pages as it needs. The label and the value of a row are separate pieces of text.
const PDFDocument = require('pdfkit');
const path = require('path');
const { BRAND_PRIMARY } = require('../../../common/constants/brand');
const { fontPath, splitRuns } = require('./fonts');

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { left: 48, right: 48, top: 48, bottom: 60 };
const CONTENT_W = PAGE.width - MARGIN.left - MARGIN.right;
const LABEL_W = 150;
const GAP = 14;
const VALUE_X = MARGIN.left + LABEL_W + GAP;
const VALUE_W = PAGE.width - MARGIN.right - VALUE_X;
const FOOTER_Y = PAGE.height - 42;
const LATER_PAGE_TOP = 86;
const LINE_FACTOR = 1.42;
const COLORS = { navy: '#0D2340', muted: '#5B6B84', faint: '#97A4B8', line: '#E4E9F2', panel: '#F6F8FC', soft: '#EEF1F6', brand: BRAND_PRIMARY };
const LOGO = path.join(__dirname, '..', '..', '..', 'assets', 'brand', 'logo-full.png');
const LOGO_W = 66;
const LOGO_H = Math.round((LOGO_W * 518) / 900);
const SIZE = { label: 9.5, value: 10.5, sub: 8.5 };

// The same colours as the app's status pills (apps/mobile/src/components/ui.js PILL).
const BADGES = Object.freeze({
  submitted: { bg: '#FFF1D6', fg: '#8A5A00' },
  scheduled: { bg: '#EDE7FB', fg: '#5B3FB5' },
  in_progress: { bg: '#E3E7FA', fg: BRAND_PRIMARY },
  completed: { bg: '#DDF3E6', fg: '#1E7F45' },
  cancelled: { bg: '#ECEEF2', fg: '#5B6B84' },
});

// ---- text primitives ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The runs of a line as they are drawn. Inside an Arabic run a space is drawn as a no-break space: the plain space of the Arabic font loses its width in the library's right-to-left drawing.
const drawable = (text) => splitRuns(text).map((run) => (run.script === 'arabic' ? { ...run, text: run.text.replace(/ /g, ' ') } : run));

function widthOf(doc, text, size, bold) {
  let total = 0;
  for (const run of drawable(text)) {
    doc.font(fontPath(run.script, bold)).fontSize(size);
    total += doc.widthOfString(run.text);
  }
  return total;
}

// Breaks `text` into lines no wider than `width` (spaces are the break points; a line break in the text is kept; a word wider than the column is cut by characters).
function wrapLines(doc, text, width, size, bold = false) {
  const lines = [];
  const fits = (candidate) => widthOf(doc, candidate, size, bold) <= width;
  const pushLong = (word) => {
    let piece = '';
    for (const ch of Array.from(word)) {
      if (piece !== '' && !fits(piece + ch)) { lines.push(piece); piece = ch; } else piece += ch;
    }
    return piece;
  };
  for (const paragraph of String(text === null || text === undefined ? '' : text).split('\n')) {
    if (paragraph === '') { lines.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (current !== '' && !fits(candidate)) {
        lines.push(current);
        current = fits(word) ? word : pushLong(word);
      } else if (current === '' && !fits(word)) {
        current = pushLong(word);
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

// One line, as one piece per run (the runs follow each other on the same baseline).
function drawLine(doc, line, x, y, { size, color, bold = false }) {
  const runs = drawable(line);
  if (runs.length === 0) return;
  doc.fillColor(color).fontSize(size);
  runs.forEach((run, i) => {
    doc.font(fontPath(run.script, bold));
    const options = { continued: i < runs.length - 1, lineBreak: false };
    if (i === 0) doc.text(run.text, x, y, options);
    else doc.text(run.text, options);
  });
}

const lineHeight = (size) => size * LINE_FACTOR;

function renderSummaryPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margins: { top: MARGIN.top, bottom: MARGIN.bottom, left: MARGIN.left, right: MARGIN.right },
      bufferPages: true,
      info: { Title: `Humancare World Wide - Request Summary ${model.reference}`, Author: 'Humancare World Wide', Subject: 'Request Summary', Creator: 'Humancare World Wide' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bottom = () => PAGE.height - MARGIN.bottom;
    let y = 0; // the cursor: where the next thing is drawn on the current page

    // ---- the running header of the pages after the first
    const drawRunningHeader = () => {
      doc.font(fontPath('latin', true)).fontSize(9).fillColor(COLORS.brand).text('Humancare World Wide', MARGIN.left, 40, { lineBreak: false });
      doc.font(fontPath('latin')).fontSize(8.5).fillColor(COLORS.muted).text(`Request ${model.reference}  ·  Request Summary`, MARGIN.left, 41, { width: CONTENT_W, align: 'right', lineBreak: false });
      doc.moveTo(MARGIN.left, 60).lineTo(PAGE.width - MARGIN.right, 60).lineWidth(0.8).strokeColor(COLORS.line).stroke();
    };
    let firstPage = true;
    doc.on('pageAdded', () => { if (!firstPage) drawRunningHeader(); });
    const newPage = () => { doc.addPage(); y = LATER_PAGE_TOP; return y; };
    const ensureRoom = (needed) => { if (y + needed > bottom()) newPage(); };

    // ---- the first page's header, title and meta panel
    const drawFirstPage = () => {
      doc.image(LOGO, MARGIN.left, 34, { width: LOGO_W });
      doc.font(fontPath('latin', true)).fontSize(15).fillColor(COLORS.brand).text('Humancare World Wide', MARGIN.left + LOGO_W + 14, 40, { lineBreak: false });
      doc.font(fontPath('latin')).fontSize(8.5).fillColor(COLORS.muted).text('Global Medical Assistance Company', MARGIN.left + LOGO_W + 14, 60, { lineBreak: false });
      doc.font(fontPath('latin', true)).fontSize(7.5).fillColor(COLORS.faint).text('REQUEST SUMMARY', MARGIN.left, 40, { width: CONTENT_W, align: 'right', characterSpacing: 1.2, lineBreak: false });
      doc.font(fontPath('latin', true)).fontSize(12).fillColor(COLORS.navy).text(model.reference, MARGIN.left, 52, { width: CONTENT_W, align: 'right', lineBreak: false });
      const ruleY = 34 + LOGO_H + 10;
      doc.moveTo(MARGIN.left, ruleY).lineTo(PAGE.width - MARGIN.right, ruleY).lineWidth(1.6).strokeColor(COLORS.brand).stroke();

      y = ruleY + 20;
      doc.font(fontPath('latin', true)).fontSize(21).fillColor(COLORS.navy).text('Request Summary', MARGIN.left, y, { lineBreak: false });
      y += 30;
      for (const line of wrapLines(doc, model.serviceName, CONTENT_W, 11.5)) {
        drawLine(doc, line, MARGIN.left, y, { size: 11.5, color: COLORS.muted });
        y += lineHeight(11.5);
      }
      y += 8;

      // the meta panel: Request ID and Generated on the left, Status and Submitted on the right
      const panelH = 88;
      doc.roundedRect(MARGIN.left, y, CONTENT_W, panelH, 8).fillAndStroke(COLORS.panel, COLORS.line);
      const colW = CONTENT_W / 2;
      const cell = (cx, cy, label, value, badge) => {
        doc.font(fontPath('latin')).fontSize(8.5).fillColor(COLORS.muted).text(label, cx, cy, { lineBreak: false });
        if (badge) {
          const b = BADGES[model.statusKey] || BADGES.submitted;
          doc.font(fontPath('latin', true)).fontSize(9);
          const w = doc.widthOfString(value) + 20;
          doc.roundedRect(cx, cy + 15, w, 19, 9.5).fill(b.bg);
          doc.fillColor(b.fg).text(value, cx + 10, cy + 19.2, { lineBreak: false });
        } else {
          const first = wrapLines(doc, value, colW - 28, 11, true)[0] || '';
          drawLine(doc, first, cx, cy + 15, { size: 11, color: COLORS.navy, bold: true });
        }
      };
      const left = MARGIN.left + 16;
      const right = MARGIN.left + colW + 8;
      cell(left, y + 10, 'Request ID:', model.reference);
      cell(right, y + 10, 'Status:', model.statusLabel, true);
      cell(left, y + 50, 'Generated:', model.generatedAt || '—');
      cell(right, y + 50, 'Submitted:', model.submittedAt || '—');
      y += panelH + 24;
    };

    // ---- sections and rows
    const sectionTitle = (title, firstRowHeight = 28) => {
      ensureRoom(26 + firstRowHeight);
      doc.rect(MARGIN.left, y + 1, 3, 14).fill(COLORS.brand);
      doc.font(fontPath('latin', true)).fontSize(12.5).fillColor(COLORS.navy).text(title, MARGIN.left + 11, y, { lineBreak: false });
      doc.moveTo(MARGIN.left, y + 21).lineTo(PAGE.width - MARGIN.right, y + 21).lineWidth(0.8).strokeColor(COLORS.line).stroke();
      y += 28;
    };
    const measureRow = (row) => {
      const labelLines = wrapLines(doc, row.label, LABEL_W, SIZE.label);
      const valueLines = wrapLines(doc, row.value, VALUE_W, SIZE.value);
      const subLines = row.sub ? wrapLines(doc, row.sub, VALUE_W, SIZE.sub) : [];
      const height = Math.max(labelLines.length * lineHeight(SIZE.label), valueLines.length * lineHeight(SIZE.value) + (subLines.length ? subLines.length * lineHeight(SIZE.sub) + 2 : 0));
      return { labelLines, valueLines, subLines, height };
    };
    // Lines flow down the page and continue on the next one when they reach the bottom margin; returns where they ended.
    const flow = (lines, x, size, color, bold = false) => {
      let end = y;
      for (const line of lines) {
        if (end + lineHeight(size) > bottom()) { newPage(); end = y; }
        drawLine(doc, line, x, end, { size, color, bold });
        end += lineHeight(size);
      }
      return end;
    };
    const drawRow = (row) => {
      const m = measureRow(row);
      if (m.height + 14 <= bottom() - LATER_PAGE_TOP) ensureRoom(m.height + 12); // fits on a page: keep it whole
      const startPage = doc.bufferedPageRange().count;
      const top = y;
      let labelEnd = top;
      m.labelLines.forEach((line, i) => { drawLine(doc, line, MARGIN.left, top + i * lineHeight(SIZE.label), { size: SIZE.label, color: COLORS.muted }); labelEnd = top + (i + 1) * lineHeight(SIZE.label); });
      let end = flow(m.valueLines, VALUE_X, SIZE.value, COLORS.navy);
      if (m.subLines.length) {
        y = end + 2;
        end = flow(m.subLines, VALUE_X, SIZE.sub, COLORS.muted);
      }
      if (doc.bufferedPageRange().count === startPage) end = Math.max(end, labelEnd);
      const lineY = end + 6;
      doc.moveTo(MARGIN.left, lineY).lineTo(PAGE.width - MARGIN.right, lineY).lineWidth(0.5).strokeColor(COLORS.soft).stroke();
      y = lineY + 7;
    };
    const drawTable = (title, rowList) => {
      sectionTitle(title, rowList.length ? Math.min(measureRow(rowList[0]).height, bottom() - LATER_PAGE_TOP) + 12 : 28);
      rowList.forEach(drawRow);
      y += 10;
    };

    drawFirstPage();
    firstPage = false;
    for (const section of model.sections) drawTable(section.title, section.rows);

    if (model.documents !== null) {
      if (model.documents.length === 0) {
        sectionTitle('Uploaded Documents', 24);
        y = flow(['No documents have been uploaded for this request.'], MARGIN.left, SIZE.value, COLORS.muted) + 10;
      } else {
        drawTable('Uploaded Documents', model.documents.map((d, i) => ({ label: `Document ${i + 1}:`, value: d.name, sub: d.meta })));
      }
    }
    if (model.timeline.length) {
      drawTable('Timeline', model.timeline.map((ev) => ({ label: ev.when || '', value: ev.note ? `${ev.stage}  (${ev.note})` : ev.stage })));
    }

    // ---- the closing line, and the footer with page numbers on every page
    ensureRoom(lineHeight(8.5) * 2);
    flow(wrapLines(doc, 'This summary lists the details submitted for this request. For the latest status, open the request in the Humancare World Wide app.', CONTENT_W, 8.5), MARGIN.left, 8.5, COLORS.muted);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // the footer sits in the bottom margin: drawing there must not start a new page
      doc.moveTo(MARGIN.left, FOOTER_Y - 8).lineTo(PAGE.width - MARGIN.right, FOOTER_Y - 8).lineWidth(0.6).strokeColor(COLORS.line).stroke();
      doc.font(fontPath('latin')).fontSize(7.5).fillColor(COLORS.faint)
        .text('"Your Care, Our Responsibility" — humancareworldwide.com', MARGIN.left, FOOTER_Y, { width: CONTENT_W * 0.7, lineBreak: false });
      doc.font(fontPath('latin', true)).fontSize(8).fillColor(COLORS.muted)
        .text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN.left, FOOTER_Y, { width: CONTENT_W, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { renderSummaryPdf, wrapLines, widthOf, PAGE, MARGIN, COLORS };
