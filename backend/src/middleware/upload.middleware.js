const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Real uploads live in backend/uploads. In the test environment, and only there, UPLOAD_DIR moves
// them to backend/.e2e-uploads (the one value the safety guard accepts), so tests never write to,
// or delete from, the shared development folder.
const UPLOAD_DIR = process.env.NODE_ENV === 'test' && process.env.UPLOAD_DIR
  ? require('../common/safety/test-database-guard').resolveTestUploadsDir(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', '..', 'uploads');
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
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
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
