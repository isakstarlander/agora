# PR-07 — `derive` Lambda (analytical tables)

## Outcome

A Python 3.12 ARM64 container-image Lambda `derive` that re-computes every derived analytical table (`party_cohesion`, `party_divergence`, `attendance_monthly`, `motion_throughput`, `speech_monthly`, `budget_by_area`, `manifesto_by_category`, `votes_wide`) via DuckDB SQL against the base Parquet files from PR-06, and writes them back to `s3://agora-parquet/…`. Debounced by an SQS queue so that bursty transform runs coalesce into at most one derive invocation per 10 minutes.

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 4 (derive); `04-data-model.md` §§14–21; `05-ingestion.md` §8.

## Prerequisites

- PR-06 (base Parquet tables populated).

## Context

Derived tables exist so that the dashboard can render a party cohesion chart without re-joining `vote_results × members × documents` on every request. They are small (thousands to low tens of thousands of rows each) and can be rewritten whole whenever any base table changes. Full rewrite is simpler than incremental maintenance at our data volume.

The set (`04-data-model.md` §§14–21):

| Table | Grain | Source |
|---|---|---|
| `votes_wide`            | `(votering_id, intressent_id)` with denormalised party, name, committee, riksmöte | `vote_results × members × votes × documents` |
| `party_cohesion`        | `(rm, parti, beteckning, punkt) → cohesion score` | `votes_wide` |
| `party_divergence`      | `(rm, parti_a, parti_b)` | `votes_wide` |
| `attendance_monthly`    | `(intressent_id, year, month)` | `vote_results × members` |
| `motion_throughput`     | `(rm, utskott)` | `documents × vote_results` |
| `speech_monthly`        | `(intressent_id, year, month)` | `speeches` |
| `budget_by_area`        | `(year, expenditure_area_code, budget_type)` | `budget_outcomes` |
| `manifesto_by_category` | `(party_code, election_year, category_code)` | `manifesto_statements` |

All use the DuckDB view layer defined in `06-storage-and-api.md` §1.3 — the same query surface the API Lambda uses. This symmetry is a feature: any SQL an analyst runs in Athena can also run in the `derive` Lambda and the API.

## Scope / Deliverables

### 1. Package layout

```
iac/lambda/derive/
  Dockerfile
  requirements.txt              # boto3, duckdb, pyarrow
  src/
    handler.py                  # dispatcher
  sql/
    votes_wide.sql
    party_cohesion.sql
    party_divergence.sql
    attendance_monthly.sql
    motion_throughput.sql
    speech_monthly.sql
    budget_by_area.sql
    manifesto_by_category.sql
```

Lambda memory: 3008 MB (the party-cohesion / divergence queries are the heaviest; DuckDB appreciates the RAM). Timeout: 10 min. Ephemeral `/tmp`: 4 GB.

### 2. Handler

```
def handler(event, context):
    # event is an SQS batch message, but we coalesce — all messages in the batch count as one trigger.
    con = boot_duckdb()   # same view setup as 06-storage-and-api.md §1.3
    for table, sql_path in TABLES:
        rows = con.execute(open(sql_path).read()).fetchdf()
        write_parquet_atomic(con, table, rows)
        update_success_sentinel(table)
    write_audit_row(ingestion_runs, source="derive")
```

All tables are rewritten on every invocation. Typical run time on a representative dataset: ≤30 s. A failure during one table aborts the run (`derive` is all-or-nothing) so that downstream consumers never see a half-updated derived layer.

### 3. SQS debounce

Create `agora-derive-queue` (Standard queue, `VisibilityTimeout=600 s`, `MessageRetentionPeriod=4 h`, DelaySeconds=600 s). PR-06's `transform` Lambda emits one message to this queue **at the end of each run**, regardless of which table it wrote. The 10-minute delay combined with `VisibilityTimeout` + `ReceiveMessageWaitTimeSeconds=20` means bursts of five transform runs within 10 minutes coalesce into a single `derive` invocation.

The `derive` Lambda reads with `BatchSize: 10`, `MaximumBatchingWindow: 60 s`. Its handler ignores the message contents — it just runs the whole derive pass when triggered.

Create a DLQ (`agora-derive-dlq`) for messages that fail 3 times.

### 4. SQL files

Ported from `./agora/packages/db/migrations/*.sql` (the existing implementation's SQL) where applicable, with `pg_trgm`/`unaccent`/`to_tsvector` replaced by DuckDB equivalents. Representative shape of `party_cohesion.sql`:

```sql
WITH votes_with_context AS (
  SELECT vr.votering_id, vr.intressent_id, m.parti, vr.rost,
         v.beteckning, v.punkt, v.rm
    FROM vote_results vr
    JOIN members m USING (intressent_id)
    JOIN votes   v USING (votering_id)
),
aggs AS (
  SELECT rm, parti, beteckning, punkt,
         COUNT(*) AS n,
         SUM(CASE WHEN rost='Ja'   THEN 1 ELSE 0 END) AS n_ja,
         SUM(CASE WHEN rost='Nej'  THEN 1 ELSE 0 END) AS n_nej,
         SUM(CASE WHEN rost='Avstår' THEN 1 ELSE 0 END) AS n_avstar
    FROM votes_with_context
   GROUP BY 1,2,3,4
)
SELECT rm, parti, beteckning, punkt,
       n, n_ja, n_nej, n_avstar,
       GREATEST(n_ja, n_nej, n_avstar) * 1.0 / NULLIF(n, 0) AS cohesion
  FROM aggs;
```

Complete SQL drafts for all eight tables live in `iac/lambda/derive/sql/`. Each SQL file must:

- `SELECT` into a columnar shape DuckDB can export with `COPY TO 's3://agora-parquet/<table>/part-0000.parquet' (FORMAT 'parquet');`.
- Use the DuckDB views defined in the API bootstrap so any change to the view layer (e.g. adding a new base table) does not drift between `derive` and `api`.

### 5. `_SUCCESS` update

After writing a derived table, overwrite its `_SUCCESS.json` atomically. Partitioned derived tables (none at MVP — all are small and single-file) are trivial; if we ever add one, the `_SUCCESS` sentinel generalises.

### 6. Ops flag: `-c agora:rebuild=true`

When this flag is set at deploy time, CDK also provisions a one-off Step Functions state machine `agora-rebuild` that:

1. Lists every manifest under `agora-raw/`.
2. Publishes each one to `agora-raw-manifests` in order.
3. Finally puts one message on `agora-derive-queue`.

This is the escape hatch that lets us rebuild the entire Parquet layer from `agora-raw` if `agora-parquet` is accidentally deleted or if we bump a Parquet schema. Not used in the normal flow.

### 7. IAM

`AgoraDeriveRole`:

- `s3:GetObject` on `agora-parquet/*`; `s3:PutObject`/`DeleteObject` on `agora-parquet/*` (rewriting derived).
- `sqs:ReceiveMessage`, `DeleteMessage` on `agora-derive-queue`.
- `sqs:SendMessage` on `agora-derive-dlq`.
- `dynamodb:PutItem` on `agora_ingestion_runs`.
- `glue:*Table`/`Partition`/`Database` scoped to `agora_parquet`.
- Base Lambda policy (CloudWatch metrics, logs).

### 8. Alarms (deferred to PR-11)

Emit EMF metrics `DeriveRunDurationMs`, `DeriveRowsWritten` (per table dimension), `DeriveErrors`. Alarms are wired in PR-11.

### 9. Tests

- Per-SQL-file unit test against a fixture Parquet set (small hand-crafted data), asserting the output row counts and a spot-check column.
- Integration: invoke on a sandboxed copy of real Parquet; assert all 8 tables are written with ≥1 row.

## Manual steps

1. After `cdk deploy`, put one message on the queue to kick off the first derive run without waiting 10 minutes:

   ```bash
   aws sqs send-message \
     --profile agora-se --region eu-north-1 \
     --queue-url <agora-derive-queue-url> \
     --message-body '{"trigger":"manual"}'
   ```

2. Verify derived tables exist:

   ```bash
   aws s3 ls s3://agora-parquet-<acct>/party_cohesion/
   ```

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` exits 0; `derive` Lambda + `agora-derive-queue` + DLQ visible.
- [ ] A manual SQS message triggers a `derive` invocation that completes `SUCCEEDED` in ≤2 min wall.
- [ ] After the run, each of these prefixes contains a non-empty Parquet file and `_SUCCESS.json`:
  - `votes_wide/year=*/`, `party_cohesion/`, `party_divergence/`, `attendance_monthly/`, `motion_throughput/`, `speech_monthly/`, `budget_by_area/`, `manifesto_by_category/`.
- [ ] Athena query `SELECT parti, AVG(cohesion) FROM agora_parquet.party_cohesion WHERE rm = '2024/25' GROUP BY 1` returns the 8 party codes with reasonable cohesion values (0.7–1.0 range is typical).
- [ ] A second message that arrives within the 10-minute debounce window does not trigger a second invocation (coalesces).
- [ ] `agora-derive-dlq` is empty.

## Out of scope

- Incremental maintenance (only-rewrite-changed-partitions). Full rewrite is fine at our data volume; revisit if any derived table breaks the 5-minute run target.
- Derived-table embeddings (e.g. `manifesto_by_category` with embeddings). If ever useful, add in a separate PR.
- Cost-aware query caching. DuckDB's own arrow cache is sufficient.
