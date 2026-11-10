// Reading old stored values: gender, care level, country, contact number. Pure functions, no database.
const fs = require('fs');
const path = require('path');
const {
  normalizeGender, normalizeCareLevel, normalizeCountry, normalizePhone,
} = require('../src/common/utils/legacy-normalize');
const { COUNTRIES } = require('../src/common/constants/countries');
const { CARE_LEVEL_KEYS, CARE_LEVEL_LEGACY_LABELS } = require('../src/common/constants/request.constants');

const I18N = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'mobile', 'src', 'data', 'i18n.json'), 'utf8'));
const LANGUAGES = Object.keys(I18N);

describe('care-level translations (the six app languages)', () => {
  it('the app ships exactly the six expected languages', () => {
    expect([...LANGUAGES].sort()).toEqual(['AR', 'EN', 'GU', 'HI', 'MR', 'TE']);
  });

  it('every language defines a label for every care-level key', () => {
    for (const lang of LANGUAGES) {
      for (const key of CARE_LEVEL_KEYS) {
        expect(typeof I18N[lang][key]).toBe('string');
        expect(I18N[lang][key].trim()).not.toBe('');
      }
    }
  });

  it('every label of every language is read back to its key, alone', () => {
    for (const lang of LANGUAGES) {
      for (const key of CARE_LEVEL_KEYS) {
        expect(normalizeCareLevel(I18N[lang][key])).toEqual({ status: 'normalize', value: key });
      }
    }
  });

  it('a label list in any one language, joined the way the app joined it, becomes the keys', () => {
    for (const lang of LANGUAGES) {
      const labels = ['care_icu', 'care_stable'].map((key) => I18N[lang][key]).join(', ');
      expect(normalizeCareLevel(labels)).toEqual({ status: 'normalize', value: 'care_icu,care_stable' });
    }
  });

  it('a list that mixes languages is still read (an old build, then a language change)', () => {
    expect(normalizeCareLevel(`${I18N.HI.care_icu}, ${I18N.AR.care_ambulatory}`)).toEqual({ status: 'normalize', value: 'care_icu,care_ambulatory' });
  });

  it('no label contains a comma, so splitting on commas cannot cut a label in two', () => {
    for (const lang of LANGUAGES) for (const key of CARE_LEVEL_KEYS) expect(I18N[lang][key]).not.toContain(',');
  });

  it('the backend table has no label the app does not ship, and none is missing', () => {
    const shipped = new Set(LANGUAGES.flatMap((lang) => CARE_LEVEL_KEYS.map((key) => `${key}|${I18N[lang][key].normalize('NFC')}`)));
    const table = new Set(Object.entries(CARE_LEVEL_LEGACY_LABELS).flatMap(([key, labels]) => labels.map((l) => `${key}|${l.normalize('NFC')}`)));
    expect(table).toEqual(shipped);
  });

  it('Hindi and Marathi share the label "ICU / गंभीर": it still maps to one key', () => {
    expect(I18N.HI.care_icu).toBe(I18N.MR.care_icu);
    expect(normalizeCareLevel(I18N.MR.care_icu)).toEqual({ status: 'normalize', value: 'care_icu' });
  });

  it('no two different keys share a label in any language (a label could not be ambiguous)', () => {
    for (const lang of LANGUAGES) {
      expect(new Set(CARE_LEVEL_KEYS.map((key) => I18N[lang][key])).size).toBe(CARE_LEVEL_KEYS.length);
    }
  });
});

describe('care-level formats', () => {
  it('leaves the stored format alone', () => {
    expect(normalizeCareLevel('care_icu')).toEqual({ status: 'unchanged' });
    expect(normalizeCareLevel('care_icu,care_stable')).toEqual({ status: 'unchanged' });
  });

  it('rewrites the corporate portal "care_icu, care_stable" to the stored format', () => {
    expect(normalizeCareLevel('care_icu, care_stable')).toEqual({ status: 'normalize', value: 'care_icu,care_stable' });
  });

  it('removes a repeated value (nothing is lost) and keeps the first-seen order', () => {
    expect(normalizeCareLevel('care_stable, care_icu, care_stable')).toEqual({ status: 'normalize', value: 'care_stable,care_icu' });
  });

  it('reads accents and combining marks regardless of Unicode form', () => {
    const decomposed = 'स्थिर / निगरानी में'.normalize('NFD');
    expect(normalizeCareLevel(decomposed)).toEqual({ status: 'normalize', value: 'care_stable' });
  });

  it.each([
    ['unknown value', 'care_icu, care_unknown'],
    ['free text', 'Patient needs oxygen'],
    ['uppercase key', 'CARE_ICU'],
    ['label with a typo', 'ICU / Critcal'],
    ['empty item', 'care_icu,,care_stable'],
  ])('sends %s to manual review without rewriting', (_name, value) => {
    expect(normalizeCareLevel(value)).toEqual({ status: 'review', reason: 'care_level_unrecognised_value' });
  });

  it('sends "Not Applicable" combined with another level to review (the intent is unknowable)', () => {
    expect(normalizeCareLevel('care_na, care_icu')).toEqual({ status: 'review', reason: 'care_level_not_applicable_combined' });
    expect(normalizeCareLevel(`${I18N.EN.care_na}, ${I18N.EN.care_icu}`)).toEqual({ status: 'review', reason: 'care_level_not_applicable_combined' });
  });

  it('reports empty and non-text values', () => {
    expect(normalizeCareLevel(null)).toEqual({ status: 'empty' });
    expect(normalizeCareLevel('  ')).toEqual({ status: 'empty' });
    expect(normalizeCareLevel(['care_icu'])).toEqual({ status: 'review', reason: 'care_level_not_text' });
  });
});

describe('gender', () => {
  it.each([['male'], ['female'], ['other']])('leaves "%s"', (value) => {
    expect(normalizeGender(value)).toEqual({ status: 'unchanged' });
  });
  it.each([['Male', 'male'], ['Female', 'female'], ['Other', 'other'], [' FEMALE ', 'female']])('rewrites "%s"', (value, expected) => {
    expect(normalizeGender(value)).toEqual({ status: 'normalize', value: expected });
  });
  it.each([['M'], ['prefer_not_to_say'], ['non-binary'], ['Mâle']])('sends "%s" to review (never guessed)', (value) => {
    expect(normalizeGender(value)).toEqual({ status: 'review', reason: 'gender_unrecognised' });
  });
  it('reports empty', () => {
    expect(normalizeGender(null)).toEqual({ status: 'empty' });
    expect(normalizeGender('')).toEqual({ status: 'empty' });
  });
});

describe('country', () => {
  it('reads the English name of every country the app lists', () => {
    for (const { code, name } of COUNTRIES) expect(normalizeCountry(name)).toEqual({ status: 'normalize', value: code });
  });
  it('leaves an ISO code, and uppercases a lowercase one', () => {
    expect(normalizeCountry('AE')).toEqual({ status: 'unchanged' });
    expect(normalizeCountry('ae')).toEqual({ status: 'normalize', value: 'AE' });
  });
  it('reads spelling variants that have one reading', () => {
    expect(normalizeCountry('USA')).toEqual({ status: 'normalize', value: 'US' });
    expect(normalizeCountry('united arab emirates')).toEqual({ status: 'normalize', value: 'AE' });
    expect(normalizeCountry('Antigua and Barbuda')).toEqual({ status: 'normalize', value: 'AG' });
    expect(normalizeCountry('Turkey')).toEqual({ status: 'normalize', value: 'TR' });
    expect(normalizeCountry('Côte d\'Ivoire')).toEqual({ status: 'normalize', value: 'CI' });
  });
  it.each([['Korea'], ['Congo'], ['Atlantis'], ['XX'], ['Dubai'], ['India, Maharashtra']])('sends "%s" to review', (value) => {
    expect(normalizeCountry(value)).toEqual({ status: 'review', reason: 'country_unrecognised' });
  });
  it('reports empty', () => {
    expect(normalizeCountry(undefined)).toEqual({ status: 'empty' });
  });
});

describe('contact number', () => {
  it('leaves E.164', () => {
    expect(normalizePhone('+971501234567')).toEqual({ status: 'unchanged' });
  });
  it.each([
    ['+971 501234567', '+971501234567'],
    ['+91 98765 43210', '+919876543210'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['  +44 20 7946 0958 ', '+442079460958'],
  ])('rewrites "%s" (same number, one format)', (value, expected) => {
    expect(normalizePhone(value)).toEqual({ status: 'normalize', value: expected });
  });
  it('sends a number without "+" to review: the country cannot be assumed', () => {
    expect(normalizePhone('9876543210')).toEqual({ status: 'review', reason: 'phone_without_country_code' });
    expect(normalizePhone('0501234567')).toEqual({ status: 'review', reason: 'phone_without_country_code' });
  });
  it('sends an impossible number to review', () => {
    expect(normalizePhone('+971 12')).toEqual({ status: 'review', reason: 'phone_invalid' });
    expect(normalizePhone('+999 123456789')).toEqual({ status: 'review', reason: 'phone_invalid' });
    expect(normalizePhone('call me')).toEqual({ status: 'review', reason: 'phone_without_country_code' });
  });
  it('reports empty', () => {
    expect(normalizePhone(null)).toEqual({ status: 'empty' });
  });
});

describe('the reasons never carry the value', () => {
  it('a review result holds a status and a reason code, nothing else', () => {
    for (const result of [normalizeGender('Zephyrina'), normalizeCareLevel('Zephyrina'), normalizeCountry('Zephyrina'), normalizePhone('Zephyrina')]) {
      expect(Object.keys(result).sort()).toEqual(['reason', 'status']);
      expect(JSON.stringify(result)).not.toContain('Zephyrina');
    }
  });
});
