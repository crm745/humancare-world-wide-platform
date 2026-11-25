// Run:  node scripts/verify-request-idempotency-db.js   (from the backend folder)
// Phase 4 verification against humancare_dev ONLY. It refuses to run against any other database.
//   A. the migrated schema: the column and the unique index are what the migration says
//   B. uniqueness semantics ON THE REAL service_requests TABLE, inside a transaction that is ALWAYS rolled back (no request data is created, changed or deleted)
//   C. real concurrent-transaction behaviour (a second insert of the same key WAITS, then fails after a commit / succeeds after a rollback) on a SCRATCH table that this
//      script creates and drops (it never touches service_requests for the concurrent part)
const path = require('path');
const { createRequire } = require('module');
const backend = process.argv[2] || path.join(__dirname, '..'); // the backend folder
const req = createRequire(path.join(backend, 'package.json'));
req('dotenv').config({ path: path.join(backend, '.env'), quiet: true });
const { PrismaClient } = req('@prisma/client');

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (dbName !== 'humancare_dev') { console.error(`REFUSING to run: database is "${dbName}", not humancare_dev`); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isDuplicate = (err) => /Duplicate entry|1062|P2002/.test(`${err && err.message} ${err && err.code} ${JSON.stringify(err && err.meta)}`);
const ROLLBACK = Symbol('rollback on purpose');

(async () => {
  const db = new PrismaClient();
  console.log(`database: ${dbName}`);

  // ---- A. schema
  const [col] = await db.$queryRawUnsafe("SELECT column_name AS name, column_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'service_requests' AND column_name = 'client_request_id'");
  check('A1 column client_request_id exists', !!col);
  check('A2 it is VARCHAR(36) and NULLABLE', !!col && String(col.type).toLowerCase() === 'varchar(36)' && col.nullable === 'YES', col ? `${col.type}, nullable=${col.nullable}` : 'missing');
  const idx = await db.$queryRawUnsafe("SELECT index_name AS name, non_unique AS nonUnique, seq_in_index AS seq, column_name AS col FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'service_requests' AND index_name = 'uq_service_requests_user_client_request' ORDER BY seq_in_index");
  check('A3 unique index uq_service_requests_user_client_request on (user_id, client_request_id) in that order', idx.length === 2 && Number(idx[0].nonUnique) === 0 && idx[0].col === 'user_id' && idx[1].col === 'client_request_id', idx.map((r) => r.col).join(','));
  const [applied] = await db.$queryRawUnsafe("SELECT migration_name AS name, finished_at AS finished FROM _prisma_migrations WHERE migration_name = '20261119130000_service_request_client_request_id'");
  check('A4 the migration is recorded as applied', !!applied && !!applied.finished);

  const [{ total: totalBefore }] = await db.$queryRawUnsafe('SELECT COUNT(*) AS total FROM service_requests');
  const [{ keyed }] = await db.$queryRawUnsafe('SELECT COUNT(*) AS keyed FROM service_requests WHERE client_request_id IS NOT NULL');
  check('A5 every existing request has NULL key (nothing was rewritten)', Number(keyed) === 0, `${totalBefore} rows, ${keyed} keyed`);
  console.log(`service_requests rows before: ${totalBefore}`);

  // ---- A6-A9. the GENERATED Prisma client against the real engine (read-only queries). The engine only validates a query's arguments after it connects, so this cannot be
  // proven offline: a client generated before the schema change would be refused here with "Unknown argument", whatever the database holds.
  const PROBE_KEY = '3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c';
  const accepted = async (name, run, expectation) => {
    try { const value = await run(); check(name, expectation(value), JSON.stringify(value)); } catch (err) { check(name, false, String(err.message).split('\n').filter(Boolean).pop()); }
  };
  await accepted('A6 the client SELECTS clientRequestId through the engine', () => db.serviceRequest.findMany({ select: { id: true, clientRequestId: true }, orderBy: { id: 'desc' }, take: 1 }), (rows) => rows.length === 0 || rows[0].clientRequestId === null);
  await accepted('A7 the client FILTERS by { userId, clientRequestId } (the lookup the app uses)', () => db.serviceRequest.findFirst({ where: { userId: 1, clientRequestId: PROBE_KEY } }), (row) => row === null);
  await accepted('A8 the client accepts the composite unique selector userId_clientRequestId', () => db.serviceRequest.findUnique({ where: { userId_clientRequestId: { userId: 1, clientRequestId: PROBE_KEY } } }), (row) => row === null);
  let control = 'accepted';
  try { await db.serviceRequest.findFirst({ where: { clientRequestIdd: PROBE_KEY } }); } catch (err) { control = err.constructor && err.constructor.name; }
  check('A9 control: a field that does not exist IS refused by the engine (so A6 to A8 prove something)', control === 'PrismaClientValidationError', control);

  // ---- B. semantics on the real table, always rolled back
  const users = await db.$queryRawUnsafe('SELECT id FROM users ORDER BY id LIMIT 2');
  if (users.length < 2) {
    check('B0 two existing users are available for the rolled-back check', false, `found ${users.length}`);
  } else {
    const [userA, userB] = [users[0].id, users[1].id];
    const required = await db.$queryRawUnsafe("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'service_requests' AND is_nullable = 'NO' AND column_default IS NULL AND extra NOT LIKE '%auto_increment%' ORDER BY ordinal_position");
    console.log('required columns without a default:', required.map((r) => r.name).join(', '));
    const K = '11111111-2222-4333-8444-555555555555';
    const insert = (tx, user, key, tag) => tx.$executeRawUnsafe(
      'INSERT INTO service_requests (user_id, service_type, patient_name, origin, destination, reference_number, client_request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      user, 'Verification (rolled back)', 'Verification', 'x', 'y', `VERIFY-${Date.now()}-${tag}-${Math.random().toString(16).slice(2)}`, key,
    );
    const seen = {};
    try {
      await db.$transaction(async (tx) => {
        await insert(tx, userA, K, 'a1');
        seen.first = true;
        try { await insert(tx, userA, K, 'a2'); seen.dupSameUser = 'accepted'; } catch (err) { seen.dupSameUser = isDuplicate(err) ? 'refused' : `other error: ${err.message}`; }
        try { await insert(tx, userB, K, 'b1'); seen.otherUser = 'accepted'; } catch (err) { seen.otherUser = `refused: ${err.message}`; }
        try { await insert(tx, userA, '99999999-8888-4777-8666-555555555555', 'a3'); seen.otherKey = 'accepted'; } catch (err) { seen.otherKey = `refused: ${err.message}`; }
        try { await insert(tx, userA, null, 'n1'); await insert(tx, userA, null, 'n2'); await insert(tx, userA, null, 'n3'); seen.nulls = 'accepted'; } catch (err) { seen.nulls = `refused: ${err.message}`; }
        const [{ inside }] = await tx.$queryRawUnsafe("SELECT COUNT(*) AS inside FROM service_requests WHERE reference_number LIKE 'VERIFY-%'");
        seen.rowsInside = Number(inside);
        throw ROLLBACK;
      });
    } catch (err) { if (err !== ROLLBACK) { check('B transaction ran', false, err.message); } }
    check('B1 same user + same key twice -> the second is REFUSED by the unique index', seen.dupSameUser === 'refused', seen.dupSameUser);
    check('B2 a DIFFERENT user may use the same key', seen.otherUser === 'accepted', seen.otherUser);
    check('B3 the same user with a different key is accepted', seen.otherKey === 'accepted', seen.otherKey);
    check('B4 many requests WITHOUT a key coexist (older app versions)', seen.nulls === 'accepted', seen.nulls);
    check('B5 exactly the accepted rows existed inside the transaction (1 + other user + other key + 3 null = 6)', seen.rowsInside === 6, `${seen.rowsInside}`);
    const [{ leftover }] = await db.$queryRawUnsafe("SELECT COUNT(*) AS leftover FROM service_requests WHERE reference_number LIKE 'VERIFY-%'");
    check('B6 the transaction was rolled back: no verification row remains', Number(leftover) === 0, `${leftover} left`);
  }

  // ---- C. concurrent transactions on a scratch table
  const scratch = `zz_idem_scratch_${Date.now().toString(36)}`;
  const second = new PrismaClient();
  try {
    await db.$executeRawUnsafe(`CREATE TABLE \`${scratch}\` (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, client_request_id VARCHAR(36) NULL, UNIQUE KEY uq (user_id, client_request_id)) ENGINE=InnoDB`);
    const K = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    // C1: the first commits; the second (started while the first still holds the key) waits, then is refused
    {
      let secondStartedAt = 0; let secondDoneAt = 0; let secondOutcome = '';
      const first = db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO \`${scratch}\` (user_id, client_request_id) VALUES (1, ?)`, K); await wait(700); });
      await wait(150);
      const racing = second.$transaction(async (tx) => {
        secondStartedAt = Date.now();
        try { await tx.$executeRawUnsafe(`INSERT INTO \`${scratch}\` (user_id, client_request_id) VALUES (1, ?)`, K); secondOutcome = 'inserted'; } catch (err) { secondOutcome = isDuplicate(err) ? 'duplicate' : `other: ${err.message}`; }
        secondDoneAt = Date.now();
      });
      await Promise.all([first, racing]);
      const [{ n }] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${scratch}\` WHERE user_id = 1 AND client_request_id = ?`, K);
      check('C1 a second insert of the same key WAITS for the first transaction to finish (>= 400 ms)', secondDoneAt - secondStartedAt >= 400, `${secondDoneAt - secondStartedAt} ms`);
      check('C2 after the first COMMITS, the second is refused as a duplicate: exactly one row', secondOutcome === 'duplicate' && Number(n) === 1, `${secondOutcome}, rows=${n}`);
    }
    // C3: the first rolls back; the second then succeeds (a failed first attempt does not burn the key)
    {
      let outcome = '';
      const first = db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO \`${scratch}\` (user_id, client_request_id) VALUES (2, ?)`, K); await wait(500); throw ROLLBACK; }).catch((err) => { if (err !== ROLLBACK) throw err; });
      await wait(150);
      const racing = second.$transaction(async (tx) => {
        try { await tx.$executeRawUnsafe(`INSERT INTO \`${scratch}\` (user_id, client_request_id) VALUES (2, ?)`, K); outcome = 'inserted'; } catch (err) { outcome = isDuplicate(err) ? 'duplicate' : `other: ${err.message}`; }
      });
      await Promise.all([first, racing]);
      const [{ n }] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${scratch}\` WHERE user_id = 2 AND client_request_id = ?`, K);
      check('C3 after the first ROLLS BACK, the second succeeds: exactly one row', outcome === 'inserted' && Number(n) === 1, `${outcome}, rows=${n}`);
    }
    // C4: ten at once: one row
    {
      const clients = Array.from({ length: 9 }, () => new PrismaClient());
      const attempts = [db, ...clients].map((client) => client.$transaction(async (tx) => {
        try { await tx.$executeRawUnsafe(`INSERT INTO \`${scratch}\` (user_id, client_request_id) VALUES (3, ?)`, K); await wait(50); return 'inserted'; } catch (err) { return isDuplicate(err) ? 'duplicate' : `other: ${err.message}`; }
      }));
      const outcomes = await Promise.all(attempts);
      await Promise.all(clients.map((c) => c.$disconnect()));
      const [{ n }] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${scratch}\` WHERE user_id = 3 AND client_request_id = ?`, K);
      check('C4 ten concurrent transactions with the same key: exactly ONE row, one winner, nine refused', Number(n) === 1 && outcomes.filter((o) => o === 'inserted').length === 1 && outcomes.filter((o) => o === 'duplicate').length === 9, `${outcomes.filter((o) => o === 'inserted').length} inserted, ${outcomes.filter((o) => o === 'duplicate').length} duplicate, rows=${n}`);
    }
  } catch (err) {
    check('C scratch-table checks ran', false, err.message);
  } finally {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${scratch}\``).catch((err) => console.error('could not drop scratch table:', err.message));
    const [gone] = await db.$queryRawUnsafe("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", scratch);
    check('C5 the scratch table is dropped', Number(gone.n) === 0);
    await second.$disconnect();
  }

  const [{ total: totalAfter }] = await db.$queryRawUnsafe('SELECT COUNT(*) AS total FROM service_requests');
  check('D service_requests row count is unchanged by this verification', Number(totalAfter) === Number(totalBefore), `${totalBefore} -> ${totalAfter}`);
  await db.$disconnect();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('verification crashed:', err); process.exit(1); });
