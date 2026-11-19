// Verification of the X-Razorpay-Signature header of a Razorpay webhook: HMAC-SHA256, as lower- or upper-case hexadecimal, of the EXACT raw bytes
// of the request body, keyed with RAZORPAY_WEBHOOK_SECRET.
//
//   - It takes the raw Node.js Buffer, never a string or a parsed object, and it does NOT parse JSON: re-serializing a payload changes its bytes
//     and therefore its signature, so the body is verified exactly as received and parsed only afterwards, by the caller.
//   - The signature must be exactly 64 hexadecimal characters (a SHA-256 digest). Anything else is rejected BEFORE any comparison.
//   - The comparison is crypto.timingSafeEqual over two digest buffers of equal length.
//   - It fails CLOSED: any configuration problem, missing or malformed input, mismatch or unexpected error is a rejection. It never throws.
//   - It never logs, and its result never contains the secret, the body or the signature: only a short code and a kind.
//
// Result: { ok: true } or { ok: false, kind, code }. `kind` says what the caller should answer:
//   "configuration"  the webhook is not configured (answer 503: the receiver is not ready, the sender retries)
//   "body"           there is no usable raw body (answer 400)
//   "signature"      the signature is missing, malformed or wrong (answer 401)
//   "error"          something unexpected failed inside the verification (answer 500)
const crypto = require('crypto');
const { webhookConfigProblem, getWebhookSecret } = require('./razorpay-webhook.config');

const SIGNATURE_LENGTH = 64; // hexadecimal characters of a SHA-256 digest
const HEX = /^[0-9a-fA-F]+$/;

const reject = (kind, code) => ({ ok: false, kind, code });

function verifyWebhookSignature(rawBody, signatureHeader, { env = process.env } = {}) {
  try {
    // 1. Configuration first: with no valid secret and environment id nothing is computed or compared.
    const configProblem = webhookConfigProblem(env);
    if (configProblem) return reject('configuration', configProblem);

    // 2. The raw bytes: a Buffer, not empty. A string or an object would already have been decoded or re-serialized.
    if (!Buffer.isBuffer(rawBody)) return reject('body', 'body_not_buffer');
    if (rawBody.length === 0) return reject('body', 'body_empty');

    // 3. The header: one text value of exactly 64 hexadecimal characters. A repeated header (an array), a number, an empty value, a wrong
    // length or a non-hex character is rejected here, before the secret is used.
    if (signatureHeader === undefined || signatureHeader === null || signatureHeader === '') return reject('signature', 'signature_missing');
    if (typeof signatureHeader !== 'string') return reject('signature', 'signature_malformed');
    if (signatureHeader.length !== SIGNATURE_LENGTH) return reject('signature', 'signature_wrong_length');
    if (!HEX.test(signatureHeader)) return reject('signature', 'signature_not_hex');

    // 4. HMAC-SHA256 of the raw bytes, compared in constant time with the signature decoded to bytes (both 32 bytes).
    const expected = crypto.createHmac('sha256', getWebhookSecret(env)).update(rawBody).digest();
    const provided = Buffer.from(signatureHeader, 'hex');
    if (provided.length !== expected.length) return reject('signature', 'signature_wrong_length');
    return crypto.timingSafeEqual(expected, provided) ? { ok: true } : reject('signature', 'signature_mismatch');
  } catch {
    // Nothing from the error is kept: its message could quote the secret or the body.
    return reject('error', 'verification_error');
  }
}

module.exports = { verifyWebhookSignature, SIGNATURE_LENGTH };
