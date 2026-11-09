# Request-first review workflow (Private Charter)

A new Private Charter request is saved first and reviewed before it becomes an operational Case.
Other services, corporate-created Cases and every existing request are not affected.

## How it works

1. `POST /requests` saves the request with its permanent `REQ-…` reference. **No Case is created and
   no Bitrix lead is sent.** The request, its reference and its first audit event are saved in one
   transaction. `reviewStatus` is `awaiting_documents`: **a draft, not a submission** (see below).
2. The patient uploads one or more documents to the same URL as before,
   `POST /requests/me/:id/documents` (field `file`; optional field `replacesDocumentId` to replace an
   earlier document). **The first document is what submits the request**: it moves to `in_review` and
   `submittedAt` is set. Replaced and rejected documents are kept for good, marked as such.
3. Every document is scanned by **ClamAV**. Only an explicit "OK" counts as clean (fails closed). The scan
   is tied to the upload's SHA-256: a file that differs from the upload checksum before the scan, or changes
   while it is scanned, is never marked clean.
4. Any Admin (admin or superadmin, no separate permission) reviews each clean document: approve, or
   reject with a reason the patient sees. A rejection, or "request additional documents" (with a
   reason), puts the request in `changes_requested` until the patient uploads something.
5. `POST /admin/requests/:id/approve` creates the Case (`CASE-…` reference) in one transaction, only
   when every current document is clean and approved, nothing was requested and left unanswered, and every
   stored file still exists and matches its checksum (`file_missing`, `file_changed`, `checksum_missing` block
   the approval). Repeating it returns the same Case. Approved documents are copied to the Case's `documents`.

## One document to submit

A request with **no document is a draft**: it is not a submission, Admin's default list leaves it out
(`GET /admin/requests?status=awaiting_documents` shows drafts), and it cannot be approved. The app does
not offer to submit a Private Charter request without a file (step 2 requires one, and the review screen
refuses to send), and if every upload fails after the request is saved, the success screen says the request
is **not submitted yet** and offers a retry. Any number of documents may follow, including ones an Admin asks
for and replacements for rejected ones, all against the same request. There is no fixed checklist of types.
A request with at least one uploaded document is listed whatever state it is in: waiting for its scan,
infected, waiting for review, or with changes requested.

## Opening a document later

Documents copied to a Case at approval stay linked to the scanned original (`request_documents.case_document_id`,
and the file's unique storage key). The existing download endpoint `GET /documents/:id/file` keeps its ownership
rules (the patient, or the corporate the Case is assigned to) and, **for these documents only**, also requires
the original to be clean and approved and the file to exist and match its stored SHA-256; the bytes sent are the
bytes that were checked. Documents from before the workflow have no such data and are served exactly as before:
missing scan data is never treated as a problem for them. A `documents` row whose file belongs to the workflow but
is not linked to it is refused.

Statuses of `service_requests.review_status`: `awaiting_documents`, `in_review`, `changes_requested`,
`approved`. `NULL` is a request made before this workflow (its Case already exists; nothing changes).

## Turning it on

It is **off by default.** Set `PRIVATE_CHARTER_REVIEW_WORKFLOW=true` only when an Admin can actually
review (today that is the API below; the Admin Portal screens are not built yet), otherwise new
Private Charter requests would wait for an approval nobody can give.

| Setting | Default | Meaning |
|---|---|---|
| `PRIVATE_CHARTER_REVIEW_WORKFLOW` | off | `true` switches the workflow on for new Private Charter requests |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `127.0.0.1` / `3310` | where clamd listens (INSTREAM over TCP) |
| `CLAMAV_TIMEOUT_MS` | `20000` | the TOTAL time one scan may take (one deadline, not reset by traffic) |

Run clamd and the worker (`npm run start:worker`; it runs the `scan-request-documents` job every minute
to retry documents whose scan failed or never ran). While the scanner is down uploads still succeed, but
the documents stay unusable (`scan_status = error`) and the request cannot be approved.

A scan ends in one of these states: `clean`, `infected` (the file is moved to `uploads/quarantine/`), `error` (the scanner could not run for now: ClamAV down, slow or unreachable; **retried** every minute) or `failed` (the scan can **never** succeed: the stored file is missing, or does not match its upload checksum; **final**, never retried). A missing file counts as lost only when the storage itself is shown to be intact: the upload folder must be a readable folder **and** at least one other document that was scanned clean (one of the newest five) must still be found in it. Otherwise (the worker was started with another `HC_UPLOAD_DIR`, a volume is not mounted, the folder is gone) the document stays `error` and is retried, so a storage problem never ends valid documents; it is scanned normally once the storage is back. Until at least one clean document exists, a missing file is retried and not failed. A `failed` document is unusable like any other that is not clean, blocks approval (`scan_unrecoverable`), and is cleared by the patient uploading a replacement. Replaced (superseded) versions are never scanned again. The worker logs each permanent failure once, and a quarantine move that fails is logged with the document and error code (the verdict stays `infected`, and nobody can open the file either way).

## Admin API (all behind the Admin login)

| Endpoint | What it does |
|---|---|
| `GET /admin/requests?status=&search=&limit=&offset=` | every submission in the workflow (drafts excluded unless `status=awaiting_documents`), with document counts, as `{ requests, total }`. `status` is one status or a comma-separated list (`in_review,changes_requested` = not yet approved); `search` matches the reference or patient name (contains, case-insensitive, max 100 characters); `total` ignores `limit`/`offset`. Each row has `documents: { current, awaitingScan, scanErrors, scanFailed, infected, awaitingReview, approved, rejected }` (current documents only; `scanErrors` is the part of `awaitingScan` whose scan failed and is retried; `scanFailed` counts scans that can never succeed and is not part of `awaitingScan`) |
| `GET /admin/requests/:id` | the request, all document versions, and its audit history |
| `GET /admin/requests/:id/documents/:docId/file` | download; **only if the scan is clean** (never infected, unscanned or errored), and the file must exist and match its stored checksum (a missing checksum is refused) |
| `POST /admin/requests/:id/documents/:docId/review` | `{ decision: 'approved' \| 'rejected', reason }` (reason required to reject) |
| `POST /admin/requests/:id/request-documents` | `{ reason }`: ask the patient for more documents |
| `POST /admin/requests/:id/approve` | create the Case; `409` with `blockers` lists what is missing |

## Audit history

`request_events` is append-only (the code only inserts; nothing purges it) and holds every upload,
scan result, review decision, request for documents, replacement, download, status change and the
approval, with who did it. It is separate from `security_events`. Rows cannot be edited by the API; a
database-level guard (triggers) is not in place.

## Files and quarantine

Uploads stay in `backend/uploads/` under the name multer gave them (the cleaned file name is cut to its last
120 characters, so the stored name and `/uploads/<name>` always fit the database) and are never served
statically. The patient's original file name is kept only as text, without control characters or path
separators, at most 191 characters. An infected file is moved to `backend/uploads/quarantine/`. Nothing
deletes a document. The worker's scan sweep tries never-scanned documents first, then failed ones, least
recently tried first, so a document that can never be scanned does not hold up newer ones. A scan verdict
and its audit event are written in one transaction.

## Rolling back

`prisma/migrations/20261107120000_request_first_workflow/down.sql` (by hand, only while the two new
tables are empty). To stop using the workflow, set the flag off: existing requests in the workflow stay
readable in the database but are no longer created; approve or finish them first.

## Not in this phase

Admin Portal screens, mobile screens for document status and replacement, patient notifications,
Bitrix (no lead is created, before or after approval), magic-byte file-type checks, and database-level
immutability of the audit table.
