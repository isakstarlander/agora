# 10 — IaC bootstrap

This document describes the AWS CDK project that defines and deploys the entire Agora stack. It answers the question *"I have a clean laptop and a clean AWS account; what do I do?"*.

## 1. Tooling

- **AWS CDK** v2, TypeScript flavour.
- **Node.js 20 LTS** (the runtime we also use in Lambdas).
- **AWS CLI v2**.
- **Docker** (required by CDK when building container-image Lambdas — the transform/derive/llm Lambdas).
- **Region:** `eu-north-1` (Stockholm). Bedrock availability as of May 2025 included Claude Haiku 3 and Titan Embed v2 in this region; verify at deploy time and fall back to `eu-west-1` if a specific model becomes unavailable.

Everything else (pino, pyarrow, duckdb, numpy, tailwind) is a dependency of the Lambdas or the web app, not of the IaC.

## 2. Repository layout

```
agora/                    # this folder
  README.md
  00-foundation.md
  ...
  12-implementation-review.md

  iac/
    package.json
    cdk.json
    tsconfig.json
    bin/
      agora.ts                 # CDK app entry point
    lib/
      data-stack.ts            # buckets, DynamoDB, ingestion & transform Lambdas, schedules, fanout state machine
      api-stack.ts             # API Gateway HTTP API + api-lambda + llm-read-lambda
      llm-stack.ts             # accountability SQS + enqueue-lambda + llm-acc-worker
      web-stack.ts             # CloudFront + S3 web bucket + WAF web ACL + certs
      obs-stack.ts             # dashboards, alarms, budgets, SES digest
      constructs/
        parquet-lambda.ts      # common Lambda factory for the container-image Lambdas
        schedule.ts            # helper for EventBridge scheduler entries
    lambda/
      fetch-riks/              # Node 20 source (documents, votes, speeches, members)
        package.json
        src/documents.ts
        src/votes.ts
        src/speeches.ts
        src/members.ts
      fetch-esv/               # Node 20 source
        src/index.ts
      fetch-manifesto/         # Node 20 source
        src/index.ts
      fanout-doctext/          # Step Functions support Lambdas
        src/list_new_docs.py
        src/fetch_detail.ts
        src/fetch_body.ts
        src/write_authors.py
        src/write_alias_index.py
      transform/               # Python container
        Dockerfile
        src/handler.py
        src/mapping/*.py
      derive/
        Dockerfile
        src/handler.py
        sql/
          party_cohesion.sql
          party_divergence.sql
          attendance_monthly.sql
          votes_wide.sql
          budget_by_area.sql
          manifesto_by_category.sql
      embed-chunks/
        Dockerfile
        src/handler.py
      api/
        Dockerfile
        src/handler.py
        src/routes/*.py
      llm-read/
        Dockerfile
        src/handler.py
        prompts/
          sammanfattning.v3.sv.md
      enqueue-accountability/
        src/index.py
      llm-acc/
        Dockerfile
        src/handler.py
        prompts/
          ansvarsutkravande.v2.sv.md
        mappings/
          topic_to_cmp.yaml
          topic_to_uo.yaml

  web/                      # the Next.js app ported from ./agora/apps/web
    package.json
    next.config.ts          # output: 'export'
    app/
      [locale]/
        page.tsx
        ledamoter/
        motioner/
        voteringar/
        budget/
        ansvar/
        sok/
        metodik/
    components/
    public/

  docs-site-source/         # optional: markdown source that is published to /om, /metodik, /privacy
```

The `iac/`, `web/`, and `docs-site-source/` folders do not yet exist — this document is the plan for their shape.

## 3. Stacks

Five CloudFormation stacks. Deployment order matters; CDK handles it via cross-stack references.

### 3.1 `AgoraDataStack`

- `agora-raw`, `agora-parquet`, `agora-logs` S3 buckets (with block-public-access, versioning, lifecycle rules).
- DynamoDB tables: `ingest_cursors`, `ingestion_runs`, `summary_cache`.
- Secrets Manager entry: `/agora/manifesto/api_key`.
- Lambdas: `fetch-riks-documents`, `fetch-riks-votes`, `fetch-riks-speeches`, `fetch-riks-members`, `fetch-esv`, `fetch-manifesto`, `transform`, `derive`, `embed-chunks`.
- Step Functions state machine `fanout-doctext` (Map state with MaxConcurrency = 10) + its support Lambdas `list_new_docs`, `fetch_detail`, `fetch_body`, `write_authors`, `write_alias_index`.
- EventBridge schedules: `agora-ingest-riks-documents`, `agora-ingest-riks-votes`, `agora-ingest-riks-speeches`, `agora-ingest-riks-members`, `agora-ingest-esv`, `agora-ingest-manifesto`, `agora-embed-chunks`, `agora-ingest-full-refresh`.
- S3 event notification from `agora-raw/**/manifest.json` → transform Lambda.
- SQS queue between transform and derive for batch coalescing.

### 3.2 `AgoraApiStack`

- Lambdas: `api` (DuckDB read path), `llm-read` (summaries + hybrid search), `enqueue-accountability` (lightweight async-enqueue).
- API Gateway HTTP API with routes as in `06-storage-and-api.md` §2.
- IAM roles `AgoraApiRole`, `AgoraLlmReadRole`, `AgoraEnqueueRole`.
- Bedrock model access grants (scoped to the Claude Haiku and Titan Embed model ARNs).
- CORS restricted to the CloudFront distribution domain (cross-stack import from `AgoraWebStack`).
- **OpenAPI build step:** a CDK custom resource runs the route-spec emitter during synth and uploads `v1.json` to `agora-web/openapi/` as part of the `BucketDeployment`.
- **Reserved (guarded by `apiTiers=on`):** authorizer Lambda, `api_keys` DynamoDB table, key-admin Lambda, `/pro/v1/*` route group attached to the same handlers. Default deploy does not provision any of these; the construct factory exists and is wired in code so enabling the flag is a one-line change.

### 3.3 `AgoraLlmStack`

- SQS queue `accountability-queue` with a dead-letter queue `accountability-dlq` (max-receive 3).
- DynamoDB tables: `accountability_cache`, `accountability_jobs`.
- Lambda `llm-acc` (Python 3.12 container, 3,008 MB) subscribed to `accountability-queue`.
- IAM role `AgoraLlmAccRole` with the scoped Bedrock + DynamoDB + SQS permissions.
- Alarms on `AccountabilityJobFailures` and DLQ depth.

Separated from `AgoraApiStack` because the worker has a different failure profile (long-running, queue-driven, container image) than the synchronous read path, and because isolating its IAM role simplifies auditing of which role can call Bedrock with the accountability prompt.

### 3.4 `AgoraWebStack`

- `agora-web` S3 bucket (block-public-access, SSE-S3).
- CloudFront distribution with two origins:
  - S3 `agora-web` (default behaviour).
  - API Gateway execute-api URL for `/v1/*`.
- WAF Web ACL with a rate-based rule of 300 req/5min/IP, attached to the CloudFront distribution.
- ACM public certificate in `us-east-1` (required for CloudFront), provisioned via a `DnsValidatedCertificate` construct if a custom domain is configured via context.
- Route 53 hosted zone + A/AAAA alias records **only if** `context.domain` is set; otherwise the default `*.cloudfront.net` is used.

### 3.5 `AgoraObsStack`

- CloudWatch dashboard `AgoraOps`.
- SNS topic `agora-ops-alerts` with one email subscription (from SSM `/agora/ops/alert_email`).
- CloudWatch alarms listed in `09-observability-and-security.md`.
- AWS Budgets (20 / 30 / 50 USD actual, 75 USD forecast).
- Weekly digest Lambda + EventBridge schedule + SES domain identity (requires post-deploy verification of the email address).

## 4. Bootstrap

```bash
# 1. Install deps
cd iac
npm ci

# 2. Authenticate to AWS (pick one)
aws configure sso --profile agora-se
# or
export AWS_PROFILE=agora-se

# 3. CDK bootstrap (first time only, per account+region)
npx cdk bootstrap aws://<account-id>/eu-north-1

# 4. Set required context (in cdk.json or on the command line)
#    - contactEmail:  address the ops digest and alarms go to
#    - domain:        OPTIONAL custom domain
#    - bedrockModels: list of model ARNs to grant
npx cdk deploy --all \
  -c contactEmail=you@example.com \
  -c bedrockModels='["arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0","arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0"]'
```

Post-deploy one-off steps that genuinely cannot be automated:

- **Confirm SES email identity** (AWS sends a verification link to the address).
- **Request Bedrock model access** for the two model ids above (console: Bedrock → Model access). This is a human-approval step that can take a few minutes to a day.
- **Confirm the SNS email subscription** (AWS sends a confirmation link).
- **Populate the Manifesto Project API key** into Secrets Manager: `aws secretsmanager put-secret-value --secret-id /agora/manifesto/api_key --secret-string <key>`. The secret is created empty by CDK; the value is inserted by hand once (keys are small and change rarely).

Everything else is hands-off.

**Phase 9 additional one-off steps (only when `apiTiers=on`):**

- **Populate the API-key pepper:** `aws secretsmanager put-secret-value --secret-id /agora/api_keys/pepper --secret-string "$(openssl rand -hex 32)"`. The pepper value is never rotated (rotating would invalidate every issued key); it is populated once per AWS account.
- **Populate the Stripe secrets** (`/agora/stripe/secret_key`, `/agora/stripe/webhook_signing`) from the Stripe dashboard.
- **Add the Stripe webhook endpoint** (`https://agora.<domain>/v1/stripe/webhook`) in the Stripe dashboard and copy the signing secret into SSM.
- **Re-run `cdk deploy`** so the authorizer picks up the populated secrets on cold start.

## 5. Environments

One production environment is sufficient for MVP. For iteration we add a `dev` environment on demand using CDK context:

```bash
npx cdk deploy --all -c env=dev -c contactEmail=you+dev@example.com
```

This creates parallel stacks named `AgoraDataStack-dev`, etc., with a `dev-` prefix on all resources. Data is separate, costs are additive.

We avoid separate AWS accounts at this scale; the added complexity is not worth the isolation for a dashboard that holds only public data.

## 6. CI/CD

Minimal GitHub Actions workflow, described here so the spec is complete:

- **On push to `main`:** run `cdk diff` and `npm test` (web + lambda unit tests). If clean, `cdk deploy AgoraDataStack AgoraApiStack AgoraWebStack AgoraObsStack --require-approval broadening`.
- **Secrets:** a single IAM role in the AWS account, assumed via OpenID Connect federation from GitHub. No long-lived access keys.
- **Build artefact (web):** `npm run build` in `web/`, output synced by CDK's `BucketDeployment` construct to `agora-web`, followed by a CloudFront invalidation of `/*`.

CI is explicitly documented here but can be implemented later — the first few deploys from a laptop are fine.

## 7. Ops flags (deploy-time knobs)

| Flag | Default | Effect |
|---|---|---|
| `-c rebuild=true` | `false` | Spins up the one-off Step Functions state machine that re-transforms every manifest in `agora-raw/`. |
| `-c reembed=true` | `false` | Forces `embed-chunks` to re-compute every `document_embeddings` row (e.g. when bumping the embedding model). |
| `-c waf=off` | `on` | Removes the WAF Web ACL and switches to the CloudFront-Function + DynamoDB rate limiter. |
| `-c bedrock=off` | `on` | Omits the LLM Lambdas and their permissions; `/v1/summarise`, `/v1/search`, and `/v1/accountability` return 501. |
| `-c scheduleIntensity=low\|normal\|high` | `normal` | Adjusts ingestion cadence; `low` is weekly, `normal` is daily, `high` is 2× daily. |
| `-c ratelimit.llmRpm=<n>` | `2` | Per-principal requests-per-minute cap for LLM endpoints (enforced in-Lambda via DynamoDB). Free-tier value; paid-tier values come from the authorizer context when `apiTiers=on`. |
| `-c apiTiers=on\|off` | `off` | Reserved for Phase 9 (commercial API tier). When `on`, CDK provisions the `api_keys` DynamoDB table, the Lambda authorizer, the `AgoraAuthorizerRole` / `AgoraKeyAdminRole` IAM roles, the empty Stripe secrets (`/agora/stripe/*` and `/agora/api_keys/pepper`), and attaches the authorizer to the existing HTTP API. No handler code changes. Default stays `off` for MVP. |

These flags are not a substitute for thought — they are escape hatches for the specific failure modes anticipated in `09-observability-and-security.md`.

## 8. Drift and state

CDK deploys via CloudFormation; state lives in AWS, at no extra cost. Drift between CDK source and deployed reality is detected by `cdk diff` in CI on every push; any drift fails the pipeline and forces a resolution via code.

## 9. Teardown

```bash
npx cdk destroy --all
```

This removes the CloudFormation stacks. S3 buckets with `retain` policies (`agora-raw`, `agora-parquet`) survive by design — they contain the only data that is not derivable. To nuke them too:

```bash
aws s3 rb s3://agora-raw-<account-id> --force
aws s3 rb s3://agora-parquet-<account-id> --force
```

The `retain` policy is a safety net for the accidental-destroy scenario; it is deliberate friction.
