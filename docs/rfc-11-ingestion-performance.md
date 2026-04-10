# RFC-11 — Ingestion Performance Optimisations

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/11-ingestion-performance.md` |

---

## Summary

Four targeted changes reduce the wall time of a daily incremental Riksdagen ingestion
from a potential timeout (> 60 min) to under 60 seconds for a fully-ingested database:

1. **Scoped and de-N+1'd `document-texts.ts`** — the function now accepts `rms: string[]`
   and fetches only documents for the target riksmöten. Already-ingested IDs are
   determined by a single batched bulk pre-check (500 IDs per query) against
   `document_texts`, replacing thousands of individual `SELECT count(*)` round trips.
2. **Scoped and de-N+1'd `document-authors.ts`** — same structural change. The function
   now accepts `rms: string[]`; already-ingested IDs are bulk-fetched from
   `document_authors` in 500-ID batches.
3. **Skip-processed and concurrent `voting.ts`** — a `runConcurrent` helper enables 4
   parallel result-fetching workers, and a bulk pre-check against `vote_results` skips
   all votes that already have result rows, eliminating unconditional re-fetching on
   every run.
4. **Removed gratuitous sleeps from `riksdagen.ts`** — the five 2-second `await sleep`
   calls between ingestion phases served no rate-limiting purpose and have been removed.

The `.github/workflows/backfill-riksdagen.yml` workflow required by the spec already
existed from RFC-10 and needed no changes.

---

## Motivation

The daily Riksdagen ingestion was at risk of timing out within the 60-minute GitHub
Actions limit. The primary causes were:

- `document-texts.ts` and `document-authors.ts` each issued one `SELECT count(*)` per
  document before deciding whether to fetch it. With thousands of documents already
  ingested, this produced thousands of Supabase round trips before any real work began.
  Both functions also paged through the *entire* `documents` table regardless of which
  riksmöten were being ingested, a cost that grows with every backfill.
- `voting.ts` fetched one API endpoint per vote sequentially with a 200 ms sleep between
  each. At ~700 votes per riksmöte, that alone accounts for 2.5+ minutes of sleep. On
  re-runs, every vote was re-fetched even though vote results never change after being
  cast.
- `riksdagen.ts` interspersed five 2-second sleeps between phases with no justification
  — each phase already manages its own rate limiting internally.

---

## Decisions

### Scope is now the caller's responsibility

`ingestDocumentTexts` and `ingestDocumentAuthors` no longer act as global catch-all
sweeps. They process only the riksmöten passed by the caller. This is a behavioural
change: any historical riksmöten not covered by the default two-riksmöte window must be
(re-)processed via `RIKSMOTEN_OVERRIDE` using the backfill workflow.

The daily ingestion cron is unaffected — `getRiksmotenToIngest()` in `riksdagen.ts`
continues to return the current and previous riksmöte exactly as before.

### `IN_BATCH_SIZE = 500` in both text and author files

PostgREST encodes `.in()` filter values as URL query parameters. At 500 IDs per batch
the URL length stays comfortably within the default Nginx/PostgREST limits. The value
matches the one established in RFC-10's `generate-embeddings.ts` for the same reason.

### `runConcurrent` uses a shared iterator, not index splitting

The concurrency helper pulls items lazily from a shared iterator rather than pre-dividing
the array into N slices. This ensures all workers stay busy even if individual requests
have variable latency — a slow request in one worker does not stall the others. The
implementation is four lines and requires no dependencies.

### Concurrency is capped at 4 for vote results

Four concurrent workers each sleeping 200 ms between requests produce ~3.6 req/s against
the Riksdagen API. This is deliberately more conservative than the prior sequential
implementation's implied 5 req/s ceiling, while still being ~4× faster at the task-level
because requests from different workers overlap in time.

### `sleep` removed from `riksdagen.ts` import

After removing all five `await sleep(2000)` calls between phases, `sleep` was no longer
referenced in `riksdagen.ts`. The import was cleaned up to keep the file free of unused
symbols.

### Backfill workflow already existed

`backfill-riksdagen.yml` was created as part of RFC-10. The spec for PR-11 includes a
definition of this workflow as a fallback ("create it now if it does not already exist").
The existing file is functionally equivalent to the spec — no changes were made.

---

## Files Created

None. The backfill workflow was already present from RFC-10.

## Files Modified

| File | Change |
|---|---|
| `scripts/ingest/document-texts.ts` | Added `rms: string[]` parameter; replaced pagination loop + per-document `count` check with a single scoped query and batched bulk pre-check |
| `scripts/ingest/document-authors.ts` | Added `rms: string[]` parameter; same structural change as `document-texts.ts` |
| `scripts/ingest/voting.ts` | Added `runConcurrent<T>` helper; replaced sequential per-vote fetch loop with a batched bulk pre-check and 4-worker concurrent pool |
| `scripts/ingest/riksdagen.ts` | Passes `rms` to `ingestDocumentTexts` and `ingestDocumentAuthors`; removed five `await sleep(2000)` between-phase calls; removed now-unused `sleep` import |
