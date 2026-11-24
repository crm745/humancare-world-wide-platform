/* global jest */
// An in-memory world for the synthetic E2E tests: a fake Prisma whose transactions run one at a time (standing in for the request row
// lock), fake review / approval services that behave like the real ones for what the engine relies on (the real approvalBlockers is used),
// and a controllable clock. No database, no network.
const crypto = require('crypto');
const { approvalBlockers } = require('../../src/modules/request-review/request-review.service');
const { buildMark, ACTION } = require('../../src/common/safety/synthetic-e2e-marker');
const { createEngine } = require('../../src/modules/request-review/synthetic-approval');

const SECRET = 's'.repeat(40);
const ENV = { SYNTHETIC_E2E_AUTO_APPROVE: 'true', SYNTHETIC_E2E_SECRET: SECRET, DATABASE_URL: 'mysql://u:p@localhost:3306/humancare_dev' };
const T0 = Date.parse('2026-11-20T12:00:00Z');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sha = () => crypto.randomBytes(32).toString('hex');
const httpError = (statusCode, publicCode) => Object.assign(new Error(publicCode), { statusCode, publicCode });

function makeRig(over = {}) {
  const clock = { now: T0 };
  const world = {
    db: 'humancare_dev', seq: 0, events: [], serviceEvents: [], outbox: new Map(), cases: new Map(), fail: { reviewDocument: 0, approveRequest: 0 },
    requests: new Map([[61, { id: 61, userId: 7, serviceKey: 'privatecharter', patientName: 'ZZ-SYNTHETIC Test', reviewStatus: 'in_review', createdAt: new Date(T0 - 3600000), ...over.request }]]),
    otherRequests: over.otherRequests || [],
    documents: [],
    docSeq: 0,
  };
  const addDoc = (fields = {}) => {
    const doc = {
      id: ++world.docSeq, serviceRequestId: 61, supersededAt: null, documentRequestId: null, scanStatus: 'clean', reviewStatus: 'pending', sha256: sha(),
      sizeBytes: 100, mimeType: 'application/pdf', originalName: 'private-name.pdf', scanDetail: null, ...fields,
    };
    world.documents.push(doc);
    return doc;
  };
  const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });

  let chain = Promise.resolve();
  const prisma = {
    $queryRaw: jest.fn(async (strings) => (strings.join('?').includes('DATABASE()') ? [{ db: world.db }] : [])),
    $transaction: jest.fn((fn) => { const run = chain.then(() => fn(prisma)); chain = run.catch(() => undefined); return run; }),
    requestEvent: {
      findMany: jest.fn(async ({ where = {}, select, distinct, take } = {}) => {
        let rows = world.events.filter((e) => matches(e, where)).sort((a, b) => a.id - b.id);
        if (distinct) rows = rows.filter((e, i) => rows.findIndex((x) => x.serviceRequestId === e.serviceRequestId) === i);
        if (take) rows = rows.slice(0, take);
        return rows.map((e) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, e[k]])) : { ...e }));
      }),
      create: jest.fn(async ({ data }) => { const row = { id: ++world.seq, occurredAt: new Date(clock.now), ...data }; world.events.push(row); return { ...row }; }),
    },
    serviceRequest: {
      findUnique: jest.fn(async ({ where }) => (world.requests.has(where.id) ? { ...world.requests.get(where.id) } : null)),
      count: jest.fn(async ({ where }) => [...world.requests.values(), ...world.otherRequests].filter((r) => r.userId === where.userId).length),
    },
    requestDocument: {
      findMany: jest.fn(async ({ where }) => world.documents.filter((d) => d.serviceRequestId === where.serviceRequestId && (where.supersededAt !== null || d.supersededAt === null)).map((d) => ({ ...d }))),
    },
  };

  const services = {
    approvalBlockers,
    reviewDocument: jest.fn(async ({ requestId, documentId, adminId, decision }) => {
      await tick();
      if (world.fail.reviewDocument > 0) { world.fail.reviewDocument -= 1; throw httpError(409, 'document_not_clean'); }
      const doc = world.documents.find((d) => d.id === documentId && d.serviceRequestId === requestId);
      if (!doc) throw httpError(404, 'not_found');
      if (doc.reviewStatus !== 'pending') throw httpError(409, 'already_decided');
      if (doc.scanStatus !== 'clean') throw httpError(409, 'document_not_clean');
      doc.reviewStatus = decision;
      world.serviceEvents.push({ action: 'document_approved', actorType: 'admin', actorId: adminId, documentId });
      return {};
    }),
    approveRequest: jest.fn(({ requestId, adminId }) => prisma.$transaction(async () => {
      await tick();
      if (world.fail.approveRequest > 0) { world.fail.approveRequest -= 1; throw httpError(500, 'boom'); }
      const request = world.requests.get(requestId);
      if (request.reviewStatus === 'approved') return { alreadyApproved: true };
      const blockers = approvalBlockers(request, world.documents.filter((d) => d.serviceRequestId === requestId && !d.supersededAt));
      if (request.reviewStatus !== 'in_review' || blockers.length) throw httpError(409, 'approval_blocked');
      request.reviewStatus = 'approved';
      if (!world.cases.has(requestId)) world.cases.set(requestId, { id: 500 + requestId });
      const key = `bitrix.deal.create:${world.cases.get(requestId).id}`;
      if (!world.outbox.has(key)) world.outbox.set(key, { status: 'pending' });
      world.serviceEvents.push({ action: 'request_approved', actorType: 'admin', actorId: adminId });
      return { alreadyApproved: false };
    })),
  };

  const log = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const engine = (envOver = {}) => createEngine({ prisma, services, env: { ...ENV, ...envOver }, now: () => clock.now, log });
  const mark = ({ requestId = 61, owner = 7, admin = 3, docs = 2, runId = 'run-1', secret = SECRET, at = clock.now } = {}) => {
    const detail = buildMark({ secret, requestId, ownerUserId: owner, adminId: admin, expectedDocuments: docs, runId, now: at });
    world.events.push({ id: ++world.seq, serviceRequestId: requestId, action: ACTION.MARKED, actorType: 'admin', actorId: admin, detail, occurredAt: new Date(at) });
    return detail;
  };
  const events = (action) => world.events.filter((e) => e.action === action);
  const advance = (ms) => { clock.now += ms; };
  const approvals = () => services.approveRequest.mock.results.length;
  return { world, prisma, services, engine, mark, addDoc, events, advance, clock, log, approvals };
}

module.exports = { makeRig, SECRET, ENV, T0, tick, httpError };
