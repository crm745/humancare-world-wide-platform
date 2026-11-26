/* global describe, test, expect, jest, __dirname */
// Help & Support: Email Support opens a mail to ops@humancareworldwide.com, Call Alarm Desk still dials, the floating SOS button is absent on this screen ONLY, and the FAQs are the
// website-sourced list in all six languages with a working accordion. Source checks and the pure parts; nothing here was run on a device.
const fs = require('fs');
const path = require('path');
const I18N = require('../../data/i18n.json');
const { openLink } = require('../openLink');
const S = require('../sos');
const { FAQS, OPS_EMAIL, EMERGENCY_TEL, REGIONAL_NUMBERS } = require('../../data/mock');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const LANGS = ['EN', 'HI', 'MR', 'GU', 'TE', 'AR'];
const screen = read('app', 'help-support.js');

describe('Email Support', () => {
  test('the address is ops@humancareworldwide.com', () => { expect(OPS_EMAIL).toBe('ops@humancareworldwide.com'); });
  test('the button opens mailto:ops@humancareworldwide.com (the recipient is pre-filled, nothing else is added)', async () => {
    expect(screen).toContain('onPress={() => open(`mailto:${OPS_EMAIL}`)}');
    const open = jest.fn(async () => undefined);
    await openLink(`mailto:${OPS_EMAIL}`, { open, onError: jest.fn() });
    expect(open).toHaveBeenCalledWith('mailto:ops@humancareworldwide.com');
  });
  test('with no mail app the person is told (the link-failure message), nothing crashes', async () => {
    const onError = jest.fn();
    await openLink(`mailto:${OPS_EMAIL}`, { open: async () => { throw new Error('no app'); }, onError });
    expect(onError).toHaveBeenCalled();
  });
});

describe('Call Alarm Desk and the regional numbers', () => {
  test('Call Alarm Desk still dials the alarm desk number', () => {
    expect(screen).toContain('onPress={() => open(`tel:${EMERGENCY_TEL}`)}');
    expect(screen).toContain("t('btn_call_alarm_desk')");
    expect(EMERGENCY_TEL).toBe('+919699999065');
  });
  test('the regional numbers are unchanged', () => {
    expect(REGIONAL_NUMBERS.map((n) => n.tel)).toEqual(['+919699999065', '+971585787878', '+96898882797', '+8801314968067', '+447557070702']);
    expect(screen).toContain('onPress={() => open(`tel:${n.tel}`)}');
  });
});

describe('the floating SOS button: absent on Help & Support only', () => {
  const ctx = { authStatus: 'authed', isCorporate: false };
  test('hidden on /help-support', () => {
    expect(S.isHiddenRoute('/help-support')).toBe(true);
    expect(S.sosFabVisible({ pathname: '/help-support', ...ctx })).toBe(false);
  });
  test('still shown on the other signed-in screens (profile, terms, about, privacy, my requests ...)', () => {
    for (const route of ['/profile', '/terms', '/privacy', '/about', '/my-requests', '/all-services', '/notifications', '/personal-details']) expect({ route, shown: S.sosFabVisible({ pathname: route, ...ctx }) }).toEqual({ route, shown: true });
  });
});

describe('the FAQs', () => {
  test('5 questions, each with an answer, from the dictionary (no hard-coded English answer is left in the data)', () => {
    expect(FAQS).toHaveLength(5);
    FAQS.forEach((f, i) => expect(f).toEqual({ q: `faq_q${i + 1}`, a: `faq_a${i + 1}` }));
    expect(read('data', 'mock.js')).not.toMatch(/airborne within 2.4 hours|TPAs and insurers|View Live Tracking|8 regions/);
  });
  test.each(LANGS)('%s: every question and answer exists, and non-English texts are translated', (lang) => {
    for (const f of FAQS) {
      for (const key of [f.q, f.a]) {
        expect({ lang, key, ok: typeof I18N[lang][key] === 'string' && I18N[lang][key].trim() !== '' }).toEqual({ lang, key, ok: true });
        if (lang !== 'EN') expect({ lang, key, same: I18N[lang][key] === I18N.EN[key] }).toEqual({ lang, key, same: false });
      }
    }
  });
  test('the English answers state no price, insurance cover, response time or guarantee of their own', () => {
    const answers = FAQS.map((f) => I18N.EN[f.a]).join(' ');
    expect(answers).not.toMatch(/₹|\$|AED|\bUSD\b|\bINR\b|within \d+ ?(minutes|hours)|\d+ ?(minutes|hours)|guaranteed|covered by your insurance|price|cost of/i);
    expect(I18N.EN.faq_a1).toMatch(/GOP/); // hospital assistance names GOP coordination; it makes no promise of its own
    expect(I18N.EN.faq_a1).not.toMatch(/guarantees payment/);
  });
  test('only the five approved FAQs remain, in this order, and no other faq key is left in any language', () => {
    expect(FAQS.map((f) => I18N.EN[f.q])).toEqual([
      'What does hospital assistance include?',
      'Can Humancare World Wide help with travel for treatment?',
      'What does Home Healthcare cover?',
      'What does Mortal Remains support include?',
      'What does Corporate Medical Solutions include?',
    ]);
    const wanted = new Set(FAQS.flatMap((f) => [f.q, f.a]));
    for (const lang of LANGS) expect(Object.keys(I18N[lang]).filter((k) => /^faq_[qa]\d+$/.test(k) && !wanted.has(k))).toEqual([]);
    expect(Object.values(I18N.EN).join(' ')).not.toMatch(/How fast can an air ambulance be dispatched|Will my insurance \/ TPA cover the cost|What is an air ambulance service|Do you offer ground ambulances/);
  });
  test('the accordion: each answer shows on tap and hides on the next, with the expanded state exposed', () => {
    expect(screen).toContain('const [open, setOpen] = useState(false);');
    expect(screen).toContain('onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }}');
    expect(screen).toContain('{open && <Text');
    expect(screen).toContain("{FAQS.map((f, i) => <Faq key={f.q} q={t(f.q)} a={t(f.a)} last={i === FAQS.length - 1} />)}");
    expect(screen).toContain("rotate: open ? '180deg' : '0deg'");
  });
  test('Arabic: the layout mirrors with the app\'s root direction (no hard-coded left/right in the screen)', () => {
    expect(screen).not.toMatch(/marginLeft|marginRight|textAlign: 'left'|textAlign: 'right'/);
  });
});
