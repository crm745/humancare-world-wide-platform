const { Router } = require('express');
const { requireAuth } = require('../../common/middleware/auth.middleware');
const { upload } = require('../../middleware/upload.middleware');
const {
  listMyCases,
  getCase,
  createCase,
  uploadCaseDocument,
} = require('./cases.controller');

const casesRouter = Router();

// Insurance/Government/Corporate corporates submit on behalf of someone they cover, and
// track it — they don't claim or work cases themselves. See cases.service.js.
casesRouter.get('/', requireAuth(['corporate']), listMyCases);
casesRouter.get('/:id', requireAuth(['corporate']), getCase);
casesRouter.post('/', requireAuth(['corporate']), createCase);
casesRouter.post('/:id/documents', requireAuth(['corporate']), upload.single('file'), uploadCaseDocument);

module.exports = { casesRouter };
