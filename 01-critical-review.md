# 01 — Critical review

This document challenges every tech layer in the project against the end-goal stated in `00-foundation.md` — *"a Swedish citizen opens one page, understands what the Riksdag has done about their topic, and can verify it in one tap"* — and removes anything that does not earn its keep. It is informed by a line-by-line read of the existing implementation in `./agora/` (see `12-implementation-review.md` for the full two-directional critique that produced this file).

The old iteration was framed "API-first" and lived on a Supabase + Next.js/Vercel + Voyage AI + Upstash Redis + Anthropic-direct + PostHog + Sentry stack. That stack worked, but **six simultaneous third-party free tiers** ran out in practice — most acutely the Supabase 500 MB database ceiling once document texts plus pgvector embeddings were loaded. The specific trigger for this plan is "Supabase storage is not enough"; the general response is "stop depending on third-party free tiers on the hot path".

## 1. What the old iteration contained (by theme)

- A **Next.js / Vercel web app** with `next-intl` (sv + en), shadcn components, Tailwind 4, Recharts.
- **Supabase Postgres** with the `pgvector`, `pg_trgm`, and `unaccent` extensions; twelve SQL migrations; a hybrid-search RPC; RLS-gated public reads.
- **Ingestion scripts** (`scripts/ingest/*.ts`) covering Riksdagen (documents, votes, members, full text, authorship), ESV/Statskontoret budget CSV (1997–present), and the Manifesto Project at WZB (8 parties × 4 elections).
- **Voyage AI** for 512-dimensional embeddings (with a 3 RPM free-tier ceiling).
- **Anthropic API direct** for summaries and an *accountability synthesis* endpoint that joins manifestos × motions × votes × budget per (party, topic).
- **Upstash Redis** for per-tier sliding-window rate limits.
- **PostHog + Sentry** for analytics and error reporting.
- **API-key stack**: SHA-256-hashed keys in Postgres, tiered rate limits, OpenAPI docs at `/docs`, an internal key for a *Löfteskollen* demo.
- **Turborepo** with `apps/web`, `packages/db`, `scripts`.
- **GitHub Actions** for daily ingestion, periodic embedding refresh, and manifesto/ESV backfill.

The repo is not a prototype — it is a production-shaped civic-tech app. The cost model is what broke, not the code.

## 2. Scoring each layer against the end-goal

For each layer we ask two questions:

- Does the ordinary citizen user described in `00-foundation.md` notice if this layer is missing? (**User-visible?**)
- Can we deliver transparency without it? (**Cut-able?**)

| Layer in old iteration | User-visible? | Cut-able? | Decision |
|---|---|---|---|
| Riksdagen ingestion (documents, votes, members, texts, authors) | Indirectly | No | **Keep**, port to AWS Lambda + Step Functions |
| ESV / Statskontoret budget CSV | Yes (budget pages) | No | **Keep**, port; run monthly |
| Manifesto Project ingestion | Yes (accountability) | No | **Keep**, port; run after each election |
| Canonical structured schema (12 migrations) | Indirectly | No | **Port schema shape to Parquet tables + DynamoDB caches.** No hosted Postgres. |
| Hybrid search RPC (`search_documents`) | Yes (`/sok`) | No | **Keep the idea** (FTS + vector, 40/60 weights). Reimplement as a Python Lambda using DuckDB FTS + NumPy cosine |
| Accountability synthesis endpoint | Yes — this *is* the end-goal | No | **Keep as first-class feature.** Move behind SQS + Lambda worker; do not run synchronously |
| Document summaries | Yes (motion detail page) | Partially | **Keep**, move to Bedrock Haiku, cache in DynamoDB |
| Next.js UI + next-intl + shadcn + Tailwind + Recharts | Yes | No | **Keep the code**, static-export to S3 + CloudFront. Drop Vercel hosting |
| API keys / tiered rate-limit product | No (today) | Not-for-MVP | **Cut the custom implementation** (SHA-256-in-Postgres, Upstash counters, Swagger-at-`/docs`). **Keep the seat warm** for a future paid tier built on API Gateway's native Usage Plan + API Key + per-key throttling (zero custom infrastructure). See `06-storage-and-api.md` §7 and `11-roadmap.md` Phase 9 |
| Upstash Redis | No | Yes | **Cut.** Replaced by DynamoDB TTL counter where a per-IP throttle is needed, and by WAF at the edge |
| PostHog | No | Yes | **Cut.** CloudFront access logs → daily Parquet aggregate via Athena when we need traffic numbers |
| Sentry | No | Yes | **Cut.** CloudWatch Logs + alarms → SNS → email replaces it |
| Vercel hosting | No | Yes | **Cut.** Static export to S3 + CloudFront; API routes become Lambda functions |
| Voyage AI embeddings | No | Yes | **Cut.** Replaced by Bedrock Titan Embed v2 (1024-dim, multilingual, no RPM cap in practice) |
| Anthropic direct API | No | Yes | **Cut.** Same Claude model via Bedrock, IAM-authed, single AWS bill |
| Supabase Postgres hosting | No | **Yes — this is the explicit decision behind this plan** | **Cut.** Analytical data → Parquet on S3; mutable state → DynamoDB |
| OpenAPI docs at `/docs` | Partially | Yes | **Defer.** Publish a single Markdown endpoints page when we actually document a stable public API |
| Löfteskollen demo | Partially | Yes | **Keep as Phase-6 polish** once the core dashboard is shipped |

Net result: of the ~15 SaaS dependencies, 9 are cut, 6 are re-targeted at AWS equivalents, and **the functional surface of the product expands** (accountability becomes first-class, budgets become MVP).

## 3. The six things that actually need to exist

1. **Ingestion.** Fetch Riksdagen, Statskontoret, and Manifesto Project data on a schedule; store raw payloads immutably; normalise into Parquet.
2. **Canonical store + query.** One schema, stored as Parquet on S3, queried with DuckDB (in Lambda); small mutable state in DynamoDB (ingest cursors, summary cache, accountability cache).
3. **Read-only HTTP API.** JSON endpoints the dashboard calls. Cached aggressively at CloudFront.
4. **Static dashboard.** A statically-exported Next.js (App Router) site on S3 + CloudFront, hydrating into interactive views. Same UI code as the existing implementation, minus the Vercel-specific bits.
5. **Thin LLM layer.** Three endpoints — summary, hybrid search, accountability synthesis — all backed by Bedrock (Haiku + Titan Embed v2), all cited, accountability-class calls async via SQS.
6. **Observability & cost control.** CloudWatch logs and alarms, AWS Budgets alarm at 20/30/50 USD, WAF rate limit.

## 4. Why not a hosted-Postgres rewrite on AWS?

When "Supabase storage is the bottleneck", the obvious move is RDS PostgreSQL or Aurora Serverless v2 with `pgvector`. We considered it and rejected it:

- **RDS PostgreSQL** (smallest `db.t4g.micro`, 20 GB): ~$13–15/mo just for the instance, plus storage. Out of coffee-budget.
- **Aurora Serverless v2 with auto-pause-to-0** (supported since late 2024): idle cost is effectively $0 but resume is 10–30 s. Every "click" after a pause is a bad experience. Warm-state minimum (0.5 ACU) is ~$43/mo — well out of budget.
- **Supabase self-hosted on Fargate/EC2:** same ops surface as RDS with more moving parts (PostgREST, GoTrue, Kong, Realtime); unjustified.

The cleanest answer is that **our data shape doesn't need a relational database at all** for the hot path. The hot queries are analytical (filter + aggregate across dates/parties/committees) and they are served at least as well by Parquet + DuckDB, for a fraction of the cost. The small amount of truly mutable state (cursors, caches, job records) fits in DynamoDB on-demand at pennies/mo. See `02-architecture.md`, section 3.2, for the full trade-off.

## 5. The accountability endpoint, specifically

The existing implementation's `/api/v1/accountability` is the only endpoint that directly answers the end-goal sentence. It takes a `(party, topic)` pair and returns a neutral, cited, Swedish-language report derived from four underlying data layers:

1. What did the party **promise** in its manifesto about this topic? (Manifesto Project statements)
2. What **motions** has the party submitted on this topic? (Riksdagen documents, authored by party members)
3. How has the party **voted** on motions/propositions touching this topic? (Riksdagen voteringar)
4. What has the government **spent** on related expenditure areas while the party was in government? (Statskontoret budget utfall)

This is the single richest piece of civic-tech output in the repo and was produced by prompt engineering on ~150 words of output, with a 7-day cache keyed on `(party, topic_hash)`.

`01-critical-review.md` of the earlier plan draft cut this feature. **That was a mistake.** Without it, the dashboard regresses to "a better riksdagen.se search"; with it, the dashboard is the only place where the four data layers are pre-joined and narratively summarised.

Two disciplines make this safe to ship:

1. **Async execution.** Synchronous LLM calls in a request path invite 30 s API Gateway timeouts on cache misses. We use `POST /v1/accountability` returning `202 Accepted + { "job_id": "…" }`; an SQS-triggered Lambda runs the synthesis; the dashboard polls `GET /v1/accountability/jobs/{id}`. Cache hits still return `200` synchronously.
2. **Structural constraints.** The prompt receives only the four pre-fetched, typed data bundles; it does not receive the free-text query. Its output is bounded at ~150 words and must cite the source `dok_id`s and `manifesto_id`s it uses. The frontend renders the prompt text itself at `/metodik/ansvarsutkravande` so readers can audit how their answer was produced.

## 6. The API-first framing, specifically

The existing implementation was literally organised around a developer-facing API product: keys, tiers, rate limits, Swagger docs. None of that earns transparency for the *citizen* in the MVP — and the citizen is MVP user #1. Cutting it in the port removes three pieces of custom infrastructure that each cost engineering time to maintain:

1. **A bespoke identity layer** (issuing, storing, hashing, rotating API keys in a Postgres table).
2. **A per-key rate-limiting layer on a third-party Redis** (Upstash, in the existing implementation).
3. **A hand-maintained Swagger surface at `/docs`** distinct from the actual route definitions.

For a dashboard that talks to its own cached backend behind a CloudFront + WAF rate rule, all three are overhead today. The single internal consumer (the Löfteskollen demo) uses a service account — that's an IAM role, not an API-key product.

### 6.1 What we *do* want to preserve

The reason the existing repo was organised around an API is that a clean, stable, public, documented API has real commercial value for Swedish newsrooms, polling firms, political consultancies, and academic researchers — groups that today pay humans to hand-scrape riksdagen.se or maintain private CSV pipelines. A small paid tier on top of Agora's API is plausibly the only route to self-sustaining funding for a civic-tech project at this scale.

The post-Supabase port therefore **removes the custom implementation but preserves every architectural property that a commercial tier would later need**:

- **Stable, versioned URLs.** All routes are `/v1/...`; breaking changes go to `/v2`. Already the case.
- **Consistent JSON shape.** One error envelope, one pagination cursor scheme, one `meta` block on every list response. Specified in `06-storage-and-api.md` §2.
- **OpenAPI 3.1 spec published from the code.** Auto-generated from the route decorators, served at `/v1/openapi.json`, cached at CloudFront. No hand-maintained Swagger page.
- **API Gateway HTTP API as the trust boundary.** Usage plans, API keys, and per-key throttling are native features of API Gateway; a later paid-tier rollout is a **CDK configuration change** that adds a `UsagePlan` + `ApiKey` + a `COGNITO_USER_POOLS` or Lambda authorizer — not a rewrite.
- **Strong cache headers + ETag on every read.** A paying customer with a background sync job pays zero marginal compute cost when the data has not changed.
- **Bulk data published separately.** The requester-pays Parquet mirror (on `s3://agora-parquet-pub/`) remains the correct channel for people who want the firehose; the paid API tier is for people who want *curated*, *low-latency*, *SLA-backed* access.

**Decision: Agora is dashboard-first, but API-as-product-ready.** The MVP ships one anonymous, rate-limited public tier (free forever). A paid tier is a well-scoped post-launch project (`11-roadmap.md` Phase 9), not an MVP distraction. The `api_keys` table, the `/api/v1/keys/request` endpoint, the Upstash rate counter, and the hand-written Swagger page are removed during the port; the API shape and CDK stack are kept "paid-tier-ready".

## 7. What could still kill the project

Named here so nobody can claim to be surprised:

- **Riksdagen changes their API.** The ingestion Lambdas are the only component that talks to Riksdagen; the schema-mapping lives in one file per source. This is as contained as we can make it.
- **An LLM feature hallucinates something politically charged and the press runs it.** Mitigation: cite-or-don't-show; publish the prompt and model id alongside every generated summary or synthesis; a "rapportera" mailto link on each generated block.
- **A single news story spikes traffic 100×.** CloudFront + static S3 handle this for cents, but the Bedrock-backed endpoints do not. Mitigation: WAF rate limit on `/v1/summarise` and `/v1/search`; cached-first behaviour on `/v1/accountability`; a feature flag to return the primary-source URL instead of running Bedrock when the monthly token ceiling is crossed.
- **Costs creep.** AWS Budgets alarm at 20/30/50 USD; a monthly "cost review" item on the roadmap.
- **Scope creep back to the old plan.** Mitigation: this document. When someone proposes rebuilding a custom `api_keys` table, a design-system phase, or a hosted Postgres, the PR must update the table in section 2 with a justification. (Enabling API Gateway's native Usage Plan + API Key feature for a commercial tier does *not* count as scope creep — that is the Phase-9 path explicitly preserved in §6.1.)
- **Supabase specifically creeps back in.** Forbidden. The whole point of this plan is that the storage-plus-embeddings working set will always eventually exceed the Supabase free tier for this project, and paying for Supabase Pro ($25/mo) is above coffee-budget for a dashboard that serves ~zero users most of the year.
