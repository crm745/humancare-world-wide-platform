// @ts-check
// Phase C: Submission Details (read-only), against the MOCKED API (tests/helpers/mockApi.js),
// which serves `state.details[id]` exactly as GET /admin/requests/:id returns a request.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const user = { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: '+971501234567' };
const doc = (over = {}) => ({
  id: 1, serviceRequestId: 501, originalName: 'report.pdf', sizeBytes: 2048, mimeType: 'application/pdf', uploadedByUserId: 9, uploadedAt: '2026-11-01T10:00:00.000Z',
  replacesId: null, supersededAt: null, scanStatus: 'clean', scanEngine: 'clamav', scanDetail: null, scannedAt: '2026-11-01T10:00:05.000Z',
  reviewStatus: 'pending', reviewedByAdminId: null, reviewedAt: null, rejectionReason: null, caseDocumentId: null, ...over,
});
const ev = (id, action, over = {}) => ({ id, serviceRequestId: 501, documentId: null, action, fromStatus: null, toStatus: null, actorType: 'system', actorId: null, detail: null, occurredAt: `2026-11-01T10:${String(id).padStart(2, '0')}:00.000Z`, ...over });

const full = {
  id: 501, userId: 9, referenceNumber: 'REQ-1501', serviceType: 'Private Charter', serviceKey: 'privatecharter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female',
  patientLocation: 'City Hospital, Mumbai', patientContact: '+971501234567', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, Dubai, United Arab Emirates', country: 'AE',
  preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu,care_stable', description: 'Needs an ICU transfer.\nOxygen on board.', mobility: 'bedridden',
  equipOxygen: true, equipCardiacMonitor: false, equipVentilator: null, urgency: 'urgent_24h', status: 'submitted', bitrixLeadId: null,
  createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'changes_requested', submittedAt: '2026-11-01T09:30:00.000Z', reviewedAt: '2026-11-01T11:00:00.000Z',
  documentsRequestReason: 'Please add the fitness-to-fly certificate.',
  user,
  requestDocuments: [
    doc({ id: 1, originalName: 'old-report.pdf', supersededAt: '2026-11-01T12:00:00.000Z', reviewStatus: 'rejected', reviewedByAdminId: 7, reviewedAt: '2026-11-01T10:30:00.000Z', rejectionReason: 'Photo is too blurry to read.' }),
    doc({ id: 2, originalName: 'new-report.pdf', replacesId: 1, uploadedAt: '2026-11-01T12:00:00.000Z' }),
    doc({ id: 3, originalName: 'virus.pdf', scanStatus: 'infected', scanDetail: 'Eicar-Test-Signature', reviewStatus: 'pending' }),
    doc({ id: 4, originalName: 'broken.pdf', scanStatus: 'error', scanDetail: 'the stored file is missing' }),
    doc({ id: 5, originalName: 'certificate.pdf', reviewStatus: 'approved', reviewedByAdminId: 7, reviewedAt: '2026-11-01T10:40:00.000Z' }),
  ],
  // Deliberately out of order: the page must show them oldest first.
  requestEvents: [
    ev(5, 'document_rejected', { documentId: 1, actorType: 'admin', actorId: 7, detail: { previous: 'pending', reason: 'Photo is too blurry to read.' } }),
    ev(1, 'request_created', { actorType: 'patient', actorId: 9, detail: { referenceNumber: 'REQ-1501' } }),
    ev(3, 'scan_clean', { documentId: 1, detail: { engine: 'clamav' } }),
    ev(2, 'document_uploaded', { documentId: 1, actorType: 'patient', actorId: 9, detail: { name: 'old-report.pdf', sizeBytes: 2048 } }),
    ev(4, 'status_changed', { fromStatus: 'awaiting_documents', toStatus: 'in_review', actorType: 'patient', actorId: 9 }),
    ev(6, 'document_replaced', { documentId: 2, actorType: 'patient', actorId: 9, detail: { name: 'new-report.pdf', sizeBytes: 3000, replacesId: 1 } }),
    ev(7, 'scan_infected', { documentId: 3, detail: { engine: 'clamav', detail: 'Eicar-Test-Signature' } }),
    ev(8, 'scan_error', { documentId: 4, detail: { engine: 'clamav', detail: 'the stored file is missing' } }),
    ev(9, 'documents_requested', { actorType: 'admin', actorId: 7, fromStatus: 'in_review', toStatus: 'changes_requested', detail: { reason: 'Please add the fitness-to-fly certificate.' } }),
  ],
  case: null,
  documentSummary: { current: 4, awaitingScan: 1, scanErrors: 1, infected: 1, awaitingReview: 1, approved: 1, rejected: 0 },
};

const approved = {
  ...full, id: 502, referenceNumber: 'REQ-1502', reviewStatus: 'approved', documentsRequestReason: null,
  requestDocuments: [doc({ id: 20, serviceRequestId: 502, originalName: 'ok.pdf', reviewStatus: 'approved', reviewedByAdminId: 7 })],
  requestEvents: [ev(30, 'request_approved', { actorType: 'admin', actorId: 7, fromStatus: 'in_review', toStatus: 'approved', detail: { documents: 1 } }), ev(31, 'case_created', { actorType: 'admin', actorId: 7, detail: { caseId: 3, caseReference: 'CASE-1003' } })],
  case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted' },
  documentSummary: { current: 1, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 1, rejected: 0 },
};

// Everything optional is missing: the page must say so rather than invent anything.
const sparse = {
  id: 503, userId: 9, referenceNumber: 'REQ-1503', serviceType: 'Private Charter', patientName: 'Sparse Patient', patientAge: null, patientGender: null, patientLocation: null, patientContact: null,
  origin: 'A', destination: 'B', country: null, preferredDate: null, careLevel: null, description: null, mobility: null, equipOxygen: null, equipCardiacMonitor: null, equipVentilator: null, urgency: null,
  createdAt: '2026-11-01T09:00:00.000Z', reviewStatus: 'in_review', submittedAt: null, documentsRequestReason: null,
  user: { id: 9, name: 'Maria Fernandez', email: 'maria@example.com', mobile: null },
  requestDocuments: [], requestEvents: [], case: null, documentSummary: { current: 0, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 0 },
};

const draft = { ...sparse, id: 504, referenceNumber: 'REQ-1504', patientName: 'Draft Dave', reviewStatus: 'awaiting_documents' };

const listRow = (r) => ({ ...r, documents: r.documentSummary });
const details = { 501: full, 502: approved, 503: sparse, 504: draft };
const detailCalls = (api) => api.calls.filter((c) => /^\/admin\/requests\/\d+$/.test(c.path));
const section = (page, title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title }) });
const nav = (page) => page.getByRole('navigation', { name: 'Main navigation' }).first();

test.describe('details page content', () => {
  test('loads the real endpoint and shows header, patient, account and request information', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');

    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    // (React StrictMode runs the effect twice in development, so allow a repeat of the same call.)
    expect(new Set(detailCalls(api).map((c) => c.path))).toEqual(new Set(['/admin/requests/501']));
    await expect(page).toHaveTitle('REQ-1501 · HumanCare Admin');

    const header = page.getByRole('main').locator('header');
    await expect(header.getByText('Changes requested', { exact: true })).toBeVisible();
    await expect(header.getByText('Maria Fernandez')).toBeVisible();
    await expect(header.getByText(/Submitted/)).toBeVisible();
    await expect(header.getByText('Documents requested from the patient:')).toBeVisible();

    const patient = section(page, 'Patient information');
    await expect(patient).toContainText('Maria Fernandez');
    await expect(patient).toContainText('61');
    await expect(patient).toContainText('Female');
    await expect(patient).toContainText('+971501234567');
    await expect(patient).toContainText('City Hospital, Mumbai');

    const account = section(page, 'Requested by (account)');
    await expect(account).toContainText('maria@example.com');
    await expect(account).toContainText('+971501234567');

    const info = section(page, 'Request information');
    await expect(info).toContainText('Private Charter');
    await expect(info).toContainText('Mumbai, Maharashtra, India');
    await expect(info).toContainText('Dubai, Dubai, United Arab Emirates');
    await expect(info).toContainText('AE');
    await expect(info).toContainText('ICU / Critical, Stable / Monitored'); // keys are shown as labels
    await expect(info).not.toContainText('care_icu');
    await expect(info).toContainText('Urgent (24h)');
    await expect(info).toContainText('Bedridden');
    await expect(info).toContainText('Oxygen');
    await expect(info).not.toContainText('Ventilator');
    await expect(info).toContainText('Needs an ICU transfer.');
    await expect(info).toContainText('2099'); // the preferred date, as that calendar day
  });

  test('the document header badges reuse the list states, including the separate scan error', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    const badges = page.getByLabel('Document status');
    await expect(badges.getByText('Infected document')).toBeVisible();
    await expect(badges.getByText('Scan error')).toBeVisible();
    await expect(badges.getByText('Awaiting review')).toBeVisible();
  });

  test('document history lists every version with scan, review, rejection, replacement and superseded states', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    const history = page.getByRole('list', { name: 'Document history' });
    const card = (name) => history.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });

    await expect(history.getByRole('listitem')).toHaveCount(5);
    // Rejected, replaced original: dimmed, with its reason, reviewer id and what replaced it.
    const old = card('old-report.pdf');
    await expect(old).toHaveAttribute('data-severity', 'rejected');
    await expect(old).toHaveAttribute('data-superseded', 'true');
    await expect(old).toContainText('Rejected');
    await expect(old).toContainText('Replaced');
    await expect(old).toContainText('Photo is too blurry to read.');
    await expect(old).toContainText('by Admin #7');
    await expect(old).toContainText('Replaced by');
    await expect(old).toContainText('new-report.pdf (document #2)');
    // The replacement points back at it.
    const replacement = card('new-report.pdf');
    await expect(replacement).toContainText('Replaces');
    await expect(replacement).toContainText('old-report.pdf (document #1)');
    await expect(replacement).toHaveAttribute('data-severity', 'normal');
    // Infected: the one solid-red badge and an explicit warning.
    const infected = card('virus.pdf');
    await expect(infected).toHaveAttribute('data-severity', 'infected');
    await expect(infected.locator('.bg-red-600')).toContainText('Infected');
    await expect(infected).toContainText('quarantined');
    await expect(infected).toContainText('Eicar-Test-Signature');
    await expect(page.locator('li[data-severity] .bg-red-600')).toHaveCount(1);
    // Scan error is distinct from both infected and awaiting scan.
    const failed = card('broken.pdf');
    await expect(failed).toHaveAttribute('data-severity', 'scan_error');
    await expect(failed).toContainText('Scan error');
    await expect(failed).toContainText('the stored file is missing');
    await expect(failed).toContainText('retried automatically');
    await expect(failed.locator('.bg-red-600')).toHaveCount(0);
    // Approved is plain.
    await expect(card('certificate.pdf')).toContainText('Approved');
    await expect(card('certificate.pdf')).toHaveAttribute('data-severity', 'normal');
    // A document that is not clean is not offered for review.
    await expect(card('virus.pdf')).toContainText('Not reviewable until scanned clean');
  });

  test('timeline: oldest first, plain-language titles, Admin only by id, patient by account name', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    const timeline = page.getByRole('list', { name: 'Request timeline' });
    await expect(timeline.getByRole('listitem')).toHaveCount(9);
    const titles = await timeline.locator('li p.font-semibold').allTextContents();
    expect(titles).toEqual([
      'Request created', 'Document uploaded', 'Virus scan clean', 'Status changed', 'Document rejected',
      'Replacement uploaded', 'Virus scan: infected', 'Virus scan error', 'Additional documents requested',
    ]);
    const item = (title) => timeline.getByRole('listitem').filter({ has: page.getByText(title, { exact: true }) });
    await expect(item('Document rejected')).toContainText('old-report.pdf');
    await expect(item('Document rejected')).toContainText('Reason: Photo is too blurry to read.');
    await expect(item('Document rejected')).toContainText('Admin #7');
    await expect(item('Status changed')).toContainText('Draft → In review');
    await expect(item('Replacement uploaded')).toContainText('Replaces "old-report.pdf"');
    await expect(item('Request created')).toContainText('Patient (Maria Fernandez)');
    await expect(item('Virus scan clean')).toContainText('System');
    await expect(item('Additional documents requested')).toContainText('Reason: Please add the fitness-to-fly certificate.');
    // The API sends no Admin names, so none is shown.
    await expect(timeline).not.toContainText(/Admin [A-Z]/);
  });

  test('approval and Case creation appear in the timeline, and the linked Case shows reference and status', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/502');
    const timeline = page.getByRole('list', { name: 'Request timeline' });
    await expect(timeline.locator('li p.font-semibold')).toHaveText(['Request approved', 'Case created']);
    await expect(timeline).toContainText('1 document attached to the Case');
    await expect(timeline).toContainText('CASE-1003');
    const linked = section(page, 'Linked Case');
    await expect(linked).toContainText('CASE-1003');
    await expect(linked).toContainText('submitted');
    // Phase G: the Case page exists, so the section links to it.
    await expect(linked.getByRole('link', { name: 'Open Case' })).toHaveAttribute('href', /^\/cases\/\d+$/);
  });

  test('without a Case, says so', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    await expect(section(page, 'Linked Case')).toContainText('No Case yet');
  });

  test('missing optional fields: shown as "Not provided" or left out, nothing invented', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/503');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1503' })).toBeVisible();
    await expect(page.getByRole('main').locator('header')).toContainText('Not submitted');

    const patient = section(page, 'Patient information');
    await expect(patient.getByText('Not provided')).toHaveCount(3); // age, gender, contact
    await expect(patient).not.toContainText('Current location'); // optional: omitted
    const account = section(page, 'Requested by (account)');
    await expect(account.getByText('Not provided')).toHaveCount(1); // mobile
    const info = section(page, 'Request information');
    await expect(info.getByText('Not provided')).toHaveCount(5); // country, preferred date, care level, urgency, description
    for (const optional of ['Mobility', 'Equipment', 'Place of death', 'Relationship to deceased', 'Date of death']) {
      await expect(info).not.toContainText(optional);
    }
    await expect(page.getByText('No documents uploaded', { exact: true })).toBeVisible();
    await expect(page.getByText('No events recorded.')).toBeVisible();
    await expect(page.getByLabel('Document status')).toHaveText('No current document'); // in review with nothing uploaded
    await expect(page.getByText('Infected')).toHaveCount(0);
  });

  test('offers document actions only where allowed, and none of the later-phase controls', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Phase D: new-report.pdf (clean, pending) gets all three; certificate.pdf (approved) can be opened or rejected;
    // the replaced, infected and scan-error documents get nothing.
    await expect(page.getByRole('button', { name: /^Download / })).toHaveCount(2);
    await expect(page.getByRole('button', { name: /^Approve (?!request)/ })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Reject / })).toHaveCount(2);
    // Phase E1: this request is already waiting for the patient (changes requested), so no document request is offered.
    await expect(page.getByRole('button', { name: /additional documents|document request/i })).toHaveCount(0);
    // Phase F: the request itself can be approved only when ready; this one is waiting for the patient, so the button is disabled.
    await expect(page.getByRole('button', { name: 'Approve request' })).toBeDisabled();
    // The frontend never creates a Case on its own.
    await expect(page.getByRole('button', { name: /create case/i })).toHaveCount(0);
  });
});

test.describe('loading, error and not-found states', () => {
  test('shows a loader while the request is fetched', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details, detailDelayMs: 700 });
    await page.goto('/requests/501');
    await expect(page.getByRole('status', { name: 'Loading' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading' })).toHaveCount(0);
  });

  test('a failed load shows the server message and Try again recovers', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, details, detailStatus: 500 });
    await page.goto('/requests/501');
    await expect(page.getByRole('alert')).toContainText('Could not load the request.');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
    api.detailStatus = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a failed refresh keeps the request on screen and says what went wrong', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    api.detailStatus = 500;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('alert')).toContainText('Could not load the request.');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
  });

  test('an unknown id shows "Request not found" with a way back', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/999');
    await expect(page.getByText('Request not found')).toBeVisible();
    await page.getByRole('link', { name: /Back to Incomplete Submissions/ }).click();
    await expect(page).toHaveURL(/\/requests$/);
  });

  test('an id that is not a number is "not found" without calling the API', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, details });
    await page.goto('/requests/abc');
    await expect(page.getByText('Request not found')).toBeVisible();
    expect(detailCalls(api)).toHaveLength(0);
  });

  test('a 401 returns to login through the existing session handling', async ({ page, context }) => {
    await installMockApi(context, { authed: false, details });
    await page.goto('/requests/501');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('navigation', () => {
  const rows = [listRow(full), listRow({ ...draft, documents: draft.documentSummary })];

  test('the reference on Incomplete Submissions opens the request, and Back returns to that list', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details, requests: rows });
    await page.goto('/requests');
    await page.getByRole('link', { name: 'REQ-1501' }).click();
    await expect(page).toHaveURL(/\/requests\/501$/);
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to Incomplete Submissions' }).click();
    await expect(page).toHaveURL(/\/requests$/);
    await expect(page.getByRole('link', { name: 'REQ-1501' })).toBeVisible();
  });

  test('the reference on Drafts opens the draft, and Back returns to Drafts', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details, requests: rows });
    await page.goto('/requests/drafts');
    await page.getByRole('link', { name: 'REQ-1504' }).click();
    await expect(page).toHaveURL(/\/requests\/504$/);
    await expect(page.getByRole('main').locator('header')).toContainText('Draft');
    await expect(page.getByRole('main').locator('header')).toContainText('Not submitted');
    await page.getByRole('link', { name: 'Back to Drafts' }).click();
    await expect(page).toHaveURL(/\/requests\/drafts$/);
  });

  test('opened directly, Back goes to the list that matches the status', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/504');
    await expect(page.getByRole('link', { name: 'Back to Drafts' })).toBeVisible();
    await page.goto('/requests/501');
    await expect(page.getByRole('link', { name: 'Back to Incomplete Submissions' })).toBeVisible();
  });

  test('only one sidebar item is highlighted: Drafts on /requests/drafts, Incomplete Submissions on a request', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details, requests: rows });
    const active = nav(page).locator('a[aria-current="page"]');
    await page.goto('/requests/drafts');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Drafts');
    await page.goto('/requests/501');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Incomplete Submissions');
  });

  test('going from one request to another shows the new one, never the old one', async ({ page, context }) => {
    await installMockApi(context, { authed: true, details });
    await page.goto('/requests/501');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
    await page.goto('/requests/502');
    await expect(page.getByRole('heading', { level: 1, name: 'REQ-1502' })).toBeVisible();
    await expect(page.getByText('REQ-1501')).toHaveCount(0);
  });
});

test.describe('responsive layout', () => {
  for (const width of [1280, 768, 375, 320]) {
    test(`${width}px: no horizontal overflow, even with a very long file name`, async ({ page, context }) => {
      const long = { ...full, requestDocuments: [doc({ id: 1, originalName: `${'very-long-document-name-'.repeat(8)}.pdf` }), ...full.requestDocuments.slice(1)] };
      await installMockApi(context, { authed: true, details: { 501: long } });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/requests/501');
      await expect(page.getByRole('heading', { level: 1, name: 'REQ-1501' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
