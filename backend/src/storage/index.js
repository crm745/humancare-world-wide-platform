// The one storage service every upload / download / delete goes through.
//
//   getStorage()      the adapter chosen by STORAGE_PROVIDER ("local" by default, "s3"). Built on first use; a bad or missing S3
//                     configuration throws a StorageError (config_missing / config_invalid) here, so nothing silently falls back
//                     to local disk or to another bucket.
//   storageFor(key)   the adapter that holds an existing object. A legacy key (a bare file name, written by the old local-disk
//                     code) is always local; every other key belongs to the configured provider.
//   setStorageForTests(adapter | null)   inject a fake adapter (or reset).
//
// Every adapter has: upload(key, body, opts), download(key), delete(key), getMetadata(key), exists(key).
const { readStorageConfig } = require('./config');
const { createLocalAdapter } = require('./local.adapter');
const { createS3Adapter } = require('./s3.adapter');
const { isLegacyLocalKey } = require('./keys');
const { StorageError } = require('./errors');

let active = null;
let local = null;
let s3Direct = null;
let injected = null;

const localRoot = () => require('../middleware/upload.middleware').UPLOAD_DIR; // lazy: importing this file creates no folder

function getLocal() {
  if (!local) local = createLocalAdapter({ root: localRoot() });
  return local;
}

// An S3 adapter from the environment, or null when S3 is not (fully) configured. Used as a READ fallback while another provider is
// the active one, and by getS3() for records that say they live in S3.
function tryS3() {
  if (!s3Direct) {
    try {
      s3Direct = createS3Adapter({ config: readStorageConfig({ ...process.env, STORAGE_PROVIDER: 's3' }) });
    } catch {
      return null;
    }
  }
  return s3Direct;
}

// Reads look in the active provider first and, when the object is "not found" there, in the other provider (if it is available); so
// switching STORAGE_PROVIDER, or having files from before S3, never makes an existing object silently unreachable. Writes go only to
// the active provider. A delete removes the object wherever it is found. (A composite has no `pathOf`: its callers stream.)
function withFallbacks(primary, others) {
  const notFound = (err) => err instanceof StorageError && err.code === 'not_found';
  return {
    provider: primary.provider,
    upload: (...args) => primary.upload(...args),
    async download(key) {
      try { return await primary.download(key); } catch (err) { if (!notFound(err)) throw err; }
      for (const other of others()) {
        try { return await other.download(key); } catch (err) { if (!notFound(err)) throw err; }
      }
      throw new StorageError('not_found', 'The stored file is missing.');
    },
    async getMetadata(key) {
      const found = await primary.getMetadata(key);
      if (found) return found;
      for (const other of others()) {
        const meta = await other.getMetadata(key);
        if (meta) return meta;
      }
      return null;
    },
    async exists(key) { return (await this.getMetadata(key)) !== null; },
    async delete(key) {
      await primary.delete(key);
      for (const other of others()) await other.delete(key).catch(() => undefined);
    },
  };
}

function getStorage() {
  if (injected) return injected;
  if (!active) {
    const config = readStorageConfig();
    if (config.provider === 's3') {
      s3Direct = createS3Adapter({ config });
      active = withFallbacks(s3Direct, () => [getLocal()]);
    } else {
      const base = getLocal();
      active = tryS3() ? withFallbacks(base, () => [tryS3()].filter(Boolean)) : base;
    }
  }
  return active;
}

function storageFor(key) {
  if (injected) return injected;
  return isLegacyLocalKey(key) ? getLocal() : getStorage();
}

// The adapter for a record that NAMES its provider ("local" | "s3", e.g. case_quotations.storage_provider). A "local" record is
// always read from the local folder, an "s3" record from S3, whatever STORAGE_PROVIDER is now.
function storageForProvider(provider) {
  if (injected) return injected;
  if (provider === 'local') return getLocal();
  if (provider === 's3') {
    getStorage();
    const adapter = s3Direct || tryS3();
    if (!adapter) throw new StorageError('config_missing', 'This file is stored in S3 but S3 is not configured.');
    return adapter;
  }
  return getStorage();
}

// "local" | "s3": where NEW files are written now.
const activeProvider = () => getStorage().provider;

function setStorageForTests(adapter) {
  injected = adapter || null;
  active = null;
  local = null;
  s3Direct = null;
}

// The whole object as a Buffer, only when its size and SHA-256 are what was recorded at upload. For files the app caps at 10 MB
// (the workflow's verified downloads). Larger / unverified files are streamed instead.
async function readVerified(key, { sha256, size }) {
  const crypto = require('crypto');
  const { stream, size: reported } = await storageFor(key).download(key);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (size && total > size) throw new StorageError('file_changed', 'The stored file no longer matches what was recorded.');
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError('download_failed', 'The stored file could not be read.', { cause: err && (err.code || err.name) });
  }
  const buffer = Buffer.concat(chunks);
  if ((size && buffer.length !== size) || (reported != null && size && reported !== size)) throw new StorageError('file_changed', 'The stored file no longer matches what was recorded.');
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== sha256) throw new StorageError('file_changed', 'The stored file no longer matches what was recorded.');
  return buffer;
}

// The whole object as a Buffer (no checksum on record, e.g. a legacy document), refusing anything over maxBytes.
async function readBuffer(key, maxBytes = 10 * 1024 * 1024) {
  const { stream } = await storageFor(key).download(key);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new StorageError('too_large', 'The stored file is too large to read into memory.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { getStorage, storageFor, storageForProvider, activeProvider, getLocal, setStorageForTests, readVerified, readBuffer, StorageError };
