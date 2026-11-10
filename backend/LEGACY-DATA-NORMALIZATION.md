# Normalizing stored request data (Step 3)

Older requests were saved in formats the strict Private Charter validation no longer produces.
`scripts/normalize-legacy-data.js` finds them, and (only when you ask it to) rewrites the ones it
can read with certainty. **Nothing here runs by itself, and it never runs from a migration.**

## What it normalizes

| Column | Older format | Stored today | Rewritten when |
|---|---|---|---|
| `patient_gender` | `Male`, `Female`, `Other` | `male`, `female`, `other` | the text is one of those, in any case |
| `care_level` | translated labels in one of 6 languages (`ICU / Critical, Stable / Monitored`); the corporate portal's `care_icu, care_stable` | keys joined by a comma: `care_icu,care_stable` | every item is a key or a known label |
| `country` | English name (`India`, `United Arab Emirates`) | ISO code (`IN`, `AE`) | the name is in the app's country list, or is one of 8 one-reading aliases (`USA`, `Turkey`...) |
| `patient_contact` | `+971 501234567` (spaces, brackets, dashes) | E.164 `+971501234567` | it starts with `+` and is a valid number |

Only these four columns are ever written. `updated_at` is not touched, and no other column is.

## What it never guesses (left for a person)

Each is reported by **row id and reason code only**, and the row stays exactly as stored.

| Reason code | Example | Why it is not guessed |
|---|---|---|
| `gender_unrecognised` | `M`, `prefer_not_to_say` | not one of the three stored values |
| `care_level_unrecognised_value` | free text, a typo, an unknown key | cannot be mapped to a level |
| `care_level_not_applicable_combined` | `Not Applicable, ICU` | "not applicable" is only valid alone: which did the patient mean? |
| `country_unrecognised` | `Korea`, `Congo`, `Dubai` | more than one country, or not a country |
| `phone_without_country_code` | `9876543210` | the patient's country is not their phone's country |
| `phone_invalid` | `+971 12` | not a possible number |
| `*_not_text` | a non-text value | cannot occur from the API; reported if it ever does |

A reviewer fixes these by hand (or leaves them): the new validation already refuses such values
for new requests.

## Scope

* `--scope privatecharter` (the default): `service_requests` rows with service key
  `privatecharter` (or that service's name when the key is missing).
* `--scope all` exists **for reports only**. `--apply` and `--rollback` refuse any scope other than
  `privatecharter`, and a backup made with another scope is refused too. Other services keep the
  formats they were saved in.

## Two stages, never together

| Stage | `--fields` | Why it is separate |
|---|---|---|
| **A** | any of `patientGender,country,patientContact` | Invisible to Bitrix (gender is looked up in lower case, country is not read, a phone number is the same number), the PDF and the app. |
| **B** | `careLevel` alone, plus `--confirm-display-fix` | Changes the stored text that the PDF, the Bitrix comment and the app print. Run it only after the display fixes below are deployed and tested. |

`--apply` without `--fields`, with an unknown field, or with fields from both stages is refused.
`--fields` also narrows a report (`--fields careLevel` reports Stage B only).

## Before you start

1. Run it against the **test** database first and read the report (see "Rehearsal").
2. Do not run it while a migration is pending (`npx prisma migrate status` should say
   "Database schema is up to date") or during a GeoNames import.
3. Pick a quiet time. The script is safe while the app runs (every update is guarded, below), but
   a quiet time keeps the report and the result identical.

## Procedure

### 1. Report (read-only)

```
node scripts/normalize-legacy-data.js --env-file .env --scope privatecharter --review-file ..\review-ids.csv
```

Prints, per table and field: empty, already current, to rewrite, needs review. Changes nothing.
`--review-file` writes the ids and reason codes to a new file (an existing file is never replaced).
Send the report back for approval **before** going on: the number of values to rewrite is the exact
impact.

### 2. Back up

Both a database dump and the script's own change list are required.

```
mysqldump --single-transaction -u <user> -p <database> service_requests cases > <folder outside the repo>\pre-normalize-<date>.sql
```

The script refuses to apply unless that dump exists, is not empty and is under 24 hours old. It
then writes `--backup-file` itself: every old and new value, in a **new** file (an existing file is
never replaced, and a path inside this repository is refused: it contains patient phone numbers).
Store both files where only the people allowed to see patient data can read them.

### 3. Apply

```
node scripts/normalize-legacy-data.js --apply --env-file .env --scope privatecharter --fields patientGender,country,patientContact ^
  --confirm-database <exact database name> ^
  --confirm-backup <folder>\pre-normalize-<date>.sql ^
  --backup-file <folder>\normalize-<date>.json
```

* `--confirm-database` must equal the database the env file points to. A wrong name stops it.
* Rows needing review are skipped, untouched.
* Each update is `UPDATE ... WHERE id = ? AND BINARY column = BINARY <value that was read>`. A value
  edited after the scan (by a patient or staff) is skipped and counted, never overwritten.
* It ends by printing the verification below.

### 4. Verify

```
node scripts/normalize-legacy-data.js --verify --env-file .env --backup-file <folder>\normalize-<date>.json
```

`applied` = values now in the new format; `restored` = back in the old one; `changedSince` = edited
by someone else since (left alone); `missing` = row deleted. `rowCounts` must show the same number
before and now. A fresh report (step 1) should then show **to rewrite 0**: the run is idempotent.

### 5. Roll back, if needed

```
node scripts/normalize-legacy-data.js --rollback --env-file .env ^
  --backup-file <folder>\normalize-<date>.json --confirm-database <exact database name>
```

Restores each old value, only where the column still holds the value the script wrote. For a
whole-database restore, load the `mysqldump` file instead (it covers `service_requests` and `cases`
as of just before the run).

## Rehearsal on a copy

The tests (`tests/legacy-backfill.test.js`) already run every step against `humancare_test`. To
rehearse on real data without touching it, restore the production dump into a scratch database
and run steps 1 to 5 there with an env file that points at the scratch database.

(The commands above use the Windows `^` line continuation; in PowerShell use a backtick, in a
POSIX shell a backslash. Run Stage B the same way with `--fields careLevel --confirm-display-fix`,
as its own run with its own dump and backup file.)

## Display of care levels (the Stage B prerequisite)

A stored key must never reach a person as raw text. One rule is used in all three places: a piece
that is exactly a known key is translated; **everything else is shown exactly as stored** (spacing,
commas, punctuation, case; a key inside a sentence is not touched).

| Place | Code | Result |
|---|---|---|
| PDF summary | `common/utils/care-level.js`, used by `request-summary.pdf.js` | keys and the known older translated labels (all six languages) print as English labels. The PDF's built-in font cannot draw Hindi, Marathi, Gujarati, Telugu or Arabic: before this fix those labels printed as garbage or not at all. |
| Bitrix lead comment (request leads) | same helper, `bitrix-lead.js` "Care level" line | keys become English labels; older translated text is sent exactly as stored, so the comment of an existing request does not change. Corporate-case leads are not touched (deferred, see below). |
| Mobile request-details | `careLevelText(value, t)` in `apps/mobile/src/lib/requestShape.js` | keys show in the language the app is using now; older labels and free text are left as stored. |

Deploy all three (backend and app) and see them pass before running Stage B. Old app builds do not
have the mobile fix: ship the new app build first, because they show raw keys for Private Charter
requests.

### Deferred work (deliberately not done in Step 3)

| Deferred item | What is left as it is today | Why it waits |
|---|---|---|
| **Corporate-case Bitrix display** | `leadInputFromCase` in `bitrix-lead.js` (the "Care level" line for corporate-portal cases) still prints the stored text, so the portal's `care_icu, care_stable` reaches Bitrix as raw keys. | It changes another service's Bitrix output, and corporate cases are outside the Private Charter backfill (`cases` are only ever read with `--scope all`, and never written). The fix is the same one-argument change, `careLevelText(caseRecord.careLevel)`, once approved. |
| **Full PDF Unicode font support** | The PDF's built-in font (Helvetica) cannot draw Hindi, Marathi, Gujarati, Telugu or Arabic. Only the care-level line has a fallback (known labels print in English). Any other non-Latin text in the PDF (patient name, description, places) still prints as garbage or is dropped; a free-text care note in a non-Latin script does too. | Fixing it means bundling a Unicode font (licence, file size, shaping for Indic and Arabic scripts), a separate decision. |

Neither item blocks Stage A or Stage B.

## Production report run (read-only; not yet executed)

The report reads only `service_requests`, only these columns, and prints counts, row ids and reason
codes: no patient value. Run it with an account that **cannot** write or read anything else.

### 1. The read-only MySQL account (a DBA runs this once; replace the `<...>` parts)

```sql
-- Run as an administrator. <db> is the production database name.
CREATE USER 'hc_report_ro'@'<host the report runs from>'
  IDENTIFIED BY '<long random password, stored in a secret manager>'
  WITH MAX_USER_CONNECTIONS 2;

-- Column-level SELECT on one table: the report cannot see names, descriptions or anything else.
GRANT SELECT (`id`, `service_key`, `service_type`, `patient_gender`, `care_level`, `country`, `patient_contact`)
  ON `<db>`.`service_requests` TO 'hc_report_ro'@'<host the report runs from>';

-- Check: exactly one GRANT line (plus USAGE), nothing else.
SHOW GRANTS FOR 'hc_report_ro'@'<host the report runs from>';
```

The default scope (`privatecharter`) never queries `cases`, so it is not granted. After the run,
remove the account:

```sql
DROP USER 'hc_report_ro'@'<host the report runs from>';
```

Try these statements on a staging copy first: they have not been run against any server yet.

### 2. The env file (outside the repository, readable only by you)

```
DATABASE_URL="mysql://hc_report_ro:<password>@<host>:3306/<db>"
```

### 3. Run

```
node scripts/normalize-legacy-data.js --env-file <path to that env file> --scope privatecharter ^
  --review-file <restricted folder>\review-ids.csv > <restricted folder>\report.txt
```

Never pass `--apply`, `--rollback` or `--verify`. Without `--apply` the script has no write path,
and the account has no write privilege either.

### 4. Check the output before sharing it

* First line: `Database: <the production database name>`. Last line: `Report only: nothing was changed.`
* Contents: row counts per field, `review <table>.<field>: <reason> xN` lines. No names, numbers or
  addresses. `review-ids.csv` has the columns `table,id,field,reason` only.
* Share the report; the number of values to rewrite is the exact impact of Stage A and Stage B.

## Report on a database that has not had the newest migrations

The report reads only the original columns (`id`, `service_key`, `service_type`, `patient_gender`,
`care_level`, `country`, `patient_contact`) with plain SQL, so it needs none of the Step 2 columns
or tables. It was run against a development database that has 21 of the 27 migrations (no
`geonames_*` tables, no city columns, `preferred_date` still a datetime) and printed its normal
report. The 90-day compatibility behaviour of the API is not touched by any of this.

## Not covered

* `users.mobile`, `users.gender` and `users.nationality` follow their own sign-up rules and are not
  touched. (`humancare_dev` does not have the sign-up columns yet; apply the pending migrations first.)
* Documents, Bitrix leads already sent, and any other column.
* `preferred_date`: converted to a calendar date by migration `20261106110000`.
