const express = require('express');
const { logRequestError, isBodyParserError, publicBodyErrorMessage } = require('./common/logging/safe-error-log');
const cors = require('cors');
const { createCorsOptions } = require('./common/security/cors-origins');
const { resolveTrustProxy } = require('./common/security/trust-proxy');
const { authRouter } = require('./modules/auth/auth.routes');
const { requestsRouter } = require('./modules/requests/requests.routes');
const { casesRouter } = require('./modules/cases/cases.routes');
const { notificationsRouter } = require('./modules/notifications/notifications.routes');
const { servicesRouter } = require('./modules/services/services.routes');
const { adminRouter } = require('./modules/admin/admin.routes');
const { geoRouter } = require('./modules/geo/geo.routes');
const { documentsRouter } = require('./modules/documents/documents.routes');
const { corporatePortalRouter } = require('./modules/corporate-portal/corporate-portal.routes');
const { bitrixInboundRouter } = require('./modules/bitrix/bitrix-inbound.controller');
const { corporateRegistrationRouter } = require('./modules/corporate-registration/corporate-registration.routes');

const app = express();
// Two response-header basics for every route: do not announce the framework, and never let a browser guess a content type.
app.disable('x-powered-by');
// Behind a reverse proxy, TRUST_PROXY says how many hops to trust so req.ip (the rate limiters) is the real client; unset = trust none (src/common/security/trust-proxy.js). A bad value stops the server at start.
const trustProxy = resolveTrustProxy(process.env);
if (trustProxy !== false) app.set('trust proxy', trustProxy);
else if (String(process.env.NODE_ENV).toLowerCase() === 'production') console.warn('TRUST_PROXY is not set: client IPs are taken from the socket. Behind a reverse proxy set TRUST_PROXY (for example 1) or every user shares one rate-limit budget.');
app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

// What a failed request is allowed to leave in the log: the error's name and code, the status and
// the method and path - nothing else. Never the message, stack, query arguments (Prisma errors
// embed them), request body, headers or tokens. Names and codes must look like identifiers, so a
// crafted value cannot smuggle text into the line.
// Admin routes (/admin/**) are logged with this minimal line only - not even a redacted message, which
// the general logger (common/logging/safe-error-log.js) includes for the other routes.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const isAdminPath = (req) => req.path === '/admin' || String(req.path).startsWith('/admin/');
function logAdminRequestError(err, req, status) {
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
// Browsers may call this API (with credentials) only from an allow-listed origin: CORS_ALLOWED_ORIGINS and the configured portal addresses; local development origins only outside production.
// Requests without an Origin header (the native mobile app, server calls) are unaffected. See src/common/security/cors-origins.js.
app.use(cors(createCorsOptions(process.env)));
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
// the body (which may hold a password or ticket), so it is never sent or logged. Admin routes answer
// with a code (`invalid_json`) and nothing is logged for them; every other route falls through to the
// global error handler below, which answers with its own fixed message and logs only the safe summary.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed' && isAdminPath(req)) {
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
app.use('/geo', geoRouter);
app.use('/corporate/cases', casesRouter);
app.use('/corporate', corporatePortalRouter);
app.use('/corporates', corporateRegistrationRouter);
app.use('/notifications', notificationsRouter);
app.use('/admin', adminRouter);
// Bitrix24 event handler (own token authentication, no JWT): receipt only, see bitrix-inbound.controller.js.
app.use('/integrations/bitrix', bitrixInboundRouter);
app.use('/documents', documentsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
// error handling middleware
app.use((err, req, res, next) => {
  const isUploadError = err.name === 'MulterError' || /Unsupported file type/.test(err.message || '');
  const status = err.statusCode || (isUploadError ? 400 : 500);
  // Never console.error(err): a broken-JSON error carries the raw request body (patient data).
  if (isAdminPath(req)) logAdminRequestError(err, req, status);
  else logRequestError(req, err);
  // `publicCode` is set deliberately by the code that throws (never a Prisma/system code),
  // so clients can branch on it without parsing the message.
  res.status(status).json({
    // A body-reading error's own message can quote the body (broken JSON): say it generically.
    error: status === 500 ? 'Internal server error' : isBodyParserError(err) ? publicBodyErrorMessage(err) : err.message,
    ...(status !== 500 && err.publicCode && { code: err.publicCode }),
  });
});

module.exports = { app };
