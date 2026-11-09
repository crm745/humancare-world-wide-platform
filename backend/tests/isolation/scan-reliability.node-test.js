// Worker reliability, Phase 1: how documents are scanned, retried, failed and quarantined. A plain node:test file in the
// same style as upload-dir-and-lock.node-test.js, and for the same reason: it NEVER touches a database and never starts Jest
// (so Jest's global setup, which empties humancare_test, does not run).
//
//   node --test tests/isolation/scan-reliability.node-test.js
//
// How it stays off the database: the Prisma client module is replaced by an in-memory fake BEFORE the service is loaded, and
// DATABASE_URL is pointed at an unusable address as a second line of defence. Files live in a private temporary folder.
// The real ClamAV client is exercised against tests/helpers/fake-clamd.js (a TCP stand-in) or a port nobody listens on.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-scan-reliability-'));
process.env.HC_UPLOAD_DIR = UPLOADS;
process.env.DATABASE_URL = 'mysql://nobody:nothing@127.0.0.1:1/never_used';
process.env.CLAMAV_HOST = '127.0.0.1';
process.env.CLAMAV_TIMEOUT_MS = '1500';

// ---- an in-memory stand-in for the Prisma client ----------------------------------------------
function makeFakePrisma() {
  const db = { docs: [], events: [], requests: [], cases: [], caseDocs: [], nextDoc: 100, nextEvent: 1 };
  const clone = (row) => (row ? { ...row } : row);
  const sameValue = (a, b) => (a instanceof Date || b instanceof Date ? (a == null ? b == null : b != null && +a === +b) : a === b);
  const matches = (row, where = {}) => Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return want.some((w) => matches(row, w));
    if (want !== null && typeof want === 'object' && !(want instanceof Date) && 'in' in want) return want.in.includes(row[key]);
    if (want !== null && typeof want === 'object' && !(want instanceof Date) && 'not' in want) return row[key] !== want.not;
    if (want !== null && typeof want === 'object' && !(want instanceof Date) && 'lte' in want) return row[key] != null && +row[key] <= +want.lte;
    if (want === null) return row[key] == null;
    return sameValue(row[key], want);
  });
  const order = (rows, orderBy) => {
    const keys = [].concat(orderBy || []).map((o) => Object.entries(o)[0]);
    return [...rows].sort((a, b) => {
      for (const [key, dir] of keys) {
        const av = a[key] == null ? -Infinity : +a[key];
        const bv = b[key] == null ? -Infinity : +b[key];
        if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  };
  const requestDocument = {
    findUnique: async ({ where }) => clone(db.docs.find((d) => d.id === where.id)),
    findFirst: async ({ where }) => clone(db.docs.find((d) => matches(d, where))),
    findMany: async ({ where, orderBy, take } = {}) => {
      db.queries.push({ where, orderBy, take });
      const rows = order(db.docs.filter((d) => matches(d, where)), orderBy);
      return (take ? rows.slice(0, take) : rows).map(clone);
    },
    updateMany: async ({ where, data }) => {
      const rows = db.docs.filter((d) => matches(d, where));
      rows.forEach((d) => Object.assign(d, data));
      return { count: rows.length };
    },
    update: async ({ where, data }) => Object.assign(db.docs.find((d) => d.id === where.id), data),
    create: async ({ data }) => {
      const row = { id: db.nextDoc++, scanStatus: 'pending', reviewStatus: 'pending', supersededAt: null, scannedAt: null, scanAttempts: 0, scanNextAttemptAt: null, uploadedAt: new Date(), ...data };
      db.docs.push(row);
      return clone(row);
    },
  };
  const tx = {
    requestDocument,
    requestEvent: { create: async ({ data }) => { db.events.push({ id: db.nextEvent++, ...data }); return data; } },
    $queryRaw: async () => [],
    serviceRequest: {
      findUnique: async ({ where }) => clone(db.requests.find((r) => r.id === where.id)),
      update: async ({ where, data }) => Object.assign(db.requests.find((r) => r.id === where.id), data),
    },
    case: {
      create: async ({ data }) => { const row = { id: db.cases.length + 1, ...data }; db.cases.push(row); return clone(row); },
      update: async ({ where, data }) => Object.assign(db.cases.find((c) => c.id === where.id), data),
      findUnique: async () => null,
    },
    caseStageEvent: { create: async () => ({}) },
    document: { create: async ({ data }) => { const row = { id: db.caseDocs.length + 1, ...data }; db.caseDocs.push(row); return row; } },
  };
  db.queries = [];
  return { ...tx, $transaction: async (fn) => fn(tx), db };
}

const fake = makeFakePrisma();
const prismaModule = require.resolve('../../src/db/prisma');
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: { prisma: fake } };

const review = require('../../src/modules/request-review/request-review.service');
const files = require('../../src/modules/request-review/request-review.files');
const scanJob = require('../../src/jobs/scan-request-documents.job');
const clamav = require('../../src/integrations/clamav/clamav');
const { startFakeClamd, unusedPort } = require('../helpers/fake-clamd');

const db = fake.db;
const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');
const PDF = '%PDF-1.4 harmless test document';
// The scanner is injected in these tests, so file content never has to be a real EICAR string (which antivirus software may
// delete from a temp folder). This marker only stands for "file content" when checking that logs never contain it.
const FILE_MARKER = 'SECRET-FILE-CONTENT-MARKER';
let counter = 0;

// A document row plus its real file in the private upload folder.
function addDoc(over = {}, { content = PDF, write = true } = {}) {
  counter += 1;
  const storageKey = over.storageKey || `doc-${counter}-${crypto.randomBytes(3).toString('hex')}.pdf`;
  if (write) fs.writeFileSync(path.join(UPLOADS, storageKey), content);
  const row = {
    id: 1000 + counter, serviceRequestId: 1, originalName: storageKey, storageKey, sizeBytes: Buffer.byteLength(content), sha256: sha(content),
    scanStatus: 'pending', scanDetail: null, scanEngine: null, scannedAt: null, scanAttempts: 0, scanNextAttemptAt: null, reviewStatus: 'pending', supersededAt: null, replacesId: null, ...over,
  };
  db.docs.push(row);
  return row;
}
const row = (id) => db.docs.find((d) => d.id === id);
const eventsOf = (id) => db.events.filter((e) => e.documentId === id).map((e) => e.action);
const reset = () => { db.docs.length = 0; db.events.length = 0; db.queries.length = 0; db.cases.length = 0; db.caseDocs.length = 0; db.requests.length = 0; };
const clean = async () => ({ status: 'clean' });
// A clock two hours ahead: every retry delay (60 minutes at most) is over by then.
const later = () => Date.now() + 2 * 60 * 60 * 1000;
const down = async () => ({ status: 'error', detail: 'cannot reach the scanner (ECONNREFUSED)' });

// Captures console output for the duration of fn, so a test can assert what was (and was not) logged.
async function logsOf(fn) {
  const logs = { log: [], warn: [], error: [] };
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(logs)) console[level] = (...args) => logs[level].push(args.join(' '));
  try { await fn(); } finally { Object.assign(console, original); }
  return logs;
}

test.after(() => { fs.rmSync(UPLOADS, { recursive: true, force: true }); });

// ---- 1. superseded documents ----------------------------------------------------------------
test('sweeps skip replaced (superseded) documents and never touch failed ones', async () => {
  reset();
  const live = addDoc({});
  const liveRetry = addDoc({ scanStatus: 'error', scannedAt: new Date('2020-01-01') });
  const oldPending = addDoc({ supersededAt: new Date() });
  const oldError = addDoc({ scanStatus: 'error', supersededAt: new Date() });
  const failed = addDoc({ scanStatus: 'failed', scanDetail: 'the stored file is missing' });
  const before = JSON.stringify([oldPending, oldError, failed]);

  const calls = [];
  const result = await review.sweepPendingScans({ scanner: async (file) => { calls.push(path.basename(file)); return { status: 'clean' }; } });

  assert.deepEqual(result, { checked: 2, scanned: 2, failed: 0, waiting: 0, due: 2, scannerUnavailable: false });
  assert.deepEqual(calls.sort(), [live.storageKey, liveRetry.storageKey].sort());
  assert.equal(row(live.id).scanStatus, 'clean');
  assert.equal(row(liveRetry.id).scanStatus, 'clean');
  assert.equal(JSON.stringify([row(oldPending.id), row(oldError.id), row(failed.id)]), before, 'replaced and failed rows are untouched history');
  assert.deepEqual(db.queries.map((q) => q.where.supersededAt), [null], 'the sweep query asks for current versions only');
  assert.deepEqual(db.queries.map((q) => q.where.scanStatus), [{ in: ['pending', 'error'] }]);
});

test('scanning a replaced document directly does nothing', async () => {
  reset();
  const old = addDoc({ supersededAt: new Date(), scanStatus: 'error' });
  const pending = addDoc({ supersededAt: new Date() });
  let calls = 0;
  const scanner = async () => { calls += 1; return { status: 'clean' }; };
  const a = await review.scanRequestDocument(old.id, { scanner });
  const b = await review.scanRequestDocument(pending.id, { scanner });
  assert.equal(calls, 0, 'the scanner is never called');
  assert.equal(a.scanStatus, 'error');
  assert.equal(b.scanStatus, 'pending');
  assert.equal(db.events.length, 0, 'no verdict and no event are written');
  assert.equal(await review.scanRequestDocument(999999), undefined, 'an unknown id is still just not found');
});

test('replacing a failed document keeps its history, and only the new version is scanned', async () => {
  reset();
  db.requests.push({ id: 1, userId: 7, reviewStatus: 'in_review', submittedAt: new Date() });
  const failed = addDoc({ scanStatus: 'failed', scanDetail: 'the stored file is missing' }, { write: false });
  const upload = path.join(UPLOADS, `replacement-${counter}.pdf`);
  fs.writeFileSync(upload, PDF);
  const stored = await review.addPatientDocument({
    userId: 7, requestId: 1, replacesDocumentId: failed.id,
    file: { path: upload, originalname: 'replacement.pdf', filename: path.basename(upload), size: Buffer.byteLength(PDF), mimetype: 'application/pdf' },
  });
  assert.equal(stored.replacesId, failed.id);
  assert.ok(row(failed.id).supersededAt, 'the failed original is marked replaced');
  assert.equal(row(failed.id).scanStatus, 'failed', 'and keeps its own status');
  assert.equal(row(stored.id).supersededAt, null);

  const result = await review.sweepPendingScans({ scanner: clean });
  assert.equal(result.checked, 1);
  assert.equal(row(stored.id).scanStatus, 'clean');
  assert.equal(row(failed.id).scanStatus, 'failed');
});

// ---- 2. permanent failures ------------------------------------------------------------------
test('a missing file fails for good: terminal status, one audit event, one log line, never retried', async () => {
  reset();
  const witness = addDoc({ scanStatus: 'clean' }); // another stored document is found: the storage itself is intact
  const gone = addDoc({}, { write: false });
  let scannerCalls = 0;
  const logs = await logsOf(async () => {
    const result = await review.scanRequestDocument(gone.id, { scanner: async () => { scannerCalls += 1; return { status: 'clean' }; } });
    assert.equal(result.scanStatus, 'failed');
    assert.equal(result.scanDetail, 'the stored file is missing');
  });
  assert.equal(scannerCalls, 0, 'ClamAV is not even asked for a file that does not exist');
  assert.deepEqual(eventsOf(gone.id), ['scan_failed']);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0], new RegExp(`document ${gone.id} \\(request 1\\) can never be scanned: the stored file is missing`));
  assert.match(logs.error[0], /will not be retried/);
  assert.equal(logs.warn.length, 0);

  const again = await review.sweepPendingScans({ scanner: clean });
  assert.equal(again.checked, 0, 'the next sweep no longer picks it up');
  assert.equal((await review.scanRequestDocument(gone.id, { scanner: clean })).scanStatus, 'failed', 'and a direct call leaves it failed');
  assert.deepEqual(eventsOf(gone.id), ['scan_failed']);
  assert.equal(row(witness.id).scanStatus, 'clean', 'and only the document whose file is gone is affected');
});

test('a file that does not match its upload checksum, or has none, fails for good', async () => {
  reset();
  const altered = addDoc({});
  fs.writeFileSync(path.join(UPLOADS, altered.storageKey), 'something else entirely');
  const noChecksum = addDoc({ sha256: null });
  const logs = await logsOf(async () => {
    assert.equal((await review.scanRequestDocument(altered.id, { scanner: clean })).scanStatus, 'failed');
    assert.equal((await review.scanRequestDocument(noChecksum.id, { scanner: clean })).scanStatus, 'failed');
  });
  assert.match(row(altered.id).scanDetail, /does not match its upload checksum/);
  assert.match(row(noChecksum.id).scanDetail, /no checksum was recorded/);
  assert.equal(logs.error.length, 2);
});

test('a file that changes while it is being scanned is never clean, and fails for good', async () => {
  reset();
  const doc = addDoc({});
  const scanner = async (file) => { fs.writeFileSync(file, 'X'.repeat(PDF.length)); return { status: 'clean' }; };
  await logsOf(async () => assert.equal((await review.scanRequestDocument(doc.id, { scanner })).scanStatus, 'failed'));
  assert.match(row(doc.id).scanDetail, /changed while it was being scanned/);
});

test('a file that vanishes during the scan is permanent; one that cannot be read for now is not', async () => {
  reset();
  addDoc({ scanStatus: 'clean' }); // the storage is intact
  const vanished = addDoc({});
  const scanner = async (file) => { fs.rmSync(file); const err = new Error('gone'); err.code = 'ENOENT'; throw err; };
  const directory = addDoc({}, { write: false });
  fs.mkdirSync(path.join(UPLOADS, directory.storageKey)); // reading a directory is a read error, not a missing file
  await logsOf(async () => {
    assert.equal((await review.scanRequestDocument(vanished.id, { scanner })).scanStatus, 'failed');
    assert.equal((await review.scanRequestDocument(directory.id, { scanner: clean })).scanStatus, 'error');
  });
  assert.match(row(directory.id).scanDetail, /^the scan could not be completed \(E[A-Z]+\)$/);
  assert.ok(!row(directory.id).scanDetail.includes(UPLOADS), 'no file-system path in the detail an Admin sees');
});

// ---- 2b. storage problems are not lost documents --------------------------------------------
// A file that is missing because the STORAGE is wrong (another HC_UPLOAD_DIR, an unmounted volume, a missing folder) must
// never end a valid document: the file is lost for good only when another stored document proves the storage is intact.
test('with no other stored document to show the storage is intact, a missing file is retried, not failed', async () => {
  reset();
  const lonely = addDoc({}, { write: false });
  let result;
  const logs = await logsOf(async () => { result = await review.scanRequestDocument(lonely.id, { scanner: clean }); });
  assert.equal(result.scanStatus, 'error', 'still retryable');
  assert.match(result.scanDetail, /no other stored document could be found.*retried instead of failing/);
  assert.deepEqual(eventsOf(lonely.id), ['scan_error'], 'recorded as a scan error, not as a permanent failure');
  assert.equal(logs.error.length, 0, 'logged as a warning, once');
  assert.equal(logs.warn.length, 1);
  assert.equal((await review.sweepPendingScans({ scanner: clean })).failed, 0);
  assert.equal(row(lonely.id).scanStatus, 'error');
});

test('a wrong or unmounted storage (every file missing) fails nothing, and the documents recover when it comes back', async () => {
  reset();
  const witnesses = [1, 2, 3].map(() => addDoc({ scanStatus: 'clean' }, { write: false })); // their files are missing too
  const target = addDoc({}, { write: false });
  const hidden = [...witnesses, target].map((d) => d.storageKey);
  await logsOf(async () => {
    const swept = await review.sweepPendingScans({ scanner: clean });
    assert.equal(swept.failed, 0, 'nothing is failed for good');
    assert.equal(swept.waiting, 1);
  });
  assert.equal(row(target.id).scanStatus, 'error');
  assert.ok(!eventsOf(target.id).includes('scan_failed'));

  // The storage comes back: every file is there again.
  for (const key of hidden) fs.writeFileSync(path.join(UPLOADS, key), PDF);
  await logsOf(async () => assert.equal((await review.sweepPendingScans({ scanner: clean, clock: later })).scanned, 1));
  assert.equal(row(target.id).scanStatus, 'clean', 'the valid document was not destroyed');
});

test('an upload folder that is unavailable fails nothing, and the document is scanned once it is back', async () => {
  reset();
  addDoc({ scanStatus: 'clean' }); // a witness for the moment the folder is back
  const target = addDoc({});
  const away = `${UPLOADS}-away`;
  fs.renameSync(UPLOADS, away); // the whole folder is gone
  try {
    await logsOf(async () => {
      const result = await review.scanRequestDocument(target.id, { scanner: clean });
      assert.equal(result.scanStatus, 'error');
      assert.match(result.scanDetail, /upload folder is unavailable/);
    });
    assert.ok(!eventsOf(target.id).includes('scan_failed'));
  } finally {
    fs.renameSync(away, UPLOADS);
  }
  await logsOf(async () => assert.equal((await review.scanRequestDocument(target.id, { scanner: clean, clock: later })).scanStatus, 'clean'));
});

test('a path that is not a folder counts as unavailable storage', async () => {
  reset();
  addDoc({ scanStatus: 'clean' });
  const target = addDoc({}, { write: false });
  const away = `${UPLOADS}-real`;
  fs.renameSync(UPLOADS, away);
  fs.writeFileSync(UPLOADS, 'a file where the upload folder should be');
  try {
    await logsOf(async () => assert.equal((await review.scanRequestDocument(target.id, { scanner: clean })).scanStatus, 'error'));
    assert.match(row(target.id).scanDetail, /upload folder is unavailable/);
  } finally {
    fs.rmSync(UPLOADS, { force: true });
    fs.renameSync(away, UPLOADS);
  }
});

test('only another document that was scanned clean counts as proof the storage is intact', async () => {
  reset();
  addDoc({ scanStatus: 'pending' }); // a stored file, but nothing vouches for it
  addDoc({ scanStatus: 'error' });
  addDoc({ scanStatus: 'infected' });
  const gone = addDoc({}, { write: false });
  await logsOf(async () => assert.equal((await review.scanRequestDocument(gone.id, { scanner: clean })).scanStatus, 'error'));
  addDoc({ scanStatus: 'clean' }); // now one does
  await logsOf(async () => assert.equal((await review.scanRequestDocument(gone.id, { scanner: clean, clock: later })).scanStatus, 'failed'));
});

test('only a genuinely missing file is lost: the others in the same healthy folder are untouched', async () => {
  reset();
  const fine = addDoc({ scanStatus: 'clean' });
  const present = addDoc({});
  const gone = addDoc({}, { write: false });
  await logsOf(async () => {
    const swept = await review.sweepPendingScans({ scanner: clean });
    assert.deepEqual([swept.scanned, swept.failed, swept.waiting], [1, 1, 0]);
  });
  assert.equal(row(gone.id).scanStatus, 'failed');
  assert.equal(row(present.id).scanStatus, 'clean');
  assert.equal(row(fine.id).scanStatus, 'clean');
});

test('if the proof cannot be looked up, nothing is decided and the document stays waiting', async () => {
  reset();
  const gone = addDoc({}, { write: false });
  const real = fake.requestDocument.findMany;
  fake.requestDocument.findMany = async () => { throw new Error('database unavailable'); };
  try {
    await logsOf(async () => assert.rejects(review.scanRequestDocument(gone.id, { scanner: clean }), /database unavailable/));
    assert.equal(row(gone.id).scanStatus, 'pending');
    assert.equal(db.events.length, 0);
  } finally {
    fake.requestDocument.findMany = real;
  }
});

// ---- 3. transient failures ------------------------------------------------------------------
test('a scanner that is down stays retryable: error, one event, one warning, healed by a later scan', async () => {
  reset();
  const doc = addDoc({});
  const logs = await logsOf(async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await review.scanRequestDocument(doc.id, { scanner: down, clock: () => Date.now() + i * 2 * 3600e3 })).scanStatus, 'error');
  });
  assert.deepEqual(eventsOf(doc.id), ['scan_error'], 'an outage is recorded once, not on every retry');
  assert.equal(logs.warn.length, 1, 'and logged once');
  assert.match(logs.warn[0], /could not be scanned for now.*will be retried/);
  assert.equal(logs.error.length, 0, 'a transient failure is not an error-level, permanent-looking line');

  assert.equal((await review.sweepPendingScans({ scanner: down, clock: () => Date.now() + 8 * 3600e3 })).waiting, 1, 'the sweep keeps it');
  assert.equal((await review.scanRequestDocument(doc.id, { scanner: clean, clock: () => Date.now() + 12 * 3600e3 })).scanStatus, 'clean');
  assert.deepEqual(eventsOf(doc.id), ['scan_error', 'scan_clean']);
});

test('the real ClamAV client: refused connection, timeout, garbage and a dropped connection are all transient', async () => {
  reset();
  const clamd = await startFakeClamd('ok');
  const previous = process.env.CLAMAV_PORT;
  try {
    process.env.CLAMAV_PORT = String(await unusedPort()); // nothing listens: connection refused
    const refused = addDoc({});
    await logsOf(async () => assert.equal((await review.scanRequestDocument(refused.id)).scanStatus, 'error'));
    assert.match(row(refused.id).scanDetail, /cannot reach the scanner/);

    process.env.CLAMAV_PORT = String(clamd.port);
    for (const mode of ['hang', 'garbage', 'close', 'wrongok']) {
      clamd.setMode(mode);
      const doc = addDoc({});
      await logsOf(async () => assert.equal((await review.scanRequestDocument(doc.id)).scanStatus, 'error', mode));
    }
    clamd.setMode('ok');
    await logsOf(async () => assert.equal((await review.sweepPendingScans({ clock: later })).scanned, 5)); // everything heals once the scanner answers
    assert.ok(db.docs.every((d) => d.scanStatus === 'clean'));
  } finally {
    if (previous === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = previous;
    await clamd.close();
  }
});

test('the clamd client reports a scanner problem as an error value, never as a permanent failure', async () => {
  const file = path.join(UPLOADS, 'client-check.pdf');
  fs.writeFileSync(file, PDF);
  const verdict = await clamav.scanFile(file, { host: '127.0.0.1', port: await unusedPort(), timeoutMs: 500 });
  assert.equal(verdict.status, 'error');
  assert.notEqual(verdict.permanent, true);
});

// ---- 4. infected files and quarantine -------------------------------------------------------
test('an infected file is quarantined, and nobody can download or review it', async () => {
  reset();
  db.requests.push({ id: 1, userId: 7, reviewStatus: 'in_review' });
  const doc = addDoc({});
  const scanner = async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' });
  const logs = await logsOf(async () => assert.equal((await review.scanRequestDocument(doc.id, { scanner })).scanStatus, 'infected'));
  assert.equal(row(doc.id).scanDetail, 'Eicar-Test-Signature');
  assert.deepEqual(eventsOf(doc.id), ['scan_infected']);
  assert.ok(fs.existsSync(path.join(review.QUARANTINE_DIR, doc.storageKey)), 'moved into quarantine');
  assert.ok(!fs.existsSync(path.join(UPLOADS, doc.storageKey)), 'and out of the uploads folder');
  assert.equal(logs.error.length, 0);
  await assertNotOpenable(doc);
});

test('a quarantine move that fails is logged, keeps the infected verdict, and still blocks every use', async () => {
  reset();
  db.requests.push({ id: 1, userId: 7, reviewStatus: 'in_review' });
  const doc = addDoc({});
  const blocker = path.join(UPLOADS, 'quarantine');
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.writeFileSync(blocker, 'a FILE where the quarantine folder should be'); // makes the quarantine step fail
  try {
    const scanner = async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' });
    let result;
    const logs = await logsOf(async () => { result = await review.scanRequestDocument(doc.id, { scanner }); });
    assert.equal(result.scanStatus, 'infected', 'the verdict is preserved');
    assert.deepEqual(eventsOf(doc.id), ['scan_infected']);
    assert.ok(fs.existsSync(path.join(UPLOADS, doc.storageKey)), 'the file could not be moved');
    assert.equal(logs.error.length, 1);
    assert.match(logs.error[0], new RegExp(`document ${doc.id} \\(request 1\\) is INFECTED but could not be quarantined while creating the quarantine folder: [A-Z]+`));
    assert.match(logs.error[0], /must be moved by hand/);
    assert.ok(!logs.error[0].includes(UPLOADS), 'the log carries the error code, not a file-system path');
    await assertNotOpenable(doc);
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});

// ---- 5. review, download and approval guards ------------------------------------------------
async function assertNotOpenable(doc) {
  const download = review.resolveAdminDownload({ requestId: 1, documentId: doc.id, adminId: 9 });
  await assert.rejects(download, (err) => err.statusCode === 409 && err.publicCode === 'document_not_clean');
  const decide = review.reviewDocument({ requestId: 1, documentId: doc.id, adminId: 9, decision: 'approved' });
  await assert.rejects(decide, (err) => err.statusCode === 409 && err.publicCode === 'document_not_clean');
  assert.throws(() => files.assertCaseDocumentServable({ ...row(doc.id), caseDocumentId: 5 }, { id: 5 }), (err) => err.statusCode === 409);
  assert.equal(db.events.filter((e) => e.documentId === doc.id && /^document_/.test(e.action)).length, 0, 'no download or review event was written');
}

test('a failed document can be neither downloaded nor reviewed', async () => {
  reset();
  db.requests.push({ id: 1, userId: 7, reviewStatus: 'in_review' });
  const doc = addDoc({ scanStatus: 'failed', scanDetail: 'the stored file is missing' });
  await assertNotOpenable(doc);
  const err = await review.resolveAdminDownload({ requestId: 1, documentId: doc.id, adminId: 9 }).catch((e) => e);
  assert.match(err.message, /virus scan is "failed"/);
});

test('a failed or errored document in the request blocks approval, with an actionable reason', () => {
  const doc = (over) => ({ id: 1, originalName: 'report.pdf', scanStatus: 'clean', reviewStatus: 'approved', scanDetail: null, ...over });
  const codes = (docs) => review.approvalBlockers({ reviewStatus: 'in_review' }, docs).map((b) => b.code);
  assert.deepEqual(codes([doc({})]), []);
  assert.deepEqual(codes([doc({ scanStatus: 'failed', reviewStatus: 'pending', scanDetail: 'the stored file is missing' })]), ['scan_unrecoverable']);
  assert.deepEqual(codes([doc({ scanStatus: 'error', reviewStatus: 'pending' })]), ['scan_failed'], 'a retryable error keeps its own code');
  assert.deepEqual(codes([doc({ scanStatus: 'pending', reviewStatus: 'pending' })]), ['unscanned']);
  assert.deepEqual(codes([doc({ scanStatus: 'infected', reviewStatus: 'pending' })]), ['infected']);
  const [blocker] = review.approvalBlockers({ reviewStatus: 'in_review' }, [doc({ scanStatus: 'failed', reviewStatus: 'pending', scanDetail: 'the stored file is missing' })]);
  assert.match(blocker.message, /can never be scanned \(the stored file is missing\).*upload a replacement/);
});

test('approval ignores replaced documents of any scan state, and is refused by a current failed one', async () => {
  reset();
  const request = { id: 1, userId: 7, reviewStatus: 'in_review', patientName: 'Synthetic Patient', serviceType: 'Private Charter', origin: 'A', destination: 'B', referenceNumber: 'REQ-1' };
  db.requests.push(request);
  const good = addDoc({ scanStatus: 'clean', reviewStatus: 'approved' });
  addDoc({ scanStatus: 'failed', supersededAt: new Date() }, { write: false });
  addDoc({ scanStatus: 'error', supersededAt: new Date() }, { write: false });
  addDoc({ scanStatus: 'infected', supersededAt: new Date() }, { write: false });

  const approved = await review.approveRequest({ requestId: 1, adminId: 9 });
  assert.equal(approved.alreadyApproved, false);
  assert.equal(db.cases.length, 1, 'the Case is created');
  assert.equal(db.caseDocs.length, 1, 'with only the current document');
  assert.equal(row(good.id).caseDocumentId, 1);

  reset();
  db.requests.push({ ...request, reviewStatus: 'in_review' });
  addDoc({ scanStatus: 'clean', reviewStatus: 'approved' });
  const broken = addDoc({ scanStatus: 'failed', scanDetail: 'the stored file is missing' }, { write: false });
  const refused = await review.approveRequest({ requestId: 1, adminId: 9 }).catch((e) => e);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.publicCode, 'approval_blocked');
  assert.deepEqual(refused.blockers.map((b) => [b.code, b.documentId]), [['scan_unrecoverable', broken.id]]);
  assert.equal(db.cases.length, 0, 'no Case is created');
});

test('the request summary counts failed scans separately and leaves replaced documents out', () => {
  const d = (over) => ({ scanStatus: 'clean', reviewStatus: 'pending', supersededAt: null, ...over });
  const summary = review.documentSummary([
    d({ scanStatus: 'failed' }), d({ scanStatus: 'error' }), d({ scanStatus: 'pending' }), d({ scanStatus: 'infected' }),
    d({ reviewStatus: 'approved' }), d({}), d({ scanStatus: 'failed', supersededAt: new Date() }),
  ]);
  assert.deepEqual(summary, { current: 6, awaitingScan: 2, scanErrors: 1, scanFailed: 1, infected: 1, awaitingReview: 1, approved: 1, rejected: 0 });
});

// ---- 6. the worker job's logging --------------------------------------------------------------
test('the job prints a changed picture at once and stays quiet while nothing changes', async () => {
  reset();
  const previous = process.env.CLAMAV_PORT;
  process.env.CLAMAV_PORT = String(await unusedPort()); // the real scanner is down
  try {
    addDoc({ scanStatus: 'clean' }); // the storage is intact, so a missing file below is really lost
    addDoc({});
    const lines = [];
    for (let i = 0; i < 3; i += 1) lines.push((await logsOf(() => scanJob.run())).log);
    assert.equal(lines[0].length, 1, 'the first run says what it found');
    assert.match(lines[0][0], /^\[scan\] ClamAV is unavailable: 1 document\(s\) are due and wait\. No retry attempt is used up\.$/);
    assert.deepEqual([lines[1].length, lines[2].length], [0, 0], 'the same picture is not repeated every minute');
    assert.ok(db.docs.every((d) => d.scanAttempts === 0), 'an outage uses no attempt');

    const clamd = await startFakeClamd('ok'); // ClamAV comes back
    process.env.CLAMAV_PORT = String(clamd.port);
    addDoc({}, { write: false }); // a document whose file is gone
    const changed = await logsOf(() => scanJob.run()).finally(() => clamd.close());
    assert.equal(changed.log.length, 1);
    assert.match(changed.log[0], /1 failed for good/);
    assert.equal(changed.error.length, 1, 'and the permanent failure is logged once, at error level');
    assert.deepEqual((await logsOf(() => scanJob.run())).error, [], 'but not again on the next run');
  } finally {
    if (previous === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = previous;
  }
});

test('no log line contains file contents, tokens or storage paths', async () => {
  reset();
  addDoc({ scanStatus: 'clean' });
  const doc = addDoc({}, { content: FILE_MARKER });
  const gone = addDoc({}, { write: false });
  const logs = await logsOf(async () => {
    await review.scanRequestDocument(doc.id, { scanner: async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' }) });
    await review.scanRequestDocument(gone.id);
  });
  const text = [...logs.log, ...logs.warn, ...logs.error].join('\n');
  assert.ok(!text.includes(FILE_MARKER), 'no file content');
  assert.ok(!text.includes(UPLOADS), 'no upload path');
  assert.ok(!/Bearer |eyJ[A-Za-z0-9_-]{10,}/.test(text), 'no token');
});

// ======================================================================================================
// Worker reliability, Phase 2: bounded retries, exponential backoff, claims with a lease, a ClamAV health check.
// Same rules as above: no database, no Jest. Time is injected (`clock`, in ms) and so is the jitter (`rng`), so every
// delay below is exact and nothing sleeps for long.
// ======================================================================================================
const { SCAN_RETRY, scanBackoffMs } = require('../../src/modules/request-review/request-review.config');

const BASE = Date.UTC(2026, 10, 9, 12, 0, 0);
const at = (minutes) => () => BASE + minutes * 60 * 1000; // a fixed clock, `minutes` after BASE
const noJitter = () => 0.5; // jitter factor exactly 1
const secs = (ms) => Math.round(ms / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 7. the backoff schedule --------------------------------------------------------------------------------
test('backoff doubles from 1 minute to a 60 minute cap, jitter included', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => secs(scanBackoffMs(n, { rng: noJitter }))), [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600]);
  // +-20% around the base delay: attempt 1 lands between 48 s and 72 s, attempt 4 starts at 384 s.
  assert.equal(secs(scanBackoffMs(1, { rng: () => 0 })), 48);
  assert.equal(secs(scanBackoffMs(1, { rng: () => 0.999999 })), 72);
  assert.equal(secs(scanBackoffMs(4, { rng: () => 0 })), 384);
  // The cap is a hard limit: it holds with the highest jitter too, and the lowest jitter at the cap is 80% of it.
  assert.equal(scanBackoffMs(9, { rng: () => 0.999999 }), SCAN_RETRY.maxDelayMs);
  assert.equal(scanBackoffMs(9, { rng: () => 0 }), SCAN_RETRY.maxDelayMs * 0.8);
  // Whatever the input, the delay is a positive whole number of milliseconds within the cap.
  for (const n of [0, -3, NaN, undefined, 1e9]) {
    const delay = scanBackoffMs(n);
    assert.ok(Number.isInteger(delay) && delay >= 1 && delay <= SCAN_RETRY.maxDelayMs, `attempts=${n}`);
  }
  assert.deepEqual([SCAN_RETRY.maxAttempts, SCAN_RETRY.initialDelayMs, SCAN_RETRY.multiplier, SCAN_RETRY.maxDelayMs, SCAN_RETRY.jitter], [10, 60000, 2, 3600000, 0.2]);
});

// ---- 8. attempts, schedule and the limit --------------------------------------------------------------------
test('a failed attempt is counted and the next one is scheduled with backoff; nothing runs before it is due', async () => {
  reset();
  const doc = addDoc({});
  let calls = 0;
  const flaky = async () => { calls += 1; return { status: 'error', detail: 'the scan timed out' }; };

  let result = await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(0), rng: noJitter });
  assert.deepEqual([result.scanStatus, result.scanAttempts, calls], ['error', 1, 1]);
  assert.equal(+result.scanNextAttemptAt, BASE + 60 * 1000, 'the first retry is 1 minute away');

  // Not due yet: nothing is scanned, nothing is counted, nothing changes.
  result = await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(0.5), rng: noJitter });
  assert.deepEqual([result.scanAttempts, calls], [1, 1]);
  assert.equal((await review.sweepPendingScans({ scanner: flaky, clock: at(0.5), rng: noJitter })).due, 0, 'the sweep does not even look at it');

  result = await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(1), rng: noJitter });
  assert.deepEqual([result.scanAttempts, calls], [2, 2]);
  assert.equal(+result.scanNextAttemptAt, BASE + 60 * 1000 + 120 * 1000, 'then 2 minutes');
  result = await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(3), rng: noJitter });
  assert.equal(+result.scanNextAttemptAt, BASE + 3 * 60 * 1000 + 240 * 1000, 'then 4');

  // One event for the outage (not one per retry), carrying the first attempt's number.
  assert.deepEqual(eventsOf(doc.id), ['scan_error']);
  assert.equal(db.events[0].detail.attempts, 1);
});

test('after the tenth attempt the document is failed for good: one event, one log line, never scanned again', async () => {
  reset();
  const doc = addDoc({});
  let calls = 0;
  const flaky = async () => { calls += 1; return { status: 'error', detail: 'the scan timed out' }; };
  const logs = await logsOf(async () => {
    for (let i = 1; i <= 10; i += 1) {
      const result = await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(i * 120), rng: noJitter });
      assert.equal(result.scanAttempts, i);
      assert.equal(result.scanStatus, i < 10 ? 'error' : 'failed', `after attempt ${i}`);
      if (i < 10) assert.equal(+result.scanNextAttemptAt - at(i * 120)(), scanBackoffMs(i, { rng: noJitter }));
    }
  });
  const final = row(doc.id);
  assert.equal(calls, 10, 'exactly ten scans, the first included');
  assert.equal(final.scanNextAttemptAt, null, 'a final state has no schedule');
  assert.match(final.scanDetail, /^scan retries exhausted after 10 attempts: the scan timed out$/);
  assert.deepEqual(eventsOf(doc.id), ['scan_error', 'scan_failed']);
  assert.deepEqual([db.events[1].detail.attempts, db.events[1].detail.reason], [10, 'retries_exhausted']);
  assert.equal(logs.error.length, 1);
  assert.match(logs.error[0], /could not be scanned after 10 attempts.*will not be retried/);

  // Final: neither a direct call nor a sweep touches it again, however late.
  await review.scanRequestDocument(doc.id, { scanner: flaky, clock: at(99999) });
  const swept = await review.sweepPendingScans({ scanner: flaky, clock: at(99999) });
  assert.deepEqual([calls, swept.due, row(doc.id).scanAttempts, row(doc.id).scanStatus], [10, 0, 10, 'failed']);
});

test('a clean or infected verdict ends the schedule; an infected file is still quarantined', async () => {
  reset();
  const first = addDoc({});
  const second = addDoc({});
  await review.scanRequestDocument(first.id, { scanner: async () => ({ status: 'error', detail: 'busy' }), clock: at(0), rng: noJitter });
  assert.ok(row(first.id).scanNextAttemptAt);
  await review.scanRequestDocument(first.id, { scanner: clean, clock: at(5) });
  assert.deepEqual([row(first.id).scanStatus, row(first.id).scanNextAttemptAt, row(first.id).scanAttempts], ['clean', null, 2]);

  const key = row(second.id).storageKey;
  await logsOf(() => review.scanRequestDocument(second.id, { scanner: async () => ({ status: 'infected', signature: 'Test-Signature' }), clock: at(0) }));
  assert.deepEqual([row(second.id).scanStatus, row(second.id).scanNextAttemptAt, row(second.id).scanAttempts], ['infected', null, 1]);
  assert.ok(fs.existsSync(path.join(UPLOADS, 'quarantine', key)), 'moved to quarantine');
  assert.ok(!fs.existsSync(path.join(UPLOADS, key)), 'and gone from the uploads folder');
});

test('replaced (superseded) documents are never claimed or counted, even when they are due', async () => {
  reset();
  const old = addDoc({ supersededAt: new Date(), scanStatus: 'error', scanAttempts: 3 });
  const oldPending = addDoc({ supersededAt: new Date() });
  let calls = 0;
  const scanner = async () => { calls += 1; return { status: 'clean' }; };
  const swept = await review.sweepPendingScans({ scanner, clock: at(1000) });
  await review.scanRequestDocument(old.id, { scanner, clock: at(1000) });
  await review.scanRequestDocument(oldPending.id, { scanner, clock: at(1000) });
  assert.deepEqual([calls, swept.due, row(old.id).scanAttempts, row(oldPending.id).scanAttempts], [0, 0, 3, 0]);
});

// ---- 9. the ClamAV health check ----------------------------------------------------------------------------
test('while ClamAV is unavailable a sweep scans nothing and uses up no attempts', async () => {
  reset();
  const docs = [addDoc({}), addDoc({ scanStatus: 'error', scanAttempts: 4, scanNextAttemptAt: new Date(BASE - 1000) })];
  let scans = 0;
  let pings = 0;
  const scanner = async () => { scans += 1; return { status: 'clean' }; };
  const health = async () => { pings += 1; return false; };
  for (let i = 0; i < 5; i += 1) {
    const result = await review.sweepPendingScans({ scanner, health, clock: at(i) });
    assert.deepEqual(result, { checked: 0, scanned: 0, failed: 0, waiting: 0, due: 2, scannerUnavailable: true });
  }
  assert.deepEqual([scans, pings], [0, 5]);
  assert.deepEqual(docs.map((d) => [row(d.id).scanAttempts, row(d.id).scanStatus]), [[0, 'pending'], [4, 'error']], 'not claimed, not counted, not changed');
  assert.equal(db.events.length, 0);

  // ClamAV is back: the same documents are scanned at once, with their budget intact.
  const result = await review.sweepPendingScans({ scanner, health: async () => true, clock: at(6) });
  assert.deepEqual([result.scanned, scans], [2, 2]);
  assert.deepEqual(docs.map((d) => row(d.id).scanAttempts), [1, 5]);
});

test('no ClamAV question is asked when nothing is due', async () => {
  reset();
  addDoc({ scanStatus: 'error', scanAttempts: 1, scanNextAttemptAt: new Date(BASE + 3600e3) }); // backing off
  addDoc({ scanStatus: 'clean' });
  let pings = 0;
  const result = await review.sweepPendingScans({ scanner: clean, health: async () => { pings += 1; return true; }, clock: at(0) });
  assert.deepEqual([result.checked, result.due, pings], [0, 0, 0]);
});

test('ClamAV going away during a sweep gives the attempt back and stops the sweep', async () => {
  reset();
  const [a, b, c] = [addDoc({}), addDoc({}), addDoc({})];
  let up = true;
  let scans = 0;
  const scanner = async () => { scans += 1; up = false; return { status: 'error', detail: 'cannot reach the scanner (ECONNRESET)' }; };
  const logs = await logsOf(async () => {
    const result = await review.sweepPendingScans({ scanner, health: async () => up, clock: at(0) });
    assert.equal(result.scannerUnavailable, true);
    assert.equal(result.checked, 1, 'the rest of the sweep was skipped');
  });
  assert.equal(scans, 1);
  assert.deepEqual([row(a.id).scanStatus, row(a.id).scanAttempts, row(a.id).scanNextAttemptAt], ['error', 0, null], 'unusable, but the attempt was not used');
  assert.deepEqual([b, c].map((d) => [row(d.id).scanStatus, row(d.id).scanAttempts]), [['pending', 0], ['pending', 0]]);
  assert.deepEqual(eventsOf(a.id), ['scan_error']);
  assert.equal(logs.warn.length, 1);
});

test('the real health check: PONG is up; a refused connection, silence, a wrong answer and a dropped connection are down', async () => {
  const clamd = await startFakeClamd('ok');
  try {
    const options = { host: '127.0.0.1', port: clamd.port, timeoutMs: 400 };
    assert.equal(await clamav.ping(options), true);
    assert.equal(clamd.state.pings, 1);
    assert.equal(clamd.state.scans, 0, 'PING is not a scan');
    for (const mode of ['hang', 'garbage', 'close']) {
      clamd.setMode(mode);
      assert.equal(await clamav.ping(options), false, mode);
    }
  } finally {
    await clamd.close();
  }
  assert.equal(await clamav.ping({ host: '127.0.0.1', port: await unusedPort(), timeoutMs: 400 }), false);
});

test('a sweep with the real client skips everything while ClamAV is down and works again once it is back', async () => {
  reset();
  const clamd = await startFakeClamd('ok');
  const previous = process.env.CLAMAV_PORT;
  try {
    process.env.CLAMAV_PORT = String(clamd.port);
    const doc = addDoc({});
    clamd.setMode('close'); // answers neither PING nor scans
    assert.equal((await review.sweepPendingScans({ clock: at(0) })).scannerUnavailable, true);
    assert.deepEqual([clamd.state.scans, row(doc.id).scanAttempts, row(doc.id).scanStatus], [0, 0, 'pending']);
    clamd.setMode('ok');
    assert.equal((await review.sweepPendingScans({ clock: at(1) })).scanned, 1);
    assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['clean', 1]);
  } finally {
    if (previous === undefined) delete process.env.CLAMAV_PORT; else process.env.CLAMAV_PORT = previous;
    await clamd.close();
  }
});

// ---- 10. claims, leases and stale workers ------------------------------------------------------------------
test('two workers racing for one document: exactly one scans it, and it is counted once', async () => {
  reset();
  const doc = addDoc({});
  let scans = 0;
  const scanner = async () => { scans += 1; await sleep(15); return { status: 'clean' }; };
  const [one, two] = await Promise.all([
    review.scanRequestDocument(doc.id, { scanner, clock: at(0) }),
    review.scanRequestDocument(doc.id, { scanner, clock: at(0) }),
  ]);
  assert.equal(scans, 1);
  assert.deepEqual([one.id, two.id], [doc.id, doc.id]);
  assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['clean', 1]);
  assert.deepEqual(eventsOf(doc.id), ['scan_clean'], 'one verdict, one event');
});

test('two sweeps at once never scan the same document twice', async () => {
  reset();
  const docs = [addDoc({}), addDoc({}), addDoc({})];
  const seen = [];
  const scanner = async (file) => { seen.push(path.basename(file)); await sleep(5); return { status: 'clean' }; };
  await Promise.all([review.sweepPendingScans({ scanner, clock: at(0) }), review.sweepPendingScans({ scanner, clock: at(0) })]);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);
  assert.ok(docs.every((d) => row(d.id).scanStatus === 'clean' && row(d.id).scanAttempts === 1));
});

test('a claimed document is protected by its lease, and recovered when the lease runs out (a crashed worker)', async () => {
  reset();
  const doc = addDoc({});
  // A worker claimed it and is stuck (as if it died): the row is left claimed with a lease and no verdict.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stuck = review.scanRequestDocument(doc.id, { scanner: () => gate, clock: at(0) });
  await sleep(5);
  assert.deepEqual([row(doc.id).scanAttempts, +row(doc.id).scanNextAttemptAt], [1, BASE + SCAN_RETRY.leaseMs]);

  let calls = 0;
  const scanner = async () => { calls += 1; return { status: 'clean' }; };
  const early = await review.sweepPendingScans({ scanner, clock: at(4) });
  assert.deepEqual([early.due, calls], [0, 0], 'the lease holds: nobody else scans it');

  const after = await review.sweepPendingScans({ scanner, clock: at(6) });
  assert.deepEqual([after.scanned, calls], [1, 1], 'the lease ran out: another worker takes over');
  assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['clean', 2], 'the crashed attempt was counted');
  release({ status: 'error', detail: 'late' });
  await stuck;
});

test('a cut-off worker that wakes up late cannot overwrite the newer result', async () => {
  reset();
  const doc = addDoc({});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Worker A claims at minute 0 and then stalls inside the scanner.
  const workerA = review.scanRequestDocument(doc.id, { scanner: () => gate, clock: at(0) });
  await sleep(5);
  // Its lease runs out; worker B claims and records "infected".
  await logsOf(() => review.scanRequestDocument(doc.id, { scanner: async () => ({ status: 'infected', signature: 'Test-Signature' }), clock: at(10) }));
  assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['infected', 2]);
  // A finally answers "clean" for the same file.
  release({ status: 'clean' });
  const result = await workerA;
  assert.equal(result.scanStatus, 'infected', 'the newer verdict stands');
  assert.deepEqual(eventsOf(doc.id), ['scan_infected'], 'and A recorded nothing');
});

test('a stale worker cannot undo a newer retry schedule either', async () => {
  reset();
  const doc = addDoc({});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const workerA = review.scanRequestDocument(doc.id, { scanner: () => gate, clock: at(0) });
  await sleep(5);
  await review.scanRequestDocument(doc.id, { scanner: async () => ({ status: 'error', detail: 'busy' }), clock: at(10), rng: noJitter });
  const before = JSON.stringify(row(doc.id));
  release({ status: 'clean' });
  await logsOf(() => workerA);
  assert.equal(JSON.stringify(row(doc.id)), before, 'A changed nothing');
});

test('a crash on the last attempt fails the document without scanning it again', async () => {
  reset();
  // Attempt ten was claimed and its worker died; the lease is over.
  const doc = addDoc({ scanStatus: 'error', scanAttempts: 10, scanNextAttemptAt: new Date(BASE), scanDetail: 'the scan timed out' });
  let calls = 0;
  const logs = await logsOf(async () => {
    const result = await review.sweepPendingScans({ scanner: async () => { calls += 1; return { status: 'clean' }; }, clock: at(10) });
    assert.deepEqual([result.failed, result.scanned], [1, 0]);
  });
  assert.equal(calls, 0, 'never scanned an eleventh time');
  assert.equal(row(doc.id).scanStatus, 'failed');
  assert.match(row(doc.id).scanDetail, /retries exhausted after 10 attempts.*did not finish/);
  assert.deepEqual(eventsOf(doc.id), ['scan_failed']);
  assert.equal(logs.error.length, 1);
});

test('a document waiting from before Phase 2 (no attempts, no schedule) is due at once with its full budget', async () => {
  reset();
  const legacy = addDoc({ scanStatus: 'error', scannedAt: new Date('2026-01-01') });
  const result = await review.sweepPendingScans({ scanner: clean, clock: at(0) });
  assert.deepEqual([result.scanned, row(legacy.id).scanAttempts], [1, 1]);
});

test('documents with no schedule go first, then the one due longest ago', async () => {
  reset();
  const lateOne = addDoc({ scanStatus: 'error', scanAttempts: 2, scanNextAttemptAt: new Date(BASE + 120e3) });
  const earlyOne = addDoc({ scanStatus: 'error', scanAttempts: 2, scanNextAttemptAt: new Date(BASE + 60e3) });
  const fresh = addDoc({});
  const order = [];
  await review.sweepPendingScans({ scanner: async (file) => { order.push(path.basename(file)); return { status: 'clean' }; }, clock: at(10) });
  assert.deepEqual(order, [fresh, earlyOne, lateOne].map((d) => d.storageKey));
});

// ---- 11. the migration ---------------------------------------------------------------------------------------
test('the Phase 2 migration is additive only and matches the Prisma schema', () => {
  const dir = path.join(__dirname, '..', '..', 'prisma', 'migrations', '20261109100000_scan_retry_backoff');
  const up = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8').replace(/--.*$/gm, '');
  const down = fs.readFileSync(path.join(dir, 'down.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.ok(!/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|MODIFY|CHANGE)\b/i.test(up), 'nothing existing is changed or removed');
  assert.match(up, /ADD COLUMN `scan_attempts` INTEGER NOT NULL DEFAULT 0/);
  assert.match(up, /ADD COLUMN `scan_next_attempt_at` DATETIME\(3\) NULL/);
  assert.match(up, /CREATE INDEX `request_documents_scan_status_scan_next_attempt_at_idx` ON `request_documents`\(`scan_status`, `scan_next_attempt_at`\)/);
  assert.equal((up.match(/ALTER TABLE/g) || []).length, 1);
  assert.match(down, /DROP INDEX `request_documents_scan_status_scan_next_attempt_at_idx`/);
  assert.match(down, /DROP COLUMN `scan_attempts`/);
  assert.match(down, /DROP COLUMN `scan_next_attempt_at`/);

  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('model RequestDocument'), schema.indexOf('model RequestEvent'));
  assert.match(model, /scanAttempts\s+Int\s+@default\(0\)\s+@map\("scan_attempts"\)/);
  assert.match(model, /scanNextAttemptAt\s+DateTime\?\s+@map\("scan_next_attempt_at"\)/);
  assert.match(model, /@@index\(\[scanStatus, scanNextAttemptAt\]\)/);
  assert.ok('request_documents_scan_status_scan_next_attempt_at_idx'.length <= 64, 'within the MySQL identifier limit');
});

// ---- 12. storage outages never use up the retry budget -----------------------------------------------------
const fsError = (code) => Object.assign(new Error(`${code}: simulated`), { code });

test('an uploads-folder outage of any length never exhausts the attempts; the document is scanned once the folder is back', async () => {
  reset();
  addDoc({ scanStatus: 'clean' }); // a witness for the moment the folder is back
  const target = addDoc({});
  const away = `${UPLOADS}-away`;
  fs.renameSync(UPLOADS, away); // the whole folder is gone
  try {
    const logs = await logsOf(async () => {
      for (let i = 0; i < 25; i += 1) { // 25 retries, far more than the 10 attempts, over more than a day
        const result = await review.scanRequestDocument(target.id, { scanner: clean, clock: at(i * 60), rng: noJitter });
        assert.deepEqual([result.scanStatus, result.scanAttempts], ['error', 0], `round ${i}`);
        assert.equal(+result.scanNextAttemptAt, at(i * 60)() + SCAN_RETRY.storageRecheckMs, 'looked at again after the storage recheck delay');
      }
    });
    assert.match(row(target.id).scanDetail, /upload folder is unavailable/);
    assert.deepEqual(eventsOf(target.id), ['scan_error'], 'recorded once, not on every round');
    assert.equal(logs.warn.length, 1, 'and logged once');
    assert.equal(logs.error.length, 0);
  } finally {
    fs.renameSync(away, UPLOADS);
  }
  await logsOf(() => review.scanRequestDocument(target.id, { scanner: clean, clock: at(25 * 60) }));
  assert.deepEqual([row(target.id).scanStatus, row(target.id).scanAttempts, row(target.id).scanNextAttemptAt], ['clean', 1, null], 'scanned, with its full budget intact');
});

test('a storage outage is not looked at again before the recheck delay, and the sweep keeps going', async () => {
  reset();
  addDoc({ scanStatus: 'clean' });
  const target = addDoc({}, { write: false });
  const other = addDoc({});
  const away = `${UPLOADS}-away2`;
  fs.renameSync(UPLOADS, away);
  try {
    await logsOf(async () => {
      const first = await review.sweepPendingScans({ scanner: clean, clock: at(0) });
      assert.deepEqual([first.checked, first.scannerUnavailable, first.failed], [2, false, 0], 'a storage problem does not stop the sweep (ClamAV is fine)');
      assert.equal((await review.sweepPendingScans({ scanner: clean, clock: at(4) })).due, 0, 'not due again for 5 minutes');
      assert.equal((await review.sweepPendingScans({ scanner: clean, clock: at(5) })).due, 2);
    });
  } finally {
    fs.renameSync(away, UPLOADS);
  }
  assert.deepEqual([target, other].map((d) => [row(d.id).scanStatus, row(d.id).scanAttempts]), [['error', 0], ['error', 0]]);
});

test('permission and I/O errors on the stored file are storage problems: retried for ever, never counted', async () => {
  reset();
  const doc = addDoc({});
  let calls = 0;
  const codes = ['EACCES', 'EPERM', 'EIO', 'EBUSY', 'EMFILE', 'ESTALE', 'ETIMEDOUT', 'EROFS', 'ENOTDIR'];
  const scanner = async () => { calls += 1; throw fsError(codes[(calls - 1) % codes.length]); };
  await logsOf(async () => {
    for (let i = 0; i < 27; i += 1) {
      const result = await review.scanRequestDocument(doc.id, { scanner, clock: at(i * 10) });
      assert.deepEqual([result.scanStatus, result.scanAttempts], ['error', 0], `${codes[i % codes.length]} round ${i}`);
    }
  });
  assert.equal(calls, 27);
  assert.deepEqual(eventsOf(doc.id), ['scan_error']);
  // The storage heals: the document is scanned and keeps all ten attempts in reserve.
  await review.scanRequestDocument(doc.id, { scanner: clean, clock: at(1000) });
  assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['clean', 1]);
});

test('ClamAV being unable to read the file from a failing disk counts as a storage problem too', async () => {
  reset();
  const doc = addDoc({});
  const unreadable = async () => ({ status: 'error', detail: 'cannot read the file (EIO)', fsCode: 'EIO' });
  await logsOf(async () => {
    for (let i = 0; i < 12; i += 1) assert.equal((await review.scanRequestDocument(doc.id, { scanner: unreadable, clock: at(i * 10) })).scanAttempts, 0);
  });
  assert.equal(row(doc.id).scanStatus, 'error');

  // The real client reports the file-system code, and a vanished file is not mistaken for a storage fault.
  const clamd = await startFakeClamd('ok');
  try {
    const verdict = await clamav.scanFile(path.join(UPLOADS, 'no-such-file.pdf'), { host: '127.0.0.1', port: clamd.port, timeoutMs: 800 });
    assert.deepEqual([verdict.status, verdict.fsCode], ['error', 'ENOENT']);
  } finally {
    await clamd.close();
  }
});

test('ordinary scan failures still use bounded retries: unknown errors and ClamAV errors end in failed after ten attempts', async () => {
  for (const scanner of [
    async () => { throw fsError('EWHATEVER'); }, // not a storage code
    async () => ({ status: 'error', detail: 'unexpected answer: INSTREAM size limit exceeded. ERROR' }), // ClamAV answers, but with an error
    async () => ({ status: 'error', detail: 'scan timed out' }),
  ]) {
    reset();
    const doc = addDoc({});
    let calls = 0;
    await logsOf(async () => {
      for (let i = 1; i <= 12; i += 1) await review.scanRequestDocument(doc.id, { scanner: async (f) => { calls += 1; return scanner(f); }, clock: at(i * 120), rng: noJitter });
    });
    assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts, calls], ['failed', 10, 10]);
  }
});

test('a genuinely missing file still fails for good at once when the storage is proven intact (Phase 1 rule), using one attempt', async () => {
  reset();
  addDoc({ scanStatus: 'clean' }); // witness: another clean document whose file is there
  const gone = addDoc({}, { write: false });
  await logsOf(async () => assert.equal((await review.scanRequestDocument(gone.id, { scanner: clean, clock: at(0) })).scanStatus, 'failed'));
  assert.deepEqual([row(gone.id).scanAttempts, row(gone.id).scanNextAttemptAt], [1, null]);
  assert.match(row(gone.id).scanDetail, /stored file is missing/);
  assert.deepEqual(eventsOf(gone.id), ['scan_failed']);
});

test('a missing file with no proof that the storage is intact is never failed, however often it is retried, and never counted', async () => {
  reset();
  const lonely = addDoc({}, { write: false }); // no other clean document to vouch for the storage
  let calls = 0;
  await logsOf(async () => {
    for (let i = 0; i < 20; i += 1) {
      const result = await review.scanRequestDocument(lonely.id, { scanner: async () => { calls += 1; return { status: 'clean' }; }, clock: at(i * 10) });
      assert.deepEqual([result.scanStatus, result.scanAttempts], ['error', 0], `round ${i}`);
    }
  });
  assert.equal(calls, 0, 'ClamAV was never asked about a file that is not there');
  assert.equal(row(lonely.id).scanNextAttemptAt.getTime(), at(190)() + SCAN_RETRY.storageRecheckMs);
  // Once something vouches for the storage, the file is called lost for good.
  addDoc({ scanStatus: 'clean' });
  await logsOf(() => review.scanRequestDocument(lonely.id, { scanner: clean, clock: at(1000) }));
  assert.equal(row(lonely.id).scanStatus, 'failed');
});

test('a checksum mismatch is a permanent failure, not a storage problem', async () => {
  reset();
  const doc = addDoc({}, { content: PDF });
  fs.writeFileSync(path.join(UPLOADS, doc.storageKey), 'someone changed this file');
  await logsOf(() => review.scanRequestDocument(doc.id, { scanner: clean, clock: at(0) }));
  assert.deepEqual([row(doc.id).scanStatus, row(doc.id).scanAttempts], ['failed', 1]);
});

test('the ClamAV health gate is unchanged: it still protects the budget, and does not apply to a storage problem', async () => {
  reset();
  const doc = addDoc({});
  const logs = await logsOf(async () => {
    const down = await review.sweepPendingScans({ scanner: clean, health: async () => false, clock: at(0) });
    assert.deepEqual([down.scannerUnavailable, down.checked, row(doc.id).scanAttempts], [true, 0, 0]);
  });
  assert.equal(logs.error.length, 0);
  // With ClamAV up, an ordinary failure still counts.
  await review.scanRequestDocument(doc.id, { scanner: async () => ({ status: 'error', detail: 'busy' }), health: async () => true, clock: at(1), rng: noJitter });
  assert.equal(row(doc.id).scanAttempts, 1);
});
