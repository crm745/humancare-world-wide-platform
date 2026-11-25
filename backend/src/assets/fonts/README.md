# Fonts for the request summary PDF

The request summary PDF (backend/src/modules/requests/pdf) is always English, but it prints what the patient typed exactly as typed, in any script. A PDF's built-in fonts
cannot draw Hindi, Marathi, Gujarati, Telugu or Arabic, so these fonts are embedded (only the glyphs a document uses are included in the file).

| File | Covers |
| --- | --- |
| NotoSans-Regular / -Bold | Latin, Greek, Cyrillic and the usual punctuation (the document's own text and all labels) |
| NotoSansDevanagari-Regular / -Bold | Hindi, Marathi (Devanagari) |
| NotoSansGujarati-Regular / -Bold | Gujarati |
| NotoSansTelugu-Regular / -Bold | Telugu |
| NotoSansArabic-Regular / -Bold | Arabic (and other Arabic-script text) |

All are Noto fonts by the Noto Project Authors (https://github.com/notofonts), licensed under the SIL Open Font License 1.1 (OFL.txt in this folder). They are fonts, not code: no
package dependency was added. The brand logo used in the PDF header is ../brand/logo-full.png (a copy of apps/mobile/assets/images/logo-full.png).
