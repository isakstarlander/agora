# Agora — Product Requests (PR) Index

This folder contains a sequence of **product requests** that, when executed in order, take Agora from zero to a production-ready AWS deployment. Each request is self-contained and written to serve as the full context for a single one-shot build prompt.

The sequence maps onto the phased roadmap in `../11-roadmap.md`; PR numbers do **not** match phase numbers because several phases fan out to more than one PR.

## How to use this folder

1. Pick the lowest unfinished PR number. Verify its **Prerequisites** are done.
2. Hand the entire contents of that PR to a capable implementer (human or LLM). That file alone must contain enough context to produce the described deliverable without consulting the `../00-*.md`–`../12-*.md` plans.
3. Perform the **Manual steps** the PR calls out (AWS console actions, secret population, external signups, etc.).
4. Verify the **Acceptance criteria** are met, then move on.

## Authoring conventions

Each PR has the same top-level sections:

1. **Title & outcome.** One sentence on what is shipped.
2. **Roadmap anchor.** Which phase of `../11-roadmap.md` this contributes to.
3. **Prerequisites.** PRs that must be complete. External prerequisites (e.g. Bedrock access granted) are listed here too.
4. **Context.** The self-contained slice of the plan that an executor needs to do this work. No external reading required.
5. **Scope / Deliverables.** Files to create, resources to provision, behaviours to implement.
6. **Manual steps.** Anything that cannot live in IaC — console clicks, Secrets Manager values, email verifications, DNS changes.
7. **Acceptance criteria.** Concrete, checkable statements.
8. **Out of scope.** Items deliberately deferred, with the PR that picks them up.

## PR sequence

| # | File | Roadmap | Outcome |
|---|---|---|---|
| 00 | `PR-00-aws-account-bootstrap.md` | Phase 0 | AWS account hardened, Bedrock + Manifesto Project approvals requested, Budgets wired. |
| 01 | `PR-01-cdk-monorepo-scaffold.md` | Phase 1 | Empty but deployable CDK monorepo with 5 stack skeletons, pnpm/npm workspaces, CI lint. |
| 02 | `PR-02-data-stack-foundation.md` | Phase 1 | `AgoraDataStack` with S3 buckets (`raw`, `parquet`, `logs`), DynamoDB tables, Secrets Manager entries, EventBridge bus, Glue Data Catalog skeleton. No compute yet. |
| 03 | `PR-03-riksdagen-ingestion.md` | Phase 1 | Node Lambdas `fetch-riks-documents`, `fetch-riks-votes`, `fetch-riks-speeches`, `fetch-riks-members` with EventBridge schedules and cursors. |
| 04 | `PR-04-fanout-doctext-stepfunctions.md` | Phase 1 | Step Functions state machine `fanout-doctext` + support Lambdas for per-document body text fetch. |
| 05 | `PR-05-esv-manifesto-ingestion.md` | Phase 1 | Node Lambdas `fetch-esv` (Statskontoret årsutfall) and `fetch-manifesto` (WZB Manifesto Project), with schedules. |
| 06 | `PR-06-transform-lambda.md` | Phase 1 | Python container Lambda `transform` — S3-event driven raw→Parquet mapping for all entities. |
| 07 | `PR-07-derive-lambda.md` | Phase 1 | Python container Lambda `derive` — DuckDB-SQL analytical tables (cohesion, divergence, attendance, etc.) with SQS debouncing. |
| 08 | `PR-08-api-stack-read.md` | Phase 2 | `AgoraApiStack` — API Gateway HTTP API + `api` Lambda (DuckDB over Parquet) serving every `/v1` read route except LLM ones. |
| 09 | `PR-09-web-port-static-export.md` | Phase 3 | Fork `agora/agora/apps/web` → `agora/web/` as Next.js static export; strip Supabase / Vercel / PostHog / Sentry / API-key UI; rewire data fetching to `/v1/*`. |
| 10 | `PR-10-web-stack-cloudfront.md` | Phase 3 | `AgoraWebStack` — `agora-web` S3 bucket, CloudFront distribution with two origins (S3 default + API Gateway for `/v1/*`), ACM cert, AWS WAF rate rule. |
| 11 | `PR-11-obs-stack.md` | Phase 4 | `AgoraObsStack` — CloudWatch dashboard, alarms, SNS topic, SES weekly digest Lambda, AWS Budgets (20/30/50 USD). |
| 12 | `PR-12-embed-chunks-lambda.md` | Phase 5 | `embed-chunks` Python container Lambda — walks `document_chunks`, calls Bedrock Titan Embed v2, writes `document_embeddings` Parquet. Weekly schedule. |
| 13 | `PR-13-llm-read-summary-search.md` | Phase 5 | `llm-read` Python container Lambda — `POST /v1/summarise` + `POST /v1/search` with DynamoDB cache, Bedrock Haiku + NumPy cosine, wired into the API. |
| 14 | `PR-14-llm-stack-accountability.md` | Phase 6 | `AgoraLlmStack` — SQS + `enqueue-accountability` + `llm-acc` worker + DynamoDB caches + `POST /v1/accountability` and poll route. |
| 15 | `PR-15-cicd-github-actions.md` | Cross-cutting | GitHub Actions + OIDC federation: `cdk diff` on PRs, `cdk deploy --all` on `main`, web build+sync step, no long-lived access keys. |
| 16 | `PR-16-production-cutover.md` | Phase 3 acceptance | End-to-end smoke tests, DNS cutover (if custom domain), 48-h soak, sign-off checklist. |
| 17 | `PR-17-phase-9-commercial-tier.md` | Phase 9 (optional) | Flips `apiTiers=on`: Lambda authorizer, `api_keys` DynamoDB table, Stripe integration, `/dev` dashboard page, tiered rate-limit logic. Optional, post-launch. |

## Minimum PR-set for an initial production dashboard

PRs **00 → 11**, in order, ship a working, useful, public Swedish-language dashboard served from AWS with ingestion running on schedule, observability wired, and cost alarms active. Everything beyond PR-11 is LLM polish (PR-12 / PR-13 / PR-14), CI automation (PR-15), the production sign-off checklist (PR-16), or the optional commercial product tier (PR-17). A single maintainer can complete PRs 00–11 in roughly 10–14 working days; PRs 12–14 add another ~1 week; PR-17 is 1–2 weeks part-time and strictly optional.

## A note on reuse from `./agora/`

The subdirectory `./agora/` contains the prior (Supabase-based) implementation. Multiple PRs — most visibly PR-03, PR-05, PR-06, PR-09, PR-13, PR-14 — **port** code from there rather than writing from scratch. Each PR calls out the specific source files it draws on. Do not rewrite logic that already works upstream; the port is a change of substrate, not a redesign.

## Guardrails that apply to every PR

Copied here so they don't have to be re-established in each file:

- **Region:** `eu-north-1` (Stockholm). Fall back to `eu-west-1` only if a specific Bedrock model is not available there at deploy time.
- **Runtime:** Lambda — Node 20 (ARM64) for ingestion; Python 3.12 (ARM64, container image) for transform / derive / api / llm-read / llm-acc / embed-chunks.
- **IaC only:** Every resource is created in CDK. No console-created resources except for explicitly listed one-off "manual" steps (SES verification, Bedrock model access, SNS email confirm, secret population).
- **No third-party hot-path SaaS.** No Supabase, Vercel, Upstash, Voyage AI, PostHog, Sentry, Pinecone, Weaviate, or Qdrant in any PR.
- **Citations everywhere.** Any LLM-generated text must carry the source `dok_id`s / `manifesto_id`s / `source_url`s it relied on; if citations fail validation, return the primary source URL instead.
- **Public-only data.** We store nothing beyond what is already public under *offentlighetsprincipen*. No user accounts, no cookies beyond strictly-necessary.
- **Parquet + DuckDB on hot path; DynamoDB for mutable state.** No hosted Postgres. Ever.
