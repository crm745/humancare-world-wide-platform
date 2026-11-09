const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Where uploaded files are kept: backend/uploads unless HC_UPLOAD_DIR is set (an absolute path is best;
// a relative one is resolved against the working directory). Everything that stores, reads, scans or
// quarantines an upload uses this one constant, so setting it moves all of them together, e.g. to keep
// an integration session's files apart from the dev server's. Unset or blank: the default, as before.
const DEFAULT_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const customUploadDir = (process.env.HC_UPLOAD_DIR || '').trim();
const UPLOAD_DIR = customUploadDir ? path.resolve(customUploadDir) : DEFAULT_UPLOAD_DIR;
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
