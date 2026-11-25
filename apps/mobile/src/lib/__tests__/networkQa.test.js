/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// Final QA of the new network UI: the startup is bounded, the placeholders of the upload progress and count texts are filled in every language, the sheet's drag rule, and the accessibility wiring.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { translate } = require('../translate');
const { checkSession, TOKEN_TIMEOUT_MS, ME_TIMEOUT_MS } = require('../sessionCheck');
const { splashDecision, MIN_SPLASH_MS } = require('../splash');
const { shouldDismissSheet, sheetOffset, DRAG_DISMISS_DISTANCE } = require('../sheetDrag');
const { pluralText } = require('../plural');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

describe('the startup session check is bounded and ends in Can\'t Connect', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  test('a server that never answers: the check ends as "unreachable" within its limits, never hangs', async () => {
    const neverAnswers = () => new Promise(() => {});
    const done = checkSession({ getToken: async () => 'saved-token', fetchMe: neverAnswers });
    let result = null;
    done.then((r) => { result = r; });
    await jest.advanceTimersByTimeAsync(ME_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS + 1);
    expect(result).toEqual({ status: 'unreachable' });
    expect(ME_TIMEOUT_MS + 2 * TOKEN_TIMEOUT_MS).toBeLessThanOrEqual(30000); // the longest the splash can wait for a saved session
  });
  test('a token store that never answers ends as a storage error (also bounded)', async () => {
    const done = checkSession({ getToken: () => new Promise(() => {}), fetchMe: async () => ({}) });
    let result = null;
    done.then((r) => { result = r; });
    await jest.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS + 1);
    expect(result).toEqual({ status: 'error' });
  });
  test('the splash keeps showing until the check ends, then goes to Can\'t Connect (failure) or Home / Login (answer)', () => {
    const at = (status) => splashDecision({ status, savedSession: true, minElapsed: true, timedOut: true });
    expect(at('loading')).toBeNull();
    expect(at('unreachable')).toBe('/cant-connect');
    expect(at('authed')).toBe('/home');
    expect(at('anon')).toBe('/welcome');
    expect(MIN_SPLASH_MS).toBe(3000);
  });
  test('Can\'t Connect always offers Try again, and Try again runs the check again', () => {
    const screen = read('app/cant-connect.js');
    expect(screen).toContain('onRetry={retryAuth}');
    expect(screen).toContain("retryLabel={text('cc_try_again')}");
    expect(read('state/AppContext.js')).toMatch(/retryAuth/);
    expect(read('lib/authState.js')).toMatch(/retry\(\) \{\s+set\('loading'\);\s+return store\.validate\(\);/);
  });
});

describe('placeholders are filled in every language', () => {
  test('req_uploading has {i}, {n} and {p}, and filling them leaves no braces', () => {
    for (const lang of LANGS) {
      const text = I18N[lang].req_uploading;
      for (const token of ['{i}', '{n}', '{p}']) expect({ lang, token, has: text.includes(token) }).toEqual({ lang, token, has: true });
      const filled = text.replace('{i}', 2).replace('{n}', 3).replace('{p}', 62);
      expect(filled).not.toMatch(/[{}]/);
      expect(filled).toMatch(/62/);
    }
  });
  test('up_state_sending has {p} in every language', () => {
    for (const lang of LANGS) {
      expect(I18N[lang].up_state_sending).toContain('{p}');
      expect(I18N[lang].up_state_sending.replace('{p}', '62')).not.toMatch(/[{}]/);
    }
  });
  test('the count and name texts fill {{n}}, {{id}} and {{date}} (no braces left) in every language', () => {
    for (const lang of LANGS) {
      const t = (key, values) => translate(I18N, lang, key, values);
      for (const n of [0, 1, 2, 3, 5, 11, 100]) {
        const text = pluralText(t, lang, 'sub_docs_missing', n);
        expect({ lang, n, braces: /[{}]/.test(text) }).toEqual({ lang, n, braces: false });
      }
      expect(t('up_docs_count', { n: 4 })).toMatch(/4/);
      expect(t('up_docs_count', { n: 4 })).not.toMatch(/[{}]/);
      expect(t('sub_request_ref', { id: 'REQ-1042' })).toContain('REQ-1042');
      expect(t('draft_card_meta', { date: '20 Nov 2026' })).toContain('20 Nov 2026');
      expect(t('draft_card_meta', { date: '20 Nov 2026' })).not.toMatch(/[{}]/);
    }
  });
  test('every call that fills a placeholder uses the syntax its string has (t() fills {{x}}; .replace fills {x})', () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(`${dir}/${e.name}`); } else if (/\.js$/.test(e.name)) files.push(`${dir}/${e.name}`);
      }
    }('app'));
    for (const dir of ['components', 'state', 'lib']) {
      (function walk(d) {
        for (const e of fs.readdirSync(path.join(SRC, d), { withFileTypes: true })) {
          if (e.isDirectory()) { if (e.name !== '__tests__') walk(`${d}/${e.name}`); } else if (/\.js$/.test(e.name)) files.push(`${d}/${e.name}`);
        }
      }(dir));
    }
    const problems = [];
    for (const file of files) {
      const src = read(file);
      for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\{/g)) {
        for (const lang of LANGS) {
          const text = I18N[lang][m[1]] ?? I18N.EN[m[1]];
          if (typeof text !== 'string') { problems.push(`${file}: ${m[1]} missing`); break; }
          if (/(^|[^{])\{[A-Za-z]+\}([^}]|$)/.test(text)) problems.push(`${file}: t('${m[1]}', {...}) but ${lang} uses single braces`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe('the draft sheet drag rule', () => {
  test('a long drag or a fast flick closes it; a short slow drag springs back; it only follows downwards', () => {
    expect(shouldDismissSheet({ dy: DRAG_DISMISS_DISTANCE, vy: 0 })).toBe(true);
    expect(shouldDismissSheet({ dy: 168, vy: 0 })).toBe(true);
    expect(shouldDismissSheet({ dy: 48, vy: 0.2 })).toBe(false);
    expect(shouldDismissSheet({ dy: 30, vy: 1.2 })).toBe(true); // a flick
    expect(shouldDismissSheet({ dy: 5, vy: 3 })).toBe(false); // a tap with a jitter is not a flick
    expect(shouldDismissSheet({ dy: -120, vy: -2 })).toBe(false); // upwards never closes
    expect(sheetOffset(-40)).toBe(0);
    expect(sheetOffset(40)).toBe(40);
    expect(sheetOffset(NaN)).toBe(0);
  });
  test('the sheet wires the rule and keeps its three actions; the backdrop is not a second Cancel for a screen reader', () => {
    const sheet = read('components/home/DraftSheet.js');
    expect(sheet).toContain('shouldDismissSheet({ dy: g.dy, vy: g.vy })');
    expect(sheet).toContain('<Pressable accessible={false} importantForAccessibility="no" onPress={onCancel}');
    expect(sheet).toContain('onRequestClose={onCancel}'); // the Android back button
    for (const handler of ['onResume', 'onStartNew', 'onCancel']) expect(sheet).toContain(`onPress={${handler}}`);
  });
});

describe('accessibility wiring', () => {
  test('the banner is one polite live region; the bar inside it is not a second alert; its icon is hidden', () => {
    const banner = read('components/network/ConnectionBanner.js');
    expect((banner.match(/accessibilityLiveRegion="polite"/g) || []).length).toBe(1);
    expect(banner).not.toMatch(/accessibilityRole="alert"/);
    expect(banner).toMatch(/aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"/);
    expect(banner).toMatch(/Platform\.OS === 'ios'/); // iOS has no live regions: it is announced once per change instead
    expect(banner).toMatch(/announced\.current === kind/);
  });
  test('every shared button says it is a button, and a disabled one says why', () => {
    const ui = read('components/ui.js');
    expect(ui).toMatch(/<AnimatedPressBox\s+accessibilityRole="button"/);
    expect(ui).toContain("accessibilityHint={blocked && app ? app.t('net_action_offline') : undefined}");
  });
  test('icons are hidden from screen readers in every new component', () => {
    for (const file of ['components/network/StatusNotice.js', 'components/network/StateView.js', 'components/home/DraftNotice.js', 'components/home/DraftSheet.js']) {
      expect({ file, ok: /aria-hidden accessibilityElementsHidden/.test(read(file)) }).toEqual({ file, ok: true });
    }
  });
  test('a file row is one item for a screen reader (name, then status); offline document rows are disabled and say why', () => {
    expect(read('components/request/UploadStatusList.js')).toContain('accessibilityLabel={`${row.file.name}, ${statusText(row, state, progress, t)}`}');
    expect(read('components/request/DetailsBlocks.js')).toContain('accessibilityState={{ disabled: offline }}');
    expect(read('components/documents/DocumentCard.js')).toContain('disabled: downloading || offline');
  });
  test('the progress button is a progressbar with a value; headings are headings', () => {
    const progress = read('components/network/ProgressButton.js');
    expect(progress).toContain('accessibilityRole="progressbar"');
    expect(progress).toContain('accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}');
    expect(read('components/network/StateView.js')).toContain('accessibilityRole="header"');
    expect(read('components/home/DraftSheet.js')).toContain('accessibilityRole="header"');
  });
  test('touch targets are at least 44 px: text buttons, links, Discard / Resume, the notice Try again', () => {
    expect(read('components/network/TextButton.js')).toContain('minHeight: 48');
    expect(read('components/home/DraftNotice.js')).toContain('minHeight: 46');
    expect(read('components/request/PendingUploadsNotice.js')).toContain('min-h-[44px]');
    expect(read('app/request/review.js')).toContain('minHeight: 44');
  });
});

describe('what must keep working', () => {
  test('idempotency, the encrypted vault, upload recovery and scan protection files are untouched by the network UI', () => {
    for (const file of ['lib/submissionKey.js', 'lib/submissionGate.js', 'lib/unresolvedSubmissionVault.js', 'lib/requestSubmission.js', 'lib/uploadRecovery.js', 'lib/uploadJournal.js']) {
      expect({ file, ui: /StatusNotice|ConnectionBanner|StateView|DraftSheet/.test(read(file)) }).toEqual({ file, ui: false });
    }
    const review = read('app/request/review.js');
    expect(review).toMatch(/const guardedSend = async \(body\) => \{\s+const gate = await checkBeforeSend\(/);
    expect(review).toContain('postWithKey(submissionTracker, apiPost, body, { service: serviceKey })');
    expect(review).toContain('journal: uploadJournal');
  });
});
