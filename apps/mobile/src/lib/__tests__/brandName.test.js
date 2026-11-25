/* global describe, test, expect, __dirname */
// The company name that patients see is exactly "Humancare World Wide" (Latin script). No other spelling of it may be visible: not in the six language files, not in the app's visible English literals,
// not in the app's name or its permission texts. The Hindi, Marathi, Gujarati, Telugu and Arabic files use the same Latin spelling (checked at the end of this file).
// Technical identifiers (humancareworldwide.com, ops@..., com.humancareworldwide.app, storage keys) are lowercase and are not the visible name.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const ABOUT = require('../../data/aboutContent');

const NAME = 'Humancare World Wide';
const root = path.join(__dirname, '..', '..', '..');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
// A wrong spelling: HumanCare / Humancare not followed by " World Wide", the one-word "Worldwide", "World wide", "Human Care", or the shouting wordmark.
const WRONG = /Human[Cc]are(?! World Wide)|Human[Cc]are World ?[Ww]ide(?<!Humancare World Wide)|Humancare Worldwide|Human Care|HUMANCARE|HumanCare/;

describe('every language file', () => {
  test.each(LANGS)('%s: no visible text spells the company name any other way', (lang) => {
    const wrong = Object.entries(I18N[lang]).filter(([, text]) => typeof text === 'string' && WRONG.test(text.replace(/humancareworldwide\.com/gi, ''))).map(([key]) => key);
    expect(wrong).toEqual([]);
  });
  test('the English texts that name the company use the exact name', () => {
    expect(I18N.EN.prof_footer).toBe(`${NAME} · Version {v}`);
    expect(I18N.EN.splash_tagline).toBe(`Excellence in Saving Lives\nThrough ${NAME}`);
    expect(I18N.EN.net_server_down).toBe(`We can't reach ${NAME} servers`);
    expect(I18N.EN.gs_logo_label).toBe(NAME);
    expect(I18N.EN.terms_s1_b).toContain(`using the ${NAME} app`);
  });
  test('the translations are kept: a non-English text still differs from the English one and still has the same placeholders', () => {
    for (const lang of LANGS.filter((l) => l !== 'EN')) {
      for (const key of ['prof_about', 'net_server_down', 'choose_login_title', 'docs_err_unverified']) {
        expect({ lang, key, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ lang, key, same: false });
      }
      expect(I18N[lang].prof_footer).toContain('{v}');
    }
  });
});

describe('the visible literals outside the language files', () => {
  test('About: the introduction names the company exactly', () => { expect(ABOUT.ABOUT_INTRO.paragraphs[0]).toContain(NAME); });
  test('the app name and its camera / photos permission texts', () => {
    const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
    expect(app.name).toBe(NAME);
    expect(app.slug).toBe('humancare-worldwide'); // technical: unchanged
    expect(app.android.package).toBe('com.humancareworldwide.app'); // technical: unchanged
    const picker = app.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-image-picker')[1];
    for (const text of [picker.cameraPermission, picker.photosPermission]) { expect(text.startsWith(NAME)).toBe(true); expect(WRONG.test(text)).toBe(false); }
  });
  test('the Can\'t Connect fallback text and the browser boot page', () => {
    expect(fs.readFileSync(path.join(root, 'src', 'lib', 'cantConnect.js'), 'utf8')).toContain(`We can't reach ${NAME} servers right now.`);
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    expect(html).toContain(`aria-label="${NAME}"`);
    expect(html).toContain(`Through ${NAME}</div>`);
  });
});

// The company name is written in Latin script as `Humancare World Wide` in every language: no Hindi, Marathi, Gujarati, Telugu or Arabic transliteration.
describe('the company name in the five other languages', () => {
  const I18N = require('../../data/i18n.json');
  const TRANSLITERATION = {
    HI: /ह्यूमनकेयर/, MR: /ह्यूमनकेअर/, GU: /હ્યુમનકેર/, TE: /హ్యూమన్\u200c?కేర్/, AR: /هيومان كير/,
  };
  test.each(Object.keys(TRANSLITERATION))('%s keeps the Latin spelling and has no transliteration', (lang) => {
    expect(Object.entries(I18N[lang]).filter(([, v]) => TRANSLITERATION[lang].test(v)).map(([k]) => k)).toEqual([]);
    expect(I18N[lang].about_p1).toContain('Humancare World Wide');
    expect(I18N[lang].faq_q2).toContain('Humancare World Wide');
  });
});
