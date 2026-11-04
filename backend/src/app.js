const express = require('express');
const cors = require('cors');
const { authRouter } = require('./modules/auth/auth.routes');
const { requestsRouter } = require('./modules/requests/requests.routes');
const { casesRouter } = require('./modules/cases/cases.routes');
const { notificationsRouter } = require('./modules/notifications/notifications.routes');
const { servicesRouter } = require('./modules/services/services.routes');
const { adminRouter } = require('./modules/admin/admin.routes');
const { documentsRouter } = require('./modules/documents/documents.routes');
const { corporatePortalRouter } = require('./modules/corporate-portal/corporate-portal.routes');
const { corporateRegistrationRouter } = require('./modules/corporate-registration/corporate-registration.routes');

const app = express();

// What a failed request is allowed to leave in the log: the error's name and code, the status and
// the method and path - nothing else. Never the message, stack, query arguments (Prisma errors
// embed them), request body, headers or tokens. Names and codes must look like identifiers, so a
// crafted value cannot smuggle text into the line.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
function logRequestError(err, req, status) {
  const safe = (value) => (typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : undefined);
  const meta = {
    name: safe(err && err.name) || 'Error',
    code: safe(err && err.code),
    status,
    method: req.method,
    path: String(req.path || '').slice(0, 200),
  };
  console.error(`Request failed: ${JSON.stringify(meta)}`);
}
// `origin: true` reflects the caller's own Origin back (same effective permissiveness
// as the old wildcard) — required because `credentials: true` is incompatible with a
// literal '*' origin, and the admin portal's cookie-based session needs credentials
// allowed cross-origin (it's served from a different port than this API).
app.use(cors({ origin: true, credentials: true }));
// The global 100 KB limit (the parser's default) is unchanged. `verify` runs on the raw bytes
// before they are parsed; it records only their COUNT, so routes with a tighter limit (see
// maxBodyBytes in admin-auth.validation.js) can enforce it on the bytes actually received - also
// for chunked bodies, which carry no Content-Length. The raw body itself is never kept.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBodyBytes = buf.length;
  },
}));
// A body that is not valid JSON gets one fixed answer. The parser's own message can quote part of
// the body (which may hold a password or ticket), so it is never sent or logged.
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    res.set('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Malformed JSON body', code: 'invalid_json' });
  }
  return next(err);
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// Uploaded files (medical reports, etc.) are never served as static files — every
// download goes through documentsRouter, which checks the requester actually owns
// the document before streaming it. See documents.controller.js.
app.use('/auth', authRouter);
app.use('/services', servicesRouter);
app.use('/requests', requestsRouter);
app.use('/corporate/cases', casesRouter);
app.use('/corporate', corporatePortalRouter);
app.use('/corporates', corporateRegistrationRouter);
app.use('/notifications', notificationsRouter);
app.use('/admin', adminRouter);
app.use('/documents', documentsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
// error handling middleware
app.use((err, req, res, next) => {
  const isUploadError = err.name === 'MulterError' || /Unsupported file type/.test(err.message || '');
  const status = err.statusCode || (isUploadError ? 400 : 500);
  logRequestError(err, req, status);
  // `publicCode` is set deliberately by the code that throws (never a Prisma/system code),
  // so clients can branch on it without parsing the message.
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    ...(status !== 500 && err.publicCode && { code: err.publicCode }),
  });
});

module.exports = { app };
