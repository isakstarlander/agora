# 00 — Foundation

This document sets the frame for the entire project. It is the one document you should read even if you read nothing else.

## 1. Vision

Agora is a read-only, public, Swedish-language web dashboard whose single purpose is to make the actions of the Riksdag (the Swedish parliament) **legible to the ordinary citizen**.

"Legible" here means four concrete things:

1. **Factual.** Every number and every claim on the dashboard is traceable, in one click, to an authoritative primary source — a vote record, a motion, a government proposition, a budget line, a manifesto statement.
2. **Temporal.** Users can scope any view to a defined period (a mandate period, a calendar year, a specific session) and see *change*, not just current state.
3. **Comparative.** Citizens can compare parties, committees, individual MPs, budget lines, and manifesto promises against each other and against past behaviour.
4. **Synthesised.** For a chosen (party, topic) combination, the site returns a short, cited, neutral summary of what the party has *promised*, *proposed*, *voted on*, and *spent on* inside the selected period — in under a minute.

Agora is explicitly *not*:

- An investigative-journalism tool (no leaks, no unverified material).
- A social network (no comments, no sharing buttons beyond URL copy).
- An advocacy platform (no editorial framing; visualisations are chosen for clarity, not persuasion).
- A superset of riksdagen.se (we do not mirror; we re-present).

## 2. The end-goal, stated as a user

> "As a Swedish citizen with no particular training, I want to open one page on my phone during the morning commute, pick a time period and a topic, and in under a minute understand what the Riksdag has actually *done* about it — and I want every claim on that page to link straight to the underlying document so I can verify it myself."

Every architectural decision in this plan is tested against that sentence. When a proposed component does not measurably help that user, it is cut.

## 3. Scope

In scope (MVP):

- Ingesting, normalising, and storing **open data from Riksdagen** (data.riksdagen.se), **budget data from Statskontoret / ESV**, and **party manifestos from the Manifesto Project at WZB**.
- Seven entity types: *members* (ledamöter), *votes* (voteringar), *motions* (motioner), *propositions* (propositioner), *interpellationer*, *budget outcomes* (utfall), and *manifesto statements*.
- Period-scoped browsing and filtering: by party, committee, ministry, date range, topic keyword.
- A handful of carefully-chosen visualisations: attendance, voting cohesion within parties, voting divergence between parties, motion throughput, budget spend by expenditure area.
- A read-only public HTTP API that the frontend consumes. The same endpoints are documented openly (OpenAPI 3.1 at `/v1/openapi.json`) so that journalists, researchers, and other civic-tech projects can reuse them. The API is deliberately designed as a *product surface* — stable, versioned, paginated, and metered at the API Gateway layer — so that a later, optional paid tier for commercial consumers (newsrooms, think tanks, polling firms) is an enable-flag change rather than a rewrite. See `06-storage-and-api.md` §7.
- A thin LLM layer for three narrow tasks: neutral summarisation of long documents, hybrid (full-text + semantic) search, and **accountability synthesis** — a cached 4-layer join of (manifesto × motions × votes × budget) per (party, topic) that answers the end-goal sentence directly.

In scope (post-MVP, see `11-roadmap.md`):

- Committee meeting attendance and speaking time (*anföranden*) at finer granularity than monthly aggregates.
- Election-year manifesto refreshes (the Manifesto Project publishes new corpora after each election).
- Co-authorship graphs between MPs.
- **Optional commercial API tier.** A paid developer plan on top of the same `/v1` endpoints, targeted at newsrooms, polling firms, and research teams that want guaranteed throughput, higher rate limits, and an email-backed SLA. The free public tier continues to exist unchanged. See `11-roadmap.md` Phase 9.

Explicitly **out of scope, permanently**:

- User accounts, personalisation, "follow this MP", or push notifications. These would require auth, email infrastructure, and GDPR-sensitive storage, while adding no transparency value that a URL + RSS feed cannot provide.
- Any *mandatory* paywall on primary-source transparency. The free, anonymous, rate-limited public tier is a permanent commitment — selling a higher tier later must never come at the cost of the public one. The primary data is public under *offentlighetsprincipen*; we can never sell access to the data itself, only to convenience, throughput, and SLA.
- A rich design system. Reuse the open-source component library (shadcn + Radix + Tailwind) that the existing implementation already has.

### 3.1 Languages

The **primary language is Swedish**. UI strings, error messages, and page titles are in Swedish. Dates formatted as `20 apr 2026`. Numbers use space as thousands separator and comma as decimal per Swedish convention.

An **English routing primitive is preserved** (`/[locale]/...` via `next-intl`, which the existing implementation already has wired) but English message bundles are best-effort at MVP. Keeping the routing primitive costs nothing today and avoids a painful migration later if English reach becomes a grant or citation requirement.

## 4. Guiding principles

These principles are the tiebreakers when two approaches are otherwise comparable.

1. **No managed-SaaS free-tier dependencies on the hot path.** The specific failure that triggered this rewrite was storage-plus-embeddings exceeding the Supabase free tier. The response is systemic, not local: we avoid any third-party service whose free tier is our ceiling. Everything is either (a) AWS-native and priced per unit of use, or (b) the primary source data itself (Riksdagen, Statskontoret, Manifesto Project).
2. **Cheap-at-rest beats cheap-at-peak.** We optimise for a near-zero bill when no one is using the site, accepting modest cold-start penalties. A dashboard about civic transparency must survive the months between election cycles without burning money.
3. **Boring technology.** S3, Lambda, CloudFront, DynamoDB, API Gateway HTTP API, Bedrock, SES. Mature, documented, priced transparently.
4. **Static is free; dynamic is a tax.** Pages that do not need live data are pre-rendered to S3. Dynamic requests are explicitly justified.
5. **Citations everywhere.** Every rendered fact links to a primary-source URL. LLM outputs must cite or they are not shown. Summaries and accountability reports carry the model id and generation timestamp.
6. **Small blast radius.** Nothing the LLM generates can silently replace a fact. Summaries and accountability reports are clearly marked as such; originals remain one tap away.
7. **Asynchronous LLM calls.** LLM calls that might take more than a couple of seconds do not run in the request path. They run through SQS-triggered worker Lambdas, and the API returns either a cached result or `202 Accepted` with a poll URL.
8. **Infrastructure as code, no exceptions.** No "just click this in the console" steps. If it is not in CDK, it does not exist.
9. **GDPR-safe by default.** No PII collected. The only personal data in the system is what is *already* public under *offentlighetsprincipen* (names of MPs, their voting records, etc.).
10. **Reuse what already works.** The existing implementation has a proven ingestion pipeline, a canonical schema, a working Next.js UI, and a working accountability synthesis prompt. This plan migrates those off the Supabase/Voyage/Upstash/Vercel stack onto AWS primitives. It does not rewrite them from scratch.

## 5. Glossary

### 5.1 Swedish political terms (as used in this project)

- **Riksdag** — the Swedish parliament, 349 members elected every four years.
- **Ledamot** — an individual member of the Riksdag.
- **Riksmöte (RM)** — a parliamentary session, running roughly Sep–Sep. Identified by a two-year string like `2024/25`.
- **Utskott** — a parliamentary committee (e.g. *Finansutskottet* = the Finance Committee). Most motions are handled in a committee before reaching a chamber vote.
- **Motion (`mot`)** — a proposal submitted by one or more MPs. Private-members-bill equivalent.
- **Proposition (`prop`)** — a bill proposed by the government.
- **Skrivelse (`skr`)** — a government communication to the Riksdag that does not propose legislation.
- **Betänkande (`bet`)** — a committee report on a matter before the chamber; contains the committee's recommendation and reservations (dissents).
- **Interpellation (`ip`)** — a formal oral question from an MP to a minister, answered in the chamber.
- **Framställning (`fr`)** — a non-government proposal to the Riksdag from bodies such as Riksdagens styrelse, Riksrevisionen, or Riksbankens fullmäktige.
- **Skriftlig fråga** — a formal written question to a minister.
- **Votering (`votering`)** — a recorded vote in the chamber. Each MP's position is a *voteringsrad*.
- **Anförande** — a speech given in the chamber, recorded in the minutes.
- **Utgiftsområde** — an expenditure area in the state budget; each has a numeric code (e.g. `UO14` = Labour market).
- **Anslag** — a specific budget line within an expenditure area.
- **Utfall** — the realised outturn (actual spend) of a budget line, published by Statskontoret / ESV.
- **Offentlighetsprincipen** — the constitutional principle (Tryckfrihetsförordningen, 2 kap.) that official documents are public by default. It is the legal foundation that makes this project possible.

### 5.2 Technical terms (as used in this project)

- **IaC** — Infrastructure as Code. Our IaC tool is **AWS CDK** (TypeScript flavour).
- **CDK** — AWS Cloud Development Kit; compiles high-level TypeScript constructs into CloudFormation templates.
- **Stack** — the unit of deployment in CloudFormation/CDK. We will have `AgoraDataStack`, `AgoraApiStack`, `AgoraLlmStack`, `AgoraWebStack`, `AgoraObsStack`.
- **Lambda** — AWS's serverless compute primitive; our chosen runtime everywhere except the static frontend.
- **EventBridge Scheduler** — AWS's serverless cron; used to trigger ingestion Lambdas on a schedule.
- **Step Functions** — AWS's serverless orchestration; used to fan out document-text fetching and embedding jobs.
- **SQS** — AWS's serverless queue; used to decouple the accountability endpoint from the LLM worker.
- **S3** — object storage; used for raw ingest, for Parquet-formatted analytical data, for individual document text files, and for the static frontend.
- **Parquet** — a columnar file format; lets analytical queries read only the columns they need, which keeps cost down.
- **DuckDB** — an embedded analytical SQL engine; runs inside a Lambda and reads Parquet directly from S3. The FTS and VSS extensions give us full-text and vector search in one process.
- **Bedrock** — AWS's managed foundation-model gateway. Used for Titan Embed v2 (embeddings) and Claude Haiku (summaries, accountability).
- **Hybrid search** — a ranking strategy that combines full-text (BM25/tsvector-style) scores with vector cosine similarity; used for the `/search` endpoint.
- **RAG** — Retrieval-Augmented Generation: embed a question, find nearest document chunks, feed those chunks to an LLM with a strict "cite your sources" prompt.
- **WAF** — Web Application Firewall; used here only for a rate-limit rule in front of CloudFront and the API.

## 6. Non-goals, restated bluntly

We repeat this because every greenfield project eventually feels tempted to re-add one of these:

- **No user accounts on the public dashboard. No auth on the free public tier.** Transparency tools should not gate transparency.
- **No bespoke `api_keys` table, no Upstash-backed rate-counter, no self-rolled HMAC signing.** If a paid tier ships later (post-MVP Phase 9) it rides on AWS API Gateway's native Usage Plan + API Key + per-key throttling primitives — zero custom infrastructure. The existing implementation's `api_keys` / `/admin` / Upstash path is not ported.
- **No third-party analytics.** We read CloudFront logs ourselves via Athena if we need aggregate traffic numbers. No Google Analytics, no PostHog, no cookie banner.
- **No third-party error-tracking SaaS.** CloudWatch + SNS → email replaces Sentry.
- **No hosted Postgres.** The cost profile that triggered this rewrite was dominated by Postgres + pgvector storage ceilings; the response is to not use hosted Postgres at all. Analytical data lives in Parquet on S3; small mutable state lives in DynamoDB.
- **No Kubernetes, no ECS, no EC2.** If we cannot do it with Lambda, S3, DynamoDB, API Gateway, and CloudFront, we ask whether it is really needed.
- **No Vercel, no Netlify.** The Next.js app is statically exported and served from S3 via CloudFront.
