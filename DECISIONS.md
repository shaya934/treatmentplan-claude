# Decisions

Decisions made while building from the spec, without stopping to ask. Each one can be revisited.

## Architecture

1. **Monorepo with pnpm workspaces.** `packages/core` (domain logic, data access, AI pipeline; shared by web and worker), `apps/web` (Next.js 15 UI + API routes + custom Node server for voice WebSockets), `apps/worker` (SQS consumer), `infra` (AWS CDK, TypeScript), `config/models.ts` (all Bedrock model IDs), `scripts` (seed, migrations, fake PDFs, restore drill).
2. **Backend = Next.js route handlers** (spec allowed "Next.js server routes or a Node API"), run through a small custom server (`apps/web/server.ts`). The custom server is needed for the voice WebSocket that relays audio to Amazon Transcribe.
3. **Two runtime modes, same code.** `ABA_MODE=aws` uses Bedrock, S3, Textract, Transcribe, Cognito and SQS. `ABA_MODE=local` uses local Postgres, filesystem storage with HMAC-signed expiring URLs (stands in for S3 presigned URLs), in-process jobs, and a **deterministic mock AI**. The mock keeps the same contracts and integrity rules (never invents numbers, emits placeholders), so the pipeline is testable end to end with synthetic data and no AWS account. Local mode is synthetic-data only and is shown with a banner.
4. **One CDK "Platform" stack** (network, data, auth, app) plus a separate "Security" stack. Splitting foundation and app into separate stacks created KMS/IAM grant cycles; one stack avoids them without hand-written key policies.
5. **Plain SQL migrations** (`packages/core/migrations`) instead of an ORM, so row-level security policies, triggers and grants are written explicitly and reviewable.

## Data and security

6. **Tenant isolation is enforced in Postgres.** Every request runs in a transaction that sets `app.tenant_id`, `app.user_id` and `app.role`. RLS is enabled *and forced* on every table. The app connects as `aba_app` (not the owner, `NOBYPASSRLS`). BCBA-only-assigned-clients and read-only-sees-final-plans are also RLS policies, not just code checks.
7. **Super admin sees no client data by default.** A super admin creates a time-limited support grant (5 to 240 minutes, reason required). Entering a tenant is logged in that tenant's audit log, and the support session is read-only.
8. **Audit log is append-only at the database level.** The app role has no UPDATE/DELETE grant, there are no UPDATE/DELETE policies, and a trigger blocks UPDATE/DELETE/TRUNCATE even for the owner.
9. **Finalized plan versions are locked by a trigger.** "Reopen as new version" creates a new draft version on top of the locked one.
10. **Login.** AWS mode uses Cognito server-side auth flows (USER_PASSWORD_AUTH plus required TOTP MFA, with MFA setup on first login); the app then issues its own HttpOnly, SameSite=Strict session cookie. Local mode runs the same two-step flow against bcrypt and TOTP in Postgres. The 15-minute idle timeout is enforced by edge middleware and the server (sliding `lst` claim) and by a client-side timer with a one-minute warning.
11. **PHI never goes in URLs.** All routes use UUIDs, S3 keys contain only UUIDs, download filenames go in Content-Disposition only, and SQS messages carry IDs only.
12. **Logging.** An allow-list logger: only named metadata keys are emitted, and string values are scrubbed of date, phone, email and long-ID patterns. Errors are logged by name or code only. API errors return generic messages. Tests assert that synthetic names, DOBs, IDs and answer text never appear in log output.
13. **Field-level encryption.** PHI columns rely on RDS storage encryption with the customer-managed KMS key, as the spec says. No extra application-level column encryption was added.

## Template (from the We Achieve ABA treatment plan PDF)

14. **The We Achieve ABA template was imported from the uploaded treatment plan PDF** (`packages/core/src/template/we-achieve-template.ts`): 20 sections, 142 fields (~150), 29 guided questions, 46 fields tagged `ccp8f_required`, and 13 validation rules stored as data.
15. **Template fixes applied on import** (spec open decision: "Fix the template issues… before importing"):
    - Pages 1–4 repeat *Patient Information*, *Assessment Information*, *Plan & Authorization* and the *Developmental History* table. Merged into one copy of each.
    - The *Behavior Intervention Plan* block, repeated 3 times, became one table with one row per target behavior (so it is not capped at 3).
    - Blank `{name}` and `{diagnosis}` slots in boilerplate became tokens (`{{first_name}}`, `{{diagnosis}}`…) filled from the client record.
    - The "Goal" column header was split across lines in the PDF ("Goa l", "Statu s"). Normalized.
    - The summary's hard-coded "F84.0" and "40 hours individual / 20 hours group" boilerplate was not kept as static text, because those numbers must come from data. They are now fields.
    - The Telehealth table has rows 97151/97155/97156. The "97153 is never telehealth" rule also checks the Requested Services *Location* column for "telehealth".
16. **Hours consistency groups**: `hours_97153`, `hours_97155` and `hours_97156` link the Requested Services table, Medical Necessity #4 (narrative mention), the Projected Schedule (sum of days), the Full Daily Schedule (time ranges parsed from text, 97153 only) and the Transition Plan "Current" row. Daily-schedule text is never rewritten automatically; it is flagged as mismatched for the BCBA.

## AI

17. **Pre-fill is deterministic, not AI.** The AI extracts facts into the evidence table. Mapping facts into template fields is rule-based, so no number reaches the plan without an evidence row behind it.
18. **Structured output = forced tool use + Zod validation, one retry, then a visible error** (spec). Generated content is post-checked: writes outside the requested fields are dropped, made-up source IDs are stripped, and numbers that appear in no file or answer are added to the review list as "unsupported".
19. **Conflict detection** runs as an AI review pass (Sonnet). The BCBA's answer stays in the text; the conflict goes on the review list.
20. **Model IDs** in `config/models.ts` are Bedrock US cross-region inference-profile IDs for the Claude 5.5 family (`us.anthropic.claude-*-5-5`, confirmed against account 324404179405 on 2026-10-26; the earlier `-v1:0` suffix was wrong). **Confirm the exact IDs in the Bedrock console** before deploying to a new account. IAM is scoped to exactly these IDs, and a check refuses Fable/Mythos IDs.
21. **Complex case (Opus)** is a per-plan toggle that only company admins can change (spec: "Admin setting, per plan").
22. **Voice** uses Transcribe *Medical* streaming (DICTATION, PRIMARYCARE) with a custom medical vocabulary of ABA terms, created by a CDK custom resource. The browser downsamples mic audio to 16 kHz PCM in memory, and the server relays frames without storing them.

## Product open decisions (defaults chosen; easy to change)

23. **Clinical directors cannot finalize** by default. This is a tenant setting (`settings.clinical_director_can_finalize`). Company admins can finalize only if their credential contains "BCBA".
24. **Retention default: 2,555 days (7 years)** per tenant (`settings.retention_days`), applied daily by a scheduled worker task. NC Medicaid/Trillium contract terms still need confirming (open decision).
25. **E-signature**: not built yet (marked optional in the spec, vendor choice open). Exports include signature blocks.
26. **App name/domain**: placeholders (`*.REPLACE-ME.example`) in `infra/cdk.json`.
27. **Export layout**: DOCX is generated with docxtemplater from the company Word template. A built-in branded template is used until the admin uploads their own .docx containing a `{@body}` paragraph. PDF is made from the DOCX by LibreOffice in the worker. Draft exports are marked "DRAFT".
28. **Retention, backups**: RDS keeps 35-day automated backups, AWS Backup takes daily (35 days) and monthly (7 years) copies of RDS and S3, and `scripts/restore-test.sh` is the local restore drill.
29. **Region: us-east-2 (Ohio).** The AWS organization (management account 981292888517) applies an SCP (`AdvancedModeRegionRestrictionSecurityControlPolicy`) that denies regional workloads (EC2, VPC, RDS, ECS, S3 buckets) in us-east-1 and allows everything in us-east-2. Bedrock calls are allowed in all regions, and the `us.anthropic.*` cross-region profiles work from us-east-2. Identity Center stays in us-east-1.
30. **Fewer guided questions.** A question is skipped whenever the files, the previous plan or the evidence table say anything about it, and answers get no AI follow-ups; gaps surface as "BCBA to confirm" in the draft and review list.
31. **Reassessments start from last period's plan.** Carried-forward fields are kept by generation unless the BCBA answers their question. The client's identity (name, DOB, gender, insurance, member ID) carries too; period dates and signatures never do. A plan written outside the app can be imported (Word/PDF, `files.purpose = previous_plan`): Claude copies its wording into matching fields, and blanks in the client record are filled (never overwritten).
32. **Graphs.** PDF pages that draw many vector paths or embed images (max 20 per file) and PNG/JPG uploads are rendered and read by Sonnet: each graph becomes "Graph: …" evidence rows (values marked approximate) and a cropped image in `figures` (same RLS as plan child tables, same KMS bucket, deleted with its file/plan/client). Graphs the BCBA ticks are embedded in a "Graphs" section of the Word/PDF export. Graph-reading failures add a review item and never block text extraction.
