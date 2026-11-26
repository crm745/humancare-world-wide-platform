/* global describe, test, expect, __dirname */
// About HumanCare: the page shows ONLY the official introduction approved by HumanCare senior management, word for word, openly on the app's background. These tests pin
// the four approved paragraphs EXACTLY (their own copy below, not read from the app), that nothing else is on the page (no logo, contact, legal links or version), that the
// text is not in a card or box, that it wraps and scrolls, and that nothing else (translations, Profile, navigation) changed.
// (The screen is not rendered here: this project's Jest covers lib/ logic and reads screen source, see jest.config.js; the layout on a phone is checked by hand.)
const fs = require('fs');
const path = require('path');
const content = require('../../data/aboutContent');
const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/i18n.json'), 'utf8'));

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// The approved text, as supplied (an independent copy). Every character matters: the em dashes, the "24×7", the figures, "across the India".
const APPROVED = [
  'Since 2004, Humancare World Wide has stood by one promise: no one should ever face a medical emergency alone. What began as a dedicated medical assistance provider has grown into a trusted global network of hospitals, aviation experts, and compassionate medical professionals, united by a single commitment: care without borders.',
  'Our mobile app puts that promise directly in your hands. In moments that matter, every second counts: with one tap, the app connects you to our 24×7 emergency control centre to request an air ambulance, arrange ground transport, coordinate hospital admission, or call medical help for a loved one, with no queues, no confusion, no delay.',
  'Through the app, you access more than 3,500 partner hospitals and 11,000+ medical facilities worldwide, with experienced doctors, surgeons and paramedics managing every stage of care end to end, from documentation and clearances to bed-to-bed patient transfer. Beyond emergencies, book home health care, teleconsultations and digital paperwork that removes the stress of medical formalities.',
  'With teams across the India, UAE, KSA, the UK and beyond, support in over 150 countries is always within reach. When every second matters, we are already on our way.',
];

describe('the approved introduction', () => {
  test('there are exactly four paragraphs, each character for character as supplied', () => {
    expect(content.ABOUT_INTRO.paragraphs).toHaveLength(4);
    content.ABOUT_INTRO.paragraphs.forEach((paragraph, i) => expect({ paragraph: i + 1, text: paragraph }).toEqual({ paragraph: i + 1, text: APPROVED[i] }));
  });
  test('the figures and terms are as supplied: 2004, 24×7, 3,500, 11,000+, 150, KSA, "care without borders", "across the India"', () => {
    const all = content.ABOUT_INTRO.paragraphs.join(' ');
    for (const piece of ['Since 2004', '24×7 emergency control centre', 'more than 3,500 partner hospitals', '11,000+ medical facilities', 'over 150 countries', 'across the India, UAE, KSA, the UK', 'care without borders', 'bed-to-bed patient transfer']) {
      expect(all).toContain(piece);
    }
  });
  test('nothing was shortened, paraphrased or added: the content file holds the four paragraphs, nothing else', () => {
    expect(content.ABOUT_INTRO.paragraphs.join('\n')).toBe(APPROVED.join('\n'));
    expect(Object.keys(content)).toEqual(['ABOUT_INTRO']);
    expect(Object.keys(content.ABOUT_INTRO)).toEqual(['paragraphs']);
  });
});

describe('nothing else is on the page', () => {
  const screen = code('app/about.js');
  const imports = read('app/about.js').split('\n').filter((line) => line.startsWith('import '));
  test('no contact details, offices, legal links, version or other section', () => {
    for (const gone of ['ABOUT_CONTACT', 'ABOUT_OFFICES', 'ABOUT_WEBSITE', 'ABOUT_MISSION', 'ABOUT_WHY', 'Linking', 'mailto:', 'tel:', "router.push('/terms')", "router.push('/privacy')",
      'terms_title', 'privacy_title', 'prof_footer', 'Constants', 'expoConfig', 'about_contact', 'about_legal', 'about_website', 'about_services', 'Group', 'LinkRow', 'Office', 'SectionLabel']) {
      expect({ gone, present: screen.includes(gone) }).toEqual({ gone, present: false });
    }
    expect(imports.join('\n')).not.toMatch(/expo-constants|PressBox|lucide/);
    expect(imports.filter((line) => /data\/images/.test(line))).toEqual([]); // no logo, no image of any kind
  });
  test('the only text on the page is the four paragraphs', () => {
    expect((screen.match(/<Text/g) || []).length).toBe(1); // the one Text drawn once per paragraph (no company name heading)
    expect(screen).toContain('ABOUT_INTRO.paragraphs.map((paragraph, i) => (');
    expect(screen).toContain('{t(`about_p${i + 1}`)}</Text>'); // each paragraph in the person's language (the English dictionary text is the approved text: translationParity / areasTranslated tests)
    expect(screen).not.toContain('.slice('); // no paragraph is cut short
    expect(screen).not.toMatch(/numberOfLines/); // and none is truncated with an ellipsis
  });
  test('the content file has no contact, office, website or legal data left', () => {
    const file = read('data/aboutContent.js');
    for (const gone of ['humancareworldwide.com', '+971', '+91', 'ops@', 'Head Office', 'Terms', 'Privacy']) expect(file).not.toContain(gone);
  });
});

describe('no company name heading and no logo at the top of the page', () => {
  const screen = code('app/about.js');
  test('the logo is gone from this page: no image and no logo import (the logo file itself stays for the rest of the app)', () => {
    expect(screen).not.toMatch(/LOGO|<Image|\bImage\b|require\(|uri:/);
    expect(read('data/images.js')).toMatch(/LOGO\s*=\s*require\(/);
  });
  test('there is no company name heading: the title bar says "About" and the page starts with the introduction', () => {
    expect(screen).not.toContain('about_name');
    expect(screen).not.toContain('accessibilityRole="header"');
    expect(screen).not.toContain('ABOUT_INTRO.name');
    for (const lang of Object.keys(i18n)) expect({ lang, has: 'about_name' in i18n[lang] }).toEqual({ lang, has: false });
    expect(i18n.EN.prof_about).toBe('About');
  });
  test('the title says just About in every language, with no company name', () => {
    for (const lang of Object.keys(i18n)) expect({ lang, named: /Humancare/i.test(i18n[lang].prof_about) }).toEqual({ lang, named: false });
  });
});

describe('the layout: open text, styled exactly like the Privacy Policy page', () => {
  const screen = code('app/about.js');
  const legal = code('components/LegalScreen.js'); // the one component Terms and Privacy share: the design reference
  const privacy = code('app/privacy.js');
  // The part of the screen from the first paragraph on (the branding block above it is checked in its own describe).
  const paragraphSource = (source) => source.slice(source.indexOf('ABOUT_INTRO.paragraphs.map'));
  const classOf = (source, startsWith) => new RegExp(`className="(${startsWith}[^"]*)"`).exec(source)[1];

  test('the Privacy Policy page is the LegalScreen component (so its values are LegalScreen\'s), and it is untouched', () => {
    expect(privacy).toContain("import { LegalScreen } from '../components/LegalScreen';");
    expect(privacy).toContain('<LegalScreen titleKey="privacy_title" sections={SECTIONS} showUpdated={false} email="support@humancareworldwide.com" />'); // the Privacy page shows no "Last updated" line
  });
  test('the same side and top padding as the Privacy page: 18 on every side, so the left and right are equal', () => {
    const mine = /<Body contentClassName="([^"]+)">/.exec(screen)[1];
    const theirs = /<Body contentClassName="([^"]+)">/.exec(legal)[1];
    expect(mine).toBe(theirs);
    expect(mine).toBe('p-[18px]');
    expect(screen).not.toMatch(/paddingLeft|paddingRight|marginLeft|marginRight|paddingStart|paddingEnd|paddingHorizontal|maxWidth|alignSelf/); // nothing that could make one side differ
  });
  test('the same body typography as the Privacy page: 13.5 size, 22 line height, muted colour, regular weight, the app\'s body font', () => {
    const mine = classOf(screen, 'mb-5 ');
    const theirs = classOf(legal, 'text-\\[13\\.5px\\] leading');
    expect(mine).toContain(theirs);
    expect(theirs).toBe('text-[13.5px] leading-[22px] text-muted');
    expect(mine).toBe('mb-5 text-[13.5px] leading-[22px] text-muted');
    // no bold / black font and no font family of its own on the paragraphs: the same default body font as the legal pages' paragraphs
    expect(paragraphSource(screen)).not.toMatch(/font-inter|fontFamily|fontWeight|fontSize|lineHeight/);
    expect(screen).not.toMatch(/fontFamily|fontWeight|fontSize|lineHeight/);
    expect(13.5 / 22).toBeLessThan(0.62); // 22 / 13.5 = 1.63 times the size, as the Privacy page reads
  });
  test('the same space between paragraphs as the Privacy page has between its sections (mb-5)', () => {
    expect(legal).toContain('<Text key={headingKey} className="mb-5">'); // each section is followed by mb-5 (20)
    expect(screen).toContain('className="mb-5 text-[13.5px]');
    expect(paragraphSource(screen)).not.toMatch(/gap:/);
  });
  test('the same background and text colours: the app\'s own screen background (no colour of its own) and the muted body text', () => {
    for (const source of [screen, legal]) expect(source).toContain('<Screen>');
    expect(paragraphSource(screen)).not.toMatch(/#[0-9A-Fa-f]{3,8}|bg-|backgroundColor|text-ink|text-navy|text-primary/);
    expect(screen).not.toMatch(/#[0-9A-Fa-f]{3,8}|bg-|backgroundColor/);
    expect(classOf(legal, 'text-\\[13\\.5px\\] leading')).toContain('text-muted');
  });
  test('the same header and back navigation (the title bar), with the About title', () => {
    expect(screen).toContain("<TopBar title={t('prof_about')} />");
    expect(legal).toContain('<TopBar title={t(titleKey)} />');
  });
  test('no card, box, border, shadow or coloured background around the text', () => {
    for (const boxed of ['Card', 'backgroundColor', 'bg-', 'border', 'shadow', 'elevation', 'rounded', 'Pressable']) expect({ boxed, present: screen.includes(boxed) }).toEqual({ boxed, present: false });
    expect(importsOf()).not.toMatch(/\bCard\b/);
  });
  test('the floating call button never covers the last paragraph: room is reserved for exactly its zone, for any bottom inset, only while it shows', () => {
    const { fabClearance } = require('../sos');
    expect(screen).toContain('const fabShows = useSosFabVisible();');
    expect(screen).toContain('fabClearance({ edge: 0, insetBottom: insets.bottom }) - (BODY_BOTTOM + insets.bottom)');
    expect(screen).toContain('<View style={{ height: reserve }} />');
    expect(screen).toContain('const BODY_BOTTOM = 32;');
    expect(read('components/layout.js')).toContain('const BOTTOM_GAP = 32;'); // what Body already pads, so only the difference is added
    for (const inset of [0, 16, 24, 34, 48]) {
      const reserve = Math.max(0, fabClearance({ edge: 0, insetBottom: inset }) - (32 + inset));
      const room = 32 + inset + reserve; // the space under the last paragraph, from the bottom edge of the screen
      expect({ inset, clears: room >= fabClearance({ edge: 0, insetBottom: inset }) }).toEqual({ inset, clears: true });
      expect({ inset, tight: room - fabClearance({ edge: 0, insetBottom: inset }) }).toEqual({ inset, tight: 0 }); // not a bigger gap than needed
    }
    // the button's own behaviour is untouched: where it shows and what it does are in lib/sos.js and components/sos
    expect(read('lib/sos.js')).toContain('export function fabClearance');
    expect(require('../sos').sosFabVisible({ pathname: '/about', authStatus: 'authed' })).toBe(true);
  });
  test('the text wraps naturally and can be selected; it is not tied to one screen size', () => {
    expect(screen).toContain('selectable');
    expect(screen).not.toMatch(/<Text[^>]*(width|height): \d+/);
    expect(paragraphSource(screen)).not.toMatch(/\bwidth: \d+/); // (only the logo has a fixed size; the text has none)
  });
  test('the page scrolls (it sits in the app\'s scrolling Body, with room under the text for the gesture bar)', () => {
    expect(read('components/layout.js')).toMatch(/export const Body = forwardRef[\s\S]*<KeyboardScroll[\s\S]*contentContainerStyle=\{\{ paddingBottom \}\}/);
  });
  test('the language direction is the root layout\'s (Arabic reads right to left)', () => {
    expect(read('app/_layout.js')).toContain("direction: isRTL ? 'rtl' : 'ltr'");
  });
  function importsOf() { return read('app/about.js').split('\n').filter((line) => line.startsWith('import ')).join('\n'); }
});

describe('what this work did not touch', () => {
  test('the Profile row that opens the page is unchanged, and the route and the legal screens still exist', () => {
    expect(code('app/(tabs)/profile.js')).toContain("router.push('/about')");
    expect(fs.existsSync(path.join(__dirname, '../../app/about.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../../app/terms.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../../app/privacy.js'))).toBe(true);
  });
  test('no translation key was added or removed for this content (it is English, and is translated separately)', () => {
    for (const lang of Object.keys(i18n)) {
      for (const key of Object.keys(i18n[lang])) expect({ lang, key, added: /^about_(intro|mission|vision|values|why|offices|presence|show)/.test(key) }).toEqual({ lang, key, added: false });
      expect(typeof i18n[lang].prof_about).toBe('string');
    }
  });
  test('the screen reads only keys that already existed', () => {
    for (const match of read('app/about.js').matchAll(/\bt\('([a-z_0-9]+)'/g)) expect(typeof i18n.EN[match[1]]).toBe('string');
  });
});
