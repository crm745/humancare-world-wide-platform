// @ts-check
// Operations quotation management on the Case details page (/cases/:id), against the MOCKED API (tests/helpers/mockApi.js), whose quotation routes
// follow the real server's rules (quotations.service.js): confirm and publish are separate, a changed version is refused, accepted and rejected versions
// are immutable, a withdrawal needs a reason. Nothing here reaches a backend, Bitrix or a patient.
const { test, expect } = require('@playwright/test');
const { installMockApi } = require('../helpers/mockApi');

const caseRow = {
  id: 3, serviceRequestId: 809, corporateId: null, referenceNumber: 'CASE-1003', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971500000000',
  serviceType: 'Private Charter', origin: 'Mumbai', destination: 'Dubai', country: 'AE', urgency: 'urgent', careLevel: 'care_icu', description: null,
  status: 'submitted', createdAt: '2026-11-02T09:00:00.000Z', updatedAt: '2026-11-02T09:00:00.000Z', corporate: null,
  stageEvents: [], documents: [], serviceRequest: { id: 809, userId: 9, referenceNumber: 'REQ-1809' },
};
const corporateCase = { ...caseRow, id: 4, serviceRequestId: null, corporateId: 2, referenceNumber: 'CASE-1004', serviceRequest: null, corporate: { id: 2, companyName: 'Acme Insurance' } };
const requestDetails = {
  809: {
    id: 809, userId: 9, referenceNumber: 'REQ-1809', serviceType: 'Private Charter', patientName: 'Maria Fernandez', patientAge: 61, patientGender: 'female', patientContact: '+971501234567',
    origin: 'Mumbai', destination: 'Dubai', country: 'AE', preferredDate: '2099-01-01T00:00:00.000Z', careLevel: 'care_icu', description: null, urgency: 'urgent_24h', createdAt: '2026-11-01T09:00:00.000Z',
    reviewStatus: 'approved', submittedAt: '2026-11-01T09:30:00.000Z', documentsRequestReason: null, user: { id: 9, name: 'Maria', email: 'm@example.com', mobile: '+971' },
    requestDocuments: [], requestEvents: [], case: { id: 3, referenceNumber: 'CASE-1003', status: 'submitted' },
    documentSummary: { current: 0, awaitingScan: 0, scanErrors: 0, infected: 0, awaitingReview: 0, approved: 0, rejected: 0 },
  },
};

// A version as the server stores it; the mock adds `actions` itself. Quotation 762's real state: draft, revision 3, 1000 INR, scan clean.
const version = (over = {}) => ({
  id: 762, caseId: 3, versionNumber: 1, status: 'draft', revision: 3, amount: '1000.000', currency: 'INR', bitrixAmountRaw: '1000', bitrixCurrencyRaw: 'INR', validationError: null,
  bitrixFileId: '65834', sizeBytes: 366770, sha256: '279f139a63c1942fa8b945d87f44d942e8f4a72ca864af7102f22f9ffb64cd6c', scanStatus: 'clean', scanDetail: 'stream: OK',
  scannedAt: '2026-11-19T10:24:56.000Z', createdAt: '2026-11-19T10:03:19.000Z', updatedAt: '2026-11-19T10:24:56.000Z', ...over,
});
const withCase = (list) => Object.assign(list, { caseReference: 'CASE-1003' });

const open = async (page, context, quotations, initial = {}) => {
  const api = await installMockApi(context, {
    authed: true, name: 'Asha Admin', cases: [caseRow], caseDetails: { 3: caseRow, 4: corporateCase }, details: requestDetails,
    quotations: quotations === null ? {} : { 3: withCase(quotations) }, ...initial,
  });
  await page.goto(initial.__path || '/cases/3');
  await expect(page.getByRole('heading', { level: 1, name: 'CASE-1003' })).toBeVisible();
  return api;
};
const card = (page, n = 1) => page.getByLabel(`Quotation version ${n}`).first();
const dialog = (page) => page.getByRole('dialog');
const calls = (api, kind) => api.quotationCalls.filter((c) => c.kind === kind);

test.describe('what the Admin sees', () => {
  test('shows the version, status, amount, currency, scan state, PDF details and what is allowed', async ({ page, context }) => {
    await open(page, context, [version()]);
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.getByRole('heading', { name: 'Version 1' })).toBeVisible();
    await expect(c).toContainText('Draft');
    await expect(c).toContainText('Malware scan clean');
    await expect(c).toContainText(/1,000\.00/);
    await expect(c).toContainText('INR');
    await expect(c).toContainText('358.2 KB');
    await expect(c).toContainText('279f139a63c1942f…'); // a short checksum, never the storage key
    await expect(c.getByRole('button', { name: 'Confirm amount and currency' })).toBeEnabled();
    await expect(c.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    await expect(c.getByRole('button', { name: 'Publish to patient' })).toHaveCount(0); // not confirmed yet
    await expect(c.getByRole('button', { name: 'View PDF' })).toBeEnabled();
    await expect(c.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    await expect(page.locator('body')).not.toContainText('quotations/case-'); // no storage key anywhere
  });

  test('a Case with no quotation yet says how one appears', async ({ page, context }) => {
    await open(page, context, []);
    await expect(page.getByText('There is no quotation yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm amount and currency' })).toHaveCount(0);
  });

  test('a Case that has no quotations feature (the server answers 404) shows no quotation section', async ({ page, context }) => {
    await open(page, context, null);
    await expect(page.getByText('Service', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Quotation', { exact: true })).toHaveCount(0);
  });

  test('a corporate Case shows no quotation section and makes no quotation call', async ({ page, context }) => {
    const api = await installMockApi(context, { authed: true, cases: [caseRow, corporateCase], caseDetails: { 3: caseRow, 4: corporateCase }, details: requestDetails, quotations: { 3: withCase([version()]) } });
    await page.goto('/cases/4');
    await expect(page.getByRole('heading', { level: 1, name: 'CASE-1004' })).toBeVisible();
    await expect(page.getByText('Quotation', { exact: true })).toHaveCount(0);
    expect(api.quotationCalls).toEqual([]);
  });

  test('a failed load shows an error with Try again', async ({ page, context }) => {
    const api = await open(page, context, [version()], { quotationStatus: 500 });
    await expect(page.getByText('Could not load the quotations.')).toBeVisible();
    api.quotationStatus = 200;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(card(page)).toBeVisible();
  });

  test('earlier versions and every version\'s history (who and when) are listed', async ({ page, context }) => {
    const v1 = version({ id: 701, versionNumber: 1, status: 'rejected', amount: '900.000', confirmedAt: '2026-11-10T09:00:00.000Z', confirmedBy: { id: 7, name: 'Asha Admin' }, publishedAt: '2026-11-10T10:00:00.000Z', publishedBy: { id: 8, name: 'Ravi Super' }, decidedAt: '2026-11-11T10:00:00.000Z', rejectionReason: 'Too high' });
    const v2 = version({ id: 702, versionNumber: 2 });
    await open(page, context, [v1, v2]);
    await expect(card(page, 2)).toContainText('Draft');
    const earlier = page.getByLabel('Quotation history');
    await expect(earlier).toContainText('Version 1');
    await expect(earlier).toContainText('Rejected by the patient');
    await expect(earlier).toContainText('Confirmed by Asha Admin');
    await expect(earlier).toContainText('Published to the patient by Ravi Super');
    await expect(earlier).toContainText('Too high');
    await expect(earlier.getByRole('button')).toHaveCount(0); // a rejected version offers no state change here (a draft is already open)
  });
});

test.describe('confirm and publish are two separate actions', () => {
  test('confirming shows the amount and asks first; it records the revision; it does NOT publish', async ({ page, context }) => {
    const api = await open(page, context, [version()]);
    await card(page).getByRole('button', { name: 'Confirm amount and currency' }).click();
    await expect(dialog(page)).toContainText('Confirm this amount and currency?');
    await expect(dialog(page)).toContainText('CASE-1003 · Version 1');
    await expect(dialog(page)).toContainText(/1,000\.00/);
    await expect(dialog(page)).toContainText('does not see it yet');
    expect(api.quotationCalls).toEqual([]); // nothing is sent until the Admin confirms
    await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(calls(api, 'confirm')).toEqual([{ kind: 'confirm', id: 762, body: { revision: 3 } }]);
    await expect(page.getByText('Version 1 is confirmed. Publish it when you are ready for the patient to see it.')).toBeVisible();
    await expect(card(page)).toContainText('Confirmed, not published');
    await expect(card(page)).toContainText('Confirmed by Asha Admin');
    await expect(card(page).getByRole('button', { name: 'Publish to patient' })).toBeEnabled();
    await expect(card(page).getByRole('button', { name: 'Confirm amount and currency' })).toHaveCount(0);
    expect(calls(api, 'publish')).toHaveLength(0);
    await expect(card(page)).not.toContainText('Currently shown to the patient');
  });

  test('publishing warns that the patient is notified, then shows the version as the one the patient sees', async ({ page, context }) => {
    const api = await open(page, context, [version({ status: 'confirmed', revision: 4, confirmedAt: '2026-11-19T11:00:00.000Z', confirmedBy: { id: 7, name: 'Asha Admin' } })]);
    await card(page).getByRole('button', { name: 'Publish to patient' }).click();
    await expect(dialog(page)).toContainText('Publish this quotation to the patient?');
    await expect(dialog(page)).toContainText('they will be notified');
    await dialog(page).getByRole('button', { name: 'Publish', exact: true }).click();
    expect(calls(api, 'publish')).toEqual([{ kind: 'publish', id: 762, body: { revision: 4 } }]);
    await expect(page.getByText('Version 1 is published. The patient has been notified.')).toBeVisible();
    await expect(card(page)).toContainText('Currently shown to the patient');
    await expect(card(page)).toContainText('Published to the patient by Asha Admin');
    await expect(card(page).getByRole('button', { name: 'Publish to patient' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Withdraw' })).toBeEnabled();
  });

  test('cancelling a dialog sends nothing', async ({ page, context }) => {
    const api = await open(page, context, [version()]);
    await card(page).getByRole('button', { name: 'Confirm amount and currency' }).click();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(api.quotationCalls).toEqual([]);
    await expect(card(page)).toContainText('Draft');
  });

  test('a double click on the confirm button sends ONE request', async ({ page, context }) => {
    const api = await open(page, context, [version()], { quotationDelayMs: 400 });
    await card(page).getByRole('button', { name: 'Confirm amount and currency' }).click();
    const confirm = dialog(page).getByRole('button', { name: 'Confirm', exact: true });
    await confirm.dblclick({ force: true }).catch(() => undefined);
    await expect(dialog(page)).toHaveCount(0);
    expect(calls(api, 'confirm')).toHaveLength(1);
  });
});

test.describe('what cannot be confirmed or published', () => {
  test('a version whose scan is pending, or whose amount is missing, cannot be confirmed: the button is disabled and says why', async ({ page, context }) => {
    await open(page, context, [version({ scanStatus: 'pending', scanDetail: null, scannedAt: null, amount: null, currency: null, validationError: 'amount_missing' })]);
    const c = card(page);
    await expect(c.getByRole('button', { name: 'Confirm amount and currency' })).toBeDisabled();
    await expect(c).toContainText('The file has not been scanned for malware yet.');
    await expect(c).toContainText('missing or invalid in Bitrix24');
    await expect(c).toContainText('The Final Quotation Amount is empty in Bitrix24.');
    await expect(c).toContainText('Malware scan pending');
    await expect(c.getByRole('button', { name: 'View PDF' })).toBeDisabled(); // an unscanned file is never opened
    await expect(c.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  });

  test('an infected file is shown prominently and offers no way to open or confirm it', async ({ page, context }) => {
    await open(page, context, [version({ scanStatus: 'infected', scanDetail: 'infected: Eicar' })]);
    const c = card(page);
    await expect(c).toContainText('Malware detected');
    await expect(c).toContainText('It cannot be opened or confirmed.');
    await expect(c.getByRole('button', { name: 'Confirm amount and currency' })).toBeDisabled();
    await expect(c.getByRole('button', { name: 'View PDF' })).toBeDisabled();
  });

  test('a changed version (the server answers 409 quotation_changed) is reloaded with a clear message and nothing is confirmed', async ({ page, context }) => {
    const api = await open(page, context, [version()], { quotationResponses: { confirm: { status: 409, body: { error: 'changed', code: 'quotation_changed', currentRevision: 4 } } } });
    await card(page).getByRole('button', { name: 'Confirm amount and currency' }).click();
    await dialog(page).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText(/The quotation changed since you opened it/)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page)).toContainText('Draft');
    expect(calls(api, 'confirm')).toHaveLength(1);
  });

  test('a blocked action (409) explains itself and refreshes; a server failure keeps the dialog open to retry', async ({ page, context }) => {
    const api = await open(page, context, [version({ status: 'confirmed', revision: 4 })], { quotationResponses: { publish: { status: 500, body: { error: 'Internal server error' } } } });
    await card(page).getByRole('button', { name: 'Publish to patient' }).click();
    await dialog(page).getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(dialog(page)).toContainText('Internal server error');
    await expect(dialog(page)).toBeVisible();
    api.quotationResponses = { publish: { status: 409, body: { error: 'The quotation must be confirmed before it can be published.', code: 'quotation_not_confirmed' } } };
    await dialog(page).getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText(/must be confirmed before it can be published/)).toBeVisible();
  });
});

test.describe('withdraw', () => {
  test('needs a reason of at least 3 characters before it can be sent; the version then shows as withdrawn with who and why', async ({ page, context }) => {
    const api = await open(page, context, [version()]);
    await card(page).getByRole('button', { name: 'Withdraw' }).click();
    const confirm = dialog(page).getByRole('button', { name: 'Withdraw', exact: true });
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel(/Reason/).fill('no');
    await dialog(page).getByLabel(/Reason/).blur();
    await expect(dialog(page)).toContainText('Enter at least 3 characters.');
    await expect(confirm).toBeDisabled();
    await dialog(page).getByLabel(/Reason/).fill('Wrong amount quoted');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    expect(calls(api, 'withdraw')).toEqual([{ kind: 'withdraw', id: 762, body: { revision: 3, reason: 'Wrong amount quoted' } }]);
    await expect(card(page)).toContainText('Withdrawn');
    await expect(card(page)).toContainText('Withdrawn by Asha Admin');
    await expect(card(page)).toContainText('Wrong amount quoted');
    await expect(card(page).getByRole('button', { name: 'Confirm amount and currency' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  });

  test('withdrawing a published version says the patient will no longer see it', async ({ page, context }) => {
    await open(page, context, [version({ status: 'published', live: true, revision: 5, confirmedAt: '2026-11-19T11:00:00.000Z', confirmedBy: { id: 7, name: 'Asha Admin' }, publishedAt: '2026-11-19T12:00:00.000Z', publishedBy: { id: 7, name: 'Asha Admin' } })]);
    await card(page).getByRole('button', { name: 'Withdraw' }).click();
    await expect(dialog(page)).toContainText('The patient will no longer see this quotation.');
  });
});

test.describe('accepted and rejected versions are immutable', () => {
  const accepted = version({ id: 710, status: 'accepted', live: true, revision: 6, confirmedAt: '2026-11-10T09:00:00.000Z', confirmedBy: { id: 7, name: 'Asha Admin' }, publishedAt: '2026-11-10T10:00:00.000Z', publishedBy: { id: 7, name: 'Asha Admin' }, decidedAt: '2026-11-11T10:00:00.000Z' });

  test('an accepted version offers no confirm, publish or withdraw: only "Create new version"', async ({ page, context }) => {
    await open(page, context, [accepted]);
    const c = card(page);
    await expect(c).toContainText('Accepted by the patient');
    await expect(c).toContainText('Currently shown to the patient');
    await expect(c.getByRole('button', { name: 'Confirm amount and currency' })).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Publish to patient' })).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'Create new version' })).toBeEnabled();
  });

  test('creating a new version explains that a fresh acceptance is needed, then adds a new draft and leaves the accepted version alone', async ({ page, context }) => {
    const api = await open(page, context, [{ ...accepted }]);
    await card(page).getByRole('button', { name: 'Create new version' }).click();
    await expect(dialog(page)).toContainText('accept it again');
    await dialog(page).getByRole('button', { name: 'Create new version', exact: true }).click();
    expect(calls(api, 'new-version')).toEqual([{ kind: 'new-version', id: 710, body: { revision: 6 } }]);
    await expect(page.getByText('A new draft version was created from Version 1.')).toBeVisible();
    await expect(card(page, 2)).toContainText('Draft');
    await expect(card(page, 2)).toContainText('Malware scan pending');
    await expect(page.getByLabel('Quotation history')).toContainText('Accepted by the patient');
    await expect(page.getByLabel('Quotation history').getByRole('button')).toHaveCount(0); // the accepted version is untouched and offers nothing now
  });

  test('a rejected version cannot be withdrawn or published', async ({ page, context }) => {
    await open(page, context, [version({ id: 720, status: 'rejected', revision: 4, rejectionReason: 'Too high', decidedAt: '2026-11-11T10:00:00.000Z' })]);
    const c = card(page);
    await expect(c).toContainText('Rejected by the patient');
    await expect(c.getByRole('button', { name: /Confirm|Publish|Withdraw/ })).toHaveCount(0);
  });
});

test.describe('the PDF', () => {
  test('Download saves the file through the authenticated, audited call', async ({ page, context }) => {
    const api = await open(page, context, [version()]);
    const [download] = await Promise.all([page.waitForEvent('download'), card(page).getByRole('button', { name: 'Download PDF' }).click()]);
    expect(download.suggestedFilename()).toBe('CASE-1003-quotation-v1.pdf');
    expect(calls(api, 'file')).toHaveLength(1);
  });

  test('View PDF opens it in a separate tab from a blob, with no opener and no stored path in the address', async ({ page, context }) => {
    // Headless Chromium has no PDF viewer (a PDF tab becomes a download), so what is checked is the call the Portal makes.
    await page.addInitScript(() => { window.__opened = []; window.open = (...args) => { window.__opened.push(args); return null; }; });
    const api = await open(page, context, [version()]);
    await card(page).getByRole('button', { name: 'View PDF' }).click();
    await expect.poll(() => page.evaluate(() => window.__opened.length)).toBe(1);
    const [url, target, features] = await page.evaluate(() => window.__opened[0]);
    expect(url).toMatch(/^blob:/);
    expect(target).toBe('_blank');
    expect(features).toBe('noopener');
    expect(calls(api, 'file')).toHaveLength(1);
  });

  test('a refusal from the server is shown, never a broken download', async ({ page, context }) => {
    await open(page, context, [version()], { quotationResponses: { file: { status: 409, body: { error: 'The stored PDF is missing or no longer matches its checksum, so it cannot be opened.', code: 'file_unverified' } } } });
    await card(page).getByRole('button', { name: 'Download PDF' }).click();
    await expect(page.getByText(/no longer matches its checksum/)).toBeVisible();
  });
});
