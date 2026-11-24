// Where a quotation's PDF is kept. Never in MySQL, never served as a static file (app.js serves no uploads), never overwritten, and
// always verified against its SHA-256 before it is trusted.
//
// createQuotationStorage() is what the services use. It routes every call by the PROVIDER RECORDED ON THE QUOTATION ROW
// (case_quotations.storage_provider, "local" | "s3"), so a historical local file stays readable when S3 is switched on, and an S3 file
// stays readable if STORAGE_PROVIDER is switched back. NEW files go to the active provider (see ../../storage) and the row records
// which one that was (`storage.provider`). createLocalStorage() below is the hardened local implementation (kept for "local" rows).
//
// Interface: putIfAbsent / hashOf / pathOf (local only) / readVerified / openStream / remove / quarantine. Every call that reads or
// removes an existing object takes the row's provider as its LAST argument.
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

// ---- provider routing (local rows and S3 rows) ----------------------------------------------------------------------------------
function createQuotationStorage({ local: injectedLocal, s3, activeProvider } = {}) {
  let localStorage = injectedLocal;
  const getLocal = () => localStorage || (localStorage = createLocalStorage());
  const shared = () => require('../../storage');
  const s3Adapter = () => s3 || shared().storageForProvider('s3');
  const active = () => (activeProvider ? activeProvider() : shared().activeProvider());
  const isS3 = (provider) => provider === 's3';
  const checkKey = (key) => { if (typeof key !== 'string' || !KEY.test(key) || key.includes('..')) throw new StorageError('key_invalid'); };

  async function readAll(adapter, key) {
    const { stream } = await adapter.download(key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async function hashOf(key, provider) {
    if (!isS3(provider)) return getLocal().hashOf(key);
    checkKey(key);
    const { stream } = await s3Adapter().download(key);
    return (await require('../../storage/meter').hashStream(stream)).sha256;
  }

  return {
    get provider() { return active(); },
    pathOf: (key) => getLocal().pathOf(key),

    /** Stores into the ACTIVE provider. { created, provider }. Same rules as the local one: never replaces an object with other content. */
    async putIfAbsent(key, bytes, sha256) {
      if (active() !== 's3') return { ...(await getLocal().putIfAbsent(key, bytes, sha256)), provider: 'local' };
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new StorageError('empty_file');
      if (sha256Of(bytes) !== sha256) throw new StorageError('hash_mismatch');
      checkKey(key);
      const adapter = s3Adapter();
      if (await adapter.exists(key)) {
        let existing;
        try { existing = await hashOf(key, 's3'); } catch { throw new StorageError('conflict'); }
        if (existing === sha256) return { created: false, provider: 's3' };
        throw new StorageError('conflict');
      }
      const stored = await adapter.upload(key, bytes, { contentType: 'application/pdf' });
      if (stored.sha256 !== sha256) { await adapter.delete(key).catch(() => undefined); throw new StorageError('verify_failed'); }
      return { created: true, provider: 's3' };
    },

    hashOf,

    /** The bytes of a stored object, only if they still match `sha256`. */
    async readVerified(key, sha256, provider) {
      if (!isS3(provider)) return getLocal().readVerified(key, sha256);
      checkKey(key);
      const bytes = await readAll(s3Adapter(), key);
      if (sha256Of(bytes) !== sha256) throw new StorageError('file_changed');
      return bytes;
    },

    /** { stream } of the stored object, for the scanner. */
    async openStream(key, provider) {
      if (!isS3(provider)) return { stream: fs.createReadStream(getLocal().pathOf(key)) };
      checkKey(key);
      return s3Adapter().download(key);
    },

    async remove(key, provider) {
      if (!isS3(provider)) return getLocal().remove(key);
      checkKey(key);
      return s3Adapter().delete(key);
    },

    /** Local: moved to uploads/quarantine. S3: the infected object is deleted (the saved verdict already blocks every use). */
    async quarantine(key, provider) {
      if (!isS3(provider)) return getLocal().quarantine(key);
      checkKey(key);
      await s3Adapter().delete(key);
      return null;
    },
  };
}

module.exports = { createLocalStorage, createQuotationStorage, keyFor, sha256Of, hashFile, StorageError, KEY, PROVIDER };
