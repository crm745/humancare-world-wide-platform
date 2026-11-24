// AWS S3 adapter (AWS SDK for JavaScript v3). The bucket stays private: no ACL is ever sent, no public or pre-signed URL is made,
// every object is encrypted at rest (SSE-S3, AES256). Bodies are streamed (multipart upload through @aws-sdk/lib-storage), so a
// large file is never held in memory. The client (and the uploader) can be injected, for tests.
//
// Credentials: explicit keys when config has them (development); otherwise NO credentials are passed and the SDK's default provider
// chain is used (EC2 instance role in production).
//
// Optional read-only fallback (config.readFallback, for a bucket / region migration): download, getMetadata and exists look in the
// fallback bucket when the primary says "not found". Uploads and deletes only ever touch the primary bucket.
const { Readable } = require('stream');
const { StorageError, isNotFound } = require('./errors');
const { assertSafeKey } = require('./keys');
const { createMeter } = require('./meter');

function createS3Adapter({ config, client, uploader, fallbackClient }) {
  let s3 = client;
  let s3Fallback = fallbackClient;
  const sdk = () => require('@aws-sdk/client-s3');
  const clientOptions = (region) => ({
    region,
    forcePathStyle: Boolean(config.forcePathStyle),
    maxAttempts: 3,
    ...(config.accessKeyId && {
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken && { sessionToken: config.sessionToken }) },
    }),
  });
  const getClient = () => {
    if (!s3) s3 = new (sdk().S3Client)(clientOptions(config.region));
    return s3;
  };
  const getFallbackClient = () => {
    if (!s3Fallback) s3Fallback = new (sdk().S3Client)(clientOptions(config.readFallback.region));
    return s3Fallback;
  };
  const Bucket = config.bucket;
  const hasFallback = Boolean(config.readFallback);

  async function upload(key, body, { contentType, maxBytes } = {}) {
    assertSafeKey(key);
    const meter = createMeter(maxBytes);
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    source.on('error', (err) => meter.destroy(err));
    const metered = source.pipe(meter);
    try {
      const params = { Bucket, Key: key, Body: metered, ServerSideEncryption: 'AES256', ...(contentType && { ContentType: contentType }) };
      let result;
      if (uploader) {
        result = await uploader(getClient(), params);
      } else {
        const { Upload } = require('@aws-sdk/lib-storage');
        result = await new Upload({ client: getClient(), params, queueSize: 3, partSize: 8 * 1024 * 1024, leavePartsOnError: false }).done();
      }
      return { key, size: meter.size(), sha256: meter.sha256(), versionId: (result && result.VersionId) || null, etag: (result && result.ETag) || null };
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError('upload_failed', 'The file could not be stored.', { cause: err && err.name });
    }
  }

  async function getObject(key, useFallback) {
    const out = await (useFallback ? getFallbackClient() : getClient()).send(new (sdk().GetObjectCommand)({ Bucket: useFallback ? config.readFallback.bucket : Bucket, Key: key }));
    if (!out || !out.Body) throw new StorageError('download_failed', 'The stored file could not be read.');
    return { stream: out.Body, size: out.ContentLength, contentType: out.ContentType || null, versionId: out.VersionId || null, etag: out.ETag || null };
  }

  async function download(key) {
    assertSafeKey(key);
    try {
      return await getObject(key, false);
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (!isNotFound(err)) throw new StorageError('download_failed', 'The stored file could not be read.', { cause: err && err.name });
    }
    if (hasFallback) {
      try {
        return await getObject(key, true);
      } catch (err) {
        if (err instanceof StorageError) throw err;
        if (!isNotFound(err)) throw new StorageError('download_failed', 'The stored file could not be read.', { cause: err && err.name });
      }
    }
    throw new StorageError('not_found', 'The stored file is missing.');
  }

  async function head(key, useFallback) {
    try {
      const out = await (useFallback ? getFallbackClient() : getClient()).send(new (sdk().HeadObjectCommand)({ Bucket: useFallback ? config.readFallback.bucket : Bucket, Key: key }));
      return { key, size: out.ContentLength, contentType: out.ContentType || null, lastModified: out.LastModified || null, versionId: out.VersionId || null, etag: out.ETag || null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StorageError('metadata_failed', 'The stored file could not be inspected.', { cause: err && err.name });
    }
  }

  async function getMetadata(key) {
    assertSafeKey(key);
    return (await head(key, false)) || (hasFallback ? head(key, true) : null);
  }

  const exists = async (key) => (await getMetadata(key)) !== null;

  async function del(key) {
    assertSafeKey(key);
    try {
      await getClient().send(new (sdk().DeleteObjectCommand)({ Bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw new StorageError('delete_failed', 'The stored file could not be deleted.', { cause: err && err.name });
    }
  }

  return { provider: 's3', upload, download, delete: del, getMetadata, exists };
}

module.exports = { createS3Adapter };
