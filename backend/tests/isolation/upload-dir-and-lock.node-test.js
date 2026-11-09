// Checks for the integration-session isolation: the HC_UPLOAD_DIR setting and the Jest lock guard.
//
//   npm run test:isolation        (plain node:test; this is NOT a Jest test, on purpose)
//
// It never connects to a database and never starts Jest. The file name does not match Jest's default
// testMatch, so `npm test` (which empties humancare_test first) does not pick it up. Everything that
// depends on the environment runs in a child process, because the upload directory is read once when
// the module is first loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.join(__dirname, '..', '..');
const DEFAULT_UPLOADS = path.join(BACKEND, 'uploads');

// Runs `script` in a fresh node process from `cwd`, with the given extra environment, and returns its stdout.
function run(script, { env = {}, cwd = BACKEND, drop = [] } = {}) {
  const base = { ...process.env };
  // The test-mode upload folder (NODE_ENV=test + UPLOAD_DIR, see upload.middleware.js) must not leak in from
  // the shell either: these checks are about the default and HC_UPLOAD_DIR behaviour.
  for (const key of ['HC_UPLOAD_DIR', 'NODE_ENV', 'UPLOAD_DIR']) delete base[key];
  for (const key of drop) delete base[key];
  return execFileSync(process.execPath, ['-e', script], { cwd, env: { ...base, ...env }, encoding: 'utf8' }).trim();
}

const printUploadDir = `console.log(JSON.stringify(require(${JSON.stringify(path.join(BACKEND, 'src', 'middleware', 'upload.middleware'))}).UPLOAD_DIR))`;
const uploadDirWith = (env, cwd) => JSON.parse(run(printUploadDir, { env, cwd }));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-isolation-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ---- HC_UPLOAD_DIR ----------------------------------------------------------------------------

test('without HC_UPLOAD_DIR the upload directory is exactly the old default: backend/uploads', () => {
  assert.equal(uploadDirWith({}), DEFAULT_UPLOADS);
  assert.equal(uploadDirWith({}), path.join(BACKEND, 'src', 'middleware', '..', '..', 'uploads')); // the original expression
});

test('a blank HC_UPLOAD_DIR is the same as unset', () => {
  assert.equal(uploadDirWith({ HC_UPLOAD_DIR: '' }), DEFAULT_UPLOADS);
  assert.equal(uploadDirWith({ HC_UPLOAD_DIR: '   ' }), DEFAULT_UPLOADS);
});

test('an absolute HC_UPLOAD_DIR is used as given, and created (nested) when it does not exist', () => {
  const dir = path.join(scratch, 'abs', 'nested', 'uploads');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(uploadDirWith({ HC_UPLOAD_DIR: dir }), dir);
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('surrounding spaces are ignored, and a relative HC_UPLOAD_DIR is resolved against the working directory', () => {
  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(cwd);
  assert.equal(uploadDirWith({ HC_UPLOAD_DIR: '  rel-uploads  ' }, cwd), path.join(cwd, 'rel-uploads'));
  assert.equal(fs.statSync(path.join(cwd, 'rel-uploads')).isDirectory(), true);
});

test('the real upload middleware stores into HC_UPLOAD_DIR and leaves backend/uploads untouched', () => {
  const dir = path.join(scratch, 'integration-uploads');
  const before = fs.readdirSync(DEFAULT_UPLOADS).sort();
  const script = `
    const express = require('express');
    const { upload, UPLOAD_DIR } = require(${JSON.stringify(path.join(BACKEND, 'src', 'middleware', 'upload.middleware'))});
    const app = express();
    app.post('/up', upload.single('file'), (req, res) => res.json({ stored: req.file.path, dir: UPLOAD_DIR }));
    const server = app.listen(0, '127.0.0.1', async () => {
      const form = new FormData();
      form.append('file', new Blob(['%PDF-1.4 isolation check'], { type: 'application/pdf' }), 'report one.pdf');
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/up', { method: 'POST', body: form });
      console.log(JSON.stringify({ status: res.status, body: await res.json() }));
      server.close();
    });`;
  const out = JSON.parse(run(script, { env: { HC_UPLOAD_DIR: dir } }));
  assert.equal(out.status, 200);
  assert.equal(path.dirname(out.body.stored), dir);
  assert.match(path.basename(out.body.stored), /^\d+-report_one\.pdf$/); // same naming as before
  assert.equal(fs.readFileSync(out.body.stored, 'utf8'), '%PDF-1.4 isolation check');
  assert.deepEqual(fs.readdirSync(DEFAULT_UPLOADS).sort(), before); // nothing new in the dev folder
});

test('every consumer takes the directory from the shared constant, and the quarantine folder is derived from it', () => {
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) sources.push(full);
    }
  })(path.join(BACKEND, 'src'));

  const middleware = path.join(BACKEND, 'src', 'middleware', 'upload.middleware.js');
  const guardFile = path.join(BACKEND, 'src', 'common', 'safety', 'test-database-guard.js');
  const importsConstant = /\{[^}]*\bUPLOAD_DIR\b[^}]*\}\s*=\s*require\('(?:\.\.\/)+middleware\/upload\.middleware'\)/;
  const consumers = [];
  for (const file of sources) {
    if (file === middleware) continue;
    const text = fs.readFileSync(file, 'utf8');
    // No other file builds its own uploads directory.
    assert.doesNotMatch(text, /(?:join|resolve)\([^)]*['"`]uploads['"`]/, `${path.relative(BACKEND, file)} builds its own uploads path`);
    // The test-database guard (Admin Lock) names UPLOAD_DIR as an ENVIRONMENT VARIABLE and returns the fixed
    // test folder; it does not consume the middleware's constant. It still has to pass the "no own uploads
    // path" check above, and the middleware (which calls it) is the only place the constant is defined.
    if (file !== guardFile && /\bUPLOAD_DIR\b/.test(text)) {
      assert.match(text, importsConstant, `${path.relative(BACKEND, file)} uses UPLOAD_DIR without importing it from the middleware`);
      consumers.push(path.relative(BACKEND, file).split(path.sep).join('/'));
    }
  }
  assert.deepEqual(consumers.sort(), [
    'src/modules/admin/admin.controller.js',
    'src/modules/bitrix/bitrix.service.js',
    'src/modules/corporate-portal/corporate-portal.controller.js',
    'src/modules/corporate-portal/corporate-portal.service.js',
    'src/modules/corporate-registration/corporate-registration.controller.js',
    'src/modules/documents/documents.controller.js',
    'src/modules/request-review/request-review.files.js',
    'src/modules/request-review/request-review.service.js',
  ]);
  const review = fs.readFileSync(path.join(BACKEND, 'src', 'modules', 'request-review', 'request-review.service.js'), 'utf8');
  assert.match(review, /QUARANTINE_DIR\s*=\s*path\.join\(UPLOAD_DIR,\s*'quarantine'\)/);
  // The four route files that accept uploads use the shared multer instance (and so the same directory).
  for (const routes of ['requests/requests', 'cases/cases', 'corporate-portal/corporate-portal', 'corporate-registration/corporate-registration']) {
    assert.match(fs.readFileSync(path.join(BACKEND, 'src', 'modules', `${routes}.routes.js`), 'utf8'), /\{\s*upload\s*\}\s*=\s*require\('\.\.\/\.\.\/middleware\/upload\.middleware'\)/);
  }
});

// ---- the Jest guard ---------------------------------------------------------------------------

const setupFile = path.join(BACKEND, 'tests', 'global-setup.js');

test('the lock file lives at backend/.integration-session.lock and is ignored by git', () => {
  const setup = require(setupFile);
  assert.equal(setup.INTEGRATION_LOCK, path.join(BACKEND, '.integration-session.lock'));
  const ignored = execFileSync('git', ['check-ignore', '-v', 'backend/.integration-session.lock'], { cwd: path.join(BACKEND, '..'), encoding: 'utf8' });
  assert.match(ignored, /backend\/\.gitignore/);
});

test('assertNoIntegrationSession: throws a clear error when the lock exists, silent when it does not', () => {
  const { assertNoIntegrationSession } = require(setupFile);
  const lock = path.join(scratch, 'fake.lock');
  assert.doesNotThrow(() => assertNoIntegrationSession(lock));
  fs.writeFileSync(lock, '');
  assert.throws(
    () => assertNoIntegrationSession(lock),
    (err) => /integration session is active/.test(err.message) && /empty every table of humancare_test/.test(err.message) && /delete the lock file/.test(err.message) && /Nothing was changed/.test(err.message),
  );
});

// A stand-in for a valid test environment: it passes the safety guard (src/common/safety/test-database-guard.js)
// but is not a credential - dotenv and the Prisma client are replaced below, so nothing ever connects with it.
const GUARD_PASSING_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'mysql://humancare_test_stub:not-a-password@127.0.0.1:3306/humancare_test?connection_limit=1',
  UPLOAD_DIR: '.e2e-uploads',
  EMAIL_PROVIDER: 'console',
};
// Variables of the surrounding shell that could change what the guard sees.
const AMBIENT_GUARD_INPUTS = ['DATABASE_URL', 'EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

// Loads global-setup.js in a child with `fs.existsSync(<lock>)` forced to `lockExists`, and with dotenv and
// the Prisma client replaced by recorders, so nothing can connect to a database or read an env file.
// `env` is the whole environment the guard may see (the shell's own guard inputs are removed first).
// The Prisma stand-in answers the live-database question with a database that is NOT humancare_test.
function runGlobalSetup(lockExists, env = {}) {
  const script = `
    const fs = require('fs');
    const Module = require('module');
    const lock = ${JSON.stringify(path.join(BACKEND, '.integration-session.lock'))};
    const realExists = fs.existsSync;
    fs.existsSync = (p) => (p === lock ? ${lockExists} : realExists(p));
    const seen = { dotenvLoaded: false, prismaLoaded: false, queries: [] };
    const realLoad = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'dotenv') { seen.dotenvLoaded = true; return { config() {} }; }
      if (request === '@prisma/client') {
        seen.prismaLoaded = true;
        return { PrismaClient: class { async $queryRawUnsafe(sql) { seen.queries.push(String(sql)); return [{ db: 'not_the_test_database', account: 'humancare_test_stub@localhost' }]; } async $disconnect() {} } };
      }
      return realLoad.call(this, request, ...rest);
    };
    require(${JSON.stringify(setupFile)})().then(
      () => console.log(JSON.stringify({ outcome: 'resolved', ...seen })),
      (err) => console.log(JSON.stringify({ outcome: 'rejected', message: err.message, ...seen })),
    );`;
  return JSON.parse(run(script, { env, drop: AMBIENT_GUARD_INPUTS }));
}

test('with the lock present, global setup aborts BEFORE reading env files, creating a Prisma client or running any SQL', () => {
  // Even with a fully valid test environment: the lock is checked first and decides alone.
  const result = runGlobalSetup(true, GUARD_PASSING_ENV);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /integration session is active/);
  assert.equal(result.dotenvLoaded, false);
  assert.equal(result.prismaLoaded, false);
  assert.deepEqual(result.queries, []);
});

test('without the lock, global setup passes the URL and environment guard and stops at the live-database check (with the stub), running no cleanup SQL', () => {
  const result = runGlobalSetup(false, GUARD_PASSING_ENV);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /Test environment safety guard: connected database is not "humancare_test"/);
  assert.equal(result.dotenvLoaded, true);
  assert.equal(result.prismaLoaded, true);
  assert.equal(result.queries.length, 1);
  assert.match(result.queries[0], /SELECT DATABASE\(\)/);
  assert.ok(!result.queries.some((sql) => /DELETE/i.test(sql)));
});

test('without the lock but without a test database URL, global setup refuses BEFORE a Prisma client exists', () => {
  const { DATABASE_URL, ...noUrl } = GUARD_PASSING_ENV;
  const result = runGlobalSetup(false, noUrl);
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /Test environment safety guard: DATABASE_URL is not set/);
  assert.equal(result.prismaLoaded, false);
  assert.deepEqual(result.queries, []);
});

test('without the lock, a URL for any other database (the development one) is refused BEFORE a Prisma client exists', () => {
  const result = runGlobalSetup(false, { ...GUARD_PASSING_ENV, DATABASE_URL: 'mysql://humancare_test_stub:not-a-password@127.0.0.1:3306/humancare_dev' });
  assert.equal(result.outcome, 'rejected');
  assert.match(result.message, /DATABASE_URL must name the database "humancare_test"/);
  assert.equal(result.prismaLoaded, false);
  assert.deepEqual(result.queries, []);
});
