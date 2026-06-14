# PR-05 — Statskontoret (ESV) and Manifesto Project ingestion

## Outcome

Two Node 20 ARM64 Lambdas — `fetch-esv` (monthly) and `fetch-manifesto` (quarterly) — added to `AgoraDataStack`. Each fetches its upstream feed, writes immutable gzipped raw files under `s3://agora-raw/statskontoret/…/` and `s3://agora-raw/manifesto/…/`, and writes a `manifest.json` that triggers the downstream transform (PR-06).

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 2 (non-Riksdagen sources); `05-ingestion.md` §§3–4; `03-data-sources.md` §§3–4.

## Prerequisites

- PR-02 (buckets, cursor table, secret for Manifesto API key).
- The Manifesto API key must already be **populated** in Secrets Manager (manual step from PR-02). The ingest Lambda will fail clearly if it is empty.

## Context

### Statskontoret (årsutfall)

Statskontoret publishes annual state-budget out-turns (utfall) per expenditure area and anslag, 1997–present, as a set of CSVs at `https://statskontoret.se/opendata/arsutfall-<year>.csv` (URL pattern is reasonably stable; validate it at ingest time). The file format is Swedish-locale CSV: semicolon-separated, `,` as decimal separator, UTF-8. We ingest **only the year's file if its SHA-256 differs from the last one we stored** — the site re-posts the file periodically as upstream tallies are revised.

### Manifesto Project (WZB)

The WZB Manifesto Project at `manifesto-project.wzb.eu/api/` returns coded quasi-sentence statements for each party-election manifesto. Endpoints we use:

- `GET /api/v1/manifestoproject-api/party_table?api_key=…` — list parties and their codes.
- `GET /api/v1/manifestoproject-api/documents?api_key=…&countryname=Sweden` — list available manifestos.
- `GET /api/v1/manifestoproject-api/annotations?api_key=…&party=...&date=...` — statement-level annotations for a given manifesto.

We care about the 8 sitting Swedish parties and the last four elections (2010, 2014, 2018, 2022). Total statements: ~40k rows.

### Existing implementation

The Supabase-based prior implementation has both ingesters:

- `./agora/scripts/ingest/esv.ts` — ESV (Statskontoret predecessor). Parse is portable; the Supabase upsert is replaced with S3 write.
- `./agora/scripts/ingest/manifesto.ts` — Manifesto Project ingester. Same change.

## Scope / Deliverables

### 1. `iac/lambda/fetch-esv/`

```
fetch-esv/
  package.json
  tsconfig.json
  src/
    index.ts                    # handler
    parser.ts                   # Swedish CSV → normalized rows
    schema.ts                   # zod schemas for input/output
```

Handler flow:

1. For each `year` from `2005` to `currentYear + 1`, HEAD the upstream URL. (Pre-2005 data is ingested once on a manual backfill — see §7.)
2. For HEAD results with a `Content-Length` or `Last-Modified` newer than the cursor `statskontoret/arsutfall/<year>`, download the CSV, gzip it, PutObject to `s3://agora-raw/statskontoret/arsutfall/year=<year>/ingested=<slug>/raw.csv.gz`.
3. Write `manifest.json` with `{source, year, sha256, row_count, ingested_at}`.
4. Update cursor to the new SHA.
5. Audit-log a row to `agora_ingestion_runs` (`source="statskontoret"`).

Schedule: `cron(0 4 1 * ? *)` — 04:00 UTC on the first of each month. Lambda environment: `RAW_BUCKET`, `CURSOR_TABLE`, `RUNS_TABLE`. Memory: 512 MB; timeout: 10 min.

### 2. `iac/lambda/fetch-manifesto/`

```
fetch-manifesto/
  package.json
  tsconfig.json
  src/
    index.ts                    # handler
    wzb-client.ts               # fetch with API key, pagination, zod schemas
    schema.ts
```

Handler flow:

1. Read the API key from Secrets Manager `/agora/manifesto/api_key` (JSON field `api_key`).
2. Fetch `party_table` (once per run) to resolve party codes.
3. Fetch `documents?countryname=Sweden`; filter to the 8 sitting parties and the 4 target elections.
4. For each matching `(party_code, date)` pair, fetch `annotations?party=...&date=...`. Page with `since_annotation_id=...` if the API exposes it; otherwise paginate via the documented page pattern.
5. For each manifesto, write two objects to `s3://agora-raw/manifesto/<party_code>/election=<YYYY>/ingested=<slug>/`:
   - `metadata.json.gz` — the entry from `documents`.
   - `statements.json.gz` — the full `annotations` list.
6. Write `manifest.json` per (party, election) with `{party_code, election_year, version, statement_count, sha256}`.
7. Update cursor `manifesto/<party>/<year>` if the corpus version changed.
8. Audit row to `agora_ingestion_runs` (`source="manifesto"`).

Schedule: `cron(0 5 1 */3 ? *)` — 05:00 UTC on the first day of every third month (quarterly). Lambda memory: 512 MB; timeout: 10 min.

### 3. Secret access

Grant `secretsmanager:GetSecretValue` on `/agora/manifesto/api_key` to the `fetch-manifesto` Lambda's role only. `fetch-esv` needs no secret — Statskontoret's feed is public and unauthenticated.

### 4. IAM

Two new roles `AgoraFetchEsvRole`, `AgoraFetchManifestoRole`. Each gets:

- `AWSLambdaBasicExecutionRole` (CloudWatch Logs).
- `s3:PutObject` on the specific prefix they write to.
- `dynamodb:*Item` on `agora_ingest_cursors` and `agora_ingestion_runs`.
- (Manifesto only) `secretsmanager:GetSecretValue` on the pinned secret ARN.

The `baseLambdaPolicy` from PR-02 is attached to both so CloudWatch custom-metrics emission works.

### 5. EventBridge schedules

Added to the `agora-schedules` group:

| Schedule name | Cron (UTC) | Target |
|---|---|---|
| `agora-ingest-esv`       | `cron(0 4 1 * ? *)`       | `fetch-esv` |
| `agora-ingest-manifesto` | `cron(0 5 1 */3 ? *)`     | `fetch-manifesto` |

Inputs are `{}` for both.

### 6. Logging, metrics, audit

Same structured-log convention as PR-03. Metrics: `IngestNewDocs` dimensioned on `source` (`"statskontoret"` / `"manifesto"`).

### 7. One-off backfills

Neither Lambda ingests historical data in a normal scheduled run. The `fetch-esv` handler supports an optional `event.years = [1997, 1998, ..., 2004]` array that forces a full re-ingest of those years. Use this once from the console to fetch 1997–2004:

```bash
aws lambda invoke \
  --profile agora-se --region eu-north-1 \
  --function-name agora-fetch-esv \
  --payload '{"years": [1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004]}' \
  /tmp/esv-backfill.json
```

For Manifesto, a full historical ingest happens naturally on the first scheduled run because the cursor is empty; no separate backfill is needed.

### 8. Tests

- `parser.test.ts` — Swedish-locale CSV parsing, including comma-decimal and "Anslag 1:1" naming.
- `wzb-client.test.ts` — mocked WZB API with recorded fixtures; asserts secret read, pagination, and schema validation.
- One snapshot test asserting both schedules exist in the group.

## Manual steps

1. **Run the 1997–2004 ESV backfill once** per the invoke command in §7. Verify `s3://agora-raw/statskontoret/arsutfall/year={1997..2004}/ingested=<slug>/raw.csv.gz` exist.
2. **Verify the Manifesto Project API key value** if the first scheduled `fetch-manifesto` run returns `401 Unauthorized`:

   ```bash
   aws secretsmanager get-secret-value \
     --profile agora-se --region eu-north-1 \
     --secret-id /agora/manifesto/api_key \
     --query SecretString --output text | jq .api_key
   ```

   Should return the plain key. If it returns `null`, re-run the populate step from PR-02.

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` exits 0.
- [ ] Manual invoke of `fetch-esv` with `{}` writes `raw.csv.gz` + `manifest.json` for the **current year** only (if new); does nothing visible if the sha is unchanged.
- [ ] Backfill invoke writes 8 historical years under `agora-raw/statskontoret/arsutfall/year={1997..2004}/…`.
- [ ] Manual invoke of `fetch-manifesto` with `{}` writes `statements.json.gz` and `metadata.json.gz` for each of ≥8 parties × 4 elections = 32 manifestos.
- [ ] `agora_ingest_cursors` populated with the expected row per ingested year / manifesto.
- [ ] `agora_ingestion_runs` has a row per invocation.
- [ ] Both schedules are enabled in EventBridge.
- [ ] Tests pass.

## Out of scope

- Parsing the CSVs or WZB JSON into Parquet — PR-06.
- Embedding the manifesto statements — PR-12.
- ESV monthly preliminary figures — post-MVP (Phase 8 of `11-roadmap.md`).
- Reintroducing retired pre-2005 ESV feed formats (they exist but the payload schema differs). Skipping those is acceptable for MVP.
