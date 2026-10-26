# AWS setup (dev environment)

About 2–3 hours, plus waiting time for Bedrock access and DNS. Do everything in **us-east-1 (N. Virginia)**.

## 1. Create and lock down the AWS account
1. Sign up at aws.amazon.com with a company email (not a personal one).
2. As root: turn on MFA for the root user (top-right menu → Security credentials → Assign MFA). Then stop using root.
3. **IAM Identity Center** → Enable → create a user for yourself → add it to a group with the `AdministratorAccess` permission set, and require MFA. Bookmark the "AWS access portal" URL it gives you. Sign in through that from now on.
4. **Billing** → Budgets: add a $300/month alert to your email (the app also creates one).

## 2. Accept the HIPAA BAA
**AWS Artifact** → Agreements → Account agreements → **AWS Business Associate Addendum** → Accept.
Do this before any real PHI is stored. (Dev uses synthetic data only, but do it now anyway.)

## 3. Turn on Bedrock model access
1. **Amazon Bedrock** → Model access (or Model catalog) → request **Anthropic Claude Haiku, Sonnet and Opus (5.5)**. Anthropic asks for a short use-case form; describe "clinical documentation drafting for ABA providers, PHI under the AWS BAA".
2. Once approved, go to **Cross-region inference** and copy the **inference profile IDs** (they look like `us.anthropic.claude-sonnet-...`). Compare them with `config/models.ts` and fix any that differ.

## 4. Domain
Pick a subdomain for dev (e.g. `dev.yourapp.com`).
- If the domain is in (or moves to) **Route 53**: Hosted zones → your domain → copy the **Hosted zone ID**. Certificates and DNS are then automatic.
- If the domain is elsewhere (GoDaddy, etc.): leave the hosted zone empty. During deploy, ACM shows a CNAME record. Add it at your registrar, then add a CNAME for `dev.yourapp.com` → the `AlbDns` value from the deploy output.

## 5. Install tools on your computer (Mac/Windows/Linux)
- Node.js 22 (nodejs.org), then `npm install -g pnpm@10`
- AWS CLI v2 (docs.aws.amazon.com/cli)
- Docker Desktop (must be running during deploy, because it builds the app images)
- Git

Log the CLI in through Identity Center:
```bash
aws configure sso          # use your access portal URL, region us-east-1, profile name: aba
aws sso login --profile aba
aws sts get-caller-identity --profile aba   # shows your 12-digit account ID
```

## 6. Configure the app
Get the code (`git clone <repo>`), then `pnpm install`. Edit `infra/cdk.json` → `aba:dev`:
```json
"aba:dev": {
  "account": "123456789012",
  "domainName": "dev.yourapp.com",
  "hostedZoneId": "Z0123456789ABC",      // "" if DNS is not in Route 53
  "hostedZoneName": "yourapp.com",        // "" if DNS is not in Route 53
  "alarmEmail": "you@yourcompany.com",
  "ownerEmail": "you@yourcompany.com"     // your platform-owner login
}
```

## 7. Deploy
```bash
cd infra
export AWS_PROFILE=aba
npx cdk bootstrap aws://123456789012/us-east-1   # one time per account
cd .. && pnpm cdk:deploy:dev                       # ~30–45 minutes
```
During the deploy:
- Confirm the **SNS subscription email** (alarms) you receive.
- If DNS is not in Route 53, add the ACM validation CNAME when the deploy pauses on the certificate.

If the deploy says GuardDuty, Security Hub or Config **already exists** in the account, set `"enableAccountSecurityServices": false` under `aba:dev` and deploy again.

## 8. First sign-in
1. Cognito emails `ownerEmail` a temporary password. Open `https://dev.yourapp.com`, sign in, set a new password, and scan the MFA QR code with an authenticator app (Google Authenticator, 1Password, etc.).
2. **Platform** page → *Onboard a company* → "We Achieve ABA" plus the company admin's email. They get their own invite.
3. The company admin adds BCBAs and other staff under **Users**.
4. Test with **synthetic data only** (`pnpm fixtures` creates fake PDFs).

## Rough monthly cost (dev)
~$250–350: VPC interface endpoints (~$150), NAT gateway (~$35), load balancer (~$20), RDS t4g.small (~$30), Fargate (~$40), plus Bedrock per use (cents to a few dollars per plan). Run `cdk destroy --all -c env=dev` when not using it for a while (dev data is synthetic and not retained).

## Before prod / real PHI
HIPAA consultant review, risk assessment, staff training, then `cdk deploy --all -c env=prod` with the `aba:prod` values filled in. Prod is Multi-AZ, has deletion protection, and retains its data.
