# 05 — Ingestion

This document describes how Riksdagen, Statskontoret, and Manifesto Project data become the Parquet tables of `04-data-model.md`. It is the only code surface that talks to an external service.

## 1. Shape of the pipeline

The pipeline has **three stages** and **three upstreams**. Every run is a Lambda; the state between stages is S3.

```
            ┌───── EventBridge ─────┐
            │                       │
            ▼                       ▼
  Lambda: fetch-riks         Lambda: fetch-esv        Lambda: fetch-man
  (Node 20, ARM64)           (Node 20, ARM64)         (Node 20, ARM64)
  daily  06:15 UTC           monthly, 1st 04:00       quarterly, 1st 05:00
  + Step Functions fanout
  for document-text fetch
            │                       │                         │
            ▼                       ▼                         ▼
                      s3://agora-raw/   (immutable JSON / XML / CSV / ZIP)
                                    │
                                    │ S3 ObjectCreated → manifest.json
                                    ▼
                       Lambda: transform
                       (Python 3.12, ARM64, container)
                       pyarrow + duckdb + boto3
                                    │
                                    ▼
                       s3://agora-parquet/   (canonical analytical tables)
                                    │
                                    │ SQS → debounced
                                    ▼
                       Lambda: derive
                       (same container image; DuckDB SQL)
                                    │
                                    ▼
                       s3://agora-parquet/   (derived tables, overwrite)
                                    │
                                    ▼
                       SQS → Lambda: embed-chunks  (scheduled weekly; Titan Embed v2)
                                    │
                                    ▼
                       s3://agora-parquet/document_embeddings/
```

The fetch Lambdas are the only components that speak HTTPS to external services. Nothing downstream does.

## 2. Schedules

EventBridge Scheduler schedules. Rates are a trade-off between freshness and upstream politeness; these are conservative defaults and can be adjusted in CDK.

| Schedule name | Cron (UTC) | Trigger | Purpose |
|---|---|---|---|
| `agora-ingest-riks-documents`  | `cron(15 6 * * ? *)`     | `fetch-riks-documents` | Daily incremental pull of `dokumentlista` across the six doctypes `mot, prop, bet, skr, ip, fr`. |
| `agora-ingest-riks-votes`      | `cron(30 6 * * ? *)`     | `fetch-riks-votes`     | Daily incremental pull of `voteringlista` for the current and prior `rm`. |
| `agora-ingest-riks-speeches`   | `cron(45 6 * * ? *)`     | `fetch-riks-speeches`  | Daily incremental pull of `anforandelista` metadata. |
| `agora-ingest-riks-members`    | `cron(0 3 * * ? *)`      | `fetch-riks-members`   | Nightly full refresh of `personlista`. |
| `agora-ingest-riks-doctext`    | *on S3 event*            | Step Functions `fanout-doctext` | Fetch full text of each new document. Triggered by transform when it sees unresolved `body_s3_key` rows. |
| `agora-ingest-esv`             | `cron(0 4 1 * ? *)`      | `fetch-esv`            | Monthly check for a newer Statskontoret årsutfall file. |
| `agora-ingest-manifesto`       | `cron(0 5 1 */3 ? *)`    | `fetch-manifesto`      | Quarterly check for a newer Manifesto Project corpus version. |
| `agora-embed-chunks`           | `cron(0 2 ? * SUN *)`    | `embed-chunks`         | Weekly re-embedding of any `document_chunks` rows without a corresponding `document_embeddings` row. |
| `agora-ingest-full-refresh`    | `cron(0 4 ? * SUN *)`    | `rebuild` (flagged)    | Sunday 04:00 UTC weekly integrity sweep — re-fetches the last 90 days of Riksdagen to heal any gaps. |

All times are UTC. Stockholm business hours are roughly 07:00–17:00 UTC+1/+2, so the 06:15 local-Stockholm morning schedule runs before the day's first parliamentary session is published.

Cadence rationale (vs. the implementation's *three-times-daily* document pull): daily is sufficient because the Riksdag does not publish into the open-data feed during evening/night hours; the extra two runs in the existing implementation caught no new documents in >90% of runs during the period we reviewed. Cutting to daily reduces Lambda invocations without any user-visible lag.

## 3. Raw storage — `s3://agora-raw/`

Layout:

```
agora-raw/
  riks/
    dokumentlista/
      doktyp=mot/
        ingested=2026-04-20T06-15/
          page-001.json.gz
          page-002.json.gz
          manifest.json
      doktyp=prop/...
      doktyp=bet/...
      doktyp=skr/...
      doktyp=ip/...
      doktyp=fr/...
    voteringlista/
      rm=2024-25/
        ingested=2026-04-20T06-30/
          part-001.json.gz
          manifest.json
    anforandelista/
      rm=2024-25/
        ingested=2026-04-20T06-45/
          part-001.json.gz
          manifest.json
    personlista/
      ingested=2026-04-20T03-00/
        full.json.gz
        manifest.json
    dokument-detail/
      doktyp=mot/
        dok_id=HB02MOT1234/
          fetched=2026-04-20T06-20/
            detail.json.gz        # Per-document metadata incl. authors
            body.txt.gz           # Full text, if available
            manifest.json
  esv/
    year=2024/
      ingested=2026-05-01T04-00/
        arsutfall-1997-2024.zip
        manifest.json
  manifesto/
    version=2025-1/
      ingested=2026-04-01T05-00/
        S_202209.json.gz
        M_202209.json.gz
        ...
        manifest.json
  doc-text/                      # Re-indexed pointer view, read by the API
    HB02MOT1234.txt.gz           # Symlinked (via S3 copy) from dokument-detail/…/body.txt.gz
    HB02PROP45.txt.gz
    ...
```

Rules:

- Objects are **immutable**. Never rewritten, never deleted except by a lifecycle rule that ages them out after 3 years. This is our disaster-recovery spine.
- All payloads are gzipped; each run's partition is self-contained so a partial failure does not poison subsequent runs.
- A `manifest.json` is the commit marker for a run. Downstream `ObjectCreated` events listen only on `manifest.json` keys.
- S3 Object Lock is **not** enabled (overkill for this use case), but a bucket policy denies `s3:DeleteObject` to all principals other than the `AgoraLifecycleRole`.
- `doc-text/` is a flat alias namespace for O(1) lookup by `dok_id`. It is populated by the document-detail fanout (section 6); deleting a key there does not delete the source body in `dokument-detail/`.

## 4. Fetch Lambdas — Riksdagen

Runtime: Node 20, ARM64. ~15 MB bundle (`undici` + `pino` + zlib built-ins). One small Lambda per stream; they share a common helper module for pagination, backoff, and cursor I/O.

### 4.1 `fetch-riks-documents`

Responsibilities:

1. For each doctype in `['mot', 'prop', 'bet', 'skr', 'ip', 'fr']`:
   1. Read the cursor from DynamoDB (`ingest_cursors`, PK = `"riks#dokumentlista#{doktyp}"`).
   2. Page `GET /dokumentlista/?typ={doktyp}&sz=100&p=1&sort=datum&sortorder=desc&utformat=json` following `@nasta_sida` until either (a) a document whose `publicerad ≤ cursor` is encountered, or (b) the page is empty.
   3. Write each page to `s3://agora-raw/riks/dokumentlista/doktyp={doktyp}/ingested=…/page-NNN.json.gz`.
   4. For every **new** `mot` row discovered, enqueue a document-detail task on the `fanout-doctext` Step Functions state machine (section 6). (Proposition / betänkande etc. detail fetches are enqueued the same way; only `mot` triggers the authors-table write.)
   5. Write a `manifest.json` listing pages, new doc count, and max-seen `publicerad`.
   6. Update the cursor.
2. Wall-clock cap: 13 minutes per Lambda invocation (2-minute safety margin on the 15-minute limit). If the backlog is larger, the invocation exits cleanly and the next scheduled run resumes.

Idempotency: if the same run is retried (Lambda may retry on error), the `ingested=<timestamp>` partition key is the invocation start time, so a retry simply writes to a new partition. Duplicate pages downstream are de-duplicated by `dok_id` in transform.

Politeness: 200 ms delay between Riksdagen requests; explicit `User-Agent` header (see `03-data-sources.md` §7); conditional GETs where the upstream supports them.

### 4.2 `fetch-riks-votes`

Same pattern against `/voteringlista/?rm={rm}&gruppering=iid&utformat=json`. Fetches the current `rm` on every run and the previous `rm` on Sundays (for late-posted votes). Writes per-rm partitions.

### 4.3 `fetch-riks-speeches`

Same pattern against `/anforandelista/?rm={rm}&utformat=json`. Persists metadata only; `anforandetext` is discarded before write (see `03-data-sources.md` §2.5).

### 4.4 `fetch-riks-members`

Full refresh of `/personlista/?utformat=json`. The membership list is small (~350 sitting + historical); diffing is not worth the code.

## 5. Fetch Lambdas — Statskontoret and Manifesto

### 5.1 `fetch-esv`

Monthly Lambda. Probes `https://www.statskontoret.se/OpenDataArsUtfallPage/GetFile?...&Year=<y>&status=Definitiv` for `y = currentYear - 1`, then `-2`, then `-3` (the newest *definitiv* file is usually ~6 months behind year-end). Downloads the first that returns HTTP 200 with content-length > 1 KB. Writes the ZIP to `s3://agora-raw/esv/year={fileYear}/ingested=…/`.

If the file hash matches the previous month's, the Lambda writes only an empty `manifest.json` to indicate "checked, nothing new", and transform is not triggered.

### 5.2 `fetch-manifesto`

Quarterly Lambda. Calls `GET /list_metadata_versions` to get the latest corpus version. If newer than the previous run's, iterates the 8 × 4 party/election matrix and fetches `GET /texts_and_annotations?api_key=...&keys[]={party}_{yyyy}09&version={ver}` for each combination. 1,500 ms sleep between calls (the WZB API is small-team-operated).

API key is pulled from Secrets Manager (`AGORA_MANIFESTO_API_KEY`). The Lambda's execution role has `secretsmanager:GetSecretValue` scoped to exactly that secret ARN.

## 6. Document-text fanout (Step Functions)

### 6.1 Why Step Functions

Fetching the full text of every new `mot` serially, at 200 ms per request, scales linearly with documents discovered per day. The existing implementation's sequential loop takes ~1.1 s per document against `data.riksdagen.se`; on a heavy motion-submission day (~400 motions early in a riksmöte) that's 7+ minutes serial inside one Lambda — too close to the 15-minute hard limit to ignore.

Step Functions gives us:

- **Fan-out** via a Map state with `MaxConcurrency = 10` (throttled to respect upstream).
- **Per-item error handling** so a single 404 or timeout does not fail the batch.
- **Automatic retry** with exponential backoff.
- **Pennies cost** — pay-per-transition, under $0.01/month at Agora's document rate.

### 6.2 State machine

```
 fanout-doctext
 ├── ListNewDocs (Lambda: list_new_docs.py)           ← reads manifest.json to discover ids
 ├── Map (MaxConcurrency=10)
 │    ├── FetchDetail (Lambda: fetch_detail.ts)       ← GET /dokument/{dok_id}?utformat=json
 │    ├── FetchBody (Lambda: fetch_body.ts)           ← GET /dokument/{dok_id}.text, gzip to S3
 │    └── WriteAuthors (Lambda: write_authors.py)     ← mot only; updates s3://agora-raw/dokument-detail/…/authors.json.gz
 └── WriteAliasIndex (Lambda: write_alias_index.py)   ← re-points s3://agora-raw/doc-text/{dok_id}.txt.gz → latest body
```

Trigger: the documents-transform Lambda emits an `execute-state-machine` call whenever it processes a manifest that contains `mot` rows without a `body_s3_key`.

### 6.3 Concurrency guardrail

`MaxConcurrency = 10` against Riksdagen is conservative; we can bump to 20 if long-tail latency ever becomes a problem. Above that we risk 429s from the open-data service (rare but observed in the existing implementation's logs).

## 7. Transform Lambda

Runtime: Python 3.12, ARM64. Packaged via Lambda container image (~220 MB) including `pyarrow`, `duckdb`, `boto3`, `pyiceberg` is **not** included.

Triggered by S3 `ObjectCreated` events on any `agora-raw/**/manifest.json` (NOT on individual pages — the manifest is the "commit" marker).

Pseudocode:

```python
def handler(event, context):
    manifest_key = parse_manifest_key(event)
    kind = kind_of(manifest_key)    # e.g. "riks.dokumentlista", "esv", "manifesto", …
    df = load_manifest(manifest_key)
    match kind:
        case "riks.dokumentlista":
            upsert_documents(df)
            if df.has_mot_rows_needing_body():
                start_fanout_doctext(df.ids)
        case "riks.voteringlista":
            upsert_votes(df)
            upsert_vote_results(df)
        case "riks.anforandelista":
            upsert_speeches(df)
        case "riks.personlista":
            replace_members(df)
        case "riks.dokument-detail":
            upsert_document_body_ref(df)
            upsert_document_authors(df)
        case "esv":
            upsert_budget_outcomes(df)
        case "manifesto":
            upsert_manifestos(df)
            upsert_manifesto_statements(df)
    enqueue_derive(kind)
```

"Upsert" on Parquet: rewrite the affected partition. For `documents` the partition is `(doktyp, year(datum))`; for `votes` and `vote_results` it is `year(datum)`; for `budget_outcomes` it is `year`. A partition is read, merged with incoming rows (keyed on PK), sorted by `datum` (or `year` for budget), and written back atomically under a new key, then the directory listing updated (by overwriting the `_SUCCESS` marker S3 object that tells DuckDB which file to read). Old Parquet is retained by an S3 lifecycle rule for 30 days so a rollback is `aws s3 cp` between versions.

Memory sizing: the biggest partition is a single `rm` of `vote_results`, ~2 M rows of ~10 narrow columns. PyArrow RSS stays under 900 MB. Lambda at 1,024 MB is sufficient and cheap; we provision 1,536 MB to allow a small headroom.

## 8. Derive Lambda

Same container image as transform. Triggered after any successful transform run (via an SQS queue that transform writes into; SQS `MaximumBatchingWindowInSeconds = 60` debounces multi-transform bursts into one derive run).

Derivations are expressed as DuckDB SQL strings in version-controlled files. Example for `party_cohesion`:

```sql
CREATE OR REPLACE TABLE party_cohesion AS
WITH ranked AS (
  SELECT
    rm, beteckning, punkt, parti, rost,
    COUNT(*) OVER (PARTITION BY rm, beteckning, punkt, parti) AS party_voters,
    COUNT(*) OVER (PARTITION BY rm, beteckning, punkt, parti, rost) AS this_rost_voters
  FROM vote_results
  WHERE rost <> 'Frånvarande'
),
modal AS (
  SELECT rm, beteckning, punkt, parti,
         FIRST(rost ORDER BY this_rost_voters DESC) AS modal_rost
  FROM ranked
  GROUP BY ALL
)
SELECT r.rm, r.parti, r.beteckning, r.punkt,
       m.modal_rost,
       100.0 * SUM(CASE WHEN r.rost = m.modal_rost THEN 1 ELSE 0 END)
             / NULLIF(COUNT(*), 0) AS cohesion_pct
FROM ranked r
JOIN modal m USING (rm, beteckning, punkt, parti)
GROUP BY ALL;
```

The SQL file lives in `iac/lambda/derive/sql/party_cohesion.sql` and is the canonical source-of-truth for the metric's definition. That file is what a journalist can read when they ask "how do you compute cohesion?".

All derived tables in `04-data-model.md` §12–§21 are expressed as similarly-shaped SQL files. A derive run executes them in topological order (`document_chunks` before `document_embeddings` is the embed-chunks Lambda's job, not derive's).

## 9. Embed Lambda

Runtime: Python 3.12, ARM64. Triggered weekly (`agora-embed-chunks`), and also on SQS from transform when a new `mot`/`prop`/`bet` chunk set is produced.

1. `SELECT dok_id, chunk_index, text FROM document_chunks LEFT JOIN document_embeddings USING (dok_id, chunk_index) WHERE embedding IS NULL LIMIT 256` (DuckDB over Parquet).
2. Batch-call Bedrock Titan Embed v2 (`amazon.titan-embed-text-v2:0`), 25 texts per request, 1024 dims.
3. Append to `document_embeddings` as a new Parquet file in the partition; rewrite `_SUCCESS` marker.

A cold rebuild of the whole embedding corpus is ~50k chunks × ~$0.00002/chunk ≈ $1. Daily steady-state cost is a few cents.

## 10. Rebuilds

A full rebuild is supported by design. The command is literally:

```bash
npx cdk deploy AgoraDataStack -c rebuild=true
```

The `rebuild=true` context flag deploys a one-off Step Functions state machine that:

1. Lists every `manifest.json` in `s3://agora-raw/`.
2. Emits one SQS message per manifest.
3. The transform Lambda processes them in parallel (reserved concurrency capped at 5 to avoid thundering herd on S3 LIST and DuckDB memory).
4. Derive runs once at the end.
5. Embed runs once at the end over any remaining unembedded chunks.

Wall-clock for a full rebuild from 5 years of history: ~15–25 minutes. Cost: a few dollars (dominated by Titan Embed if the embeddings are also being rebuilt).

## 11. Observability per run

Each Lambda emits a single structured log line per invocation:

```json
{
  "event": "ingest.fetch.done",
  "source": "riks",
  "stream": "dokumentlista",
  "doktyp": "mot",
  "pages": 17,
  "new_docs": 42,
  "api_ms": 8123,
  "lambda_ms": 9812,
  "cursor_before": "2026-04-19T18:05:00",
  "cursor_after":  "2026-04-20T06:12:44",
  "run_id": "d1c92e…"
}
```

In parallel, every run writes a row to the DynamoDB `ingestion_runs` table (see `04-data-model.md` §23) so that a single query answers "did last night's ingestion succeed?" without pawing through logs.

CloudWatch Logs Insights queries are bundled in `09-observability-and-security.md`.

## 12. Failure modes

| Failure | Symptom | Response |
|---|---|---|
| Riksdagen 5xx | Fetch Lambda retries 3× with jitter; on final failure emits a CloudWatch metric and alarms | Rerun is automatic on next schedule |
| Riksdagen schema drift | Transform throws on unknown required field | Pyarrow `strict=False` lets minor additive changes pass; required-field breakage alarms loudly |
| Manifesto Project 404 for a (party, year) combo | Known (not every party ran every cycle under the same id) | Treated as empty, logged, not alarmed |
| Manifesto Project 401 (expired key) | `fetch-manifesto` fails closed | Alarm; rotate key in Secrets Manager |
| Statskontoret URL pattern changes | `fetch-esv` alarms on "no file found in probe range" | Update `03-data-sources.md` §3 and the probe logic in one place |
| Lambda OOM during transform | Partition too large | Bump memory; if recurrent, split partition by month |
| Clock skew / duplicate ingestion | Same page written twice | Transform de-dupes on PK |
| DuckDB upgrade breaks SQL | Derive fails | DuckDB version is pinned in the container image |
| Step Functions Map state throttled by Lambda quota | Fanout slows | Map MaxConcurrency is 10; raise regional Lambda concurrency quota if required |
| Riksdagen 429 (rate-limit) | Fanout bodies fail with 429 | State machine catches, waits 60 s, retries |

## 13. What ingestion deliberately does not do

- It does **not** compute summaries at ingest time. Summaries are a lazy-cached product of user requests (see `08-llm-layer.md`).
- It does **not** call Bedrock from a fetch Lambda. The only outbound services the fetch Lambdas call are `data.riksdagen.se`, `statskontoret.se`, and `manifesto-project.wzb.eu`.
- It does **not** talk to a relational database. There is no RDBMS in Agora. Parquet on S3 and DynamoDB *are* the storage.
