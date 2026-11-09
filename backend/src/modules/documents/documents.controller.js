const path = require('path');
const { getDocumentForUser } = require('./documents.service');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const { findWorkflowSource, assertCaseDocumentServable, readVerifiedFile } = require('../request-review/request-review.files');

async function downloadDocument(req, res, next) {
  try {
    // Ownership (the patient, or the corporate the Case is assigned to) is checked first, as ever.
    const document = await getDocumentForUser(req.params.id, req.user);
    const filename = path.basename(document.fileUrl); // fileUrl is "/uploads/<filename>"

    // A file that came through the request-first review workflow is owned by a request_documents row
    // (found by its unique storage key). It is served only if that row is linked to THIS document, was
    // scanned clean and approved, and the file is still byte-identical to what was scanned; the bytes sent
    // are the ones that were checked. A missing or altered file is refused.
    const source = await findWorkflowSource(document.fileUrl);
    if (source) {
      assertCaseDocumentServable(source, document);
      const buffer = await readVerifiedFile(source);
      res.set('X-Content-Type-Options', 'nosniff');
      res.attachment(document.name);
      return res.send(buffer);
    }

    // Every other document is a legacy one, from before the workflow: it has no scan or checksum data
    // and is served exactly as it always was. Having no such data is not a reason to refuse it.
    return res.download(path.join(UPLOAD_DIR, filename), document.name);
  } catch (err) {
    next(err);
  }
}

module.exports = { downloadDocument };
