/* global jest */
// Shared fakes for the Razorpay order-creation tests. No network and no database: an in-memory "database" whose transactions run one at a
// time (so they behave like the invoice row lock), and a fake Razorpay gateway behind an injected fetch. Every key, host and id is fake.
const SECRET = 'FAKE_SECRET_VALUE_9876';
const KEY_ID = 'rzp_test_FAKEKEY123456';
const ENV = Object.freeze({ NODE_ENV: 'test', PAYMENTS_ENABLED: 'true', PAYMENTS_ENVIRONMENT_ID: 'test', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: SECRET });
const BASIC = `Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64')}`;

const clock = { t: Date.parse('2026-11-20T10:00:00.000Z'), now() { return new Date(this.t); }, advance(ms) { this.t += ms; } };
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

function makeInvoice(over = {}) {
  return {
    id: 1, caseId: 10, source: 'quotation', status: 'issued', amount: '1500.000', currency: 'INR', dueDate: null, quotationId: 5, allowPartialPayment: false,
    quotation: { id: 5, status: 'accepted', supersededAt: null },
    case: { id: 10, status: 'in_progress', closedAt: null, serviceRequest: { userId: 7, serviceKey: 'privatecharter' } },
    ...over,
  };
}

const unique = (code = 'P2002') => Object.assign(new Error('Unique constraint failed'), { code });

// structuredClone returns Dates from outside the Jest sandbox, so `instanceof Date` is unreliable here.
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";

function matches(row, where) {
  for (const [key, expected] of Object.entries(where || {})) {
    const actual = row[key];
    if (expected === null) { if (actual !== null && actual !== undefined) return false; continue; }
    if (expected && typeof expected === 'object' && !isDate(expected)) {
      if ('not' in expected) { if ((expected.not === null) ? (actual === null || actual === undefined) : actual === expected.not) return false; continue; }
      if ('lt' in expected) { if (!(actual !== null && actual !== undefined && new Date(actual).getTime() < new Date(expected.lt).getTime())) return false; continue; }
      return false;
    }
    if (isDate(expected)) { if (!actual || new Date(actual).getTime() !== expected.getTime()) return false; continue; }
    if (actual !== expected) return false;
  }
  return true;
}

function makeDb({ invoices = [makeInvoice()], payments = [] } = {}) {
  const state = { invoices: new Map(invoices.map((i) => [i.id, i])), payments: payments.map(clone), audits: [], locks: [], nextPaymentId: 1 + payments.reduce((m, p) => Math.max(m, p.id), 0) };
  let chain = Promise.resolve();
  const db = {
    state,
    inTx: false,
    txCount: 0,
    async $transaction(fn) {
      const run = async () => {
        const snapshot = { payments: clone(state.payments), audits: clone(state.audits), nextPaymentId: state.nextPaymentId };
        db.inTx = true;
        db.txCount += 1;
        try { return await fn(db); } catch (err) { Object.assign(state, clone(snapshot)); throw err; } finally { db.inTx = false; }
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
    async $queryRaw(strings, ...values) {
      state.locks.push({ table: /FROM (\w+)/.exec(strings.join('?'))[1], id: values[0], inTx: db.inTx, tx: db.txCount });
      return [];
    },
    // requireAuth looks the patient up once (a retired account is refused at once); these tests have no such account row.
    user: { findUnique: jest.fn(async () => null) },
    invoice: { findUnique: jest.fn(async ({ where }) => clone(state.invoices.get(where.id)) || null) },
    payment: {
      findUnique: jest.fn(async ({ where }) => clone(state.payments.find((p) => p.id === where.id)) || null),
      findMany: jest.fn(async ({ where, take }) => clone(state.payments.filter((p) => matches(p, where)).sort((a, b) => a.id - b.id).slice(0, take || 1000))),
      create: jest.fn(async ({ data }) => {
        if (data.idempotencyKey && state.payments.some((p) => p.invoiceId === data.invoiceId && p.idempotencyKey === data.idempotencyKey)) throw unique();
        const row = { externalReference: null, razorpayOrderId: null, ...data, id: state.nextPaymentId, createdAt: clock.now(), updatedAt: clock.now() };
        state.nextPaymentId += 1;
        state.payments.push(row);
        return clone(row);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = state.payments.filter((p) => matches(p, where));
        for (const row of rows) {
          if (data.razorpayOrderId && state.payments.some((p) => p !== row && p.razorpayOrderId === data.razorpayOrderId)) throw unique();
          Object.assign(row, data, data.updatedAt ? {} : { updatedAt: clock.now() });
        }
        return { count: rows.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }) => {
        if (data.idempotencyKey && state.audits.some((a) => a.entityType === data.entityType && a.entityId === data.entityId && a.idempotencyKey === data.idempotencyKey)) throw unique();
        state.audits.push(clone(data));
        return {};
      }),
    },
  };
  return db;
}

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// A fake Razorpay. `modes` is a queue for the NEXT order-creation calls: "ok" (default) | "refuse" (400) | "timeout" (nothing created) |
// "lost" (order created, then a 502) . `listMode`: "ok" | "error". `hooks.beforeCreate` runs inside the create call.
// `orderPrefix` makes the fake order ids unique across gateways: Razorpay ids are globally unique, and so is payments.razorpay_order_id.
function makeGateway({ orderPrefix = 'FAKE' } = {}) {
  const gateway = {
    orders: [], calls: [], modes: [], listMode: 'ok', getMode: 'ok', hooks: {}, seq: 0, observed: [],
    creates() { return gateway.calls.filter((c) => c.method === 'POST'); },
  };
  gateway.fetchImpl = jest.fn(async (url, init) => {
    const u = new URL(url);
    const method = init.method;
    gateway.calls.push({ url: String(url), method, init });
    if (gateway.hooks.onCall) await gateway.hooks.onCall({ url: String(url), method });
    if (method === 'POST' && u.pathname === '/v1/orders') {
      const body = JSON.parse(init.body);
      const mode = gateway.modes.shift() || 'ok';
      if (mode === 'timeout') throw abortError();
      if (mode === 'refuse') return reply(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'DO_NOT_LEAK_DESCRIPTION https://secret.example/x' } });
      gateway.seq += 1;
      const order = { id: `order_${orderPrefix}${gateway.seq}`, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created', amount_paid: 0, attempts: 0, notes: body.notes };
      gateway.orders.push(order);
      if (gateway.hooks.beforeCreateReply) await gateway.hooks.beforeCreateReply(order);
      if (mode === 'lost') return reply(502, { error: { description: 'bad gateway' } });
      return reply(200, order);
    }
    if (method === 'GET' && u.pathname === '/v1/orders') {
      if (gateway.listMode === 'error') return reply(500, {});
      const receipt = u.searchParams.get('receipt');
      const items = gateway.orders.filter((o) => o.receipt === receipt);
      return reply(200, { entity: 'collection', count: items.length, items });
    }
    const one = /^\/v1\/orders\/(order_[A-Za-z0-9]+)$/.exec(u.pathname);
    if (method === 'GET' && one) {
      if (gateway.getMode === 'error') return reply(500, {});
      const order = gateway.orders.find((o) => o.id === one[1]);
      return order ? reply(200, order) : reply(404, { error: { code: 'BAD_REQUEST_ERROR' } });
    }
    return reply(404, {});
  });
  return gateway;
}

const silentLog = () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() });
const KEY = (n = 1) => `idem-key-${String(n).padStart(8, '0')}`; // 16+ characters from [A-Za-z0-9_-]

module.exports = { SECRET, KEY_ID, ENV, BASIC, clock, makeInvoice, makeDb, makeGateway, reply, silentLog, KEY };
