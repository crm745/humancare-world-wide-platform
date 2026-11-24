// Writes the fictional E2E fixture PDF for ONE designated test patient, so the same document is built the same way on every run.
//
//   npm run e2e:fixture-pdf -- --name "E2E-TEST Asha Rao 0412" --age 54 --gender female --origin "Mumbai" --destination "Dubai" [--out <folder>]
//
// The text of the file is exactly what the request form will store, because the upload is only accepted when every field matches the stored request
// (src/modules/request-review/e2e-document-verification.js). Origin / Destination may be the city name or the full location text the form stores.
//
// It reads no .env, opens no database and makes no network call: it only builds a PDF in memory and writes ONE file. The patient name must start
// with the visible test marker (E2E-TEST); values are plain ASCII. The default folder is the system temp folder, never the repository. An existing file is
// never overwritten. The output is the file path and nothing else (no field value is printed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFixturePdf, FixtureError } = require('../src/modules/request-review/e2e-document-verification');

const OPTIONS = new Set(['--name', '--age', '--gender', '--origin', '--destination', '--out']);

function parseArgs(argv) {
  const args = argv.slice();
  const named = {};
  while (args.length) {
    const key = args.shift();
    if (!OPTIONS.has(key)) return { error: 'unknown_option' };
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) return { error: 'missing_value' };
    named[key] = value;
  }
  return { named };
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fixture';

async function run(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  const { named, error } = parseArgs(argv);
  if (error) { errorLog(`e2e-fixture-pdf: ${error}. Options: ${[...OPTIONS].join(' ')}`); return 2; }
  let bytes;
  try {
    bytes = await buildFixturePdf({ patientName: named['--name'], age: named['--age'], gender: named['--gender'], origin: named['--origin'], destination: named['--destination'] });
  } catch (err) {
    errorLog(`e2e-fixture-pdf: refused (${err instanceof FixtureError ? err.code : 'error'})`);
    return 2;
  }
  const folder = path.resolve(named['--out'] || path.join(os.tmpdir(), 'humancare-e2e-fixtures'));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `e2e-fixture-${slug(named['--name'])}.pdf`);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' }); // never overwrites
  } catch (err) {
    errorLog(`e2e-fixture-pdf: could not write the file (${err && err.code === 'EEXIST' ? 'already exists' : 'error'})`);
    return 2;
  }
  log(file);
  return 0;
}

if (require.main === module) {
  run().then((code) => process.exit(code), () => process.exit(1));
}

module.exports = { run, parseArgs };
