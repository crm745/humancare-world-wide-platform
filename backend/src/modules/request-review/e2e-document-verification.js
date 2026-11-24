// Content verification for the DESIGNATED E2E test identity only (auto-approval.js decides when it applies; genuine requests never reach it).
//
// A genuine medical document cannot be read by machine, so nothing here claims to verify one. What CAN be verified is a clearly fictional fixture
// that the operator generates for one test patient: a single-page PDF holding exactly this text and nothing else,
//
//     FICTIONAL E2E TEST DOCUMENT - NOT A MEDICAL RECORD
//     Patient Name: <value>
//     Age: <value>
//     Gender: <value>
//     Origin: <value>
//     Destination: <value>
//
// and the verifier extracts that text from the uploaded bytes and compares EVERY field with the stored request. Anything else (another file type, a
// PDF whose text cannot be read this way, a missing / duplicated / extra / different line) is NOT verified, with a short code; the caller then holds
// the request. There is no signature and no secret: the gate is the designated identity (auto-approval.js) plus this exact match, bound to the
// request by the patient name, which carries a per-run token (for example "E2E-TEST Asha Rao 0412").
//
// Reading text back: pdf-lib (the PDF parser already used by the structure validator) parses the file, and each content stream is inflated with
// pdf-lib's own decoder; the fixture's text is written as standard-font hex strings, which are decoded as plain ASCII. A PDF that was not written
// this way (a scanned report, subset fonts, text drawn as outlines) yields no usable lines and so can never verify. That is intentional: it fails
// closed. Nothing here writes, logs or returns a field VALUE; results carry codes and field NAMES only.
const { PDFDocument, StandardFonts, PDFRawStream, decodePDFRawStream } = require('pdf-lib');

const BANNER = 'FICTIONAL E2E TEST DOCUMENT - NOT A MEDICAL RECORD';
const FIELDS = Object.freeze(['Patient Name', 'Age', 'Gender', 'Origin', 'Destination']);
const E2E_NAME_PREFIX = 'E2E-TEST'; // the same visible marker auto-approval.js requires of a designated request
const GENDERS = new Set(['male', 'female', 'other']);
const MAX_BYTES = 200 * 1024;
const MAX_STREAM_BYTES = 200 * 1024;
const MAX_LINES = 20;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/; // exactly what a standard-font fixture can carry and be read back unchanged

class FixtureError extends Error {
  constructor(code) { super(code); this.name = 'FixtureError'; this.code = code; }
}

// ---- the generator (also what the tests and the CLI use, so every run builds the same document) -------------------------------------------------
function cleanValue(label, value, max) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !text.trim()) throw new FixtureError(`fixture_value_missing:${label}`);
  if (text !== text.trim() || text.length > max || !PRINTABLE_ASCII.test(text)) throw new FixtureError(`fixture_value_invalid:${label}`);
  return text;
}

// -> Buffer (a one-page PDF). Refuses anything that could not be read back exactly, and any name without the visible test marker.
async function buildFixturePdf({ patientName, age, gender, origin, destination } = {}) {
  const name = cleanValue('Patient Name', patientName, 80);
  if (!name.startsWith(E2E_NAME_PREFIX)) throw new FixtureError('fixture_name_not_marked');
  const ageNumber = Number(cleanValue('Age', age, 3));
  if (!Number.isInteger(ageNumber) || ageNumber < 1 || ageNumber > 120) throw new FixtureError('fixture_value_invalid:Age');
  const sex = cleanValue('Gender', gender, 10);
  if (!GENDERS.has(sex)) throw new FixtureError('fixture_value_invalid:Gender');
  const lines = [
    BANNER,
    `Patient Name: ${name}`,
    `Age: ${ageNumber}`,
    `Gender: ${sex}`,
    `Origin: ${cleanValue('Origin', origin, 100)}`,
    `Destination: ${cleanValue('Destination', destination, 100)}`,
  ];
  const doc = await PDFDocument.create();
  doc.setTitle('Fictional E2E test document');
  doc.setProducer('HumanCare E2E fixture');
  doc.setCreator('HumanCare E2E fixture');
  const page = doc.addPage([480, 260]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 220;
  for (const line of lines) {
    page.drawText(line, { x: 30, y, size: 11, font });
    y -= 28;
  }
  return Buffer.from(await doc.save());
}

// ---- reading the text back --------------------------------------------------------------------------------------------------------------------
// -> [lines] in the order they were drawn. Throws FixtureError when the file cannot be read this way.
async function extractFixtureLines(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) throw new FixtureError('fixture_unreadable');
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true });
  } catch {
    throw new FixtureError('fixture_unreadable');
  }
  if (doc.isEncrypted || doc.getPageCount() !== 1) throw new FixtureError('fixture_unreadable');
  const lines = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let content;
    try {
      content = Buffer.from(decodePDFRawStream(object).decode());
    } catch {
      continue; // not a content stream we can inflate (an image, a font): it holds no fixture text
    }
    if (content.length > MAX_STREAM_BYTES) throw new FixtureError('fixture_unreadable');
    for (const match of content.toString('latin1').matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
      lines.push(Buffer.from(match[1].replace(/\s+/g, ''), 'hex').toString('latin1'));
      if (lines.length > MAX_LINES) throw new FixtureError('fixture_unexpected_content');
    }
  }
  return lines;
}

// The stored request values a fixture line may legitimately carry. Origin / Destination accept the stored location text or the stored city name
// (both are request values; the form's picker stores both).
const expectedFor = (request) => ({
  'Patient Name': [request.patientName],
  Age: [request.patientAge],
  Gender: [request.patientGender],
  Origin: [request.origin, request.originCityName],
  Destination: [request.destination, request.destinationCityName],
});

// -> { verified: true, fields: [...names] } | { verified: false, code }. Never throws, never returns a value from the document.
//   type     the file's REAL type, from its own bytes (the caller already detected it)
//   request  the stored ServiceRequest (patientName, patientAge, patientGender, origin, destination, originCityName, destinationCityName)
async function verifyE2EFixture({ bytes, type, request } = {}) {
  try {
    if (type !== 'pdf') return { verified: false, code: 'fixture_not_pdf' };
    if (!request) return { verified: false, code: 'fixture_request_missing' };
    const lines = await extractFixtureLines(bytes);
    if (lines.filter((line) => line === BANNER).length !== 1) return { verified: false, code: 'fixture_banner_missing' };
    const found = new Map();
    for (const line of lines) {
      if (line === BANNER) continue;
      const split = line.indexOf(': ');
      const label = split > 0 ? line.slice(0, split) : null;
      if (!label || !FIELDS.includes(label)) return { verified: false, code: 'fixture_unexpected_content' };
      if (found.has(label)) return { verified: false, code: `fixture_field_duplicated:${label}` };
      found.set(label, line.slice(split + 2));
    }
    const expected = expectedFor(request);
    for (const label of FIELDS) {
      if (!found.has(label)) return { verified: false, code: `fixture_field_missing:${label}` };
      const allowed = expected[label].filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map((v) => String(v));
      if (!allowed.includes(found.get(label))) return { verified: false, code: `fixture_field_mismatch:${label}` };
    }
    return { verified: true, fields: [...FIELDS] };
  } catch (err) {
    return { verified: false, code: err instanceof FixtureError ? err.code : 'fixture_unreadable' };
  }
}

module.exports = { BANNER, FIELDS, E2E_NAME_PREFIX, FixtureError, buildFixturePdf, extractFixtureLines, verifyE2EFixture };
