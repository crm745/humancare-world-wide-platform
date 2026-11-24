// Spawns the EXISTING, UNMODIFIED scripts/synthetic-mark.js as a child process, exactly as its own
// header documents. This file contains no marker-issuing logic of its own — every safeguard (owner
// isolation, 6h request age, unique ownership, ZZ-SYNTHETIC name, no Bitrix footprint, admin exists,
// active-mark limit) is enforced by that script and the marker module it calls, both untouched.
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'synthetic-mark.js');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

class MarkerIssuanceError extends Error {
  constructor(message, code, output) {
    super(message);
    this.name = 'MarkerIssuanceError';
    this.code = code;
    this.output = output;
  }
}

// { ok: true, output } | throws MarkerIssuanceError. Never passes ALLOW_SYNTHETIC_MARKING to any
// other process; it is set only in this child's environment.
function issueMarker({ requestId, ownerId, adminId, runId, documents = 1, timeoutMs = 20000 }) {
  const args = [SCRIPT_PATH, String(requestId), '--owner-id', String(ownerId), '--admin-id', String(adminId), '--run-id', runId, '--documents', String(documents)];
  let output;
  try {
    output = execFileSync('node', args, {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ALLOW_SYNTHETIC_MARKING: 'true' },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  } catch (err) {
    const stdout = (err.stdout || '').toString().trim();
    throw new MarkerIssuanceError(`synthetic-mark.js refused or failed: ${stdout || err.message}`, 'marker_refused', stdout);
  }
  const trimmed = output.trim();
  if (!/:\s*marked\s*$/.test(trimmed)) throw new MarkerIssuanceError(`unexpected synthetic-mark.js output: ${trimmed}`, 'marker_unexpected_output', trimmed);
  return { ok: true, output: trimmed };
}

module.exports = { issueMarker, MarkerIssuanceError, SCRIPT_PATH };
