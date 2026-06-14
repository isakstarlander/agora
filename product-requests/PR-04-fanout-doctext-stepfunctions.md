# PR-04 — `fanout-doctext` Step Functions state machine

## Outcome

A Step Functions state machine `fanout-doctext` that, for every newly ingested document in `s3://agora-raw/riks/dokumentlista/`, fetches its JSON detail (`/dokument/{dok_id}.json`) and its plain-text body (`/dokument/{dok_id}.text`), writes the body to `s3://agora-raw/riks/document-text/<dok_id>.txt.gz`, and records document-author rows for motion-type documents. Fans out up to 10 in parallel, with tolerant per-item error handling.

## Roadmap anchor

`11-roadmap.md` — Phase 1, step 2 (document-text half); `05-ingestion.md` §6; `03-data-sources.md` §2.3.

## Prerequisites

- PR-03 complete — the document list Lambda writes `ingested=<slug>/` folders and manifests.
- PR-02's DynamoDB tables and raw-manifests SNS topic exist.

## Context

Document bodies are stored as **individual S3 objects**, one per `dok_id`, not as a Parquet column. This keeps Parquet scans cheap and makes text delivery to the summariser a point-GET rather than a range scan. The object key is always `s3://agora-raw/riks/document-text/<dok_id>.txt.gz`, gzipped.

The fanout problem is sized as follows: per daily document-list run, we typically see 0–50 new `dok_id`s across all doctypes. During high-activity periods (budget week) it can spike to a few hundred. Sequential fetching at 4 rps would take 2 minutes in the normal case and 20+ in the spike. We parallelise with Step Functions `Map` (`MaxConcurrency: 10`) so the same work runs in ~10 % of the wall time.

Motion-type documents additionally expose an `authors` array on the detail endpoint. We extract and persist it as JSON to `s3://agora-raw/riks/dokument-authors/<dok_id>.json.gz` so PR-06's transform picks it up.

`prot` (chamber minutes) is excluded — its body is not stored (we only keep `prot` as a pointer row per `04-data-model.md` §4, note).

## Scope / Deliverables

### 1. State machine

`AgoraDataStack` owns the state machine. Implemented in CDK with `sfn.StateMachine` using `CHAINED` definition; the Lambdas it orchestrates live in `iac/lambda/fanout-doctext/`.

```
Start
  → ListNewDocs            (Python Lambda)
  → Map (MaxConcurrency=10, ItemsPath=$.docs):
      → FetchDetail        (Node Lambda)
      → Choice: is author-bearing doctype? (mot)
          → WriteAuthors   (Python Lambda)    }
          → FetchBody      (Node Lambda)      }  parallel branch is unnecessary;
          → WriteAliasIndex(Python Lambda)    }  chain is fine
      (else)
          → FetchBody
      → Continue
  → Summarise              (Python Lambda: aggregate counts, write a run record)
  → End
```

`ItemsPath` is the list of new `dok_id` strings produced by `ListNewDocs`. `MaxConcurrency: 10` is the parallelism knob that bounds us at 10 rps of body-fetch against `data.riksdagen.se` which is well under the politeness budget.

Logging is enabled at `ALL` level to a CloudWatch log group `/aws/states/agora-fanout-doctext` with 30-day retention.

### 2. Support Lambdas

Under `iac/lambda/fanout-doctext/`:

```
fanout-doctext/
  package.json                 # Node 20 deps for the two Node-handlers
  tsconfig.json
  src/
    list_new_docs.py           # Python: walk the newest ingested=<slug>/ folder, return [dok_id]
    fetch_detail.ts            # Node: riksClient → /dokument/<id>.json → s3://.../dokument-detail/
    fetch_body.ts              # Node: riksClient → /dokument/<id>.text → s3://.../document-text/
    write_authors.py           # Python: parse detail JSON → authors list → s3://.../dokument-authors/<id>.json.gz
    write_alias_index.py       # Python: maintain a `dok_id → (doktyp, year, utskott, beteckning)` small pairing file per run
    summarise.py               # Python: at end of Map, append one row to agora_ingestion_runs
```

Python Lambdas (3.12, ARM64) are thin and built via the `DockerImageCode.fromImageAsset` construct from PR-01 — but for the absolute simplest two-file Python Lambdas we can use `aws_lambda.Function` with `Runtime.PYTHON_3_12` and an inline `Code.fromAsset` zip. Choose the latter for this PR; a single Python file does not need a container.

### 3. `list_new_docs.py`

Triggered by: Step Functions (one invocation at the start of a run; the input is the `s3://...manifest.json` key, passed in from the SNS message via the Step Functions trigger).

Behaviour:

1. Read the `manifest.json`.
2. Read each `part-*.json.gz` it references.
3. For each document in the listing, extract `dok_id`, `doktyp`, `datum`, `url_html`, `url_text`.
4. Filter out documents where a `s3://agora-raw/riks/document-text/<dok_id>.txt.gz` already exists (`HEAD` request).
5. Return the filtered list as `{ "docs": [ { "dok_id": "...", "doktyp": "...", ... }, ... ] }`.

Maintain an in-memory LRU of recent HEAD results because the same `dok_id` can appear on two consecutive days' listings (Riksdagen re-surfaces recent items).

### 4. `fetch_detail.ts`

Node Lambda using the same `riks-client.ts` from PR-03 (extract it into a shared layer, or duplicate — duplicate is fine for a ~200-line file; a shared layer adds deploy-time coupling we do not need).

- `GET /dokument/<dok_id>.json` → parse → validate → gzip → PutObject to `s3://agora-raw/riks/dokument-detail/<dok_id>.json.gz`.
- Return the parsed detail JSON to the state machine so subsequent steps can use it without re-fetching.

### 5. `fetch_body.ts`

- `GET /dokument/<dok_id>.text`; skip if 404 (some docs are body-less — e.g. early `prot` pointers) and return `{ body_present: false }`.
- Compute SHA-256 of the body.
- Compare against `s3://agora-raw/riks/document-text/<dok_id>.txt.gz` if it already exists (compare `ETag`-derived sha where possible, or read-and-hash on suspected mismatch).
- If unchanged, return `{ body_present: true, body_sha256, body_bytes, unchanged: true }`. If new, PutObject with `ContentEncoding: 'gzip'` and return the same shape with `unchanged: false`.
- Never re-fetch the body if the sha hasn't changed — bodies are near-immutable.

### 6. `write_authors.py`

- Accepts the detail JSON (from `fetch_detail`) via Step Functions state.
- For `doktyp == "mot"` only, pulls the `authors` array:

```json
[
  { "intressent_id": "0123456", "roll": "undertecknare", "ordning": 0 },
  ...
]
```

- Writes to `s3://agora-raw/riks/dokument-authors/<dok_id>.json.gz`.
- No DynamoDB writes in this PR. PR-06 transforms these JSONs into `document_authors` Parquet.

### 7. `write_alias_index.py`

Appends one row per `dok_id` into a run-scoped JSON array at `s3://agora-raw/riks/alias-index/ingested=<slug>/index.json.gz` containing `{ dok_id, doktyp, year, utskott, beteckning, body_s3_key }`. This file is what PR-06's transform reads first to know the scope of a run.

### 8. `summarise.py`

- At the end of the Map, writes a single row into `agora_ingestion_runs` with `(source="fanout-doctext", run_id, started_at, ended_at, count_success, count_failure, count_skipped)`.

### 9. Step Functions trigger

The state machine is triggered **by the transform Lambda** in PR-06 (which subscribes to `agora-raw-manifests`). In **this PR**, there is no automatic trigger yet — add a manual `StartExecution` permission for the `agora-admin` IAM identity so we can kick off a run from the console with a hand-crafted input.

Add a placeholder of the invocation policy, but do not wire the actual subscription — PR-06 owns that.

Concretely: the state machine ARN is exported as a CfnOutput `FanoutDoctextArn`. PR-06 reads it via a cross-stack import, in its own SNS subscription handler.

### 10. IAM

Create `AgoraFanoutDoctextRole` with:

- `states:StartExecution` on its own ARN (self-invoke, used by the `rebuild` ops flag later).
- `s3:GetObject` on `agora-raw/riks/dokumentlista/*` and `agora-raw/riks/dokument-detail/*`.
- `s3:PutObject` on `agora-raw/riks/document-text/*`, `agora-raw/riks/dokument-detail/*`, `agora-raw/riks/dokument-authors/*`, `agora-raw/riks/alias-index/*`.
- `dynamodb:PutItem` on `agora_ingestion_runs`.
- CloudWatch `logs:*` on `/aws/states/agora-fanout-doctext`.

Each child Lambda gets its own narrower role derived from this parent role.

### 11. Alarms

Emit EMF metric `DoctextFetchFailures` per failed Map item. Alarm wiring to SNS is deferred to PR-11.

### 12. Tests

- Unit test `list_new_docs.py` against a committed fixture of a manifest + two parts.
- Unit test `fetch_body.ts` against a recorded HTTP fixture.
- State-machine synth-test: assert `Type: Map` exists with `MaxConcurrency: 10`, and the state-machine log level is `ALL`.

## Manual steps

- After `cdk deploy AgoraDataStack`, trigger a first run manually:

  ```bash
  aws stepfunctions start-execution \
    --profile agora-se --region eu-north-1 \
    --state-machine-arn <FanoutDoctextArn> \
    --input '{"manifest_s3_key":"riks/dokumentlista/doktyp=mot/ingested=<slug>/manifest.json"}'
  ```

  Replace the manifest key with an actual one present in `agora-raw-<account>` after PR-03's first run. Watch the execution in the console; it should complete green within 2–3 minutes for a typical daily batch of ≤50 documents.

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` exits 0.
- [ ] Start-execution succeeds and completes `SUCCEEDED` for a real manifest key.
- [ ] After a successful run, `s3://agora-raw/riks/document-text/<dok_id>.txt.gz` exists for ≥90 % of the documents listed in the manifest (body-less docs are acceptable and logged).
- [ ] For `doktyp=mot` documents, `s3://agora-raw/riks/dokument-authors/<dok_id>.json.gz` exists.
- [ ] `s3://agora-raw/riks/alias-index/ingested=<slug>/index.json.gz` exists after the run.
- [ ] `agora_ingestion_runs` has one row with `source="fanout-doctext"` and a non-null `ended_at`.
- [ ] Re-running the same manifest-key input is a near-no-op (body sha matches; PutObjects are skipped); the execution still completes `SUCCEEDED`.
- [ ] Unit tests pass.

## Out of scope

- Auto-trigger from SNS. PR-06 adds it (the transform Lambda subscribes to `agora-raw-manifests` and starts executions when the manifest is a `riks/dokumentlista` one).
- Parquet writes. PR-06.
- Reading text bodies at query time. PR-08 (`api` uses the Parquet row's `body_s3_key`).
- Embedding the body text. PR-12.
