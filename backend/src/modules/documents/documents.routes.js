const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { downloadDocument } = require('./documents.controller');

const documentsRouter = Router();

// No role restriction here — a patient can only reach their own documents and a
// corporate only theirs, enforced inside getDocumentForUser, not by role alone.
documentsRouter.get('/:id/file', requireAuth(), downloadDocument);

module.exports = { documentsRouter };
