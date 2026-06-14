# PR-14 — `AgoraLlmStack` (async accountability synthesis)

## Outcome

`AgoraLlmStack` deployed: one SQS queue `agora-accountability-queue` + DLQ, one `enqueue-accountability` Python Lambda (tiny, API-facing), one `llm-acc` Python container Lambda (3 GB, SQS-triggered worker), the `agora_accountability_cache` + `agora_accountability_jobs` DynamoDB tables wired to both, and the `topic_to_cmp.yaml` / `topic_to_uo.yaml` topic-mapping files. `POST /v1/accountability` returns `202 Accepted` on miss, `200 OK` on cache hit. `GET /v1/accountability/jobs/{job_id}` polls. The `/ansvar` dashboard page is wired end-to-end and renders a cited ~150-word Swedish report with per-layer evidence tables.

## Roadmap anchor

`11-roadmap.md` — Phase 6 (3 days); `08-llm-layer.md` §4; `06-storage-and-api.md` §5.

## Prerequisites

- PR-13 (llm-read is already live; shared Python modules exist under `iac/lib/python-shared/`).
- PR-07 (`derive` Lambda has produced `party_cohesion`, `votes_wide`, `budget_by_area`, `manifesto_by_category`).
- DynamoDB tables `agora_accountability_cache` and `agora_accountability_jobs` exist (created in PR-02).
- Bedrock Claude Haiku access granted.

## Context

Accountability is **the centerpiece** of Agora (`08-llm-layer.md` §4 opening line). It is the only endpoint that fuses the four data layers — party manifestos (promises), motions (action), votes (roll-call behaviour), budget outturns (resources) — into one cited narrative for a `(party, topic, period)` triple. Without it, the product is "a better riksdagen.se search"; with it, it is a transparency product.

The endpoint is **async** because a cache miss runs four DuckDB queries over Parquet plus one Bedrock call with ~4 KB of context — 5–10 s wall-clock that would risk API Gateway's 30 s timeout under load. The 202-then-poll pattern is documented in `06-storage-and-api.md` §5.2.

Cache semantics (`06-storage-and-api.md` §5.4):

- 7-day TTL.
- Hash-based invalidation on the four-bundle input (new motion / new vote / new budget row busts the cache).
- Prompt-version-bumped on change.

This PR replaces the 501 stub on `POST /v1/accountability` that was emplaced in PR-08 and leaves the `/v1/accountability/jobs/{job_id}` poll route — which was already wired to the hot-path `api` Lambda in PR-08 — functional now that the jobs table is being written.

## Scope / Deliverables

### 1. New CDK stack: `AgoraLlmStack`

Depends on `AgoraDataStack` (for Parquet bucket), `AgoraApiStack` (for the HTTP API to attach routes to), `AgoraObsStack` (for SNS alerts, SSM kill-switch). Create `iac/lib/stacks/llm-stack.ts`; register in `iac/bin/agora.ts`.

```
AgoraLlmStack
├── SQS queue: agora-accountability-queue (+ DLQ)
├── Lambda: enqueue-accountability (Python 3.12, 512 MB, 10 s)
├── Lambda: llm-acc (Python 3.12 container, 3008 MB, 10 min, reserved concurrency 2)
├── Route: POST /v1/accountability   → enqueue-accountability
├── Event source mapping: queue → llm-acc (batchSize 1)
└── CloudWatch metrics + alarms (see PR-11 §AccountabilityJob*)
```

### 2. `agora-accountability-queue`

- Standard queue, not FIFO.
- `VisibilityTimeout = 600 s` (matches Lambda timeout + buffer).
- `MessageRetentionPeriod = 4 h`.
- `ReceiveMessageWaitTimeSeconds = 20` (long poll).
- DLQ `agora-accountability-dlq` after 3 failures; retention 14 days.

### 3. `enqueue-accountability` Lambda

Thin, Python-only (no container image). Packages: `boto3`, nothing else.

Flow per `06-storage-and-api.md` §5.2:

```python
def handler(event, _ctx):
    body = json.loads(event["body"])
    party = body["party"]
    topic = body["topic"].strip().lower()
    frm = body["from"]           # YYYY-MM-DD
    to  = body["to"]

    # Validate
    if party not in VALID_PARTIES: return problem(400, "Ogiltigt parti")
    if not is_date(frm) or not is_date(to): return problem(400, "Ogiltiga datum")
    if date(to) <= date(frm):  return problem(400, "Till-datum före från-datum")

    topic_hash  = sha256(topic)[:12]
    period_hash = sha256(f"{frm}#{to}")[:12]
    cache_pk    = f"{party}#{topic_hash}#{period_hash}"
    input_hash  = compute_input_hash(party, topic, frm, to)   # hashes the four-bundle query inputs

    # 1. cache hit
    cached = ddb.get_item(Table="agora_accountability_cache",
                         Key={"pk": {"S": cache_pk}}).get("Item")
    if cached and cached["input_hash"]["S"] == input_hash and not expired(cached):
        return respond(200, cached_to_public(cached))

    # 2. enqueue
    job_id = str(uuid4())
    ddb.put_item(Table="agora_accountability_jobs", Item=to_ddb({
        "job_id": job_id,
        "cache_pk": cache_pk,
        "input_hash": input_hash,
        "state": "queued",
        "progress_pct": 0,
        "created_at": now_iso(),
        "party": party, "topic": topic, "from": frm, "to": to,
        "ttl": int(time.time()) + 4*3600,
    }))
    sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps({"job_id": job_id, "cache_pk": cache_pk,
                                "party": party, "topic": topic,
                                "from": frm, "to": to, "input_hash": input_hash}),
    )
    return respond(202, {
        "job_id": job_id,
        "poll_url": f"/v1/accountability/jobs/{job_id}",
        "estimated_wait_ms": 8000,
    }, headers={"Location": f"/v1/accountability/jobs/{job_id}"})
```

### 4. `llm-acc` Lambda (worker)

Python 3.12 container image. 3008 MB memory, 10 min timeout, `/tmp` 4 GB, reserved concurrency 2 (prevents a misbehaving client from running up the Bedrock bill faster than PR-11 alarms can fire).

```
iac/lambda/llm-acc/
  Dockerfile
  requirements.txt      # boto3, duckdb, pyarrow, numpy
  src/
    handler.py
    bundle.py           # four-layer retrieval
    prompt.py           # renders + invokes Claude
    validate.py         # hallucination checks
    topics.py           # topic_to_cmp, topic_to_uo lookups + embedding fallback
  prompts/
    ansvarsutkravande.v2.sv.md
  mappings/
    topic_to_cmp.yaml   # Swedish topic → Manifesto Project category codes
    topic_to_uo.yaml    # Swedish topic → expenditure area codes
```

Handler loop:

```python
def handler(event, _ctx):
    for rec in event["Records"]:
        msg = json.loads(rec["body"])
        run_job(msg)

def run_job(msg):
    job_id = msg["job_id"]
    write_job(job_id, state="running", progress=5)

    try:
        bundle = fetch_bundle(msg)                # 4 DuckDB queries
        write_job(job_id, progress=50)
        report = invoke_accountability(bundle, msg)  # 1 Bedrock call
        if not validate_report(report, bundle):
            write_job(job_id, state="failed",
                      reason="validation", progress=100)
            emf("AccountabilityJobFailures", 1, dim={"reason": "validation"})
            return
    except BedrockNotEnabled:
        write_job(job_id, state="failed", reason="bedrock_disabled")
        return
    except Exception as e:
        write_job(job_id, state="failed", reason=str(e)[:200])
        emf("AccountabilityJobFailures", 1, dim={"reason": "exception"})
        raise  # let SQS retry / eventually DLQ

    # 3. write cache
    ddb.put_item(Table="agora_accountability_cache", Item=to_ddb({
        "pk":              msg["cache_pk"],
        "input_hash":      msg["input_hash"],
        "party":           msg["party"],
        "topic":           msg["topic"],
        "from":            msg["from"],
        "to":              msg["to"],
        "report_sv":       report,
        "bundle":          bundle_for_display(bundle),
        "model_id":        MODEL_ID,
        "prompt_version":  PROMPT_VERSION,
        "generated_at":    now_iso(),
        "ttl":             int(time.time()) + 7*86400,
    }))
    write_job(job_id, state="done", result_pk=msg["cache_pk"], progress=100)
    emf("AccountabilityJobDurationMs", job_duration())
```

### 5. Four-layer retrieval (`bundle.py`)

Implement the four SQL queries from `08-llm-layer.md` §4.1 verbatim against the DuckDB view layer. Each layer is bounded (20 manifesto statements, 10 motions, 10 votes, all budget years in period). Combined JSON rarely exceeds 8 KB.

Topic → Manifesto Project category code mapping (`topic_to_cmp.yaml`):

```yaml
förskola:           [per506]                     # Education Expansion
skola:              [per506, per507]
skatt:              [per402, per503]
barnomsorg:         [per506]
försvar:            [per104, per105]
klimat:             [per416]
miljö:              [per416, per501]
sjukvård:           [per504]
...  # ~40 entries — cover the Swedish civic vocabulary the maintainer expects
```

Topic → expenditure area code mapping (`topic_to_uo.yaml`):

```yaml
förskola:        [UO16, UO25]
skola:           [UO16, UO25]
sjukvård:        [UO09]
försvar:         [UO06]
klimat:          [UO20]
miljö:           [UO20]
infrastruktur:   [UO22]
...
```

Unknown topic → compute query embedding, cosine-match against `manifesto_statements.embedding` (pre-computed in a future PR; for MVP this fallback returns the top-10 statements by BM25 over `manifesto_statements.text` using DuckDB FTS).

### 6. Prompt

Copy the exact prompt text from `08-llm-layer.md` §4.2 into `prompts/ansvarsutkravande.v2.sv.md`. Prompt version = `ansvarsutkravande.v2-<sha8>`. Served publicly at `/metodik/ansvarsutkravande` on the dashboard (replace PR-09's stub).

### 7. Output validation (`validate.py`)

Per `08-llm-layer.md` §4.3:

1. Total word count ≤ 180.
2. At least one `dok_id` cited in the `Källor:` line.
3. Every cited `dok_id` appears in the input `MOTIONS_JSON` or `VOTES_JSON` (no hallucinated ids).
4. No four-digit-or-longer number in the output that does not appear in the input JSON (catches fabricated figures).
5. ≥ 85% of non-whitespace characters are Swedish alphabet or digits.

On validation failure: `state=failed` with reason, no cache write, no retry.

### 8. Bedrock invocation

Shared wrapper in `iac/lib/python-shared/bedrock.py` (reused by PR-13's `llm-read`). Temperature 0.2; `max_tokens` 400; `anthropic_version: bedrock-2023-05-31`. Record `LlmTokensInput` / `LlmTokensOutput` on every call.

### 9. Poll route wiring

`GET /v1/accountability/jobs/{job_id}` already routes to the hot-path `api` Lambda (PR-08). The handler there reads `agora_accountability_jobs` → if `state=done`, also loads `agora_accountability_cache` by `result_pk` and returns the merged payload:

```json
{
  "job_id":       "…",
  "state":        "done",
  "progress_pct": 100,
  "report_sv":    "…150 ord…",
  "bundle":       { "manifesto": [...], "motions": [...], "votes": [...], "budget": [...] },
  "model_id":     "anthropic.claude-3-haiku-20240307-v1:0",
  "prompt_version": "ansvarsutkravande.v2-abcd1234",
  "generated_at": "2026-04-20T12:00:00Z",
  "sources":      [ { "label": "Motion HB02MOT1234", "url": "…" } ]
}
```

Cache-Control for this route: `no-store` (it's polled every 1–2 s).

### 10. Dashboard `/ansvar` page

Replace PR-09's "kommer snart" stub with the live flow:

- **Picker**: `<Select>` party (from `/v1/members` distinct parties), `<Input>` topic (free-text), `<DateRangePicker>` period (default last 4 years to today).
- **Submit** → `POST /v1/accountability`. On `200`, render directly. On `202`, poll `/v1/accountability/jobs/{job_id}` every 1.5 s with a progress bar showing `progress_pct`.
- **Report view**:
  - `report_sv` rendered as three paragraphs with source chips.
  - Beneath it, four collapsible evidence tables — one per layer — with links to original documents (`source_url` on every row).
  - AI chip + timestamp + model + "Prompt"-link + `Rapportera` mailto.
- **Error states**: 503 (Bedrock down) → show the raw four-layer bundle as a fallback with a "Syntes tillfälligt otillgänglig" banner. 501 (Bedrock disabled) → "Ansvarsutkrävande är tillfälligt inaktiverat".

The component uses the `lib/api.ts` helpers from PR-09; no new fetch infra.

### 11. SSM kill switch

Honour `/agora/llm/enabled` (from PR-11): if `"false"`, `enqueue-accountability` returns `503` immediately without writing a job. The `llm-acc` worker also checks before the Bedrock call and `state=failed` with reason `"disabled"` if flipped mid-run.

### 12. IAM

`AgoraEnqueueAccountabilityRole`:

- `dynamodb:GetItem`, `PutItem` on `agora_accountability_cache`, `agora_accountability_jobs`.
- `sqs:SendMessage` on `agora-accountability-queue`.
- `ssm:GetParameter` on `/agora/llm/*`.
- Base Lambda logging.

`AgoraLlmAccRole`:

- `s3:GetObject` on `agora-parquet/*`.
- `bedrock:InvokeModel` on Claude Haiku + Titan Embed v2.
- `dynamodb:PutItem`, `UpdateItem` on both accountability tables.
- `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on the queue; `SendMessage` on the DLQ.
- `ssm:GetParameter` on `/agora/llm/*`.
- Base Lambda logging + EMF.

### 13. Metrics

Emit to namespace `Agora`:

- `AccountabilityJobDurationMs` (avg, p95).
- `AccountabilityJobFailures` (dim `reason`: `validation`, `exception`, `bedrock_disabled`).
- `AccountabilityCacheHit`, `AccountabilityCacheMiss`.
- `LlmTokensInput`, `LlmTokensOutput` (shared with PR-13).

PR-11 alarms `AccountabilityJobDurationP95High` (>15 s, 15-min window) and `AccountabilityJobFailuresHigh` (≥3 in 1 h) consume these — they were defined as noop in PR-11 and now begin receiving data.

### 14. Tests

- Unit: `validate_report` — passes on a clean report; fails on hallucinated `dok_id`; fails on fabricated four-digit number; fails on >180 words.
- Unit: `compute_input_hash` — order-independent for the four-bundle input.
- Integration: enqueue a request for a known-populated `(party, topic, period)`; assert job transitions `queued → running → done` within 30 s on warm Lambda and that the poll payload passes all validators.
- Integration: second request for the same inputs returns `200` (cache hit) in ≤100 ms.
- Integration: request for an unknown topic returns a report that falls back via BM25 embedding-match (`topics.py` fallback path).

## Manual steps

1. **Populate the mapping YAMLs.** `topic_to_cmp.yaml` and `topic_to_uo.yaml` ship with ~40 Swedish-vocab entries. Expect to iterate on these during Phase 6 QA — a topic the user types (`"SL-kort"`) that isn't mapped uses the embedding fallback, which is noisier. Watch CloudWatch for `AccountabilityJobFailures{reason=validation}` spikes after launch, which often point to a missing mapping.
2. **First end-to-end dry run.** After deploy, from a laptop:

   ```bash
   curl -s -X POST https://<cloudfront>/v1/accountability \
     -H 'content-type: application/json' \
     -d '{"party":"S","topic":"förskola","from":"2022-09-01","to":"2026-09-01"}' \
     | tee resp.json
   # -> expect 202 with job_id

   job_id=$(jq -r .job_id resp.json)
   for i in $(seq 1 20); do
     curl -s https://<cloudfront>/v1/accountability/jobs/$job_id | jq '.state, .progress_pct'
     sleep 2
   done
   # final curl returns state=done with a 150-word report + four evidence arrays
   ```

3. **Verify caching.** Immediate re-submit of the same inputs should return `200` (not `202`) with the cached report body.
4. **Force invalidation.** Add a new row to `vote_results` for the party/period (or wait for daily ingest) → `input_hash` shifts → next submit returns `202` even if the cached report is age-fresh.
5. **Prompt page.** Verify `https://<domain>/metodik/ansvarsutkravande` renders the live prompt text identical to `prompts/ansvarsutkravande.v2.sv.md`.

## Acceptance criteria

- [ ] `cdk deploy AgoraLlmStack` exits 0; SQS queue, DLQ, two Lambdas, event source mapping all visible.
- [ ] `POST /v1/accountability` with a valid body returns `202 Accepted` with a `job_id` and `Location` header within 300 ms.
- [ ] `GET /v1/accountability/jobs/{job_id}` returns `state=done` within 15 s end-to-end on a cold Lambda, within 8 s on a warm one.
- [ ] The `report_sv` in the done payload passes every rule in §7.
- [ ] The `/ansvar` dashboard page submits, polls, and renders a cited report for `(S, förskola, 2022–2026)`.
- [ ] A synthetic invalid input (`"party":"XYZ"`) returns `400` with an RFC 7807 error body.
- [ ] A Bedrock-disabled test (SSM `/agora/llm/enabled=false`) returns `503` immediately on submit; restoring to `true` restores the flow.
- [ ] `agora-accountability-dlq` is empty 24 h after deploy.
- [ ] EMF metrics `AccountabilityJobDurationMs`, `AccountabilityCacheHit` visible in CloudWatch.

## Out of scope

- A "compare two parties" endpoint. Rejected by `08-llm-layer.md` §9.
- Serving the four-bundle evidence separately from the synthesised report. The evidence is returned alongside the report; it is not its own endpoint.
- Per-topic prompt variants. One prompt, one version, four layers.
- Auto-tuning of the `topic_to_cmp` / `topic_to_uo` maps. Humans edit YAML; changes ship via PR.
- A public "list all cached reports" route. Privacy + cache eviction surface area; not worth it for Phase 6.
- Multi-language accountability. Swedish only at MVP. English may land in a post-MVP PR; the prompt is the translation unit.
