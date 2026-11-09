// How a stored care level reads in the PDF summary and the Bitrix lead comment, and the helper
// behind both. A machine key must never be printed raw; anything the helper does not know for
// certain must come out exactly as it went in. No database needed.
const fs = require('fs');
const path = require('path');
const { careLevelText } = require('../src/common/utils/care-level');
const { renderPdfLines, valueAfter } = require('./helpers/pdf-text');
const { leadInputFromRequest } = require('../src/modules/bitrix/bitrix-lead');
const { CARE_LEVEL_KEYS, CARE_LEVEL_LABEL_EN } = require('../src/common/constants/request.constants');

const I18N = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'mobile', 'src', 'data', 'i18n.json'), 'utf8'));
const LANGUAGES = Object.keys(I18N);

describe('English labels', () => {
  it('match the English strings of the mobile app, for every key', () => {
    expect(Object.keys(CARE_LEVEL_LABEL_EN).sort()).toEqual([...CARE_LEVEL_KEYS].sort());
    for (const key of CARE_LEVEL_KEYS) expect(CARE_LEVEL_LABEL_EN[key]).toBe(I18N.EN[key]);
  });
});

describe('careLevelText: keys', () => {
  it('reads every key', () => {
    for (const key of CARE_LEVEL_KEYS) expect(careLevelText(key)).toBe(CARE_LEVEL_LABEL_EN[key]);
  });
  it('reads the stored list and the corporate "care_icu, care_stable" the same way', () => {
    expect(careLevelText('care_icu,care_stable')).toBe('ICU / Critical, Stable / Monitored');
    expect(careLevelText('care_icu, care_stable')).toBe('ICU / Critical, Stable / Monitored');
    expect(careLevelText('care_na')).toBe('Not Applicable');
  });
  it('never leaves a care_ key in a value made only of keys', () => {
    expect(careLevelText('care_icu,care_stable,care_ambulatory')).not.toMatch(/care_/);
  });
});

describe('careLevelText: values it must not change', () => {
  const UNTOUCHED = [
    'Patient needs oxygen, ventilator; call Dr. Rao', 'care_unknown', 'CARE_ICU', 'needs care_icu bed', 'care_icu.',
    'care_icu;care_stable', ',,', ' ', 'ICU / Critcal', 'a,b,,c, ', '  leading and trailing  ', 'Basic', 'काफ़ी गंभीर, ऑक्सीजन',
  ];
  it.each(UNTOUCHED.map((v) => [JSON.stringify(v), v]))('leaves %s exactly as it is', (_label, text) => {
    expect(careLevelText(text)).toBe(text);
    expect(careLevelText(text, { translateLegacy: true })).toBe(text);
  });

  it('translates only the keys in a mixed value, keeping spacing and punctuation', () => {
    expect(careLevelText('care_icu,  Oxygen needed ,care_na')).toBe('ICU / Critical,  Oxygen needed ,Not Applicable');
    expect(careLevelText(' care_icu ,x')).toBe(' ICU / Critical ,x');
    expect(careLevelText('care_icu, ventilator, "see note"; care_stable')).toBe('ICU / Critical, ventilator, "see note"; care_stable');
  });

  it('returns null, undefined, empty and non-text values as they are', () => {
    expect(careLevelText(null)).toBeNull();
    expect(careLevelText(undefined)).toBeUndefined();
    expect(careLevelText('')).toBe('');
    expect(careLevelText(42)).toBe(42);
  });
});

describe('careLevelText: older translated labels (all six languages)', () => {
  it('are left as stored by default (the Bitrix comment keeps what was sent)', () => {
    for (const lang of LANGUAGES) {
      const stored = `${I18N[lang].care_icu}, ${I18N[lang].care_stable}`;
      expect(careLevelText(stored)).toBe(stored);
    }
  });

  it.each(LANGUAGES)('become English labels when translateLegacy is on, in %s', (lang) => {
    for (const key of CARE_LEVEL_KEYS) {
      expect(careLevelText(I18N[lang][key], { translateLegacy: true })).toBe(CARE_LEVEL_LABEL_EN[key]);
    }
    const stored = `${I18N[lang].care_icu}, ${I18N[lang].care_ambulatory}`;
    expect(careLevelText(stored, { translateLegacy: true })).toBe('ICU / Critical, Ambulatory');
  });

  it('a list that mixes languages, keys and a note keeps the note', () => {
    expect(careLevelText(`${I18N.HI.care_icu}, care_stable, ${I18N.AR.care_na}`, { translateLegacy: true }))
      .toBe('ICU / Critical, Stable / Monitored, Not Applicable');
    expect(careLevelText(`${I18N.GU.care_icu}, needs a nurse`, { translateLegacy: true })).toBe('ICU / Critical, needs a nurse');
  });
});

const baseRequest = {
  referenceNumber: 'REQ-1001', serviceType: 'Private Charter Air Ambulance Service', serviceKey: 'privatecharter',
  patientName: 'Maria Fernandez', origin: 'Mumbai, Maharashtra, India', destination: 'Dubai, United Arab Emirates',
  status: 'submitted', createdAt: '2031-01-01T10:00:00.000Z', case: null,
};
const careInPdf = async (careLevel) => valueAfter(await renderPdfLines({ ...baseRequest, careLevel }), 'Care level:');

describe('PDF summary: care level', () => {
  it('prints keys as English labels, never raw', async () => {
    expect(await careInPdf('care_icu,care_stable')).toBe('ICU / Critical, Stable / Monitored');
    expect(await careInPdf('care_icu, care_stable')).toBe('ICU / Critical, Stable / Monitored');
    expect(await careInPdf('care_na')).toBe('Not Applicable');
  });

  it.each(LANGUAGES)('prints an older %s label as readable English (the built-in font cannot draw it)', async (lang) => {
    expect(await careInPdf(`${I18N[lang].care_icu}, ${I18N[lang].care_stable}`)).toBe('ICU / Critical, Stable / Monitored');
    expect(await careInPdf(I18N[lang].care_ambulatory)).toBe('Ambulatory');
  });

  it('prints free text as stored, and leaves the line out when there is no care level', async () => {
    expect(await careInPdf('Basic')).toBe('Basic');
    expect(await careInPdf('needs care_icu bed')).toBe('needs care_icu bed');
    expect(await careInPdf('care_icu, ventilator')).toBe('ICU / Critical, ventilator');
    expect(await careInPdf(null)).toBeUndefined();
  });

  it('leaves the other lines as they were', async () => {
    const lines = await renderPdfLines({ ...baseRequest, careLevel: 'care_icu', patientAge: 61, patientGender: 'female' });
    expect(valueAfter(lines, 'Patient Name:')).toBe('Maria Fernandez');
    expect(valueAfter(lines, 'Age / Gender:')).toBe('61 / female');
    expect(valueAfter(lines, 'From:')).toBe('Mumbai, Maharashtra, India');
  });
});

describe('Bitrix lead comment: care level', () => {
  const comments = (careLevel) => leadInputFromRequest({ ...baseRequest, careLevel, description: 'Needs oxygen' }, { mobile: '+971501234567' }).comments;

  it('writes stored keys as English labels', () => {
    expect(comments('care_icu,care_stable')).toBe('Requirement: Needs oxygen\nCare level: ICU / Critical, Stable / Monitored');
  });

  it('sends older translated text and free text exactly as stored (output unchanged for existing requests)', () => {
    for (const lang of LANGUAGES) {
      const stored = `${I18N[lang].care_icu}, ${I18N[lang].care_stable}`;
      expect(comments(stored)).toBe(`Requirement: Needs oxygen\nCare level: ${stored}`);
    }
    expect(comments('Basic')).toBe('Requirement: Needs oxygen\nCare level: Basic');
  });

  it('leaves the line out when there is no care level, as before', () => {
    expect(comments(null)).toBe('Requirement: Needs oxygen');
  });

  it('changes nothing else in the lead input', () => {
    const input = leadInputFromRequest({ ...baseRequest, careLevel: 'care_icu', patientAge: 61, patientGender: 'female', patientContact: '+971501234567' }, null);
    expect(input).toMatchObject({ mobile: '+971501234567', patientGender: 'female', patientAge: 61 });
  });
});

describe('PDF and Bitrix read the same stored value the same way', () => {
  const bitrixLine = (careLevel) => {
    const text = leadInputFromRequest({ ...baseRequest, careLevel }, null).comments;
    const line = text.split('\n').find((l) => l.startsWith('Care level: '));
    return line ? line.slice('Care level: '.length) : undefined;
  };

  // Stored by the validator, by the corporate portal, and as free text.
  it.each([
    ['care_icu'], ['care_icu,care_stable'], ['care_icu,care_stable,care_ambulatory'], ['care_na'], ['care_icu, care_stable'],
    ['Basic'], ['needs care_icu bed'], ['care_icu, ventilator'],
  ])('%s: the same words in both', async (stored) => {
    expect(await careInPdf(stored)).toBe(bitrixLine(stored));
  });

  it('a stored key never reaches either as raw text', async () => {
    for (const stored of ['care_icu,care_stable', 'care_na', 'care_ambulatory,care_stable']) {
      expect(await careInPdf(stored)).not.toMatch(/care_/);
      expect(bitrixLine(stored)).not.toMatch(/care_/);
    }
  });

  it('for older translated text they differ only in the way intended: Bitrix as sent, the PDF in English', async () => {
    for (const lang of LANGUAGES) {
      const stored = `${I18N[lang].care_icu}, ${I18N[lang].care_stable}`;
      expect(bitrixLine(stored)).toBe(stored);
      expect(await careInPdf(stored)).toBe('ICU / Critical, Stable / Monitored');
    }
  });

  it('what the Private Charter validator stores is what these read', async () => {
    const { validatePrivateCharterRequest } = require('../src/modules/requests/private-charter.validation');
    const { IDS, ROWS } = require('./fixtures/geo-cities');
    const city = (id) => { const c = ROWS.find((r) => r.geonameId === id); return { geonameId: c.geonameId, name: c.name, label: c.name, countryCode: c.countryCode, timezone: c.timezone }; };
    const body = {
      serviceKey: 'privatecharter', serviceType: 'Private Charter Air Ambulance Service', patientName: 'Maria Fernandez', patientAge: 61,
      patientGender: 'female', country: 'AE', origin: { geonameId: IDS.MUMBAI }, destination: { geonameId: IDS.DUBAI },
      patientContact: '+971501234567', preferredDate: '2099-01-01', careLevel: ['care_icu', 'care_stable'], description: 'x', mobility: 'bedridden', urgency: 'planned',
    };
    const { data, fields } = validatePrivateCharterRequest(body, { cities: { origin: city(IDS.MUMBAI), destination: city(IDS.DUBAI) } });
    expect(fields).toEqual({});
    expect(data.careLevel).toBe('care_icu,care_stable');
    expect(await careInPdf(data.careLevel)).toBe('ICU / Critical, Stable / Monitored');
    expect(bitrixLine(data.careLevel)).toBe('ICU / Critical, Stable / Monitored');
  });
});
