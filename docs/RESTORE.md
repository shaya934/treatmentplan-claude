# Backup and restore

## What is backed up

| Data | Backup | Retention |
|---|---|---|
| RDS Postgres | Automated backups + point-in-time recovery | 35 days |
| RDS + files bucket | AWS Backup plan `daily` (06:00 UTC) | 35 days |
| RDS + files bucket | AWS Backup plan `monthly` (1st, 07:00 UTC), cold storage after 30 days | 7 years |
| Files bucket | S3 versioning (noncurrent versions expire after 30 days) | 30 days |

Everything is encrypted with the PHI KMS key. The backup vault has `RETAIN` removal policy.

## Restore the database (AWS)

1. RDS console → the `Db` instance → **Actions → Restore to point in time**. Pick the time just before the incident.
2. New instance: same VPC, the `data` (isolated) subnet group, the `DbSg` security group, the same parameter group (`rds.force_ssl=1`), and encryption with the PHI key.
3. Confirm row counts on the restored instance (connect from an ECS exec session in the app subnets as the owner):
   `SELECT count(*) FROM tenants; … plans; plan_versions; audit_log;`
4. Cut over: update the `Db` endpoint in CDK, or rename instances (old → `-old`, restored → original identifier), then redeploy the web and worker services so they reconnect.
5. Keep the old instance (stopped) until the restore is verified, then delete it with a final snapshot.

## Restore files (AWS)

- Single object: S3 console → object → **Versions** → restore the previous version.
- Bulk: AWS Backup → the files bucket recovery point → **Restore** to a new bucket, then `aws s3 sync` the affected `tenants/<tenantId>/` prefix back.

## Restore drill (tested)

`scripts/restore-test.sh` dumps the local database, restores it into a scratch database and compares row counts for every PHI table. It passed on 2026-10-26 (see PROGRESS.md). Run the AWS procedure above against the dev stack before go-live and record the result in PROGRESS.md.
