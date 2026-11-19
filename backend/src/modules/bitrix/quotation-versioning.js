// Pure: the quotation fingerprint and the versioning decision. No database, no network, no files.
//
// FINGERPRINT (case_quotations.content_fingerprint, 64 hex): SHA-256 over the PDF's own SHA-256, the canonical amount and the
// currency, so the same content always gives the same value and any change to the file, the amount or the currency changes it.
// When the money did not validate, the RAW Bitrix texts are hashed instead (prefixed "raw"), so an edit of an invalid amount is
// still a change.
const crypto = require('crypto');

const FINGERPRINT_VERSION = 'q1';

function contentFingerprint({ pdfSha256, amount, currency, amountRaw = null, currencyRaw = null }) {
  if (typeof pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pdfSha256)) throw new Error('A 64-character lowercase hex PDF hash is required.');
  const money = amount != null && currency != null ? `ok\n${amount}\n${currency}` : `raw\n${amountRaw ?? ''}\n${currencyRaw ?? ''}`;
  return crypto.createHash('sha256').update(`${FINGERPRINT_VERSION}\n${pdfSha256}\n${money}`).digest('hex');
}

// Statuses in which a version is still the unpublished WORKING version (case_quotations_working_slot_chk).
const WORKING_STATUSES = new Set(['draft', 'confirmed']);

/**
 * What a sync result does to the Case's quotation versions. `head` is the version with the highest versionNumber (or null),
 * `incomingFingerprint` the fingerprint of what Bitrix holds now.
 *
 *   create          no version yet, OR the head is published / accepted / rejected / withdrawn / superseded: a NEW draft version
 *                   (the head, and every older version, is left exactly as it is: accepted and rejected stay immutable)
 *   update_working  the head is the unpublished working version (draft or confirmed): it is updated in place; a confirmed one
 *                   returns to draft and loses its confirmation
 *   unchanged       the head already holds exactly this content: nothing is written (at most "last seen")
 */
function decideVersion(head, incomingFingerprint) {
  if (!head) return { action: 'create', versionNumber: 1 };
  if (head.contentFingerprint === incomingFingerprint) return { action: 'unchanged' };
  if (WORKING_STATUSES.has(head.status)) return { action: 'update_working', versionNumber: head.versionNumber };
  return { action: 'create', versionNumber: head.versionNumber + 1 };
}

module.exports = { contentFingerprint, decideVersion, WORKING_STATUSES, FINGERPRINT_VERSION };
