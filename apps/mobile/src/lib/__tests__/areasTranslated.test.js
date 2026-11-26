/* global describe, test, expect, __dirname */
// Service Detail pages, country names and dropdowns, Stretcher / Wheelchair options, Notifications, About HumanCare, Privacy Policy and Terms: all of their text goes through t() and is
// translated in the six languages (English, Hindi, Marathi, Gujarati, Telugu, Arabic).
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const SERVICES = require('../../data/services.json');
const COUNTRY_NAMES = require('../../data/countryNames.json');
const { COUNTRIES } = require('../../data/countryList');
const { COUNTRY_NAME_BY_ISO } = require('../../data/countries');
const { translate } = require('../translate');
const { ABOUT_INTRO } = require('../../data/aboutContent');
const { localizedServiceContent, STAT_LABEL_KEYS, STAT_VALUE_KEYS } = require('../serviceText');
const C = require('../countryNames');
const { nameOf } = require('../phoneCountry');

const CODES = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const OTHERS = CODES.filter((c) => c !== 'EN');
const SRC = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').split('\r\n').join('\n');
const tFor = (lang) => (key, values) => translate(I18N, lang, key, values);

describe('Service Detail pages', () => {
  const needsWords = (v) => /[a-z]/.test(v);
  test('the English dictionary holds exactly the text of data/services.json (title, description, every feature, stat labels and wordy values)', () => {
    for (const [key, svc] of Object.entries(SERVICES)) {
      expect(I18N.EN[`sd_${key}_title`]).toBe(svc.title);
      expect(I18N.EN[`sd_${key}_desc`]).toBe(svc.desc);
      svc.features.forEach((f, i) => expect(I18N.EN[`sd_${key}_f${i + 1}`]).toBe(f));
      expect(Object.keys(I18N.EN).filter((k) => new RegExp(`^sd_${key}_f\\d+$`).test(k))).toHaveLength(svc.features.length);
      for (const s of svc.stats) {
        expect(I18N.EN[STAT_LABEL_KEYS[s.label]]).toBe(s.label);
        if (needsWords(s.value)) expect(I18N.EN[STAT_VALUE_KEYS[s.value]]).toBe(s.value);
      }
    }
  });
  test.each(OTHERS)('%s: every service is shown in the language: title, description, features and figures', (lang) => {
    const t = tFor(lang);
    for (const [key, svc] of Object.entries(SERVICES)) {
      const content = localizedServiceContent(svc, key, t);
      expect(content.title).not.toBe(svc.title);
      expect(content.desc).not.toBe(svc.desc);
      content.features.forEach((f, i) => expect(f).not.toBe(svc.features[i]));
      expect(content.stats).toHaveLength(svc.stats.length);
      content.stats.forEach((s, i) => {
        expect(s.label).not.toBe(svc.stats[i].label);
        if (needsWords(svc.stats[i].value)) expect(s.value).not.toBe(svc.stats[i].value);
        else expect(s.value).toBe(svc.stats[i].value); // a number stays a number
      });
    }
  });
  test('English shows the bundled text unchanged', () => {
    const t = tFor('EN');
    for (const [key, svc] of Object.entries(SERVICES)) expect(localizedServiceContent(svc, key, t)).toEqual({ title: svc.title, desc: svc.desc, features: svc.features, stats: svc.stats });
  });
  test('a missing translation falls back to the English text (never a key)', () => {
    const t = (key) => key; // a dictionary with nothing
    const air = localizedServiceContent(SERVICES.air, 'air', t);
    expect(air.title).toBe(SERVICES.air.title);
    expect(air.features).toEqual(SERVICES.air.features);
  });
  test('every label and wordy value of every service has a key', () => {
    for (const svc of Object.values(SERVICES)) for (const s of svc.stats) { expect(STAT_LABEL_KEYS[s.label]).toBeTruthy(); if (needsWords(s.value)) expect(STAT_VALUE_KEYS[s.value]).toBeTruthy(); }
  });
  test('the screen uses it; the service names that are SENT with a request are untouched', () => {
    const page = read('app/service/[key].js');
    expect(page).toContain("import { localizedServiceContent } from '../../lib/serviceText';");
    expect(page).toContain("lang === 'EN' ? detailContent(local, live, key) : detailContent(content, null, key)");
    expect(page).toContain('{content.stats.map((st) => (');
    expect(SERVICES.privatecharter.title).toBe('Private Charter Air Ambulance Service'); // sent as the serviceType: not translated in the data file
  });
});

describe('country names and the Select Country dropdowns', () => {
  test.each(OTHERS)('%s: every country in the list has a name in the language, and it is not the English one', (lang) => {
    const missing = COUNTRIES.filter((c) => !COUNTRY_NAMES[lang][c.code]).map((c) => c.code);
    expect(missing).toEqual([]);
    const sameAsEnglish = COUNTRIES.filter((c) => COUNTRY_NAMES[lang][c.code] === c.name && /[A-Za-z]/.test(c.name) && !/^(India|Chad)$/.test(c.name)).map((c) => c.code);
    expect(sameAsEnglish).toEqual([]);
  });
  test.each(OTHERS)('%s: the corporate form\'s country names (data/countries.js) have names too', (lang) => {
    expect(Object.keys(COUNTRY_NAME_BY_ISO).filter((iso) => !COUNTRY_NAMES[lang][iso])).toEqual([]);
  });
  test('the names are written in each language\'s script', () => {
    const script = { HI: /[ऀ-ॿ]/, MR: /[ऀ-ॿ]/, GU: /[઀-૿]/, TE: /[ఀ-౿]/, AR: /[؀-ۿ]/ };
    for (const lang of OTHERS) for (const [iso, name] of Object.entries(COUNTRY_NAMES[lang])) expect({ lang, iso, ok: script[lang].test(name) }).toEqual({ lang, iso, ok: true });
  });
  test('what is shown is localized; what is stored and sent stays English', () => {
    expect(C.countryName('IN', 'HI')).toBe(COUNTRY_NAMES.HI.IN);
    expect(C.countryName('IN', 'EN')).toBe('');
    expect(C.countryDisplay('IN', 'India', 'AR')).toBe(COUNTRY_NAMES.AR.IN);
    expect(C.countryDisplay('IN', 'India', 'EN')).toBe('India');
    expect(C.countryDisplay('', 'Somewhere', 'HI')).toBe('Somewhere');
    expect(C.countryDisplay('', '', 'HI')).toBe('');
    expect(nameOf('IN')).toBe('India'); // the value that is saved and sent
    expect(nameOf('GB')).toBe('United Kingdom');
  });
  test('the language in force decides (AppContext tells countryNames when the language changes)', () => {
    C.setCountryLanguage('HI');
    expect(C.displayNameOf('IN')).toBe(COUNTRY_NAMES.HI.IN);
    C.setCountryLanguage('EN');
    expect(C.displayNameOf('IN')).toBe('India');
    const app = read('state/AppContext.js');
    expect(app.match(/setCountryLanguage\(code\);/g)).toHaveLength(2); // at start and on every change
  });
  test('the list can be searched in the language, and in English too; digits still search dial codes', () => {
    const codes = (list) => list.map((c) => c.code);
    expect(codes(C.searchCountriesLocalized(COUNTRY_NAMES.HI.IN, 'HI'))).toContain('IN');
    expect(codes(C.searchCountriesLocalized(COUNTRY_NAMES.AR.AE.slice(0, 4), 'AR'))).toContain('AE');
    expect(codes(C.searchCountriesLocalized('germ', 'HI'))).toContain('DE'); // English still works
    expect(codes(C.searchCountriesLocalized('+971', 'AR'))).toContain('AE');
    expect(codes(C.searchCountriesLocalized('germ', 'EN'))).toContain('DE');
  });
  test('with nothing typed the whole list shows: India first, then in the language\'s order', () => {
    for (const lang of CODES) {
      const list = C.searchCountriesLocalized('', lang);
      expect(list).toHaveLength(COUNTRIES.length);
      expect(list[0].code).toBe('IN');
      expect(new Set(list.map((c) => c.code)).size).toBe(COUNTRIES.length);
    }
  });
  test('the corporate form shows the names in the language but keeps the English value', () => {
    const labels = C.countryLabelsByEnglishName('HI');
    expect(labels[COUNTRY_NAME_BY_ISO.IN]).toBe(COUNTRY_NAMES.HI.IN);
    expect(C.countryLabelsByEnglishName('EN')).toEqual({});
    expect(read('app/corporate-new-case.js')).toContain('labels={countryLabelsByEnglishName()} keepSize');
  });
  test('no screen shows an English country name or a bare "Select country"', () => {
    for (const file of ['components/NationalityPhone.js', 'app/personal-details.js', 'app/request/step1.js', 'components/request/HomeStep1.js', 'components/request/MarineStep1.js', 'components/request/MortalStep1.js', 'components/request/CorporateStep1.js']) {
      const text = read(file);
      expect(text).not.toContain("'Select country'");
      expect(text).not.toMatch(/\{item\.name\}/);
    }
    expect(read('components/NationalityPhone.js')).toContain('{displayNameOf(item.code)}</Text>');
    expect(read('components/NationalityPhone.js')).toContain('searchCountriesLocalized(query)');
    for (const lang of CODES) expect(translate(I18N, lang, 'ph_select_country')).toBeTruthy();
  });
});

describe('Stretcher and Wheelchair', () => {
  test('the Travel type chips read in the language; the stored values are unchanged', () => {
    const step2 = read('app/request/step2.js');
    expect(step2).toContain('options={AIRLINE_MODES.map((key) => ({ value: key, label: t(`rd_travel_${key}`) }))}');
    for (const lang of OTHERS) {
      expect(I18N[lang].rd_travel_stretcher).not.toBe('Stretcher');
      expect(I18N[lang].rd_travel_wheelchair).not.toBe('Wheelchair');
    }
    expect(I18N.EN.rd_travel_stretcher).toBe('Stretcher');
    expect(I18N.EN.rd_travel_wheelchair).toBe('Wheelchair');
    const { AIRLINE_MODES } = require('../../data/mock');
    expect(AIRLINE_MODES).toEqual(['stretcher', 'wheelchair']);
  });
  test('the Medical Escort service text that mentions them is translated', () => {
    for (const lang of OTHERS) {
      expect(I18N[lang].sd_commercialair_f1).not.toBe(I18N.EN.sd_commercialair_f1);
      expect(I18N[lang].sd_commercialair_desc).not.toBe(I18N.EN.sd_commercialair_desc);
    }
  });
});

describe('Notifications', () => {
  test('its words exist, translated, in every language', () => {
    for (const key of ['notifications_title', 'notif_empty', 'notif_unread', 'alerts_today', 'alerts_yesterday', 'sk_loading_notifications', 'lf_title_notifications', 'btn_return_home']) {
      for (const lang of OTHERS) expect({ key, lang, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ key, lang, same: false });
    }
  });
  test('the screen has no English literal: the empty state, the "Unread" spoken label and the titles come from t()', () => {
    const screen = read('app/notifications.js');
    expect(screen).toContain("t('notif_empty')");
    expect(screen).toContain("t('notif_unread')");
    expect(screen).not.toContain("'Unread. '");
  });
});

describe('About HumanCare', () => {
  test('the English dictionary text is exactly the approved text (including its wording)', () => {
    ABOUT_INTRO.paragraphs.forEach((p, i) => expect(I18N.EN[`about_p${i + 1}`]).toBe(p));
    expect(Object.keys(I18N.EN).filter((k) => /^about_p\d+$/.test(k))).toHaveLength(ABOUT_INTRO.paragraphs.length);
  });
  test.each(OTHERS)('%s: every paragraph is translated and keep the figures (2004, 24×7, 3,500, 11,000+, 150)', (lang) => {
    ABOUT_INTRO.paragraphs.forEach((_, i) => {
      const text = I18N[lang][`about_p${i + 1}`];
      expect(text).not.toBe(I18N.EN[`about_p${i + 1}`]);
      for (const figure of ['2004', '24×7', '3,500', '11,000+', '150'].filter((f) => I18N.EN[`about_p${i + 1}`].includes(f))) expect({ lang, i, figure, kept: text.includes(figure) }).toEqual({ lang, i, figure, kept: true });
    });
  });
  test('the page draws the translated text', () => {
    const screen = read('app/about.js');
    expect(screen).not.toContain('about_name'); // no company name heading on the page
    expect(screen).toContain('{t(`about_p${i + 1}`)}');
  });
});

describe('Privacy Policy and Terms & Conditions', () => {
  const SECTION_KEYS = [];
  for (const page of ['terms', 'privacy']) { for (let i = 1; i <= 7; i += 1) SECTION_KEYS.push(`${page}_s${i}_h`, `${page}_s${i}_b`); SECTION_KEYS.push(`${page}_s8_b`); }
  test('every section heading and paragraph exists in all six languages, translated', () => {
    for (const key of [...SECTION_KEYS, 'legal_contact_h', 'legal_last_updated', 'terms_title', 'privacy_title']) {
      expect(typeof I18N.EN[key]).toBe('string');
      for (const lang of OTHERS) expect({ key, lang, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ key, lang, same: false });
    }
  });
  test('the English text is the approved original', () => {
    expect(I18N.EN.terms_s1_b).toBe('By creating an account or using the Humancare World Wide app, you agree to be bound by these Terms & Conditions. If you do not agree, please do not use the platform.');
    expect(I18N.EN.terms_s3_b).toBe('This app is not a replacement for local emergency services. In a life-threatening emergency, contact your local emergency number immediately in addition to using this app.');
    expect(I18N.EN.privacy_s2_b).toContain('We do not sell your personal data to third parties.');
    expect(I18N.EN.legal_last_updated).toBe('Last updated: 1 January 2026');
  });
  test('the pages draw only keys; the screen translates them; the ops e-mail stays an address', () => {
    for (const page of ['terms', 'privacy']) {
      const source = read(`app/${page}.js`);
      expect(source).not.toMatch(/'[A-Z][a-z]+ [A-Za-z ,.'-]{8,}'/); // no English sentence in the file
      expect(source.match(/\['[a-z0-9_]+', '[a-z0-9_]+'\]/g)).toHaveLength(8);
    }
    const legal = read('components/LegalScreen.js');
    expect(legal).toContain('{`${i + 1}. ${t(headingKey)}\\n`}');
    expect(legal).toContain('{t(bodyKey)}</Text>');
    expect(legal).toContain("{t('legal_last_updated')}"); // Terms and Privacy both turn it off (showUpdated={false})
    expect(read('app/privacy.js')).toContain('showUpdated={false}');
    expect(read('app/terms.js')).toContain('showUpdated={false}');
    expect(legal).toContain("email = 'ops@humancareworldwide.com'"); // Terms keeps the ops address
    expect(legal).toContain('{`${email}.`}');
    expect(read('app/privacy.js')).toContain('email="support@humancareworldwide.com"'); // the Privacy Policy shows the support address
    expect(read('app/terms.js')).not.toContain('email=');
  });
  test('the contact line ends with a space, so the address follows it in every language', () => {
    for (const lang of CODES) for (const key of ['terms_s8_b', 'privacy_s8_b']) expect(I18N[lang][key].endsWith(' ')).toBe(true);
  });
  test('Arabic reads right to left (the screen\'s direction) and keeps the Latin address and OTP intact', () => {
    expect(I18N.AR.privacy_s2_b).toContain('رمز التحقق');
    expect(read('app/_layout.js')).toContain("direction: isRTL ? 'rtl' : 'ltr'");
  });
});
