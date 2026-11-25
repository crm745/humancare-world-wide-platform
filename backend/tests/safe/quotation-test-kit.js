/* global jest */
// Shared in-memory world for the quotation tests: a fake Prisma (Case, Deal link, case_quotations, audit, outbox events) whose transaction
// serialises callers (standing in for the Case row lock) and rolls back on a throw, a fake outbox store applying the same lease / fence
// rules as the real SQL, a fake Bitrix client and a real local storage in a temporary folder. No database, no network.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BitrixDealCallError } = require('../../src/modules/bitrix/bitrix-deal.api');
const { createLocalStorage } = require('../../src/modules/bitrix/quotation-storage');

const ENV_ON = { BITRIX_DEAL_PROFILE: 'test', BITRIX_SYNC_ENABLED: 'true', BITRIX_PRIVATE_CHARTER_DEAL_ENABLED: 'true', PRIVATE_CHARTER_REVIEW_WORKFLOW: 'true', BITRIX_QUOTATION_SYNC_ENABLED: 'true' };
const REF = 'CASE-4037';
const DEAL = '21802';
const REF_FIELD = 'UF_CRM_1794548440549';
const FILE_FIELD = 'UF_CRM_1794985313';
const AMOUNT_FIELD = 'UF_CRM_6A3399F56ECFF';
const CURRENCY_FIELD = 'UF_CRM_6A23F4E86AA45';

const pdf = (label) => Buffer.from(`%PDF-1.7\n% ${label}\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\nstartxref\n0\n%%EOF\n`);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const deepClone = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x));

function makeWorld(over = {}) {
  return {
    clock: new Date('2030-01-02T10:00:00Z').getTime(),
    caseRecord: { id: 3037, referenceNumber: REF, status: 'in_progress', serviceRequestId: 4672 },
    request: { id: 4672, userId: 55, serviceKey: 'privatecharter', reviewStatus: 'approved', bitrixLeadId: null },
    // Push device registry and delivery rows (what enqueuePushDeliveries reads and writes), and the patient's notification preferences by user id.
    devices: [], deliveries: [], prefs: {},
    notifications: [], admins: [{ id: 7, name: 'Asha Admin', status: 'active', role: 'admin' }, { id: 8, name: 'Ravi Super', status: 'active', role: 'superadmin' }, { id: 9, name: 'Old Admin', status: 'disabled', role: 'admin' }], pushes: [],
    link: { id: 1173, caseId: 3037, bitrixDealId: DEAL },
    quotations: [], invoices: [], nextInvoiceId: 1, audit: [], events: [], nextQuotationId: 1, nextEventId: 464, logs: [],
    ...over,
  };
}

const matches = (row, where) => Object.entries(where || {}).every(([key, cond]) => {
  if (key === 'OR') return cond.some((w) => matches(row, w));
  const value = row[key];
  if (cond === null) return value == null;
  if (cond instanceof Date) return value != null && +value === +cond;
  if (typeof cond === 'object') {
    if ('in' in cond) return cond.in.includes(value);
    if ('gte' in cond) return value != null && +value >= +cond.gte;
    if ('lte' in cond) return value != null && +value <= +cond.lte;
    if ('not' in cond) return value !== cond.not;
  }
  return value === cond;
});

// Opt-in (Phase 4): the invoice table of the fake. NOT attached by makePrisma, so the tests that prove the sync, the Admin actions and the patient's decision
// never reach an invoice keep proving it. The invoice tests and the HTTP kit attach it.
function attachInvoices(db, world) {
  db.invoice = {
      findFirst: jest.fn(async ({ where }) => { const i = world.invoices.find((x) => matches(x, where)); return i ? { ...i } : null; }),
      findUnique: jest.fn(async ({ where }) => { const i = world.invoices.find((x) => matches(x, where)); return i ? { ...i } : null; }),
      // The real database refuses a duplicate quotation, invoice number or (case, key), and a Case / currency / amount that differs from the quotation (composite FK).
      create: jest.fn(async ({ data }) => {
        const dup = (why) => { const e = new Error(`unique ${why}`); e.code = 'P2002'; return e; };
        if (data.quotationId != null) {
          if (world.invoices.some((i) => i.quotationId === data.quotationId)) throw dup('quotation');
          const q = world.quotations.find((x) => x.id === data.quotationId);
          if (!q || q.caseId !== data.caseId || q.currency !== data.currency || Number(q.amount) !== Number(data.amount)) { const e = new Error('fk'); e.code = 'P2003'; throw e; }
        }
        if (data.invoiceNumber && world.invoices.some((i) => i.invoiceNumber === data.invoiceNumber)) throw dup('number');
        if (data.idempotencyKey && world.invoices.some((i) => i.caseId === data.caseId && i.idempotencyKey === data.idempotencyKey)) throw dup('key');
        const row = { id: world.nextInvoiceId, voidedAt: null, partialPaymentAuthorizedByAdminId: null, partialPaymentAuthorizedAt: null, allowPartialPayment: false, createdAt: new Date(world.clock), ...data };
        world.nextInvoiceId += 1;
        world.invoices.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }) => { const found = world.invoices.filter((i) => matches(i, where)); found.forEach((i) => Object.assign(i, data)); return { count: found.length }; }),
    };
  return db;
}

function makePrisma(world) {
  let chain = Promise.resolve();
  const uniq = (row, ignoreId) => {
    for (const q of world.quotations) {
      if (q.id === ignoreId) continue;
      if (q.caseId === row.caseId && q.versionNumber === row.versionNumber) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
      if (q.storageKey === row.storageKey) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
    }
  };
  const db = {
    bitrixDealLink: { findUnique: jest.fn(async () => ({ ...world.link, case: { ...world.caseRecord, serviceRequest: { ...world.request } } })) },
    caseQuotation: {
      findFirst: jest.fn(async ({ where: full }) => {
        const { case: ownership, ...where } = full; // `case: { serviceRequestId, serviceRequest: { userId } }` is the ownership path of the real query
        const owned = !ownership || (world.caseRecord.serviceRequestId === ownership.serviceRequestId && world.request.userId === ownership.serviceRequest.userId);
        const list = world.quotations.filter((q) => owned && matches(q, where)).sort((a, b) => b.versionNumber - a.versionNumber);
        return list[0] ? { ...list[0] } : null;
      }),
      findUnique: jest.fn(async ({ where }) => { const q = world.quotations.find((x) => matches(x, where)); return q ? { ...q } : null; }),
      findMany: jest.fn(async ({ where: full, take, orderBy }) => world.quotations.filter((q) => { const { invoices, ...where } = full; return matches(q, where) && (!invoices || !invoices.none || !world.invoices.some((i) => i.quotationId === q.id)); }).sort((a, b) => (orderBy && orderBy.versionNumber === 'desc' ? b.versionNumber - a.versionNumber : a.id - b.id)).slice(0, take).map((q) => ({ ...q }))),
      create: jest.fn(async ({ data }) => {
        const row = { id: world.nextQuotationId, confirmedAt: null, confirmedByAdminId: null, publishedAt: null, publishedByAdminId: null, withdrawnAt: null, withdrawnByAdminId: null, withdrawReason: null, decidedAt: null, decidedByUserId: null, rejectionReason: null, validUntil: null, supersededById: null, liveSlot: null, scanEngine: null, scanDetail: null, scannedAt: null, scanAttempts: 0, scanNextAttemptAt: null, supersededAt: null, createdAt: new Date(world.clock), ...data };
        uniq(row, null);
        world.nextQuotationId += 1;
        world.quotations.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = world.quotations.filter((q) => matches(q, where));
        for (const q of found) {
          for (const [k, v] of Object.entries(data)) q[k] = v && typeof v === 'object' && 'increment' in v ? q[k] + v.increment : v;
          uniq(q, q.id);
        }
        return { count: found.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }) => {
        if (world.audit.some((a) => a.entityType === data.entityType && a.entityId === data.entityId && a.idempotencyKey === data.idempotencyKey && data.idempotencyKey != null)) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
        world.audit.push(data); return data;
      }),
    },
    integrationOutbox: {
      create: jest.fn(async ({ data }) => {
        if (world.events.some((e) => e.idempotencyKey === data.idempotencyKey)) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
        const event = { id: world.nextEventId, status: 'pending', attempts: 0, nextAt: 0, lockedBy: null, lockedUntil: null, lastError: null, caseId: data.caseId, idempotencyKey: data.idempotencyKey, eventType: data.eventType, entityType: data.entityType, payload: data.payload };
        world.nextEventId += 1;
        world.events.push(event);
        return event;
      }),
    },
    // What the central notification core reads to check ownership (it is called with the same client as the publication).
    serviceRequest: { findUnique: jest.fn(async ({ where }) => (where.id === world.request.id ? { id: world.request.id, userId: world.request.userId } : null)) },
    case: { findUnique: jest.fn(async ({ where }) => (where.id === world.caseRecord.id ? { id: world.caseRecord.id, serviceRequestId: world.caseRecord.serviceRequestId } : null)), findFirst: jest.fn(async ({ where }) => {
      const c = world.caseRecord;
      const keyed = where.id !== undefined || where.referenceNumber !== undefined || where.serviceRequestId !== undefined;
      const match = keyed
        && (where.id === undefined || c.id === where.id)
        && (where.referenceNumber === undefined || c.referenceNumber === where.referenceNumber)
        && (where.serviceRequestId === undefined || c.serviceRequestId === where.serviceRequestId)
        && (!where.serviceRequest || world.request.userId === where.serviceRequest.userId); // ownership is part of the query, like the real one
      return match ? { ...c, serviceRequest: { ...world.request } } : null;
    }) },
    adminUser: { findMany: jest.fn(async ({ where }) => world.admins.filter((a) => where.id.in.includes(a.id)).map((a) => ({ ...a }))) },
    user: { findUnique: jest.fn(async () => ({ pushToken: 'ExponentPushToken[test]' })) },
    // Like the real table: the idempotency key is unique (a duplicate is a P2002), and findUnique reads by it.
    notification: {
      findUnique: jest.fn(async ({ where }) => {
        const found = where.id !== undefined ? world.notifications.find((n) => n.id === where.id) : world.notifications.find((n) => n.idempotencyKey === where.idempotencyKey);
        return found ? { ...found } : null;
      }),
      create: jest.fn(async ({ data }) => {
        if (data.idempotencyKey && world.notifications.some((n) => n.idempotencyKey === data.idempotencyKey)) { const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notifications_idempotency_key_key' }; throw e; }
        const row = { id: world.notifications.length + 1, readAt: null, deletedAt: null, createdAt: new Date(world.clock), ...data }; world.notifications.push(row); return { ...row };
      }),
    },
    // The push delivery tables, like the real ones: the destination index is unique (a duplicate is a P2002) and a query returns only what it selects.
    notificationPreference: {
      findUnique: jest.fn(async ({ where }) => { const p = world.prefs[where.ownerType_ownerId.ownerId]; return p ? { ...p } : null; }),
    },
    notificationDevice: {
      findMany: jest.fn(async ({ where, select }) => world.devices
        .filter((d) => d.ownerType === where.ownerType && d.ownerId === where.ownerId && d.status === where.status && +d.lastRegisteredAt <= +where.lastRegisteredAt.lte)
        .sort((a, b) => a.id - b.id).map((d) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, d[k]])))),
    },
    notificationDelivery: {
      findMany: jest.fn(async ({ where, select }) => world.deliveries
        .filter((d) => d.notificationId === where.notificationId && d.channel === where.channel).map((d) => Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, d[k]])))),
      create: jest.fn(async ({ data, select }) => {
        if (world.deliveries.some((d) => d.notificationId === data.notificationId && d.channel === data.channel && d.destinationKey === data.destinationKey)) {
          const e = new Error('unique'); e.code = 'P2002'; e.meta = { target: 'notification_deliveries_dest_key' }; throw e;
        }
        const row = { id: world.deliveries.length + 1, status: 'pending', attemptCount: 0, ...data }; world.deliveries.push(row);
        return select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
      }),
    },
    $queryRaw: jest.fn(async () => [{ id: world.caseRecord.id }]),
    $transaction: jest.fn((fn) => {
      const run = chain.then(async () => {
        const snapshot = deepClone({ i: world.invoices, ni: world.nextInvoiceId, q: world.quotations, a: world.audit, e: world.events, n: world.nextQuotationId, nt: world.notifications, dl: world.deliveries });
        // A real transaction client has no $transaction (only the shared client opens one): the service gets the same.
        const tx = { ...db };
        delete tx.$transaction;
        try { return await fn(tx); } catch (err) {
          world.invoices = snapshot.i; world.nextInvoiceId = snapshot.ni; world.quotations = snapshot.q; world.audit = snapshot.a; world.events = snapshot.e; world.nextQuotationId = snapshot.n; world.notifications = snapshot.nt; world.deliveries = snapshot.dl;
          throw err;
        }
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    }),
  };
  return db;
}

// The outbox store's rules on the in-memory events: due, unlocked, scoped; a result is fenced on id, status, attempts and owner.
function makeStore(world) {
  const due = (e) => e.status === 'pending' && e.nextAt <= world.clock && (e.lockedUntil == null || e.lockedUntil <= world.clock);
  const inScope = (e, scope) => !scope || !scope.caseIds || scope.caseIds.includes(e.caseId);
  const owns = (e, c) => e.status === 'processing' && e.attempts === c.attempts && e.lockedBy === c.workerId && e.lockedUntil > world.clock;
  return {
    findCandidateIds: jest.fn(async (_db, limit, scope) => world.events.filter((e) => due(e) && inScope(e, scope)).slice(0, limit).map((e) => e.id)),
    claim: jest.fn(async (_db, { id, workerId, leaseSeconds }) => {
      const e = world.events.find((x) => x.id === id);
      if (!e || !due(e)) return null;
      Object.assign(e, { status: 'processing', attempts: e.attempts + 1, lockedBy: workerId, lockedUntil: world.clock + leaseSeconds * 1000 });
      return { id, workerId, attempts: e.attempts, caseId: e.caseId, dealId: DEAL };
    }),
    writeResult: jest.fn(async (_db, c, { status, lastError = null, delaySeconds = 0 }) => {
      const e = world.events.find((x) => x.id === c.id);
      if (!owns(e, c)) return 0;
      Object.assign(e, { status, lastError, nextAt: world.clock + delaySeconds * 1000, lockedBy: null, lockedUntil: null });
      return 1;
    }),
    recoverExpiredLeases: jest.fn(async () => ({ failed: 0, pending: 0 })),
  };
}

const addEvent = (world, over = {}) => {
  const e = { id: world.nextEventId, status: 'pending', attempts: 0, nextAt: 0, lockedBy: null, lockedUntil: null, lastError: null, caseId: 3037, ...over };
  world.nextEventId += 1;
  world.events.push(e);
  return e;
};

// A Deal as crm.deal.get returns it. `file: null` = no file; amount/currency default to empty like the real Deal 21802.
const dealBody = ({ fileId = 65834, amount, currency = '', stage = 'C38:NEW', ref = REF, category = '38' } = {}) => ({
  ID: DEAL, CATEGORY_ID: category, STAGE_ID: stage, DATE_MODIFY: '2030-01-02T10:00:00+00:00', [REF_FIELD]: ref,
  [FILE_FIELD]: fileId == null ? null : { id: fileId, showUrl: '/x', downloadUrl: '/y' },
  ...(amount === undefined ? {} : { [AMOUNT_FIELD]: amount }), [CURRENCY_FIELD]: currency,
});

// Fake Bitrix: reads only. `state.deal` / `state.pdf` can be changed between passes.
function makeApi(state) {
  const calls = [];
  return {
    calls, BitrixDealCallError,
    getDeal: jest.fn(async () => { calls.push('crm.deal.get'); if (state.dealError) return { status: state.dealError }; return { status: 'ok', deal: state.deal }; }),
    getDealFileField: jest.fn(async () => { calls.push('crm.item.get'); const id = state.deal[FILE_FIELD] ? String(state.deal[FILE_FIELD].id) : null; return { status: 'ok', file: id ? { id } : null }; }),
    downloadBitrixFile: jest.fn(async () => {
      calls.push('download');
      if (state.downloadError) throw state.downloadError;
      return { bytes: state.pdf, sha256: sha(state.pdf), byteCount: state.pdf.length, contentType: 'application/pdf' };
    }),
    createDeal: jest.fn(async () => { throw new Error('write attempted'); }),
    updateDealFiles: jest.fn(async () => { throw new Error('write attempted'); }),
  };
}

function makeRig(over = {}) {
  const world = makeWorld(over);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-quotation-'));
  const state = { deal: dealBody(), pdf: pdf('one') };
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), log: jest.fn() };
  const rig = {
    world, root, state, log, prisma: makePrisma(world), store: makeStore(world), api: makeApi(state), storage: createLocalStorage({ root }),
    ctx: (extra = {}) => ({ prisma: rig.prisma, store: rig.store, api: rig.api, storage: rig.storage, env: ENV_ON, log, workerId: 'w1', now: () => new Date(world.clock), ...extra }),
    filesOnDisk: () => {
      const out = [];
      const walk = (d) => { for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out.push(path.relative(root, p).split(path.sep).join('/')); } };
      walk(root);
      return out.sort();
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return rig;
}

module.exports = { ENV_ON, REF, DEAL, REF_FIELD, FILE_FIELD, AMOUNT_FIELD, CURRENCY_FIELD, pdf, sha, makeWorld, makePrisma, attachInvoices, makeStore, addEvent, dealBody, makeApi, makeRig, matches };
