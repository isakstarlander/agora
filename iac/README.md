# Agora IaC

TypeScript CDK app for the Agora AWS infrastructure. Deploys five CloudFormation stacks into `eu-north-1`.

## Prerequisites

- Node.js 22 LTS (`nvm use` after checkout)
- AWS CLI v2
- Docker Desktop (required for container-image Lambda builds in later PRs)
- SSO profile `agora-se` configured: `aws configure sso --profile agora-se`

## Usage

```
cd iac
npm ci
npx cdk bootstrap aws://<account-id>/eu-north-1 --profile agora-se
npx cdk diff --all -c contactEmail=you@example.com --profile agora-se
npx cdk deploy --all -c contactEmail=you@example.com --profile agora-se
```

## Bootstrap (run once per account + region)

```bash
cd iac
npm ci
npx cdk bootstrap aws://<account-id>/eu-north-1 \
  --profile agora-se \
  --trust <account-id> \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --tags Project=agora --tags ManagedBy=cdk
```

## Ops flags (see also `10-iac-bootstrap.md` §7)

| Flag | Default | Effect |
|---|---|---|
| `-c agora:env=dev` | `prod` | Deploy parallel dev stacks with a `dev-` prefix |
| `-c agora:waf=off` | `on` | Use CloudFront-Function rate limiter instead of WAF |
| `-c agora:bedrock=off` | `on` | Omit LLM Lambdas; `/v1/summarise`, `/v1/search`, `/v1/accountability` return 501 |
| `-c agora:scheduleIntensity=low\|normal\|high` | `normal` | Adjust ingestion cadence |
| `-c agora:rebuild=true` | `false` | Trigger the one-off manifest-rescan state machine |
| `-c agora:reembed=true` | `false` | Force re-computation of every `document_embeddings` row |
| `-c agora:apiTiers=on` | `off` | Enable the Phase-9 commercial API tier |

## Stacks

| Stack | Purpose |
|---|---|
| `AgoraDataStack` | S3 buckets, DynamoDB, ingestion Lambdas, schedules |
| `AgoraApiStack` | API Gateway HTTP API + read Lambdas |
| `AgoraLlmStack` | Accountability SQS queue + worker Lambda |
| `AgoraWebStack` | CloudFront + S3 + WAF |
| `AgoraObsStack` | CloudWatch dashboards, alarms, budgets |

## Development

```bash
npm run build    # compile TypeScript
npm test         # run snapshot tests
npm run lint     # ESLint
npm run format   # Prettier
npm run synth    # cdk synth --all
npm run diff     # cdk diff --all
```
