# PR-03 — Riksdagen ingestion Lambdas

## Outcome

Four Node 20 ARM64 Lambdas — `fetch-riks-documents`, `fetch-riks-votes`, `fetch-riks-speeches`, `fetch-riks-members` — deployed as part of `AgoraDataStack` and scheduled via EventBridge. Each Lambda pages the corresponding `data.riksdagen.se` endpoint, writes page-by-page gzipped JSON + a `manifest.json` to `s3://agora-raw/riks/.../ingested=<slug>/`, and advances `agora_ingest_cursors` so the next run is incremental.

This PR does **not** implement document-body (full-text) fetching. That is PR-04's Step Functions state machine. It also does not implement transform (raw→Parquet). That is PR-06.

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 2 (Riksdagen half); `05-ingestion.md` §§2–4; `03-data-sources.md` §2.

## Prerequisites

- PR-01 (scaffold), PR-02 (buckets, DynamoDB, scheduler group) complete.
- `data.riksdagen.se` is reachable from the Lambda egress NAT-free default networking.

## Context

`data.riksdagen.se` exposes several JSON-serialisable endpoints (append `&utformat=json`). Relevant endpoints and their Agora use:

| Endpoint | Purpose | Lambda |
|---|---|---|
| `GET /dokumentlista/?doktyp={mot,prop,bet,skr,ip,fr}&p={page}&sz=50&sort=datum&sortorder=desc&utformat=json` | Paginated list of documents of a given doktyp | `fetch-riks-documents` |
| `GET /voteringlista/?rm={YYYY-YY}&utformat=json` | Paginated list of vote points for a given riksmöte | `fetch-riks-votes` |
| `GET /anforandelista/?rm={YYYY-YY}&utformat=json` | Paginated list of chamber-speech metadata | `fetch-riks-speeches` |
| `GET /personlista/?utformat=json` | Full list of MPs (sitting + historical) | `fetch-riks-members` |
| `GET /dokument/{dok_id}.json` | Per-document detail (authors, status) | used by `fanout-doctext` in PR-04 |
| `GET /dokument/{dok_id}.text` | Raw plain-text body | used by `fanout-doctext` in PR-04 |

All endpoints honour rate limiting via the standard `Retry-After` header on 429; our politeness rule is **max 4 requests / second, sequential, with exponential backoff** on 429 / 5xx. Each Lambda runs single-threaded — we are not the Riksdag's heaviest consumer by an order of magnitude.

The existing (Supabase-based) implementation in `../agora/agora/scripts/ingest/` already contains working versions of these ingesters:

- `scripts/ingest/documents.ts` — reference for document list pagination and enrichment.
- `scripts/ingest/voting.ts` — reference for vote-list pagination.
- `scripts/ingest/members.ts` — reference for the members full-refresh strategy.
- `scripts/ingest/utils.ts` — shared helpers for fetch, parse, retry.

The port keeps the URL-building and parse logic; it replaces the Supabase write path with a plain S3 write and swaps out Node's cursor-in-Postgres for DynamoDB.

## Scope / Deliverables

### 1. Source layout

Create `iac/lambda/fetch-riks/` with one bundle per entry point:

```
iac/lambda/fetch-riks/
  package.json                 # local deps: aws-sdk v3 (s3, dynamodb, ssm), pino, zod, undici
  tsconfig.json
  src/
    lib/
      riks-client.ts           # fetch wrapper: throttle, backoff, JSON parse, zod validation
      s3-sink.ts               # gzip + PutObject + manifest-writer
      cursor.ts                # DynamoDB cursor get/set
      runs.ts                  # DynamoDB ingestion_runs audit
      logger.ts                # structured JSON logger with common fields
    handlers/
      documents.ts             # export handler(event): documents-list ingest
      votes.ts                 # export handler(event): vote-list ingest
      speeches.ts              # export handler(event): speech-list ingest
      members.ts               # export handler(event): members full-refresh
```

All four handlers share the `lib/` helpers. Total shipped bundle target: <2 MB per Lambda after tree-shaking (esbuild minify + source maps separate).

### 2. `lib/riks-client.ts`

- `riksGet(path, params)` → JSON.
- Throttles at 4 rps via a local token bucket.
- Retries on 429 / 502 / 503 / 504 with exponential backoff (250 ms → 4 s, max 5 attempts). Uses `Retry-After` when provided.
- Parses JSON and narrows via zod schemas defined per endpoint.
- On schema mismatch, logs a `WARN` with the field path and **still returns the parsed data** — Riksdagen occasionally adds fields. The ingest is tolerant; the transform (PR-06) is strict.

### 3. `lib/s3-sink.ts`

Writes one gzipped JSON page to `s3://agora-raw/<prefix>/ingested=<slug>/part-NNN.json.gz` using the AWS SDK v3 `S3Client.putObject` with `ContentEncoding: 'gzip'`, `ContentType: 'application/json'`.

After the last page, writes a `manifest.json` to the same `ingested=<slug>/` folder with:

```json
{
  "source": "riks/dokumentlista",
  "doktyp": "mot",
  "ingested_at": "2026-04-20T06:15:00Z",
  "parts": 12,
  "total_rows": 587,
  "max_dok_id": "HB02MOT1234",
  "min_dok_id": "HB02MOT1100",
  "cursor_after": "HB02MOT1234"
}
```

The `manifest.json` write triggers the `agora-raw-manifests` SNS topic via the S3 event rule that PR-02 created. The transform Lambda in PR-06 subscribes and consumes only manifest events, which guarantees it sees a consistent set of parts per run.

### 4. `lib/cursor.ts`

Two methods:

- `getCursor(source_stream: string) → string | null` (DynamoDB `GetItem` on `agora_ingest_cursors`, PK `source_stream`).
- `setCursor(source_stream: string, value: string)` (`PutItem`).

Partition key examples:

- `riks/dokumentlista/mot`
- `riks/dokumentlista/prop`
- `riks/voteringlista/2024-25`
- `riks/personlista` (single-valued)

### 5. `handlers/documents.ts`

Lambda handler. Responsibility:

1. Read `event.doktyp` (`mot | prop | bet | skr | ip | fr`). Fail fast if missing.
2. Read cursor `riks/dokumentlista/<doktyp>` = `last_dok_id`.
3. Page `/dokumentlista/` filtered by `doktyp`, sorted `datum desc`. Stop when a page contains `last_dok_id` or when the page is empty.
4. Stream pages to S3 via `s3-sink`. Dedupe duplicates within the run (same `dok_id` on page boundary).
5. Write `manifest.json`. Advance cursor to the new max `dok_id`.
6. Write an `agora_ingestion_runs` audit row with `(source=riks, run_id=<ulid>, started_at, ended_at, pages, total_rows, errors_count)`.

Batch by 50 per page; expect typical daily volume of 0–1 page per doktyp outside of high-activity weeks.

### 6. `handlers/votes.ts`

Same shape, but:

- `event.rm` (e.g. `"2024/25"`) is required.
- Lambda pages `/voteringlista/?rm=<rm>&utformat=json`; cursor key `riks/voteringlista/<rm>`; cursor value is `votering_id`.

### 7. `handlers/speeches.ts`

Same shape. Cursor key `riks/anforandelista/<rm>`. Metadata only — speech body text is ignored at MVP (see `04-data-model.md` §8).

### 8. `handlers/members.ts`

**Full refresh, not incremental.** Writes everything the endpoint returns to `riks/personlista/ingested=<slug>/full.json.gz` every run. No cursor. `personlista` is small (~10k rows lifetime); a full refresh is cheaper than reasoning about MP resignations and reinstatements.

### 9. Four `aws_lambda_nodejs.NodejsFunction` resources

Add to `data-stack.ts`:

```ts
const ingestRole = new iam.Role(this, "IngestRole", {
  assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
  ],
});
this.rawBucket.grantWrite(ingestRole);
this.ingestCursorsTable.grantReadWriteData(ingestRole);
this.ingestionRunsTable.grantWriteData(ingestRole);

const fn = (name: string, entry: string, opts = {}) =>
  new NodeLambda(this, name, {
    entry: path.join(__dirname, `../lambda/fetch-riks/src/handlers/${entry}.ts`),
    role: ingestRole,
    timeout: Duration.minutes(5),
    memorySize: 512,
    environment: {
      RAW_BUCKET: this.rawBucket.bucketName,
      CURSOR_TABLE: this.ingestCursorsTable.tableName,
      RUNS_TABLE: this.ingestionRunsTable.tableName,
    },
    ...opts,
  });

const fnDocs     = fn("FetchRiksDocuments", "documents");
const fnVotes    = fn("FetchRiksVotes",     "votes");
const fnSpeeches = fn("FetchRiksSpeeches",  "speeches");
const fnMembers  = fn("FetchRiksMembers",   "members");
```

All four Lambdas get log retention `ONE_MONTH`, ARM64, Node 20 (via the factory from PR-01).

### 10. EventBridge schedules

Per `05-ingestion.md` §2. Schedule expressions assume `agora:scheduleIntensity=normal` (context key from PR-01); the wrapper multiplies / divides frequencies when `low` or `high` are set.

| Schedule name | Cron (UTC) | Target | Input |
|---|---|---|---|
| `agora-ingest-riks-documents-mot`  | `cron(15 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"mot"}` |
| `agora-ingest-riks-documents-prop` | `cron(20 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"prop"}` |
| `agora-ingest-riks-documents-bet`  | `cron(25 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"bet"}` |
| `agora-ingest-riks-documents-skr`  | `cron(27 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"skr"}` |
| `agora-ingest-riks-documents-ip`   | `cron(29 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"ip"}` |
| `agora-ingest-riks-documents-fr`   | `cron(31 6 * * ? *)` | `fetch-riks-documents` | `{"doktyp":"fr"}` |
| `agora-ingest-riks-votes`          | `cron(40 6 * * ? *)` | `fetch-riks-votes`     | `{"rm":"2025/26"}` (recalculated from current date at synth time — see below) |
| `agora-ingest-riks-speeches`       | `cron(45 6 * * ? *)` | `fetch-riks-speeches`  | `{"rm":"2025/26"}` |
| `agora-ingest-riks-members`        | `cron(0 3 * * ? *)`  | `fetch-riks-members`   | `{}` |

The `rm` for votes/speeches must adapt to the current riksmöte. Implement a helper in `constructs/env.ts`:

```ts
export function currentRm(today = new Date()): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const start = m >= 9 ? y : y - 1;
  const end = (start + 1) % 100;
  return `${start}/${String(end).padStart(2, "0")}`;
}
```

Re-synth and redeploy crosses the September boundary safely. A future improvement is to let the handler itself figure out `rm` when the event omits it, so the schedule target input is `{}` permanently — record this as a PR-03 follow-up.

All schedules live in the `agora-schedules` group from PR-02.

### 11. Logs

Each handler logs one `start` line and one `end` line with `event=ingest.riks.<type>.{start|end}`, `pages`, `rows`, `duration_ms`, `status`, `cursor_before`, `cursor_after`. Structured JSON per `09-observability-and-security.md` §1.1.

Emit an EMF metric `IngestNewDocs` (count) after a successful run.

### 12. Tests

`iac/lambda/fetch-riks/__tests__/`:

- `riks-client.test.ts` — throttle and backoff unit tests using `nock`.
- `cursor.test.ts` — DynamoDB client mock.
- Integration test `documents.int.test.ts` that invokes the handler locally against a **fixture** (committed 5-page recording of a real response) and asserts S3 puts + cursor update against a `@aws-sdk/client-mock` instance.

Record the fixture once against real Riksdagen data to avoid flaky tests; commit it. It is public data.

## Manual steps

None — all manual setup was done in PR-00 and PR-02.

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` deploys without errors; four new Lambdas visible.
- [ ] Each Lambda can be invoked manually from the console with the expected input and returns a structured success payload (`{ ok: true, rows: N, pages: M, cursor_after: ... }`) in under 2 minutes wall-clock.
- [ ] After a manual invoke of `fetch-riks-members`, `s3://agora-raw/riks/personlista/ingested=<slug>/full.json.gz` exists and is ≥100 KB.
- [ ] After a manual invoke of `fetch-riks-documents` with `{"doktyp":"mot"}` on a fresh account, `s3://agora-raw/riks/dokumentlista/doktyp=mot/ingested=<slug>/` contains ≥1 `part-*.json.gz` and a `manifest.json`.
- [ ] The `manifest.json` write triggers a message on `agora-raw-manifests` (verify via CloudWatch metrics on the SNS topic).
- [ ] `agora_ingest_cursors` has rows for each doktyp after the first successful document run.
- [ ] EventBridge shows the schedules listed in §10, all `State=ENABLED`.
- [ ] `agora_ingestion_runs` gets one new row per invocation, with `ended_at` set.

## Out of scope

- Document **body** fetching (individual `/dokument/{id}.text` calls). That is PR-04's fanout state machine.
- Raw → Parquet transformation. PR-06.
- Derived tables and embeddings. PR-07, PR-12.
- Alarms on `IngestErrors`. PR-11.
