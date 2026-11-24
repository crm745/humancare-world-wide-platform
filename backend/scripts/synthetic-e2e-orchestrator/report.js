// Structured execution report: run id, request id, Case id, checks, failures and timestamps — never
// PII (no patient name/email/phone, even synthetic ones, beyond the opaque runId) and never a secret
// (no token, no webhook URL, no password).
const fs = require('fs');
const path = require('path');

const NETWORK_LIMITATIONS_NOTE = [
  'Network isolation - what is proven vs. disclosed:',
  'ENFORCED IN-PROCESS (not by the operating system): the isolated API and the dedicated worker were started by this',
  'orchestrator with a sanitized environment (Bitrix sync off, every Bitrix/SMTP/payment credential blank, local storage)',
  'and an egress guard loaded before any application code; the guard blocks Bitrix names and addresses on every JavaScript',
  'transport (net/tls, http/https, fetch/undici, dns, dgram), refuses child processes, worker threads and unknown native',
  'modules, and loads no general worker or Bitrix job module. The browser ran through a local filtering proxy with service',
  'workers blocked. Each guard ran a self-test before registration and recorded its evidence; the run fails on any',
  'recorded violation. No Windows Firewall rule was created.',
  'DISCLOSED, NOT CLAIMED: this is not kernel-level isolation. Native code inside an allowed module (the Prisma query engine,',
  'which only connects to the loopback MySQL server) opens sockets outside JavaScript and cannot be intercepted; a future',
  'code change could add a transport the guard does not know (the module and native-load tripwires and the self-tests are',
  'the regression guards for that). Windows Firewall cannot scope a rule to one process, so no OS-level equivalent exists',
  'without administrator-created per-user rules.',
].join(' ');

function buildReport({ runId, startedAt, preflight, submission, scan, marker, approval, verification, isolation, cleanup, failures = [] }) {
  return {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    requestId: submission ? submission.requestId : null,
    requestReference: submission ? submission.referenceNumber : null,
    caseId: verification ? verification.caseId : null,
    caseReference: verification ? verification.caseReference : null,
    preflight: preflight || null,
    scan: scan ? { documents: (scan || []).map((d) => ({ id: d.id, scanStatus: d.scanStatus })) } : null,
    marker: marker ? { issued: !!marker.ok, output: marker.output } : null,
    approval: approval ? { reviewStatus: approval.reviewStatus } : null,
    verification: verification ? { ok: verification.ok, checks: verification.checks } : null,
    isolation: isolation || null,
    networkIsolationLimitations: NETWORK_LIMITATIONS_NOTE,
    cleanup: cleanup || null,
    failures,
    overallOutcome: failures.length === 0 && (!verification || verification.ok) ? 'passed' : 'failed',
  };
}

function writeReport(reportDir, runId, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

// The --gate-only report: what was started, what each check observed, and - explicitly - everything that did NOT run.
const GATE_ONLY_NOT_EXECUTED = [
  'phone lock acquisition', 'Playwright / Chromium launch', 'the registration form and patient registration or submission',
  'creation or modification of requests, cases, documents, markers or approval records',
  'the document-scan job', 'the synthetic-approval job', 'any scheduled or run-on-start worker job',
];
const GATE_ONLY_EXECUTED = [
  'configuration and environment validation (backend/.env read in memory only)',
  'preflight: database identity (SELECT DATABASE()) and ClamAV TCP reachability', 'port and process-ownership checks',
  'egress guard self-tests (API, worker, orchestrator) and the browser-proxy canary (raw CONNECT, no browser)',
  'web bundle verification (no rebuild when reused)',
  'isolated API start: its own SELECT DATABASE() before listening; server start-up read-only SELECTs on the geonames tables; GET /health',
  'dedicated worker start in READINESS-ONLY mode: its own SELECT DATABASE(); then idle',
];

function buildGateReport({ runId, startedAt, preflight, isolation, failures = [] }) {
  const gate = isolation ? isolation.gate : null;
  const passed = failures.length === 0 && !!gate && gate.every((c) => c.ok);
  return {
    mode: 'gate-only',
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: passed ? 'gate_passed' : 'gate_failed',
    preflight: preflight || null,
    isolation: isolation || null,
    gate,
    executed: GATE_ONLY_EXECUTED,
    notExecuted: GATE_ONLY_NOT_EXECUTED,
    networkIsolationLimitations: NETWORK_LIMITATIONS_NOTE,
    failures,
  };
}

function writeGateReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'gate-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

module.exports = { buildReport, writeReport, buildGateReport, writeGateReport, GATE_ONLY_NOT_EXECUTED, GATE_ONLY_EXECUTED, NETWORK_LIMITATIONS_NOTE };
