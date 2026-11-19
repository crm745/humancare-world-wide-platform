/* global describe, test, expect, __dirname */
// The patient's quotation card and how it is wired into Request Details, plus its six-language strings. (This project's Jest runs in node with no native
// renderer, so the screen is checked the way the other screens are: what it renders, what it sends and what it refuses to do.)
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const section = read('../../components/request/QuotationSection.js');
const hook = read('../../lib/useQuotation.js');
const details = read('../../app/request-details.js');
const i18n = JSON.parse(read('../../data/i18n.json'));

const USED_KEYS = [...new Set([...section.matchAll(/t\('(quotation_[a-z_]+)'\)/g)].map((m) => m[1]))];
const STATE_KEYS = ['available', 'accepted', 'rejected', 'expired', 'unavailable'].map((k) => `quotation_status_${k}`); // built with a template in the card
const ERROR_KEYS = [...read('../quotationView.js').matchAll(/'(quotation_(?:err|reason)_[a-z]+)'/g)].map((m) => m[1]);
const ALL_KEYS = [...new Set([...USED_KEYS, ...STATE_KEYS, ...ERROR_KEYS, 'quotation_title', 'quotation_done_already', 'quotation_downloading'])];

describe('strings', () => {
  test('every quotation string the card, the states and the errors use exists as non-empty text in EN, HI, MR, GU, TE and AR', () => {
    expect(ALL_KEYS.length).toBeGreaterThan(30);
    for (const code of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of ALL_KEYS) {
        expect(typeof i18n[code][key]).toBe('string');
        expect(i18n[code][key].length).toBeGreaterThan(0);
      }
    }
  });

  test('the strings with a value in them keep every placeholder in every language', () => {
    const needs = { quotation_version: ['{n}'], quotation_accept_body: ['{n}', '{amount}'], quotation_reject_confirm_body: ['{n}', '{amount}'], quotation_accepted_msg: ['{date}'], quotation_rejected_msg: ['{n}'] };
    for (const code of ['EN', 'HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const [key, holes] of Object.entries(needs)) for (const hole of holes) expect(i18n[code][key]).toContain(hole);
    }
  });

  test('no language shows the server\'s English or a raw code: every error key is ours', () => {
    for (const key of ERROR_KEYS) expect(i18n.EN[key]).not.toMatch(/quotation_|_/);
  });
});

describe('the card', () => {
  test('renders nothing when the server says there is no quotation feature for this request', () => {
    expect(section).toContain("if (q.status === 'hidden') return null;");
  });

  test('shows loading, an error with Try again, an empty state, the quotation, the accepted / rejected / expired / unavailable states', () => {
    for (const needle of ["q.status === 'loading'", "q.status === 'error'", "kind === 'none'", "kind === 'rejected'", "kind === 'accepted'", "kind === 'expired'", "kind === 'unavailable'", "kind === 'available'", "t('quotation_empty')", "t('quotation_load_failed')", "t('quotation_retry')", "t('quotation_expired_msg')", "t('quotation_unavailable_msg')"]) {
      expect(section).toContain(needle);
    }
  });

  test('shows the version, the amount with its currency and the validity date when there is one', () => {
    expect(section).toContain("fill(t('quotation_version'), { n: quotation.versionNumber })");
    expect(section).toContain('quotationAmount(quotation || lastDecision)');
    expect(section).toContain("t('quotation_amount')");
    expect(section).toContain("!!quotation.validUntil && <InfoRow");
    expect(section).toContain("t('quotation_valid_until')");
  });

  test('Accept and Reject are offered ONLY while the server says the quotation can be decided (never expired, accepted, rejected or closed)', () => {
    const buttons = section.slice(section.indexOf("{kind === 'available' && ("), section.indexOf("{kind === 'available' && (") + 600);
    expect(buttons).toContain("t('quotation_reject')");
    expect(buttons).toContain("t('quotation_accept')");
    expect(section.match(/t\('quotation_accept'\)/g)).toHaveLength(1);
    expect(section.match(/t\('quotation_reject'\)/g)).toHaveLength(1);
    expect(section).toContain("{quotation && kind === 'available' && (");
  });

  test('accepting asks first, showing the version and the amount, and submits the exact quotation shown', () => {
    expect(section).toContain("visible={sheet === 'accept'}");
    expect(section).toContain("fill(t('quotation_accept_body'), { n: quotation.versionNumber, amount })");
    expect(section).toContain("onPress={() => openSheet('accept')}");
    expect(section).toContain('q.accept(quotation)');
    expect(hook).toContain("decide('accept', q)");
  });

  test('rejecting needs a reason (validated before it can continue), then asks again before the final action', () => {
    expect(section).toContain("visible={sheet === 'reject'}");
    expect(section).toContain("visible={sheet === 'rejectConfirm'}");
    expect(section).toContain('validateRejectionReason(reason)');
    expect(section).toContain("if (reasonCheck.ok) openSheet('rejectConfirm')");
    expect(section).toContain("error={touched && !reasonCheck.ok ? t(reasonCheck.key) : undefined}");
    expect(section).toContain('maxLength={REASON_MAX}');
    expect(section).toContain("fill(t('quotation_reject_confirm_body'), { n: quotation.versionNumber, amount })");
    expect(section).toContain('q.reject(quotation, check.value)');
    // the final reject button is only in the confirmation sheet, and it re-checks the reason
    expect(section).toContain("if (!check.ok) { setSheet('reject'); setTouched(true); return; }");
  });

  test('a decision cannot be sent twice: the buttons are disabled while it runs and the hook guards it', () => {
    expect(section).toContain('loading={q.busy} disabled={q.busy} onPress={accept}');
    expect(section).toContain('loading={q.busy} disabled={q.busy} onPress={reject}');
    expect(section).toContain('const closeSheet = () => { if (q.busy) return;');
    expect(hook).toContain('guard.current.run(`decide:${quotation.id}`');
    expect(hook).toContain('guard.current.run(`file:${quotation.id}`');
  });

  test('after a decision the card shows what the SERVER now holds (it reloads), and a stale answer closes the sheet with our message', () => {
    expect(hook).toContain('if (outcome.ok || outcome.stale) await reload();');
    expect(section).toContain('else if (outcome.stale) {');
    expect(section).toContain("toast(t(outcome.key))");
    expect(section).toContain("t(outcome.already ? 'quotation_done_already' : doneKey)");
  });

  test('the PDF is opened only through the authenticated download, never a link, and only when the server says a file is available', () => {
    expect(section).toContain('quotation.fileAvailable && (');
    expect(section).toContain('q.download(quotation, request.referenceNumber)');
    expect(section).not.toMatch(/Linking|openURL|WebBrowser|https?:|storageKey|sha256/);
    expect(hook).not.toMatch(/Linking|openURL|https?:/);
  });

  test('uses the app\'s own components and strings: Card, Button, InfoRow, Sheet, Field, the toast; no hard-coded sentence', () => {
    for (const needle of ["from '../ui'", "from '../widgets'", 'useApp()']) expect(section).toContain(needle);
    expect(section).not.toMatch(/>\s*(Accept|Reject|Quotation|Cancel|Continue)\s*</);
  });

  test('refreshes when the screen is focused again (not on first focus)', () => {
    expect(section).toContain('useFocusEffect');
    expect(section).toContain('first.current');
  });

  test('creates no invoice, payment or Bitrix / Razorpay call', () => {
    for (const source of [section, hook, read('../quotations.js'), read('../quotationView.js')]) {
      expect(source).not.toMatch(/invoice|payment|razorpay|bitrix|Checkout|openAuthSession/i);
    }
  });
});

describe('Request Details', () => {
  test('shows the quotation for Private Charter requests only, next to the invoices, and still refreshes on focus', () => {
    expect(details).toContain("import QuotationSection from '../components/request/QuotationSection';");
    expect(details).toContain("{request.serviceKey === 'privatecharter' && <QuotationSection request={request} onChanged={reload} />}");
    expect(details.indexOf('<QuotationSection')).toBeLessThan(details.indexOf('<InvoicesSection'));
    expect(details).toContain('useFocusEffect');
  });

  test('the existing sections and navigation are untouched', () => {
    for (const needle of ['<InvoicesSection request={request} onChanged={reload} />', '<DocumentHistory request={request} />', '<AdditionalDocuments request={request} onUploaded={reload} />', "router.push({ pathname: '/request-tracking'"]) {
      expect(details).toContain(needle);
    }
  });
});
