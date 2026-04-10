# RFC-10 — Storage Optimisations

| Field  | Value |
|--------|-------|
| Status | Implemented — pending manual migration apply |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/10-storage-optimisations.md` |

---

## Summary

Three targeted changes reduce the projected database footprint for 4 riksmöten from
~1.9 GB to ~1.3–1.45 GB, leaving ~6× headroom within Supabase Pro's 8 GB included
storage:

1. **Dropped `body_html`** from `document_texts` — only `body_text` is used at rest; the
   HTML is always re-fetchable from `documents.document_url`.
2. **Reduced embedding dimensions** from `vector(1024)` to `vector(512)` — Voyage AI's
   `voyage-4-lite` uses Matryoshka representation learning; the first 512 dimensions of
   any 1024-dim embedding are a valid 512-dim embedding at no quality cost.
3. **Restricted document chunking** to `mot`, `prop`, and `bet` — the substantive policy
   documents. `ip` and `fr` remain in `document_texts` for FTS but are no longer chunked
   or embedded.

Additionally, a riksmöte scope override (`RIKSMOTEN_OVERRIDE`) was added to the ingestion
script and a dedicated backfill workflow was created so historical riksmöten (2022/23 and
2023/24) can be ingested without changing the daily ingestion cron.

---

## Motivation

After ingesting two riksmöten (2024/25 and 2025/26), the database measured:

| Table | Rows | Storage |
|---|---|---|
| `document_chunks` | 33 578 | ~461 MB |
| `document_texts` | 12 047 | ~344 MB |
| `documents` | 12 107 | ~7 MB |
| `manifesto_statements` | 19 122 | ~129 MB |
| `vote_results` | 383 637 | ~74 MB |

Scaling naïvely to 4 riksmöten projects ~1.9 GB total. The three optimisations bring
that well within budget and make continued growth sustainable.

---

## Decisions

### Migration numbered 011, not 008

The product request spec refers to this as migration "008". As of implementation the
repository already contained migrations 001–010 (`010_manifesto_search.sql` being the
most recent). To preserve the monotonic sequence the migration was numbered
`011_storage_optimisations.sql`. The spec's numbering is stale and not authoritative.

### `011` supersedes `010_manifesto_search.sql`

`010_manifesto_search.sql` creates `match_manifesto_statements(vector(1024))`. The new
migration drops and recreates this function with a `vector(512)` parameter. The `DROP
FUNCTION IF EXISTS` in `011` handles this cleanly — no modification to `010` was needed.

### Single `EMBED_DIM` constant in `lib/api/embed.ts` covers all routes

All three routes that call `embedQuery()` (`/api/v1/search`, `/api/v1/search/manifesto`,
`/api/v1/accountability`) share the same helper. Changing `EMBED_DIM` in
`apps/web/lib/api/embed.ts` from `1024` to `512` was sufficient — no per-route changes
were required.

### Type filter applied at the chunking query in `generate-embeddings.ts`

The product request describes filtering at two levels: the chunking step and the
embedding-fetch step. Because `generate-embeddings.ts` creates chunks and embeds them in
a single pass (it reads from `document_texts`, chunks `body_text` on the fly, and writes
to `document_chunks`), the filter is applied once on the `document_texts` SELECT via a
`documents!inner(type)` join. This is equivalent to filtering at both levels and avoids
redundancy.

### `ip` and `fr` documents are not deleted

The spec states these types "can be omitted from the chunking script entirely." They are
not removed from `document_texts` or `documents` — they remain available for FTS via
`search_documents()`. Only their contribution to the vector index is eliminated by the
type filter.

### `RIKSMOTEN_OVERRIDE` in `riksdagen.ts` is parsed from `process.env` at call time

The override is read inside `getRiksmotenToIngest()` at runtime, not at module load time,
so there is no need to restart the process if the env var is set after import. This also
means the daily cron (which runs without `RIKSMOTEN_OVERRIDE`) is completely unaffected.

### Backfill workflow mirrors existing workflow conventions

`backfill-riksdagen.yml` uses the same `actions/checkout@v6`, `actions/setup-node@v6`
with `.nvmrc`, and `npm ci --engine-strict=false` pattern as all other workflows in the
repository. It does not trigger `embed.yml` automatically — embedding after backfill
is a separate manual trigger to allow inspection of the ingested data first.

---

## Files Created

| File | Description |
|---|---|
| `packages/db/migrations/011_storage_optimisations.sql` | Drops `body_html`, resizes embeddings to `vector(512)`, recreates HNSW indexes and both search functions |
| `.github/workflows/backfill-riksdagen.yml` | Manual `workflow_dispatch` workflow; accepts `riksmoten` input and sets `RIKSMOTEN_OVERRIDE` |

## Files Modified

| File | Change |
|---|---|
| `scripts/ingest/document-texts.ts` | Removed `body_html: html` from `document_texts` upsert payload |
| `scripts/embed/generate-embeddings.ts` | `EMBEDDING_DIM` 1024 → 512; `document_texts` SELECT joins `documents!inner(type)` and filters to `mot/prop/bet` |
| `scripts/ingest/riksdagen.ts` | `getRiksmotenToIngest()` checks `RIKSMOTEN_OVERRIDE` env var before computing default |
| `apps/web/lib/api/embed.ts` | `EMBED_DIM` 1024 → 512 (covers all three search/accountability routes) |
