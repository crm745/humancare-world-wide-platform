// Logging for the global error handler (app.js): useful for diagnosing a failure, and never
// a copy of what the patient submitted.
//
// Why `console.error(err)` is not safe on this API:
//   - a body-parser "entity.parse.failed" error carries the raw request body in `err.body`, and
//     its message and stack quote a piece of it;
//   - a Prisma validation error's message prints the whole failed call, including the data;
//   - any other error may carry the submitted values in its message, in `err.meta`, `err.cause`
//     or custom properties.
// So no error object is ever logged whole. One summary is written instead, made only from:
//   classification, name, a short safe code, HTTP status, method and path (no query string),
//   a few allow-listed metadata fields, the stack FRAMES (never the message part of the stack),
//   and, for non-Prisma errors only, the message with every value the request submitted
//   (body, query and params) replaced by [redacted], whitespace collapsed and cut at 300 chars.
// Prisma messages are dropped entirely: they are built from the data.
const BODY_PARSER_ERROR_TYPE = /^(entity|encoding|charset|request|stream|parameters)\./;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
// An error class name is an identifier; anything else in `name` is not trusted.
const SAFE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const REDACTED = '[redacted]';
const MAX_MESSAGE = 300;
const MAX_FRAMES = 8;
const MIN_REDACT_LENGTH = 3;
const MAX_REDACT_VALUES = 500;

const isBodyParserError = (err) => Boolean(err) && typeof err.type === 'string' && BODY_PARSER_ERROR_TYPE.test(err.type);

function classify(err) {
  if (isBodyParserError(err)) return 'body-parser';
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'PrismaClientValidationError') return 'prisma-validation';
  if (name === 'PrismaClientKnownRequestError') return 'prisma-known-request';
  if (name === 'PrismaClientInitializationError') return 'prisma-initialization';
  if (name === 'PrismaClientUnknownRequestError' || name === 'PrismaClientRustPanicError') return 'prisma-engine';
  if (name.startsWith('PrismaClient') || typeof err.clientVersion === 'string') return 'prisma-other';
  if (name === 'MulterError') return 'upload';
  return 'application';
}
const isPrisma = (classification) => classification.startsWith('prisma-');

const isError = (value) => value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
const safeToken = (value) => (typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined);
const safeNumber = (value) => (Number.isInteger(value) ? value : undefined);

// Every string the request submitted, so it can be struck out of a message that repeats it.
function submittedValues(req) {
  const found = new Set();
  const visit = (value, depth) => {
    if (found.size >= MAX_REDACT_VALUES || depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value.length >= MIN_REDACT_LENGTH) {
        found.add(value);
        // Messages often show a value JSON-escaped (\" and \n): strike out that form too.
        const escaped = JSON.stringify(value).slice(1, -1);
        if (escaped !== value) found.add(escaped);
      }
    } else if (typeof value === 'number') {
      const text = String(value);
      if (text.length >= 6) found.add(text);
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
    } else if (typeof value === 'object') {
      Object.values(value).forEach((item) => visit(item, depth + 1));
    }
  };
  if (req) [req.body, req.query, req.params].forEach((part) => visit(part, 0));
  return [...found];
}

function redactor(values) {
  if (!values.length) return (text) => text;
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(values.sort((a, b) => b.length - a.length).map(escape).join('|'), 'gi');
  return (text) => text.replace(pattern, REDACTED);
}

// The stack's "at ..." lines only. The first part of a stack is `${name}: ${message}`, which
// may hold submitted text (even a line that looks like a frame), so it is cut off by length,
// not by pattern. If the stack does not start that way, only the unbroken run of frame lines
// at its very end is used.
function stackFrames(err, redact) {
  if (typeof err.stack !== 'string') return [];
  const header = `${err.name}: ${err.message}`;
  let lines;
  if (err.stack.startsWith(header)) {
    lines = err.stack.slice(header.length).split('\n');
  } else {
    lines = err.stack.split('\n');
    let start = lines.length;
    while (start > 0 && /^\s+at /.test(lines[start - 1])) start -= 1;
    lines = lines.slice(start);
  }
  return lines.filter((line) => /^\s+at \S/.test(line)).slice(0, MAX_FRAMES).map((line) => redact(line.trim().slice(0, 300)));
}

// Names of the model, column or index involved: identifiers, never values.
function prismaMeta(err) {
  const meta = err && typeof err.meta === 'object' && err.meta ? err.meta : null;
  if (!meta) return undefined;
  const pick = {};
  for (const key of ['modelName', 'target', 'column', 'column_name', 'field_name', 'constraint']) {
    const value = meta[key];
    const token = Array.isArray(value) ? value.slice(0, 5).map(safeToken) : safeToken(value);
    if (Array.isArray(token) ? token.every(Boolean) && token.length : token) pick[key] = token;
  }
  return Object.keys(pick).length ? pick : undefined;
}

function logRequestError(req, err) {
  const where = { method: req && req.method, path: req && req.path };

  // Only real Error objects are inspected; any other thrown value (a string, a plain object with a
  // convincing-looking `name`...) could be the data itself, so only its type is logged.
  if (!isError(err)) {
    console.error('[request-error] a non-error value was thrown', { classification: 'non-error', valueType: typeof err, ...where });
    return;
  }

  const classification = classify(err);

  if (classification === 'body-parser') {
    console.error('[request-error] request body could not be read', {
      type: err.type,
      status: err.statusCode || err.status || 400,
      ...where,
      contentType: req && req.headers ? String(req.headers['content-type'] || '').split(';')[0].slice(0, 64) : undefined,
      contentLength: req && req.headers ? Number(req.headers['content-length']) || undefined : undefined,
    });
    return;
  }

  const redact = redactor(submittedValues(req));
  const summary = {
    classification,
    name: typeof err.name === 'string' && SAFE_NAME.test(err.name) ? err.name : undefined,
    code: safeToken(err.code) ?? safeNumber(err.errno),
    status: safeNumber(err.statusCode) ?? safeNumber(err.status),
    ...where,
  };
  if (isPrisma(classification)) {
    summary.clientVersion = safeToken(err.clientVersion);
    summary.meta = prismaMeta(err);
  } else if (typeof err.message === 'string') {
    summary.message = redact(err.message).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
  }
  if (err.cause && typeof err.cause === 'object') summary.cause = { name: typeof err.cause.name === 'string' && SAFE_NAME.test(err.cause.name) ? err.cause.name : undefined, code: safeToken(err.cause.code) };
  summary.frames = stackFrames(err, redact);

  console.error('[request-error]', summary);
}

// What the client is told when the body could not be read: never a quote from the body.
function publicBodyErrorMessage(err) {
  if (err && err.type === 'entity.parse.failed') return 'Malformed JSON request body.';
  if (err && err.type === 'entity.too.large') return 'Request body is too large.';
  return 'The request body could not be read.';
}

module.exports = { logRequestError, isBodyParserError, publicBodyErrorMessage };
