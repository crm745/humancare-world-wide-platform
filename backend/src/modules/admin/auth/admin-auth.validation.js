// Strict request-body validation for the Admin authentication endpoints. Every check is on type,
// shape and length only: the services decide what is acceptable (password policy, ticket and
// credential validity). Unknown fields are refused, and a failure never says which field was wrong
// or repeats anything the caller sent.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url - the same shape the services accept
const MAX_PASSWORD_CHARS = 1024; // the services refuse anything over 72 bytes; this only bounds the work
const MAX_EMAIL_CHARS = 254;
const MAX_TICKET_CHARS = 2048;
const MAX_LABEL_CHARS = 200; // the service truncates to its own, shorter, limit
// Large enough for the biggest legitimate WebAuthn body (about 45 KB), well under the 100 KB parser cap.
const MAX_WEBAUTHN_BODY_BYTES = 64 * 1024;

class RequestValidationError extends Error {
  constructor() {
    super('Invalid request');
    this.name = 'RequestValidationError';
    this.code = 'invalid_request';
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The parsed JSON body, as an object whose keys are all in `allowed`. (Express 5 leaves req.body
// undefined when no JSON was sent.)
function bodyOf(req, allowed) {
  const body = req.body;
  if (!isPlainObject(body)) throw new RequestValidationError();
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new RequestValidationError();
  return body;
}

function text(value, { min, max }) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new RequestValidationError();
  return value;
}

const token = (value) => {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new RequestValidationError();
  return value;
};

const objectField = (value) => {
  if (!isPlainObject(value)) throw new RequestValidationError();
  return value;
};

function validateInspect(req) {
  const body = bodyOf(req, ['token']);
  return { token: token(body.token) };
}

// An empty password is allowed through to the service, which answers it with its own weak_password.
function validateAccept(req) {
  const body = bodyOf(req, ['token', 'password']);
  return { token: token(body.token), password: text(body.password, { min: 0, max: MAX_PASSWORD_CHARS }) };
}

function validateRedeem(req) {
  const body = bodyOf(req, ['token', 'password']);
  return { token: token(body.token), password: text(body.password, { min: 1, max: MAX_PASSWORD_CHARS }) };
}

function validateRegistrationOptions(req) {
  const body = bodyOf(req, ['ticket']);
  return { ticket: text(body.ticket, { min: 1, max: MAX_TICKET_CHARS }) };
}

function validateRegistrationVerify(req) {
  const body = bodyOf(req, ['ticket', 'response', 'label']);
  const label = body.label === undefined || body.label === null ? undefined : text(body.label, { min: 0, max: MAX_LABEL_CHARS });
  return { ticket: text(body.ticket, { min: 1, max: MAX_TICKET_CHARS }), response: objectField(body.response), label };
}

function validateLoginPassword(req) {
  const body = bodyOf(req, ['email', 'password']);
  return {
    email: text(body.email, { min: 1, max: MAX_EMAIL_CHARS }),
    password: text(body.password, { min: 1, max: MAX_PASSWORD_CHARS }),
  };
}

function validateLoginPasskey(req) {
  const body = bodyOf(req, ['loginTicket', 'response']);
  return { loginTicket: text(body.loginTicket, { min: 1, max: MAX_TICKET_CHARS }), response: objectField(body.response) };
}

// ---- recovery endpoints -------------------------------------------------------------------------

const MAX_REASON_CHARS = 500; // the service applies its own, exact rules (VARCHAR(500), no control characters)

// The request id from the path: a plain positive whole number that fits a 32-bit column.
function validateRecoveryRequestId(req) {
  const raw = req.params && req.params.id;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new RequestValidationError();
  return Number(raw);
}

// Step-up endpoints take no body at all: who the caller is and which request it is come from the
// session and the path, never from the body.
function validateNoBody(req) {
  const body = req.body;
  if (body === undefined) return;
  if (!isPlainObject(body) || Object.keys(body).length > 0) throw new RequestValidationError();
}

// A decision: the passkey assertion and an optional reason. No admin id, session id or request id.
function validateRecoveryDecision(req) {
  const body = bodyOf(req, ['response', 'reason']);
  const reason = body.reason === undefined || body.reason === null ? undefined : text(body.reason, { min: 0, max: MAX_REASON_CHARS });
  return { response: objectField(body.response), reason };
}

// A route-specific body limit, tighter than the global 100 KB JSON parser. It enforces the limit
// on the number of bytes the parser actually read (req.rawBodyBytes, recorded by the parser's
// `verify` hook in app.js), so it holds for chunked bodies and for requests with no or a wrong
// Content-Length. A declared Content-Length over the limit is refused too, as an early exit.
// Anything over 100 KB never gets here: the global parser answers 413 first.
function maxBodyBytes(limit = MAX_WEBAUTHN_BODY_BYTES) {
  return function bodyLimit(req, res, next) {
    const declared = Number(req.headers['content-length']);
    const received = req.rawBodyBytes;
    if ((Number.isFinite(declared) && declared > limit) || (Number.isInteger(received) && received > limit)) {
      return res.status(413).json({ error: 'Request body too large', code: 'payload_too_large' });
    }
    return next();
  };
}

module.exports = {
  RequestValidationError,
  validateInspect,
  validateAccept,
  validateRedeem,
  validateRegistrationOptions,
  validateRegistrationVerify,
  validateLoginPassword,
  validateLoginPasskey,
  validateRecoveryRequestId,
  validateNoBody,
  validateRecoveryDecision,
  maxBodyBytes,
  MAX_WEBAUTHN_BODY_BYTES,
};
