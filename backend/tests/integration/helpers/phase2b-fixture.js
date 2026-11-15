// Fixture for the Phase 2B real-MySQL tests: synthetic records, a registry of the EXACT ids created, a baseline
// snapshot and an exact-id cleanup. Used only by the integration runner (jest.integration.config.js), which has
// already taken the session lock and confirmed the database identity.
//
// Safety rules enforced here:
//   - every synthetic record carries this run's unique marker (PHASE2B_TEST_<runid>) in a text column;
//   - the id of every record created is registered (and mirrored to a file so a crashed run can still be cleaned
//     by exact id);
//   - cleanup deletes ONE row per statement, by primary key, only after reading the row and confirming it carries
//     the marker (or, for links, belongs to a registered synthetic Case); each delete must affect exactly 1 row; a
//     row that does not check out stops the cleanup and is reported. There is no delete by prefix, no bulk
//     delete call, no table emptying and no delete without an id.
//   - a snapshot (row counts of every table, CHECKSUM TABLE of the touched tables) is taken first and compared after
//     cleanup, which proves nothing that existed before was modified or removed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const guard = require('../../../src/common/safety/integration-runner-guard');

// Children first: the order records must be deleted in.
const DELETE_ORDER = ['audit', 'stage', 'link', 'outbox', 'inbox', 'case'];
const TOUCHED_TABLES = ['audit_logs', 'case_stage_events', 'bitrix_deal_links', 'integration_outbox', 'integration_inbox', 'cases'];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class Phase2bFixture {
  constructor() {
    this.runId = Date.now().toString(36).toUpperCase();
    this.prefix = `PHASE2B_TEST_${this.runId}`;
    this.ids = { audit: [], stage: [], link: [], outbox: [], inbox: [], case: [] };
    this.clients = [];
    this.registryFile = path.join(os.tmpdir(), `phase2b-registry-${this.runId}.json`);
    this.evidence = [];
    this.counter = 0;
  }

  // A synthetic text value that contains the marker and is unique within the run.
  name(label) {
    this.counter += 1;
    return `${this.prefix}_${label}_${this.counter}`;
  }

  track(kind, id) {
    this.ids[kind].push(Number(id));
    fs.writeFileSync(this.registryFile, JSON.stringify({ prefix: this.prefix, ids: this.ids }));
    return id;
  }

  note(test, facts) {
    this.evidence.push({ test, at: new Date().toISOString(), ...facts });
  }

  // A NEW Prisma client = its own connection pool = separate MySQL connections. The environment is re-validated by the
  // integration guard first, so a client can only ever be built for humancare_test.
  newClient(label = 'client') {
    guard.assertIntegrationEnvironment(process.env);
    const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    client.__label = label;
    this.clients.push(client);
    return client;
  }

  async connectionInfo(client) {
    const [row] = await client.$queryRawUnsafe('SELECT CONNECTION_ID() AS id, UTC_TIMESTAMP(3) AS now');
    return { label: client.__label, connectionId: Number(row.id), dbUtc: row.now.toISOString() };
  }

  // ---- baseline ----------------------------------------------------------------------------------------------
  async snapshot(db) {
    const tables = (await db.$queryRawUnsafe(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
    )).map((r) => String(r.name || r.NAME || r.TABLE_NAME));
    const counts = {};
    for (const name of tables) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('unusual table name');
      const [row] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${name}\``);
      counts[name] = Number(row.n);
    }
    const sums = await db.$queryRawUnsafe(`CHECKSUM TABLE ${TOUCHED_TABLES.map((t) => `\`${t}\``).join(', ')}`);
    const checksums = {};
    // Columns are read by position (table name, checksum): the column names differ between drivers and versions.
    for (const row of sums) {
      const [table, checksum] = Object.values(row);
      checksums[String(table).split('.').pop()] = String(checksum);
    }
    // A comparison that compares nothing proves nothing: every touched table must have a real checksum.
    for (const table of TOUCHED_TABLES) {
      if (!/^\d+$/.test(checksums[table] || '')) throw new Error(`no usable checksum for ${table}; the preservation check would be empty.`);
    }
    return { counts, checksums };
  }

  // ---- cleanup -----------------------------------------------------------------------------------------------
  async cleanup(db) {
    const report = { deleted: {}, failures: [] };
    const caseIds = new Set(this.ids.case);
    const owned = {
      audit: async (id) => { const [r] = await db.$queryRaw`SELECT idempotency_key AS k FROM audit_logs WHERE id = ${id}`; return r && String(r.k || '').includes(this.prefix); },
      stage: async (id) => { const [r] = await db.$queryRaw`SELECT idempotency_key AS k FROM case_stage_events WHERE id = ${id}`; return r && String(r.k || '').includes(this.prefix); },
      link: async (id) => { const [r] = await db.$queryRaw`SELECT case_id AS c FROM bitrix_deal_links WHERE id = ${id}`; return r && caseIds.has(Number(r.c)); },
      outbox: async (id) => { const [r] = await db.$queryRaw`SELECT idempotency_key AS k FROM integration_outbox WHERE id = ${id}`; return r && String(r.k || '').includes(this.prefix); },
      inbox: async (id) => { const [r] = await db.$queryRaw`SELECT external_event_id AS k FROM integration_inbox WHERE id = ${id}`; return r && String(r.k || '').includes(this.prefix); },
      case: async (id) => { const [r] = await db.$queryRaw`SELECT reference_number AS k FROM cases WHERE id = ${id}`; return r && String(r.k || '').includes(this.prefix); },
    };
    const remove = {
      audit: (id) => db.$executeRaw`DELETE FROM audit_logs WHERE id = ${id}`,
      stage: (id) => db.$executeRaw`DELETE FROM case_stage_events WHERE id = ${id}`,
      link: (id) => db.$executeRaw`DELETE FROM bitrix_deal_links WHERE id = ${id}`,
      outbox: (id) => db.$executeRaw`DELETE FROM integration_outbox WHERE id = ${id}`,
      inbox: (id) => db.$executeRaw`DELETE FROM integration_inbox WHERE id = ${id}`,
      case: (id) => db.$executeRaw`DELETE FROM cases WHERE id = ${id}`,
    };
    for (const kind of DELETE_ORDER) {
      report.deleted[kind] = 0;
      for (const id of [...new Set(this.ids[kind])]) {
        const stillThere = await db.$queryRawUnsafe(`SELECT 1 AS x FROM ${this.table(kind)} WHERE id = ${Number(id)}`);
        if (stillThere.length === 0) continue; // already gone (rolled back or removed): nothing to delete
        if (!(await owned[kind](id))) {
          report.failures.push(`${kind} ${id}: not recognised as a synthetic row; NOT deleted. Cleanup stopped.`);
          return report; // never broaden: stop at the first row that does not check out
        }
        const affected = Number(await remove[kind](id));
        if (affected !== 1) {
          report.failures.push(`${kind} ${id}: delete affected ${affected} rows. Cleanup stopped.`);
          return report;
        }
        report.deleted[kind] += 1;
      }
    }
    return report;
  }

  table(kind) {
    return { audit: 'audit_logs', stage: 'case_stage_events', link: 'bitrix_deal_links', outbox: 'integration_outbox', inbox: 'integration_inbox', case: 'cases' }[kind];
  }

  // Counts, by the exact ids registered, how many of the synthetic records still exist.
  async remaining(db) {
    const left = {};
    for (const kind of DELETE_ORDER) {
      const ids = [...new Set(this.ids[kind])].map(Number);
      if (ids.length === 0) { left[kind] = 0; continue; }
      const rows = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${this.table(kind)} WHERE id IN (${ids.join(',')})`);
      left[kind] = Number(rows[0].n);
    }
    return left;
  }

  async disconnectAll() {
    await Promise.all(this.clients.map((c) => c.$disconnect().catch(() => {})));
    this.clients = [];
  }
}

module.exports = { Phase2bFixture, sleep, DELETE_ORDER, TOUCHED_TABLES };
