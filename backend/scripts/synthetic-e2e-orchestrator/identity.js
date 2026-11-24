// Pure generator of a unique synthetic test identity and run identifier. No I/O, no database, no
// network — fully unit-testable.
const crypto = require('crypto');

// A run id is used in firewall rule names, phone-lock file names, and the marker's --run-id, so it
// must satisfy synthetic-e2e-marker.js's RUN_ID pattern: /^[A-Za-z0-9_-]{3,40}$/.
function generateRunId(now = Date.now) {
  const stamp = new Date(now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const random = crypto.randomBytes(4).toString('hex');
  return `e2e-${stamp}-${random}`;
}

// The ZZ-SYNTHETIC name prefix is required by both synthetic-mark.js (LIMITS.NAME_PREFIX) and
// synthetic-approval.js (requestProblem's not_synthetic check). The runId is embedded in the name,
// email and mobile so ownership can always be proven later (cleanup, phone-lock recovery) without
// a lookup table.
function buildIdentity(runId, phoneNumber) {
  if (typeof phoneNumber !== 'string' || !phoneNumber) throw new Error('buildIdentity requires a phone number from the configured test pool');
  const shortRun = runId.replace(/[^A-Za-z0-9]/g, '').slice(-16);
  return {
    runId,
    firstName: 'ZZ-SYNTHETIC',
    lastName: shortRun,
    patientName: `ZZ-SYNTHETIC ${shortRun}`,
    email: `zz-synthetic+${shortRun}@e2e-orchestrator.invalid`,
    mobile: phoneNumber,
    password: `Synth-${crypto.randomBytes(9).toString('base64url')}-1!`,
  };
}

module.exports = { generateRunId, buildIdentity };
