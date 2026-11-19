// A fake backend for browser tests that must never touch the real API or database.
// Every request to the API origin is intercepted and answered here; anything not listed
// gets a 404, so a forgotten endpoint fails loudly instead of leaking out.
//
// It also installs the fake WebAuthn API (see fakeWebAuthn.js), so sign-in and the passkey steps
// run without an authenticator. Individual tests change what the "server" does by editing `state`
// or by adding `state.override['POST /path'] = { status, body }` (or a function returning one).
const { installFakeWebAuthn } = require('./fakeWebAuthn');

const APP_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000';

const CORS = {
  'access-control-allow-origin': APP_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type,x-hc-admin',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};

const json = (status, body) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const b64u = (n, fill) => Buffer.alloc(n, fill).toString('base64url');
const REQUEST_OPTIONS = () => ({ challenge: b64u(32, 9), rpId: 'localhost', timeout: 120000, allowCredentials: [{ id: b64u(16, 1), type: 'public-key', transports: ['internal'] }], userVerification: 'required' });
const CREATION_OPTIONS = () => ({
  rp: { name: 'HumanCare World Wide Admin', id: 'localhost' },
  user: { id: b64u(32, 8), name: 'admin@example.com', displayName: 'Test Admin' },
  challenge: b64u(32, 9),
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 120000,
  attestation: 'none',
  excludeCredentials: [{ id: b64u(16, 2), type: 'public-key' }],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
});


// Quotation rows as the server returns them: newest first, each with the `actions` the server would allow for its state (quotationActions in
// quotations.service.js). `list` is an array of quotation rows with an optional `caseReference` property.
function recomputeQuotations(list) {
  const rows = [...list].sort((a, b) => b.versionNumber - a.versionNumber);
  const hasWorking = rows.some((q) => ['draft', 'confirmed'].includes(q.status));
  return rows.map((q, i) => {
    const blockers = [];
    if (q.scanStatus !== 'clean') blockers.push({ code: 'scan_not_clean', message: q.scanStatus === 'infected' ? 'The file was flagged by the malware scan and can never be confirmed.' : 'The file has not been scanned for malware yet.' });
    if (q.amount == null || q.currency == null || q.validationError) blockers.push({ code: 'quotation_invalid', message: 'The final amount or currency is missing or invalid in Bitrix24. Correct it there; this version updates by itself.', ...(q.validationError ? { detail: q.validationError } : {}) });
    const working = ['draft', 'confirmed'].includes(q.status);
    return {
      confirmedAt: null, confirmedBy: null, publishedAt: null, publishedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null, decidedAt: null, rejectionReason: null,
      supersededAt: null, supersededById: null, validUntil: null, validationError: null, scannedAt: null, live: false, ...q,
      actions: {
        canConfirm: q.status === 'draft' && blockers.length === 0,
        canPublish: q.status === 'confirmed' && blockers.length === 0,
        canWithdraw: ['draft', 'confirmed', 'published'].includes(q.status),
        canCreateVersion: i === 0 && ['accepted', 'rejected', 'withdrawn', 'superseded'].includes(q.status) && q.scanStatus === 'clean' && !hasWorking,
        canViewFile: q.scanStatus === 'clean',
        blockers: working ? blockers : [],
      },
    };
  });
}

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
    loginStatus: 200, // set to 401/429 to make the password step fail
    loginError: 'Invalid credentials',
    passkeyStatus: 200, // the passkey step of sign-in
    refreshStatus: 401, // what POST /admin/refresh answers (200 = the session is renewed)
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
    shareResponses: {}, // 'authorize' | 'revoke' | 'retry' | 'document_request' -> { status, body }: force an answer for a Bitrix sharing / document-request POST
    shareCalls: [], // { kind, requestId, docId?, shareId?, body } for every such POST that reached the server
    nextShareId: 900,
    nextDocumentRequestId: 70,
    // Operations quotations (see the handlers below, which follow quotations.service.js): caseId -> the versions GET /admin/cases/:id/quotations returns.
    quotations: {},
    quotationStatus: 200, // set to 500 to make the list fail
    quotationDelayMs: 0,
    quotationCalls: [], // { kind: 'confirm' | 'publish' | 'withdraw' | 'new-version' | 'file', id, body } for every call that reached the server
    quotationResponses: {}, // 'confirm' | 'publish' | 'withdraw' | 'new-version' | 'file' -> { status, body }: force an answer
    quotationFile: '%PDF-1.4 mock quotation',
    nextQuotationId: 800,
    nextCaseId: 50,
    nextEventId: 1000,
    // Admin Lock: invitation, recovery and the generic per-route override.
    invite: { valid: true, state: 'valid', adminName: 'New Person', maskedEmail: 'ne***@example.org', purpose: 'activation' },
    decision: { status: 'pending', validApprovals: 1 }, // what an approval answers
    recoveryRequests: [], // what GET /admin/recovery/requests lists (`requests` is the review list above)
    override: {},
    calls: [], // { method, path, query, rawBody, cookie, csrf, origin, body }
    ...initial,
  };
  state.details = structuredClone(state.details); // tests change it; never share it between tests
  state.cases = structuredClone(state.cases);
  state.caseDetails = structuredClone(state.caseDetails);

  await installFakeWebAuthn(context, { supported: initial.webauthnSupported !== false });

  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const { pathname, searchParams } = new URL(req.url());
    const headers = req.headers();
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch {
      body = null;
    }
    const key = `${req.method()} ${pathname}`;
    state.calls.push({
      method: req.method(), path: pathname, query: Object.fromEntries(searchParams), rawBody: req.postData() || null,
      cookie: headers.cookie || null, csrf: headers['x-hc-admin'] || null, origin: headers.origin || null, body,
    });

    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });

    const override = state.override[key];
    if (override) {
      const out = typeof override === 'function' ? override(body, state) : override;
      if (out.abort) return route.abort(out.abort); // simulate a network failure
      return route.fulfill(json(out.status, out.body));
    }

    // ---- sign-in -------------------------------------------------------------------------
    if (key === 'POST /admin/login/password') {
      if (state.loginStatus !== 200) return route.fulfill(json(state.loginStatus, { error: state.loginError, code: 'invalid_credentials' }));
      return route.fulfill(json(200, { loginTicket: 'LOGIN-TICKET', options: REQUEST_OPTIONS(), loginTicketExpiresInSeconds: 120 }));
    }
    if (key === 'POST /admin/login/passkey') {
      if (state.passkeyStatus !== 200) return route.fulfill(json(state.passkeyStatus, { error: 'Invalid credentials', code: 'invalid_credentials' }));
      state.authed = true;
      return route.fulfill(
        json(200, { admin: { id: 1, name: state.name, email: 'admin@example.com', role: state.role }, accessTokenExpiresInSeconds: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' }),
      );
    }
    if (key === 'POST /admin/refresh') {
      if (state.refreshStatus === 200) {
        state.authed = true;
        return route.fulfill(json(200, { accessTokenExpiresInSeconds: 900 }));
      }
      return route.fulfill(json(state.refreshStatus, { error: 'Invalid token' }));
    }
    if (pathname === '/admin/me') {
      if (state.meNetworkFail) return route.abort('connectionrefused');
      if (!state.authed) return route.fulfill(json(401, { error: 'Missing or malformed Authorization header' }));
      const isSuper = state.role === 'superadmin';
      return route.fulfill(
        json(200, { ok: true, admin: { id: 1, role: 'admin', corporateId: null, adminRole: state.role, corporateReview: isSuper || state.corporateReview } }),
      );
    }
    if (key === 'POST /admin/logout') {
      // The real backend's strict JSON parser refuses any body here that is not an object or array,
      // such as the text "null" (this once left logout failing silently in the real browser).
      if (req.postData()) return route.fulfill(json(400, { error: 'Malformed JSON body', code: 'invalid_json' }));
      if (headers['x-hc-admin'] !== '1') return route.fulfill(json(403, { error: 'Forbidden', code: 'csrf_required' }));
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

    // ---- Operations quotations: the server's rules (quotations.service.js), in the same order, over `state.quotations`.
    const quotationList = /^\/admin\/cases\/([^/]+)\/quotations$/.exec(pathname);
    const quotationAction = /^\/admin\/quotations\/(\d+)\/(file|confirm|publish|withdraw|new-version)$/.exec(pathname);
    if (quotationList && req.method() === 'GET') {
      await wait(state.quotationDelayMs);
      if (state.quotationStatus !== 200) return route.fulfill(json(state.quotationStatus, { error: 'Could not load the quotations.' }));
      const key = decodeURIComponent(quotationList[1]);
      const entry = Object.entries(state.quotations).find(([id]) => id === key) || Object.entries(state.quotations).find(([, list]) => list.caseReference === key);
      if (!entry) return route.fulfill(json(404, { error: 'Case not found', code: 'case_not_found' }));
      const [caseId, list] = entry;
      const rows = recomputeQuotations(list);
      return route.fulfill(json(200, { caseId: Number(caseId), caseReference: list.caseReference || `CASE-${caseId}`, quotations: rows, livePublishedId: (rows.find((q) => q.live) || {}).id ?? null }));
    }
    if (quotationAction) {
      const [, qid, kind] = quotationAction;
      const found = Object.values(state.quotations).flatMap((list) => list.map((q) => ({ q, list }))).find((x) => String(x.q.id) === qid);
      const body = JSON.parse(req.postData() || '{}');
      state.quotationCalls.push({ kind, id: Number(qid), body });
      await wait(state.quotationDelayMs);
      const forced = state.quotationResponses[kind];
      if (forced) return route.fulfill(json(forced.status, forced.body));
      if (!found) return route.fulfill(json(404, { error: 'Quotation not found', code: 'quotation_not_found' }));
      const { q, list } = found;
      const now = new Date().toISOString();
      const admin = { id: 1, name: state.name };
      const view = () => recomputeQuotations(list).find((x) => x.id === q.id);
      const blocked = (code, error, extra = {}) => route.fulfill(json(409, { error, code, ...extra }));
      if (kind === 'file') {
        if (q.scanStatus !== 'clean') return blocked('scan_not_clean', 'The malware scan is not clean, so the file cannot be opened.');
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="quotation-v${q.versionNumber}.pdf"` }, body: state.quotationFile });
      }
      if (!Number.isInteger(body.revision)) return route.fulfill(json(400, { error: 'The quotation revision you looked at is required.', code: 'revision_required' }));
      const readiness = () => {
        const out = [];
        if (q.scanStatus !== 'clean') out.push({ code: 'scan_not_clean', message: 'The file has not been scanned for malware yet.' });
        if (q.amount == null || q.currency == null || q.validationError) out.push({ code: 'quotation_invalid', message: 'The final amount or currency is missing or invalid in Bitrix24. Correct it there; this version updates by itself.', ...(q.validationError ? { detail: q.validationError } : {}) });
        return out;
      };
      if (kind === 'confirm') {
        if (q.status === 'confirmed') return route.fulfill(json(200, { alreadyConfirmed: true, quotation: view() }));
        if (q.status !== 'draft') return blocked('quotation_not_draft', `Only a draft quotation can be confirmed (this one is ${q.status}).`);
        if (body.revision !== q.revision) return blocked('quotation_changed', 'The quotation changed since you opened it.', { currentRevision: q.revision });
        const blockers = readiness();
        if (blockers.length) return blocked(blockers[0].code, blockers[0].message, { blockers });
        Object.assign(q, { status: 'confirmed', confirmedAt: now, confirmedBy: admin, revision: q.revision + 1 });
        return route.fulfill(json(201, { alreadyConfirmed: false, quotation: view() }));
      }
      if (kind === 'publish') {
        if (q.status === 'published') return route.fulfill(json(200, { alreadyPublished: true, quotation: view() }));
        if (q.status === 'draft') return blocked('quotation_not_confirmed', 'The quotation must be confirmed before it can be published.');
        if (q.status === 'accepted') return blocked('new_version_required', 'An accepted quotation cannot be published again. Create a new version.');
        if (q.status !== 'confirmed') return blocked('quotation_not_publishable', `Only a confirmed quotation can be published (this one is ${q.status}).`);
        if (body.revision !== q.revision) return blocked('quotation_changed', 'The quotation changed since you opened it.', { currentRevision: q.revision });
        const blockers = readiness();
        if (blockers.length) return blocked(blockers[0].code, blockers[0].message, { blockers });
        for (const other of list) if (other.id !== q.id && other.live) Object.assign(other, { live: false, status: other.status === 'published' ? 'superseded' : other.status, supersededAt: now, supersededById: q.id });
        Object.assign(q, { status: 'published', live: true, publishedAt: now, publishedBy: admin, revision: q.revision + 1 });
        return route.fulfill(json(201, { alreadyPublished: false, quotation: view() }));
      }
      if (kind === 'withdraw') {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 3 || reason.length > 1000) return route.fulfill(json(400, { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_invalid' }));
        if (q.status === 'withdrawn') return route.fulfill(json(200, { alreadyWithdrawn: true, quotation: view() }));
        if (['accepted', 'rejected', 'superseded'].includes(q.status)) return blocked('quotation_immutable', `A ${q.status} quotation can no longer be changed.`);
        if (body.revision !== q.revision) return blocked('quotation_changed', 'The quotation changed since you opened it.', { currentRevision: q.revision });
        Object.assign(q, { status: 'withdrawn', live: false, withdrawnAt: now, withdrawnBy: admin, withdrawReason: reason, revision: q.revision + 1 });
        return route.fulfill(json(201, { alreadyWithdrawn: false, quotation: view() }));
      }
      if (kind === 'new-version') {
        if (!['accepted', 'rejected', 'withdrawn', 'superseded'].includes(q.status)) return blocked('quotation_not_versionable', `A new version can be made from an accepted, rejected, withdrawn or superseded quotation (this one is ${q.status}).`);
        if (list.some((x) => ['draft', 'confirmed'].includes(x.status))) return blocked('working_version_exists', 'This Case already has an unpublished draft or confirmed quotation.');
        const created = {
          ...q, id: state.nextQuotationId++, versionNumber: Math.max(...list.map((x) => x.versionNumber)) + 1, status: 'draft', live: false, revision: 0, scanStatus: 'pending', scannedAt: null, createdAt: now,
          confirmedAt: null, confirmedBy: null, publishedAt: null, publishedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawReason: null, decidedAt: null, rejectionReason: null, supersededAt: null, supersededById: null,
        };
        list.push(created);
        return route.fulfill(json(201, { quotation: recomputeQuotations(list).find((x) => x.id === created.id) }));
      }
    }
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

    // ---- Bitrix sharing and post-Case document requests (deal-document.controller.js), with the server's checks. A share's status is
    // changed only by "a worker" in real life; here an Admin's action leaves it where the server would (authorized / revoking / authorized again).
    const shareRoute = /^\/admin\/requests\/(\d+)\/(documents\/(\d+)\/share|shares\/(\d+)\/(revoke|retry)|document-requests)$/.exec(pathname);
    if (shareRoute && req.method() === 'POST') {
      const [, requestId, , docId, shareId, shareAction] = shareRoute;
      const body = JSON.parse(req.postData() || '{}');
      const kind = docId ? 'authorize' : shareId ? shareAction : 'document_request';
      state.shareCalls.push({ kind, requestId: Number(requestId), docId: docId ? Number(docId) : undefined, shareId: shareId ? Number(shareId) : undefined, body });
      const forced = state.shareResponses[kind];
      if (forced) return route.fulfill(json(forced.status, forced.body));
      const found = state.details[requestId];
      if (!found || found.reviewStatus == null) return route.fulfill(json(404, { error: 'Request not found' }));
      if (found.reviewStatus !== 'approved') {
        const message = kind === 'document_request' ? 'A document request can be made only after the request is approved.' : 'Documents can be shared only after the request is approved.';
        return route.fulfill(json(409, { error: message, code: 'request_not_approved' }));
      }
      if (!found.case) return route.fulfill(json(409, { error: 'The request has no Case.', code: 'case_missing' }));
      found.documentShares = found.documentShares ?? [];
      const now = new Date().toISOString();
      if (kind === 'document_request') {
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (description.length < 3 || description.length > 1000) return route.fulfill(json(400, { error: 'A description of 3 to 1000 characters is required.', code: 'description_required' }));
        found.case.documentRequests = found.case.documentRequests ?? [];
        const created = { id: state.nextDocumentRequestId++, description, reason: body.reason ?? null, status: 'open', createdAt: now, resolvedAt: null };
        found.case.documentRequests.push(created);
        return route.fulfill(json(201, { documentRequest: created }));
      }
      if (kind === 'authorize') {
        const document = found.requestDocuments.find((d) => d.id === Number(docId));
        if (!document) return route.fulfill(json(404, { error: 'Document not found' }));
        if (document.scanStatus !== 'clean') return route.fulfill(json(409, { error: 'Only a document whose virus scan is clean can be shared.', code: 'document_not_clean' }));
        if (document.reviewStatus !== 'approved') return route.fulfill(json(409, { error: 'Only an approved document can be shared.', code: 'document_not_approved' }));
        if (document.caseDocumentId == null) return route.fulfill(json(409, { error: 'The document is not part of the Case yet.', code: 'not_in_case' }));
        const last = found.documentShares.filter((s) => s.requestDocumentId === document.id).sort((a, b) => b.generation - a.generation)[0];
        if (last && last.status !== 'revoked') return route.fulfill(json(200, { share: last, alreadyAuthorized: true }));
        const share = {
          id: state.nextShareId++, requestDocumentId: document.id, caseDocumentId: document.caseDocumentId, generation: last ? last.generation + 1 : 1, detectedType: 'pdf',
          status: 'authorized', bitrixFileId: null, tryCount: 1, attempts: 0, lastError: null, authorizedAt: now, attachedAt: null, revokedAt: null, revokeReason: null, updatedAt: now,
        };
        found.documentShares.push(share);
        return route.fulfill(json(201, { share, alreadyAuthorized: false }));
      }
      const share = found.documentShares.find((s) => s.id === Number(shareId));
      if (!share) return route.fulfill(json(404, { error: 'Share not found' }));
      if (kind === 'revoke') {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 3 || reason.length > 1000) return route.fulfill(json(400, { error: 'A reason of 3 to 1000 characters is required.', code: 'reason_required' }));
        if (share.status === 'revoking' || share.status === 'revoked') return route.fulfill(json(200, { share, alreadyRevoked: true }));
        if (!['authorized', 'attaching', 'attached', 'ambiguous', 'failed'].includes(share.status)) {
          return route.fulfill(json(409, { error: `A share that is ${share.status} cannot be revoked; retry it first.`, code: 'share_not_revocable' }));
        }
        Object.assign(share, { status: 'revoking', revokeReason: reason, tryCount: share.tryCount + 1, attempts: 0, lastError: null });
        return route.fulfill(json(202, { share, alreadyRevoked: false }));
      }
      if (share.status !== 'failed' && share.status !== 'revoke_failed') return route.fulfill(json(409, { error: 'Only a failed share can be retried.', code: 'share_not_retryable' }));
      Object.assign(share, { status: share.status === 'failed' ? 'authorized' : 'revoking', tryCount: share.tryCount + 1, attempts: 0, lastError: null });
      return route.fulfill(json(202, { share }));
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

    // ---- invitation links and first passkey ------------------------------------------------
    if (key === 'POST /admin/invitations/inspect') return route.fulfill(json(200, state.invite));
    if (key === 'POST /admin/invitations/accept') {
      return route.fulfill(json(200, { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: 'ENROLL-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/enrollment/redeem') {
      return route.fulfill(json(200, { status: 'pending_passkey', nextStep: 'passkey_enrollment', enrollmentTicket: 'ENROLL-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/passkeys/registration/options') return route.fulfill(json(200, { options: CREATION_OPTIONS() }));
    if (key === 'POST /admin/passkeys/registration/verify') return route.fulfill(json(200, { status: 'active', nextStep: 'sign_in' }));

    // ---- recovery: the target Admin's side --------------------------------------------------
    if (key === 'POST /admin/recovery/redeem') {
      return route.fulfill(json(200, { status: 'approved', nextStep: 'passkey_registration', recoveryTicket: 'RECOVERY-TICKET-SECRET', ticketExpiresInSeconds: 600 }));
    }
    if (key === 'POST /admin/recovery/passkeys/registration/options') return route.fulfill(json(200, { options: CREATION_OPTIONS() }));
    if (key === 'POST /admin/recovery/passkeys/registration/verify') return route.fulfill(json(200, { status: 'recovered', nextStep: 'sign_in' }));

    // ---- recovery: a superadmin's decision ---------------------------------------------------
    if (key === 'GET /admin/recovery/requests') {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      return route.fulfill(json(200, { requests: state.recoveryRequests }));
    }
    const stepUp = /^\/admin\/recovery\/requests\/(\d+)\/(approval|rejection)\/options$/.exec(pathname);
    if (req.method() === 'POST' && stepUp) {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      return route.fulfill(json(200, { decision: stepUp[2] === 'approval' ? 'approve' : 'reject', requestId: Number(stepUp[1]), options: REQUEST_OPTIONS(), expiresAt: '2030-01-01T00:00:00Z' }));
    }
    const decide = /^\/admin\/recovery\/requests\/(\d+)\/(approve|reject)$/.exec(pathname);
    if (req.method() === 'POST' && decide) {
      if (!state.authed) return route.fulfill(json(401, { error: 'Invalid token' }));
      const rejected = decide[2] === 'reject';
      return route.fulfill(
        json(200, { decision: decide[2], requestId: Number(decide[1]), status: rejected ? 'rejected' : state.decision.status, validApprovals: rejected ? 0 : state.decision.validApprovals }),
      );
    }

    return route.fulfill(json(404, { error: `unmocked endpoint ${pathname}` }));
  });

  return state;
}

const meCalls = (state) => state.calls.filter((c) => c.path === '/admin/me').length;

module.exports = { installMockApi, meCalls, APP_ORIGIN, API_ORIGIN, REQUEST_OPTIONS, CREATION_OPTIONS };
