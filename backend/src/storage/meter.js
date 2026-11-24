// A pass-through stream that counts the bytes, hashes them (SHA-256) and refuses to go past `maxBytes`.
const crypto = require('crypto');
const { Transform } = require('stream');
const { StorageError } = require('./errors');

function createMeter(maxBytes) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  let digest = null;
  const stream = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) return cb(new StorageError('too_large', 'The file is too large.'));
      hash.update(chunk);
      return cb(null, chunk);
    },
  });
  stream.size = () => size;
  stream.sha256 = () => {
    if (digest === null) digest = hash.digest('hex');
    return digest;
  };
  return stream;
}

// SHA-256 and size of a readable stream, consuming it.
async function hashStream(readable, maxBytes) {
  const meter = createMeter(maxBytes);
  await new Promise((resolve, reject) => {
    readable.on('error', reject);
    meter.on('error', reject);
    meter.on('end', resolve);
    meter.resume();
    readable.pipe(meter);
  });
  return { sha256: meter.sha256(), size: meter.size() };
}

module.exports = { createMeter, hashStream };
