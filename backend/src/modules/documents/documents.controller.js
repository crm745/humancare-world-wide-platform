const path = require('path');
const { getDocumentForUser } = require('./documents.service');
const { UPLOAD_DIR } = require('../../middleware/upload.middleware');
const { findWorkflowSource, assertCaseDocumentServable, readVerifiedFile, httpError } = require('../request-review/request-review.files');
const { isScanClean, isKnownUnsafe, ownerDownloadGateEnabled } = require('./document-scan');

// Who the document's OWNER is: the patient whose request produced the Case, or, for a Case a corporate created itself (no request behind it), that corporate. Anyone else with access
// (a corporate that was given a patient's Case) is a different party.
function isOwner(document, user) {
  const request = document.case && document.case.serviceRequest;
  if (user.role === 'patient') return !!request && request.userId === user.id;
  if (user.role === 'corporate') return !request;
  return false;
}

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

    // Every other document is a legacy one (documents/document-scan.js). What may be served depends on its scan record and on who asks:
    //   infected or failed   nobody: the file is known to be dangerous or cannot be verified at all
    //   clean                its owner, and anyone else with access
    //   anything else (never scanned, pending, error)
    //                        NOT a different party (a corporate holding a patient's Case): refused until a clean scan is confirmed.
    //                        The owner keeps their own older documents for now (the approved temporary behaviour); LEGACY_DOCUMENT_OWNER_GATE=true, once the backfill has finished, requires
    //                        a clean scan of them too.
    if (isKnownUnsafe(document)) throw httpError(409, 'This document cannot be opened: it failed the virus scan or could not be verified.', 'document_not_clean');
    if (!isScanClean(document) && (!isOwner(document, req.user) || ownerDownloadGateEnabled())) {
      throw httpError(409, 'This document cannot be opened yet: it has not been scanned for viruses.', 'document_not_scanned');
    }
    // The browser must not guess a different type than the one sent (shared by every service; the workflow branch above already did this).
    res.set('X-Content-Type-Options', 'nosniff');
    return res.download(path.join(UPLOAD_DIR, filename), document.name, { dotfiles: 'allow' });
  } catch (err) {
    next(err);
  }
}

module.exports = { downloadDocument };
