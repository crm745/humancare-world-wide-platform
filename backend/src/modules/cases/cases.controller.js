const {
  listCasesForCorporate,
  getCaseById,
  createCaseByCorporate,
} = require('./cases.service');
const { addDocumentToCase } = require('../documents/documents.service');
const { scanBeforeStore } = require('../documents/legacy-scan');
const { toSafeDocument } = require('../documents/document-response');
const { sendMedicalReportToBitrix } = require('../bitrix/bitrix.service');
const { ingestUpload, validateUpload, discardStored, discardTemp } = require('../../storage/ingest');
const { AREAS } = require('../../storage/keys');

async function listMyCases(req, res, next) {
  try {
    const cases = await listCasesForCorporate(req.user.corporateId, { status: req.query.status });
    res.json({ cases });
  } catch (err) {
    next(err);
  }
}

async function getCase(req, res, next) {
  try {
    const caseRecord = await getCaseById(req.params.id);
    if (caseRecord.corporateId !== req.user.corporateId) {
      return res.status(403).json({ error: 'This case was not submitted by your organization.' });
    }
    res.json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}

async function createCase(req, res, next) {
  try {
    const { patientName, serviceType, origin, destination } = req.body;
    if (!patientName || !serviceType || !origin || !destination) {
      return res.status(400).json({ error: 'patientName, serviceType, origin and destination are required' });
    }
    const caseRecord = await createCaseByCorporate(req.user.corporateId, req.body);
    res.status(201).json({ case: caseRecord });
  } catch (err) {
    next(err);
  }
}

async function uploadCaseDocument(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    let stored = null;
    let document;
    let caseRecord;
    try {
      caseRecord = await getCaseById(req.params.id);
      if (caseRecord.corporateId !== req.user.corporateId) {
        await discardTemp(req.file);
        return res.status(403).json({ error: 'This case was not submitted by your organization.' });
      }
      // Scan before store (documents/legacy-scan.js: infected 422 and quarantined; scanner down or no verdict 503, deleted), then checked and moved into the storage service under a generated key.
      await validateUpload(req.file, { policy: 'organization' }); // type, structure (a .doc is refused) before anything is scanned or stored
      const scan = await scanBeforeStore(req.file);
      stored = await ingestUpload({ file: req.file, area: AREAS.CASE_DOCUMENTS, scan: 'deferred', policy: 'organization' });
      if (stored.sha256 !== scan.sha256) throw Object.assign(new Error('The stored file is not the one that was scanned.'), { statusCode: 503, publicCode: 'scan_unavailable' });
      document = await addDocumentToCase(caseRecord.id, { type: req.body.type, name: req.file.originalname, fileUrl: stored.key, fileSizeBytes: stored.size,
        // the row's clean scan record: the verdict and the digest of exactly the bytes that were stored
        scan });
    } catch (err) {
      await discardTemp(req.file);
      if (stored) await discardStored(stored.key);
      throw err;
    }
    // Other document types (passport, ID…) have their own Bitrix fields; only the report is mapped so far.
    if (document.type === 'Medical Report') await sendMedicalReportToBitrix(caseRecord.bitrixLeadId, document);
    // `document` was read in full (the Bitrix24 step above needs its fileUrl); the client gets the safe fields only.
    res.status(201).json({ document: toSafeDocument(document) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMyCases, getCase, createCase, uploadCaseDocument };
