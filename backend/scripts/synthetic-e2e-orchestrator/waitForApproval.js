// Bounded, read-only poll for the dedicated scan-only worker to approve the marked request. This
// module never approves anything itself — it only observes reviewStatus and the synthetic_e2e_*
// event trail written by src/modules/request-review/synthetic-approval.js, so it can report a clear,
// specific reason instead of a bare timeout when the marker was revoked/expired/failed.
const { pollUntil } = require('./pollUtil');
const { ACTION } = require('../../src/common/safety/synthetic-e2e-marker');

const TERMINAL_FAILURE_ACTIONS = new Set([ACTION.REVOKED, ACTION.EXPIRED]);

async function waitForApproval(prisma, requestId, { intervalMs = 5000, timeoutMs = 15 * 60 * 1000, onTick } = {}) {
  return pollUntil({
    intervalMs,
    timeoutMs,
    onTick,
    check: async () => {
      const request = await prisma.serviceRequest.findUnique({ where: { id: Number(requestId) }, select: { id: true, reviewStatus: true } });
      if (!request) {
        const err = new Error(`request ${requestId} no longer exists`);
        err.code = 'request_missing';
        throw err;
      }
      if (request.reviewStatus === 'approved') return { done: true, value: request };

      const events = await prisma.requestEvent.findMany({
        where: { serviceRequestId: Number(requestId), action: { startsWith: 'synthetic_e2e_' } },
        orderBy: { id: 'desc' },
        take: 5,
        select: { action: true, detail: true, occurredAt: true },
      });
      const terminalFailure = events.find((e) => TERMINAL_FAILURE_ACTIONS.has(e.action));
      if (terminalFailure) {
        const err = new Error(`the synthetic approval engine recorded "${terminalFailure.action}" for request ${requestId}`);
        err.code = 'approval_terminal_failure';
        err.detail = terminalFailure.detail;
        throw err;
      }
      const lastFailed = events.find((e) => e.action === ACTION.FAILED);
      const diagnostic = lastFailed
        ? `request still "${request.reviewStatus}"; last recorded failure: ${lastFailed.detail && lastFailed.detail.stage ? lastFailed.detail.stage : 'unknown stage'}`
        : `request still "${request.reviewStatus}"; awaiting the dedicated scan worker`;
      return { done: false, diagnostic };
    },
  });
}

module.exports = { waitForApproval };
