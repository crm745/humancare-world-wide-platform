const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Where uploaded files are kept. Everything that stores, reads, scans or quarantines an upload uses this
// one constant, so changing it moves all of them together.
//   - Test environment (NODE_ENV=test with UPLOAD_DIR set): only backend/.e2e-uploads, the one value the
//     safety guard accepts, so tests never write to, or delete from, the shared development folder.
//   - HC_UPLOAD_DIR (an absolute path is best; a relative one is resolved against the working directory):
//     keeps e.g. an integration session's files apart from the dev server's. Blank counts as unset.
//   - Otherwise backend/uploads.
// The two settings are never combined: a test run that also names HC_UPLOAD_DIR is refused instead of
// letting one silently win (the tests could otherwise write into, or clean, a real session's folder).
const DEFAULT_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const customUploadDir = (process.env.HC_UPLOAD_DIR || '').trim();
const testMode = process.env.NODE_ENV === 'test' && Boolean(process.env.UPLOAD_DIR);
if (testMode && customUploadDir) {
  throw new Error('HC_UPLOAD_DIR must not be set together with UPLOAD_DIR in the test environment.');
}
let UPLOAD_DIR = DEFAULT_UPLOAD_DIR;
if (testMode) UPLOAD_DIR = require('../common/safety/test-database-guard').resolveTestUploadsDir(process.env.UPLOAD_DIR);
else if (customUploadDir) UPLOAD_DIR = path.resolve(customUploadDir);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // At most 120 characters, keeping the end so the extension survives: the stored name (and the
    // "/uploads/<name>" URL built from it) must fit the database columns and the file system.
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120);
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Unsupported file type. Allowed: PDF, JPG, PNG, WEBP, DOC, DOCX.'));
    }
    cb(null, true);
  },
});

module.exports = { upload, UPLOAD_DIR };
