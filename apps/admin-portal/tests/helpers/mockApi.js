// A fake backend for browser tests that must never touch the real API or database.
// Every request to the API origin is intercepted and answered here; anything not listed
// gets a 404, so a forgotten endpoint fails loudly instead of leaking out.
const APP_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000';

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

const json = (status, body) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {object} [initial]
 * @returns the mutable `state`; tests flip fields to change what the "server" does.
 */
async function installMockApi(context, initial = {}) {
  const state = {
    authed: false, // does the (fake) session cookie count as valid?
    role: 'superadmin', // 'admin' | 'superadmin'
    corporateReview: false,
    name: 'Test Admin',
    loginStatus: 200, // set to 401/429 to make login fail
    loginError: 'Invalid credentials',
    meNetworkFail: false,
    casesStatus: 200,
    casesDelayMs: 0,
    cases: [], // rows served by GET /admin/cases
    caseDetails: {}, // GET /admin/cases/:id responses, keyed by id
    caseDetailStatus: 200,
    caseDelayMs: 0,
    requests: [], // rows served by GET /admin/requests (see below)
    requestsStatus: 200, // set to 500 to make the list fail
    details: {}, // GET /admin/requests/:id responses, keyed by id
    detailStatus: 200, // set to 500 to make the details call fail
    detailDelayMs: 0,
    // Document download / review (see the handlers below). They follow the server's rules and mutate
    // `details`, so a refetch shows what the decision changed.
    fileContent: '%PDF-1.4 mock document',
    exposeDisposition: false, // let the browser read Content-Disposition (the real API does not)
    fileResponses: {}, // docId -> { status, body }: force an answer for a download
    fileDelayMs: 0,
    reviewResponses: {}, // docId -> { status, body }: force an answer for a review
    reviewDelayMs: 0,
    reviews: [], // { id, docId, body } for every review POST that reached the server
    requestDocsResponses: {}, // requestId -> { status, body }: force an answer for "request additional documents"
    requestDocsDelayMs: 0,
    requestDocs: [], // { id, body } for every request-documents POST that reached the server
    approveResponses: {}, // requestId -> { status, body }: force an answer for "approve request"
    approveDelayMs: 0,
    approvals: [], // requestId for every approve POST that reached the server
    nextCaseId: 50,
    nextEventId: 1000,
    calls: [], // { method, path, query, cookie }
    ...initial,
  };
  state.details = structuredClone(state.details); // tests change it; never share it between tests
  state.cases = structuredClone(state.cases);
  state.caseDetails = structuredClone(state.caseDetails);

  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const { pathname, searchParams } = new URL(req.url());
    state.calls.push({ method: req.method(), path: pathname, query: Object.fromEntries(searchParams), cookie: req.headers().cookie || null });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    if (pathname === '/admin/login') {
      if (state.loginStatus !== 200) return route.fulfill(json(state.loginStatus, { error: state.loginError }));
      state.authed = true;
      return route.fulfill(
        json(200, {
          token: 'SECRET-JWT-SHOULD-NEVER-REACH-THE-PAGE',
          refreshToken: 'SECRET-REFRESH-SHOULD-NEVER-REACH-THE-PAGE',
          admin: { id: 1, name: state.name, email: 'admin@example.com', role: state.role },
        }),
      );
    }
    if (pathname === '/admin/me') {
      if (state.meNetworkFail) return route.abort('connectionrefused');
      if (!state.authed) return route.fulfill(json(401, { error: 'Missing or malformed Authorization header' }));
      const isSuper = state.role === 'superadmin';
      return route.fulfill(
        json(200, { ok: true, admin: { id: 1, role: 'admin', corporateId: null, adminRole: state.role, corporateReview: isSuper || state.corporateReview } }),
      );
    }
    if (pathname === '/admin/logout') {
      state.authed = false;
      return route.fulfill(json(200, { message: 'Logged out.' }));
    }
    if (pathname === '/admin/cases') {
      // Like the server: only `status` is understood (400 for an unknown one); no search, paging or request reference.
      if (state.casesDelayMs) await new Promise((resolve) => setTimeout(resolve, state.casesDelayMs));
      if (state.casesStatus !== 200) return route.fulfill(json(state.casesStatus, { error: state.casesStatus === 401 ? 'Token expired' : 'Could not load the cases.' }));
      const status = searchParams.get('status');
      if (status && status !== 'all' && !['submitted', 'scheduled', 'in_progress', 'completed', 'cancelled'].includes(status)) {
        return route.fulfill(json(400, { error: 'Invalid status filter.' }));
      }
      return route.fulfill(json(200, { cases: state.cases.filter((c) => !status || status === 'all' || c.status === status) }));
    }
    const caseDetail = /^\/admin\/cases\/([^/]+)$/.exec(pathname);
    if (caseDetail && req.method() === 'GET') {
      // GET /admin/cases/:id by numeric id or CASE-... reference; `state.caseDetails` holds each Case as the API returns it.
      if (state.caseDelayMs) await new Promise((resolve) => setTimeout(resolve, state.caseDelayMs));
      if (state.caseDetailStatus !== 200) return route.fulfill(json(state.caseDetailStatus, { error: 'Could not load the case.' }));
      const key = decodeURIComponent(caseDetail[1]);
      const found = Object.values(state.caseDetails).find((c) => String(c.id) === key || c.referenceNumber === key);
      return found ? route.fulfill(json(200, { case: found })) : route.fulfill(json(404, { error: 'Case not found' }));
    }
    const wait = (ms) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : null);
    const docRoute = /^\/admin\/requests\/(\d+)\/documents\/(\d+)\/(file|review)$/.exec(pathname);
    if (docRoute) {
      const [, requestId, docId, kind] = docRoute;
      const found = state.details[requestId];
      const document = found?.requestDocuments.find((d) => String(d.id) === docId);

      if (kind === 'file' && req.method() === 'GET') {
        await wait(state.fileDelayMs);
        const forced = state.fileResponses[docId];
        if (forced) return route.fulfill(json(forced.status, forced.body));
        if (!document) return route.fulfill(json(404, { error: 'Document not found' }));
        if (document.scanStatus !== 'clean') {
          return route.fulfill(json(409, { error: `This document cannot be opened: its virus scan is "${document.scanStatus}".`, code: 'document_not_clean' }));
        }
        // Like the server, every successful download is written to the request's audit history.
        found.requestEvents.push({
          id: state.nextEventId++, serviceRequestId: found.id, documentId: document.id, action: 'document_downloaded', fromStatus: null, toStatus: null,
          actorType: 'admin', actorId: 1, detail: null, occurredAt: new Date().toISOString(),
        });
        return route.fulfill({
          status: 200,
          headers: {
            ...CORS,
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="${document.originalName}"`,
            ...(state.exposeDisposition && { 'access-control-expose-headers': 'Content-Disposition' }),
          },
          body: state.fileContent,
        });
      }

      if (kind === 'review' && req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        state.reviews.push({ id: Number(requestId), docId: Number(docId), body });
        await wait(state.reviewDelayMs);
        const forced = state.reviewResponses[docId];
        if (forced) return route.fulfill(json(forced.status, forced.body));
        // The server's rules (request-review.service.js reviewDocument), in the same order.
        if (body.decision !== 'approved' && body.decision !== 'rejected') return route.fulfill(json(400, { error: 'decision must be "approved" or "rejected".' }));
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (body.decision === 'rejected' && (reason.length < 3 || reason.length > 1000)) {
          return route.fulfill(json(400, { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_required' }));
        }
        if (!found || found.reviewStatus === null) return route.fulfill(json(404, { error: 'Request not found' }));
        if (found.reviewStatus === 'approved') return route.fulfill(json(409, { error: 'This request has already been approved.', code: 'request_approved' }));
        if (!document) return route.fulfill(json(404, { error: 'Document not found' }));
        if (document.supersededAt) return route.fulfill(json(409, { error: 'This document was replaced by a newer one.', code: 'document_superseded' }));
        if (document.scanStatus !== 'clean') {
          return route.fulfill(json(409, { error: `Only a document whose virus scan is clean can be reviewed (scan: "${document.scanStatus}").`, code: 'document_not_clean' }));
        }
        const allowed = body.decision === 'approved' ? document.reviewStatus === 'pending' : document.reviewStatus !== 'rejected';
        if (!allowed) return route.fulfill(json(409, { error: `This document is already ${document.reviewStatus}.`, code: 'already_decided' }));

        const now = new Date().toISOString();
        Object.assign(document, {
          reviewStatus: body.decision, reviewedByAdminId: 1, reviewedAt: now, rejectionReason: body.decision === 'rejected' ? reason : null,
        });
        found.requestEvents.push({
          id: state.nextEventId++, serviceRequestId: found.id, documentId: document.id, action: body.decision === 'approved' ? 'document_approved' : 'document_rejected',
          fromStatus: null, toStatus: null, actorType: 'admin', actorId: 1, detail: { previous: 'pending', ...(reason && body.decision === 'rejected' && { reason }) }, occurredAt: now,
        });
        if (body.decision === 'rejected' && found.reviewStatus !== 'changes_requested') found.reviewStatus = 'changes_requested';
        const current = found.requestDocuments.filter((d) => !d.supersededAt);
        found.documentSummary = {
          ...found.documentSummary,
          awaitingReview: current.filter((d) => d.scanStatus === 'clean' && d.reviewStatus === 'pending').length,
          approved: current.filter((d) => d.reviewStatus === 'approved').length,
          rejected: current.filter((d) => d.reviewStatus === 'rejected').length,
        };
        return route.fulfill(json(200, { document }));
      }
    }

    const askRoute = /^\/admin\/requests\/(\d+)\/request-documents$/.exec(pathname);
    if (askRoute && req.method() === 'POST') {
      // POST .../request-documents, with the server's checks in the same order: reason (400), request found (404), approved (409
      // request_approved), draft (409 request_is_draft), already waiting for the patient (409 documents_request_already_pending).
      const requestId = askRoute[1];
      const body = JSON.parse(req.postData() || '{}');
      state.requestDocs.push({ id: Number(requestId), body });
      await wait(state.requestDocsDelayMs);
      const forced = state.requestDocsResponses[requestId];
      if (forced) return route.fulfill(json(forced.status, forced.body));
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 3 || reason.length > 1000) {
        return route.fulfill(json(400, { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_required' }));
      }
      const found = state.details[requestId];
      if (!found || found.reviewStatus === null || found.reviewStatus === undefined) return route.fulfill(json(404, { error: 'Request not found' }));
      if (found.reviewStatus === 'approved') return route.fulfill(json(409, { error: 'This request has already been approved.', code: 'request_approved' }));
      // The backend's two further guards (requestAdditionalDocuments): only a submitted request that is in review.
      if (found.reviewStatus === 'awaiting_documents') {
        return route.fulfill(json(409, { error: 'This request is still a draft: the patient has not uploaded a document yet, so documents cannot be requested.', code: 'request_is_draft' }));
      }
      if (found.reviewStatus === 'changes_requested') {
        return route.fulfill(json(409, { error: 'The patient has already been asked for changes and has not responded yet. Wait for their upload before requesting more.', code: 'documents_request_already_pending' }));
      }
      const now = new Date().toISOString();
      found.requestEvents.push({
        id: state.nextEventId++, serviceRequestId: found.id, documentId: null, action: 'documents_requested', fromStatus: found.reviewStatus, toStatus: 'changes_requested',
        actorType: 'admin', actorId: 1, detail: { reason }, occurredAt: now,
      });
      Object.assign(found, { reviewStatus: 'changes_requested', documentsRequestReason: reason, reviewedAt: now });
      return route.fulfill(json(200, { request: found }));
    }

    const approveRoute = /^\/admin\/requests\/(\d+)\/approve$/.exec(pathname);
    if (approveRoute && req.method() === 'POST') {
      // POST .../approve, like the server: 404, already approved (200 with the existing Case), blockers (409 approval_blocked), else 201 and a Case.
      const requestId = approveRoute[1];
      state.approvals.push(Number(requestId));
      await wait(state.approveDelayMs);
      const forced = state.approveResponses[requestId];
      if (forced) return route.fulfill(json(forced.status, forced.body));
      const found = state.details[requestId];
      if (!found || found.reviewStatus == null) return route.fulfill(json(404, { error: 'Request not found' }));
      if (found.reviewStatus === 'approved') return route.fulfill(json(200, { request: found, case: found.case, alreadyApproved: true }));
      const current = found.requestDocuments.filter((d) => !d.supersededAt);
      const blockers = [];
      if (found.reviewStatus !== 'in_review') blockers.push({ code: 'not_in_review', message: 'The request is not in review.' });
      for (const d of current) {
        if (d.scanStatus !== 'clean') blockers.push({ code: 'unscanned', documentId: d.id, message: `"${d.originalName}" has not been scanned yet.` });
        else if (d.reviewStatus === 'pending') blockers.push({ code: 'awaiting_review', documentId: d.id, message: `"${d.originalName}" is waiting for review.` });
        else if (d.reviewStatus === 'rejected') blockers.push({ code: 'rejected', documentId: d.id, message: `"${d.originalName}" was rejected and has not been replaced.` });
      }
      if (!current.length) blockers.push({ code: 'no_documents', message: 'The request has no current document.' });
      if (blockers.length) return route.fulfill(json(409, { error: 'This request cannot be approved yet.', code: 'approval_blocked', blockers }));
      const caseId = state.nextCaseId++;
      const now = new Date().toISOString();
      found.case = { id: caseId, referenceNumber: `CASE-${1000 + caseId}`, status: 'submitted' };
      Object.assign(found, { reviewStatus: 'approved', reviewedAt: now, documentsRequestReason: null });
      found.requestEvents.push(
        { id: state.nextEventId++, serviceRequestId: found.id, documentId: null, action: 'request_approved', fromStatus: 'in_review', toStatus: 'approved', actorType: 'admin', actorId: 1, detail: { documents: current.length }, occurredAt: now },
        { id: state.nextEventId++, serviceRequestId: found.id, documentId: null, action: 'case_created', fromStatus: null, toStatus: null, actorType: 'admin', actorId: 1, detail: { caseId, caseReference: found.case.referenceNumber }, occurredAt: now },
      );
      return route.fulfill(json(201, { request: found, case: found.case, alreadyApproved: false }));
    }

    const detail = /^\/admin\/requests\/(\d+)$/.exec(pathname);
    if (detail) {
      // GET /admin/requests/:id: `state.details[id]` is the request exactly as the API returns it.
      if (state.detailDelayMs) await new Promise((resolve) => setTimeout(resolve, state.detailDelayMs));
      if (state.detailStatus !== 200) return route.fulfill(json(state.detailStatus, { error: 'Could not load the request.' }));
      const found = state.details[detail[1]];
      if (!found) return route.fulfill(json(404, { error: 'Request not found' }));
      return route.fulfill(json(200, { request: found }));
    }
    if (pathname === '/admin/requests') {
      if (state.requestsStatus !== 200) return route.fulfill(json(state.requestsStatus, { error: 'Could not load the requests.' }));
      // Same contract as the backend: status is one value or a comma list, search matches the
      // reference or patient name, and total ignores limit/offset. Without a status, drafts are left out.
      const status = searchParams.get('status');
      const search = (searchParams.get('search') || '').toLowerCase();
      const limit = Number(searchParams.get('limit')) || 50;
      const offset = Number(searchParams.get('offset')) || 0;
      const matching = state.requests.filter((r) => {
        const okStatus = status ? status.split(',').includes(r.reviewStatus) : r.reviewStatus !== 'awaiting_documents';
        const okSearch = !search || r.referenceNumber.toLowerCase().includes(search) || r.patientName.toLowerCase().includes(search);
        return okStatus && okSearch;
      });
      return route.fulfill(json(200, { requests: matching.slice(offset, offset + limit), total: matching.length }));
    }
    return route.fulfill(json(404, { error: `unmocked endpoint ${pathname}` }));
  });

  return state;
}

const meCalls = (state) => state.calls.filter((c) => c.path === '/admin/me').length;

module.exports = { installMockApi, meCalls, APP_ORIGIN, API_ORIGIN };
