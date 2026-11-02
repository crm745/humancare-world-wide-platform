const crypto = require('crypto');

// Used by the seed scripts when no INITIAL_*_PASSWORD env var is set, so a fresh
// checkout never gets a password that's sitting in plain text in Git history.
function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  return Array.from(crypto.randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
}

module.exports = { randomPassword };
