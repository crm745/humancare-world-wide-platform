/* global describe, test, expect, __dirname */
// The My Documents screen, its card, and that the other download users and the shared DocRow are as they were.
const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const screen = read('../../app/my-documents.js');
const card = read('../../components/documents/DocumentCard.js');
const widgets = read('../../components/widgets.js');
const i18n = JSON.parse(read('../../data/i18n.json'));

const KEYS = ['docs_search_ph', 'docs_empty_title', 'docs_empty_sub', 'docs_no_match', 'docs_clear_search', 'docs_load_failed',
  'docs_try_again', 'docs_download', 'docs_downloading', 'docs_downloaded', 'docs_tap_retry', 'docs_err_session', 'docs_err_missing', 'docs_err_blocked',
  'docs_err_network', 'docs_err_share', 'docs_err_generic', 'docs_err_unverified', 'docs_err_denied'];

describe('the My Documents screen', () => {
  test('still loads from the same endpoint (the API contract is unchanged)', () => {
    expect(screen.match(/apiGet\(/g)).toHaveLength(1);
    expect(screen).toContain("apiGet('/requests/me/documents')");
    expect(screen).toContain('`/documents/${doc.id}/file`');
  });
  test('uses the dedicated card and the new download, not the shared DocRow or downloadAndShare', () => {
    expect(screen).toContain("from '../components/documents/DocumentCard'");
    expect(screen).toContain("import { downloadDocument, downloadErrorInfo } from '../lib/download'");
    expect(screen).not.toMatch(/DocRow|downloadAndShare/);
  });
  test('shared TopBar and Body; a count, a search, a retry, an empty state and a no-match state', () => {
    expect(screen).toContain("<TopBar title={t('my_documents')} />");
    expect(screen).toContain('countLabel(shown.length, docs.length)');
    expect(screen).toContain('filterDocuments(docs, query)');
    expect(screen).toContain("onPress={retry}");
    expect(screen).toContain("t('docs_empty_title')");
    expect(screen).toContain("t('docs_no_match')");
    expect(screen).toContain("t('docs_clear_search')");
  });
  test('a download in progress cannot be started twice (the guard is in documentsAccessibility.test.js); a failure is shown on the card and as a toast', () => {
    expect(screen).toContain('guard.current.run(doc.id, async () => {');
    expect(screen).toContain("{ status: 'error', message }");
    expect(screen).toContain('toast(message)');
  });
  test('the date is never presented as an upload date', () => {
    expect(card).toContain('documentDate(doc.uploadedAt)');
    for (const lang of Object.keys(i18n)) expect(i18n[lang].docs_added_to_case).toBeUndefined(); // no caption at all
    expect(card).not.toMatch(new RegExp('Added to case|Uploaded\\b', 'i')); // the words, not the field name uploadedAt
    expect(card).not.toMatch(/new Date\(\)|Date\.now/); // never the device's date
  });
  test('official brand blue from the palette, with no hard-coded app blue', () => {
    expect(card).toContain("from '../../lib/tracking/palette'");
    expect(card + screen).not.toMatch(/#1A73E8/i);
  });
  test('the card is an accessible 44-point button with a label', () => {
    expect(card).toContain('accessibilityRole="button"');
    expect(card).toContain('accessibilityLabel={documentAccessibilityLabel(doc, state, t)}');
    expect(card).toContain('h-11 w-11');
  });
});

describe('translations', () => {
  test('every new label exists in all six languages', () => {
    expect(Object.keys(i18n)).toHaveLength(6);
    for (const lang of Object.keys(i18n)) for (const key of KEYS) expect(i18n[lang][key]).toBeTruthy();
  });
  test('the templates keep their placeholders in every language', () => {
    for (const lang of Object.keys(i18n)) {
      expect(i18n[lang].docs_downloaded).toContain('{name}');
    }
  });
  test('the error messages of Group 1 are translated in every language, not copies of English', () => {
    for (const lang of ['HI', 'MR', 'GU', 'TE', 'AR']) {
      for (const key of ['docs_err_unverified', 'docs_err_denied', 'docs_err_share']) expect(i18n[lang][key]).not.toBe(i18n.EN[key]);
    }
  });
  test('the sharing message no longer claims the file was saved (the temporary copy is removed)', () => {
    expect(i18n.EN.docs_err_share).not.toMatch(/saved/i);
    expect(i18n.EN.docs_err_share).toContain('could not be opened');
  });
  test('the unverified-document message sends the person to HumanCare, in every language', () => {
    for (const lang of Object.keys(i18n)) expect(i18n[lang].docs_err_unverified).toContain('HumanCare');
  });
  test('English is the default and the others are translated', () => {
    expect(i18n.EN.docs_empty_title).toBe('No documents yet');
    expect(i18n.HI.docs_empty_title).not.toBe(i18n.EN.docs_empty_title);
    expect(i18n.AR.docs_empty_title).not.toBe(i18n.EN.docs_empty_title);
  });
});

describe('what was left alone', () => {
  test('the shared DocRow is exactly as it was', () => {
    const doc = widgets.slice(widgets.indexOf('export function DocRow'), widgets.indexOf('export function Toast'));
    expect(doc).toContain("export function DocRow({ label, meta, onPress, className = '' }) {");
    expect(doc).toContain('<FileText size={16} color="#D64545" />');
    expect(doc).toContain('<Download size={15} color="#1A73E8" />');
    expect(doc).toContain('className={`mb-2.5 flex-row items-center gap-2.5 rounded-[14px] border border-line bg-white p-3 active:opacity-80 ${className}`}');
  });
  test('the corporate tracking page still uses DocRow and downloadAndShare', () => {
    const tracking = read('../../app/tracking.js');
    expect(tracking).toContain("import { DocRow } from '../components/widgets'");
    expect(tracking).toContain("import { downloadAndShare } from '../lib/download'");
    expect(tracking).toMatch(/downloadAndShare\(`\/documents\/\$\{d\.id\}\/file`, d\.name\)/);
  });
  test('Request Details still downloads its summary with downloadAndShare', () => {
    const details = read('../../app/request-details.js');
    expect(details).toContain("import { downloadAndShare } from '../lib/download'");
    expect(details).toMatch(/downloadAndShare\(`\/requests\/me\/\$\{request\.id\}\/summary`/);
  });
  test('no backend, session or guard file was touched by this feature (their markers are intact)', () => {
    const session = read('../session.js');
    expect(session).toContain('export async function compareAndClearTokens');
    expect(read('../api.js')).toContain('export async function apiUpload');
  });
});
