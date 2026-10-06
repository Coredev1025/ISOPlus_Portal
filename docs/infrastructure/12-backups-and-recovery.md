# Backups and recovery

What is backed up, how often, where, and for how long, as found in the AWS account on 2026-10-06 (read-only).
Where something could not be found it says so. Nothing here has been restored as a test: **a backup that has
not been restored is not yet proven.**

## Summary

| Data | Backed up? | How | Retention |
|---|---|---|---|
| MongoDB (production database) | Yes, by a function in this account | Daily at 16:00 UTC (02:00 or 03:00 Sydney), compressed dump to S3 | 60 days in practice (see below) |
| MongoDB Atlas's own backups | **Unknown** | Atlas setting, outside AWS | **To confirm** |
| S3 documents (`isoplus-portal`) | **No** | No versioning, no replication, no lifecycle | Deleting or overwriting an object is unrecoverable |
| S3 public assets | **No** | The same | The same |
| Redis | Snapshot in production only | Daily 18:30 UTC | 1 day. Working state, not a record |
| Environment properties and secrets | Not backed up as such | Secrets in Secrets Manager; plain text properties exist only in the environment | Keep the values in the password manager |
| Application versions | Yes | Every deploy is kept in the deploy bucket | Roll back by deploying an earlier version |

## MongoDB backup (found)

* EventBridge rule `isoplus-mongodb-backup-daily` (enabled), `cron(0 16 * * ? *)`, calls the function
  `isoplus-portal-mongodb-backup` (container image, 512 MB, 303 second timeout).
* It writes `mongodb/iso-plus/<date>_<time>.gz` to the bucket `isoplus-db-backups-...-ap-southeast-2-an`
  (private, encrypted). Files are about 41 to 42 MB each, 60 present, from 6 August to 4 October.
* Health: one invocation a day for the last four days, no errors. The latest file was 4 October 16:01 UTC.
* **The lifecycle rule is named "expire-all-db-backups-30d" but expires objects after 60 days.** The name
  and the setting disagree; the 60 days is what runs. Decide which is intended and rename or change it.
* **It dumps the production database.** Checked 2026-10-06 by comparing hostnames only (credentials stripped
  before anything was shown): the function's `ATLAS_URI` points at the same Atlas cluster as production's
  `MONGODB_URI` (the `cluster0` cluster) and not at dev's (`cluster1`). The database is named `iso-plus` on
  both clusters, so the file names (`mongodb/iso-plus/...`) do not tell them apart; the bucket is production's.
  The function holds the connection string, password included, as a plain `ATLAS_URI` setting: KAN-326.
* The dump has grown slowly (41.0 to 42.1 MB over a few days) and the function has a 303 second limit.
  Watch the run time; a timeout would stop backups with no other symptom than a missing file.
* A second rule, `isoplus-mysql-backup-daily`, is disabled and is unrelated to this product.

## Before a release (release runbook, step 8)

The release runbook asks for a database backup and says how is to confirm. The nightly backup is not enough
on its own: take one immediately before. **To confirm and test on dev first:** run the function once by hand
(`aws lambda invoke --function-name isoplus-portal-mongodb-backup ...`) and check a new file appears with a
recent time. Note the file name in the release record.

## Restoring MongoDB (not tested)

The files are compressed archives. A restore into a **new, empty** database (never over production) is,
in outline: download the file, restore it with `mongorestore --gzip --archive=<file>` into a scratch database,
then check collection counts and the newest records. The repository's `npm run seed` and the release rehearsal
(`docs/ongoing/2026-10-04-prod-copy-rehearsal.md`) already restore dumps locally, so the tooling exists. Whether
the function's output is a `--archive` or a per-collection dump is **to confirm** with one real restore.

## What is not covered

* **The documents.** Invoices and statements are PDFs in `isoplus-portal`; the database holds the records that
  point to them. A deleted or overwritten PDF cannot be recovered, though it could be regenerated from the
  data. Turning on S3 versioning, with a lifecycle rule to expire old versions, is the cheap fix (KAN-327,
  low priority). It is a change to production and needs a decision (cost is small, restoring a version is simple).
* **Atlas.** If Atlas snapshots are off and this function is the only backup, a day's data is the most that
  can be lost, and recovery depends on this one dump. Confirm Atlas's setting.
* **No recovery targets are written down.** How much data loss (hours) and downtime the business accepts is
  not defined anywhere. A decision for the owners, then check the above meets it.
* **One instance, one region.** Everything runs in `ap-southeast-2` on one instance. A region loss means
  rebuilding from the repository, the Terraform, the S3 data and the last database dump.
* **Existing AWS Backup plans** in the account cover other systems (virtual machines and a security
  platform), not this product.
