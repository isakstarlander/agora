# PR-06 — `transform` Lambda (raw → Parquet)

## Outcome

A Python 3.12 ARM64 container-image Lambda `transform` that subscribes to the `agora-raw-manifests` SNS topic, reads the manifest + parts from `s3://agora-raw/…`, and writes the canonical analytical Parquet tables to `s3://agora-parquet/…`. After this PR, the full base-table layer of `04-data-model.md` §2.1 is live: `members`, `documents`, `document_authors`, `votes`, `vote_results`, `speeches`, `budget_outcomes`, `manifestos`, `manifesto_statements`, `document_chunks`.

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 3 (transform); `04-data-model.md`; `05-ingestion.md` §7 (transform stage).

## Prerequisites

- PR-02 (buckets, SNS topic, Glue database).
- PR-03 (Riksdagen raw JSON in `agora-raw/riks/`).
- PR-04 (document text + authors JSON in `agora-raw/riks/`).
- PR-05 (Statskontoret CSV, Manifesto statements JSON in `agora-raw/…`).

## Context

**Design rules** (from `04-data-model.md` §1):

1. Primary keys are unchanged upstream ids (`dok_id`, `intressent_id`, `(party_code, election_year)`, `(year, anslag_code, budget_type)`).
2. Dates UTC; enums Swedish strings.
3. Every analytical table is a pure Parquet file, Hive-partitioned where noted.
4. A raw mirror always exists (we never delete from `agora-raw`).
5. Document bodies are **not Parquet columns** — they are individual S3 objects. The `documents` row holds `body_s3_key`, `body_sha256`, `body_bytes`.

**Consistency sentinel.** Each analytical prefix has a `_SUCCESS` file that lists the Parquet files in the latest committed write. DuckDB readers look at `_SUCCESS` first to guarantee read-after-write consistency (`06-storage-and-api.md` §1.2). The transform Lambda rewrites `_SUCCESS` atomically after all parts succeed.

**Idempotency.** Every run is driven by a specific `manifest.json` key. Reprocessing the same manifest yields byte-identical Parquet output (modulo file timestamps). Parts that overlap an existing partition **merge** with the existing Parquet rows, deduplicating by primary key. Concurrency across partitions is safe; within a partition we serialise using DynamoDB conditional writes on a lightweight `transform_locks` entry (we reuse `agora_ingestion_runs` with a `run_state=LOCKED` guard).

## Scope / Deliverables

### 1. Package layout

```
iac/lambda/transform/
  Dockerfile
  requirements.txt              # boto3, pyarrow, duckdb, pydantic, pandas
  src/
    handler.py                  # SNS message → route → mapper
    io/
      raw_reader.py             # gzip-aware S3 reader
      parquet_writer.py         # merge-into-partition + _SUCCESS writer
      lock.py                   # DynamoDB per-partition lock
    mapping/
      members.py
      documents.py
      document_authors.py
      votes.py
      vote_results.py
      speeches.py
      budget_outcomes.py
      manifestos.py
      manifesto_statements.py
      document_chunks.py
    schema/
      *.py                      # pyarrow schema per table (types, required/nullable)
```

Container is built via `DockerImageCode.fromImageAsset` with `Platform.LINUX_ARM64`. Memory: 2048 MB (for duckdb/arrow joining during merge). Timeout: 10 min. Ephemeral storage: 4 GB.

### 2. Handler routing

SNS messages arrive as JSON; extract the S3 event, extract the manifest key, and dispatch to the correct mapper:

| Key prefix | Mapper |
|---|---|
| `riks/dokumentlista/doktyp=…/ingested=…/manifest.json` | `documents.py` (and also triggers `fanout-doctext` state machine) |
| `riks/voteringlista/rm=…/ingested=…/manifest.json` | `votes.py` + `vote_results.py` |
| `riks/anforandelista/rm=…/ingested=…/manifest.json` | `speeches.py` |
| `riks/personlista/ingested=…/manifest.json` | `members.py` |
| `riks/alias-index/ingested=…/index.json.gz` (direct PUT — no manifest) | downstream triggers: see §4 |
| `statskontoret/arsutfall/year=…/ingested=…/manifest.json` | `budget_outcomes.py` |
| `manifesto/<party>/election=…/ingested=…/manifest.json` | `manifestos.py` + `manifesto_statements.py` |

Unknown keys → `WARN` log + silent success (so that SNS does not DLQ on something harmless).

### 3. `fanout-doctext` trigger

Replace the placeholder trigger left in PR-04. Specifically, when the `documents.py` mapper finishes, it invokes the `fanout-doctext` state machine with:

```json
{ "manifest_s3_key": "riks/dokumentlista/doktyp=<doktyp>/ingested=<slug>/manifest.json" }
```

so that the body-text fetch runs **after** the documents Parquet is written (the Parquet row has the expected `body_s3_key` value even if the body does not yet exist; the `fanout` fills it in and PR-12's embed reader reads directly from the S3 body without re-touching the Parquet row).

### 4. Mapping: Riksdagen

#### 4.1 `members.py`

Reads the `full.json.gz` from the manifest folder. Emits one row per MP with the columns in `04-data-model.md` §3. Full-refresh: overwrite `agora-parquet/members/part-0000.parquet`; update `_SUCCESS`.

#### 4.2 `documents.py`

Reads all `part-*.json.gz` pages. For each row:

- Build a `documents` record with keys from `04-data-model.md` §4. `body_s3_key = f"riks/document-text/{dok_id}.txt.gz"`; `body_sha256` and `body_bytes` are **null** here — the fanout fills them when the body is fetched. Mapper leaves them null.
- Compute the Hive partition `doktyp=<doktyp>/year=<year-of-datum>`.
- Merge into the existing partition (read existing Parquet, `UNION ALL` with the new rows, `QUALIFY ROW_NUMBER() OVER (PARTITION BY dok_id ORDER BY publicerad DESC) = 1` to dedupe in favour of the latest record).
- Rewrite the partition atomically: write to a temp key, `_SUCCESS` is re-issued after all affected partitions finish.

For `doktyp == "mot"`, the `document_authors` rows are populated by a **separate** pass (§4.3).

#### 4.3 `document_authors.py`

Triggered by a second SNS fan-out we subscribe to: `agora-raw-manifests` messages for `riks/alias-index/ingested=…/index.json.gz`. For each `dok_id` listed, fetch `riks/dokument-authors/<dok_id>.json.gz` if present and write the flattened `(dok_id, intressent_id, ordning, roll)` rows. Merge into `agora-parquet/document_authors/part-0000.parquet`, deduped by `(dok_id, intressent_id, ordning)`.

#### 4.4 `votes.py` + `vote_results.py`

Reads `voteringlista` pages. Emits:

- One `votes` row per voting point (`04-data-model.md` §6).
- Many `vote_results` rows per voting point (`04-data-model.md` §7), one per MP with `rost ∈ {Ja, Nej, Avstår, Frånvarande}`.

Partitioned `year=year(datum)` on both tables.

#### 4.5 `speeches.py`

Metadata only — `dok_id, dok_datum, anforande_id, intressent_id, parti, rubrik, anforandetyp, anforande_url_html`. Partitioned `year=year(dok_datum)`.

### 5. Mapping: Statskontoret

`budget_outcomes.py` reads the Swedish-locale CSV from the manifest folder (uses `raw_reader.py` with `pyarrow.csv.read_csv(..., parse_options=ParseOptions(delimiter=";"))`), normalises column names, converts decimals, and emits `budget_outcomes` rows with the columns in `04-data-model.md` §9. Partition `year=<year>`.

### 6. Mapping: Manifesto Project

`manifestos.py` reads `metadata.json.gz` and emits one `manifestos` row.

`manifesto_statements.py` reads `statements.json.gz` and emits one row per coded quasi-sentence with the Manifesto Project's CMP category codes and the original Swedish text. The `embedding` column is **null** in this PR — PR-12 fills it. Schema: `04-data-model.md` §11.

### 7. `document_chunks.py`

For every `documents` row that acquires a new `body_s3_key`, read the body text and chunk it into ≤800-token windows with 100-token overlap. Emit `document_chunks` rows:

| Column | Type | Notes |
|---|---|---|
| `chunk_pk` | STRING | Synthetic: `f"{dok_id}#{chunk_index:04d}"` |
| `dok_id` | STRING | FK → documents |
| `chunk_index` | INT | 0-based |
| `text` | STRING | ≤800 tokens |
| `char_offset_start` | INT | Position in the decompressed body |
| `char_offset_end` | INT |  |
| `created_at` | TIMESTAMP | UTC |

Partitioned `doktyp=<doktyp>`.

Emitting `document_chunks` here (in transform) avoids a second pass over the bodies in PR-12.

### 8. `_SUCCESS` handling

Every base-table prefix maintains a `_SUCCESS.json` file of the form:

```json
{
  "tables": {
    "documents/doktyp=mot/year=2025": {
      "latest_run_id": "01HXYZ…",
      "part_files": ["part-0000.parquet", "part-0001.parquet"],
      "row_count": 5831,
      "written_at": "2026-04-20T07:12:33Z"
    },
    ...
  }
}
```

Readers (the `api` Lambda in PR-08) load `_SUCCESS.json` first and use only the listed `part-*.parquet` files. This avoids the classic S3 list-while-writing race.

### 9. IAM

`AgoraTransformRole`:

- `s3:GetObject` on `agora-raw/*`; `s3:PutObject`/`GetObject`/`DeleteObject` on `agora-parquet/*`.
- `dynamodb:*Item` on `agora_ingest_cursors`, `agora_ingestion_runs`.
- `sns:Subscribe` on `agora-raw-manifests` (at stack-synth time only).
- `states:StartExecution` on the `fanout-doctext` state machine ARN.
- `lambda:InvokeFunction` on itself (used for self-triggering on oversized-partition fallbacks).
- `glue:*Partition`, `glue:*Table`, `glue:*Database` scoped to the `agora_parquet` catalog — to register / update table metadata as tables are created.

### 10. Glue catalog registration

After a mapper writes the first file for a table, register the table in Glue (`agora_parquet.<table>`) via `glue.CreateTable` if it does not exist. This is a side-effect of the mapper, not a separate step — keeps Athena instantly queryable.

### 11. SNS subscription

The stack adds `transform` as an SNS subscriber to `agora-raw-manifests` with message filters excluding `riks/dokumentlista` manifests? No — we want `documents.py` to handle them. **All manifests route to `transform`.** The topic is a fan-out; sibling subscribers like `fanout-doctext` see only the ones their filter allows. Here we set **no filter** — `transform` is the universal consumer.

A DLQ (`agora-transform-dlq` SQS queue) is attached with `maxReceiveCount=3`. Messages that fail three times go to the DLQ. An alarm (PR-11) watches DLQ depth > 0.

### 12. Tests

- Per-mapper unit test using committed fixtures:
  - `tests/fixtures/riks-documents-mot-2024.json.gz`
  - `tests/fixtures/statskontoret-2024.csv.gz`
  - `tests/fixtures/manifesto-S-2022.json.gz`
- Integration test: deploy to a sandbox account, invoke the Lambda with a synthetic SNS event pointing at a fixture key, assert `agora-parquet/<table>/.../part-*.parquet` exists and is readable via DuckDB.
- Property test: running the same manifest twice produces byte-identical Parquet (modulo statistics headers).

### 13. Deployment

Add to `AgoraDataStack`. Docker image builds on first `cdk deploy` (~2 min cold). Subsequent deploys are ~10 s if the `requirements.txt` hasn't changed.

## Manual steps

1. **Trigger the first transform run for each source** after PR-03 and PR-05 have populated `agora-raw`. Easiest path: the SNS topic already has messages from the ingest PRs, so the Lambda will naturally process them after deploy. If you want to force it:

   ```bash
   aws sns publish --profile agora-se --region eu-north-1 \
     --topic-arn <agora-raw-manifests-arn> \
     --message '{"Records":[{"s3":{"bucket":{"name":"agora-raw-<acct>"},"object":{"key":"riks/personlista/ingested=2026-04-20T03-00/manifest.json"}}}]}'
   ```

2. **Verify in Athena** that the base tables are visible under the `agora_parquet` database:

   ```sql
   SELECT COUNT(*) FROM agora_parquet.members;
   SELECT COUNT(*) FROM agora_parquet.documents;
   SELECT COUNT(*) FROM agora_parquet.budget_outcomes;
   ```

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` exits 0; `transform` Lambda + SNS subscription visible.
- [ ] After natural ingest flow has run for one full cycle, these Parquet prefixes exist and are non-empty:
  - `agora-parquet/members/`
  - `agora-parquet/documents/doktyp=mot/year=2025/`
  - `agora-parquet/document_authors/`
  - `agora-parquet/votes/year=2025/`
  - `agora-parquet/vote_results/year=2025/`
  - `agora-parquet/speeches/year=2025/`
  - `agora-parquet/budget_outcomes/year=2024/`
  - `agora-parquet/manifestos/`
  - `agora-parquet/manifesto_statements/`
  - `agora-parquet/document_chunks/doktyp=mot/`
- [ ] Each prefix contains a `_SUCCESS.json` listing the exact `part-*.parquet` files that readers should use.
- [ ] Athena query `SELECT parti, COUNT(*) FROM agora_parquet.vote_results WHERE year = 2025 GROUP BY 1 ORDER BY 2 DESC` runs in under 5 s and returns party-level tallies.
- [ ] Re-publishing an already-processed manifest produces **no new rows** (idempotent).
- [ ] Transform DLQ is empty.
- [ ] Per-mapper unit tests pass; integration test passes.

## Out of scope

- Derived tables (`party_cohesion`, `party_divergence`, etc.). PR-07.
- Embeddings for `document_chunks` and `manifesto_statements`. PR-12.
- Athena workgroup scoping or query-result location configuration — default workgroup is fine at this scale.
- Parquet compaction / small-file merging. The transform writes one file per partition per run; compaction (if ever needed) becomes a separate weekly Lambda.
