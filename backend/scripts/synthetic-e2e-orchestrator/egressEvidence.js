// Append-only evidence log shared by every guarded process of one synthetic E2E run (JSON lines). A guard records what it
// saw (guard installed, self-test passed, a destination it blocked, a module/native load it refused); the orchestrator
// reads the file back to decide whether isolation held. A record never contains a secret, a URL, a path with a query, a
// header or a body - only the kind of event, the role, the pid and the destination HOST or ADDRESS that was blocked.
const fs = require('fs');

const ENV_EVIDENCE = 'HC_EGRESS_EVIDENCE';

function record(file, event) {
  if (!file) return;
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n';
  try {
    fs.appendFileSync(file, line);
  } catch {
    // Evidence that cannot be written is itself reported by the orchestrator (a guard that never reports "installed"
    // fails the gate), so a write failure here must not take the guarded process down by throwing inside a socket call.
  }
}

function readAll(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { records.push({ kind: 'unreadable_record' }); }
  }
  return records;
}

// Kinds that are a PROOF the guard is installed and working (written once per process, at startup).
const READY_KINDS = ['guard_installed', 'guard_selftest_passed'];
// Kinds that are violations: something tried to leave through a blocked path. Each one fails the run.
const VIOLATION_KINDS = ['blocked_connect', 'blocked_dns', 'blocked_dgram', 'blocked_fetch', 'blocked_child_process', 'blocked_worker_thread', 'blocked_native_module', 'blocked_module_load', 'unreadable_record', 'identity_failed', 'guard_selftest_failed'];

function summarize(records, roles) {
  const byRole = {};
  for (const role of roles) byRole[role] = { installed: false, selftest: false, identity: role === 'api' ? false : null };
  const violations = [];
  for (const r of records) {
    if (r.role && byRole[r.role]) {
      if (r.kind === 'guard_installed') byRole[r.role].installed = true;
      if (r.kind === 'guard_selftest_passed') byRole[r.role].selftest = true;
      if (r.kind === 'database_identity_ok') byRole[r.role].identity = true;
    }
    if (VIOLATION_KINDS.includes(r.kind)) violations.push(r);
  }
  return { byRole, violations };
}

module.exports = { ENV_EVIDENCE, READY_KINDS, VIOLATION_KINDS, record, readAll, summarize };
