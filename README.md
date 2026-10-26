# ABA Treatment Plan Assistant

A HIPAA-ready, multi-tenant web app for ABA companies to produce NC Medicaid (CCP 8F) treatment plans and reassessments. A BCBA uploads a client's files and answers guided questions by typing or by voice. The AI (Amazon Bedrock only) writes the clinical narrative into the company template, and the BCBA edits it through chat and finalizes it.

- **SECURITY.md**: every HIPAA safeguard mapped to code or AWS resources
- **DECISIONS.md**: decisions made during the build
- **PROGRESS.md**: phase-by-phase status and blockers
- **docs/RESTORE.md**: backup and restore procedure

> Development and testing use **synthetic data only**. Do not upload real client files until the AWS BAA is accepted, the prod stack is deployed, and the HIPAA consultant review is done.

## Layout

```
config/models.ts        Bedrock model IDs per step (only place to change models)
packages/core           domain logic: template schema, rules, consistency engine, AI pipeline,
                        Postgres access with row-level security, services, migrations, tests
apps/web                Next.js 15 UI + API routes + custom server (voice WebSocket)
apps/worker             SQS worker: extraction, generation, export, retention
infra                   AWS CDK (TypeScript): dev and prod
scripts                 seed, migrations, fake PDFs, TOTP helper, restore drill
```

## Run locally (synthetic data, mock AI)

Needs Node 22, pnpm 10, PostgreSQL 16 and LibreOffice (for PDF export).

```bash
pnpm install
pnpm db:up            # local Postgres roles + databases (scripts/local-db.sh)
pnpm seed -- --reset  # 2 test companies, a user per role, 3 synthetic clients; prints TOTP secrets
pnpm fixtures         # writes the fake client PDFs to fixtures/out/
pnpm dev              # http://localhost:3000
```

Sign in as `bcba1@demo.test` / `Demo-Passw0rd!`. For the MFA code, run `pnpm totp <secret from seed output>` or add the secret to an authenticator app. Other users: `admin@demo.test`, `director@demo.test`, `bcba2@demo.test`, `qa@demo.test`, `owner@platform.test` (platform owner).

Local mode uses a deterministic mock instead of Bedrock. It follows the same contracts and integrity rules, so the whole workflow works, but the writing is mechanical.

## Test

```bash
pnpm test         # 74 tests: rules, RLS isolation, pipeline, export, integrity, no-PHI-in-logs, CDK assertions
pnpm typecheck
pnpm audit:deps
bash scripts/restore-test.sh
```

## Deploy (dev)

See PROGRESS.md → Blockers. In short: accept the AWS BAA, enable Bedrock model access, set the domain and alarm email in `infra/cdk.json`, then `pnpm cdk:deploy:dev`. The prod stack is defined (`cdk synth -c env=prod`) and must not be deployed before the HIPAA consultant review.

## Workflow

1. **Files & facts**: drag in PDFs/DOCX/images/CSV/XLSX → extracted evidence table (fact, file, page, date, category) → BCBA corrects or deletes facts → template fields pre-fill with sources.
2. **Guided questions**: 29 questions from the template; ones the files already answer are skipped, partly answered ones show what is known; up to 2 follow-ups; mic input via Amazon Transcribe.
3. **Draft & edit**: section-by-section generation streams in; review list (placeholders, conflicts, low BCBA input, mismatches); click any field to type; side chat for edits with accept/reject; linked hours stay consistent; source key; version history.
4. **Check & finalize**: CCP 8F rule checks from the template; finalize locks the version and stamps the date; DOCX/PDF export from the company Word template.

Admins manage the template through a chatbot (structured diff, preview, compliance guard, publish and rollback), plus users, the audit log and usage.
