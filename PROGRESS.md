# Progress

Built 2026-10-26 in one session, following the spec phase by phase. All development and testing used **synthetic data only**.

## Blockers (owner action needed)

1. **No usable AWS credentials in the build environment.** STS rejected the provided keys (`InvalidClientTokenId`), so **`cdk deploy` (dev) was not run** and **Bedrock / Textract / Transcribe / Cognito were not called live**. All AWS paths are written against the AWS SDK v3 and are type-checked. CDK for dev and prod **synthesizes**, and its templates are assertion-tested. To deploy dev:
   - accept the AWS BAA in AWS Artifact; enable Bedrock model access for the Claude 5.5 models (US cross-region profiles, used from us-east-2) and confirm the IDs in `config/models.ts`
   - set `domainName` and `alarmEmail` (and optionally `hostedZoneId`/`hostedZoneName`) under `aba:dev` in `infra/cdk.json`
   - follow docs/AWS_SETUP.md (step-by-step), which ends with `pnpm cdk:deploy:dev`
2. **Docker image not built here.** The sandbox's network proxy rejects Debian's plain-HTTP package mirrors, so `docker build` could not finish in this environment. The Dockerfile is standard (node:22-bookworm-slim, pnpm, LibreOffice in the worker target). The first `cdk deploy` builds it on a normal machine or in CI.
3. **Open product decisions** (defaults chosen, see DECISIONS.md #23–27): retention period vs. NC Medicaid/Trillium contract, e-signature vendor, whether clinical directors can finalize, app name/domain, pricing.

## Phase 0 – Foundation ✅ (deploy blocked, see 1)
- Monorepo, CDK stacks (VPC with endpoints, KMS, RDS, S3, SQS, Cognito, ECS, ALB, WAF, Security), CI pipeline (`.github/workflows/ci.yml`), seed script with 3 synthetic clients and fake PDFs (`pnpm seed`, `pnpm fixtures`).
- Done-when, verified locally: login with MFA works (TOTP, browser e2e). CDK test asserts that only the load balancer is public. `cdk deploy` not run (blocker 1).

## Phase 1 – Template engine ✅
- Template JSON schema (`template/schema.ts`). We Achieve ABA template imported from the uploaded treatment plan PDF, with fixes (DECISIONS #15): 20 sections, **142 fields**, **29 guided questions**, 46 `ccp8f_required`, 13 rules as data.
- Rendered as an editable document in page order with length type, question and required flags (`FieldEditor`). Tests: `rules.test.ts` › template.

## Phase 2 – Upload and extraction ✅
- Presigned direct upload (S3 / signed local URLs), PDF text via unpdf, Textract for scanned pages and images (local mode flags them `needs_ocr` instead of guessing), DOCX/CSV/XLSX readers, Haiku extraction into the evidence table, BCBA fact review screen (correct/delete/add/confirm), deterministic pre-fill with source and status.
- Done-when: uploading the 3 fake PDFs pre-fills scores (current/prior/change), dates, diagnoses and utilization with correct file and page (`pipeline.test.ts`, browser e2e).

## Phase 3 – Guided chat and voice ✅ (Transcribe not run live)
- Question flow with "answered by files" skip, "partly known" preface ("The Vineland-3 from 3/2026 shows Communication SS 68…"), at most 2 follow-ups, skip/back/jump, progress bar, autosave and resume.
- Mic: browser streams 16 kHz PCM over a WebSocket to Transcribe Medical with an ABA custom vocabulary. The transcript lands in the input box to correct before sending. No audio is stored, and browser speech recognition is never used.
- Done-when: all 29 questions answered (voice mode recorded), vague answers trigger follow-ups (`pipeline.test.ts`). Live Transcribe not run (blocker 1).

## Phase 4 – Narrative generation and review ✅
- Section-by-section generation (Sonnet) streamed to the editor over SSE, length types, placeholders, per-sentence source key, review list (placeholders, conflicts, low BCBA input, unsupported numbers, linked-hours mismatches, carried-forward, OCR).
- Done-when: full draft in well under 3 minutes locally; the planted conflict (BCBA "Communication SS 72" vs file 68) and a missing number (caregiver sessions) both appear on the review list (`pipeline.test.ts`). Real-model latency still to be measured on Bedrock.

## Phase 5 – Editor and chat editing ✅
- TipTap document editor with click-to-type, side chat (typed or voice) with before/after diff and per-change accept/reject, consistency engine, version history with view/restore.
- Done-when: "Change 97153 to 12 hrs/week" updates the code table, Medical Necessity #4, the projected schedule and the transition plan, and flags the daily schedule; restoring a version works (`pipeline.test.ts`, `rules.test.ts`, browser e2e).

## Phase 6 – Validation, finalize, export ✅
- All 11 CCP 8F checks from the spec as template data, finalize locks the version and stamps the final date, reopen creates a new version, DOCX (docxtemplater + company Word template) and PDF (LibreOffice).
- Done-when: a plan missing a caregiver goal cannot be finalized; export uses the template layout with header, footer and signature blocks (`pipeline.test.ts`, browser e2e downloads DOCX and PDF).

## Phase 7 – Admin template chatbot ✅
- Admin chat → structured diff → preview of changed sections with a sample rendered page → publish with change reason; compliance guard (typed reason, re-checked server-side); rollback; new plans use the latest version; drafts migrate only on "Update to latest template"; DOCX → template draft conversion; company Word template upload for export.
- Done-when: an admin adds a field by chat and it appears in new plans only; removing a CCP 8F field shows a warning (`templates.test.ts`, browser e2e).

## Phase 8 – Hardening ✅ (AWS parts deploy with blocker 1)
- Audit log UI with search, retention job (daily scheduled task) and client-data deletion, GuardDuty/Security Hub/Config/CloudTrail, backup plan plus restore drill, cost dashboard (`/admin/usage`), prod stack defined (Multi-AZ, deletion protection, retained data) but **not deployed**.
- Restore drill: `scripts/restore-test.sh` **passed** (13 tables, row counts match).
- Dependency scan: `pnpm audit --audit-level high` passes after upgrading to vitest 3 and zod 4 and pinning postcss. 6 moderate advisories remain in dev tooling.
- SECURITY.md maps every safeguard to its implementation. Ready for the HIPAA consultant review once deployed.

## Phase 9 – Multi-tenant sales ✅
- Tenant onboarding (super admin console), per-tenant branding/templates/users, usage per tenant, logged and time-limited read-only support sessions.
- Done-when: a second test company can't see any of the first company's data, verified by tests that run raw SQL against every table (`isolation.test.ts`). Usage billing shows per-tenant AI cost and report counts. Automated invoicing waits on the pricing decision.

## Test summary
- `pnpm test`: **74 tests passing** (rules and consistency engine, RLS tenant isolation and roles, full pipeline including DOCX/PDF export, clinical integrity and placeholders, no PHI in logs, template chatbot, sessions, rate limiting, CDK assertions).
- Browser e2e (Playwright, production build): login with TOTP → upload 3 PDFs → guided questions with follow-up → generate → review → chat edit with linked fields → click-to-edit → versions → checks → DOCX/PDF download → admin template chat → compliance guard → audit → usage. No console errors.

## Not done / next
- E-signature (optional in spec; waiting on the vendor decision).
- Live AWS deploy and verification of Bedrock prompts against the real models (blocker 1); tune prompts on synthetic plans once Bedrock access exists.
- Automated invoicing for other companies (pricing open).
