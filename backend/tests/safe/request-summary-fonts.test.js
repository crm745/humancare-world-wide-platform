/* global describe, test, expect */
// The fonts and the script runs behind the Unicode support of the request summary PDF (pdf/fonts.js): the font files are present and valid, each covers what the code says it covers, and a text is cut
// into runs by script correctly. fontkit (a dependency of the PDF library) is used here only to MEASURE the font files. No database, no network.
const fs = require('fs');
const path = require('path');
const fontkit = require('fontkit');
const { FONT_DIR, FILES, SCRIPTS, OWN_NEUTRALS, BLOCKS, fontPath, scriptOfCodePoint, splitRuns } = require('../../src/modules/requests/pdf/fonts');

const open = (script, bold = false) => fontkit.openSync(fontPath(script, bold));

describe('the font files', () => {
  test('all ten are present, valid TrueType files, and the licence and the notes are next to them', () => {
    for (const script of SCRIPTS) {
      for (const bold of [false, true]) {
        const file = fontPath(script, bold);
        expect({ file: path.basename(file), exists: fs.existsSync(file) }).toEqual({ file: path.basename(file), exists: true });
        expect(fs.readFileSync(file).subarray(0, 4).toString('hex')).toBe('00010000'); // TrueType
        expect(fs.statSync(file).size).toBeGreaterThan(100000);
      }
    }
    expect(fs.existsSync(path.join(FONT_DIR, 'OFL.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(FONT_DIR, 'OFL.txt'), 'utf8')).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(fs.readFileSync(path.join(FONT_DIR, 'README.md'), 'utf8')).toMatch(/SIL Open Font License/);
    expect(Object.keys(FILES).sort()).toEqual([...SCRIPTS].sort());
  });
  test('the brand logo is a real PNG of the expected size', () => {
    const logo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'assets', 'brand', 'logo-full.png'));
    expect(logo.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(logo.readUInt32BE(16)).toBe(900);
    expect(logo.readUInt32BE(20)).toBe(518);
  });
  test('each font draws the script it is used for (a sample letter of each)', () => {
    const samples = { latin: 'AaZz', devanagari: 'आशानायर', gujarati: 'કિરણ', telugu: 'అనిల్', arabic: 'أحمد' };
    for (const [script, sample] of Object.entries(samples)) {
      const font = open(script);
      for (const ch of Array.from(sample)) expect({ script, ch, has: font.hasGlyphForCodePoint(ch.codePointAt(0)) }).toEqual({ script, ch, has: true });
    }
  });
  test('the neutral characters each script font is said to draw are really in the font (so they never become boxes)', () => {
    for (const script of Object.keys(OWN_NEUTRALS)) {
      for (const bold of [false, true]) {
        const font = open(script, bold);
        for (const ch of OWN_NEUTRALS[script]) expect({ script, bold, ch, has: font.hasGlyphForCodePoint(ch.codePointAt(0)) }).toEqual({ script, bold, ch, has: true });
      }
    }
  });
  test('Noto Sans draws the Latin text, digits and punctuation of the labels and of English values', () => {
    const font = open('latin');
    for (const ch of Array.from('Request Summary 0123456789 .,:;()-/&@#%+\'"—·–')) expect({ ch, has: font.hasGlyphForCodePoint(ch.codePointAt(0)) }).toEqual({ ch, has: true });
  });
  test('the bold fonts exist for the headings and the status', () => {
    for (const script of SCRIPTS) expect(path.basename(fontPath(script, true))).toMatch(/-Bold\.ttf$/);
  });
});

describe('scriptOfCodePoint', () => {
  test.each([
    ['A', 'latin'], ['z', 'latin'], ['é', 'latin'], ['Ω', 'latin'], ['Ж', 'latin'], ['आ', 'devanagari'], ['।', 'devanagari'], ['ક', 'gujarati'], ['అ', 'telugu'], ['أ', 'arabic'], ['ﻻ', 'arabic'], ['٣', 'arabic'],
    [' ', null], ['4', null], [',', null], ['—', null], ['‍', null], ['🙂', null], ['₹', null],
  ])('%s is %s', (ch, script) => { expect(scriptOfCodePoint(ch.codePointAt(0))).toBe(script); });
  test('the blocks are what the comments say', () => {
    expect(Object.keys(BLOCKS).sort()).toEqual(['arabic', 'devanagari', 'gujarati', 'telugu']);
  });
});

describe('splitRuns', () => {
  const view = (text) => splitRuns(text).map((r) => `${r.script}:${r.text}`);
  test('Latin text is one run; the empty text has none', () => {
    expect(view('Flat 4B, Rose Villa, Pune 411001')).toEqual(['latin:Flat 4B, Rose Villa, Pune 411001']);
    expect(splitRuns('')).toEqual([]);
    expect(splitRuns(null)).toEqual([]);
    expect(splitRuns(undefined)).toEqual([]);
  });
  test('a phrase of one script stays in one run, spaces and digits included (so it is shaped and ordered as one piece)', () => {
    expect(view('हिंदी: मुंबई, 411001 महाराष्ट्र')).toEqual(['devanagari:हिंदी: मुंबई, 411001 महाराष्ट्र']); // digits BETWEEN two Devanagari words stay in the run
    expect(view('అనిల్ కుమార్, హైదరాబాద్')).toEqual(['telugu:అనిల్ కుమార్, హైదరాబాద్']);
    expect(view('أحمد 123 علي')).toEqual(['arabic:أحمد 123 علي']);
    // neutrals at the END of a phrase belong to the text that follows (Noto Sans): only a neutral between two runs of the same script is absorbed
    expect(view('हिंदी 411001')).toEqual(['devanagari:हिंदी', 'latin: 411001']);
    expect(view('أحمد علي 123')).toEqual(['arabic:أحمد علي', 'latin: 123']);
  });
  test('Gujarati keeps only its spaces; digits and punctuation go to Noto Sans', () => {
    expect(view('ગુજરાતી, અમદાવાદ')).toEqual(['gujarati:ગુજરાતી', 'latin:, ', 'gujarati:અમદાવાદ']);
    expect(view('કિરણ પટેલ')).toEqual(['gujarati:કિરણ પટેલ']);
  });
  test('Arabic keeps spaces and digits but hands characters its font lacks to Noto Sans', () => {
    expect(view('أحمد — Dubai دبي')).toEqual(['arabic:أحمد', 'latin: — Dubai ', 'arabic:دبي']);
  });
  test('mixed text is cut where the script changes, and no character is lost or reordered', () => {
    for (const text of ['Ahmed أحمد علي', 'Flat 4B, मुंबई 400001 Pune', 'Name: అనిల్ (Anil) — કિરણ', 'x‍y', 'क्‍ष क्‍ष', 'plain 🙂 text ₹ 100']) {
      expect(splitRuns(text).map((r) => r.text).join('')).toBe(text);
    }
  });
  test('a zero-width joiner stays with the script it shapes', () => {
    expect(view('क्‍ष')).toEqual(['devanagari:क्‍ष']);
  });
  test('emoji, symbols and CJK are handed to Noto Sans (the library then falls back to its empty box, never to a crash)', () => {
    expect(view('Name 🙂 ₹ 日本')).toEqual(['latin:Name 🙂 ₹ 日本']);
  });
  test('a very long text is cut quickly and completely', () => {
    const text = ('Latin words and हिंदी शब्द and العربية ').repeat(2000);
    const start = Date.now();
    const runs = splitRuns(text);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(runs.map((r) => r.text).join('')).toBe(text);
  });
});
