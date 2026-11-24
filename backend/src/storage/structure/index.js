// Structure validation for the accepted formats. `validateStructure(type, buffer)` resolves null (acceptable) or { code, reason }.
// A type with no validator is NOT accepted (fail closed).
const { validatePng, validateJpeg, validateWebp } = require('./images');
const { validatePdf } = require('./pdf');
const { validateDocx } = require('./docx');

async function validateStructure(type, buffer) {
  switch (type) {
    case 'png': return validatePng(buffer);
    case 'jpeg': return validateJpeg(buffer);
    case 'webp': return validateWebp(buffer);
    case 'pdf': return validatePdf(buffer);
    case 'docx': return validateDocx(buffer);
    default: return { code: 'file_type_not_allowed', reason: 'no validator for this type' };
  }
}

module.exports = { validateStructure };
