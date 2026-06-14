# Agora

> *"The agora was the open gathering place of the ancient Greek city — the space where citizens could see what was being decided, by whom, and on what grounds."*

**Agora** is a low-cost, AWS-native, infrastructure-as-code plan for a public-facing dashboard that lets Swedish members of the society critically review and get transparent insight into the actions of the Riksdag over a defined period of time.

This directory is intentionally self-contained. It references **no documents outside this folder**. You can move `agora/` to its own repository and it remains complete.

## What problem are we solving?

Foundation models have training-time knowledge of public Swedish political data (published under *offentlighetsprincipen*, the principle of public access to official records), but they do not have reliable insight into *recent* parliamentary activity. General-purpose search engines index Riksdagen's own site, but the UX is oriented toward researchers and journalists — not toward the average citizen who wants to answer questions like:

- How did *my* MP vote on the last climate bill?
- Which parties actually show up to committee meetings?
- Where did the 2026 budget's education allocations go, and how does that compare to 2023?
- What did party X promise in its election manifesto that has — or has not — resulted in a motion?

Agora's job is to make those answers cheap, fast, and trustworthy.

## Why a new plan?

A previous iteration (the `/api-first` project in our broader notes, mirrored here as the `./agora/` subdirectory) hit free-tier limits quickly because it leaned on multiple third-party SaaS tiers — most acutely the Supabase Postgres free tier when document texts plus pgvector embeddings outgrew the 500 MB ceiling, and also Voyage AI embeddings, Upstash Redis, PostHog, Sentry, Vercel hosting, and direct Anthropic API keys. Six simultaneous dependencies, each priced for growth rather than for hobby-scale transparency work.

Agora replaces those with **AWS primitives** deployed via **AWS CDK (TypeScript)**, chosen specifically so that:

1. Idle cost is as close to zero as practically possible (serverless everywhere, auto-pause / scale-to-zero where available).
2. All running components have predictable, inspectable bills.
3. The whole stack can be reproduced by a single `cdk deploy` in a fresh AWS account.
4. Scaling up costs linearly with real traffic, not with plan tiers.

## Reading order

The documents are numbered so that a newcomer can read them top-to-bottom and leave with a full mental model:

| # | File | What you'll get |
|---|------|---|
| — | `README.md` | You are here. |
| 00 | `00-foundation.md` | Vision, scope, non-goals, guiding principles, glossary of Swedish political and technical terms. |
| 01 | `01-critical-review.md` | Explicit critical review of the old plan: what we cut, what we keep, and why. |
| 02 | `02-architecture.md` | Target AWS architecture with ASCII diagram and a concrete monthly cost model. |
| 03 | `03-data-sources.md` | Full reference to all three upstream feeds: Riksdagen open-data endpoints, Statskontoret årsutfall, Manifesto Project WZB API. Legal framing, attribution rules. |
| 04 | `04-data-model.md` | Canonical schema for members, documents (incl. interpellationer and framställningar), votes split into aggregate + per-MP, speeches, budget outcomes, manifestos, and all derived analytical tables. |
| 05 | `05-ingestion.md` | EventBridge-scheduled Lambda ingestion pipeline with Step Functions fanout for document-text fetch, per-source cadence, idempotency, and back-off. |
| 06 | `06-storage-and-api.md` | S3 + Parquet + DuckDB-in-Lambda (with FTS), and the read-only HTTP API in front of it, including hybrid search, the async accountability protocol, and the "API as a product" forward-compatibility invariants that keep the door open for a later commercial tier. |
| 07 | `07-dashboard.md` | Static Next.js frontend on S3 + CloudFront; page-by-page breakdown, ported from the existing implementation. |
| 08 | `08-llm-layer.md` | Thin LLM layer (Amazon Bedrock): summaries, hybrid FTS+vector search, and 4-layer accountability synthesis with citations and async job protocol. |
| 09 | `09-observability-and-security.md` | CloudWatch, AWS Budgets (20/30/50 USD), WAF-lite, IAM roles per Lambda, secrets handling, DDoS posture. |
| 10 | `10-iac-bootstrap.md` | CDK project layout (5 stacks incl. `AgoraLlmStack` for the SQS-backed accountability worker), account bootstrap, deploy flow, ops flags. |
| 11 | `11-roadmap.md` | Phased plan (MVP → public launch), anchored on **porting** the existing implementation off Supabase rather than rewriting it. Explicit cut-list if time runs short. Phase 9 (optional, post-launch) wires a commercial API tier on top of the same endpoints without touching MVP handlers. |
| 12 | `12-implementation-review.md` | Frank two-directional critique of this plan vs. the existing code in `./agora/`, and the record of the decisions (Supabase out, accountability in, Titan Embed v2, dashboard-first) that produced the current `00-`–`11-`. Read *after* 00–11. |

## Quickstart (once implemented)

```bash
# Prerequisites: Node 20+, AWS CLI v2, an AWS account with admin IAM for the bootstrap user
npm install
npx cdk bootstrap aws://<account-id>/eu-north-1    # Stockholm region
npx cdk deploy --all --profile agora-se
```

The `eu-north-1` (Stockholm) region is chosen because (a) it minimises latency for Swedish users, (b) it keeps data within Sweden/EU jurisdiction which is friendly to *offentlighetsprincipen*-style transparency values, and (c) it is priced comparably to `eu-west-1`.

## Status

This directory contains **plans**, not code. Document `11-roadmap.md` translates the plans into a concrete phased build.
