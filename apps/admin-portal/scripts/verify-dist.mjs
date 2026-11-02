#!/usr/bin/env node
// Verifies a production build of the Admin Portal after `vite build`:
//   1. the expected API origin is embedded in the JavaScript, and
//   2. no local API target is present anywhere in the output.
//
//   node scripts/verify-dist.mjs [--dir <build output, default dist>] [--expect <https URL>]
//
// --expect defaults to $VITE_API_BASE_URL. Exit codes: 0 = verified, 1 = verification failed,
// 2 = could not run (bad usage, missing build output, expected URL not acceptable).
//
// Bare "http://localhost" (no port) is not flagged: react-router and axios contain it as the
// base for parsing relative URLs, and no request is ever sent to it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProductionApiUrl } from '../build/apiUrl.mjs';

const FORBIDDEN = [
  ['localhost with a port', /localhost:\d+/gi],
  ['127.x.x.x loopback address', /(?<![\d.])127\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d)/g],
  ['0.0.0.0', /(?<![\d.])0\.0\.0\.0(?![\d.])/g],
  ['IPv6 loopback [::1]', /\[::1\]/g],
  ['IPv6 loopback ::1', /(?<![:\w])::1(?![:\w])/g],
  ['host on port 4000 (local backend)', /\/\/[^\s"'`/]*:4000(?!\d)/g],
];
const SCANNED = /\.(?:js|mjs|css|html|map|json)$/i;

function usage(message) {
  console.error(`verify-dist: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { dir: undefined, expect: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[(i += 1)];
    else if (argv[i] === '--expect') args.expect = argv[(i += 1)];
    else usage(`unknown argument "${argv[i]}"`);
  }
  return args;
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(args.dir ?? fileURLToPath(new URL('../dist', import.meta.url)));
const expected = args.expect ?? process.env.VITE_API_BASE_URL;

if (!fs.existsSync(path.join(dir, 'index.html'))) usage(`no build output found in ${dir} (run the build first).`);
if (!expected) usage('no expected API URL: pass --expect <url> or set VITE_API_BASE_URL.');
try {
  // The expectation itself must be an acceptable production origin (never a local target).
  validateProductionApiUrl(expected);
} catch (err) {
  usage(`the expected URL is not an acceptable production API origin: ${err.message}`);
}

const files = listFiles(dir).filter((file) => SCANNED.test(file));
const problems = [];
let expectedFound = false;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(dir, file).split(path.sep).join('/');

  for (const [label, pattern] of FORBIDDEN) {
    for (const match of text.matchAll(pattern)) {
      const start = Math.max(0, match.index - 25);
      const excerpt = text.slice(start, match.index + match[0].length + 25).replace(/\s+/g, ' ');
      problems.push(`${rel}: ${label}  ...${excerpt}...`);
    }
  }

  // The origin appears as a quoted string literal in the bundled config module.
  if (/\.m?js$/i.test(file) && ['"', "'", '`'].some((q) => text.includes(`${q}${expected}${q}`))) expectedFound = true;
}

if (!expectedFound) problems.push('the expected API origin is not embedded in any JavaScript file');

if (problems.length) {
  console.error(`verify-dist: FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}) in ${dir}`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`verify-dist: OK. ${files.length} files scanned, expected API origin embedded, no local API targets found.`);
