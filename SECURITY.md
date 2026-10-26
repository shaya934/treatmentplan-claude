# Security: HIPAA safeguard map

Each safeguard in the spec, mapped to the code or AWS resource that implements it. The AWS BAA covers AWS's side only. **Get a HIPAA consultant review before any real PHI is uploaded.** Development and testing use synthetic data only.

## Technical safeguards (built into the app)

| Safeguard | Implementation | Verified by |
|---|---|---|
| Unique user accounts, MFA required, no shared logins | Cognito user pool: `MfaConfiguration: ON`, TOTP only, admin-created users only, email as unique username (`infra/lib/foundation-stack.ts` → `Users`). Server-side auth flow with MFA setup on first login (`packages/core/src/auth.ts`). Local mode: same two-step flow, bcrypt and TOTP. | `infra/test/infra.test.ts` (Cognito MFA), browser e2e (TOTP login) |
| Password policy | Cognito policy: 12+ characters, upper, lower, digit, symbol; `checkPasswordPolicy` mirrors it for local mode | `session.test.ts` |
| Role-based access; BCBAs see only assigned clients | `packages/core/src/rbac.ts` (role matrix, checked at every service call) **and** Postgres RLS policies `client_visible()`, `plans_read`, child-table policies (`migrations/001_init.sql`) | `isolation.test.ts` "BCBAs see only assigned clients", "read-only users see finalized plans only" |
| Tenant isolation in the database, not just code | `tenant_id` on every table; RLS **enabled and forced** on all tables; runtime role `aba_app` is non-owner and `NOBYPASSRLS`; `withCtx()` sets `app.tenant_id/user_id/role` per transaction (`packages/core/src/db.ts`) | `isolation.test.ts` "a second company cannot see any of the first company's data, even with raw SQL", "cannot write into another tenant" |
| Super admin cannot view client data without a logged, time-limited grant | `support_grants` table; `createSupportGrant`, `activeGrant`, `logSupportAccess` (`svc/admin.ts`); support sessions are read-only (`apps/web/lib/api.ts`) | `isolation.test.ts` "super admin cannot read client data…", "support grant is time-limited and logged" |
| Encryption in transit (TLS 1.2+) | ALB HTTPS listener with `ELBSecurityPolicy-TLS13-1-2-*`, HTTP→HTTPS redirect; HSTS header; RDS `rds.force_ssl=1` with CA-verified connections (`rdsSsl()`); `enforceSSL` on every bucket and queue; VPC interface endpoints for AWS APIs | `infra.test.ts` |
| Encryption at rest (KMS) for the database, S3, backups and queues | One customer-managed KMS key with rotation (`PhiKey`) used by RDS storage and Performance Insights, the files bucket (SSE-KMS + bucket key), SQS + DLQ, Secrets Manager, CloudWatch log group, CloudTrail, the AWS Backup vault and the SNS topic | `infra.test.ts` |
| Automatic logoff after 15 minutes idle | Session cookie with sliding last-activity claim checked by edge middleware (`apps/web/middleware.ts`) and by `api()`. Client idle timer with a 1-minute warning (`components/Shell.tsx`). Cognito tokens are never stored in the browser. | `session.test.ts` |
| Append-only audit log of every view, upload, download, edit, export, finalize, template change and login | `audit_log` table: no UPDATE/DELETE policies, privileges revoked from `aba_app`, trigger blocks UPDATE/DELETE/TRUNCATE. `audit()` calls in every service (`svc/*.ts`), plus login/logout/MFA (`auth.ts`), voice sessions (`server.ts`) and support access. Admin search UI at `/admin/audit`. | `isolation.test.ts` "audit_log rejects update and delete, even for the owner", "every view is audited" |
| Audio deleted immediately; temp files wiped after each job | Audio is streamed frame by frame to Transcribe and never buffered to disk (`transcribe.ts`, `server.ts`); local mode only counts bytes. PDF conversion works in a `mkdtemp` dir removed in `finally` (`export.ts`); the worker also wipes `aba-*` temp dirs after every job (`apps/worker/src/main.ts`). | Code review; `pipeline.test.ts` PDF export |
| No PHI in URLs, error messages, analytics, CloudWatch logs or crash reports | UUID-only routes and S3 keys; filenames only in Content-Disposition; allow-list logger with scrubbing (`logger.ts`); `SafeError` generic API errors (`apps/web/lib/api.ts`); no analytics or crash-report SDKs; WAF sampled requests disabled; RDS statement logging off; SQS messages carry IDs only | `pipeline.test.ts` "log output never contains synthetic client names, DOBs, IDs or answer text"; sanitizer test |
| File access only through short-lived presigned URLs (≤ 5 min) | `storage.ts`: `presignTtlSeconds` capped at 300 for upload and download; uploads go browser→S3 directly; S3 CORS limited to the app origin | `pipeline.test.ts` (signed-URL verification) |
| Configurable retention per tenant; automatic deletion; client data deletion on request | `tenants.settings.retention_days`; `runRetention()` runs daily as a scheduled Fargate task (`RetentionSchedule`); `deleteClientData()` plus admin UI button on the client page; S3 noncurrent-version expiry | Manual / code review (see PROGRESS.md) |
| Backups with a documented, tested restore | RDS automated backups (35 days) + AWS Backup daily/monthly plan into a KMS vault; `docs/RESTORE.md`; `scripts/restore-test.sh` (local drill, passing) | `scripts/restore-test.sh` |
| Rate limiting and WAF on login and upload endpoints | WAF rate-based rules `LoginRateLimit` (`/api/auth/`) and `UploadRateLimit` (`/api/plans/`) plus AWS managed rule groups; app-level limiter on login, MFA and plan writes (`apps/web/lib/ratelimit.ts`) | `ratelimit.test.ts`, `infra.test.ts` |
| Dependency vulnerability scanning in CI; annual pen test | `.github/workflows/ci.yml` runs `pnpm audit --audit-level high`. Pen test: administrative item before selling to other companies. | CI |
| AI only through Bedrock; IAM scoped to approved models | `BedrockAiClient` is the only AI client (`ai/client.ts`); model IDs only in `config/models.ts`; task-role statement `BedrockApprovedModelsOnly` limited to those IDs; Bedrock reached via VPC endpoint | `integrity.test.ts`, `infra.test.ts` |
| Clinical integrity (no invented scores, rates, dates or diagnoses) | `CLINICAL_INTEGRITY_RULES` in every generation system prompt; deterministic pre-fill; post-checks drop out-of-scope writes and fake sources; unsupported numbers flagged | `integrity.test.ts` |
| Network isolation | App tasks in private subnets with no public IP; database in isolated subnets; only the ALB is internet-facing; VPC endpoints for S3, Bedrock, Textract, Transcribe, Secrets Manager, SQS, KMS, Logs, ECR and STS | `infra.test.ts` |
| Monitoring | CloudTrail (all regions, log-file validation, KMS), AWS Config recorder plus managed rules, GuardDuty (S3, RDS, Fargate runtime), Security Hub, alarms, budget alerts | `infra.test.ts` |
| Security headers | CSP, HSTS, X-Frame-Options DENY, nosniff, no-referrer, `Cache-Control: no-store` (`apps/web/next.config.ts`) | Code review |

## Administrative safeguards (the company handles these)

- [ ] Accept the AWS BAA in AWS Artifact before any real PHI is stored
- [ ] BAAs with any other vendor that touches PHI (e-signature, email if it includes PHI)
- [ ] Written risk assessment covering this app
- [ ] Staff HIPAA training and a policy that BCBAs review every AI draft before signing (the app enforces BCBA-only finalize and shows a "reviewed" confirmation)
- [ ] Breach notification procedure
- [ ] Review consent and notice-of-privacy-practices language about AI-assisted documentation
- [ ] When selling to other ABA companies: sign a BAA with each customer company
- [ ] Annual penetration test before selling to other companies
- [ ] Confirm every service used is on the current AWS HIPAA Eligible Services list (Bedrock, Textract, Transcribe Medical, Cognito, RDS, S3, SQS, ECS Fargate, ALB, WAF, KMS, Secrets Manager, CloudWatch, CloudTrail, Config, GuardDuty, Security Hub, AWS Backup)
