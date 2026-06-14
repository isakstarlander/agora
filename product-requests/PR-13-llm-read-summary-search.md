# PR-13 — `llm-read` Lambda (summarise + hybrid search)

## Outcome

Two production endpoints are live:

- `POST /v1/summarise` — given a `dok_id`, returns a neutral 3-sentence Swedish summary in ≤3 s warm (cached ≤10 ms), with cite-or-fail validation.
- `POST /v1/search` — hybrid BM25 + cosine search over the full document corpus, returning ranked `documents` rows with per-leg sub-scores. ~300–800 ms warm.

Both are served by a single Python 3.12 ARM64 container Lambda `llm-read`, wired to API Gateway inside `AgoraApiStack`. The accountability route remains 501 until PR-14 ships.

## Roadmap anchor

`11-roadmap.md` — Phase 5 (3 days); `08-llm-layer.md` §§3, 5; `06-storage-and-api.md` §§3, 4.

## Prerequisites

- PR-08 (API Gateway + hot-path `api` Lambda already serving read routes).
- PR-12 (embeddings exist in `s3://agora-parquet/document_embeddings/`).
- PR-00 Bedrock model access granted for `anthropic.claude-3-haiku-20240307-v1:0` and `amazon.titan-embed-text-v2:0`.
- The `agora_summary_cache` DynamoDB table (created in PR-02) exists.

## Context

`08-llm-layer.md` §3 defines the summary endpoint. `08-llm-layer.md` §5 + `06-storage-and-api.md` §3 define hybrid search. Both live in **one** Lambda (`llm-read`) to amortise the Bedrock + embedding-matrix cold-start cost across both endpoints, and to keep the dedicated hot-path `api` Lambda (from PR-08) slim.

The core invariants to hold:

1. **Cite-or-fail on summaries** (`08-llm-layer.md` §7.1). Output validator discards bad outputs before caching.
2. **The search path does not generate prose** (`08-llm-layer.md` §5.3). Queries produce an embedding vector and nothing else; results are structured rows.
3. **Bedrock failures degrade gracefully** (`08-llm-layer.md` §7). Quota exceeded → 503 with `source_url`; Bedrock not enabled → 501. Search falls back to FTS-only with `X-Agora-Degraded: 1`.
4. **Search weighting: 40% FTS + 60% cosine** (`06-storage-and-api.md` §3.2). Tie-breaker `datum DESC`.

## Scope / Deliverables

### 1. Package layout

```
iac/lambda/llm-read/
  Dockerfile
  requirements.txt   # boto3, duckdb, pyarrow, numpy
  src/
    handler.py       # router: /v1/summarise, /v1/search
    summarise.py
    search.py
    bedrock.py
    matrix.py        # lazy-loaded numpy embedding matrix
    duck.py          # shares bootstrap with `api`
    validate.py      # shared output-validation helpers
  prompts/
    sammanfattning.v3.sv.md
    stopwords.sv.txt
```

Lambda config: 2048 MB memory (for the embedding matrix), timeout 30 s, ephemeral `/tmp` 2 GB. ARM64. Reserved concurrency: 5 (backstop against runaway spend if WAF fails).

### 2. Shared DuckDB bootstrap

Reuse `iac/lambda/api/src/duck.py` verbatim — same view layer, same FTS indexes. When this Lambda warms, `get_duck()` builds the exact same in-memory structure the `api` Lambda has. Put the shared module under `iac/lib/python-shared/` and COPY into both Dockerfiles.

### 3. `POST /v1/summarise`

Flow per `08-llm-layer.md` §3:

```python
def summarise(body):
    dok_id = body["dok_id"]
    model_id = os.environ.get("SUMMARY_MODEL_ID",
                              "anthropic.claude-3-haiku-20240307-v1:0")
    pk = f"{dok_id}#{model_id}"

    # 1. cache check
    cached = ddb.get_item(Table="agora_summary_cache",
                         Key={"pk": {"S": pk}}).get("Item")
    if cached and fresh(cached):
        emf("SummaryHit", 1)
        return envelope(cached, status=200)

    # 2. body fetch
    try:
        raw = s3.get_object(Bucket=BUCKET_RAW,
                            Key=f"riks/document-text/{dok_id}.txt.gz")["Body"].read()
        text = gzip.decompress(raw).decode("utf-8")[:10_000]
    except s3.exceptions.NoSuchKey:
        return problem(404, "Dokumenttext saknas",
                       "Dok_id finns inte i doc-text spegeln.")

    # 3. bedrock
    try:
        summary = invoke_claude(model_id, render_prompt(text))
    except BedrockNotEnabled:
        return problem(501, "LLM ej aktiverad",
                       source_url=doc_source_url(dok_id))
    except BedrockThrottled:
        emf("SummaryFailures", 1, dim={"reason": "throttle"})
        return problem(503, "LLM överbelastad",
                       source_url=doc_source_url(dok_id))

    # 4. validate
    if not validate_summary(summary):
        emf("SummaryFailures", 1, dim={"reason": "validation"})
        return problem(503, "LLM-utdata ogiltig",
                       source_url=doc_source_url(dok_id))

    # 5. cache + return
    row = {
        "pk":              pk,
        "dok_id":          dok_id,
        "summary_sv":      summary,
        "citations":       [{"label": "Motionstext", "url": doc_source_url(dok_id)}],
        "model_id":        model_id,
        "prompt_version":  PROMPT_VERSION,
        "generated_at":    now_iso(),
        "source_url":      doc_source_url(dok_id),
        "ttl":             int(time.time()) + 365*86400,
    }
    ddb.put_item(Table="agora_summary_cache", Item=to_ddb(row))
    emf("LlmTokensInput",  tokens_in(text))
    emf("LlmTokensOutput", tokens_out(summary))
    return envelope(row, status=200)
```

Synchronous by design (Haiku warm ≤2 s, well under API Gateway's 30 s).

### 4. Summary prompt

Copy the exact prompt text from `08-llm-layer.md` §3.1 into `prompts/sammanfattning.v3.sv.md`. The prompt version string is the SHA-256 prefix of the file contents (`sammanfattning.v3-<sha8>`). Bumping the file changes the version, which invalidates cached rows (by way of `cache_pk` including `model_id`; prompt changes alone don't bust — but a `model_id` bump does).

If you change the prompt **semantically**, bump the filename to `v4` and the env var `PROMPT_VERSION`. Cached rows with `prompt_version != current` are ignored (fall-through path re-summarises).

Published publicly at `https://<domain>/metodik/sammanfattning` (PR-09 has the Swedish stub page; this PR fills in the live text by copying the same `.md` into `web/content/metodik/sammanfattning.sv.md` and swaps the "kommer snart" message for the content).

### 5. Summary output validation

Per `08-llm-layer.md` §7.1 — discard if any of:

- More than 5 sentences.
- Contains HTML tags (`<[^>]+>`).
- Contains any stop-word from `prompts/stopwords.sv.txt` (value-laden terms like `katastrofal`, `beundransvärd`, `fantastisk`, `skamlig`).
- Fewer than 85% non-whitespace Swedish-alphabet characters.

Ship `stopwords.sv.txt` with ~30 entries. The list is editable in place and not considered a prompt-version bump.

### 6. `POST /v1/search`

Flow per `06-storage-and-api.md` §3.2:

```python
def search(body):
    q = body["q"][:200]  # hard cap on query length
    doktyp = body.get("doktyp")
    rm = body.get("rm")
    limit = min(int(body.get("limit", 20)), 50)

    # 1. embedding
    try:
        qvec = invoke_titan(q)        # 1024-dim normalised float32
    except BedrockNotEnabled:
        qvec = None                    # FTS-only fallback
    except BedrockThrottled:
        qvec = None

    # 2. FTS
    fts = con.execute("""
        SELECT dok_id, titel, undertitel, datum, doktyp, rm,
               fts_main_documents.match_bm25(dok_id, ?) AS fts_score
          FROM documents
         WHERE (? IS NULL OR doktyp = ANY(?))
           AND (? IS NULL OR rm = ?)
         ORDER BY fts_score DESC
         LIMIT 200
    """, [q, doktyp, doktyp, rm, rm]).fetchall()

    # 3. vector (only if we have qvec)
    if qvec is not None:
        matrix, meta = get_embedding_matrix()   # warm-cached
        scores = matrix @ qvec                  # (N,) float32 — cosine since both normalised
        idx = topk_filtered(scores, meta,
                            doktyp=doktyp, rm=rm, k=200)
        vec = [(meta[i]["dok_id"], float(scores[i])) for i in idx]
    else:
        vec = []

    # 4. combine
    combined = combine_scores(fts, vec, w_fts=0.4, w_vec=0.6)

    # 5. hydrate top-`limit`
    hit_ids = [r["dok_id"] for r in combined[:limit]]
    rows = con.execute(f"""
        SELECT dok_id, titel, undertitel, datum, doktyp, rm, url_html
          FROM documents
         WHERE dok_id IN ({placeholders(hit_ids)})
    """, hit_ids).df()

    headers = {}
    if qvec is None:
        headers["X-Agora-Degraded"] = "1"

    return envelope({
        "items": [merge(row, score) for row, score in zip(rows, combined)],
        "next_cursor": None,       # search is top-K, no pagination
        "fetched_at": now_iso(),
        "source": "hybrid-search",
    }, headers=headers, cache_ttl=900)
```

Score combiner:

```python
def combine_scores(fts, vec, w_fts, w_vec):
    # normalise each leg to [0, 1] by dividing by the leg's top score
    fts_top = max((r["fts_score"] for r in fts), default=1.0)
    vec_top = max((s for _, s in vec), default=1.0)
    fts_norm = {r["dok_id"]: r["fts_score"] / fts_top for r in fts}
    vec_norm = {d: s / vec_top for d, s in vec}
    all_ids = set(fts_norm) | set(vec_norm)
    out = [{
        "dok_id":     d,
        "fts_score":  fts_norm.get(d, 0),
        "vec_score":  vec_norm.get(d, 0),
        "score":      w_fts*fts_norm.get(d, 0) + w_vec*vec_norm.get(d, 0),
    } for d in all_ids]
    out.sort(key=lambda r: (-r["score"], -row_datum(r["dok_id"])))
    return out
```

Per-leg sub-scores are included in the response but hidden by the dashboard by default (shown behind a `?debug=1` query param).

### 7. Embedding matrix loader

`matrix.py` holds a module-level `_matrix: np.ndarray | None = None` and a `_meta: list[dict] | None = None`. `get_embedding_matrix()`:

1. If `_matrix` is not None, return it.
2. Read `s3://agora-parquet/document_embeddings/_SUCCESS.json` to get the list of live part files.
3. Read them with `pyarrow.parquet.read_table(..., columns=["dok_id", "chunk_index", "embedding"])`.
4. Stack the embeddings into a single `float32` `(N, 1024)` array.
5. Cache metadata (`[{dok_id, chunk_index}]`) aligned by row index.

At 50k chunks × 1024 dims × 4 bytes ≈ 200 MB, which fits in Lambda's 2048 MB budget alongside the DuckDB workspace.

When `_SUCCESS.json`'s etag changes (tracked in the module), the matrix is invalidated and reloaded on next call.

### 8. Bedrock client

```python
bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)

def invoke_claude(model_id: str, prompt: str) -> str:
    try:
        resp = bedrock.invoke_model(
            modelId=model_id,
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
            }).encode(),
        )
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in ("AccessDeniedException", "ValidationException"):
            raise BedrockNotEnabled() from e
        if code in ("ThrottlingException", "ServiceUnavailableException"):
            raise BedrockThrottled() from e
        raise
    body = json.loads(resp["body"].read())
    return body["content"][0]["text"]

def invoke_titan(text: str) -> np.ndarray:
    # Same shape as PR-12 §3; normalised float32 (1024,).
    ...
```

### 9. Route wiring in `AgoraApiStack`

Add two routes to the existing HTTP API:

- `POST /v1/summarise` → `llm-read` Lambda, `routeKey: 'POST /v1/summarise'`.
- `POST /v1/search`    → `llm-read` Lambda, `routeKey: 'POST /v1/search'`.

Remove the 501 stubs on these routes that PR-08 installed.

### 10. Rate limiting

Enforce the LLM-endpoint quota (`06-storage-and-api.md` §2.6): 20 req / 10 min per `principal_id`. The shared rate-limit helper from PR-08 (`agora_ratelimit_counter` DynamoDB TTL counter) is reused; call with `scope="llm"` so summary + search + accountability share one bucket per caller.

On 429, emit EMF `ApiPrincipalThrottles` with `dim={tier: "free"}`.

### 11. IAM

`AgoraLlmReadRole`:

- `s3:GetObject` on `agora-raw/riks/document-text/*` and `agora-parquet/*`.
- `bedrock:InvokeModel` on both Claude Haiku and Titan Embed v2 model ARNs (scoped per-model).
- `dynamodb:GetItem`, `PutItem` on `agora_summary_cache`; `UpdateItem` on `agora_ratelimit_counter`.
- `dynamodb:PutItem` on `agora_ingestion_runs` (for post-hoc audit rows).
- Base Lambda logging + EMF publish.

### 12. Metrics

Emit to namespace `Agora`:

- `SummaryHit`, `SummaryMiss`, `SummaryFailures` (dim `reason`).
- `SearchFtsOnly` (incremented when `qvec is None`).
- `LlmTokensInput`, `LlmTokensOutput` (from every Bedrock call).
- `LlmLatencyMs` (p50, p95) split by `endpoint` dim.

PR-11's `BedrockMonthlyTokenCap` alarm consumes `LlmTokensInput`.

### 13. Tests

- Unit: `validate_summary` — covers happy path, > 5 sentences, HTML, stop-word, non-Swedish.
- Unit: `combine_scores` — both legs empty, one leg empty, tie-break by datum.
- Integration: invoke locally (SAM or `lambda invoke`) against a real `dok_id`; assert the full envelope shape and that `citations[0].url` is reachable.
- Snapshot: verify API Gateway routes in CDK synth exactly match the three LLM routes (the third, `/v1/accountability`, is still a 501 stub owned by PR-08; this PR does not replace it).

### 14. Methodology pages

Replace the PR-09 stubs with real content:

- `web/content/metodik/sammanfattning.sv.md` — the summarisation prompt verbatim, plus 3 bullets on validation rules and a link to a sample summary.
- `web/content/metodik/sokning.sv.md` — hybrid-search pipeline in plain Swedish (1 page): what BM25 is, what an embedding is, why 40/60, why FTS-only fallback is safe.

Accountability methodology page (`metodik/ansvarsutkravande`) stays as a stub until PR-14.

## Manual steps

1. **Confirm Bedrock access.** `aws bedrock list-foundation-models --region eu-north-1 --by-provider anthropic` must include Claude 3 Haiku with `AVAILABLE`. Same for Titan Embed v2 under `--by-provider amazon`. If `ACCESS_DENIED`, go back to PR-00 and request again.
2. **Smoke-test the summary.** After deploy:

   ```bash
   curl -s -X POST https://<api>/v1/summarise \
     -H 'content-type: application/json' \
     -d '{"dok_id":"<a real dok_id from agora-raw/doc-text/>"}' | jq .
   ```

   Expect a 3-sentence Swedish summary + citations in ≤3 s.
3. **Smoke-test search.**

   ```bash
   curl -s -X POST https://<api>/v1/search \
     -H 'content-type: application/json' \
     -d '{"q":"barnomsorg","limit":5}' | jq '.items[] | {titel, score, fts_score, vec_score}'
   ```

   Expect 5 items; `fts_score` and `vec_score` both populated (non-zero) for at least the top result.
4. **Synthetic Bedrock failure test.** Temporarily revoke Bedrock access for the Lambda's IAM role; call `/v1/summarise` → expect `501`. Call `/v1/search` → expect `200` with `X-Agora-Degraded: 1` header and BM25-only scoring. Restore IAM.

## Acceptance criteria

- [ ] `cdk deploy AgoraApiStack` exits 0.
- [ ] `POST /v1/summarise` with a known `dok_id` returns the `08-llm-layer.md` §3 shape in ≤3 s (warm).
- [ ] A second `POST /v1/summarise` for the same `dok_id` returns in ≤100 ms (DynamoDB cache hit).
- [ ] `POST /v1/search {"q":"…"}` returns ranked items with `fts_score`, `vec_score`, `score` fields; the top item's `score > 0`.
- [ ] `/metodik/sammanfattning` and `/metodik/sokning` on the deployed dashboard render the live methodology text.
- [ ] A summary that fails validation (force-injected by mocking Bedrock to return `<script>alert</script>`) is not cached and returns 503.
- [ ] Hybrid search returns at most `limit` items; when Bedrock is disabled, it still returns items and sets `X-Agora-Degraded: 1`.
- [ ] EMF metrics `LlmTokensInput`, `LlmTokensOutput`, `SummaryHit`, `SearchFtsOnly` visible in CloudWatch.
- [ ] Exceeding 20 req / 10 min from one IP returns `429` with `Retry-After`.

## Out of scope

- Accountability synthesis. PR-14.
- Multi-turn chat. Explicitly rejected (`08-llm-layer.md` §9).
- Fine-tuning or RAG with custom retrievers beyond the four DuckDB queries. The four-layer retrieval is owned by PR-14.
- Model A/B — one model id at a time. Model upgrades flow via env var + cache key invalidation.
- Redirecting the dashboard's existing `<SummaryBlock>` component. The frontend swap is the `web/` part of PR-13 and lives in the same PR commit but the hosting / cache-invalidation is PR-10's responsibility.
