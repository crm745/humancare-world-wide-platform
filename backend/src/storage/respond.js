// Streams a stored object to an authenticated client. The caller has ALREADY checked the user's right to the document; this only
// delivers bytes (no redirect, no pre-signed URL, so the bucket is never reachable from outside the backend).
const { pipeline } = require('stream');
const { storageFor } = require('./index');
const { StorageError } = require('./errors');

async function sendStoredFile(res, { key, filename }) {
  let object;
  try {
    object = await storageFor(key).download(key);
  } catch (err) {
    if (err instanceof StorageError && err.code === 'not_found') {
      const notFound = new Error('The stored file is missing.');
      notFound.statusCode = 404;
      notFound.publicCode = 'file_missing';
      throw notFound;
    }
    throw err;
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  if (object.size != null) res.set('Content-Length', String(object.size));
  res.type('application/octet-stream');
  res.attachment(filename);
  await new Promise((resolve) => {
    pipeline(object.stream, res, (err) => {
      if (err && !res.headersSent) res.status(502).json({ error: 'The file could not be read.' });
      resolve();
    });
  });
}

module.exports = { sendStoredFile };
