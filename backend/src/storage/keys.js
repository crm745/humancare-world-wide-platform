// Object keys. The database stores ONLY these (never a machine path, never a URL). A key is generated here, from a fixed
// list of areas and random bytes: nothing the client sends (file name, type) ever becomes part of it, except the extension of
// the file type that was detected from the file's own bytes.
const crypto = require('crypto');
const { StorageError } = require('./errors');

const AREAS = Object.freeze({
  REQUEST_DOCUMENTS: 'request-documents',
  CASE_DOCUMENTS: 'case-documents',
  CORPORATE_DOCUMENTS: 'corporate-documents',
  REGISTRATION_DOCUMENTS: 'registration-documents',
  QUOTATIONS: 'quotations',
});
const AREA_VALUES = new Set(Object.values(AREAS));
const EXTENSIONS = new Set(['.pdf', '.jpg', '.png', '.webp', '.doc', '.docx']);

// "<area>/<yyyy>/<mm>/<32 hex>[.ext]"
const GENERATED_KEY = /^[a-z-]{3,40}\/\d{4}\/\d{2}\/[a-f0-9]{32}(\.[a-z]{2,4})?$/;
// Anything a stored object may be called: segments of [A-Za-z0-9._-], none empty or starting with a dot, so no "..", no absolute path, no backslash.
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}){0,5}$/;

function generateKey(area, extension = '', now = new Date()) {
  if (!AREA_VALUES.has(area)) throw new StorageError('key_invalid', 'Unknown storage area.');
  const ext = extension ? String(extension).toLowerCase() : '';
  if (ext && !EXTENSIONS.has(ext)) throw new StorageError('key_invalid', 'Unsupported extension.');
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${area}/${yyyy}/${mm}/${crypto.randomBytes(16).toString('hex')}${ext}`;
}

function assertSafeKey(key) {
  if (typeof key !== 'string' || key.length > 191 || !SAFE_KEY.test(key) || key.includes('..')) throw new StorageError('key_invalid', 'Invalid storage key.');
  return key;
}

// A key written by the old local-disk code: a bare file name (multer's "<timestamp>-<name>") with no folder. These can only ever
// live in the local upload folder, whatever STORAGE_PROVIDER says. Keys made by generateKey always contain "/".
const isLegacyLocalKey = (key) => typeof key === 'string' && !key.includes('/');

// Old `documents.file_url` / `corporate_documents.file_url` values are "/uploads/<file>"; new rows hold the key itself.
function keyFromStoredReference(ref) {
  const text = String(ref || '');
  return text.startsWith('/uploads/') ? text.slice('/uploads/'.length) : text;
}

module.exports = { AREAS, generateKey, assertSafeKey, isLegacyLocalKey, keyFromStoredReference, GENERATED_KEY };
