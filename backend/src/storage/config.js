// Storage settings from the environment. Nothing here has a default for the AWS account, region or bucket: S3 is used only
// when region and bucket are set; otherwise the service refuses to use it, with a message that names the missing VARIABLES
// (never their values).
//
// Credentials, two supported modes:
//   - development: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (and optionally AWS_SESSION_TOKEN) from the environment;
//   - production (EC2): NEITHER key variable set. The AWS SDK's default credential provider chain then supplies them (the
//     instance's IAM role, via the metadata service), so no permanent access key is needed on the server.
// Setting only one of the two keys is refused.
//
// Optional read-only fallback bucket for a region/bucket migration (AWS_S3_READ_FALLBACK_BUCKET + AWS_S3_READ_FALLBACK_REGION,
// both or neither): an object missing from the primary bucket is looked for there. Nothing is ever written to it.
// See STORAGE-MIGRATION.md.
const { StorageError } = require('./errors');

const PROVIDERS = ['local', 's3'];
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

function readStorageConfig(env = process.env) {
  const provider = String(env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) throw new StorageError('config_invalid', `STORAGE_PROVIDER must be one of: ${PROVIDERS.join(', ')}.`);
  if (provider === 'local') return { provider };

  const get = (name) => String(env[name] || '').trim();
  const missing = ['AWS_REGION', 'AWS_S3_BUCKET'].filter((name) => !get(name));
  if (missing.length) throw new StorageError('config_missing', `S3 storage is selected but these environment variables are not set: ${missing.join(', ')}.`);
  if (!REGION.test(get('AWS_REGION'))) throw new StorageError('config_invalid', 'AWS_REGION is not a valid region name.');
  if (!BUCKET.test(get('AWS_S3_BUCKET')) || get('AWS_S3_BUCKET').includes('..')) throw new StorageError('config_invalid', 'AWS_S3_BUCKET is not a valid bucket name.');
  const pathStyle = get('AWS_S3_FORCE_PATH_STYLE').toLowerCase();
  if (pathStyle && !['true', 'false'].includes(pathStyle)) throw new StorageError('config_invalid', 'AWS_S3_FORCE_PATH_STYLE must be true or false.');
  if (Boolean(get('AWS_ACCESS_KEY_ID')) !== Boolean(get('AWS_SECRET_ACCESS_KEY'))) {
    throw new StorageError('config_invalid', 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together, or both left unset to use the AWS default credential provider chain (for example the EC2 instance role).');
  }
  const fallbackBucket = get('AWS_S3_READ_FALLBACK_BUCKET');
  const fallbackRegion = get('AWS_S3_READ_FALLBACK_REGION');
  if (Boolean(fallbackBucket) !== Boolean(fallbackRegion)) throw new StorageError('config_invalid', 'AWS_S3_READ_FALLBACK_BUCKET and AWS_S3_READ_FALLBACK_REGION must be set together.');
  if (fallbackBucket && (!BUCKET.test(fallbackBucket) || !REGION.test(fallbackRegion))) throw new StorageError('config_invalid', 'The read fallback bucket or region is not valid.');
  return {
    provider,
    region: get('AWS_REGION'),
    bucket: get('AWS_S3_BUCKET'),
    ...(get('AWS_ACCESS_KEY_ID') && { accessKeyId: get('AWS_ACCESS_KEY_ID'), secretAccessKey: get('AWS_SECRET_ACCESS_KEY'), ...(get('AWS_SESSION_TOKEN') && { sessionToken: get('AWS_SESSION_TOKEN') }) }),
    forcePathStyle: pathStyle === 'true',
    ...(fallbackBucket && { readFallback: { bucket: fallbackBucket, region: fallbackRegion } }),
  };
}

module.exports = { readStorageConfig, PROVIDERS };
