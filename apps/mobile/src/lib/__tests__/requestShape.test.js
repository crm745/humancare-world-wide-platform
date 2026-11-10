const { toUiStatus, formatDisplayDate, serviceKeyFromTitle, toListItem, isMortalRequest, careLevelText } = require('../requestShape');
const I18N = require('../../data/i18n.json');
const { requestService } = require('../../data/mock');

describe('toUiStatus', () => {
  it('maps in_progress to progress', () => expect(toUiStatus('in_progress')).toBe('progress'));
  it('passes through an already-UI status unchanged', () => expect(toUiStatus('completed')).toBe('completed'));
  it('passes through an unknown status unchanged', () => expect(toUiStatus('weird_status')).toBe('weird_status'));
});

describe('formatDisplayDate', () => {
  it('formats an ISO date as DD Mon YYYY', () => {
    expect(formatDisplayDate('2026-09-25T00:00:00.000Z')).toMatch(/25 Sep\w* 2026/);
  });
  it('returns empty string for a missing date', () => expect(formatDisplayDate(null)).toBe(''));
});

describe('serviceKeyFromTitle', () => {
  it('falls back to "air" for an unrecognized title', () => {
    expect(serviceKeyFromTitle('Some Made Up Service')).toBe('air');
  });
});

describe('toListItem', () => {
  it('shapes a backend ServiceRequest into a list item', () => {
    const item = toListItem({
      id: 7,
      referenceNumber: 'REQ-1007',
      serviceType: 'Not A Real Service',
      status: 'in_progress',
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    expect(item).toMatchObject({ id: 'REQ-1007', rawId: 7, status: 'progress', date: '2026-09-25' });
  });
});

describe('Mortal Remains requests', () => {
  const services = { mortal: { title: 'Mortal Remains Transportation' }, air: { title: 'Air Ambulance' } };
  it('names the transfer type and sends its own service key', () => {
    expect(requestService({ service: 'mortal', mortalTransfer: 'international' }, services))
      .toEqual({ title: 'Mortal Remains Transportation — International', key: 'mortal_international' });
    expect(requestService({ service: 'mortal', mortalTransfer: 'domestic' }, services).key).toBe('mortal_domestic');
  });
  it('recognises old and new Mortal Remains requests', () => {
    expect(isMortalRequest({ serviceKey: 'mortal' })).toBe(true);
    expect(isMortalRequest({ serviceKey: 'mortal_domestic' })).toBe(true);
    expect(isMortalRequest({ serviceKey: 'ground' })).toBe(false);
    expect(isMortalRequest({})).toBe(false);
  });
});

describe('careLevelText', () => {
  const KEYS = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];
  // The app's own translate function (AppContext): the language, then English, then the key.
  const tIn = (lang) => (key) => (I18N[lang] && I18N[lang][key]) ?? I18N.EN[key] ?? key;

  it.each(Object.keys(I18N))('shows every key in %s, as that language names it', (lang) => {
    const t = tIn(lang);
    for (const key of KEYS) {
      expect(careLevelText(key, t)).toBe(I18N[lang][key]);
      expect(careLevelText(key, t)).not.toMatch(/^care_/);
    }
    expect(careLevelText('care_icu,care_stable', t)).toBe(`${I18N[lang].care_icu}, ${I18N[lang].care_stable}`);
  });

  it('reads the corporate portal "care_icu, care_stable" the same way', () => {
    expect(careLevelText('care_icu, care_stable', tIn('EN'))).toBe('ICU / Critical, Stable / Monitored');
  });

  it('leaves older translated labels exactly as stored (they are already readable)', () => {
    for (const lang of Object.keys(I18N)) {
      const stored = `${I18N[lang].care_icu}, ${I18N[lang].care_stable}`;
      expect(careLevelText(stored, tIn('EN'))).toBe(stored);
    }
  });

  it('translates only the keys in a mixed value and keeps the rest, spacing included', () => {
    expect(careLevelText('care_icu,  Oxygen needed ,care_na', tIn('EN'))).toBe('ICU / Critical,  Oxygen needed ,Not Applicable');
    expect(careLevelText(`care_icu, ${I18N.HI.care_stable}`, tIn('EN'))).toBe(`ICU / Critical, ${I18N.HI.care_stable}`);
    expect(careLevelText(' care_icu ,x', tIn('EN'))).toBe(' ICU / Critical ,x');
  });

  it('leaves unknown and free text untouched, byte for byte', () => {
    for (const text of [
      'Patient needs oxygen, ventilator; call Dr. Rao', 'care_unknown', 'CARE_ICU', 'needs care_icu bed', 'care_icu.',
      'care_icu;care_stable', ',,', ' ', 'ICU / Critcal', 'a,b,,c, ', '  leading and trailing  ',
    ]) {
      expect(careLevelText(text, tIn('EN'))).toBe(text);
    }
  });

  it('returns null, undefined and empty as they are', () => {
    expect(careLevelText(null, tIn('EN'))).toBeNull();
    expect(careLevelText(undefined, tIn('EN'))).toBeUndefined();
    expect(careLevelText('', tIn('EN'))).toBe('');
  });
});

describe('careLevelText: the app and the backend read a stored value the same way', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const backendDir = path.resolve(__dirname, '..', '..', '..', '..', '..', 'backend');
  // The backend's helper (used by the PDF and the Bitrix comment), run by plain Node as the server runs it.
  const backendReads = (inputs) => {
    const script = "const { careLevelText } = require('./src/common/utils/care-level'); console.log(JSON.stringify(JSON.parse(process.argv[1]).map((v) => careLevelText(v))))";
    const out = spawnSync(process.execPath, ['-e', script, JSON.stringify(inputs)], { cwd: backendDir, encoding: 'utf8' });
    if (out.status !== 0) throw new Error('backend helper failed to run');
    return JSON.parse(out.stdout);
  };
  const english = (key) => I18N.EN[key];

  it('gives the same text in English for keys, mixed values, free text and odd punctuation', () => {
    const inputs = [
      'care_icu', 'care_icu,care_stable', 'care_icu,care_stable,care_ambulatory', 'care_na', 'care_icu, care_stable',
      'Basic', 'needs care_icu bed', 'care_icu, ventilator', 'care_icu,  Oxygen needed ,care_na', ' care_icu ,x',
      'a,b,,c, ', 'CARE_ICU', ',,', '', 'care_icu.', 'काफ़ी गंभीर, ऑक्सीजन',
    ];
    const fromBackend = backendReads(inputs);
    inputs.forEach((stored, i) => expect(careLevelText(stored, english)).toBe(fromBackend[i]));
  });

  it('leaves older translated labels as stored, in every language, like the backend does by default', () => {
    const stored = Object.keys(I18N).map((lang) => `${I18N[lang].care_icu}, ${I18N[lang].care_stable}`);
    const fromBackend = backendReads(stored);
    stored.forEach((text, i) => {
      expect(careLevelText(text, english)).toBe(text);
      expect(fromBackend[i]).toBe(text);
    });
  });

  it('null stays null on both sides', () => {
    expect(careLevelText(null, english)).toBeNull();
    expect(backendReads([null])).toEqual([null]);
  });

  it('knows the same four keys as the backend, and the backend English labels equal the app English strings', () => {
    const keys = ['care_icu', 'care_stable', 'care_ambulatory', 'care_na'];
    const fromBackend = backendReads(keys);
    keys.forEach((key, i) => {
      expect(careLevelText(key, english)).toBe(fromBackend[i]);
      expect(fromBackend[i]).toBe(I18N.EN[key]);
    });
  });
});
