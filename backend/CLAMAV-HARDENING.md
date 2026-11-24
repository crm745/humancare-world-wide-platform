# ClamAV hardening (Phase 1): exact configuration and operations

Nothing in this file has been applied. The running daemon was not modified or restarted.

## What was found (WSL, ClamAV 1.5.4)

- Every directive below exists in the installed `clamd` (it is compiled in): `AlertEncrypted`, `AlertEncryptedArchive`,
  `AlertEncryptedDoc`, `AlertOLE2Macros`, `AlertExceedsMax`.
- `/etc/clamav/clamd.conf` sets none of them, so each is off. Network settings are `TCPSocket 3310`, `TCPAddr 127.0.0.1` and
  `LocalSocket /var/run/clamav/clamd.ctl`. They must not change.
- `freshclam.conf` already has `Checks 24` (24 updates a day), but `clamav-freshclam` is **inactive and disabled** in WSL.
  The signature files are from **Nov 10** (`daily.cld`, version 28179), so they are about 10 days old.
- The daemon answers `VERSIONCOMMANDS` (which starts with the version line) but refuses `VERSION` from a TCP client
  ("COMMAND UNAVAILABLE"). The backend uses `VERSION` first and falls back to `VERSIONCOMMANDS`.

## Important consequence of the new freshness check

The backend now refuses new uploads (503 `scan_unavailable`) when the signatures are older than `CLAMAV_MAX_SIGNATURE_AGE_DAYS`
(default 7). With the current WSL signatures (about 10 days old) **uploads will be refused until freshclam has updated them.**
Do step 2 below before testing uploads. Documents already stored are not touched.

## 1. Add three settings to `/etc/clamav/clamd.conf` (append; change nothing else)

```
AlertEncrypted yes
AlertOLE2Macros yes
AlertExceedsMax yes
```

- `AlertEncrypted yes` raises an alert for encrypted archives and encrypted documents (it is shorthand for the two settings
  `AlertEncryptedArchive` and `AlertEncryptedDoc`).
- `AlertOLE2Macros yes` alerts on OLE2 (legacy Office) files that contain macros.
- `AlertExceedsMax yes` alerts when a file exceeds a scan limit (`MaxFileSize`, `MaxScanSize`, `MaxRecursion`, `MaxFiles`),
  instead of silently reporting the unscanned remainder as OK. This closes the "zip bomb scans clean" gap.
- Existing limits already fit the 10 MB upload cap: `StreamMaxLength 25M`, `MaxFileSize 25M`, `MaxScanSize 100M`, `MaxRecursion 16`.

An alert shows up as a verdict of `... FOUND` (for example `Heuristics.Encrypted.Zip`), which the backend already treats as infected,
so the upload is refused.

Check the file before restarting: `sudo clamconf -n` (prints the non-default settings and reports unknown or invalid ones).

## 2. Signature updates

Run one update now, then turn on the daily updater. `freshclam.conf` already contains `Checks 24` and `NotifyClamd`, so the daemon
reloads the new signatures by itself.

```
sudo systemctl stop clamav-freshclam      # only if it is running
sudo freshclam                            # one update now
sudo systemctl enable --now clamav-freshclam
systemctl is-active clamav-freshclam      # expect: active
```

If WSL has no systemd, run `sudo freshclam -d` from a startup script, or schedule `sudo freshclam` daily with cron.

## 3. Restart clamd (after step 1)

```
sudo systemctl restart clamav-daemon
systemctl is-active clamav-daemon         # expect: active
```

## 4. Verify (read only)

From the backend folder, with your `.env`:

```
node -e "require('dotenv').config({quiet:true});require('./src/integrations/clamav/clamav').ready({noCache:true}).then(r=>console.log(JSON.stringify(r)))"
```

Expect `{"ok":true,...,"signatureDate":"<within 7 days>"}`. A stale daemon prints `{"ok":false,"reason":"signatures_stale",...}`.

## Backend settings

| Variable | Default | Meaning |
|---|---|---|
| `CLAMAV_HOST`, `CLAMAV_PORT` | `127.0.0.1`, `3310` | unchanged |
| `CLAMAV_TIMEOUT_MS` | `20000` | unchanged |
| `CLAMAV_MAX_SIGNATURE_AGE_DAYS` | `7` | oldest accepted signature database; invalid or non-positive values fall back to 7 |

## Production notes

- Run `clamd` and `freshclam` as services on the host (or sidecar), with freshclam enabled and monitored.
- Alert when `ready()` reports `signatures_stale` or `unreachable`: new uploads fail closed while that is true, and queued
  documents stay pending (the scan workers wait; no retry attempts are used).
