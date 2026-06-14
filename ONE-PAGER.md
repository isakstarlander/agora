# Agora — one-pager

*An AWS-native, Swedish-language civic transparency dashboard for the Riksdag.*

## The problem

Foundation models know Sweden's political record up to training cutoff; general search indexes riksdagen.se but surfaces it for researchers, not citizens. The average Swede cannot cheaply answer "How did my MP vote on the last climate bill?", "What did party X promise that has — or has not — become a motion?", or "Where did the 2026 education budget actually go vs. 2023?". Agora makes those answers fast, cited, and trustworthy — on a phone, in under a minute.

## The product

A read-only public dashboard joining three primary sources — **Riksdagen open data** (members, motions, propositions, interpellations, votes), **Statskontoret / ESV** (budget outcomes), and the **Manifesto Project at WZB** (party manifestos) — into a period-scoped, comparative view with one-click citations back to source. A thin LLM layer on Amazon Bedrock (Titan Embed v2 + Claude Haiku) powers neutral document summaries, hybrid FTS + vector search, and the differentiator — **accountability synthesis**: an async 4-layer join of *manifesto × motions × votes × budget* per (party, topic), cached and cited. Swedish-first; English routing primitive preserved.

## Stack, briefly

All AWS, all CDK (TypeScript), deployed with one `cdk deploy --all` into `eu-north-1`. S3 + Parquet + DuckDB-in-Lambda for analytics (FTS and vector extensions in one process). API Gateway HTTP API in front of read-only Lambdas. Next.js static export on S3 + CloudFront. SQS-triggered worker Lambda for accountability jobs. DynamoDB for small mutable state. CloudWatch + SNS + AWS Budgets (20/30/50 USD) for ops. Zero hosted Postgres, zero Vercel, zero third-party SaaS on the hot path. **Cost profile:** ≈ $0.50/mo idle, ≈ $8.50/mo at modest traffic, inside a $50/mo ceiling at 10× traffic.

## Status and plan

Plans complete; AWS build not started. An earlier `/api-first` implementation exists (Next.js UI, ingestion scripts, accountability prompt) — much of it will be **ported**, not rewritten. Execution is broken into 18 self-contained product requests (`product-requests/PR-00` … `PR-17`), organised into nine phases:

| Phase 0–3 | Phase 4 | Phase 5–6 | Phase 7 | Phase 8–9 |
|---|---|---|---|---|
| AWS bootstrap → ingestion → API → **MVP dashboard** | Observability | LLM read + accountability | Polish, RSS, CSV | Parked expansions + **optional commercial API tier** |

Estimated effort for the solo-maintainer path to MVP: ~10–14 working days (PRs 00–11), plus another week for LLM features.

## Top 3 risks

1. **Reputational / LLM hallucination.** A Bedrock call produces something politically charged and a reporter runs with it. Mitigated by *cite-or-don't-show*, published prompt + model ID on every generated block, and async jobs with visible staleness — but one incident on a sensitive topic is the kind of failure that defines a civic tool in the public mind.
2. **Operational fragility: solo maintainer, zero tests.** Neither the existing implementation nor this plan ships with a test harness (ingestion dedup, OpenAPI contract, accountability golden outputs). The async SQS + worker Lambda + DynamoDB flow adds new failure modes on top. Solo maintainer + zero regression coverage is the most likely way this project quietly decays.
3. **Scope creep back to the old plan.** The whole premise is *no managed-SaaS free tier on the hot path*. Any PR that reintroduces hosted Postgres, pgvector, Upstash, or a bespoke `api_keys` table undoes the bet. `01-critical-review.md` is the designated arbiter — but only if contributors actually read it.

## Top 3 opportunities

1. **Accountability synthesis is a genuine differentiator.** No one else — not riksdagen.se, not general search, not existing civic-tech — gives a citizen a cited, neutral, one-minute answer to *"what did this party promise, propose, vote on, and spend on this topic?"* The 4-layer join is the moat.
2. **A sustainable commercial path that doesn't compromise the mission.** Phase 9 flips a CDK flag to enable a paid API tier (Stripe + API Gateway usage plans + Lambda authorizer) for newsrooms, polling firms, and researchers — on the same endpoints the public uses, free tier permanently intact. Revenue without a paywall on transparency.
3. **Reusable reference architecture.** The stack is boring on purpose (S3 + Lambda + DuckDB + Bedrock). If MVP lands, the same pattern forks naturally to other Nordic / EU parliaments or civic datasets — Agora becomes a template as much as a site.

---

*Read next: `README.md` → `00-foundation.md` → `11-roadmap.md` → `product-requests/README.md`.*
