# HumanCare Synthetic E2E Test Orchestrator

Runs one synthetic patient through the real web UI against `humancare_dev`, with Bitrix isolated **inside the processes the orchestrator owns** (no Windows Firewall rule, nothing machine-wide).

**Flow:** terminate this tool's own orphaned processes → preflight (config at rest, DB = `humancare_dev`, ClamAV, general worker absent, no other dedicated worker, Bitrix source unchanged) → port check (4400, 8481) → sanitized environments → isolated web build (verified) → browser proxy + static web server → isolated **dedicated worker** and isolated **API** under the egress guard → **isolation gate** → Playwright journey (canary → register → Firebase **test** phone OTP → Private Charter request → document upload → submit) → wait for ClamAV `clean` → existing `scripts/synthetic-mark.js` issues the signed marker → existing worker + approval engine approves → read-only verification (incl. a final isolation re-check) → everything stopped → `report.json`.

## What runs where
| Thing | Port | Notes |
|---|---|---|
| Isolated API (`src/synthetic-e2e-api.js`) | **4400** | started by the orchestrator; checks `SELECT DATABASE()` = `humancare_dev` through its own Prisma connection **before** `src/server.js` listens |
| Isolated web build (static export of `apps/mobile`) | **8481** | `EXPO_PUBLIC_API_URL=http://localhost:4400` set in the export child only; bundle verified to contain it |
| Dedicated worker (`src/synthetic-e2e-worker.js`) | — | scan job + synthetic approval only; keeps its own DB identity check |
| Browser egress proxy | random, 127.0.0.1 | Chromium is launched through it |
| **Never used / never touched** | 4000, 4100, 8081 | normal dev API, payment E2E runner (`humancare_test`), normal Expo dev server |

The orchestrator never attaches to, stops, or modifies an existing service. If 4400 or 8481 is taken, or a dedicated worker or the general worker is already running, it stops before starting anything.

## One-time setup
1. `phone-pool.local.json` (copy the `.example`): your Firebase *test* numbers (+91 only) and the fixed test code. Never a real number.
2. `backend/.env` is **read-only** to this tool. It needs `DATABASE_URL` (`humancare_dev`, loopback host), `SYNTHETIC_E2E_SECRET`, `FIREBASE_SERVICE_ACCOUNT_PATH` and the usual API settings. **Nothing about Bitrix, SMTP, payments or storage in that file matters or needs editing**: the spawned processes get a sanitized environment (below). There is no acknowledgment file any more.
3. Do **not** start the API, the dedicated worker or `expo start` for this run — the orchestrator starts its own. (Your normal ones can keep running on their own ports.) The general worker (`src/worker.js`) must not be running.
4. `apps/mobile` must have its dependencies installed (`apps/mobile/node_modules/expo`).

## Run
```powershell
cd "e:\Nobita\Humancare World Wide Project\Humancare World Wide\backend"
npm run e2e:synthetic
```
Options: `--headless`, `--gate-only`, `--reuse-web-build <dir>`, `--recover` (terminates only this tool's own orphaned API/worker from a crashed run), `--cleanup <runId> [--apply]` (dry-run unless `--apply`; never deletes audit rows). `--spawn-worker`, `--web-url`, `--api-url` were removed.

### `--gate-only` (isolation check, no patient)
```powershell
npm run e2e:synthetic -- --gate-only --reuse-web-build "$env:TEMP\hc-web-verify"
```
**Starts:** the isolated API (4400; its own `SELECT DATABASE()` = `humancare_dev` before it listens), a **readiness-only** dedicated worker (`--readiness-only`: validates its configuration, opens Prisma, confirms `SELECT DATABASE()` = `humancare_dev`, then idles — it never creates the job runner, so no run-on-start run, no interval, no scan, no approval), the browser filtering proxy and the static web server (8481).
**Checks:** configuration/environment, preflight (orchestrator's read-only `SELECT DATABASE()`, ClamAV TCP), ports and process ownership, every egress self-test (API, worker, orchestrator, proxy canary), the web bundle, local MySQL/ClamAV/API/web reachability. Writes `gate-report.json` (what ran, what did not, every check's result), then stops only what it started.
**Cannot execute:** the phone lock, Playwright/Chromium, the registration form, any patient registration, any request/case/document/marker/approval creation or change, the scan job, the synthetic-approval job. (The orchestrator's gate-only path has no reference to them and never loads them; the API's normal start-up does read-only `SELECT`s on the geonames tables, and `GET /health` writes nothing.)

### `--reuse-web-build <dir>`
Skips `expo export`: the directory is verified (exactly `http://localhost:4400`, a JS bundle, `index.html`, no port 4100; it must be outside `apps/mobile` and `backend/src`) and then only read and served. Nothing is rebuilt, no Metro cache is cleared, no mobile file is touched. A rejected directory never falls back to a rebuild. Note: reuse proves the export targets the isolated API, not that it was built from the current mobile source; the report records when the bundle was built.
Output: `backend/.synthetic-e2e-runs/<runId>/report.json` (gitignored). Exit code 0 = passed.

## How Bitrix is isolated (and what is *not* claimed)
Layers, in the order they apply:
1. **Nothing to send to.** The API and worker environments are built from scratch (`childEnv.js`): `BITRIX_SYNC_ENABLED=false`, the Deal and Quotation switches `false`, `BITRIX24_WEBHOOK_URL`, `BITRIX_INBOUND_APPLICATION_TOKEN` and `BITRIX_ALLOWED_PORTAL_HOST` **blank**; every other key found in `backend/.env` that is not on a short allow-list is set to blank (dotenv/Prisma would otherwise refill it). `BITRIX_DEAL_PROFILE=actual` is set only so the new synthetic case's Deal link/outbox row is stamped; nothing is ever sent. SMTP is blank (console mail provider; console output that could contain an OTP is suppressed), payments are off, storage is local, `NODE_ENV=development`, no `NODE_OPTIONS`.
2. **In-process egress guard** (`egressGuard.js`, loaded with `node --require` before any application code, also installed in the orchestrator itself). It blocks the Bitrix portal by **name** (the configured host *and* any `*.bitrix24.*` name) and by **address** (the IPs the host resolved to at start-up, in every spelling) on every JavaScript transport: `net`/`tls` (hence `http`, `https`, `http2`, `fetch`/undici, nodemailer, AWS SDK, firebase-admin), `dns`, `dgram`. Redirects cannot bypass it (each hop opens a new socket through the same hook); a harmless name that resolves to a blocked address is blocked at the lookup. `child_process`, worker threads and unknown native modules are refused in the API and worker. The API refuses to load `src/worker.js` or any job module; the worker refuses everything but its one scan job and every Bitrix client/worker module.
3. **Browser**: Chromium runs through a local filtering proxy (name + resolved-address check, address pinned), `--host-resolver-rules` maps Bitrix names to NOTFOUND, QUIC and non-proxied WebRTC UDP are off, service workers are blocked, a route + WebSocket route abort Bitrix hosts and `localhost:4000`/`:4100`, and a canary navigation to a Bitrix-looking name must fail before the registration form is opened.
4. **Self-tests and the gate.** Each guard probes itself at start-up (every probe must be refused, otherwise the process exits) and writes evidence to `egress-evidence.jsonl`. Nothing that registers a patient runs until the gate passes: guard installed + self-test passed (API, worker, orchestrator), API DB identity confirmed, worker ready, no violation recorded, browser proxy denies the canary, bundle verified, MySQL/ClamAV/API/web reachable. Any recorded violation, dead child or proxy denial during the run fails it, and the final verification re-checks isolation.

**Limits (disclosed, not hidden):** this is application-level isolation, not kernel-level. Windows Firewall cannot scope a rule to one process (`Program=node.exe` matches every Node process), so no OS-level equivalent exists without administrator-created per-user rules. Native code inside an allowed module — the Prisma query engine, which only connects to the loopback MySQL server — opens sockets outside JavaScript and cannot be intercepted. A future code change could add a transport the guard does not know; the module/native-load tripwires and the self-tests are the regression guards. The browser canary proves a Bitrix-looking name does not leave the machine, not which browser layer stopped it. The UI selectors are the app's English labels; reCAPTCHA on web may challenge automated browsers. If the exported bundle does not contain the 4400 URL (a stale shared Metro cache), the run **stops** and asks you before any cache is cleared — it never passes `--clear` itself.

## Safety guarantees
* Requests 155/156/157 are refused at every stage. Only the `ZZ-SYNTHETIC` account created by this run is touched.
* `humancare_dev` only; `humancare_test` and production are never accessed. The API and the orchestrator both check the live database name.
* Firebase OTP is not bypassed; the code is never logged and no screenshot is taken on an OTP screen. Child output is redacted.
* `backend/.env`, `apps/mobile/.env` and all mobile source are never written.
* Cleanup is a separate explicit command and never deletes audit/security events.

## Tests
`npm run test:synthetic-orchestrator` (standalone `node:test`, `tests/isolation/synthetic-*.node-test.js`). Local mock endpoints only (`127.0.0.1`, `127.0.0.2` as the "Bitrix" stand-in, `*.test`/`*.invalid` names): no database, no firewall change, no real Bitrix, no live journey. Never `npm test` for this feature.
