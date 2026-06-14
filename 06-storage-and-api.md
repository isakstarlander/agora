# 06 — Storage and API

This document describes how the Parquet-on-S3 storage layer is served to the dashboard through a small HTTP API, and how the read path composes the storage with the LLM layer for summaries, hybrid search, and accountability synthesis.

## 1. Storage layer

### 1.1 Buckets

Three S3 buckets. Names illustrated with the `agora-` prefix; real names include an account-id suffix to be globally unique.

| Bucket | Purpose | Versioning | Lifecycle |
|---|---|---|---|
| `agora-raw`     | Immutable source-of-truth mirror of upstream responses (Riksdagen, Statskontoret, Manifesto Project) | Enabled  | Transition to IA at 90 d, Glacier at 365 d, delete at 3 y |
| `agora-parquet` | Canonical analytical tables                                                                          | Enabled  | Transition to IA at 180 d; never delete |
| `agora-web`     | Static frontend build output                                                                         | Disabled | Keep latest only                       |

All three are **block-public-access=on**. Public access goes through CloudFront with an Origin Access Control (OAC).

### 1.2 Parquet layout

```
agora-parquet/
  members/
    part-0000.parquet
    _SUCCESS
  documents/
    doktyp=mot/year=2024/part-0000.parquet
    doktyp=mot/year=2025/part-0000.parquet
    doktyp=prop/year=2024/part-0000.parquet
    doktyp=bet/year=2024/part-0000.parquet
    doktyp=ip/year=2024/part-0000.parquet
    doktyp=fr/year=2024/part-0000.parquet
    _SUCCESS
  document_authors/
    part-0000.parquet
    _SUCCESS
  votes/
    year=2024/part-0000.parquet
    year=2025/part-0000.parquet
    _SUCCESS
  vote_results/
    year=2024/part-0000.parquet
    year=2025/part-0000.parquet
    _SUCCESS
  votes_wide/                     (same partitioning as vote_results)
  speeches/
    year=2024/part-0000.parquet
    _SUCCESS
  budget_outcomes/
    year=2023/part-0000.parquet
    year=2024/part-0000.parquet
    _SUCCESS
  manifestos/part-0000.parquet
  manifesto_statements/part-0000.parquet
  document_chunks/
    doktyp=mot/part-0000.parquet
    doktyp=prop/part-0000.parquet
    _SUCCESS
  document_embeddings/
    part-0000.parquet
    part-0001.parquet
    _SUCCESS
  party_cohesion/part-0000.parquet
  party_divergence/part-0000.parquet
  attendance_monthly/part-0000.parquet
  motion_throughput/part-0000.parquet
  speech_monthly/part-0000.parquet
  budget_by_area/part-0000.parquet
  manifesto_by_category/part-0000.parquet
```

The `_SUCCESS` marker is a sentinel file used by the DuckDB query runner to guarantee read-after-write consistency: readers only look at files listed in the most recent `_SUCCESS` manifest, not at whatever happens to be in the prefix mid-write.

### 1.3 DuckDB-in-Lambda query runner

The API Lambda ships with DuckDB (Python package, ARM64 wheel). Cold start downloads ~30 MB of DuckDB binary + `httpfs` + `fts` extensions; warm requests reuse it. Full-text search uses DuckDB's FTS extension against `documents.titel || ' ' || documents.undertitel` and against `document_chunks.text` at warm-start.

Connection bootstrap:

```python
import duckdb, os

_con: duckdb.DuckDBPyConnection | None = None

def get_duck() -> duckdb.DuckDBPyConnection:
    global _con
    if _con is not None:
        return _con
    con = duckdb.connect(":memory:")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL fts;    LOAD fts;")
    con.execute(f"SET s3_region='{os.environ['AWS_REGION']}';")
    con.execute("SET s3_use_ssl=true;")

    # Base tables
    con.execute("CREATE VIEW members     AS SELECT * FROM read_parquet('s3://agora-parquet/members/part-*.parquet');")
    con.execute("CREATE VIEW documents   AS SELECT * FROM read_parquet('s3://agora-parquet/documents/doktyp=*/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW document_authors AS SELECT * FROM read_parquet('s3://agora-parquet/document_authors/part-*.parquet');")
    con.execute("CREATE VIEW votes       AS SELECT * FROM read_parquet('s3://agora-parquet/votes/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW vote_results AS SELECT * FROM read_parquet('s3://agora-parquet/vote_results/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW votes_wide  AS SELECT * FROM read_parquet('s3://agora-parquet/votes_wide/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW speeches    AS SELECT * FROM read_parquet('s3://agora-parquet/speeches/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW budget_outcomes AS SELECT * FROM read_parquet('s3://agora-parquet/budget_outcomes/year=*/part-*.parquet', hive_partitioning=1);")
    con.execute("CREATE VIEW manifestos  AS SELECT * FROM read_parquet('s3://agora-parquet/manifestos/part-*.parquet');")
    con.execute("CREATE VIEW manifesto_statements AS SELECT * FROM read_parquet('s3://agora-parquet/manifesto_statements/part-*.parquet');")
    con.execute("CREATE VIEW document_chunks    AS SELECT * FROM read_parquet('s3://agora-parquet/document_chunks/doktyp=*/part-*.parquet', hive_partitioning=1);")

    # FTS indexes — in-memory, rebuilt per warm Lambda
    con.execute("PRAGMA create_fts_index('documents', 'dok_id', 'titel', 'undertitel', stemmer='swedish');")
    con.execute("PRAGMA create_fts_index('document_chunks', 'chunk_pk', 'text', stemmer='swedish');")

    _con = con
    return con
```

Document embeddings are loaded lazily by the search handler as a NumPy `float32` array (see section 3.2 below) — not as a DuckDB view — because cosine similarity is a dense linear-algebra operation better served by NumPy than by SQL.

The IAM role attached to the Lambda grants `s3:GetObject` on the parquet bucket and `s3:GetObject` on `s3://agora-raw/doc-text/*` and nothing else. S3 endpoint usage stays within the AWS network, so there is no egress cost.

### 1.4 When to reach for Athena instead

Athena is deployed but not on the hot path. It is used when:

- A derivation query is too heavy for DuckDB's 10 GB Lambda `/tmp` budget.
- An ad-hoc journalist-style query needs to be run from the AWS console.
- We need to ad-hoc aggregate CloudFront access logs (see `09-observability-and-security.md`).

Athena reads the *same* Parquet files; we expose a Glue Data Catalog view of the layout for convenience.

## 2. HTTP API

### 2.1 Gateway

**API Gateway HTTP API** (not REST API) in front of the Lambdas. Single domain, multiple routes. CORS restricted to the dashboard's CloudFront domain for browser traffic; server-to-server calls from the eventual paid-tier consumers are allowed by the same CORS rule (CORS only affects browsers) and pass through unchanged.

Three Lambdas back the API:

- **`api`** (Python 3.12) — handles every synchronous read route in sections 2.2 and 2.3 (documents, votes, members, cohesion, budgets, manifestos). Uses the DuckDB bootstrap above.
- **`llm-read`** (Python 3.12) — handles `POST /v1/summarise` and `POST /v1/search`. Calls Bedrock directly; may return synchronously on cache hit.
- **`enqueue-accountability`** (Python 3.12, tiny) — handles `POST /v1/accountability`; writes an `accountability_jobs` row, pushes to SQS, returns `202 Accepted` (or `200` on cache hit). Poll route lives on `api`.

Separate Lambdas keep the hot-path `api` cold-start small (no boto3-bedrock import) and let us size memory independently (the LLM handlers provision 2,048 MB so they can hold the embedding matrix; `api` runs at 1,024 MB).

**Reserved authorizer hook.** The HTTP API is defined with no authorizer at MVP — every route is public-and-anonymous. The CDK construct for the API exposes a no-op `AuthorizerConfig` object so that a Lambda authorizer can be attached in one CDK diff when Phase 9 (commercial tier) ships. The authorizer contract is documented in §7.3 below and is deliberately minimal so that MVP handlers do not branch on auth state.

### 2.2 Read routes

All routes are `GET`, cacheable, and accept an optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` period scope.

| Method + path | Purpose | Cache TTL at CloudFront |
|---|---|---|
| `GET /v1/members`                                        | List of MPs with party/constituency; optional `?rm=`, `?parti=`   | 24 h |
| `GET /v1/members/{intressent_id}`                        | Member detail                                                     | 6 h  |
| `GET /v1/members/{intressent_id}/attendance`             | Attendance over period                                            | 6 h  |
| `GET /v1/members/{intressent_id}/speeches`               | Speech count & chars over period                                  | 6 h  |
| `GET /v1/documents`                                      | Paginated documents; filters `?doktyp=`, `?rm=`, `?parti=`, `?utskott=`, `?q=` | 5 min |
| `GET /v1/documents/{dok_id}`                             | Document detail, includes cached summary if present               | 1 h  |
| `GET /v1/documents/{dok_id}/authors`                     | Motion authorship                                                 | 24 h |
| `GET /v1/votes`                                          | Paginated vote points; filters `?rm=`, `?utskott=`, `?parti=`     | 5 min |
| `GET /v1/votes/{votering_id}`                            | One vote point, per-MP detail                                     | 1 h  |
| `GET /v1/party-cohesion`                                 | Cohesion series; filters `?parti=`, `?rm=`                        | 1 h  |
| `GET /v1/party-divergence`                               | Divergence matrix for a period                                    | 1 h  |
| `GET /v1/motion-throughput`                              | Counts by committee                                               | 1 h  |
| `GET /v1/budget`                                         | Budget outcomes by area; filters `?year=`, `?uo=`, `?budget_type=`| 12 h |
| `GET /v1/budget/areas`                                   | List of expenditure areas with names                              | 24 h |
| `GET /v1/manifestos`                                     | Manifestos by party and election                                  | 24 h |
| `GET /v1/manifestos/{party_code}/{election_year}`        | Statement list for one manifesto                                  | 24 h |
| `GET /v1/accountability/jobs/{job_id}`                   | Poll route for async accountability synthesis                     | 0    |
| `POST /v1/summarise`                                     | LLM summary (see `08-llm-layer.md`)                               | not cached at CF; cached in DynamoDB 365 d |
| `POST /v1/search`                                        | Hybrid FTS + vector search                                        | 15 min (keyed on query-string hash) |
| `POST /v1/accountability`                                | 4-layer accountability synthesis for (party, topic, period)       | not cached at CF; cached in DynamoDB 7 d |
| `GET /v1/health`                                         | Liveness                                                          | 0    |

### 2.3 Response shape

Every collection response is:

```json
{
  "items": [ ... ],
  "next_cursor": "opaque-string-or-null",
  "fetched_at": "2026-04-20T12:00:00Z",
  "source": "https://data.riksdagen.se/..."
}
```

Every item includes a `source_url` pointing back to the underlying primary document (Riksdagen, Statskontoret, or Manifesto Project), because the dashboard's promise is one-tap verification.

Errors follow RFC 7807 (`application/problem+json`):

```json
{
  "type":   "https://agora.invalid/errors/not-found",
  "title":  "Dokument saknas",
  "status": 404,
  "detail": "Dok_id HB02MOT9999 finns inte i agoras index.",
  "instance": "/v1/documents/HB02MOT9999"
}
```

### 2.4 Caching strategy

CloudFront is configured with:

- `Cache-Control: public, max-age=<ttl>, stale-while-revalidate=600, stale-if-error=86400` set by the API Lambda per route.
- A cache key comprising path + normalised query string (sorted parameters; lower-cased values where appropriate).
- Automatic gzip + brotli.
- Invalidation on deploy only for the static bucket; API responses expire naturally.

A pragmatic target at steady state is an 80% cache hit ratio.

### 2.5 Pagination

Cursor-based. The cursor is a base64-encoded JSON blob of the last row's `(datum, dok_id)` pair (or equivalent per-table sort key). This avoids `OFFSET` scans and is stable across repeated reads.

### 2.6 Rate limiting

Two layers, designed so that a future paid tier plugs in without surgery:

1. **CloudFront → WAF** rate-based rule: 300 requests per 5-minute sliding window per source IP. Returns `429` with a `Retry-After` header. (Alternative, if cost-optimising: CloudFront Function + DynamoDB TTL counter; see `09-observability-and-security.md` for the trade-off.)
2. **API Lambda → self**: the LLM-backed endpoints (`/summarise`, `/search`, `/accountability`) check a DynamoDB TTL counter and return `429` if the caller exceeds their quota. The counter's partition key is a **principal identifier** (`principal_id`) and not an IP per se:
   - Anonymous free-tier traffic: `principal_id = "ip#" + source_ip`, default quota 20 req / 10 min.
   - Future authenticated traffic: `principal_id = "key#" + sha256(api_key)[:16]`, quota read from the authorizer context (`rate_limit_rpm`).

   The Lambdas are written against `principal_id` from day one, so enabling the paid tier is a question of which value the authorizer supplies — not a code change in the handler.

Details and alternatives in `09-observability-and-security.md`.

## 3. Hybrid search — `POST /v1/search`

This is the endpoint that makes the dashboard's "find motions about X" feature work. It is a port of the existing implementation's `search_documents(query_text, query_embedding, …)` RPC, re-expressed with DuckDB's FTS extension for the lexical leg and NumPy for the vector leg.

### 3.1 Request

```json
{
  "q":        "förskoleplatser",
  "doktyp":   ["mot", "prop"],   // optional filter
  "rm":       "2024/25",         // optional
  "limit":    20
}
```

### 3.2 Pipeline

1. Embed `q` via Bedrock Titan Embed v2 (1024 dims). ~50 ms warm.
2. Run the FTS leg:
   ```sql
   SELECT dok_id, titel, undertitel,
          fts_main_documents.match_bm25(dok_id, ?) AS fts_score
     FROM documents
    WHERE doktyp IN (?) AND rm = ?
    ORDER BY fts_score DESC
    LIMIT 200;
   ```
   DuckDB's FTS extension implements BM25 with the Swedish stemmer specified at index creation time.
3. Run the vector leg in NumPy: cosine similarity between the query vector and the `document_embeddings` matrix, filtered to the same `doktyp` / `rm` pre-filter. The embedding matrix is loaded once per warm Lambda from `s3://agora-parquet/document_embeddings/` into a `float32 (N, 1024)` NumPy array (~200 MB at N=50k).
4. Combine scores with a weighted mean, **40% FTS + 60% vector** — the same weighting the existing implementation used and the weighting civic-tech hybrid-search papers report works well for short queries against long legal-text corpora. Break ties by `datum` desc.
5. Resolve the top-`limit` `dok_id`s to full `documents` rows via a single DuckDB point-join.
6. Return the items with their hybrid score and per-leg sub-scores (for debugging; the dashboard hides them by default).

### 3.3 Caching

CloudFront caches on `sha256(q + doktyp + rm + limit)` for 15 minutes. The embedding call to Bedrock is therefore the only paid-per-call operation, and only ~20% of distinct queries hit it.

### 3.4 Why not OpenSearch

OpenSearch Serverless is priced at minimum ~$350/month — above the project's entire annual budget. DuckDB FTS + NumPy is strictly weaker on operator fluency but strictly sufficient for this corpus size (O(50k) documents, O(200k) chunks). If we later scale past ~O(1M) chunks, revisit.

## 4. Summary — `POST /v1/summarise`

Thin wrapper:

1. Read `{dok_id, model_id}` from the body.
2. Look up `summary_cache` in DynamoDB. On hit, return synchronously.
3. On miss, fetch `s3://agora-raw/doc-text/{dok_id}.txt.gz`, call Bedrock Claude Haiku with the prompt in `08-llm-layer.md` §2, write the result (including citations) to `summary_cache` with 365-day TTL, and return.

Synchronous by design — summaries cap out at ~2 s warm (Haiku).

## 5. Accountability — `POST /v1/accountability`

This is the endpoint that directly answers the foundation-document end-goal sentence. It is async by default.

### 5.1 Request

```json
{
  "party":  "S",
  "topic":  "förskoleplatser",
  "from":   "2022-09-01",
  "to":     "2026-09-01"
}
```

### 5.2 Protocol

1. `POST /v1/accountability` → Lambda `enqueue-accountability`:
   1. Normalise `(party, topic, from, to)` → compute `input_hash = sha256(…)` and `cache_pk = "{party}#{sha256(topic)[:12]}#{sha256(from+to)[:12]}"`.
   2. Look up `accountability_cache`. On hit and `input_hash` matches and TTL not expired → return `200` with the cached report body. (~10 ms.)
   3. On miss, write an `accountability_jobs` row with `state=queued`, push an SQS message `{job_id, cache_pk, party, topic, from, to}`, return `202 Accepted` with `Location: /v1/accountability/jobs/{job_id}` and a JSON body `{ "job_id": "…", "poll_url": "…", "estimated_wait_ms": 8000 }`.
2. The SQS queue triggers `llm-acc` Lambda (Python 3.12, 3,008 MB). It:
   1. Sets `state=running`, writes progress 0%.
   2. Runs the four-layer retrieval (see `08-llm-layer.md` §4) against DuckDB for the `(manifesto, motions, votes, budget)` bundle.
   3. Writes progress 50%.
   4. Calls Bedrock Claude Haiku with the accountability prompt, ~150-word output bounded, cite-or-don't-show enforced at the model's output layer.
   5. Writes the result to `accountability_cache` with 7-day TTL.
   6. Updates the job row with `state=done`, `result_pk=cache_pk`, progress 100%.
3. The dashboard polls `GET /v1/accountability/jobs/{job_id}` every 1–2 s. On `state=done` it fetches the cached result via the same endpoint (which reads from `accountability_cache` by `result_pk`).

Total wall-clock on a cache miss: ~5–10 seconds. Cache hits: ~10 ms.

### 5.3 Why async

Synchronous LLM calls in an API Gateway path invite 30-second timeouts on cache misses. The accountability synthesis is expensive enough (4 DuckDB queries + 1 LLM call with ~4 KB of context) that occasional misses will brush against that ceiling. The 202-then-poll pattern is explicitly safe, and the job record gives us `progress_pct` for UI feedback ("Sammanfattar ansvarsutkrävande… 50%").

### 5.4 Cache semantics

- **TTL = 7 days.** A report can safely go stale for a week; parliamentary activity does not shift that fast for a given `(party, topic)`.
- **Hash-based invalidation.** Every cache row carries the `input_hash` of the four-bundle input. If new ingest data changes the hash (e.g. a new motion is published by the party on the topic), the cached row is considered stale regardless of its age and the next request re-enqueues a synthesis.
- **Prompt versioning.** The prompt text itself is in a version-controlled file; its SHA is written to `prompt_version` in `accountability_cache`. Changing the prompt invalidates all cached rows.

## 6. Why a dedicated API, not just static JSON

We considered pre-computing all the dashboard's data as static JSON and serving it from S3 directly (no Lambda at all). It is tempting: cheapest possible, simplest possible. We rejected it because:

1. **Dashboard users filter.** "Votes by party X in month Y on committee Z" has too many parameter combinations to precompute; the combinatorial explosion outgrows S3 storage benefits.
2. **Freshness is granular.** Pre-rendering requires a full regenerate on every ingest. Runtime queries serve fresh data immediately after transform.
3. **Search needs compute.** The hybrid-search endpoint must compute embedding similarity server-side.
4. **Accountability needs compute.** The LLM synthesis cannot run in the browser.

However we **do** pre-compute the small, list-y pages — most notably the index of all members and the list of expenditure areas — as static files refreshed nightly into `agora-web/static/*.json`. Some pages are better as static files; the routing decision is per-endpoint, documented inline.

## 7. API as a product — forward-compatible design

The dashboard is Agora's MVP product. The API is a by-product today; it may become a **second** product tomorrow (Swedish newsrooms, polling firms, political consultancies, academic researchers). The MVP does not build that second product, but the MVP does build the API in a way that **does not foreclose** it. This section lists the specific engineering invariants that make the future rollout cheap.

### 7.1 Versioning

The API is prefixed `/v1/`. Breaking changes bump the prefix (`/v2/`). Old versions run in parallel for at least 90 days. Because the dashboard is the only known consumer *today*, a deprecation is low-risk — but the prefix exists specifically so that deprecations remain low-risk when the consumer set grows. Any `/v1` endpoint that ships is a public commitment; shipping it in `/v1-rc` or `/internal` is the correct place for anything not yet stable.

### 7.2 OpenAPI specification

An OpenAPI 3.1 document is generated from the route definitions in the `api` Lambda (we use Python route decorators that carry the schema; the spec is emitted at build time, not request time). The spec is published as a static JSON file:

- `s3://agora-web/openapi/v1.json` → `https://agora.<domain>/openapi/v1.json` → served from CloudFront with `Cache-Control: public, max-age=3600`.
- The dashboard's `/metodik/api` page renders the spec with a lightweight HTML viewer (no Swagger UI bundle — a ~25 kB inline script is enough at this API size).
- The spec is regenerated in CI on every push and diffed in PRs; any accidental breaking change shows up as a red `cdk diff` step.

This replaces the existing implementation's hand-maintained `/docs` Swagger page; there is one source of truth (the route definitions) and one published artefact.

### 7.3 Reserved authorizer contract

A Lambda authorizer can be dropped in front of the HTTP API without touching the handlers. The authorizer must return a context object with these fields:

```json
{
  "principal_id":       "anon" | "ip#<ip>" | "key#<sha256-prefix>",
  "tier":               "free" | "hobby" | "press" | "enterprise",
  "rate_limit_rpm":     20,
  "monthly_quota":      1000,
  "key_owner_email":    "newsroom@dn.se",
  "scopes":             ["read:documents", "read:votes", "read:accountability"]
}
```

At MVP a trivial always-pass authorizer injects `{principal_id: "ip#...", tier: "free", ...}`, which keeps the single handler code path identical between free and paid flows.

### 7.4 Stable JSON contracts

A handful of contract rules that newspaper-scale consumers rely on and that are cheap to hold from day one:

- Every list response has the `{ items, next_cursor, fetched_at, source }` shape (§2.3).
- Every item carries a `source_url` pointing at the primary record.
- Every timestamp is RFC 3339 UTC. Every money figure is SEK (no MSEK, no mixed units).
- Every item with a textual identifier exposes it under its canonical Swedish name (`dok_id`, `intressent_id`, `votering_id`, `uo`, `anslag`, `rm`).
- Dates in paths are `YYYY-MM-DD`; years are four-digit integers; `rm` is the Swedish `2024/25` format as-is.
- Cursor tokens are opaque; consumers must not decode them.
- Errors follow RFC 7807 `application/problem+json` (§2.3).

### 7.5 Caching headers as a contract

The Cache-Control headers in §2.4 are a public-facing part of the API. A news-aggregator consumer that caches by `ETag` + `Last-Modified` pays effectively zero per-request cost. We hold `ETag` stable for every read and emit `Last-Modified: <latest _SUCCESS manifest timestamp>`.

### 7.6 Metering plumbing (no billing yet)

The `api` Lambda emits an EMF metric `ApiRequests` with dimensions `(route, tier)` on every invocation. At MVP `tier=free`; the dimension is still published. This gives us, for free:

- Per-route RPS graphs that already split free vs. paid traffic once a paid tier exists.
- A usage-report script that can reconstruct a per-customer bill from CloudWatch Logs without any code change, because the authorizer context already carried `principal_id` (which would be logged on every request in Phase 9).

### 7.7 What is **not** built at MVP

To be explicit about the deferred scope:

- No authorizer Lambda (only the no-op stub).
- No `api_keys` DynamoDB table.
- No Stripe integration.
- No `/pro` or `/v1/keys/request` routes.
- No developer self-serve signup page.
- No monthly usage-report emailing.

Each of these is a well-scoped piece of work, and none of them requires changes to the existing handler, Parquet layer, or DuckDB query path. That is the whole point of §§7.1–7.6.

### 7.8 Bulk data is a separate channel

The paid-tier API is about *curated*, *low-latency*, *SLA-backed* JSON. Bulk data — a full dump of votes or motions for an archival analysis — is published separately on a **requester-pays Parquet mirror** (`s3://agora-parquet-pub/`) where the consumer pays S3's GET/egress cost directly. The two channels don't compete: a newsroom pays for the API because they want live JSON on deadline; a research team uses requester-pays Parquet because they want to run a year-long backtest without shipping 50 GB through our bill.
