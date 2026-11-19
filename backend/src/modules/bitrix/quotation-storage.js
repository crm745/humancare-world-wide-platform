// Where a quotation's PDF is kept: the local uploads folder (UPLOAD_DIR), in its own sub-folder. Never in MySQL, never served as a
// static file (app.js serves no uploads), never overwritten, and always verified against its SHA-256 before it is trusted.
//
// The interface is deliberately tiny (putIfAbsent / hashOf / pathOf / readVerified / remove / quarantine) so another provider can
// replace this one later without touching the sync or the scanner. Only "local" exists today.
//
// STORAGE KEY: "quotations/case-<caseId>/<name>.pdf", relative to the uploads folder, opaque and unique per file (the table has
// UNIQUE storage_key). The sync names a file after the outbox event that creates it ("ev<eventId>-<sha256>"), so a retry of the same
// event finds its own object again instead of making a second one, while every other event gets its own.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY = /^quotations\/case-[1-9]\d{0,9}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.pdf$/;
const PROVIDER = 'local';
const QUARANTINE_FOLDER = 'quarantine';

class StorageError extends Error {
  constructor(code, message) { super(message || code); this.name = 'StorageError'; this.code = code; }
}

const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

const keyFor = (caseId, eventId, sha256) => `quotations/case-${caseId}/ev${eventId}-${sha256}.pdf`;

function createLocalStorage({ root } = {}) {
  const base = root || require('../../middleware/upload.middleware').UPLOAD_DIR; // lazy: nothing is created on import
  const baseResolved = path.resolve(base);

  function pathOf(key) {
    if (typeof key !== 'string' || !KEY.test(key) || key.includes('..')) throw new StorageError('key_invalid');
    const full = path.resolve(baseResolved, ...key.split('/'));
    if (!full.startsWith(baseResolved + path.sep)) throw new StorageError('key_invalid');
    return full;
  }

  /** Stores `bytes` under `key` only if nothing is there. { created: true } when it wrote the file; { created: false } when an object
   * with that key already exists AND has exactly this content (an earlier try of the same event). An existing object with other
   * content is never replaced: it is a conflict. */
  async function putIfAbsent(key, bytes, sha256) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new StorageError('empty_file');
    if (sha256Of(bytes) !== sha256) throw new StorageError('hash_mismatch');
    const target = pathOf(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    try {
      await fs.promises.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await fs.promises.link(temp, target); // atomic and refuses to replace an existing file
      } catch (err) {
        if (err.code === 'EEXIST') {
          let existing;
          try { existing = await hashFile(target); } catch { throw new StorageError('conflict'); }
          if (existing === sha256) return { created: false };
          throw new StorageError('conflict');
        }
        if (!['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err;
        await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL); // no hard links here: still never overwrites
      }
      if ((await hashFile(target)) !== sha256) { await fs.promises.rm(target, { force: true }); throw new StorageError('verify_failed'); }
      return { created: true };
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  const hashOf = (key) => hashFile(pathOf(key));

  /** The bytes of a stored object, only if they still match `sha256`. */
  async function readVerified(key, sha256) {
    const bytes = await fs.promises.readFile(pathOf(key));
    if (sha256Of(bytes) !== sha256) throw new StorageError('file_changed');
    return bytes;
  }

  const remove = (key) => fs.promises.rm(pathOf(key), { force: true });

  /** Moves an infected object out of the way (uploads/quarantine/quotations/...). Resolves the new relative path. */
  async function quarantine(key) {
    const source = pathOf(key);
    const target = path.join(baseResolved, QUARANTINE_FOLDER, ...key.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.rename(source, target);
    return path.relative(baseResolved, target).split(path.sep).join('/');
  }

  return { provider: PROVIDER, putIfAbsent, hashOf, pathOf, readVerified, remove, quarantine };
}

module.exports = { createLocalStorage, keyFor, sha256Of, hashFile, StorageError, KEY, PROVIDER };
