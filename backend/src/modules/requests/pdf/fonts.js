// Fonts and script runs for the request summary PDF. The PDF is English only, but it prints what the patient typed exactly as typed, so any script a patient may type has to be DRAWN, not
// turned into boxes or garbage (the built-in PDF fonts only know Western European text). Noto Sans files are embedded (src/assets/fonts, SIL OFL 1.1: see the README there).
//
//   splitRuns(text)   cuts a text into runs, each drawn with the font of its script: latin | devanagari | gujarati | telugu | arabic
//   fontPath(script, bold)   the file of a run's font
//
// How a text is cut: every character belongs to the script of its own Unicode block (Devanagari U+0900-097F covers Hindi and Marathi; Gujarati U+0A80-0AFF; Telugu U+0C00-0C7F; Arabic
// U+0600-06FF and its supplements and presentation forms); everything else (Latin letters, digits, spaces, punctuation, symbols, emoji) is drawn by Noto Sans. The zero-width joiner and
// non-joiner stay with the script they shape. A space or mark BETWEEN two runs of the same script stays inside that run when that script's font has a glyph for it (so an Arabic phrase is one
// run and its words keep their right-to-left order, and a Hindi phrase is shaped as one piece); otherwise it is drawn by Noto Sans. Shaping (conjuncts, vowel signs, Arabic joining) and the
// right-to-left order inside an Arabic run are done by the PDF library's font engine.
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
const FILES = Object.freeze({
  latin: ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf'],
  devanagari: ['NotoSansDevanagari-Regular.ttf', 'NotoSansDevanagari-Bold.ttf'],
  gujarati: ['NotoSansGujarati-Regular.ttf', 'NotoSansGujarati-Bold.ttf'],
  telugu: ['NotoSansTelugu-Regular.ttf', 'NotoSansTelugu-Bold.ttf'],
  arabic: ['NotoSansArabic-Regular.ttf', 'NotoSansArabic-Bold.ttf'],
});
const SCRIPTS = Object.freeze(Object.keys(FILES));
const fontPath = (script, bold = false) => path.join(FONT_DIR, FILES[FILES[script] ? script : 'latin'][bold ? 1 : 0]);

// The neutral characters each script's font can draw itself (measured from the font files; tests/safe/request-summary-fonts.test.js re-measures them). Others go to Noto Sans.
const SPACES = ' ';
const ASCII_NEUTRALS = ' 0123456789.,:;()-/#%+\'"';
const OWN_NEUTRALS = Object.freeze({
  devanagari: `${ASCII_NEUTRALS}–—`,
  telugu: `${ASCII_NEUTRALS}–—`,
  gujarati: SPACES,
  arabic: ' 0123456789.,:-',
});

const inRange = (c, ranges) => ranges.some(([from, to]) => c >= from && c <= to);
const BLOCKS = Object.freeze({
  devanagari: [[0x0900, 0x097f], [0xa8e0, 0xa8ff], [0x1cd0, 0x1cff]],
  gujarati: [[0x0a80, 0x0aff]],
  telugu: [[0x0c00, 0x0c7f]],
  arabic: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
});
const JOINERS = new Set([0x200c, 0x200d]);

// The script of one code point, or null for a neutral (it is decided by its neighbours).
function scriptOfCodePoint(c) {
  for (const script of Object.keys(BLOCKS)) if (inRange(c, BLOCKS[script])) return script;
  if (JOINERS.has(c)) return null;
  const isLatinLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x370 && c <= 0x52f) || (c >= 0x1e00 && c <= 0x1eff);
  return isLatinLetter ? 'latin' : null;
}

function splitRuns(text) {
  const chars = Array.from(String(text === null || text === undefined ? '' : text));
  if (chars.length === 0) return [];
  const scripts = chars.map((ch) => scriptOfCodePoint(ch.codePointAt(0)));
  // a zero-width joiner or non-joiner shapes the script it sits in
  chars.forEach((ch, i) => {
    if (!JOINERS.has(ch.codePointAt(0))) return;
    let before = null;
    for (let j = i - 1; j >= 0 && before === null; j -= 1) before = scripts[j] && scripts[j] !== 'latin' ? scripts[j] : null;
    scripts[i] = before || 'latin';
  });
  // neutrals: between two runs of the same non-Latin script they stay in it when its font can draw them; otherwise Noto Sans
  let i = 0;
  while (i < chars.length) {
    if (scripts[i] !== null) { i += 1; continue; }
    let j = i;
    while (j < chars.length && scripts[j] === null) j += 1;
    const before = i > 0 ? scripts[i - 1] : null;
    const after = j < chars.length ? scripts[j] : null;
    const keep = before && before === after && before !== 'latin' && chars.slice(i, j).every((ch) => OWN_NEUTRALS[before].includes(ch));
    for (let k = i; k < j; k += 1) scripts[k] = keep ? before : 'latin';
    i = j;
  }
  const runs = [];
  chars.forEach((ch, index) => {
    const last = runs[runs.length - 1];
    if (last && last.script === scripts[index]) last.text += ch;
    else runs.push({ script: scripts[index], text: ch });
  });
  return runs;
}

module.exports = { FONT_DIR, FILES, SCRIPTS, OWN_NEUTRALS, BLOCKS, fontPath, scriptOfCodePoint, splitRuns };
