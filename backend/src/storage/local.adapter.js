// Local-disk adapter: the same interface as the S3 adapter, for development, tests and for files written before S3 (legacy bare-name keys).
// Writes go to a temp file and are linked into place; an existing key is never overwritten.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { StorageError } = require('./errors');
const { assertSafeKey } = require('./keys');
const { createMeter } = require('./meter');

function createLocalAdapter({ root }) {
  if (!root) throw new StorageError('config_invalid', 'The local storage root is not set.');
  const base = path.resolve(root);

  function pathOf(key) {
    assertSafeKey(key);
    const full = path.resolve(base, ...key.split('/'));
    if (!full.startsWith(base + path.sep)) throw new StorageError('key_invalid', 'Invalid storage key.');
    return full;
  }

  async function upload(key, body, { maxBytes } = {}) {
    const target = pathOf(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const meter = createMeter(maxBytes);
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    try {
      await pipeline(source, meter, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      try {
        await fs.promises.link(temp, target); // refuses to replace an existing object
      } catch (err) {
        if (err.code === 'EEXIST') throw new StorageError('conflict', 'An object with this key already exists.');
        if (!['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err;
        await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('upload_failed', 'The file could not be stored.', { cause: err.code });
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
    return { key, size: meter.size(), sha256: meter.sha256(), versionId: null, etag: null };
  }

  async function download(key) {
    const file = pathOf(key);
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch (err) {
      throw new StorageError(err.code === 'ENOENT' ? 'not_found' : 'download_failed', err.code === 'ENOENT' ? 'The stored file is missing.' : 'The stored file could not be read.', { cause: err.code });
    }
    if (!stat.isFile()) throw new StorageError('not_found', 'The stored file is missing.');
    return { stream: fs.createReadStream(file), size: stat.size, contentType: null, versionId: null, etag: null };
  }

  async function getMetadata(key) {
    try {
      const stat = await fs.promises.stat(pathOf(key));
      return stat.isFile() ? { key, size: stat.size, contentType: null, lastModified: stat.mtime, versionId: null, etag: null } : null;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (err.code === 'ENOENT') return null;
      throw new StorageError('metadata_failed', 'The stored file could not be inspected.', { cause: err.code });
    }
  }

  const exists = async (key) => (await getMetadata(key)) !== null;

  async function del(key) {
    try {
      await fs.promises.rm(pathOf(key), { force: true });
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('delete_failed', 'The stored file could not be deleted.', { cause: err.code });
    }
  }

  return { provider: 'local', upload, download, delete: del, getMetadata, exists, pathOf };
}

module.exports = { createLocalAdapter };
