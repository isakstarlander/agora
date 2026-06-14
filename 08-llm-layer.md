# 08 — LLM layer

The LLM layer is small on purpose. It does **three** things: it summarises long documents, it finds documents by natural-language query (hybrid full-text + vector search), and it synthesises a cited accountability report for a `(party, topic, period)` triple. Everything else that a language model could in principle do is explicitly out of scope; see `01-critical-review.md` §5.

## 1. Why we have an LLM layer at all

Without it, a citizen looking at a 40-page proposition is stuck between reading the whole thing and giving up. A neutral 3-sentence opener reduces that friction. Similarly, a citizen whose question is *"Did the government do anything about barnomsorgspeng this year?"* may not know the terms `motion` or `proposition`; hybrid search over titles, bodies, and embeddings lets the site find the right documents without forcing the user to learn parliamentary vocabulary.

The third use — accountability synthesis — directly answers the foundation-document end-goal sentence. It is the only place on the site where manifesto promises, motions, votes, and budget outturns are pre-joined and narratively summarised for one `(party, topic)` pair. Without it, Agora is "a better riksdagen.se search"; with it, it is a transparency product.

All three uses are **bounded and auditable**: every generated output cites the exact sources the user can click to verify, and every prompt is public.

## 2. Provider — Amazon Bedrock

Bedrock is chosen over direct Anthropic/OpenAI APIs because:

- It keeps requests and logs inside AWS, in the same region as our data. Simpler data-residency story for *offentlighetsprincipen*-adjacent content.
- Usage is billed to the same AWS account as everything else; one invoice, one budget alarm.
- We can swap the underlying model by changing one CDK parameter.
- No separate credential store; Lambda uses its IAM role.

### 2.1 Models used

Two models, both on-demand (no provisioned throughput):

**Summarisation and accountability — `anthropic.claude-3-haiku-20240307-v1:0` (or newer small Claude)**

- Fast, inexpensive, neutral when prompted carefully.
- 200k-token context window, which is overkill for per-document summaries (bodies rarely exceed 10k tokens) and comfortable for the accountability 4-bundle input.
- Pricing as of May 2025: ~$0.25 / 1M input tokens, ~$1.25 / 1M output tokens.

**Embeddings — `amazon.titan-embed-text-v2:0`**

- 1024-dimensional embeddings, up to 8,192 input tokens per call.
- Multilingual (130+ languages) — handles Swedish well.
- Pricing as of May 2025: ~$0.02 / 1M input tokens.

**Dimensionality change.** The existing implementation used Voyage AI at 512 dims; we move to Titan Embed v2 at 1024 dims. One-time cost of re-embedding the corpus at cut-over: under $1 (see `05-ingestion.md` §9). Higher dimensionality helps retrieval quality on Swedish text (Voyage is English-strong) and removes the Voyage 3 RPM free-tier ceiling that constrained the existing implementation's re-embedding cadence.

Fallback path: if Bedrock access is not granted in the account or the region, all three LLM endpoints degrade gracefully (see section 7).

## 3. Summary endpoint — `POST /v1/summarise`

Input:

```json
{ "dok_id": "HB02MOT1234" }
```

Output:

```json
{
  "dok_id":       "HB02MOT1234",
  "summary_sv":   "Motionen föreslår att ... . Förslagsställarna argumenterar för att ... . Motionen hänvisas till socialutskottet.",
  "citations":    [
    { "label": "Motionstext", "url": "https://data.riksdagen.se/dokument/HB02MOT1234.html" }
  ],
  "model_id":     "anthropic.claude-3-haiku-20240307-v1:0",
  "prompt_version": "sammanfattning.v3",
  "generated_at": "2026-04-20T12:00:00Z",
  "source_url":   "https://data.riksdagen.se/dokument/HB02MOT1234.html"
}
```

Flow:

1. Lambda `llm-read` looks up `summary_cache` in DynamoDB keyed on `"{dok_id}#{model_id}"`.
2. If present and fresher than 365 days, return synchronously (~10 ms).
3. Otherwise fetch the gzipped body from `s3://agora-raw/doc-text/{dok_id}.txt.gz`.
4. Truncate to 10k characters (very few documents exceed this).
5. Call Bedrock Claude Haiku with the prompt in §3.1.
6. Validate the output (see §7 guardrails). If it fails, return 503 with `source_url`; do not cache.
7. Store the result in `summary_cache` (TTL 365 days).
8. Return.

Synchronous by design — Haiku caps at ~2 s warm for this input size, comfortably below the 30 s API Gateway timeout.

### 3.1 Summarisation prompt

Stored at `iac/lambda/llm/prompts/sammanfattning.v3.sv.md`, versioned in git. Served publicly at `/metodik/sammanfattning`:

```
Du är en neutral och saklig sammanfattare av svenska riksdagsdokument.

Uppgiften: Producera en sammanfattning i exakt tre meningar på svenska.

Krav:
- Första meningen: vad dokumentet föreslår eller behandlar.
- Andra meningen: vem som står bakom och det huvudsakliga argumentet.
- Tredje meningen: hur dokumentet behandlas vidare (utskott, voteringsstatus) om detta framgår, annars utelämna denna mening.

Regler:
- Använd inga värdeladdade ord ("bra", "dålig", "kontroversiell").
- Parafrasera — kopiera inte fraser längre än 5 ord.
- Om dokumentet är för kort för tre meningar, producera så många meningar som rimligt — aldrig fler.
- Producera endast sammanfattningen. Inga inledande fraser som "Här är sammanfattningen:".

Dokumentets text:
---
{DOKUMENT_TEXT}
---
```

## 4. Accountability endpoint — `POST /v1/accountability`

The centerpiece. It synthesises a `(party, topic, period)` triple into a cited ~150-word Swedish report that answers "what did this party promise, propose, vote on, and spend on — regarding this topic, over this period?"

Protocol, caching, and the 202-Accepted async pattern are in `06-storage-and-api.md` §5. This section specifies the **retrieval** of the four-layer bundle and the **prompt** used to synthesise it.

### 4.1 Four-layer retrieval

The `llm-acc` Lambda runs four DuckDB queries, each bounded to keep the bundle small and the cost predictable:

**Layer 1 — Manifesto statements.**

```sql
SELECT ms.text, ms.category_code, ms.position, m.election_year
  FROM manifesto_statements ms
  JOIN manifestos m USING (manifesto_id)
 WHERE m.party_code = ?
   AND ms.category_code IN (SELECT category_code FROM topic_to_cmp WHERE topic_key = ?)
 ORDER BY m.election_year DESC
 LIMIT 20;
```

`topic_to_cmp` is a small YAML-to-Parquet mapping bundled with the Lambda; it maps common Swedish topic keywords (e.g. `"förskola"`, `"skola"`, `"skatt"`) to Manifesto Project category codes (e.g. `per506 Education Expansion`). Unknown topics fall back to embedding similarity on `manifesto_statements.text` against the query embedding.

**Layer 2 — Motions authored by the party on the topic.**

```sql
WITH candidate_docs AS (
  SELECT DISTINCT dok_id
    FROM document_chunks
    -- hybrid search candidate set, same pipeline as /v1/search, filtered to the party
)
SELECT d.dok_id, d.titel, d.datum, d.url_html
  FROM documents d
  JOIN document_authors da USING (dok_id)
  JOIN members mem USING (intressent_id)
 WHERE d.dok_id IN (SELECT dok_id FROM candidate_docs)
   AND d.doktyp = 'mot'
   AND mem.parti = ?
   AND d.datum BETWEEN ? AND ?
 ORDER BY d.datum DESC
 LIMIT 10;
```

**Layer 3 — Votes cast by the party on documents matching the topic.**

```sql
SELECT v.votering_id, v.datum, v.titel, v.dok_id,
       modal_rost(vr.rost) FILTER (WHERE vr.parti = ?) AS party_modal_rost,
       cohesion_pct(vr.rost) FILTER (WHERE vr.parti = ?) AS party_cohesion_pct
  FROM votes v
  JOIN vote_results vr USING (votering_id)
 WHERE v.dok_id IN (SELECT dok_id FROM candidate_docs)
   AND v.datum BETWEEN ? AND ?
 GROUP BY v.votering_id, v.datum, v.titel, v.dok_id
 ORDER BY v.datum DESC
 LIMIT 10;
```

**Layer 4 — Budget outturns for expenditure areas associated with the topic.**

```sql
SELECT year, expenditure_area_code, expenditure_area_name, budget_type, amount_sek
  FROM budget_by_area
 WHERE expenditure_area_code IN (SELECT uo_code FROM topic_to_uo WHERE topic_key = ?)
   AND budget_type = 'utfall'
   AND year BETWEEN YEAR(?) AND YEAR(?)
 ORDER BY year DESC, expenditure_area_code;
```

`topic_to_uo` is a second small YAML-to-Parquet mapping, from topic keywords to expenditure-area codes (e.g. `"förskola"` → `UO16` *Utbildning och universitetsforskning*, plus `UO25` *Allmänna bidrag till kommuner*).

Each layer is bounded (20, 10, 10, all-years-in-period). The combined JSON bundle rarely exceeds 8 KB, keeping input token cost well below $0.01 per cache miss.

### 4.2 Prompt

Stored at `iac/lambda/llm/prompts/ansvarsutkravande.v2.sv.md`, versioned in git. Served publicly at `/metodik/ansvarsutkravande`:

```
Du är en neutral och saklig analytiker av svensk politik. Du får fyra
strukturerade datalager om partiet {PARTY} och ämnet "{TOPIC}" under
perioden {FROM}–{TO}. Din uppgift är att producera exakt en rapport på
svenska, högst 150 ord, i tre stycken.

Stycke 1 — Löften: Sammanfatta vad partiet har lovat i sina valmanifest
om ämnet. Referera till valår och kategori.
Stycke 2 — Handling: Sammanfatta de motioner som partiets ledamöter har
lämnat på ämnet, och hur partiet har röstat i relevanta voteringar.
Stycke 3 — Resurser: Sammanfatta utfallet av relevanta utgiftsområden
under perioden.

Regler:
- Använd inga värdeladdade ord ("bra", "dålig", "svikit").
- Hitta inte på siffror eller dokument. Om ett datalager är tomt, säg "Ingen data i perioden" i det stycket.
- Varje påstående måste kunna härledas till ett dok_id, ett manifesto-utdrag, eller ett utgiftsområde i indata.
- Avsluta med en rad med källor, formatet: "Källor: {dok_id1}, {dok_id2}, …"
- Producera inte kommentarer eller metatext.

Indata:
Löften (manifest): {MANIFESTO_JSON}
Motioner: {MOTIONS_JSON}
Voteringar: {VOTES_JSON}
Utgiftsområden: {BUDGET_JSON}
```

### 4.3 Output validation

Before caching, the Lambda enforces:

1. Total word count ≤ 180 (slack above the 150-word target).
2. At least one `dok_id` cited in the `Källor:` line.
3. Every cited `dok_id` must appear in the input `MOTIONS_JSON` or `VOTES_JSON` — no hallucinated ids.
4. No occurrence of regex tokens that suggest hallucinated numbers outside the input (we grep numeric strings against the input JSON; if any four-digit-or-longer number in the output does not appear in the input, we discard).
5. Character-ratio heuristic: at least 85% of non-whitespace characters must be in the Swedish alphabet or digits — catches prompts that inject English content.

On validation failure, the Lambda writes `state=failed` to `accountability_jobs` with the reason, does not cache, and does not retry (the caller can re-submit to force a fresh generation).

### 4.4 Cache and freshness

See `06-storage-and-api.md` §5.4. Seven-day TTL, hash-based invalidation on input change, prompt version on the row.

## 5. Search endpoint — `POST /v1/search`

Hybrid FTS + vector search. Protocol and DuckDB FTS / NumPy cosine pipeline are documented in `06-storage-and-api.md` §3. This section covers the embedding call and the weighting rationale.

### 5.1 Embedding call

```python
resp = bedrock.invoke_model(
    modelId="amazon.titan-embed-text-v2:0",
    body=json.dumps({
        "inputText": query,
        "dimensions": 1024,
        "normalize": True,
    }).encode(),
)
vec = np.array(json.loads(resp["body"].read())["embedding"], dtype=np.float32)
```

Normalised vectors at ingestion and at query time let cosine become a dot product — a `matmul` over the `(N, 1024)` matrix finishes in ~5–10 ms for `N = 50k`.

### 5.2 Score weighting

Combined score = `0.4 · bm25_normalised + 0.6 · cosine`, where `bm25_normalised` is the BM25 score divided by the top-result's BM25 so both legs are in `[0, 1]`. Tie-breaker: `datum DESC`.

The 40/60 weighting is carried over from the existing implementation's tuning on Swedish parliamentary text. Civic-tech corpora consistently benefit from a vector-heavy mix because the questions are semantic ("what has been done about X") while the text uses formal parliamentary vocabulary that a lexical search misses unless the query uses the exact term.

### 5.3 The search path does not generate prose

This is an important invariant. The LLM's role in search is confined to producing a query vector; the result set is structured rows with `score`, `titel`, `datum`, `source_url`. Even if the query asks "give me a summary of X", the endpoint returns documents, not generated text. (A follow-up summary call for a specific `dok_id` is the user's explicit next step.)

This invariant is what makes hybrid search safe to ship without heavy guardrails: there is no free-form generation path that a bad-faith query can exploit.

## 6. Embedding refresh

A separate weekly Lambda (`embed-chunks`) runs Sunday 02:00 UTC to:

1. `SELECT dok_id, chunk_index, text FROM document_chunks LEFT JOIN document_embeddings USING (dok_id, chunk_index) WHERE embedding IS NULL LIMIT 256` (DuckDB over Parquet).
2. Batch-call Bedrock Titan Embed v2, 25 texts per request, `dimensions=1024`, `normalize=True`.
3. Append to `document_embeddings` as a new Parquet file in the partition; rewrite `_SUCCESS` marker.

A cold full rebuild of the whole embedding corpus is ~50k chunks × ~200 tokens/chunk × ~$0.02/1M tokens ≈ $0.20–$1 one-time. Incremental weekly cost is pennies.

## 7. Guardrails and fallback behaviour

| Failure mode | Behaviour |
|---|---|
| Bedrock quota exceeded | `/v1/summarise` returns 503 with the `source_url`. `/v1/search` falls back to DuckDB FTS-only (BM25) with a response header `X-Agora-Degraded: 1`. `/v1/accountability` returns 503 with the four-bundle input surfaced as a plain-data JSON (so the dashboard can render the raw evidence unsynthesised). |
| Model output fails validation (see §4.3 for accountability; §7.1 below for summaries) | Discard, do not cache, return 503 with `source_url`. |
| Bedrock not enabled in the account | All LLM endpoints return 501 with `source_url`; dashboard hides the "Sammanfattning" and "Ansvarsutkrävande" blocks and falls back to FTS-only search. The rest of the product works. |
| Suspected prompt injection in user search query | Queries are **not** passed into the summarisation or accountability prompts; they are only used as inputs to the embedding model and as SQL parameters. The prompts' `{…}` placeholders are bound to typed server-side values only. |
| Suspected prompt injection in ingested document text | The summary prompt treats the document text as opaque content between `---` markers; the system instruction is prepended and is not overridable by the content. Output validation is the backstop. |
| Monthly token budget crossed | A feature flag in SSM Parameter Store (`/agora/llm/enabled`) can be flipped to `false`; when false, all three endpoints return 503 with `source_url`. Budget alarms raise to a human before this, not after. |

### 7.1 Summary output validation

Discard if any of:

- More than 5 sentences.
- Contains HTML tags.
- Contains any value-laden stop-word from `iac/lambda/llm/prompts/stopwords.sv.txt` (e.g. `katastrofal`, `beundransvärd`).
- Fewer than 85% non-whitespace Swedish-alphabet characters.

## 8. Caching economics

- Summaries are produced at most once per `(dok_id, model_id)`. Re-summarising only happens on explicit model upgrade (which bumps `model_id`).
- Search queries are cached at CloudFront for 15 minutes, keyed on exact query string; this absorbs the "I pressed enter twice" pattern cheaply.
- Accountability reports are cached in DynamoDB for 7 days, keyed on `(party, topic_hash, period_hash)` with hash-based invalidation on input change.
- The embedding matrix is cached in Lambda warm memory for the duration of the container lifetime.

These four levels of cache mean that **steady-state LLM cost grows with unique summary and unique accountability demands, not with page views.** A realistic monthly LLM cost ceiling at coffee-budget traffic (~10k uniques/month) is ~$0.50.

## 9. Explicit non-features

- No chat interface. No multi-turn conversation. If someone wants to ask a follow-up, they click a result.
- No "compare these two motions" open generation. If we build that, it becomes a fixed, auditable template with bounded input — not an open LLM call.
- No generation of *new* claims or "what did the parliament decide about X this year" paragraphs outside the accountability endpoint, which has a fixed four-layer schema and a cite-or-fail output validator.
- No fine-tuning. Prompting + neutrality checks + short outputs keep quality sufficient.
- No storing of user queries beyond the CloudFront cache key hash. We do not build a query log.
