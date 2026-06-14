# 12 — Implementation review

> **Status update (current iteration).** The owner has explicitly chosen to move the project **off Supabase entirely**: "the data-storage + vectorisation greatly exceeds the free tier limitation on db storage. We must move away from Supabase." The plan in `00-`–`11-` now reflects that decision throughout. In the language of Part C below, this is **option B3: fully post-Supabase AWS architecture**. The critiques in Parts A, B, and D are preserved here as the historical record that produced that decision — they are not the current plan.
>
> Where Part A said the plan was "missing things the implementation already has", those things (accountability synthesis, hybrid search, `document_texts`/`document_authors`/`speeches`/`manifestos`/`manifesto_statements`/`budget_outcomes`/`ingestion_runs`, the 7-day accountability TTL) are now **first-class in the new plan**. Read Parts A and B as the gap-analysis that drove the rewrite, not as outstanding action items.
>
> Where Part D flagged unresolved decisions, they are resolved as follows:
> - **#1 Supabase-stays vs. full migration?** → Full migration. Supabase is out; hosted Postgres is out entirely. See `01-critical-review.md` §4 and `02-architecture.md` §3.2.
> - **#2 Accountability endpoint** → In. First-class Phase 6 feature. See `08-llm-layer.md` §4.
> - **#3 Storage substrate** → S3 + Parquet + DuckDB-in-Lambda for analytical data; DynamoDB on-demand for mutable state. See `04-data-model.md` and `06-storage-and-api.md`.
> - **#4 Embeddings** → Bedrock Titan Embed v2 at 1024 dims (Voyage out). See `08-llm-layer.md` §2.1.
> - **#5 API-key product** → **Deferred, not dropped.** The custom implementation (SHA-256-in-Postgres, Upstash counters, hand-maintained `/docs` Swagger) is out of MVP. The API boundary is deliberately designed so a later commercial tier can be enabled as a CDK flag flip (`apiTiers=on`) plus a Lambda authorizer — zero rewrite of handlers, Parquet, or DuckDB layers. Bulk consumers use a requester-pays Parquet mirror; live-JSON consumers (newsrooms, polling firms, research teams) are a Phase-9 product. See `01-critical-review.md` §6, `02-architecture.md` §3.4.1, `06-storage-and-api.md` §7, `11-roadmap.md` Phase 9.
> - **#6 Rate limiting** → AWS WAF rate-based rule in front of CloudFront; per-IP DynamoDB TTL counter in-Lambda for the LLM endpoints. CloudFront-Function + DynamoDB counter available as a `-c waf=off` escape hatch. See `06-storage-and-api.md` §2.6 and `09-observability-and-security.md` §4.
> - **#7 Analytics + error tracking** → Out. CloudWatch + CloudFront access logs + Athena replace PostHog and Sentry. See `00-foundation.md` §6 and `09-observability-and-security.md`.
>
> The rest of this document is the frank two-directional critique that produced those resolutions. Read it as primary-source context; read `00-`–`11-` for the current plan.

---

This document is a frank, two-directional critique:

- **Part A:** critical feedback on the **new plan** (documents `00-`–`11-`), with the **existing implementation** (in `./agora/`) as the reality check.
- **Part B:** critical feedback on the **existing implementation**, with the **new plan** as the reality check.
- **Part C:** a concrete, opinionated migration path that takes the best of both.
- **Part D:** unresolved decisions that need a human in the loop.

The existing implementation turns out to be a mature Turborepo monorepo (Next.js 16 app router + Supabase Postgres with pgvector + scheduled ingestion for Riksdagen, ESV, and the Manifesto Project + Voyage AI embeddings + Anthropic synthesis + Upstash rate-limiting + PostHog/Sentry + a working *Löfteskollen* demo). It is far from a prototype. Several features I cut in `01-critical-review.md` are already shipping.

---

## Part A — Critical feedback on the new plan

### A1. The data model in the plan is missing things the implementation already uses

What the implementation has that `04-data-model.md` does not:

| Implementation table | Why it matters | New-plan status |
|---|---|---|
| `document_texts (document_id, body_html, body_text, word_count, language)` | Document bodies are *expensive to re-fetch* (1 second each, flaky HTML parsing). Storing them once is cheaper than fetching on demand, which is what the plan implies. | Missing. Plan says "fetch text on demand at summary time and discard". **The plan is wrong** about this being cheap. |
| `document_authors (document_id, member_id)` many-to-many | Motions routinely have 2–10 co-signatories. Modelling a motion as having a single `proposer` loses most of the political signal. | Missing. My `documents` table implies singular authorship. **Bug in the plan.** |
| `speeches (member_id, document_id, rm, anforande_nummer, body_text, word_count)` | Speaking time per MP per period is a civic-transparency metric citizens actually understand ("who talks the most?"). | Plan lists *anföranden* as "aggregates only" and fetches on demand. The implementation proves full storage is affordable. |
| `vote_results` (individual rows) separate from `votes` (aggregate row) | Denormalising per-MP votes under a per-vote-point aggregate row matches how the Riksdagen API actually returns data and makes aggregate queries much cheaper. | Plan conflates them into a single `votes` table. **Implementation's split is better.** |
| `budget_outcomes (year, month, expenditure_area_code, anslag_code, amount_sek, budget_type)` | Real budget data, pulled from Statskontoret (successor of ESV) as a multi-year CSV covering **1997–present**. | Plan parks budget to post-MVP saying "needs PDF parsing". **This is wrong** — structured CSV already exists, and the implementation has been consuming it. |
| `manifestos` + `manifesto_statements` with a `(party, election_year)` key | The Manifesto Project at WZB exposes a public API with structured, sentence-level annotations of party manifestos going back to 2010 for Sweden. | Plan marks manifestos "parked — no machine-readable canonical source". **Wrong** — `manifesto-project.wzb.eu` is the canonical source and the implementation is already hitting it. |
| `ingestion_runs` audit table | Per-run record of source, status, counts, errors as JSONB. Cheap, invaluable for debugging "why is today's data missing?". | Missing. My plan relies on CloudWatch logs alone; a small audit table is complementary, not redundant. |
| `accountability_cache (party, topic_hash, topic_raw, summary, generated_at)` | 7-day TTL cache for AI-generated syntheses. | Plan caches summaries for 180 days. The implementation's 7-day TTL is probably more correct — party positions *do* change and stale summaries mislead. |

**Action:** rewrite `04-data-model.md` to include `document_texts`, `document_authors`, `speeches`, `manifestos`, `manifesto_statements`, `budget_outcomes`, and `ingestion_runs`; split `votes` / `vote_results`; cut the 180-day summary TTL to 7 days.

### A2. The plan's "cut the accountability feature" call is probably wrong

`01-critical-review.md` says the LLM layer should be narrow: summaries + semantic search only. The implementation has a fourth thing the plan dismissed — `GET /api/v1/accountability` — that synthesises four data layers (manifesto promises × motions × votes × budget) per (party, topic) into a short Swedish-language report.

Read against the end-goal sentence in `00-foundation.md`:

> *"open one page on my phone, pick a topic, and in under a minute understand what the Riksdag has actually done about it."*

**The accountability endpoint is that page.** Structured-data-plus-charts alone does not answer "what did the government actually do about climate this mandate period?" in under a minute — the citizen has to synthesise across four tables themselves. A cached, cited, LLM-generated 150-word synthesis is *exactly* the thing that reduces friction below the one-minute threshold.

My worry in `01-critical-review.md` — hallucination risk on politically charged topics — is real, but the implementation mitigates it with (a) a fixed prompt template, (b) four pre-fetched data rows as sole context, (c) a 7-day cache, (d) explicit citations, and (e) a rate-limited paid-tier gate. That is more discipline than my plan's summary endpoint has.

**Action:** promote accountability from "out of scope" to **a named Phase 5 feature** (alongside summaries + NL search). Carry over the 4-layer synthesis prompt and cache TTL. Acknowledge this is the product differentiator vs. riksdagen.se.

### A3. Hybrid search is a better design than pure vector search

The implementation's `search_documents(query_text, query_embedding, ...)` RPC blends BM25 (tsvector, `swedish` dictionary) with cosine similarity at a 40/60 weighting. My plan proposes pure vector search with SQL `ILIKE` as a fallback. Hybrid is strictly better because:

- For exact-string queries ("barnomsorgspeng"), BM25 wins.
- For fuzzy semantic queries ("förskoleersättning till familjer"), embeddings win.
- The user does not know which kind of query they're typing; the ranker should not care either.

**Action:** rewrite `08-llm-layer.md` section 5 to describe hybrid search with explicit weighting, and note that the `query_text` side can be implemented as DuckDB FTS (extension available and proven) so the whole ranker stays inside one Lambda.

### A4. The plan's ingestion cadence is over-engineered

My plan: three times daily incremental + weekly full refresh. The implementation: nightly at 03:00 UTC, single job. For civic data with 24-hour inherent delay between parliamentary action and publication, **daily is enough**. Three-times-daily mostly multiplies log volume and cron-edge failure modes.

**Action:** drop the `agora-ingest-incremental` 6-hour cadence to daily; keep the Sunday full refresh.

### A5. The plan's document-type list is incomplete

My `03-data-sources.md` lists `mot`, `prop`, `bet`, `skr`, `prot` as the document types. The implementation adds `ip` (interpellation) and `fr` (framställning). The plan also conflates `skr` (*skrivelse*) with written questions. Verify:

- `ip` = interpellation (a formal oral question)
- `fr` = framställning (often *framställning till riksdagen* — non-government bills from Riksdagens styrelse, RKU, RRV)
- Written questions (*skriftliga frågor*) are actually their own document type not to be confused with the above

**Action:** correct the doctypes list in `03-data-sources.md`; add `ip` and `fr` rows to the `documents` table partitioning scheme in `04-data-model.md`.

### A6. The plan dismisses i18n too fast

I cut i18n as YAGNI. The implementation already has `next-intl` wired with `sv` and `en` locales and a `messages/` directory. Cost of keeping: small (the routing is done; English message bundles are minimal). Benefit: grant applications, international researchers, and academic citation are meaningfully easier when the site is also navigable in English.

**Action:** soften the stance in `00-foundation.md` and `07-dashboard.md`. Ship Swedish-only; keep the `[locale]` routing primitive so an English mode can be added without a migration.

### A7. The plan under-specifies tests

Neither the plan nor the implementation has a test suite (the implementation has *zero* tests — noted in Part B). But the plan should have been more explicit about this because:

- RLS policies are easy to get wrong and hard to catch in review.
- Ingestion dedup logic is the kind of thing that breaks silently.
- Schema-drift detection against Riksdagen is a contract test waiting to be written.

**Action:** add a "Phase 1b — basic test harness" (Vitest + Playwright + a Docker-Compose-booted local Supabase/Postgres) to `11-roadmap.md`.

### A8. The plan's storage-bottleneck estimate is close but not tested

My estimate: ~2 GB of Parquet total. Reality check from the implementation: `document_texts` alone is multiple hundred MB at full corpus depth (motions are short, but propositions are 100+ pages). Vote rows ~5M × 100 bytes ≈ 500 MB uncompressed. Embeddings ~50k × 512 dims × 4 bytes ≈ 100 MB. So the real answer is 1.5–3 GB *before* Parquet compression (probably 300–800 MB after). Within the cost table's rounding. Fine — but the plan should show the decomposition.

**Action:** replace the "~2 GB" with a decomposed table in `02-architecture.md` section 4.

### A9. The plan's `AWS Budgets` ceiling at 5/10/15 USD is too tight once Bedrock is in use

If we enable the accountability endpoint (A2), steady-state Bedrock cost can plausibly climb to $10–20/mo by itself on a busy week. The 15-USD budget will fire false alarms. The right ceiling is probably 20/30/50 USD with a 25-USD *forecast* alarm on the 20-USD actual budget.

**Action:** widen the budget alarms in `09-observability-and-security.md` section 2.1 and update the cost table in `02-architecture.md`.

---

## Part B — Critical feedback on the implementation

### B1. Every third-party dependency is a free-tier tripwire

The implementation depends on six SaaS providers, each with a generous-but-finite free tier:

| SaaS | Used for | Free-tier ceiling | Cost to replace on AWS |
|---|---|---|---|
| Supabase | Postgres + RLS | 500 MB DB, 2 GB bandwidth, 50k MAU | Aurora Serverless v2 (w/ scale-to-zero) or **S3+Parquet+DuckDB** |
| Voyage AI | 512-dim embeddings | 3 RPM free (!), then pay-as-you-go | Bedrock Titan Embed v2 ($0.02/1M tokens, no RPM cap in practice) |
| Anthropic direct | Claude for synthesis | variable, rate-limited | Bedrock Claude Haiku (same model, same cost, AWS-billed) |
| Upstash Redis | Per-key rate limits | 100 commands/day on free tier — nowhere near prod | DynamoDB TTL counter (~$0) **or** API Gateway usage plans |
| PostHog | Analytics | 1M events / mo | Drop entirely (the plan's position) |
| Sentry | Error reporting | 5k errors / mo | CloudWatch + SNS |

Your stated reason for the rewrite was "we hit free-tier limits." The implementation has *six simultaneous ways to hit a free-tier limit*, three of which (Voyage 3 RPM, Upstash 100 cmd/day, Supabase 500 MB) will bite in Phase 1 of traffic growth.

**The Voyage AI 3 RPM free tier is the most brittle component in the entire system.** Every accountability request embeds a fresh topic query. 3 RPM = 4320/day = one careless cron or one Twitter mention away from 429 errors. Moving to Bedrock removes this class of failure entirely.

### B2. Synchronous LLM calls in the request path

`GET /api/v1/accountability` calls `anthropic.messages.create` inside the request handler with a 30-second API Gateway timeout. On a cache miss, the citizen waits 5–20 seconds while the Lambda (or Vercel function) holds open the connection. Real risks:

- CloudFront/API Gateway 30s timeouts → user sees a generic 504.
- A retry storm during a viral moment doubles the load.
- Front-end can't show partial progress.

The correct shape is:

```
client → /accountability?party=S&topic=klimat
server → if cache hit, return 200 + JSON
         else, enqueue SQS job + return 202 Accepted + { "poll": "/accountability/jobs/abc" }
worker Lambda (SQS-triggered) → compute, write to cache, write to jobs table
client polls /accountability/jobs/abc → 200 when done
```

Both the implementation **and** the new plan assume synchronous LLM. Both are wrong on this point.

### B3. Zero tests

No `*.test.ts`, no Vitest, no Playwright. On a read-only transparency tool this is less catastrophic than on a stateful product, but it means:

- RLS policies are not verified after each migration.
- Ingestion dedup logic is not regression-tested.
- The OpenAPI spec is not verified against the actual routes.
- The accountability synthesis has no golden-output tests for known (party, topic) combinations.

Claim "all public data, RLS `SELECT = true`" makes this mostly low-blast-radius, but that claim should have a test.

### B4. Document-text ingestion is an O(N) serial loop with a 1.1-second sleep

`scripts/ingest/document-texts.ts` processes documents sequentially with a hardcoded 1.1 s inter-request sleep. For 1,000 backfilled docs that's ~18 minutes; for 50,000, it's 15 hours. GitHub Actions workflow has a 60-min timeout — this already silently caps how much backfill you can do per run, meaning a full re-ingest likely requires many re-runs with state tracking.

On AWS this becomes a Step Function with parallel fan-out (e.g., 10 concurrent workers at 1 RPS each = 10 RPS total, still polite). Single-core Node loops do not translate well to serverless.

### B5. Storage layout bakes in Supabase assumptions

`packages/db/src/index.ts` is one line: `export type { Database } from './database.types'`. That file is generated by `supabase gen types`. The rest of the codebase imports `Database` and consumes the Supabase JS client (`supabase.from(...)`). This is **Supabase-flavoured Postgres**, not portable Postgres:

- RLS policies rely on Supabase's `auth.uid()` / `auth.role()` runtime functions.
- The `search_documents` RPC assumes Supabase's PostgREST-exposed RPC path.
- The API-key-hashing `api_keys` table is queried via the Supabase client and leans on its row-level security checks.

Moving to raw RDS or Aurora retains the SQL and pgvector, but drops PostgREST — every `supabase.from(...)` call must be rewritten to raw SQL (or an ORM). This is weeks of work, not hours.

**The cheapest migration path is probably not "RDS/Aurora + rewrite".** It is one of:

1. **Stay on Supabase**, but move *away from the expensive satellites* (Voyage → self-hosted embeddings on AWS Lambda; Upstash → DynamoDB; Vercel → S3+CloudFront; Anthropic direct → Bedrock). Keep Supabase for the Postgres + RLS + PostgREST it does well. **Biggest bang for buck.**
2. **Supabase → Supabase self-hosted on ECS Fargate / EC2.** Open-source Supabase is deployable; costs ~$15–30/mo at smallest shape. Removes the 500 MB ceiling but adds an ops surface.
3. **Full rewrite to the `02-architecture.md` shape** (S3+Parquet+DuckDB+Lambda). Cheapest at rest, but throws away every line of API code. Only justified if Supabase *itself* is the problem, which it probably isn't.

### B6. Next.js API routes + Vercel is the most expensive bit

Serverless on Vercel's Pro tier is $20/user/month base + usage. The current implementation has no Vercel deploy wiring visible, so presumably it's on the free Hobby tier — which **prohibits commercial use**, and a civic-tech project that accepts donations or grant funding may or may not qualify. Either way:

- Vercel Hobby: free, but bandwidth + function execution capped in ways that'll bite before 1k DAU.
- Vercel Pro: $20/mo minimum per seat, plus per-invocation and bandwidth.
- Vercel Enterprise: out of scope.

The API routes themselves are ordinary Next.js App Router `route.ts` handlers. They can be moved to:

- **Lambda behind API Gateway** (the plan's approach).
- **Next.js static export** for the pages + **Lambda for `/api/v1/*`**.

Both are cheaper than Vercel-function-based hosting.

### B7. API-key infrastructure is a cost and a non-goal

The implementation has a full API-key stack (`api_keys` table, SHA-256 hashing, tiered rate limits `anon/free/paid`, `/api/v1/keys/request` endpoint). Against the end-goal (*"transparency for the ordinary citizen"*) this is pure overhead — it doesn't make the dashboard better; it makes the developer-API story better. But there is no developer-API user identified.

The only internal consumer is the Löfteskollen demo, which carries an `AGORA_INTERNAL_API_KEY`. That is a single service account. It does not need a tier system or Upstash Redis. It needs one IAM role.

**Recommendation (and it's a real decision for the human to make):**

- **Option 1 (cleanest):** delete the API-keys table, delete `api_keys.ts`, delete Upstash, delete `/api/v1/keys/request`. Dashboard talks to a public read-only API behind CloudFront caching + WAF rate rule. ~2 days of refactor.
- **Option 2 (preserve optionality):** keep the `api_keys` table but stop requiring keys on public endpoints. Keys become purely for *elevated* actions (admin, rebuild). The dashboard stops sending `Authorization` headers. Rate-limiting moves to WAF.

Either beats paying for Upstash to throttle unidentified citizens.

### B8. Authorship data is underused

The implementation has a `document_authors` many-to-many table but the dashboard (from what the Explore pass saw) mostly exposes single-author framing via the Löfteskollen demo. Co-signature patterns between MPs are one of the richest transparency signals — they reveal which MPs actually work together, regardless of party. Both the plan and the implementation should surface this.

### B9. Manifesto coverage stops at 2022

`manifesto.ts` has a hardcoded list of 8 parties × 4 elections (2022, 2018, 2014, 2010). This is fine — Swedish elections are every 4 years — but it means the next election automatically produces a gap until someone edits `manifesto.ts`. A small improvement: read the election list from the Manifesto Project API itself (it supports `?country=Sweden`) so new elections appear without a code change.

### B10. The `search_documents` FTS uses `swedish` dictionary but embeddings are Voyage's multilingual

Mixing a monolingual stemmer (tsvector with `swedish`) with multilingual embeddings is not wrong but isn't optimal. Voyage's `voyage-4` weighs English slightly higher than Swedish in its training data. Bedrock's Titan Embed v2 is explicitly multilingual and strong in Nordic languages. Migration is a net improvement for search quality, not just cost.

---

## Part C — Pragmatic migration path

Given Part A (the plan was wrong about some things) and Part B (the implementation has some non-portable assumptions), the most honest recommendation is **not** to pick the plan or the implementation but to take a third path:

### C1. What to keep from the implementation

- **Postgres + pgvector + `search_documents` RPC.** Proven, Swedish-language-correct, hybrid search. Do not throw this away.
- **All 12 migrations.** The schema is a good schema.
- **The three ingestion scripts (`riksdagen.ts`, `esv.ts`, `manifesto.ts`).** They work, they cover real sources, they have retry logic. Port them, don't rewrite them.
- **The Next.js UI + shadcn components + next-intl.** Already built; export statically.
- **The accountability synthesis prompt template.** This is the product.
- **The `ingestion_runs` audit table pattern.**

### C2. What to replace, in priority order

1. **Voyage → Bedrock Titan Embed v2.** Re-embed once (~$5 one-time). Removes the 3 RPM free-tier tripwire. Best cost/effort ratio of any single change.
2. **Anthropic direct → Bedrock Claude.** Change the SDK import, route through IAM. No prompt changes, no data migration.
3. **Upstash → DynamoDB TTL counter.** Standard sliding-window in a single-digit-line Lambda. Drops Redis bill to zero.
4. **Vercel → S3+CloudFront for the app, API Gateway+Lambda for `/api/v1/*`.** Static export the Next.js routes; keep the App Router layout; move route.ts handlers to Lambda functions preserving the same handler signatures. Consider `@sls-next/lambda-at-edge` or just a hand-rolled adapter.
5. **Delete API keys on public endpoints.** Move rate-limiting to WAF. Keep the keys table only if Löfteskollen stays.
6. **Delete PostHog.** Keep Sentry → CloudWatch alarms (or swap Sentry's AWS DataDog/CloudWatch integration).
7. **Delete DeepL** unless you decide English matters (see A6).

### C3. What to defer or skip

- **Full rewrite to S3+Parquet+DuckDB.** Tempting, but it trashes the Postgres schema and the `search_documents` RPC. Only do it if Supabase itself (not its satellites) becomes a problem. Revisit at 10× traffic.
- **The static-only dashboard.** The Next.js app has dynamic pieces (the Löfteskollen demo) that don't fit a pure static export cleanly. Static-export everything that trivially can be; leave the accountability demo on Lambda.
- **The "API-first" product framing.** Gone. `/api/v1/*` is now *dashboard's API*, with the raw Parquet files on a requester-pays bucket as the "developer API" for anyone who actually wants bulk data.

### C4. Net expected bill

Under this migration (Supabase stays; Vercel + Voyage + Upstash + Anthropic-direct + PostHog + DeepL all gone):

- Supabase Free or Pro ($25/mo): whichever storage tier is needed.
- AWS: ~$3–8/mo (S3 + CloudFront + Lambda + API Gateway + Bedrock usage + DynamoDB).
- **Total: either ~$5/mo (if we stay on Supabase Free and stay under 500 MB — plausible by storing raw document HTML on S3, not in Postgres) or ~$30/mo (Supabase Pro).**

The Supabase Free path is the nearest thing to the original "coffee-budget" target **and** preserves the working implementation.

---

## Part D — Unresolved decisions

These require Isak's judgement; they are not technical calls the plan should make unilaterally.

1. **API-key existence.** Keep the `api_keys` stack (because someone may already be integrated against it or because the Löfteskollen demo relies on it) or remove it entirely (because it contradicts the transparency-first framing)?
2. **Accountability as first-class.** Is the AI synthesis endpoint a feature we promote and rate-limit fairly, or something we hide behind a `paid` tier to control cost? The implementation currently gates synthesis behind the paid tier; the transparency mission arguably wants it free.
3. **Supabase or not.** Is the rewrite's motivation *"the Supabase free tier is not enough"* (→ migrate everything off Supabase) or *"our total SaaS surface is too brittle and expensive"* (→ shrink the satellites, keep Supabase)? Very different answers.
4. **English.** Ship Swedish-only (current plan), ship Swedish + English (current implementation)?
5. **Löfteskollen demo.** Part of the product (per the implementation) or cut to simplify (per the plan's current framing)?
6. **RLS vs. IAM.** The implementation relies on Postgres RLS as its security boundary. On AWS-native, the equivalent is IAM + explicit Lambda SQL. Which do we trust more going forward?

Each of these is a product decision dressed up as a technical one. The plan will have to get updated after you answer them.
