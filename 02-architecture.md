# 02 — Architecture

This document describes the target AWS architecture, the reasoning behind each choice, and a concrete monthly cost model. Everything here is deployable via the CDK project described in `10-iac-bootstrap.md`.

## 1. One-paragraph summary

Riksdagen's open-data endpoints are polled on a schedule by a Lambda that writes raw payloads to S3 and normalised Parquet files to a second S3 prefix. A second pipeline (also Lambda) ingests Statskontoret (ex-ESV) budget CSV and Manifesto Project statements into the same Parquet lake. A third Lambda runs DuckDB against the Parquet to serve JSON over API Gateway; most reads are served from the CloudFront cache. A fourth Lambda performs hybrid full-text + vector search and document summaries by calling Bedrock (Titan Embed v2 + Claude Haiku). Accountability synthesis runs asynchronously: the API returns `202 Accepted` and a poll URL; an SQS-triggered Lambda worker performs the 4-layer join and the Bedrock call, caches the result in DynamoDB. The dashboard is a statically-exported Next.js build on S3 behind the same CloudFront distribution. CloudWatch, AWS Budgets, SNS → email, and a WAF rate rule watch everything.

## 2. ASCII diagram

```
                  ┌─────────────────────────────────────────┐
                  │             EventBridge Scheduler        │
                  │  (daily riksdagen / monthly esv /        │
                  │   on-demand manifesto / weekly embed)    │
                  └──────┬───────────────┬──────────────┬────┘
                         │               │              │
                         ▼               ▼              ▼
       ┌───────────────────────┐ ┌──────────────┐ ┌──────────────┐
       │ Lambda: ingest-riks   │ │ Lambda: esv  │ │ Lambda: man  │
       │ data.riksdagen.se ──> │ │ statskontoret│ │ wzb manifesto│
       │ (Step Function fans   │ │ opendata ──> │ │ project api  │
       │  document-text fetch  │ │              │ │              │
       │  to ~10 parallel)     │ │              │ │              │
       └──────┬────────────────┘ └──────┬───────┘ └──────┬───────┘
              │                         │                 │
              ▼                         ▼                 ▼
       ┌──────────────────────────────────────────────────────┐
       │                 S3: agora-raw/                        │  <-- immutable source-of-truth
       │  riksdagen/.../*.json.gz                              │
       │  statskontoret/.../*.csv.gz                           │
       │  manifesto/.../*.json.gz                              │
       │  texts/<dok_id>.html.gz   (individual doc bodies)     │
       └────────────────────────┬─────────────────────────────┘
                                │  S3:ObjectCreated(manifest.json)
                                ▼
                    ┌────────────────────────┐
                    │ Lambda: transform      │
                    │  Python + pyarrow +    │  <-- idempotent rewrites
                    │  DuckDB                │       of affected partitions
                    └───────────┬────────────┘
                                │
                                ▼
            ┌──────────────────────────────────────────────────┐
            │              S3: agora-parquet/                   │
            │   members/, documents/, votes/, vote_results/,    │
            │   document_authors/, speeches/, budget_outcomes/, │
            │   manifestos/, manifesto_statements/,             │
            │   document_chunks/ (text + embedding),            │
            │   party_cohesion/, party_divergence/, etc.        │
            └──┬────────────────────────────────────┬──────────┘
               │                                    │
               ▼                                    ▼
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │ Lambda: api  (DuckDB)    │        │ Lambda: llm-read         │
  │  /members, /documents,   │        │  /v1/summarise           │
  │  /votes, /budget, etc.   │        │  /v1/search (hybrid)     │
  └──────────┬───────────────┘        └──────────┬───────────────┘
             │                                   │
             ├───────────────────┬───────────────┘
             │                   │
             ▼                   ▼
    ┌─────────────────────────────────────┐         ┌──────────────────────┐
    │     API Gateway HTTP API            │         │ DynamoDB             │
    │  CORS: dashboard only               │◀──────▶ │  ingest_cursors       │
    └──────────────┬──────────────────────┘         │  summary_cache        │
                   │                                │  accountability_cache │
                   │                                │  accountability_jobs  │
                   │                                │  ingestion_runs       │
                   │                                │  ratelimit_counter    │
                   │                                └──────────▲───────────┘
                   │                                           │
                   │       POST /v1/accountability             │
                   │       returns 202 + job_id                │
                   │           │                               │
                   │           ▼                               │
                   │   ┌────────────────┐   SQS     ┌──────────┴─────────┐
                   │   │ Lambda:        │──────────▶│ Lambda: llm-acc    │
                   │   │  enqueue       │           │  4-layer synthesis │
                   │   │                │           │  + Bedrock Haiku   │
                   │   └────────────────┘           └────────────────────┘
                   │
                   ▼
            ┌──────────────────────┐
            │      CloudFront      │
            │  (+ AWS WAF rate)    │
            └──┬───────────────────┘
               │                       /api/v1/*       /*
               │                       (to API GW)     (to S3 static site)
               ▼                                       ▼
                                   ┌──────────────────────────────┐
                                   │  S3: agora-web               │
                                   │  (Next.js static export)     │
                                   └──────────────────────────────┘
```

Observability sits off to the side: every Lambda emits logs + metrics to CloudWatch; an AWS Budgets alarm watches the monthly spend; a tiny Lambda ships a weekly digest email via SES.

## 3. Component-by-component rationale

### 3.1 Compute — Lambda everywhere

Why Lambda rather than ECS/Fargate/EC2:

- **Scale to zero.** Hours per day of near-zero traffic; we pay nothing during those hours.
- **Bedrock SDK, AWS SDK, DuckDB, pyarrow all run comfortably in Lambda** (Node and Python both <250 MB zipped with these libs, or via container images for transform/api/llm).
- **Deployment simplicity.** No container registry except for the container-image Lambdas; no task definitions; no cluster.
- **Cold starts are tolerable** for this use case (<1 s on ARM64 Node 20 with small bundles; 2–4 s for the DuckDB Lambda on first request, then warm). We mitigate by keeping bundles small and scheduling a light warm-up poke on the API Lambda every 10 minutes during Swedish daylight hours (costs <$0.05/mo).

Why ARM64 (Graviton):

- **~20 % cheaper per GB-second** than x86.
- Identical code path for Node/Python/DuckDB/NumPy.

### 3.2 Data storage — S3 + Parquet + DuckDB, with DynamoDB for mutable state

Why not a hosted Postgres (Supabase, RDS, Aurora Serverless v2):

- **Supabase:** the project explicitly ruled this out. Data storage (body texts) plus pgvector embeddings exceed the 500 MB free tier; Pro tier is $25/mo, above the coffee-budget ceiling for a dashboard with hours-per-day of near-zero traffic.
- **RDS PostgreSQL** (smallest `db.t4g.micro`, 20 GB gp3): ~$13–15/mo instance + storage. Out of budget at rest, before any traffic.
- **Aurora Serverless v2 with auto-pause to 0 ACU** (late-2024 feature): idle cost is effectively $0, but resume time is 10–30 s. Every "click" after a pause would be a bad experience. Warm-state minimum (0.5 ACU continuously) is ~$43/mo — well out of band.

Why S3 + Parquet + DuckDB:

- S3 storage cost for our full working set (see section 4 for the decomposition) is under $0.20/mo.
- DuckDB in a Lambda reads Parquet directly from S3 using range requests; a well-partitioned query scans a few MB and costs a fraction of a cent.
- The **DuckDB FTS extension** gives us full-text search with Swedish stemming out of the box. The **DuckDB VSS extension** (HNSW on disk) is an option for vector search; we default to **NumPy cosine similarity** on a Parquet-loaded embedding matrix (a few hundred MB, mmap-able, fits a 1 GB Lambda) because it is simpler and faster at our corpus size.
- Columnar format is near-ideal for dashboard analytics.
- No cluster to run, no connection pool to manage, no schema migrations beyond rewriting the Parquet file.

Why still use DynamoDB for some things:

Even with Parquet as the analytical store, the system has a small amount of **mutable, point-lookup state** that does not fit an immutable columnar layout. DynamoDB on-demand costs fractions of a cent per month for this workload and saves us from re-writing Parquet partitions for every small state change.

| DynamoDB table | Purpose |
|---|---|
| `ingest_cursors` | Last-seen id per Riksdagen/ESV/Manifesto endpoint. |
| `ingestion_runs` | Per-run audit log (source, start, end, counts, errors). |
| `summary_cache` | `(dok_id, model_id) → (summary_sv, generated_at)`. 7-day TTL. |
| `accountability_cache` | `(party, topic_hash) → (summary, generated_at, sources)`. 7-day TTL. |
| `accountability_jobs` | `job_id → (status, created_at, result_ref)`. 24-hour TTL. |
| `ratelimit_counter` | Per-IP token-bucket counter for expensive endpoints. 10-minute TTL. |

### 3.3 Hot-path query engine — DuckDB-in-Lambda

The API Lambda ships with DuckDB (Python package, ARM64 wheel). Cold start downloads ~30 MB of DuckDB binary + `httpfs` + `fts` extensions; warm requests reuse them.

A condensed bootstrap:

```python
import duckdb, os

def get_duck():
    con = duckdb.connect(":memory:")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL fts;    LOAD fts;")
    con.execute(f"SET s3_region='{os.environ['AWS_REGION']}';")
    con.execute("""
      CREATE VIEW votes           AS SELECT * FROM read_parquet('s3://.../votes/year=*/part-*.parquet');
      CREATE VIEW vote_results    AS SELECT * FROM read_parquet('s3://.../vote_results/year=*/part-*.parquet');
      CREATE VIEW documents       AS SELECT * FROM read_parquet('s3://.../documents/doktyp=*/year=*/part-*.parquet');
      CREATE VIEW document_texts  AS SELECT * FROM read_parquet('s3://.../document_texts/year=*/part-*.parquet');
      CREATE VIEW members         AS SELECT * FROM read_parquet('s3://.../members/part-*.parquet');
      CREATE VIEW budget_outcomes AS SELECT * FROM read_parquet('s3://.../budget_outcomes/year=*/part-*.parquet');
      CREATE VIEW manifesto_statements AS SELECT * FROM read_parquet('s3://.../manifesto_statements/party=*/year=*/part-*.parquet');
    """)
    # FTS indexes built lazily on first search request, pinned on warm container
    return con
```

The IAM role attached to the Lambda grants `s3:GetObject` on the parquet bucket and nothing else.

### 3.4 API — API Gateway HTTP API (not REST API)

- HTTP API is **~70 % cheaper** than REST API (~$1.00 / million requests vs. $3.50).
- Feature set is sufficient for the free public tier: routes, Lambda proxy, CORS, JWT authorizer, Lambda authorizer.
- CloudFront sits in front of it, so most reads are cache hits and never reach API Gateway at all.

#### 3.4.1 Paid-tier migration path (preserved, not built)

HTTP API does **not** natively support AWS's `UsagePlan` + `ApiKey` + per-key throttle resources — those are REST-API-only. This is the one architectural corner that a naive reader might think forecloses the commercial tier. It does not. Two clean paths exist, each a well-scoped CDK change rather than a rewrite; see `11-roadmap.md` Phase 9 for the decision gate:

- **Path A — Lambda authorizer + DynamoDB key store (recommended).** Keep the HTTP API. Add a Lambda authorizer that reads a hashed API key from the `Authorization` header, looks it up in a new `api_keys` DynamoDB table (`key_hash → {tier, active, owner_email}`), and returns a policy document + usage context. Per-key throttling is enforced in-Lambda with the existing `ratelimit_counter` DynamoDB table, partition-keyed by `k#<key_hash>` instead of `ip#<address>`. No REST API migration, no additional API Gateway cost, per-request authorizer cost ≲ $0.02/mo. The `api_keys` table is ~100 rows even at generous growth — nothing like the existing implementation's Postgres-backed keyring.
- **Path B — REST API for the paid endpoints only.** Stand up a parallel REST API (`api.agora.se/pro/v1/...`) with UsagePlan + ApiKey natively wired. Free tier keeps the HTTP API. Costs shift from $1.00 to $3.50 per million requests *only on the paid path*, which matters little because paid customers are by definition low-QPS relative to aggregate free-tier traffic. Advantage: zero custom code for key issuance, tier enforcement, or throttling.

The common denominator for both paths: the Lambda handlers are the same, the Parquet/DuckDB layer is the same, the DynamoDB tables are the same. What changes is only the request-authentication shim at the edge. Either path is 1–2 days of work from a cold start.

### 3.5 Frontend — Next.js static export, S3 + CloudFront

The existing implementation is a Next.js 16 App Router app with `next-intl`, shadcn components, Tailwind 4, Recharts, and Lucide icons. It is **kept as-is** for the port:

- Build with `output: 'export'` (Next.js static export) to produce a fully pre-rendered site with hydrated client components.
- Deploy to `agora-web` S3 bucket via CDK's `BucketDeployment`; invalidate CloudFront on every deploy.
- The accountability demo page, which needs server-side logic, calls the Lambda-backed HTTP API rather than relying on a Next.js server runtime.

Why we did not rewrite the UI to SvelteKit: the existing code works, is well-styled, and includes `next-intl` routing that we want to preserve for future English support. A rewrite cost is not justified by any measurable user benefit.

### 3.6 LLM — Amazon Bedrock (Claude Haiku + Titan Embed v2)

- **Claude 3 Haiku** (latest available small Claude in `eu-north-1`) via Bedrock: low-cost, good enough for 3-sentence neutral summaries and 150-word accountability syntheses in Swedish.
- **Titan Text Embeddings v2**: 1024-dim multilingual embeddings, $0.02 per 1 M input tokens. Strong in Nordic languages per AWS's documentation.
- **No vector DB.** Embeddings are stored as a column in `manifesto_statements` and `document_chunks` Parquet. At query time, the LLM Lambda reads the relevant rows into NumPy and computes cosine similarity in memory (a few hundred ms at our corpus size).
- **No hosted vector service** (no Pinecone, Weaviate, Qdrant). Each of them has a free tier that will eventually become a paid tier — exactly the failure mode that motivated this rewrite.

Bedrock is chosen over direct Anthropic/OpenAI APIs because it keeps requests, logs, and billing inside AWS in the same region as the data.

### 3.7 CDN + security — CloudFront + AWS WAF

- CloudFront in front of both the static site and the API. Always-free tier includes 1 TB egress + 10 M HTTPS requests / mo.
- **AWS WAF** with a rate-based rule (300 req / 5 min / IP) in front of CloudFront: ~$5–6/mo. Alternative documented in `09-observability-and-security.md` section 4.1: a CloudFront Function + DynamoDB counter (~$0.20/mo) at the cost of more code.
- For the expensive endpoints (`/v1/summarise`, `/v1/search`, `/v1/accountability`) a per-IP token bucket in DynamoDB provides a second throttle layer.

### 3.8 DNS & TLS

- Route 53 hosted zone: $0.50/mo. Optional at MVP; use the default `*.cloudfront.net` URL initially.
- AWS Certificate Manager public certificates: free.

## 4. Monthly cost model

### 4.1 Data footprint decomposition

With the full set of tables from the implementation carried forward:

| Parquet table | Rows | Row size | Raw (MB) | Parquet compr. | Notes |
|---|---|---|---|---|---|
| `members` | ~2 k | 200 B | 0.4 | <1 | Full refresh nightly |
| `documents` | ~500 k | 500 B | 250 | 40 | All doctypes, historical |
| `document_texts` (body_text only) | ~500 k | 20 KB avg | 10 GB | 2 GB | Stored as individual S3 text files, not Parquet — see section 4.2 |
| `document_authors` | ~2 M | 40 B | 80 | 10 | Many-to-many |
| `votes` | ~20 k | 200 B | 4 | 1 | Aggregate rows |
| `vote_results` | ~5 M | 120 B | 600 | 100 | One row per MP per vote |
| `speeches` | ~200 k | 300 B + text | 50 (meta) | 10 | Full text fetched on demand |
| `budget_outcomes` | ~500 k | 120 B | 60 | 10 | 1997–present, monthly granularity |
| `manifestos` | ~40 | 200 B | 0.01 | <1 | 8 parties × 5 elections |
| `manifesto_statements` + embeddings | ~50 k | 600 B + 4 KB vec | 250 | 200 | 1024-dim float32 |
| `document_chunks` + embeddings | ~250 k | 300 B + 4 KB vec | 1.1 GB | 800 | 1024-dim float32 |
| Derived tables (cohesion, divergence, etc.) | small | — | — | <20 | |

**Parquet working set: ~1.2 GB compressed.** Raw mirror in `agora-raw`: ~5 GB including gzipped JSON pages + gzipped HTML document bodies.

### 4.2 Document bodies — S3 object files, not Parquet columns

Motion + proposition body text is the largest piece of data. Storing it as a column in a Parquet table forces every full-text query to scan the whole column (DuckDB's Parquet reader is page-based but still reads more than we want for keyword lookups). Storing each body as a small gzipped S3 object keyed on `dok_id` is cheaper and more flexible:

- `s3://agora-raw/texts/<dok_id>.html.gz` and `<dok_id>.txt.gz`
- The `documents` Parquet row carries `text_s3_key` and `word_count`.
- The FTS Lambda loads only the bodies whose `dok_id`s match a metadata pre-filter (by `year`, `doktyp`, `utskott`), then builds a DuckDB FTS index over them.

### 4.3 Line-item monthly bill

Assumptions:

- **Traffic:** 5 000 dashboard visits / mo, ~10 API requests each = 50 k API calls / mo.
- **Ingestion:** 1 Riksdagen run / day (30 s, 512 MB) + 1 ESV run / mo + 1 Manifesto run / quarter + 1 weekly embed-refresh.
- **Transform:** ~50 runs / mo at 1 024 MB × 10 s = 500 GB-s.
- **API Lambda:** 50 k invocations, avg 400 ms at 1 024 MB. CloudFront cache hit ratio 80 % → ~10 k real invocations = 4 000 GB-s.
- **LLM-read Lambda:** 1 000 summary calls / mo, 500 search calls / mo.
- **LLM-accountability Lambda:** ~1 000 unique (party, topic) syntheses / mo after cache (mostly cached hits at CloudFront-level).
- **Bedrock Haiku:** 1 000 summaries × (~2 k in / 200 out) + 1 000 syntheses × (~3 k in / 300 out) tokens.
- **Bedrock Titan Embed:** 50 k initial + 2 k / week incremental ≈ 100 k tokens / mo.
- **Storage:** ~1.2 GB Parquet + ~5 GB raw + ~100 MB frontend.
- **CloudFront:** 50 GB egress, 500 k requests.

| Service | Usage | Cost |
|---|---|---|
| Lambda compute | ~6 k GB-s ARM64 | Always-free tier covers 400 k GB-s/mo; $0 |
| Lambda requests | ~60 k | Always-free tier covers 1 M/mo; $0 |
| API Gateway HTTP API | 50 k req | 1 M free first 12 months, then ~$0.05 |
| CloudFront | 50 GB + 500 k req | Always-free tier covers 1 TB + 10 M HTTPS req; $0 |
| S3 storage | ~6.5 GB mix | ~$0.15 |
| S3 requests | ~20 k PUT + ~100 k GET | ~$0.15 |
| DynamoDB on-demand | ~200 k ops | ~$0.25 |
| SQS | ~1 k messages | $0 (1 M free/mo) |
| Bedrock Claude Haiku | ~2.5 M in / 0.5 M out tokens | ~$1.30 |
| Bedrock Titan Embed v2 | ~0.1 M tokens | ~$0.002 |
| AWS WAF | 1 web ACL, 1 rule, 500 k req | ~$5.60 |
| Route 53 (optional) | 1 hosted zone | $0.50 |
| CloudWatch logs | ~1 GB ingested | ~$0.50 |
| **Total first 12 months** | | **≈ $8.50** |
| **Steady state (WAF variant)** | | **≈ $9** |
| **Steady state (CloudFront-Function rate-limit variant)** | | **≈ $3.50** |

Commentary:

- The WAF base fee dominates steady-state cost; the CF-Function variant drops the bill to ~$3.50/mo.
- Bedrock costs scale with unique summary/accountability demand, not with idle time.
- Adding the accountability feature adds only ~$0.50/mo net vs. the earlier plan, because cache + CloudFront absorb most repeat queries.
- The entire steady-state stack is comfortably inside the $10/mo coffee-budget ceiling. If traffic 10×'s the bill, we're still at ~$30/mo worst case.

### 4.4 Incremental cost of a paid tier (if/when it ships)

If Phase 9 ships and the commercial tier acquires, say, 20 paying customers averaging 50 k API requests / mo each (= 1 M paid requests / mo on top of the free baseline):

| Service | Marginal usage | Marginal cost |
|---|---|---|
| Lambda compute | ~80 k additional GB-s | still inside free tier → $0 |
| Lambda requests | +1 M | ~$0.20 |
| API Gateway HTTP API | +1 M | ~$1.00 |
| DynamoDB (auth + rate) | ~2 M reads | ~$0.25 |
| CloudWatch | negligible | ~$0.10 |
| Stripe fees (2.9 % + 3 SEK / txn on ~20 monthly charges) | — | ~$3–5 |
| **Marginal monthly cost of paid tier** | | **≈ $5–7** |

That marginal cost is covered by any plausible pricing ($20–50 / mo / customer), which makes the feature comfortably self-funding above ~2 paying customers. Pricing itself is a business question reserved for `11-roadmap.md` Phase 9.

## 5. Why not…

A short list of architectures we considered and rejected, with reasons:

- **Supabase Pro** ($25/mo + egress). Above ceiling; fails the "no third-party free-tier tripwires" principle.
- **RDS PostgreSQL or Aurora Serverless v2.** Either expensive at rest or poor UX on wake. The data shape does not need a relational database for the hot path.
- **Supabase self-hosted on Fargate.** More moving parts than RDS, same cost bracket.
- **OpenSearch Serverless** for search. Minimum ~$350/mo (two 0.5 OCU indexers). Wildly out of band.
- **Pinecone / Weaviate / Qdrant Cloud** for vectors. Each has a free tier that will eventually become paid — the pattern we are trying to escape.
- **SQLite with sqlite-vec + Litestream to S3.** Clever and very cheap, but the read-only replication story across many concurrent Lambdas is more complex than DuckDB-over-S3-Parquet, which is purpose-built for this shape.
- **Self-hosted Postgres on a t4g.nano EC2** ($3/mo). Tempting but reintroduces an OS to patch, a backup strategy, a failover story, and a security perimeter. The cost saving is not worth the operational cost.
- **DynamoDB-only.** Possible, but the analytical queries (filter + aggregate across dates/parties/committees) get awkward; every new query needs a new GSI. Parquet + DuckDB is more pleasant.
- **Vercel for hosting.** Pro tier is $20/user/mo minimum; Hobby tier's commercial-use terms are borderline for civic-tech; either way it's a SaaS free-tier dependency we're trying to leave behind.
