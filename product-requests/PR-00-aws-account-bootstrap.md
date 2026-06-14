# PR-00 — AWS account bootstrap

## Outcome

An AWS account ready to accept a CDK deployment for Agora: MFA-protected root, an Identity Center admin user, AWS Budgets alarms, CloudTrail on, and Bedrock model access + Manifesto Project API key requests in flight.

## Roadmap anchor

`11-roadmap.md` — Phase 0 (½ day).

## Prerequisites

- A Swedish / EU personal or organisational email the maintainer monitors daily.
- A payment method that AWS accepts (credit card).
- Approximately one business day of wall-clock time for Bedrock model access and the Manifesto Project API key to be granted; nothing else in the PR sequence is blocked on them until PR-12.

## Context

Agora is a public Swedish-language dashboard that ingests open data from the Riksdag, Statskontoret, and the Manifesto Project, serves it as JSON through an API Gateway in front of Lambdas, and renders a statically-exported Next.js site from S3 via CloudFront. The entire steady-state cost target is under 10 USD per month. AWS Budgets is therefore wired **before** any other infrastructure, so that a misconfiguration that breaks the cost model triggers an alarm rather than a surprise invoice.

The account is deployed to only once per environment — **one production environment is sufficient for MVP.** We do not create separate AWS accounts; isolation is by resource naming only. The deploy region is `eu-north-1` (Stockholm) for data residency and latency; fall back to `eu-west-1` only if Bedrock access to Claude Haiku or Titan Embed v2 is not available in Stockholm at deploy time.

The account is **never** used for anything other than Agora. No personal projects, no dev sandboxes.

## Scope / Deliverables

All actions in this PR are AWS console, CLI, or external website actions. No code is produced.

### 1. Account creation & root hardening

1. Create (or dedicate) an AWS account at `signup.aws.amazon.com`. Use a dedicated alias email (e.g. `aws-agora+owner@…`).
2. Sign in as root. Enable a hardware or virtual MFA device on the root user. Do not create access keys for root.
3. Set the account alias to `agora` under *IAM → Account settings → Account alias* so that the sign-in URL is `https://agora.signin.aws.amazon.com/console`.
4. Set the contact information (*Account → Alternate contacts*) to a shared `ops@…` email so AWS outage and billing notices do not go dead if the root-owner email changes.
5. Enable **IAM Identity Center** (AWS SSO) in `eu-north-1`. Create one user `agora-admin` and assign the `AdministratorAccess` permission set. All subsequent console and CLI work uses this user, not root.

### 2. AWS CLI profile

On the local machine where CDK will run:

```bash
aws configure sso --profile agora-se
# SSO start URL: https://<your-sso-portal>.awsapps.com/start
# SSO region:    eu-north-1
# Default region: eu-north-1
# Output:        json
```

Verify:

```bash
aws sts get-caller-identity --profile agora-se
```

The returned `Arn` must contain `AWSReservedSSO_AdministratorAccess_…/agora-admin`.

### 3. AWS Budgets (three alarms)

In *Billing → Budgets → Create budget*, create three **cost budgets**, scoped to the full account, each notifying the maintainer email at the specified threshold:

| Budget name | Period | Threshold | Trigger | Notify |
|---|---|---|---|---|
| `agora-budget-20usd`  | Monthly | 20 USD  | Actual ≥ 100 % | Email |
| `agora-budget-30usd`  | Monthly | 30 USD  | Actual ≥ 100 % | Email |
| `agora-budget-50usd`  | Monthly | 50 USD  | Actual ≥ 100 % AND Forecast ≥ 75 USD | Email |

Store the alarm-recipient email in SSM Parameter Store **now** (we will reference it from CDK later):

```bash
aws ssm put-parameter \
  --profile agora-se --region eu-north-1 \
  --name /agora/ops/alert_email \
  --type String \
  --value "alerts+agora@example.com" \
  --overwrite
```

### 4. CloudTrail

Enable a multi-region trail for **management events** only (free).

Replace `<account-id>` in every command below with the numeric AWS account id from `aws sts get-caller-identity`.

**Step 1 — create the bucket and block public access:**

```bash
aws s3api create-bucket \
  --profile agora-se --region eu-north-1 \
  --bucket agora-cloudtrail-<account-id> \
  --create-bucket-configuration LocationConstraint=eu-north-1

aws s3api put-public-access-block \
  --profile agora-se --region eu-north-1 \
  --bucket agora-cloudtrail-<account-id> \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

**Step 2 — attach the required CloudTrail bucket policy** (save as `cloudtrail-bucket-policy.json`, then apply):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AWSCloudTrailAclCheck",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:GetBucketAcl",
      "Resource": "arn:aws:s3:::agora-cloudtrail-<account-id>"
    },
    {
      "Sid": "AWSCloudTrailWrite",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::agora-cloudtrail-<account-id>/AWSLogs/<account-id>/*",
      "Condition": {
        "StringEquals": { "s3:x-amz-acl": "bucket-owner-full-control" }
      }
    }
  ]
}
```

```bash
aws s3api put-bucket-policy \
  --profile agora-se --region eu-north-1 \
  --bucket agora-cloudtrail-<account-id> \
  --policy file://cloudtrail-bucket-policy.json
```

**Step 3 — create and start the trail:**

```bash
aws cloudtrail create-trail \
  --profile agora-se --region eu-north-1 \
  --name agora-mgmt-trail \
  --s3-bucket-name agora-cloudtrail-<account-id> \
  --is-multi-region-trail \
  --enable-log-file-validation
aws cloudtrail start-logging \
  --profile agora-se --region eu-north-1 \
  --name agora-mgmt-trail
```

The bucket has no lifecycle expiration policy (logs are retained indefinitely). Management events cost $0.

### 5. Request Bedrock model access

In `eu-north-1` → Bedrock → Model access → *Manage model access*, request access to:

- `anthropic.claude-3-haiku-20240307-v1:0` (or the latest small Claude available in `eu-north-1` at request time).
- `amazon.titan-embed-text-v2:0`.

Submit the form. Approval typically arrives in minutes but can take up to a business day. None of PR-01 through PR-11 need Bedrock, so this approval can run in the background.

If either model is unavailable in `eu-north-1` at the time of the request, document the fallback choice in `/agora/ops/bedrock_region`:

```bash
aws ssm put-parameter --profile agora-se --region eu-north-1 \
  --name /agora/ops/bedrock_region \
  --type String --value "eu-west-1" --overwrite
```

Default value is `eu-north-1`; only set this parameter if a fallback is actually needed.

### 6. Request the Manifesto Project API key

At `https://manifesto-project.wzb.eu/information/documents/api` → register → request an API key. This is a free, human-reviewed step; typical turnaround is ~1 business day.

Do **not** commit the returned key anywhere. It will be pasted into Secrets Manager during PR-02; keep it in a password manager until then.

### 7. Reserve the Route 53 zone (optional)

If a custom domain is planned (e.g. `agora.se`, `agora-sverige.se`), register / transfer the domain to Route 53 now so that ACM certificate validation is a one-click step later. The zone can stay empty; the charge is $0.50 / month. If no custom domain is planned, skip this step and deploy against the default CloudFront `*.cloudfront.net` URL.

## Manual steps

**Everything in this PR is manual.** It is called out explicitly because it is the only PR in the sequence where no code is produced. The manual steps here are:

1. Create the AWS account, enable MFA on root, do not create root access keys.
2. Enable Identity Center, create the `agora-admin` user, sign out of root.
3. Configure the local `agora-se` AWS CLI SSO profile.
4. Create the three AWS Budgets and store the alert email in SSM.
5. Enable CloudTrail (multi-region management events).
6. **Request Bedrock model access** — wait for approval. Expected in minutes to a business day.
7. **Request the Manifesto Project API key** — wait for approval. Expected in ~1 business day.
8. Optionally: register the Route 53 domain.

## Acceptance criteria

- [ ] `aws sts get-caller-identity --profile agora-se` returns an ARN containing `AdministratorAccess`.
- [ ] Three budgets visible in the console; three confirmation emails received from `no-reply@…amazonaws.com`.
- [ ] `aws ssm get-parameter --profile agora-se --region eu-north-1 --name /agora/ops/alert_email` returns the alarm email.
- [ ] `aws cloudtrail get-trail-status --profile agora-se --name agora-mgmt-trail` shows `IsLogging=True`.
- [ ] Bedrock model-access status page in `eu-north-1` shows *Access granted* for both models (or the fallback region is recorded in SSM).
- [ ] Manifesto Project API key email has arrived (the key itself is not yet in AWS; that happens in PR-02).
- [ ] Root user has no access keys (confirmed in IAM dashboard warning block).

## Out of scope

- Any CDK, Lambda, or application code. That begins in PR-01.
- Deploying the CloudTrail bucket under CDK control. The trail is set up outside IaC deliberately so that turning CDK on or off does not affect auditing.
- Organisation (AWS Organizations) setup. Agora runs in a single account; organisation-level controls are unnecessary at this scale.
- Custom IAM policies for the `agora-admin` user. AdministratorAccess is sufficient because all production work is done through CDK-deployed roles, not by the human user.
