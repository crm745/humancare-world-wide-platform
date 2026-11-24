// Bounded, read-only poll for every current document of a request to reach scan_status = 'clean'.
// Never scans anything itself — that is the dedicated worker's job (ClamAV via
// request-review.service.js's sweepPendingScans). This module only observes.
const { pollUntil } = require('./pollUtil');

const FAILURE_STATES = new Set(['infected', 'error', 'failed']);

async function waitForCleanScan(prisma, requestId, { intervalMs = 5000, timeoutMs = 10 * 60 * 1000, onTick } = {}) {
  return pollUntil({
    intervalMs,
    timeoutMs,
    onTick,
    check: async () => {
      const documents = await prisma.requestDocument.findMany({
        where: { serviceRequestId: Number(requestId), supersededAt: null },
        select: { id: true, scanStatus: true, scanDetail: true },
        orderBy: { id: 'asc' },
      });
      if (!documents.length) return { done: false, diagnostic: 'no current document found yet' };
      const failed = documents.find((d) => FAILURE_STATES.has(d.scanStatus));
      if (failed) {
        const err = new Error(`document ${failed.id} reached a terminal scan state "${failed.scanStatus}"${failed.scanDetail ? `: ${failed.scanDetail}` : ''}`);
        err.code = 'scan_failed';
        throw err;
      }
      const allClean = documents.every((d) => d.scanStatus === 'clean');
      if (allClean) return { done: true, value: documents };
      return { done: false, diagnostic: `waiting on ${documents.filter((d) => d.scanStatus !== 'clean').length} document(s): ${documents.map((d) => d.scanStatus).join(', ')}` };
    },
  });
}

module.exports = { waitForCleanScan };
