// SHA-256 digest of a high-entropy random token (invitation links, refresh tokens), so only the
// hash is stored. A fast hash is correct here because the input is already unguessable; do NOT
// use this for passwords (those need bcrypt) and never log the input.
const crypto = require('crypto');

const MAX_TOKEN_LENGTH = 4096;

function hashToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH || token.trim() !== token) {
    throw new TypeError('hashToken needs a non-empty token string without surrounding whitespace');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { hashToken };
