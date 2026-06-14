# 04 — Data model

This document defines the canonical schema Agora works with internally. All ingestion output, all API responses, and all dashboard queries speak this schema. If a field is not here, it does not exist in the product.

The schema preserves the shape of the existing implementation's twelve Postgres migrations (see `12-implementation-review.md` §B) but is re-expressed in our post-Supabase substrate: analytical tables are Parquet files on S3 read by DuckDB; mutable state is DynamoDB on-demand; raw payloads are immutable S3 objects. No hosted Postgres.

## 1. Design rules

1. **Primary keys are the upstream ids we pass through unchanged.** `dok_id` from Riksdagen, `intressent_id` for members, `(party_code, election_year)` for manifestos, `(year, anslag_code, budget_type)` for budget outturns. No synthetic ids, no renumbering. This keeps our data joinable back to the source.
2. **Dates are `DATE` or `TIMESTAMP`** stored in UTC, rendered in Europe/Stockholm in the UI.
3. **Enums are stored as Swedish strings** (`Ja`, `Nej`, `Avstår`, `Frånvarande`, `mot`, `prop`, etc.) because that is what the source emits and what the UI displays.
4. **Every analytical table is a pure Parquet file** (or a partitioned set of them) under `s3://agora-parquet/`. No Iceberg, no Delta, no Hudi — the data volume does not justify it.
5. **Partitioning is by date / doctype** where it helps prune scans; see each table for specifics.
6. **A *raw* mirror always exists.** Every ingested Riksdagen / Statskontoret / Manifesto Project response lives in `s3://agora-raw/` forever so that a full rebuild is always possible.
7. **Mutable state lives in DynamoDB**, not in Parquet. Anything that is written-by-read (caches, cursors, job records) is in DynamoDB. Anything that is derived-from-raw is in Parquet.
8. **Document bodies are not Parquet columns.** Each full document text is an individual gzipped S3 object under `s3://agora-raw/doc-text/{dok_id}.txt.gz`. This avoids column-scan costs on multi-MB text blobs and lets the API fan out reads to S3 in parallel when summarising.

## 2. Overview

### 2.1 Analytical tables (Parquet on S3)

| # | Table | Kind | Grain | Partitioned by |
|---|---|---|---|---|
| 3  | `members`                | base    | one row per MP                                    | none |
| 4  | `documents`              | base    | one row per document                              | `doktyp`, `year(datum)` |
| 5  | `document_authors`       | base    | one row per (dok_id, intressent_id) on motions    | none |
| 6  | `votes`                  | base    | one row per voting point (vote event)             | `year(datum)` |
| 7  | `vote_results`           | base    | one row per MP per voting point                   | `year(datum)` |
| 8  | `speeches`               | base    | one row per chamber speech (metadata only)        | `year(dok_datum)` |
| 9  | `budget_outcomes`        | base    | one row per `(year, anslag, budget_type)`         | `year` |
| 10 | `manifestos`             | base    | one row per `(party_code, election_year)`         | none |
| 11 | `manifesto_statements`   | base    | one row per coded quasi-sentence                  | none |
| 12 | `document_chunks`        | derived | one row per 800-token chunk of a document's body  | `doktyp` |
| 13 | `document_embeddings`    | derived | one row per `(dok_id, chunk_index)`, 1024-dim vec | none |
| 14 | `votes_wide`             | derived | one row per `(votering_id, intressent_id)`        | `year(datum)` |
| 15 | `party_cohesion`         | derived | per `(rm, parti, beteckning, punkt)`              | none |
| 16 | `party_divergence`       | derived | per `(rm, parti_a, parti_b)`                      | none |
| 17 | `attendance_monthly`     | derived | per `(intressent_id, year, month)`                | none |
| 18 | `motion_throughput`      | derived | per `(rm, utskott)`                               | none |
| 19 | `speech_monthly`         | derived | per `(intressent_id, year, month)`                | none |
| 20 | `budget_by_area`         | derived | per `(year, expenditure_area_code, budget_type)`  | none |
| 21 | `manifesto_by_category`  | derived | per `(party_code, election_year, category_code)`  | none |

### 2.2 Mutable-state tables (DynamoDB on-demand)

| # | Table | PK / SK | Purpose | TTL |
|---|---|---|---|---|
| 22 | `ingest_cursors`        | PK `source#stream`                  | Latest successfully-ingested `dok_id`/`votering_id` per `(source, typ, rm)` | none |
| 23 | `ingestion_runs`        | PK `source`, SK `run_id`            | Audit log of every ingestion run                                            | 180 days |
| 24 | `summary_cache`         | PK `dok_id#model_id`                | LLM-generated document summary + Swedish text + citations                   | 365 days |
| 25 | `accountability_cache`  | PK `party#topic_hash#period_hash`   | Cached accountability synthesis output                                      | 7 days |
| 26 | `accountability_jobs`   | PK `job_id`                         | Async job state for POST → poll pattern                                     | 24 hours |
| 27 | `ratelimit_counter`     | PK `ip`, SK `window_start`          | Per-IP throttle counter, if used in lieu of WAF                             | 1 hour |

## 3. `members`

One row per MP, historical and sitting.

| Column | Type | Notes |
|---|---|---|
| `intressent_id`    | STRING | PK. Riksdagen's internal id. |
| `sorteringsnamn`   | STRING | "Andersson, Anna". For alphabetical sorting. |
| `fnamn`            | STRING | First name. |
| `enamn`            | STRING | Last name. |
| `parti`            | STRING | Party code: `S`, `M`, `SD`, `C`, `V`, `KD`, `L`, `MP`, `-` (independent). |
| `valkrets`         | STRING | Constituency. |
| `kon`              | STRING | `man` \| `kvinna` \| null. Reported by Riksdagen. |
| `fodd_ar`          | INT    | Year of birth. |
| `status`           | STRING | e.g. `Tjänstgörande riksdagsledamot`, `Ersättare`, `Avgången`. |
| `period_start`     | DATE   | First day in current status. |
| `period_end`       | DATE   | Last day in current status, or null if ongoing. |
| `bild_url_80`      | STRING | Portrait URL at 80px, if published. |

Partitioning: none. ~350 sitting + a few thousand historical records. Rewritten whole on each ingestion run.

Source: `/personlista/`.

## 4. `documents`

One row per document — motions, propositions, committee reports, skrivelser, interpellationer, framställningar, and pointer rows for minutes.

| Column | Type | Notes |
|---|---|---|
| `dok_id`               | STRING    | PK. |
| `doktyp`               | STRING    | `mot`, `prop`, `bet`, `skr`, `ip`, `fr`, `prot`. |
| `rm`                   | STRING    | Riksmöte, e.g. `2024/25`. |
| `beteckning`           | STRING    | Within-rm identifier. |
| `titel`                | STRING    | Main title. |
| `undertitel`           | STRING    | Subtitle, often empty. |
| `datum`                | DATE      | Nominal document date. |
| `publicerad`           | TIMESTAMP | Publication timestamp, nullable. |
| `organ`                | STRING    | Committee code for `bet`/`mot`, ministry for `prop`/`skr`, nullable. |
| `status`               | STRING    | Upstream processing status, nullable. |
| `url_html`             | STRING    | Source URL at riksdagen.se. |
| `url_text`             | STRING    | Plain-text download URL. |
| `body_s3_key`          | STRING    | `doc-text/{dok_id}.txt.gz`, if the body was fetchable. Nullable for `prot` pointers. |
| `body_sha256`          | STRING    | SHA-256 of the decompressed body; used to detect re-ingest-required changes. |
| `body_bytes`           | BIGINT    | Uncompressed body size. |

Partitioning: by `doktyp` and `year(datum)`. Small per-partition files; DuckDB scans only relevant partitions.

Source: `/dokumentlista/` (index) + `/dokument/{dok_id}.text` (body).

Note: the `summary_*` columns present on the implementation's `documents` table live in DynamoDB's `summary_cache` in Agora, not on the Parquet row. That keeps the analytical table stable and avoids rewriting a whole Parquet partition when a summary is (re)generated.

## 5. `document_authors`

Many-to-many link between motions and their authoring MPs.

| Column | Type | Notes |
|---|---|---|
| `dok_id`         | STRING | PK part 1. FK → `documents`. |
| `intressent_id`  | STRING | PK part 2. FK → `members`. |
| `ordning`        | INT    | 0-based position in the author list. `ordning = 0` is the primary author. |
| `roll`           | STRING | `undertecknare` (signer) usually. Nullable. |

Empty for `prop` (government author) and `prot` (no authorship concept).

Source: per-document detail fetch during `mot` ingestion.

## 6. `votes`

One row per voting point (vote event), independent of individual MPs.

| Column | Type | Notes |
|---|---|---|
| `votering_id`     | STRING | PK. |
| `rm`              | STRING | Riksmöte. |
| `beteckning`      | STRING | Betänkande code. |
| `punkt`           | INT    | Point number within the betänkande. |
| `datum`           | DATE   | Vote date. |
| `dok_id`          | STRING | Originating betänkande document id, nullable. |
| `titel`           | STRING | Human-readable title of the vote point, denormalised for fast display. |
| `ja`              | INT    | Aggregate Ja count. |
| `nej`             | INT    | Aggregate Nej count. |
| `avstar`          | INT    | Aggregate Avstår count. |
| `franvarande`     | INT    | Aggregate Frånvarande count. |
| `utskott`         | STRING | Committee code, denormalised. |

Partitioning: by `year(datum)`. Very small; a full year of voting points is tens of thousands of rows.

## 7. `vote_results`

One row per MP per voting point — the per-individual detail.

| Column | Type | Notes |
|---|---|---|
| `votering_id`   | STRING | PK part 1. FK → `votes`. |
| `intressent_id` | STRING | PK part 2. FK → `members`. |
| `rost`          | STRING | `Ja` \| `Nej` \| `Avstår` \| `Frånvarande`. |
| `parti`         | STRING | Party at time of vote (denormalised; an MP's party can change). |
| `valkrets`      | STRING | Constituency at time of vote. |
| `datum`         | DATE   | Vote date, denormalised to allow standalone partitioning. |

Partitioning: by `year(datum)`. Under-2-MB Parquet files per year.

Source: `/voteringlista/?gruppering=iid`.

Split rationale (vs. the implementation's single wide `votes` table): aggregate counts (section 6) are queried an order of magnitude more often than per-MP rows (section 7) by the dashboard's headline widgets (e.g. "How did the chamber vote on bill X"). Keeping them separate halves the bytes-read for those queries and costs nothing for the detail drill-down because DuckDB can trivially join on `votering_id`.

## 8. `speeches`

One row per chamber speech, **metadata only**.

| Column | Type | Notes |
|---|---|---|
| `anforande_id`   | STRING    | PK. |
| `dok_id`         | STRING    | Originating protokoll dokument id. |
| `rel_dok_id`     | STRING    | Related motion/proposition/betänkande, nullable. |
| `intressent_id`  | STRING    | Speaker. Nullable for talman interventions without a registered id. |
| `parti`          | STRING    | Speaker's party, denormalised. |
| `dok_datum`      | DATE      | Session date. |
| `anforande_nummer` | INT     | Position within the session. |
| `anftyp`         | STRING    | `replik`, `svar`, etc. |
| `char_count`     | INT       | Length of the `anforandetext`. We do **not** store the full text. |

Partitioning: by `year(dok_datum)`.

Source: `/anforandelista/`.

## 9. `budget_outcomes`

One row per `(year, anslag, budget_type)`. Annual granularity; `month = 0` is the full-year sentinel.

| Column | Type | Notes |
|---|---|---|
| `year`                   | INT     | Fiscal year. |
| `month`                  | INT     | `0` for annual (the only value Statskontoret publishes in the feed we consume). |
| `expenditure_area_code`  | STRING  | e.g. `"UO14"`. |
| `expenditure_area_name`  | STRING  | e.g. `"Arbetsmarknad och arbetsliv"`. |
| `anslag_code`            | STRING  | Nullable for area-level totals. |
| `anslag_name`            | STRING  | Nullable. |
| `agency`                 | STRING  | Null in MVP (not present in the new feed). Retained for forward compatibility. |
| `amount_sek`             | DOUBLE  | Normalised to SEK. Source is MSEK. |
| `budget_type`            | STRING  | `utfall` \| `budgetram` \| `andringsbudget`. |

Unique key: `(year, month, anslag_code, budget_type)`.

Partitioning: by `year`.

Source: Statskontoret årsutfall ZIP (see `03-data-sources.md` §3).

## 10. `manifestos`

One row per `(party_code, election_year)`.

| Column | Type | Notes |
|---|---|---|
| `manifesto_id`   | STRING | PK. Stable synthetic id of the form `"{party_code}_{election_year}"`. |
| `party_code`     | STRING | `S`, `M`, `SD`, `C`, `V`, `KD`, `L`, `MP`. |
| `party_name`     | STRING | Human-readable Swedish name. |
| `election_year`  | INT    | 2010, 2014, 2018, 2022, (2026). |
| `wzb_id`         | STRING | The Manifesto Project's numeric party id (e.g. `"11320"`). |
| `corpus_version` | STRING | e.g. `"2025-1"`. |
| `ingested_at`    | TIMESTAMP | Last ingestion timestamp. |

## 11. `manifesto_statements`

One row per coded quasi-sentence.

| Column | Type | Notes |
|---|---|---|
| `manifesto_id`    | STRING | FK → `manifestos`. PK part 1. |
| `statement_index` | INT    | 0-based position in the manifesto. PK part 2. |
| `text`            | STRING | The quasi-sentence, in Swedish. |
| `category_code`   | STRING | Manifesto Project category (`per101`–`per706`), nullable. |
| `position`        | INT    | `-1` \| `0` \| `1` — derived from the signed `pos` value. Nullable. |

Embeddings of manifesto statements are **not** stored at MVP; the accountability endpoint filters by `category_code` before it hands them to the LLM, which is sufficient.

## 12. `document_chunks` (derived)

Full document bodies chunked into ~800-token windows for retrieval.

| Column | Type | Notes |
|---|---|---|
| `dok_id`      | STRING | FK → `documents`. |
| `chunk_index` | INT    | 0-based position. |
| `text`        | STRING | ~800 tokens, ~4 KB. |
| `char_start`  | INT    | Offset in the decompressed body. |
| `char_end`    | INT    | Exclusive end offset. |

Partitioning: by `doktyp`. Rebuilt from `s3://agora-raw/doc-text/` on demand.

## 13. `document_embeddings` (derived)

| Column | Type | Notes |
|---|---|---|
| `dok_id`        | STRING | FK → `documents`. PK part 1. |
| `chunk_index`   | INT    | PK part 2. |
| `embedding`     | LIST<FLOAT>, length 1024 | Titan Embed v2 vector. |
| `model_id`      | STRING | e.g. `amazon.titan-embed-text-v2:0`. |
| `generated_at`  | TIMESTAMP | |

Stored as a single Parquet file, partitioned loosely by `hash(dok_id) % 4` to spread load on a full-corpus scan. At ~50k chunks and 1024 dims the file is ~200 MB; the search Lambda mmaps the NumPy view at warm-start and re-uses it across invocations.

Model change: the existing implementation used Voyage AI at 512 dims. We move to Titan Embed v2 at 1024 dims. Two dimensionalities never coexist in the same file — a transform run writes one model's output, and the `model_id` column is the source of truth.

## 14. `votes_wide` (derived)

A denormalised convenience table joining `vote_results` with `members`, `votes`, and `documents`, plus a boolean `voted_against_own_party` computed as "the MP's `rost` differs from the modal `rost` of their party on this voting point".

| Column | Type |
|---|---|
| `votering_id`              | STRING |
| `intressent_id`            | STRING |
| `rm`                       | STRING |
| `beteckning`               | STRING |
| `punkt`                    | INT    |
| `datum`                    | DATE   |
| `parti`                    | STRING |
| `valkrets`                 | STRING |
| `rost`                     | STRING |
| `doktyp`                   | STRING |
| `titel`                    | STRING |
| `utskott`                  | STRING |
| `voted_against_own_party`  | BOOLEAN |

Materialised on each transform run. Rebuilt idempotently from `vote_results` + `votes` + `documents` + `members`.

## 15. `party_cohesion` (derived)

| Column | Type |
|---|---|
| `rm`           | STRING |
| `parti`        | STRING |
| `beteckning`   | STRING |
| `punkt`        | INT    |
| `cohesion_pct` | DOUBLE |
| `modal_rost`   | STRING |

`cohesion_pct` is the share of the party's non-absent members that voted the modal position. 100 means perfect line-voting.

## 16. `party_divergence` (derived)

| Column | Type |
|---|---|
| `rm`                   | STRING |
| `parti_a`              | STRING |
| `parti_b`              | STRING |
| `vote_points_total`    | INT    |
| `vote_points_diverged` | INT    |
| `divergence_pct`       | DOUBLE |

Computed symmetrically, with `parti_a < parti_b` lexicographically to avoid duplication.

## 17. `attendance_monthly` (derived)

| Column | Type |
|---|---|
| `intressent_id`  | STRING |
| `year`           | INT    |
| `month`          | INT    |
| `votes_total`    | INT    |
| `votes_attended` | INT    |
| `attendance_pct` | DOUBLE |

## 18. `motion_throughput` (derived)

| Column | Type |
|---|---|
| `rm`            | STRING |
| `utskott`       | STRING |
| `submitted`     | INT    |
| `reported_on`   | INT    |
| `approved`      | INT    |

## 19. `speech_monthly` (derived)

| Column | Type |
|---|---|
| `intressent_id` | STRING |
| `year`          | INT    |
| `month`         | INT    |
| `speeches`      | INT    |
| `chars_total`   | INT    |

## 20. `budget_by_area` (derived)

| Column | Type |
|---|---|
| `year`                  | INT    |
| `expenditure_area_code` | STRING |
| `expenditure_area_name` | STRING |
| `budget_type`           | STRING |
| `amount_sek`            | DOUBLE |

## 21. `manifesto_by_category` (derived)

| Column | Type |
|---|---|
| `party_code`   | STRING |
| `election_year`| INT    |
| `category_code`| STRING |
| `statement_n`  | INT    |
| `position_avg` | DOUBLE |

## 22. DynamoDB — `ingest_cursors`

| Attribute | Type | Notes |
|---|---|---|
| `pk`                | S | `"{source}#{stream}"` e.g. `"riks#mot"`, `"riks#voteringlista#2024/25"`, `"statskontoret#utgift"`, `"manifesto#2025-1"`. |
| `last_dok_id`       | S | Latest dok_id we have ingested; nullable for non-document streams. |
| `last_seen_datum`   | S | ISO date. |
| `last_run_id`       | S | FK → `ingestion_runs`. |
| `updated_at`        | S | ISO timestamp. |

## 23. DynamoDB — `ingestion_runs`

| Attribute | Type | Notes |
|---|---|---|
| `pk`                | S | `source`, e.g. `"riks"`, `"statskontoret"`, `"manifesto"`. |
| `sk`                | S | `"{started_at}#{run_id}"` (descending naturally when `ScanIndexForward=false`). |
| `run_id`            | S | UUID. |
| `started_at`        | S | ISO. |
| `finished_at`       | S | ISO, nullable while running. |
| `rows_processed`    | N | |
| `rows_inserted`     | N | |
| `rows_updated`      | N | |
| `errors`            | L | List of `{code, message, context}`. |
| `lambda_request_id` | S | For correlation with CloudWatch logs. |

TTL: 180 days on `ttl_epoch`.

## 24. DynamoDB — `summary_cache`

| Attribute | Type | Notes |
|---|---|---|
| `pk`          | S | `"{dok_id}#{model_id}"`. |
| `summary_sv`  | S | Swedish 3-sentence summary. |
| `summary_en`  | S | English translation, nullable. |
| `citations`   | L | List of `{label, url}`. |
| `model_id`    | S | `anthropic.claude-3-haiku-20240307-v1:0`. |
| `generated_at`| S | ISO. |

TTL: 365 days on `ttl_epoch`.

## 25. DynamoDB — `accountability_cache`

| Attribute | Type | Notes |
|---|---|---|
| `pk`              | S | `"{party_code}#{topic_hash}#{period_hash}"`. |
| `report_sv`       | S | ~150-word synthesis in Swedish. |
| `source_refs`     | L | List of `{kind, id, excerpt}`; every claim cites at least one. |
| `input_hash`      | S | SHA-256 of the 4-bundle input, for cache invalidation on data refresh. |
| `model_id`        | S | |
| `prompt_version`  | S | Allows re-running a stale cache if the prompt itself changes. |
| `generated_at`    | S | ISO. |

TTL: 7 days on `ttl_epoch`. A refresh always re-computes after the TTL; a new ingest that changes `input_hash` short-circuits the TTL.

## 26. DynamoDB — `accountability_jobs`

| Attribute | Type | Notes |
|---|---|---|
| `pk`           | S | `job_id` (UUID). |
| `state`        | S | `queued` \| `running` \| `done` \| `failed`. |
| `progress_pct` | N | 0–100, set by the worker for UI feedback. |
| `result_pk`    | S | On `done`, the `pk` into `accountability_cache`. |
| `error`        | S | On `failed`, human-readable message. |
| `created_at`   | S | ISO. |
| `updated_at`   | S | ISO. |

TTL: 24 hours on `ttl_epoch`. Jobs are ephemeral; the report itself lives in `accountability_cache`.

## 27. DynamoDB — `ratelimit_counter` (optional)

Only created if we choose the CloudFront Function + DynamoDB counter variant instead of AWS WAF's rate-based rule (see `02-architecture.md` §4 and `09-observability-and-security.md`).

| Attribute | Type | Notes |
|---|---|---|
| `pk`            | S | IP address. |
| `sk`            | S | Window start timestamp, rounded to the minute. |
| `count`         | N | Requests in window. |

TTL: 1 hour on `ttl_epoch`.

## 28. Non-tables (things we intentionally do not model)

- **Sessions / meetings beyond `rm`.** Finer-grained session tracking belongs to the minutes, not to our dashboard queries.
- **Committees as a separate entity.** We carry committee codes as strings on `documents` and `votes`; a small YAML file in the repo maps codes to human-readable names. This keeps the schema flat.
- **Topics / tags.** Riksdagen's tagging is inconsistent. We rely on full-text search and, via embeddings, on semantic search. No curated taxonomy.
- **Aggregated "score" fields** (e.g., "progressiveness index"). These are editorial and violate the principle of not framing.
- **A `users` or `api_keys` table.** The implementation had both; they are removed entirely in the port. See `01-critical-review.md` §6.

## 29. Key indices and access patterns

DuckDB does not need indices in the RDBMS sense; Parquet row-group statistics are enough for our query volume. But we tune *partitioning* so that:

- "Show me votes in 2024 for party X" reads only `vote_results/year=2024/*.parquet`.
- "Show me motions of type `mot` in rm `2024/25`" reads only `documents/doktyp=mot/year=2024/*.parquet` and `documents/doktyp=mot/year=2025/*.parquet`.
- "Search document embeddings" reads the entire `document_embeddings/` prefix into memory once per warm Lambda and keeps it mmap'd.
- "Accountability for (party, topic)" reads `document_authors` + `documents` + `vote_results` filtered by a candidate set of `dok_id`s already narrowed by topic search; plus `manifesto_statements` filtered by `category_code`; plus `budget_outcomes` filtered by expenditure-area mapping. Each leg touches < 10 MB of Parquet.

For full-text search, DuckDB's FTS extension is created against `documents.titel || ' ' || documents.undertitel` and against `document_chunks.text` at warm-start; the index structure is an in-memory DuckDB artifact, not a persisted blob.

## 30. Evolution

Schema changes happen by rewriting Parquet — there is no live migration concern because nothing is stateful in the usual sense:

1. Change the transform Lambda.
2. Trigger a full rebuild from `agora-raw/` (a single CDK context flag, see `10-iac-bootstrap.md`, section "Ops flags").
3. New Parquet replaces old. Old Parquet retained under an S3 lifecycle rule for 30 days.

DynamoDB schema changes use on-demand additive attributes (no migrations needed for added fields; for renamed fields, the transform Lambda writes both names for one release cycle and then drops the old name).

No downtime, no migration scripts, no dual-writes.
