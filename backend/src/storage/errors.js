// Errors of the storage layer. `code` is stable and safe to log; messages never contain credentials, bucket names or file-system paths.
class StorageError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'StorageError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const isNotFound = (err) => Boolean(err) && (err.code === 'not_found' || err.code === 'ENOENT' || err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404);

module.exports = { StorageError, isNotFound };
