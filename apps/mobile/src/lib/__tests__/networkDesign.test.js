/* global describe, test, expect, beforeEach, afterEach, jest, __dirname */
// The new network design: the connection banner (priority, "Back online" timing), the removed bottom message and its positioning code, the "could not load" and Can't Connect states, the splash
// during the session check, the notices that replace the toasts, the progress button, the upload list, the drafts card and sheet, plural forms, the theme tokens and the translations.
// Pure logic is run; the components are checked at the source level (they are not rendered here), like the app's other screen tests.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { NOTICE } = require('../../theme/colors');
const { BANNER, RESTORED_VISIBLE_MS, bannerKind, loadFailureView, hideToastForBanner } = require('../networkUi');
const { createBannerPresenter, OUTAGE_DELAY_MS } = require('../bannerPresenter');
const { cantConnectState, cantConnectView, CANT_CONNECT_TEXT } = require('../cantConnect');
const { splashDecision, startupDestination } = require('../splash');
const { pluralCategory, pluralText } = require('../plural');
const { translate } = require('../translate');

const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('the banner: which one shows', () => {
  test('offline beats servers unreachable beats slow; nothing when online', () => {
    expect(bannerKind({ status: 'offline' })).toBe('offline');
    expect(bannerKind({ status: 'serverDown' })).toBe('serverDown');
    expect(bannerKind({ status: 'slow' })).toBe('slow');
    expect(bannerKind({ status: 'online' })).toBeNull();
    // one status is the worst state at a time (lib/network.js), and a restoration never hides a problem
    expect(bannerKind({ status: 'offline', restoredVisible: true })).toBe('offline');
    expect(bannerKind({ status: 'serverDown', restoredVisible: true })).toBe('serverDown');
    expect(bannerKind({ status: 'slow', restoredVisible: true })).toBe('slow');
    expect(bannerKind({ status: 'online', restoredVisible: true })).toBe('restored');
  });
  test('each state has its own wording, icon and colours; Back online is a title only', () => {
    expect(BANNER.offline).toMatchObject({ titleKey: 'net_offline', textKey: 'net_offline_text', icon: 'wifiOff', tone: 'warning' });
    expect(BANNER.serverDown).toMatchObject({ titleKey: 'net_server_down', textKey: 'net_server_down_text', icon: 'cloudOff', tone: 'warning' });
    expect(BANNER.slow).toMatchObject({ titleKey: 'net_slow', textKey: 'net_slow_text', icon: 'signal', tone: 'slow' });
    expect(BANNER.restored).toMatchObject({ titleKey: 'net_restored', textKey: null, icon: 'wifi', tone: 'success' });
    expect(I18N.EN.net_offline).toBe('No internet connection');
    expect(I18N.EN.net_offline_text).toBe('Connect to the internet to continue.');
    expect(I18N.EN.net_server_down).toBe("We can't reach HumanCare servers");
    expect(I18N.EN.net_server_down_text).toBe('Please try again in a moment.');
    expect(I18N.EN.net_slow_text).toBe('Things may take a little longer to load.');
  });
  test('"Back online" hides by itself after 2.5 s, and is dropped if something is wrong again', () => {
    expect(RESTORED_VISIBLE_MS).toBe(2500);
    const p = createBannerPresenter();
    p.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    p.observe('online');
    expect(p.get()).toBe('restored');
    jest.advanceTimersByTime(2499);
    expect(p.get()).toBe('restored');
    jest.advanceTimersByTime(1);
    expect(p.get()).toBeNull();
    p.observe('offline');
    jest.advanceTimersByTime(OUTAGE_DELAY_MS);
    p.observe('online');
    p.observe('slow'); // something is wrong again: the pending "Back online" is dropped, not shown later
    expect(p.get()).toBe('slow');
    jest.advanceTimersByTime(5000);
    expect(p.get()).toBe('slow');
  });
});

describe('the banner: where it is and how it looks (source)', () => {
  const banner = read('components/network/ConnectionBanner.js');
  test('colours come from the theme tokens: warning, success, info and the quiet slow look', () => {
    expect(NOTICE.warning).toEqual({ bg: '#FDF0DA', border: '#F1D9AE', title: '#6B3A06', text: '#8F4C08' });
    expect(NOTICE.success).toEqual({ bg: '#E0F5F4', border: '#BFE8E4', text: '#0B6564' });
    expect(NOTICE.info).toMatchObject({ bg: '#EAEBF4', border: '#D6D9EE' });
    expect(NOTICE.slow).toEqual({ bg: '#EEF2FB', border: '#DCE3F5', title: '#0D2340', text: '#5B6B84' });
    expect(banner).toMatch(/NOTICE\[tone\]/);
    expect(banner).not.toMatch(/#FDF0DA|#6B3A06|#E0F5F4/); // no hand-written copy of a token
  });
  test('layout: 10/16 padding, a 1 px bottom border, a 32 px white tile (radius 10), title 14/19 weight 800, text 12.5/17', () => {
    expect(banner).toMatch(/paddingVertical: 10, paddingHorizontal: 16/);
    expect(banner).toMatch(/borderBottomWidth: 1, borderBottomColor: look\.border/);
    expect(banner).toMatch(/width: 32, height: 32, borderRadius: 10, backgroundColor: '#FFFFFF'/);
    expect(banner).toMatch(/Inter_800ExtraBold/);
    expect(banner).toMatch(/fontSize: 14, lineHeight: 19/);
    expect(banner).toMatch(/fontSize: 12\.5, lineHeight: 17/);
  });
  test('animates its height over 200 ms, and not at all with Reduce Motion', () => {
    expect(read('lib/bannerMotion.js')).toMatch(/BANNER_ENTER_MS = 220/);
    expect(banner).toMatch(/useReducedMotion\(\)/);
  });
  test('the shared headers mount it; the request form shows it under the step bar, not above it', () => {
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toMatch(/<TopBar title=\{t\('req_title'\)\} onBack=\{goBack\} banner=\{false\} \/>\s+<StepBar step=\{step\} \/>\s+<ConnectionBanner \/>/);
    expect(read('components/layout.js')).toMatch(/\{banner \? <ConnectionBanner \/> : null\}/);
  });
  test('the bottom message and its whole positioning system are gone', () => {
    for (const gone of ['components/NetworkBanner.js', 'lib/bottomBars.js']) expect(fs.existsSync(path.join(SRC, gone))).toBe(false);
    const all = ['app', 'components', 'lib', 'state'].flatMap(function walk(dir) {
      return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(`${dir}/${e.name}`)) : /\.js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
    });
    for (const file of all) expect({ file, text: read(file).match(/setBottomBar|clearBottomBar|bottomBarsHeight|subscribeBottomBars|messageBottom|NetworkBanner\b/) }).toEqual({ file, text: null });
  });
  test('the SOS button is back at its normal place: its position code never mentions the network', () => {
    expect(read('lib/sos.js')).not.toMatch(/bottomBars|ConnectionBanner|useNetwork/);
    expect(read('components/sos/SosFab.js')).not.toMatch(/useNetwork|ConnectionBanner|bottomBars/);
  });
});

describe('offline buttons and lists', () => {
  test('the request form says why the button is pale, only while offline', () => {
    const frame = read('components/request/RequestFrame.js');
    expect(frame).toContain('<Collapse show={!!(needsNetwork && isOffline)}>');
    expect(frame).toContain("t('net_submit_offline')");
    expect(I18N.EN.net_submit_offline).toBe('Connect to the internet to submit.');
  });
  test('document rows say "Opens when you\'re online" in their meta line and a tap does nothing (no toast)', () => {
    expect(I18N.EN.net_opens_online).toBe("Opens when you're online");
    expect(read('components/request/DetailsBlocks.js')).toContain("offline && doc.openable ? t('net_opens_online') : null");
    expect(read('components/documents/DocumentCard.js')).toContain("offline ? t('net_opens_online') : null");
    expect(read('app/request-details.js')).toContain('onOpen={() => { if (isOffline) return; openDocumentPreview(router.push, doc); }}');
    expect(read('app/my-documents.js')).toContain('const start = (doc) => { if (isOffline) return; openDocumentPreview(router.push, doc); };');
    expect(read('app/my-documents.js')).not.toMatch(/toast\(t\('net_/);
  });
  test('lists that show saved data offline say so once, under the list, and only offline', () => {
    expect(read('components/network/CachedNote.js')).toMatch(/if \(!isOffline\) return null;/);
    for (const file of ['app/my-requests.js', 'app/notifications.js', 'app/my-documents.js']) expect(read(file)).toContain('<CachedNote />');
    expect(I18N.EN.net_cached_note).toBe('Showing what was saved on this phone.');
  });
  test('a toast that only repeats the banner is not drawn while the banner is up', () => {
    expect(hideToastForBanner({ message: 'No internet connection. Connect to the internet to continue.', bannerVisible: true })).toBe(true);
    expect(hideToastForBanner({ message: 'Upload cancelled. Nothing was sent.', bannerVisible: true })).toBe(false);
  });
});

describe('a screen that could not load', () => {
  const net = (kind) => ({ isOffline: kind === 'offline', isServerDown: kind === 'server' });
  test('no internet: wifi-off icon and the screen\'s own title', () => {
    const v = loadFailureView({ error: Object.assign(new Error('x'), { code: 'network' }), net: net('offline'), screenTitleKey: 'lf_title_requests' });
    expect(v).toEqual({ reason: 'offline', icon: 'wifiOff', titleKey: 'lf_title_requests', bodyKey: 'net_load_offline' });
  });
  test('servers unreachable: cloud-off icon and "Can\'t reach HumanCare"', () => {
    const v = loadFailureView({ error: Object.assign(new Error('x'), { code: 'network' }), net: net('server'), screenTitleKey: 'lf_title_requests' });
    expect(v).toEqual({ reason: 'server', icon: 'cloudOff', titleKey: 'lf_title_server', bodyKey: 'net_load_server' });
    expect(loadFailureView({ error: Object.assign(new Error('x'), { status: 503 }), net: net('online'), screenTitleKey: 'lf_title_requests' }).titleKey).toBe('lf_title_server');
  });
  test('too slow: hourglass icon and "This is taking too long"', () => {
    const v = loadFailureView({ error: Object.assign(new Error('x'), { code: 'timeout' }), net: net('online'), screenTitleKey: 'lf_title_requests' });
    expect(v).toEqual({ reason: 'slow', icon: 'hourglass', titleKey: 'lf_title_slow', bodyKey: 'net_load_timeout' });
  });
  test('a refusal or a missing item keeps the screen\'s own title and text; a screen that names none gets the generic title', () => {
    const v = loadFailureView({ error: Object.assign(new Error('x'), { status: 404 }), net: net('online'), screenTitleKey: 'lf_title_request' });
    expect(v).toMatchObject({ reason: 'other', titleKey: 'lf_title_request', bodyKey: null });
    expect(loadFailureView({ error: null, net: net('online') }).titleKey).toBe('lf_title_generic');
  });
  test('one title per screen, in English', () => {
    expect(I18N.EN).toMatchObject({
      lf_title_requests: "Couldn't load your requests", lf_title_request: "Couldn't load this request", lf_title_tracking: "Couldn't load tracking", lf_title_documents: "Couldn't load your documents",
      lf_title_server: "Can't reach HumanCare", lf_title_slow: 'This is taking too long',
    });
    const screens = { 'app/my-requests.js': 'lf_title_requests', 'app/request-details.js': 'lf_title_request', 'app/request-tracking.js': 'lf_title_tracking', 'app/tracking.js': 'lf_title_tracking', 'app/my-documents.js': 'lf_title_documents', 'app/home.js': 'lf_title_home', 'app/notifications.js': 'lf_title_notifications', 'app/corporate-dashboard.js': 'lf_title_cases' };
    for (const [file, key] of Object.entries(screens)) expect(read(file)).toContain(`<LoadFailure titleKey="${key}"`);
  });
  test('the layout is shared with Can\'t Connect: circles, a "!" badge, a filled Try again with a refresh icon', () => {
    const view = read('components/network/StateView.js');
    expect(view).toMatch(/width: 128, height: 128, borderRadius: 64/);
    expect(view).toMatch(/width: 84, height: 84, borderRadius: 42/);
    expect(view).toMatch(/size=\{38\}/);
    expect(view).toMatch(/width: 30, height: 30, borderRadius: 15/);
    expect(view).toMatch(/fontSize: 22, lineHeight: 28/);
    expect(view).toMatch(/maxWidth: 300/);
    expect(view).toMatch(/<RefreshCw size=\{19\}/);
    expect(view).not.toMatch(/variant="outline"/); // a filled button now
    expect(read('components/LoadFailure.js')).toContain('<StateView');
    expect(read('app/cant-connect.js')).toContain('<StateView');
  });
});

describe("Can't Connect", () => {
  test('no internet, servers down and an unknown reason: the right icon and body, and the "saved session is safe" pill', () => {
    expect(cantConnectState({ authStatus: 'unreachable', net: { isOffline: true } })).toEqual({ reason: 'offline', icon: 'wifiOff', titleKey: 'cc_title', bodyKey: 'cc_body_offline', safePill: true });
    expect(cantConnectState({ authStatus: 'unreachable', net: { isServerDown: true } })).toEqual({ reason: 'server', icon: 'cloudOff', titleKey: 'cc_title', bodyKey: 'cc_body_server', safePill: true });
    expect(cantConnectState({ authStatus: 'unreachable', net: {} })).toEqual({ reason: 'generic', icon: 'cloudOff', titleKey: 'cc_title', bodyKey: 'cc_body_generic', safePill: true });
  });
  test('a phone storage problem: device icon, its own wording, and NO pill', () => {
    expect(cantConnectState({ authStatus: 'error', net: {} })).toEqual({ reason: 'storage', icon: 'device', titleKey: 'cc_storage_title', bodyKey: 'cc_storage_body', safePill: false });
  });
  test('the wording: the "safe" sentence moved out of the bodies into its own pill', () => {
    expect(I18N.EN.cc_body_offline).toBe('No internet connection. Connect to the internet and we will continue automatically.');
    expect(I18N.EN.cc_body_server).toBe("We can't reach HumanCare servers right now. We will continue automatically when they are back.");
    expect(I18N.EN.cc_body_generic).toBe('We could not check your saved session. We will continue automatically when the connection is back.');
    expect(I18N.EN.cc_safe).toBe('Your saved session is safe');
    for (const key of ['cc_body_offline', 'cc_body_server', 'cc_body_generic']) for (const lang of LANGS) expect(I18N[lang][key].split(/[.।]/).filter(Boolean)).toHaveLength(2);
    expect(CANT_CONNECT_TEXT.cc_safe).toBe(I18N.EN.cc_safe);
  });
  test('no logo, no SOS, no login link; the pill only for the safe states; Auto-continue is untouched', () => {
    const screen = read('app/cant-connect.js');
    expect(screen).not.toMatch(/LOGO|Image\b|SosModal|cc_login_other|router\.replace\('\/login'\)/);
    expect(screen).toContain("pill={state.safePill ? { icon: 'shield', text: text('cc_safe') } : null}");
    expect(screen).toMatch(/if \(view\.leaveTo && pathname === CANT_CONNECT_PATH\) navReplace\(view\.leaveTo\);/);
    expect(cantConnectView({ authStatus: 'authed' })).toEqual({ mode: 'leave', leaveTo: '/home' });
  });
});

describe('the session check shows the splash', () => {
  test('a saved session being checked keeps the splash for as long as the check runs (no Connecting screen)', () => {
    for (const [minElapsed, timedOut] of [[false, false], [true, false], [true, true]]) {
      expect(splashDecision({ status: 'loading', savedSession: true, minElapsed, timedOut })).toBeNull();
    }
  });
  test('Can\'t Connect appears only when the check FAILED; a person with no saved session still goes on at 4 s', () => {
    expect(splashDecision({ status: 'unreachable', savedSession: true, minElapsed: true })).toBe('/cant-connect');
    expect(startupDestination({ status: 'unreachable', savedSession: true })).toBe('/cant-connect');
    expect(splashDecision({ status: 'loading', savedSession: false, minElapsed: true, timedOut: true })).toBe('/welcome');
    expect(splashDecision({ status: 'authed', savedSession: true, minElapsed: true })).toBe('/home');
  });
});

describe('sending a request: notices, not toasts', () => {
  const review = read('app/request/review.js');
  test('a lost answer and an already-sent request set a notice above the button', () => {
    expect(review).toContain("if (isBlocked(err)) { setRetryable(true); setNotice(err.reason === 'already_sent' ? 'sent' : 'lost'); return; }");
    expect(review).toContain("if (outcome === 'edited') { setNotice('sent'); return; }");
    expect(review).toContain("{ setRetryable(true); setNotice('lost'); return; }");
    const catchBlock = review.slice(review.indexOf('} catch (err) {\n      setUploading(null);'), review.indexOf('// While files upload'));
    expect(catchBlock).not.toMatch(/net_try_again|net_already_sent/); // the two toasts are gone
    expect(review).toContain('setNotice(null);'); // cleared at the next press
  });
  test('the lost-answer card and the already-sent card say what the design says', () => {
    expect(review).toContain("<StatusNotice tone=\"warning\" icon=\"alert\" title={t('sub_lost_title')} text={t('sub_lost_text')} />");
    expect(review).toContain("<StatusNotice tone=\"info\" icon=\"info\" title={t('sub_sent_title')} text={t('sub_sent_text')}>");
    expect(review).toContain("router.push('/my-requests')");
    expect(I18N.EN).toMatchObject({
      sub_lost_title: "We couldn't confirm that this went through.", sub_lost_text: 'Please try again. We check first, so it is never sent twice.',
      sub_sent_title: 'Your request was already sent.', sub_sent_text: 'Please check My Requests before sending it again.', sub_open_requests: 'Open My Requests',
    });
  });
  test('the button reads Try again with a refresh icon after a lost answer; the send logic is untouched (guardedSend, the gate, the key)', () => {
    expect(review).toContain("retryable ? t('sk_try_again') : undefined");
    expect(review).toContain('refreshIcon={retryable}');
    expect(review).toMatch(/const guardedSend = async \(body\) => \{\s+const gate = await checkBeforeSend\(/);
    expect(review).toMatch(/postWithKey\(submissionTracker, apiPost, body, \{ service: serviceKey \}\)/);
  });
  test('while files upload the button is the progress bar: overall progress, base #5D66AD, fill #303A8F, disabled', () => {
    expect(review).toMatch(/const progress = uploading \? Math\.max\(0, Math\.min\(1, \(\(uploading\.index - 1\) \+ uploading\.progress\) \/ Math\.max\(1, uploading\.total\)\)\) : null;/);
    expect(read('components/request/RequestFrame.js')).toMatch(/progress !== null \? \(\s+<ProgressButton title=\{label \?\? t\(nextKey\)\} progress=\{progress\} \/>/);
    const button = read('components/network/ProgressButton.js');
    expect(button).toMatch(/BASE = '#5D66AD'/);
    expect(button).toMatch(/backgroundColor: COLORS\.primary/);
    expect(button).toMatch(/accessibilityState=\{\{ disabled: true, busy: true \}\}/);
    expect(button).not.toMatch(/onPress/);
    expect(I18N.EN.req_uploading).toBe('Uploading file {i} of {n}… {p}%');
  });
});

describe('uploads', () => {
  const list = read('components/request/UploadStatusList.js');
  test('the file list: tiles by type, one-line names, the four status looks, a 4 px progress bar', () => {
    expect(list).toMatch(/image \? '#E0F5F4' : COLORS\.primarySoft/);
    expect(list).toMatch(/color=\{image \? '#0B6564' : COLORS\.primary\}/);
    expect(list).toMatch(/numberOfLines=\{1\} ellipsizeMode="tail"/);
    expect(list).toContain('#1E7F45'); // Uploaded
    expect(list).toContain('#A3AEC2'); // Not sent yet: a grey dot
    expect(list).toContain('#B42828'); // refused
    expect(list).toMatch(/height: 4, borderRadius: 2, backgroundColor: '#E4E9F2'/);
    expect(list).toContain("trimStop(state.errors[file.uri])"); // "Unsupported file type" (the server's reason, without its full stop)
  });
  test('the submitted screen with a missing file: success circle, warning with the plural text, the list, Try again and Return home in the bar', () => {
    const screen = read('app/request/submitted.js');
    expect(screen).toContain("t('sub_received_title')");
    expect(screen).toContain("pluralText(t, lang, 'sub_docs_missing', missing.length)");
    expect(screen).toContain('<UploadStatusList files={draft.files}');
    expect(screen).toContain("t('sub_return_home')");
    expect(screen).toMatch(/width: 64, height: 64, borderRadius: 32, backgroundColor: '#E0F5F4'/);
  });
  test('after a restart: a warning with its own Try again, Upload switched off with a note, then an info notice if something is missing', () => {
    const notice = read('components/request/PendingUploadsNotice.js');
    expect(notice).toContain("title={t('up_restart_simple')} text={t('up_restart_text')}");
    expect(notice).toContain("<StatusNotice tone=\"info\" icon=\"info\" text={t('up_restart_missing')} />");
    expect(read('components/request/AdditionalDocuments.js')).toContain("t('up_available_after_check')");
    expect(read('components/request/AdditionalDocuments.js')).toContain('disabled={gated}');
    expect(I18N.EN).toMatchObject({ up_restart_simple: 'Your last upload may not have finished.', up_restart_text: 'Tap Try again so nothing is sent twice.', up_available_after_check: 'Available after the check.' });
  });
});

describe('plural forms', () => {
  test('English, Marathi, Telugu: one for 1; Hindi and Gujarati: one for 0 and 1; Arabic: one, two, few, many, other', () => {
    for (const lang of ['EN', 'MR', 'TE']) { expect(pluralCategory(lang, 1)).toBe('one'); expect(pluralCategory(lang, 0)).toBe('other'); expect(pluralCategory(lang, 2)).toBe('other'); }
    for (const lang of ['HI', 'GU']) { expect(pluralCategory(lang, 0)).toBe('one'); expect(pluralCategory(lang, 1)).toBe('one'); expect(pluralCategory(lang, 2)).toBe('other'); }
    expect([1, 2, 3, 10, 11, 99, 100, 102, 103].map((n) => pluralCategory('AR', n))).toEqual(['one', 'two', 'few', 'few', 'many', 'many', 'other', 'other', 'few']);
  });
  test('the missing-files text reads right for 1 and for many, in every language', () => {
    for (const lang of LANGS) {
      const t = (key, values) => translate(I18N, lang, key, values);
      expect(pluralText(t, lang, 'sub_docs_missing', 1)).not.toMatch(/\{n\}/);
      expect(pluralText(t, lang, 'sub_docs_missing', 4)).not.toMatch(/\{n\}/);
    }
    const en = (key, values) => translate(I18N, 'EN', key, values);
    expect(pluralText(en, 'EN', 'sub_docs_missing', 1)).toBe("1 file wasn't sent. Try again to finish.");
    expect(pluralText(en, 'EN', 'sub_docs_missing', 3)).toBe("3 files weren't sent. Try again to finish.");
  });
});

describe('saved drafts', () => {
  test('the Home card: a pencil tile, the label, the service, "Saved <date> · Nothing has been sent", Discard and Resume side by side at 46 px', () => {
    const card = read('components/home/DraftNotice.js');
    expect(card).toMatch(/width: 48, height: 48, borderRadius: 14/);
    expect(card).toContain('PencilLine');
    expect(card).toMatch(/textTransform: 'uppercase', color: NOTICE\.warning\.text/);
    expect(card).toContain("t('draft_card_meta', { date: formatDate(savedAt) })");
    expect(card).toMatch(/minHeight: 46/);
    expect(card).toMatch(/\{t\('draft_discard'\)\}[\s\S]*\{t\('draft_resume'\)\}|title=\{t\('draft_resume'\)\}/);
    expect(I18N.EN.draft_card_meta).toBe('Saved {{date}} · Nothing has been sent');
  });
  test('the sheet replaces the native alert and keeps the same three actions', () => {
    const service = read('app/service/[key].js');
    expect(service).not.toMatch(/Alert\.alert|\bAlert\b/);
    expect(service).toContain("if (!swapping && savedDraft) { setAsking(true); return; }");
    expect(service).toMatch(/onResume=\{\(\) => \{ setAsking\(false\); openSaved\(\); \}\}/); // Resume: open the saved draft
    expect(service).toMatch(/onStartNew=\{async \(\) => \{ setAsking\(false\); await discardDraft\(\); resetDraft\(key\); router\.push\('\/request\/step1'\); \}\}/); // Start new: discard, then a new request
    expect(service).toMatch(/onCancel=\{\(\) => setAsking\(false\)\}/); // Cancel: nothing
    const sheet = read('components/home/DraftSheet.js');
    expect(sheet).toContain('<Modal visible={visible} transparent animationType="slide"');
    expect(sheet).toMatch(/width: 40, height: 4/); // the drag handle
    expect(sheet).toMatch(/width: 64, height: 64, borderRadius: 32/);
    expect(sheet).toContain('#C53030');
    expect(sheet).toContain('#F1C7C7');
    for (const key of ['draft_prompt_title', 'draft_prompt_body', 'draft_resume', 'draft_start_new', 'pd_cancel']) expect(sheet).toContain(`t('${key}')`);
  });
});

describe('translations', () => {
  const NEW_KEYS = [
    'net_offline_text', 'net_server_down_text', 'net_slow_text', 'net_submit_offline', 'net_opens_online', 'net_cached_note',
    'lf_title_requests', 'lf_title_request', 'lf_title_tracking', 'lf_title_documents', 'lf_title_home', 'lf_title_notifications', 'lf_title_cases', 'lf_title_generic', 'lf_title_server', 'lf_title_slow',
    'cc_safe', 'sub_lost_title', 'sub_lost_text', 'sub_sent_title', 'sub_sent_text', 'sub_open_requests', 'sub_received_title', 'sub_request_ref', 'sub_docs_missing_title',
    'sub_docs_missing_one', 'sub_docs_missing_two', 'sub_docs_missing_few', 'sub_docs_missing_many', 'sub_docs_missing_other', 'sub_return_home',
    'up_restart_text', 'up_available_after_check', 'up_docs_count', 'draft_card_meta',
  ];
  test('every new string exists in all six languages, and the five others are not copies of the English', () => {
    expect(NEW_KEYS).toHaveLength(35);
    for (const lang of LANGS) for (const key of NEW_KEYS) {
      expect({ lang, key, ok: typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0 }).toEqual({ lang, key, ok: true });
      if (lang !== 'EN' && !/^sub_docs_missing_(two|few|many)$/.test(key) && key !== 'sub_request_ref') expect({ lang, key, copy: I18N[lang][key] === I18N.EN[key] }).toEqual({ lang, key, copy: false });
    }
  });
  test('placeholders survive translation', () => {
    for (const lang of LANGS) {
      expect(I18N[lang].sub_request_ref).toContain('{{id}}');
      expect(I18N[lang].draft_card_meta).toContain('{{date}}');
      expect(I18N[lang].up_docs_count).toContain('{{n}}');
      for (const f of ['one']) expect(I18N[lang][`sub_docs_missing_${f}`]).not.toContain('{p}');
      for (const f of ['other', 'few', 'many']) expect(I18N[lang][`sub_docs_missing_${f}`]).toContain('{{n}}');
    }
  });
  test('the existing keys the new text was split from are all still there', () => {
    for (const key of ['net_action_offline', 'net_load_offline', 'net_load_server', 'net_load_timeout', 'net_try_again', 'net_already_sent', 'cc_connecting_title', 'cc_connecting_body', 'btn_return_home']) {
      for (const lang of LANGS) expect(typeof I18N[lang][key]).toBe('string');
    }
  });
  test('the translation table for a native-speaker check exists and lists every new or changed string', () => {
    const table = fs.readFileSync(path.join(SRC, '..', '..', '..', 'docs', 'network-design-refs', 'translations.md'), 'utf8');
    for (const key of NEW_KEYS) expect(table).toContain(`\`${key}\``);
    for (const key of ['cc_body_offline', 'cc_body_server', 'cc_body_generic']) expect(table).toContain(`\`${key}\``);
  });
  test('Arabic: the layout mirrors (the app sets direction from the language; the banner and notices use row layouts and no left/right)', () => {
    expect(read('app/_layout.js')).toMatch(/direction: isRTL \? 'rtl' : 'ltr'/);
    for (const file of ['components/network/ConnectionBanner.js', 'components/network/StatusNotice.js', 'components/network/StateView.js', 'components/network/ProgressButton.js']) {
      expect({ file, physical: read(file).match(/\b(left|right|marginLeft|marginRight|paddingLeft|paddingRight):/g) }).toEqual({ file, physical: null });
    }
  });
});
