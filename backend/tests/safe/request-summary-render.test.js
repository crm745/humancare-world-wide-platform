/* global describe, test, expect, jest */
// The request summary PDF as a FILE: a real PDF for each of the eight services, with the logo, the title, the Request ID, the generated date, the patient and service information, the status and the
// service-specific details; readable labels, wrapping, multi-page layouts, page numbers; Unicode text drawn with embedded fonts; nothing internal inside the file (not even its metadata); and the
// headers it is sent with. Synthetic requests only. No database, no network.
const zlib = require('zlib');
const { renderPdfLines, renderPdfBuffer, fontUsage, valueAfter } = require('../helpers/pdf-text');
const { SECRET_TEXTS, EIGHT, services, wrap } = require('./helpers/summary-fixtures');

jest.setTimeout(60000);
const all = services();
const pagesOf = (pdf) => Number((/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(pdf.toString('latin1')) || [])[1]);
const inflated = (pdf) => {
  const text = pdf.toString('latin1');
  const parts = [text];
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const end = text.indexOf('endstream', m.index);
    try { parts.push(zlib.inflateSync(pdf.subarray(m.index + m[0].length, end)).toString('latin1')); } catch { /* not deflated */ }
  }
  return parts.join('\n');
};
const lines = (request) => renderPdfLines(request);

describe('a real PDF for each of the eight services', () => {
  test.each(Object.entries(EIGHT))('%s: a valid PDF with the header, the meta data, the sections and the footer', async (_name, key) => {
    const { buffer } = await renderPdfBuffer(all[key]);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.subarray(-6).toString('latin1')).toContain('%%EOF');
    expect(buffer.length).toBeGreaterThan(15000);
    expect(buffer.length).toBeLessThan(400000);
    expect(pagesOf(buffer)).toBeGreaterThanOrEqual(1);
    const text = await lines(all[key]);
    for (const expected of ['HumanCare Worldwide', 'Global Medical Assistance Company', 'Request Summary', 'Request ID:', 'REQ-1042', 'Status:', 'In progress', 'Generated:', 'Submitted:', 'Patient Information', 'Service Information', 'Service:', all[key].serviceType]) {
      expect({ key, expected, found: text.includes(expected) }).toEqual({ key, expected, found: true });
    }
    expect(text.some((l) => /^\d{2} [A-Z][a-z]{2} 20\d\d, \d\d:\d\d UTC$/.test(l))).toBe(true); // the generated date
    expect(text.some((l) => /^Page 1 of \d+$/.test(l))).toBe(true);
    expect(text).toContain('"Your Care, Our Responsibility" — humancareworldwide.com');
  });
  test.each(Object.entries(EIGHT))('%s: the logo is embedded (one image) and the fonts are embedded TrueType (no built-in font)', async (_name, key) => {
    const { buffer } = await renderPdfBuffer(all[key]);
    const text = buffer.toString('latin1');
    expect(text).toMatch(/\/Subtype \/Image/);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
    expect(text).toMatch(/\/FontFile2/);
    expect(text).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/);
  });
  test('the service-specific rows come out as label / value pairs (one example from each layout)', async () => {
    const expectations = {
      privatecharter: [['Date Of Service:', 'Sat Dec 05 2026'], ['Urgency:', 'Urgent (24h)'], ['From:', 'Mumbai, Maharashtra, India'], ['Care level:', 'ICU / Critical'], ['Country:', 'United Arab Emirates']],
      commercialair: [['Travel type:', 'Stretcher'], ['Required on board:', 'Oxygen (3 LPM), Cardiac monitor']],
      ground: [['To:', 'Ruby Hall Clinic, Pune'], ['Urgency:', 'Critical (within 6h)']],
      tele: [['Consultation type:', 'House Call'], ['Visit date:', 'Tue Dec 01 2026']],
      homecare: [['Care Requirement:', '12 Hours'], ['Oxygen:', 'Yes (3 LPM)'], ['Medical History:', 'Diabetes and hypertension.']],
      mortal: [["Deceased Person's Name:", 'Suresh Kale'], ['Date of death:', 'Sun Nov 15 2026'], ['Preferred transfer date:', 'Fri Nov 20 2026']],
      corporate: [['Company Name:', 'Acme Industries Pvt Ltd'], ['No. of Employees:', '250'], ['Office Country:', 'India']],
      marine: [['Service scope:', 'International'], ['Origin:', 'Port of Mumbai'], ['Oxygen:', 'Yes (4 LPM)']],
      medvalue: [['Specialty:', 'Oncology'], ['Current city:', 'Hyderabad'], ['Destination city:', 'Singapore']],
    };
    for (const [key, pairs] of Object.entries(expectations)) {
      const text = await lines(all[key]);
      for (const [label, value] of pairs) expect({ key, label, value: valueAfter(text, label) }).toEqual({ key, label, value });
    }
  });
  test('the uploaded documents and the timeline are printed; Teleconsultation and Corporate Medical Solutions have no documents section', async () => {
    const ground = await lines(all.ground);
    for (const expected of ['Uploaded Documents', 'Document 1:', 'discharge-summary.pdf', 'Document 2:', 'ct-scan.jpg', 'Timeline']) expect(ground).toContain(expected);
    expect(ground.some((l) => l.startsWith('Request submitted'))).toBe(true);
    expect(ground).toContain('20 Nov 2026, 09:15 UTC');
    for (const key of ['tele', 'corporate']) expect(await lines(all[key])).not.toContain('Uploaded Documents');
    expect(await lines(wrap({ serviceType: 'Ground Ambulance', serviceKey: 'ground', patientName: 'X', origin: 'A', destination: 'B' }, { case: { documents: [], stageEvents: [] } }))).toContain('No documents have been uploaded for this request.');
  });
});

describe('English only, whatever the patient typed; the patient\'s own text is preserved and drawn', () => {
  const typed = (extra) => ({ ...all.ground, ...extra });
  test('Hindi, Marathi, Gujarati, Telugu and Arabic text is drawn with its own embedded font, and every character is found in it (no empty-box glyph)', async () => {
    const samples = { NotoSansDevanagari: 'आशा नायर, सुरेश काळे', NotoSansGujarati: 'કિરણ પટેલ', NotoSansTelugu: 'అనిల్ కుమార్', NotoSansArabic: 'أحمد علي' };
    for (const [font, name] of Object.entries(samples)) {
      const { buffer } = await renderPdfBuffer(typed({ patientName: name }));
      const usage = fontUsage(buffer);
      expect({ font, embedded: Boolean(usage[`${font}-Regular`]) }).toEqual({ font, embedded: true });
      expect({ font, notdef: usage[`${font}-Regular`].has(0) }).toEqual({ font, notdef: false }); // glyph 0 is the font's empty box
      expect(buffer.toString('latin1')).toMatch(new RegExp(`/BaseFont /[A-Z]{6}\\+${font}-Regular`));
    }
  });
  test('the text is found as the patient wrote it where one glyph is one character (Latin, Arabic and Devanagari letters)', async () => {
    const read = (await lines(typed({ patientName: 'आशा नायर', origin: 'Flat 4B, Pune 411001', destination: 'أحمد' }))).join('\n');
    for (const piece of ['Flat 4B, Pune 411001', 'आ', 'श', 'न', 'य', 'र', 'أ', 'ح', 'م', 'د']) expect(read).toContain(piece);
  });
  test('a typed symbol that none of our fonts has does not break the document', async () => {
    const { buffer } = await renderPdfBuffer(typed({ patientName: 'Name \u{1F3E5}\u{13000} end' }));
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
  test('the labels, the status, the dates and the footer are English for the same request regardless of the script of the text', async () => {
    const english = await lines(typed({ patientName: 'John Doe' }));
    const arabic = await lines(typed({ patientName: 'أحمد علي', description: 'ألم في الصدر' }));
    const labels = (l) => l.filter((x) => /:$/.test(x) || /^(Patient|Service|Request) /.test(x));
    expect(labels(arabic)).toEqual(labels(english));
    expect(arabic).toContain('Patient Information');
    expect(arabic).toContain('In progress');
  });
  test('mixed text keeps both parts: Latin words and digits next to Devanagari', async () => {
    const read = (await lines(typed({ origin: 'Flat 4B, मुंबई 400001' }))).join('');
    expect(read).toContain('Flat 4B,');
    expect(read).toContain('400001');
    for (const char of ['म', 'ब', 'ई']) expect(read).toContain(char);
  });
  test('the PDF does not depend on any language: the same bytes of text for the same request however it is asked for', async () => {
    const a = await lines(all.ground);
    const b = await lines({ ...all.ground, lang: 'AR', language: 'hi', locale: 'te-IN', preferredLanguage: 'GU' });
    expect(b).toEqual(a);
  });
});

describe('layout: margins, wrapping, page numbers and multi-page documents', () => {
  const long = (n) => 'The patient has a long history of heart disease with several admissions. '.repeat(n).trim();
  test('a long text wraps inside the value column over many lines and the document grows to several pages with "Page X of Y" on every page', async () => {
    const request = { ...all.ground, description: long(250) }; // about 18,000 characters: under the limit the PDF keeps whole
    const { buffer } = await renderPdfBuffer(request);
    const pages = pagesOf(buffer);
    expect(pages).toBeGreaterThanOrEqual(3);
    const text = await lines(request);
    for (let page = 1; page <= pages; page += 1) expect(text).toContain(`Page ${page} of ${pages}`);
    expect(text.filter((l) => /^Page \d+ of \d+$/.test(l))).toHaveLength(pages);
    // the running header on every page after the first
    expect(text.filter((l) => l === 'Request REQ-1042  ·  Request Summary')).toHaveLength(pages - 1);
    // wrapped: no single line is wider than the column allows (about 75 characters at this size), and the text is all there
    const body = text.filter((l) => l.includes('history of heart disease'));
    expect(body.length).toBeGreaterThan(20);
    for (const line of body) expect(line.length).toBeLessThan(95);
    expect(text.join(' ').split('admissions.').length - 1).toBe(250); // every sentence is there, none lost at a page break
  });
  test('a word wider than the column is broken instead of running off the page', async () => {
    const request = { ...all.ground, patientName: 'W'.repeat(300) };
    const text = await lines(request);
    const pieces = text.filter((l) => /^W+$/.test(l.trim()));
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.join('')).toHaveLength(300);
  });
  test('an extremely long text (the 64 KB description limit) is bounded: it ends with a note and the file stays small', async () => {
    const { buffer } = await renderPdfBuffer({ ...all.ground, description: 'long text '.repeat(6500) });
    expect(buffer.length).toBeLessThan(2500000);
    const text = (await lines({ ...all.ground, description: 'long text '.repeat(6500) })).join(' ');
    expect(text).toContain('(text shortened)');
  });
  test('many documents with long, multilingual names fill several pages and every one is listed in order', async () => {
    const documents = Array.from({ length: 60 }, (_, i) => ({ name: `Report ${i + 1} — ${i % 2 ? 'रिपोर्ट' : 'scan'} ${'long name '.repeat(i % 6)}.pdf`, type: 'Medical Report', fileSizeBytes: 1000 * (i + 1), uploadedAt: '2026-11-20T09:20:00.000Z' }));
    const request = { ...all.ground, case: { documents, stageEvents: [] } };
    const { buffer } = await renderPdfBuffer(request);
    expect(pagesOf(buffer)).toBeGreaterThanOrEqual(3);
    const text = await lines(request);
    const labels = text.filter((l) => /^Document \d+:$/.test(l));
    expect(labels).toHaveLength(60);
    expect(labels).toEqual(Array.from({ length: 60 }, (_, i) => `Document ${i + 1}:`));
  });
  test('a row is kept together: no label is left alone at the bottom of a page and its value on the next (labels and values stay in pairs in the text order)', async () => {
    const text = await lines({ ...all.mortal, description: all.mortal.description });
    for (const label of ['Place of death:', 'From:', 'To:']) {
      const at = text.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      expect(text[at + 1]).not.toMatch(/^Page \d+ of \d+$/);
      expect(text[at + 1]).not.toBe('Request REQ-1042  ·  Request Summary');
    }
  });
  test('a minimal request (almost no fields) is a clean one-page document', async () => {
    const request = { referenceNumber: 'REQ-1', serviceType: 'Marine Medical Safety', status: 'weird_status', createdAt: null };
    const { buffer } = await renderPdfBuffer(request);
    expect(pagesOf(buffer)).toBe(1);
    const text = await lines(request);
    expect(text).toContain('Not provided');
    expect(text).toContain('Weird status');
    expect(text.join(' ')).not.toMatch(/undefined|null|NaN|1970/);
  });
  test('rendering is fast enough for a request (well under a second for the usual document)', async () => {
    const start = Date.now();
    await renderPdfBuffer(all.homecare);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('authorized data only: nothing internal is inside the file', () => {
  test.each(Object.entries(EIGHT))('%s: no internal id, CRM field, private path, checksum, scan detail or request key in the PDF, its text or its metadata', async (_name, key) => {
    const { buffer } = await renderPdfBuffer(all[key]);
    const everything = inflated(buffer) + (await lines(all[key])).join('\n');
    for (const secret of SECRET_TEXTS) expect({ key, secret, found: everything.includes(secret) }).toEqual({ key, secret, found: false });
    expect(everything).not.toMatch(/bitrix|Bearer |eyJ[A-Za-z0-9_-]{20,}|uploads\//i);
  });
  test('the document information is generic: no patient name, no request details', async () => {
    const { buffer } = await renderPdfBuffer(all.ground);
    const text = buffer.toString('latin1');
    // the document information (Title, Author, Subject) are separate objects, written as UTF-16 strings: keep the printable characters
    const infoText = (name) => {
      const ref = new RegExp(`/${name} (\\d+) 0 R`).exec(text);
      expect(ref).toBeTruthy();
      const object = new RegExp(`\\n${ref[1]} 0 obj\\n([\\s\\S]*?)\\nendobj`).exec(text);
      return object[1].replace(/[^\x20-\x7e]/g, '');
    };
    expect(infoText('Title')).toContain('Request Summary REQ-1042');
    expect(infoText('Author')).toContain('HumanCare Worldwide');
    expect(infoText('Subject')).toContain('Request Summary');
    for (const name of ['Title', 'Author', 'Subject']) expect(infoText(name)).not.toContain('Ravi');
    expect(text).not.toContain('Ravi Kumar');
  });
});

describe('what the file is sent as', () => {
  test('the headers: a PDF attachment named after the Request ID, with its length, not cached, not sniffable', async () => {
    const { buffer, headers } = await renderPdfBuffer(all.ground);
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toBe('attachment; filename="REQ-1042-summary.pdf"');
    expect(headers['Content-Length']).toBe(String(buffer.length));
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
  test.each([['REQ-1042', 'REQ-1042-summary.pdf'], ['CASE-1007', 'CASE-1007-summary.pdf'], ['REQ 1/2"\r\nX: y', 'REQ_1_2___X__y-summary.pdf'], ['../../etc/passwd', '.._.._etc_passwd-summary.pdf'], ['', 'request-summary.pdf'], [null, 'request-summary.pdf'], ['é'.repeat(100), `${'_'.repeat(60)}-summary.pdf`]])('the file name for %j is safe: %j', async (reference, expected) => {
    const { safeFileName } = require('../../src/modules/requests/request-summary.pdf');
    expect(safeFileName(reference)).toBe(expected);
    expect(safeFileName(reference)).not.toMatch(/[\r\n"\\/]/);
  });
});
