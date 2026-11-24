// Read-only OS process introspection (Windows) for the synthetic E2E orchestrator.
//
// Used to (a) detect whether the general-purpose worker (src/worker.js, which schedules every
// Bitrix-capable job: bitrix-retry, bitrix-deal, bitrix-deal-inbox, bitrix-deal-reconcile,
// bitrix-deal-document, bitrix-quotation) is running — which must never be true during a synthetic
// E2E run — and (b) verify whether a PID recorded in a phone-lock or firewall-manifest file is still
// alive, for crash-safe recovery.
//
// Nothing here starts, stops, or modifies any process; it only lists and inspects. Enumeration
// failures (PowerShell unavailable, WMI denied, timeout) are never treated as "nothing is running":
// every caller fails closed on an enumeration failure.
const { execFileSync } = require('child_process');

const PS_TIMEOUT_MS = 15000;

class ProcessGuardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProcessGuardError';
    this.code = code;
  }
}

function runPowerShellJson(command) {
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new ProcessGuardError(`process enumeration failed: ${err.message}`, 'enumeration_failed');
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProcessGuardError('process enumeration returned unreadable output', 'enumeration_unreadable');
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Every node.exe process currently visible to this account, with its full command line. Throws
// (never silently returns "nothing found") when the enumeration itself could not be trusted.
function listNodeProcesses() {
  const rows = runPowerShellJson(
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
  );
  return rows.filter((r) => r && r.ProcessId != null).map((r) => ({ pid: Number(r.ProcessId), commandLine: String(r.CommandLine || '') }));
}

// The general-purpose worker's entry file, and the dedicated worker's (whose own path also contains
// "worker.js", so it must be excluded explicitly rather than relying on a single pattern).
const GENERAL_WORKER_PATTERN = /(^|[\\/])src[\\/]worker\.js\b/i;
const DEDICATED_WORKER_PATTERN = /synthetic-e2e-worker\.js/i;

// { running: boolean, matches: [{pid, commandLine}] }
function generalWorkerStatus() {
  const processes = listNodeProcesses();
  const matches = processes.filter((p) => GENERAL_WORKER_PATTERN.test(p.commandLine) && !DEDICATED_WORKER_PATTERN.test(p.commandLine));
  return { running: matches.length > 0, matches };
}

function dedicatedWorkerStatus() {
  const processes = listNodeProcesses();
  const matches = processes.filter((p) => DEDICATED_WORKER_PATTERN.test(p.commandLine));
  return { running: matches.length > 0, matches };
}

// Is `pid` alive right now, and if so, is it a node.exe process? Used for phone-lock and firewall-
// manifest staleness checks — never guesses: a failed check throws (ProcessGuardError), and callers
// must treat that as "ownership cannot be established" (fail closed), never as "the PID is free".
function processState(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) throw new ProcessGuardError('invalid pid', 'invalid_pid');
  const rows = runPowerShellJson(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${numericPid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`,
  );
  if (!rows.length) return { alive: false };
  const row = rows[0];
  return { alive: true, isNode: String(row.Name || '').toLowerCase() === 'node.exe' };
}

module.exports = {
  ProcessGuardError, listNodeProcesses, generalWorkerStatus, dedicatedWorkerStatus, processState,
  GENERAL_WORKER_PATTERN, DEDICATED_WORKER_PATTERN,
};
