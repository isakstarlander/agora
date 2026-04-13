# RFC-12 — Accountability Fixes

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/12-accountability-fixes.md` |

---

## Summary

Three classes of defect found after shipping RFC-07 and RFC-09 are resolved:

1. **OpenAPI security declarations** — six protected endpoints (`/documents`, `/votes`,
   `/budget`, `/search`, `/members/{id}/votes`, `/members/{id}/documents`) were missing
   `security: [{ BearerAuth: [] }]` in their `registerPath` calls, so the Swagger UI at
   `/docs` did not inject the stored bearer token when trying them. All six now declare
   the field.
2. **Thin accountability responses** — the legislation layer filtered to documents
   authored by party members (architecturally wrong; it is not an accountability signal).
   The promises layer returned sentence fragments because there was no minimum similarity
   threshold. Both are fixed: the legislation layer now returns the top-5 topically
   relevant documents regardless of author, and the promises layer applies a `similarity
   >= 0.5` floor before slicing.
3. **Every request called Claude** — there was no persistent cache for AI-generated
   summaries. The only deduplication was a 60-second Next.js ISR window. A new
   `accountability_cache` table now stores summaries keyed by `(party, topic_hash)` with
   a 7-day application TTL. Claude is only called on a cache miss.

`tsc --noEmit` exits clean after all changes.

---

## Motivation

RFC-07 shipped the accountability endpoint with two architectural shortcuts that made the
response data poor in practice:

- The legislation layer filtered `search_documents` results to documents authored by the
  queried party's members. This was the wrong question — the meaningful accountability
  signal is "what did parliament debate on this topic and how did the party vote?" not
  "what did this party write?". Because few documents passed the filter, the votes layer
  (which is downstream of legislation) also returned empty.
- No similarity floor on the promises layer meant that even distant manifesto matches
  surfaced. For topics with no strong manifesto signal, sentence fragments like
  `"Inte klimatet."` appeared in the output.

The Claude cost issue was noticed separately: with no server-side cache, every unique
(party, topic) pair called Claude on every request. A 60-second ISR window on the demo
page was the only deduplication, and it only covered the demo — direct API calls from
external consumers had no protection at all.

The OpenAPI security gap was found during manual verification of the Swagger UI after
RFC-09: the lock icon did not appear on endpoints that require a key, making the
interactive docs misleading.

---

## Decisions

### Migration numbered `012`, not `009`

The spec file names the new migration `009_accountability_cache.sql` and places it under
`supabase/migrations/`. Both are incorrect for this repository: migrations live under
`packages/db/migrations/`, and the most recent existing file is
`011_storage_optimisations.sql`. The migration was created as
`packages/db/migrations/012_accountability_cache.sql` to preserve sequential ordering.
The `supabase/migrations/` directory referenced in the spec does not exist.

### `cachedSummary` uses three-state `undefined | null | string`

The cached summary value distinguishes three states:
- `undefined` — the cache was not checked (free tier; skip synthesis branch entirely)
- `null` — the cache was checked and recorded a past synthesis failure (do not retry Claude)
- `string` — a valid cached summary; return without calling Claude

Using `undefined` as the sentinel for "not checked" lets the synthesis decision be a
single `if (!isPaidTier) … else if (cachedSummary !== undefined) … else { /* miss */ }`
branch with no additional boolean flags.

### Cache is written even when `summary` is `null`

If Claude fails or returns no text, the route still upserts a row with `summary: null`.
This prevents repeated Claude calls for a (party, topic) pair that consistently yields no
useful output. The write is wrapped in `try/catch` so a cache failure is non-fatal.

### Prompt caching on the static system prompt

`cache_control: { type: 'ephemeral' }` is applied to the `SYNTHESIS_SYSTEM` text block.
The Anthropic SDK's `TextBlockParam` type does not include `cache_control` in its public
types, so the block is cast as `Anthropic.TextBlockParam & { cache_control: { type:
'ephemeral' } }`. This reduces input token cost approximately 90% for repeated cache
misses that share the same instruction text.

### Legislation layer `doc_type` and `doc_rm` passed as `undefined`, not `null`

Consistent with RFC-07: the generated Supabase types for the `search_documents` RPC
declare optional parameters as `string | undefined`. The spec samples pass `null`;
these were changed to `undefined` to satisfy the type checker.

### `parsed.error.issues` instead of `.errors`

Consistent with RFC-07: Zod v4 renamed `.errors` to `.issues`.

### `database.types.ts` updated manually

The `accountability_cache` table was added to the `Database['public']['Tables']` type by
hand rather than regenerating via `supabase gen types typescript`. Regeneration requires
a running Supabase instance with the migration already applied, which is a deployment
prerequesite, not a build-time step. The manually authored type matches the migration
schema exactly and will be overwritten cleanly on the next `gen types` run after the
migration is applied.

---

## Files Created

| File | Description |
|---|---|
| `packages/db/migrations/012_accountability_cache.sql` | New `accountability_cache` table with `(party, topic_hash)` PK and `generated_at` index for TTL sweeps |

## Files Modified

| File | Change |
|---|---|
| `packages/db/src/database.types.ts` | Added `accountability_cache` table to `Database['public']['Tables']` |
| `apps/web/lib/api/openapi/spec.ts` | Added `security: [{ BearerAuth: [] }]` to six `registerPath` calls: `/documents`, `/votes`, `/budget`, `/search`, `/members/{id}/votes`, `/members/{id}/documents` |
| `apps/web/app/api/v1/accountability/route.ts` | Full rewrite: similarity floor on promises layer, author filter removed from legislation layer, cache lookup and write around Claude synthesis, prompt caching on system block, tier-gating for synthesis |

---

## Deployment Order

The migration must be applied **before** the updated route is deployed, because the
route writes to `accountability_cache` on every paid-tier cache miss.

1. Apply `012_accountability_cache.sql` via Supabase dashboard SQL editor or `supabase db push`
2. Deploy `spec.ts` and `accountability/route.ts` (can be the same commit)
3. Verify budget area 20 data: `SELECT expenditure_area_code, COUNT(*) FROM budget_outcomes WHERE expenditure_area_code = '20' GROUP BY 1;` — if 0 rows, re-run `npm run ingest:esv --workspace=scripts`
