// The scan record of a legacy `documents` row (the original document path: attached to a Case). Phase 5, legacy-document scan protection.
//
//   scan_status  NULL        a document from before scanning existed: NEVER scanned. It is treated as NOT clean everywhere it matters (below).
//                'pending'   a backfill has claimed it and is scanning it right now (or crashed: the lease then expires and it is picked up again)
//                'clean'     a confirmed clean ClamAV verdict, for the exact bytes with the recorded sha256. New uploads are stored ONLY with this (legacy-scan.js scan-before-store);
//                            documents copied from the review workflow inherit it from their source; the backfill sets it for older files.
//                'infected'  ClamAV found something: the file was moved to quarantine, never deleted
//                'error'     no verdict (scanner down, timeout, file changed while scanned): retried with bounded backoff
//                'failed'    can never be scanned (file missing or unreadable, or the retries are used up): final, needs a human
// Only 'clean' is ever "clean". A document is never marked clean without a confirmed successful scan.
//
// WHERE IT IS ENFORCED
//   Bitrix24 medical reports  never sent unless clean: the shared sender (bitrix.service.js) and therefore every caller, the retry sweep included
//   corporate downloads       a corporate that is NOT the document's owner (a Case that came from a patient's request) is served only a clean document
//   patient-owner downloads   the owner's access to their own OLDER documents is preserved for now, except those known infected or unusable. When the backfill has finished, setting
//                             LEGACY_DOCUMENT_OWNER_GATE=true requires 'clean' for owners too. It is OFF unless the value is exactly "true".
const CLEAN = 'clean';
const INFECTED = 'infected';
const FAILED = 'failed';

const isScanClean = (document) => !!document && document.scanStatus === CLEAN;

// Statuses that are never served to anyone, whatever the owner gate says: the file is known to be dangerous or cannot be verified at all.
const isKnownUnsafe = (document) => !!document && (document.scanStatus === INFECTED || document.scanStatus === FAILED);

// The switch for patient-owner downloads. OFF (the approved temporary behaviour) unless it says exactly "true", like the Bitrix switches.
const ownerDownloadGateEnabled = (env = process.env) => env.LEGACY_DOCUMENT_OWNER_GATE === 'true';

// What a new row stores after a CONFIRMED clean verdict: `scan` is what legacy-scan.js scanBeforeStore (or the review workflow) established.
function cleanScanRecord(scan) {
  if (!scan || !scan.sha256 || !scan.engine) throw new Error('A clean scan record needs the file digest and the scanner that confirmed it.');
  return { sha256: scan.sha256, scanStatus: CLEAN, scanEngine: scan.engine, scannedAt: scan.scannedAt || new Date() };
}

module.exports = { CLEAN, INFECTED, FAILED, isScanClean, isKnownUnsafe, ownerDownloadGateEnabled, cleanScanRecord };
