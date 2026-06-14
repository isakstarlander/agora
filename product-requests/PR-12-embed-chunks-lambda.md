# PR-12 — `embed-chunks` Lambda (weekly embedding refresh)

## Outcome

A Python 3.12 ARM64 container-image Lambda `embed-chunks` deployed into `AgoraDataStack`, triggered Sunday 02:00 UTC by EventBridge. On each run it walks `document_chunks` for rows with no matching embedding, batch-calls Bedrock `amazon.titan-embed-text-v2:0` (1024 dims, normalised), and appends new rows to `document_embeddings` Parquet under `s3://agora-parquet/document_embeddings/`. Cost of a cold full pass over the current corpus: <$1; incremental weekly cost: pennies.

## Roadmap anchor

`11-roadmap.md` — Phase 5, step 2; `08-llm-layer.md` §6; `05-ingestion.md` §9.

## Prerequisites

- PR-06 deployed; `document_chunks` Parquet exists and has rows (chunking happens inside the `transform` Lambda when a new `doc-text` manifest arrives).
- PR-00 Bedrock model access for `amazon.titan-embed-text-v2:0` has been **granted** in `eu-north-1`. Inspect via `aws bedrock list-foundation-models --region eu-north-1 --by-provider amazon --profile agora-se`; the access status for Titan Embed v2 must read `AVAILABLE`.

## Context

Embeddings power the vector leg of hybrid search (`06-storage-and-api.md` §3.2). We ship with **Amazon Titan Embed v2** at 1024 dimensions for three reasons (`08-llm-layer.md` §2.1): it handles Swedish well, it is cheap (~$0.02 / 1M input tokens), and it lives in the same AWS account as the rest of the stack (no third-party key management).

Embedding is **offline** — the API Lambda never embeds documents at request time, only the user's query. This PR owns the offline path.

Chunking itself lives in `transform` (PR-06): `document_chunks` rows are produced there with `(dok_id, chunk_index, text, tokens_est)` but no embedding. This PR is the downstream step that fills in the vector.

### Embedding schema

`document_embeddings` Parquet shape (`04-data-model.md`):

| Column | Type | Notes |
|---|---|---|
| `dok_id`         | STRING  | matches `document_chunks.dok_id` |
| `chunk_index`    | INT32   | matches `document_chunks.chunk_index` |
| `model_id`       | STRING  | `amazon.titan-embed-text-v2:0` (captured so a model swap doesn't silently mix vectors) |
| `dim`            | INT32   | `1024` |
| `embedding`      | LIST<FLOAT> | 1024 floats, L2-normalised |
| `embedded_at`    | TIMESTAMP | UTC |

The `(dok_id, chunk_index, model_id)` triple is the logical primary key. When `model_id` bumps, every chunk is re-embedded — a fresh Parquet file is written per model, and search reads the latest `model_id` only.

## Scope / Deliverables

### 1. Package layout

```
iac/lambda/embed-chunks/
  Dockerfile
  requirements.txt        # boto3, duckdb, pyarrow, numpy
  src/
    handler.py
    bedrock.py            # invoke_model wrapper with retry
    sink.py               # write Parquet atomically
```

Lambda config: 1536 MB memory, timeout 15 min, ephemeral `/tmp` 2 GB. ARM64.

### 2. Handler

Pseudocode:

```python
MODEL_ID = "amazon.titan-embed-text-v2:0"
BATCH = 25                   # Bedrock Titan accepts one text per call; batch is client-side fan-in
LIMIT = int(os.environ.get("CHUNK_LIMIT", "2000"))

def handler(event, context):
    con = boot_duckdb()
    rows = con.execute(f"""
      SELECT dc.dok_id, dc.chunk_index, dc.text
        FROM document_chunks dc
   LEFT JOIN document_embeddings de
          ON de.dok_id = dc.dok_id
         AND de.chunk_index = dc.chunk_index
         AND de.model_id = '{MODEL_ID}'
       WHERE de.dok_id IS NULL
       LIMIT {LIMIT}
    """).fetchall()

    vectors = []
    for chunk in batched(rows, BATCH):
        for (dok_id, chunk_index, text) in chunk:
            vec = invoke_titan(text)      # 1024 floats, normalised
            vectors.append({
                "dok_id": dok_id,
                "chunk_index": chunk_index,
                "model_id": MODEL_ID,
                "dim": 1024,
                "embedding": vec,
                "embedded_at": now_utc(),
            })
    if vectors:
        write_parquet_append("document_embeddings", vectors)
        update_success_sentinel("document_embeddings")
    write_audit_row(ingestion_runs, source="embed-chunks",
                    rows_written=len(vectors), model_id=MODEL_ID)
    return {"embedded": len(vectors)}
```

Partial failures inside `invoke_titan` (throttling, 5xx) retry with exponential backoff up to 4 attempts. Hard failure aborts the run after writing what succeeded — the next scheduled run picks up the rest.

`CHUNK_LIMIT` default 2000 gives headroom for the full weekly backlog while keeping any single run bounded. A cold full rebuild is orchestrated by a manual invocation with `event = {"chunk_limit": 100000}` (see manual steps).

### 3. Bedrock invocation

```python
import boto3, json, numpy as np

bedrock = boto3.client("bedrock-runtime", region_name=os.environ["AWS_REGION"])

def invoke_titan(text: str) -> list[float]:
    resp = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "inputText": text,
            "dimensions": 1024,
            "normalize": True,
        }).encode(),
    )
    payload = json.loads(resp["body"].read())
    vec = np.array(payload["embedding"], dtype=np.float32)
    # Defensive re-normalise — Bedrock normalizes, but floats drift slightly.
    vec = vec / np.linalg.norm(vec)
    return vec.tolist()
```

Rate considerations: Titan v2 has a soft TPS cap per account. The default is typically 100 rps which is more than enough for this workload (~2000 chunks × 0.1 s = 200 s total per run).

### 4. Parquet append strategy

`document_embeddings/` is non-partitioned at MVP (small enough). Each run writes `part-<timestamp>-<uuid>.parquet`, then rewrites `_SUCCESS.json` listing every current part file. The API Lambda's warm-start loader reads the manifest and concatenates.

When `model_id` changes: delete old part files after the new model's embeddings have all been written. An ops flag on the handler `event = {"purge_model_id": "amazon.titan-embed-text-v2:0"}` does this purge explicitly; the scheduled run never purges.

### 5. Scheduling

EventBridge rule `agora-embed-chunks-weekly`, cron `cron(0 2 ? * SUN *)` (Sunday 02:00 UTC). Target: the Lambda with an empty payload.

### 6. IAM

`AgoraEmbedChunksRole`:

- `s3:GetObject` on `agora-parquet/document_chunks/*` and `agora-parquet/document_embeddings/*`.
- `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on `agora-parquet/document_embeddings/*`.
- `bedrock:InvokeModel` resource-scoped to `arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0`.
- `dynamodb:PutItem` on `agora_ingestion_runs`.
- Base Lambda logging + CloudWatch EMF metrics.

### 7. Metrics

Emit EMF metrics into namespace `Agora`:

- `EmbedChunksWritten` (count), dim `model_id`.
- `EmbedTokensInput` (sum) — important for Bedrock cost tracking and for the PR-11 `BedrockMonthlyTokenCap` alarm that watches `LlmTokensInput` (embed + LLM combined).
- `EmbedDurationMs` (avg).
- `EmbedErrors` (count).

### 8. Tests

- Unit test on `invoke_titan` with a stubbed `bedrock-runtime` — assert payload shape and output length = 1024.
- Integration test (manual): invoke against a small test chunk set; verify rows land in Parquet and search Lambda picks them up.

## Manual steps

1. **Confirm Bedrock access for Titan Embed v2.** PR-00 requested it; if approval is still pending, wait. Without approval this PR's first run errors with `AccessDeniedException`.
2. **Kick off a cold full pass.** After the first `cdk deploy` of this PR's update to `AgoraDataStack`:

   ```bash
   aws lambda invoke \
     --profile agora-se --region eu-north-1 \
     --function-name agora-embed-chunks \
     --payload '{"chunk_limit": 100000}' \
     --cli-binary-format raw-in-base64-out \
     out.json
   cat out.json  # expect {"embedded": <some thousands>}
   ```

   This one-off pass embeds the existing chunk corpus (~20–50k rows). Budget ~$0.20–$1. After it finishes, the weekly scheduled run only picks up deltas.
3. **Verify the embedding matrix is reachable.** From a laptop with AWS credentials:

   ```bash
   aws s3 ls s3://agora-parquet-<acct>/document_embeddings/
   ```

   Multiple `part-*.parquet` files and a `_SUCCESS.json` listing them should be present.

## Acceptance criteria

- [ ] `cdk deploy AgoraDataStack` exits 0; `embed-chunks` Lambda + EventBridge rule visible.
- [ ] A manual invocation with `{"chunk_limit": 100}` completes `SUCCEEDED` with `embedded: 100` in the response, and `agora-parquet/document_embeddings/` contains a new Parquet file.
- [ ] A second manual invocation returns `embedded: 0` if no new chunks have arrived — i.e. the LEFT JOIN filter correctly excludes already-embedded rows.
- [ ] The EventBridge rule is enabled with `cron(0 2 ? * SUN *)`.
- [ ] DuckDB can query `document_embeddings`:

  ```sql
  SELECT dim, COUNT(*) FROM read_parquet('s3://…/document_embeddings/part-*.parquet') GROUP BY 1;
  ```

  returns `(1024, N)` where `N ≥ 1`.
- [ ] EMF metric `EmbedChunksWritten` visible in CloudWatch for namespace `Agora`.
- [ ] `ingestion_runs` contains a row with `source="embed-chunks"` after every invocation.

## Out of scope

- Re-embedding on model upgrade — that is a manual one-off operation triggered with an event payload (see §4), not scheduled.
- Embedding `manifesto_statements` text — deferred; only `document_chunks` are embedded at MVP. Revisit if accountability precision suffers on Layer 1 unknown-topic fallback (`08-llm-layer.md` §4.1).
- Speeches embeddings. Speeches are metadata-only at MVP.
- An incremental re-chunk pass when the chunking code in `transform` changes. Operationally: bump `model_id` or add a suffix if chunk semantics change; the code is out of scope here.
