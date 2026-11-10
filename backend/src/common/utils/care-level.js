// How a stored care level reads on a screen, a PDF or a lead comment.
//
// Stored values come in several shapes (see LEGACY-DATA-NORMALIZATION.md): machine keys
// ("care_icu,care_stable"), the older translated labels, the corporate portal's "care_icu, care_stable",
// and anything a person typed. This function only translates what it knows for certain and leaves
// everything else exactly as stored, byte for byte (spacing, punctuation, commas, case):
//
//   * a value made only of keys (and optionally, see below, known labels) is rewritten as the
//     readable list "ICU / Critical, Stable / Monitored";
//   * in any other value, only the pieces that are exactly a key are replaced, in place, with their
//     own surrounding spacing; the rest of the text is not touched. A key inside a sentence
//     ("needs care_icu bed") is not a piece, so it is left alone.
//
// Options:
//   translateLegacy  also read the known translated labels (all six app languages) and give the
//                    English label. Off by default: the Bitrix comment keeps legacy text as it was
//                    sent. On for the PDF, whose built-in font cannot draw Hindi, Marathi, Gujarati,
//                    Telugu or Arabic.
// A value that is not a string (null, undefined) is returned as it is.

const { CARE_LEVEL_KEYS, CARE_LEVEL_LEGACY_LABELS, CARE_LEVEL_LABEL_EN } = require('../constants/request.constants');

const LABEL_TO_KEY = new Map(
  Object.entries(CARE_LEVEL_LEGACY_LABELS).flatMap(([key, labels]) => labels.map((label) => [label.normalize('NFC'), key])),
);

function keyOf(piece, translateLegacy) {
  const text = piece.trim().normalize('NFC');
  if (CARE_LEVEL_KEYS.includes(text)) return text;
  if (translateLegacy && LABEL_TO_KEY.has(text)) return LABEL_TO_KEY.get(text);
  return null;
}

function careLevelText(value, { translateLegacy = false } = {}) {
  if (typeof value !== 'string' || value === '') return value;
  const pieces = value.split(',');
  const keys = pieces.map((piece) => keyOf(piece, translateLegacy));
  if (keys.every(Boolean)) return keys.map((key) => CARE_LEVEL_LABEL_EN[key]).join(', ');
  return pieces.map((piece, i) => {
    if (!keys[i]) return piece;
    const leading = piece.match(/^\s*/)[0];
    const trailing = piece.match(/\s*$/)[0];
    return `${leading}${CARE_LEVEL_LABEL_EN[keys[i]]}${trailing}`;
  }).join(',');
}

module.exports = { careLevelText };
