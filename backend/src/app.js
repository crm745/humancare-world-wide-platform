const express = require('express');
const { logRequestError, isBodyParserError, publicBodyErrorMessage } = require('./common/logging/safe-error-log');
const cors = require('cors');
const { authRouter } = require('./modules/auth/auth.routes');
const { requestsRouter } = require('./modules/requests/requests.routes');
const { casesRouter } = require('./modules/cases/cases.routes');
const { notificationsRouter } = require('./modules/notifications/notifications.routes');
const { servicesRouter } = require('./modules/services/services.routes');
const { adminRouter } = require('./modules/admin/admin.routes');
const { geoRouter } = require('./modules/geo/geo.routes');
const { documentsRouter } = require('./modules/documents/documents.routes');
const { corporatePortalRouter } = require('./modules/corporate-portal/corporate-portal.routes');
const { corporateRegistrationRouter } = require('./modules/corporate-registration/corporate-registration.routes');

const app = express();
// `origin: true` reflects the caller's own Origin back (same effective permissiveness
// as the old wildcard) — required because `credentials: true` is incompatible with a
// literal '*' origin, and the admin portal's cookie-based session needs credentials
// allowed cross-origin (it's served from a different port than this API).
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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
app.use('/documents', documentsRouter);

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
// error handling middleware
app.use((err, req, res, next) => {
  // Not console.error(err): a broken-JSON error carries the raw request body (patient data).
  logRequestError(req, err);
  const isUploadError = err.name === 'MulterError' || /Unsupported file type/.test(err.message || '');
  const status = err.statusCode || (isUploadError ? 400 : 500);
  // `publicCode` is set deliberately by the code that throws (never a Prisma/system code),
  // so clients can branch on it without parsing the message.
  res.status(status).json({
    // A body-reading error's own message can quote the body (broken JSON): say it generically.
    error: status === 500 ? 'Internal server error' : isBodyParserError(err) ? publicBodyErrorMessage(err) : err.message,
    ...(status !== 500 && err.publicCode && { code: err.publicCode }),
  });
});

module.exports = { app };
