# PR-08 — `AgoraApiStack` read API

## Outcome

`AgoraApiStack` deployed with an API Gateway HTTP API and a single Python 3.12 ARM64 container-image Lambda `api` that serves every synchronous read route of `/v1`. Responses are JSON, paginated, and carry a `source_url` on every item. The `api` Lambda reads Parquet from S3 via DuckDB's `httpfs` extension and DynamoDB for caches.

## Roadmap anchor

`11-roadmap.md` — Phase 2 (read API, ½ week); `06-storage-and-api.md` §§1–2, §5 (forward-compatible shapes).

## Prerequisites

- PR-06 (base Parquet) and PR-07 (derived Parquet) complete; `agora-parquet` contains data.
- PR-02's DynamoDB tables exist.

## Context

Three Lambdas back the API over the project's lifetime:

- **`api`** — synchronous reads (this PR).
- **`llm-read`** — `POST /v1/summarise`, `POST /v1/search` (PR-13).
- **`enqueue-accountability`** — `POST /v1/accountability` (PR-14).

This PR provisions only the `api` Lambda and wires the non-LLM routes. The other two Lambdas are added in later PRs; the API Gateway routes that target them return `501 Not Implemented` with a `Retry-After: 1209600` header (14 days — long enough that a crawler does not hammer us while we build) and a body explaining *"this endpoint ships in a later phase"*. This placeholder is deliberate: the **URL space is stable from day one**.

### Response contract (`06-storage-and-api.md` §2.3)

Every successful collection response:

```json
{
  "items": [ ... ],
  "next_cursor": "opaque-string-or-null",
  "fetched_at": "2026-04-20T12:00:00Z",
  "source": "https://data.riksdagen.se/…"
}
```

Every error response (RFC 7807 `application/problem+json`):

```json
{
  "type":   "https://agora.invalid/errors/not-found",
  "title":  "Dokument saknas",
  "status": 404,
  "detail": "Dok_id HB02MOT9999 finns inte i agoras index.",
  "instance": "/v1/documents/HB02MOT9999"
}
```

Every item includes a `source_url` pointing to the upstream primary source.

### Route list (read half)

| Method + path | Cache TTL | Purpose |
|---|---|---|
| `GET /v1/health` | 0 | `{status:"ok", parquet_ok:bool, ddb_ok:bool}` |
| `GET /v1/members` | 24 h | List MPs. Filters `?rm=`, `?parti=`, `?q=` |
| `GET /v1/members/{intressent_id}` | 6 h | MP detail |
| `GET /v1/members/{intressent_id}/attendance` | 6 h | Monthly attendance rows |
| `GET /v1/members/{intressent_id}/speeches` | 6 h | Speech counts & chars |
| `GET /v1/documents` | 5 min | Paginated docs. Filters `?doktyp=`, `?rm=`, `?parti=`, `?utskott=`, `?q=`, `?from=`, `?to=` |
| `GET /v1/documents/{dok_id}` | 1 h | Detail; includes cached summary if present |
| `GET /v1/documents/{dok_id}/authors` | 24 h | Motion authorship |
| `GET /v1/votes` | 5 min | Paginated vote points |
| `GET /v1/votes/{votering_id}` | 1 h | Per-MP vote list |
| `GET /v1/party-cohesion` | 1 h | Cohesion series |
| `GET /v1/party-divergence` | 1 h | Divergence matrix |
| `GET /v1/motion-throughput` | 1 h | Counts by committee |
| `GET /v1/budget` | 12 h | Budget outcomes |
| `GET /v1/budget/areas` | 24 h | List of expenditure areas |
| `GET /v1/manifestos` | 24 h | Manifestos by party/election |
| `GET /v1/manifestos/{party_code}/{election_year}` | 24 h | Statements for one manifesto |
| `GET /v1/accountability/jobs/{job_id}` | 0 | Poll accountability job — lives on `api` even though enqueue + worker are PR-14 |
| `GET /v1/openapi.json` | 24 h | OpenAPI 3.1 spec generated from route decorators |
| `POST /v1/summarise` | n/a | Returns 501 until PR-13 |
| `POST /v1/search` | n/a | Returns 501 until PR-13 |
| `POST /v1/accountability` | n/a | Returns 501 until PR-14 |

### Forward-compatibility invariants

Designed so that Phase 9 (commercial tier) ships as a CDK config change (`-c agora:apiTiers=on`) rather than a handler rewrite:

- Every response header set includes `X-Tier: free` and `X-RateLimit-Remaining: <n>`. Both are no-ops at MVP; paid tiers simply overwrite them.
- Lambda authorizer **is not attached** at MVP. The CDK construct exposes a no-op `AuthorizerConfig` object; flipping `apiTiers=on` attaches a Lambda authorizer (PR-17) without touching handlers.
- `principal_id` and `tier` fields are set on every structured log line. At MVP both are `ip#...` and `free` respectively.
- Rate-limit handling reads from DynamoDB `agora_ratelimit_counter`. The principal key is the `/24`-masked IP; Phase 9 swaps it for `k#<key_hash>` (from the authorizer context) with no handler changes.

## Scope / Deliverables

### 1. Package layout

```
iac/lambda/api/
  Dockerfile
  requirements.txt          # duckdb, boto3, pyarrow, fastapi OR flask, aws-lambda-powertools, pydantic
  src/
    handler.py              # Lambda entry; uses powertools' APIGatewayHttpResolver
    duck.py                 # DuckDB bootstrap per 06-storage-and-api.md §1.3
    cache_headers.py        # route → Cache-Control mapping
    ratelimit.py            # per-principal token bucket in agora_ratelimit_counter
    pagination.py           # opaque cursor encoder/decoder (base64url of (table, last_key, filters_hash))
    openapi.py              # OpenAPI 3.1 spec generated from route registrations
    routes/
      health.py
      members.py
      documents.py
      votes.py
      cohesion.py
      divergence.py
      motion_throughput.py
      budget.py
      manifestos.py
      accountability_poll.py   # GET /v1/accountability/jobs/{id} — reads agora_accountability_jobs
      stubs.py                 # POST endpoints returning 501 until PR-13/14
```

Use `aws-lambda-powertools` for the resolver, logging, metrics, and tracing shortcuts. Memory: 1024 MB. Timeout: 30 s (matches API Gateway's max). Ephemeral: 1 GB.

### 2. DuckDB bootstrap (`duck.py`)

Verbatim from `06-storage-and-api.md` §1.3 — creates views over `s3://agora-parquet/<table>/…/part-*.parquet` (the views list the `_SUCCESS.json`-approved files only — helper function `list_part_files(table, partition)` consults the sentinel). Installs `httpfs` and `fts` extensions on cold start; cached for subsequent requests within a warm container.

FTS indexes are created lazily on first `GET /v1/documents?q=…`:

```python
con.execute("PRAGMA create_fts_index('documents', 'dok_id', 'titel', 'undertitel', stemmer='swedish');")
```

Holding the FTS index is a ~200 ms warm-start penalty; on subsequent requests it's <10 ms. Do not build chunk-level FTS here — that belongs to the search Lambda in PR-13.

### 3. Route handlers

Each route file exports one or more `@app.get(...)` decorated handlers using `APIGatewayHttpResolver`. Representative handler:

```python
@app.get("/v1/party-cohesion")
def party_cohesion():
    parti = app.current_event.get_query_string_value("parti")
    rm    = app.current_event.get_query_string_value("rm") or current_rm()
    rows = con.execute("""
        SELECT rm, parti, beteckning, punkt, cohesion, n, n_ja, n_nej, n_avstar
          FROM party_cohesion
         WHERE rm = ?
           AND (? IS NULL OR parti = ?)
         ORDER BY rm, parti
    """, [rm, parti, parti]).fetchdf().to_dict(orient="records")
    return envelope(rows, source="https://data.riksdagen.se/voteringlista/")
```

Consistent envelope helper wraps `items`, `next_cursor`, `fetched_at`, and `source`.

### 4. Pagination

- Cursor is opaque: base64url-encoded JSON of `{"table": "...", "last_key": "...", "filters_hash": "sha256:..."}`.
- `filters_hash` binds the cursor to the current query-string — a client can't swap filters mid-pagination.
- Default `limit=50`, max `limit=200`.
- `next_cursor` is `null` when no more pages.

### 5. Cache headers

Each route's handler sets `Cache-Control: public, max-age=<n>, s-maxage=<n>` per the TTL table. No `Set-Cookie` anywhere. `Vary: Accept-Language`.

### 6. Rate limiting

`ratelimit.py` implements a per-principal rolling-window token bucket using `agora_ratelimit_counter`. At MVP:

- Principal = `ip#<cidr-24-masked>`.
- Limit = `20 req/min` for GETs, `2 req/min` for POST (the few POSTs in this PR all return 501 — the limit still applies).
- Exceeded → 429 with `Retry-After` and the standard error envelope.

WAF (PR-10) provides the outer rate layer; this Lambda-level one is a second line and is also the one that Phase 9 upgrades to per-key throttling.

### 7. API Gateway HTTP API (CDK)

In `iac/lib/api-stack.ts`:

- `apigwv2.HttpApi` with `corsPreflight = { allowOrigins: [<web-origin-from-web-stack>, "*"], allowMethods: ["GET","POST","OPTIONS"], allowHeaders: ["Content-Type","Authorization"], allowCredentials: false, maxAge: Duration.minutes(10) }`.

  At MVP the web origin isn't deployed yet; use `*` and tighten in PR-10 via a cross-stack import.

- One `HttpLambdaIntegration` pointing at `apiLambda`.
- Routes: every path in the table above, with `methods: [HttpMethod.GET]` or `POST`.
- Stage `$default` with auto-deploy.
- No authorizer (reserved hook documented in `06-storage-and-api.md` §7.3).
- Log format: JSON, fields `(requestId, requestTime, routeKey, status, responseLatency, integrationLatency, userAgent, ip)`, sent to CloudWatch log group `/aws/apigw/agora` with 30-day retention.

Export the API endpoint URL as `CfnOutput("ApiEndpoint")`.

### 8. OpenAPI generation

`openapi.py` introspects the route registrations and emits an OpenAPI 3.1 document. Build-time step in CDK:

- A CDK `CustomResource` runs `python -m agora_api.openapi > build/openapi/v1.json` during synth.
- The resulting file is uploaded to the `agora-web` bucket at `openapi/v1.json` via `BucketDeployment` (which PR-10 configures).
- Route `GET /v1/openapi.json` **redirects** 302 to the static file — no dynamic generation at request time.

### 9. IAM

`AgoraApiRole`:

- `s3:GetObject` on `agora-parquet/*` and `agora-raw/riks/document-text/*` (for body reads during `GET /v1/documents/{id}` full-body return).
- `dynamodb:GetItem`, `PutItem` on `agora_ratelimit_counter`; `GetItem` on `agora_summary_cache`, `agora_accountability_jobs`, `agora_accountability_cache`.
- Base Lambda policy.
- **No Bedrock** (the `api` Lambda does not call Bedrock; the LLM Lambdas do).

### 10. Logs & metrics

Structured logs with `service=agora-api`, `principal_id`, `tier`, `route`, `duration_ms`, `ddb_ms`, `duck_ms`. EMF metrics: `ApiRequests` (dimensioned on `route, tier`), `ApiLatencyMs`, `ApiErrors5xx`, `ApiPrincipalThrottles`.

### 11. Keep-warm schedule

`EventBridge` rule every 10 minutes during Europe/Stockholm daylight (06:00–22:00 CET/CEST) hits `GET /v1/health` from a lightweight Node Lambda. Cost: <$0.05 / mo. Purpose: keep the `api` Lambda warm so cold-start on the FTS index (~1 s) doesn't hit the first real user of the day.

### 12. Tests

- Per-route unit tests using `moto` for DynamoDB and a fixture Parquet set in `/tmp` for DuckDB (DuckDB reads local files the same as it reads S3 via `httpfs`).
- Integration: invoke the deployed API with `curl`; assert JSON shapes match the envelope contract.
- Schemathesis / `schemathesis run https://<endpoint>/v1/openapi.json` to fuzz the endpoints once per PR-08 deploy (CI job).

## Manual steps

None. All configuration is CDK-driven.

## Acceptance criteria

- [ ] `cdk deploy AgoraApiStack` exits 0.
- [ ] `curl https://<api-endpoint>/v1/health` returns 200 with `{"status":"ok","parquet_ok":true,"ddb_ok":true}` within 1 s warm, 3 s cold.
- [ ] `curl https://<api-endpoint>/v1/party-cohesion?rm=2024/25` returns JSON with at least 8 rows (one per sitting party) in under 1 s warm.
- [ ] `curl https://<api-endpoint>/v1/documents?doktyp=mot&q=barnomsorg` returns a list with ≥1 item and all items include a `source_url`.
- [ ] `curl -X POST https://<api-endpoint>/v1/summarise` returns 501 with a Problem+JSON body and `Retry-After: 1209600`.
- [ ] `curl https://<api-endpoint>/v1/openapi.json` returns a redirect or JSON. The returned OpenAPI document validates against the OpenAPI 3.1 meta-schema.
- [ ] Firing >20 GETs/minute from one IP triggers a 429 with `Retry-After`.
- [ ] Every route's response includes `X-Tier: free` and `Cache-Control` headers.
- [ ] CloudWatch metric `ApiRequests` shows data points with `tier=free` dimension.

## Out of scope

- CloudFront (PR-10). At the end of this PR the API is reachable via its raw `execute-api` URL; PR-10 puts CloudFront in front.
- LLM routes (`/v1/summarise`, `/v1/search`, `POST /v1/accountability`) — they return 501 until PR-13 / PR-14.
- API-key authorizer / usage plan / paid tier — deferred to PR-17.
- Full-body text of `GET /v1/documents/{dok_id}`: it **links** to the body via `body_url` pointing at the pre-signed S3 URL or at Riksdagen's own URL. Returning the body inline is a client-side choice we do not make at MVP.
