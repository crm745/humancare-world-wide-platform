// Fixture for the Razorpay order-creation real-MySQL tests: ONE eligible synthetic invoice per call (user, admin, Private Charter service
// request, Case, Deal link, accepted quotation, issued invoice), a registry of the EXACT ids created, a baseline snapshot and an exact-id
// cleanup. Same safety rules as phase2b-fixture.js, which it follows. Used only by the integration runner (jest.integration.config.js),
// which has already taken the session lock and confirmed the database identity.
//
//   - every synthetic record carries this run's unique marker (PAYTEST_<runid>) in a text column;
//   - the id of every record created is registered (and mirrored to a file so a crashed run can still be cleaned by exact id);
//   - cleanup deletes ONE row per statement, by primary key, only after reading the row and confirming it carries the marker (or belongs to
//     a registered synthetic Case / invoice); each delete must affect exactly 1 row; a row that does not check out stops the cleanup;
//   - there is no delete by prefix, no bulk delete, no table emptying and no delete without an id;
//   - a snapshot (row counts of every table, CHECKSUM TABLE of the touched tables) is compared after cleanup, which proves nothing that
//     existed before was modified or removed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const guard = require('../../../src/common/safety/integration-runner-guard');

// Children first: the order records must be deleted in.
const DELETE_ORDER = ['inbox', 'audit', 'payment', 'invoice', 'quotation', 'link', 'case', 'request', 'user', 'admin'];
const TABLE = {
  inbox: 'integration_inbox',
  audit: 'audit_logs', payment: 'payments', invoice: 'invoices', quotation: 'case_quotations', link: 'bitrix_deal_links',
  case: 'cases', request: 'service_requests', user: 'users', admin: 'admin_users',
};
const TOUCHED_TABLES = Object.values(TABLE);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class PaymentsFixture {
  constructor() {
    this.runId = Date.now().toString(36).toUpperCase();
    this.prefix = `PAYTEST_${this.runId}`;
    this.ids = Object.fromEntries(DELETE_ORDER.map((k) => [k, []]));
    this.clients = [];
    this.registryFile = path.join(os.tmpdir(), `paytest-registry-${this.runId}.json`);
    this.evidence = [];
    this.counter = 0;
  }

  name(label) {
    this.counter += 1;
    return `${this.prefix}_${label}_${this.counter}`;
  }

  track(kind, id) {
    this.ids[kind].push(Number(id));
    fs.writeFileSync(this.registryFile, JSON.stringify({ prefix: this.prefix, ids: this.ids }));
    return id;
  }

  note(test, facts) { this.evidence.push({ test, at: new Date().toISOString(), ...facts }); }

  // A NEW Prisma client = its own connection pool = separate MySQL connections. The environment is re-validated by the integration guard
  // first, so a client can only ever be built for humancare_test.
  newClient(label = 'client') {
    guard.assertIntegrationEnvironment(process.env);
    const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    client.__label = label;
    this.clients.push(client);
    return client;
  }

  // One complete, ELIGIBLE invoice for the order-creation service: a Private Charter Case owned by a synthetic patient, an accepted and
  // live quotation, and an issued quotation-source invoice that matches it exactly (the composite foreign key enforces that).
  async buildInvoice(db, { amount = '1500.000', currency = 'INR', allowPartial = false, dueDate = null } = {}) {
    const n = this.counter + 1;
    const user = await db.user.create({ data: { name: this.name('PATIENT'), email: `${this.prefix}_u${n}@example.invalid` } });
    this.track('user', user.id);
    const admin = await db.adminUser.create({ data: { name: this.name('ADMIN'), email: `${this.prefix}_a${n}@example.invalid` } });
    this.track('admin', admin.id);
    const request = await db.serviceRequest.create({
      data: { userId: user.id, serviceType: 'PAYTEST synthetic', serviceKey: 'privatecharter', patientName: this.name('PATIENT'), origin: 'Synthetic-A', destination: 'Synthetic-B', referenceNumber: this.name('SR') },
    });
    this.track('request', request.id);
    const kase = await db.case.create({
      data: { serviceRequestId: request.id, referenceNumber: this.name('CASE'), patientName: this.name('PATIENT'), serviceType: 'PAYTEST synthetic', origin: 'Synthetic-A', destination: 'Synthetic-B' },
    });
    this.track('case', kase.id);
    const link = await db.bitrixDealLink.create({ data: { caseId: kase.id } });
    this.track('link', link.id);
    const now = Date.now();
    const quotation = await db.caseQuotation.create({
      data: {
        caseId: kase.id, dealLinkId: link.id, bitrixDealId: this.name('DEAL'), versionNumber: 1, bitrixFileId: 'F1', contentFingerprint: 'a'.repeat(64),
        storageKey: this.name('KEY'), sizeBytes: 100, sha256: 'b'.repeat(64), scanStatus: 'clean', amount, currency, status: 'accepted', liveSlot: 1,
        confirmedByAdminId: admin.id, confirmedAt: new Date(now - 3000), publishedByAdminId: admin.id, publishedAt: new Date(now - 2000),
        decidedByUserId: user.id, decidedAt: new Date(now - 1000),
      },
    });
    this.track('quotation', quotation.id);
    const invoice = await db.invoice.create({
      data: {
        caseId: kase.id, source: 'quotation', quotationId: quotation.id, amount, currency, status: 'issued', issueDate: new Date(), dueDate,
        idempotencyKey: this.name('INV'), allowPartialPayment: allowPartial,
        ...(allowPartial && { partialPaymentAuthorizedByAdminId: admin.id, partialPaymentAuthorizedAt: new Date() }),
      },
    });
    this.track('invoice', invoice.id);
    return { userId: user.id, adminId: admin.id, caseId: kase.id, linkId: link.id, quotationId: quotation.id, invoiceId: invoice.id, amount, currency };
  }

  // Payment and audit rows are written by the SERVICE under test, so they are found afterwards by the synthetic invoices / Cases they belong to.
  async registerDiscovered(db) {
    const invoiceIds = [...new Set(this.ids.invoice)];
    const caseIds = [...new Set(this.ids.case)];
    if (invoiceIds.length) {
      for (const row of await db.$queryRawUnsafe(`SELECT id FROM payments WHERE invoice_id IN (${invoiceIds.join(',')})`)) if (!this.ids.payment.includes(Number(row.id))) this.track('payment', row.id);
    }
    if (caseIds.length) {
      for (const row of await db.$queryRawUnsafe(`SELECT id FROM audit_logs WHERE case_id IN (${caseIds.join(',')})`)) if (!this.ids.audit.includes(Number(row.id))) this.track('audit', row.id);
    }
  }

  // ---- baseline ------------------------------------------------------------------------------------------------------
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
    for (const row of sums) {
      const [table, checksum] = Object.values(row); // by position: the column names differ between drivers
      checksums[String(table).split('.').pop()] = String(checksum);
    }
    for (const table of TOUCHED_TABLES) {
      if (!/^\d+$/.test(checksums[table] || '')) throw new Error(`no usable checksum for ${table}; the preservation check would be empty.`);
    }
    return { counts, checksums };
  }

  // ---- cleanup -------------------------------------------------------------------------------------------------------
  async cleanup(db) {
    await this.registerDiscovered(db);
    const report = { deleted: {}, failures: [] };
    const caseIds = new Set(this.ids.case);
    const invoiceIds = new Set(this.ids.invoice);
    const mine = (value) => String(value || '').includes(this.prefix);
    const one = async (sql, id) => { const [row] = await db.$queryRawUnsafe(sql, id); return row; };
    const owned = {
      inbox: async (id) => { const r = await one('SELECT external_event_id AS v FROM integration_inbox WHERE id = ?', id); return r && mine(r.v); },
      audit: async (id) => { const r = await one('SELECT case_id AS v FROM audit_logs WHERE id = ?', id); return r && caseIds.has(Number(r.v)); },
      payment: async (id) => { const r = await one('SELECT invoice_id AS v FROM payments WHERE id = ?', id); return r && invoiceIds.has(Number(r.v)); },
      invoice: async (id) => { const r = await one('SELECT idempotency_key AS v FROM invoices WHERE id = ?', id); return r && mine(r.v); },
      quotation: async (id) => { const r = await one('SELECT storage_key AS v FROM case_quotations WHERE id = ?', id); return r && mine(r.v); },
      link: async (id) => { const r = await one('SELECT case_id AS v FROM bitrix_deal_links WHERE id = ?', id); return r && caseIds.has(Number(r.v)); },
      case: async (id) => { const r = await one('SELECT reference_number AS v FROM cases WHERE id = ?', id); return r && mine(r.v); },
      request: async (id) => { const r = await one('SELECT reference_number AS v FROM service_requests WHERE id = ?', id); return r && mine(r.v); },
      user: async (id) => { const r = await one('SELECT email AS v FROM users WHERE id = ?', id); return r && mine(r.v); },
      admin: async (id) => { const r = await one('SELECT email AS v FROM admin_users WHERE id = ?', id); return r && mine(r.v); },
    };
    // One literal statement per table, each deleting exactly one row by primary key (tests/safe/integration-runner-guard.test.js enforces this form).
    const remove = {
      inbox: (id) => db.$executeRaw`DELETE FROM integration_inbox WHERE id = ${id}`,
      audit: (id) => db.$executeRaw`DELETE FROM audit_logs WHERE id = ${id}`,
      payment: (id) => db.$executeRaw`DELETE FROM payments WHERE id = ${id}`,
      invoice: (id) => db.$executeRaw`DELETE FROM invoices WHERE id = ${id}`,
      quotation: (id) => db.$executeRaw`DELETE FROM case_quotations WHERE id = ${id}`,
      link: (id) => db.$executeRaw`DELETE FROM bitrix_deal_links WHERE id = ${id}`,
      case: (id) => db.$executeRaw`DELETE FROM cases WHERE id = ${id}`,
      request: (id) => db.$executeRaw`DELETE FROM service_requests WHERE id = ${id}`,
      user: (id) => db.$executeRaw`DELETE FROM users WHERE id = ${id}`,
      admin: (id) => db.$executeRaw`DELETE FROM admin_users WHERE id = ${id}`,
    };
    for (const kind of DELETE_ORDER) {
      report.deleted[kind] = 0;
      // A refund points at its original payment (a RESTRICT foreign key) and is always created after it, so payments go newest first.
      const ids = [...new Set(this.ids[kind])];
      if (kind === 'payment') ids.sort((a, b) => b - a);
      for (const id of ids) {
        const stillThere = await db.$queryRawUnsafe(`SELECT 1 AS x FROM ${TABLE[kind]} WHERE id = ${Number(id)}`);
        if (stillThere.length === 0) continue; // already gone: nothing to delete
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

  async remaining(db) {
    const left = {};
    for (const kind of DELETE_ORDER) {
      const ids = [...new Set(this.ids[kind])].map(Number);
      if (ids.length === 0) { left[kind] = 0; continue; }
      const rows = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${TABLE[kind]} WHERE id IN (${ids.join(',')})`);
      left[kind] = Number(rows[0].n);
    }
    return left;
  }

  async disconnectAll() {
    await Promise.all(this.clients.map((c) => c.$disconnect().catch(() => {})));
    this.clients = [];
  }
}

module.exports = { PaymentsFixture, sleep, DELETE_ORDER, TOUCHED_TABLES };
