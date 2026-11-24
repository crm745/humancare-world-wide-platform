# Document storage: provider resolution and migration strategy

Nothing here has been run. It describes how existing files stay reachable and how a later move
(local to S3, or Sydney `ap-southeast-2` to Mumbai `ap-south-1`) must be done.

## How a stored file is found

| Record | Where the provider comes from |
|---|---|
| Quotation (`case_quotations`) | The row's own `storage_provider` (`local` or `s3`). Always honoured, whatever `STORAGE_PROVIDER` is now. A row with no provider is treated as `local`. |
| Legacy file (bare filename, or `/uploads/<name>`) | Always the local upload folder. |
| Every other new key (`<area>/<yyyy>/<mm>/<random>.<ext>`) | The active provider first; if the object is "not found" there, the other provider (local, or S3 when it is configured). Writes only go to the active provider. |

A "not found" is the only thing that triggers the second look. An S3 outage, access error or
checksum mismatch is reported as such and is never read as "missing" or served from elsewhere.

New quotations record the provider that really stored them. A quotation row that says `s3` while S3 is
not configured fails with a configuration error instead of being read from somewhere else.

## Rules that keep documents reachable

1. Keys are never rewritten. The database stores the key only; the bucket and region come from configuration.
   A key is therefore the same in the Sydney bucket, the Mumbai bucket and the local folder.
2. Never delete or overwrite anything in the old location until the new one has been verified (below).
3. `STORAGE_PROVIDER` or `AWS_S3_BUCKET` must not be changed on a running system on their own. Follow the steps.

## Moving local files to S3 (later)

1. Set the S3 configuration and `STORAGE_PROVIDER=s3`. New files go to S3; old local files are still read through the
   fallback (and quotation rows still say `local`).
2. Run a copy job (to be written; it must be a dry run first): for each object in the local folder, in key order,
   upload to the same key, read it back from S3, compare SHA-256 to the database `sha256` (documents that have one)
   or to the local file, and record the result. Do not stop on one failure, report it.
3. For quotations only, after the object is verified in S3, update that row's `storage_provider` to `s3`
   (compare-and-swap on `revision`, one row at a time). Other tables need no change.
4. Keep the local files for a retention period (suggested 30 days) after the last verified copy, then delete them in a
   separate, explicitly approved step.
5. Legacy bare-filename keys keep resolving to the local folder only. They must be copied to S3 under their
   own name and their rows rewritten to a new key in a separate step, because a bare name is hard-wired to local.
   Until then the local folder must stay mounted.

## Sydney to Mumbai (later)

1. Create the Mumbai bucket (private, Block Public Access on, SSE-S3, the same policy shape as the Sydney one).
2. Copy every object with the same key (S3 Batch Replication or `aws s3 sync`). Verify counts, sizes and SHA-256 of a sample
   plus every quotation and request document (they carry a `sha256`).
3. Cutover: set `AWS_S3_BUCKET` / `AWS_REGION` to Mumbai and `AWS_S3_READ_FALLBACK_BUCKET` / `AWS_S3_READ_FALLBACK_REGION`
   to Sydney. New files go to Mumbai; anything not yet copied is still read from Sydney (read-only: nothing is ever written
   to or deleted from the fallback).
4. Re-run the copy for anything written to Sydney between the copy and the cutover.
5. When the verification report is clean and a retention period has passed, remove the fallback settings. Keep the
   Sydney bucket until a separate approval to delete it.
6. Rollback at any point before step 5: swap the two settings back.

## Credentials

- Development: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (both or neither).
- Production (EC2): set neither; the AWS SDK default provider chain uses the instance's IAM role. The role needs the
  same permissions as the development policy on the production bucket, and read on the fallback bucket during a migration.
