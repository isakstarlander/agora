# RFC-06 — Search API Routes + API Key Protection Retrofit

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/06-api-search.md` |

---

## Summary

Implemented two search endpoints — `GET /api/v1/search` (hybrid full-text + vector
document search) and `GET /api/v1/search/manifesto` (semantic manifesto statement
search via `voyage-4-lite` embeddings). Both are gated behind API key authentication.

As part of this PR, all ten existing data routes (implemented in RFC-05) were
retrofitted with the same `requireApiKey` guard — closing the gap between the
implemented auth module (RFC-04) and the routes that consumed it. `tsc --noEmit`
exits clean.

---

## Motivation

The search endpoints are the first in the project to involve an external embedding
model (Voyage AI) at query time. Their value — ranked hybrid search across tens of
thousands of parliamentary documents, and semantic similarity across party manifestos —
is only meaningful once the embedding pipeline from RFC-03 has populated
`document_chunks.embedding` and `manifesto_statements.embedding`.

The API key retrofit was triggered by the realisation that RFC-04 built the full
authentication module but RFC-05 never wired it in. Every data endpoint was
effectively public. All future product requests (PR-07+) introduce the rule that every
`apiRoute` handler — except `keys/request` and `openapi` — must begin with a
`requireApiKey` check.

---

## Decisions

### Migration numbered 010, not 009

The spec (`api-first/06-api-search.md`) instructs creating `009_manifesto_search.sql`.
`009_api_keys.sql` was created in RFC-04. The migration was therefore numbered `010`.

### `position` quoted in SQL

PostgreSQL treats `position` as a reserved function name. The `RETURNS TABLE`
declaration and `SELECT` list in `010_manifesto_search.sql` both use `"position"` to
avoid the syntax error that would otherwise occur.

### `ZodError.issues` instead of `.errors`

Consistent with RFC-05: the project uses Zod v4, where the collection of validation
errors is `.issues`. All route files use `.issues[0]?.message`.

### Optional RPC params as `undefined` not `null`

The generated Supabase types for `search_documents` declare `doc_type` and `doc_rm` as
`string | undefined`. Passing `null` is a type error. Absent filters use `?? undefined`
instead of the spec's `?? null`.

### `match_manifesto_statements` RPC cast

`match_manifesto_statements` is defined in migration 010, which post-dates the
`packages/db/src/database.types.ts` snapshot. Until types are regenerated the call site
casts `supabase.rpc` to an `unknown` intermediary to satisfy the type checker, avoiding
`any` while remaining explicit about the shape.

### `voyageai` installed with `nvm use`

The workspace root `.nvmrc` pins Node 24. The local shell was running Node 22, which
caused `npm install voyageai` to fail with `EBADENGINE`. Running `nvm use` first
resolved this.

### `requireApiKey` enforced per-route, not in middleware

No `middleware.ts` exists in `apps/web/`. The auth guard is applied inline at the top
of each handler. This is consistent with the existing architecture and keeps the
enforcement visible at the call site.

---

## Files Created

| File | Description |
|---|---|
| `apps/web/lib/api/embed.ts` | Lazy `VoyageAIClient` singleton; `embedQuery(text)` produces a 1024-dim `voyage-4-lite` embedding |
| `apps/web/app/api/v1/search/route.ts` | `GET /api/v1/search` — hybrid FTS + vector document search via `search_documents` RPC |
| `apps/web/app/api/v1/search/manifesto/route.ts` | `GET /api/v1/search/manifesto` — semantic manifesto search with party/year post-filter and manifesto metadata enrichment |
| `packages/db/migrations/010_manifesto_search.sql` | `match_manifesto_statements` SQL function using cosine distance on `manifesto_statements.embedding` |

## Files Modified

| File | Change |
|---|---|
| `apps/web/lib/env.ts` | Added `VOYAGE_API_KEY` to server env schema and `runtimeEnv` |
| `apps/web/package.json` | Added `voyageai` dependency |
| `apps/web/app/api/v1/documents/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/documents/[id]/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/members/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/members/[id]/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/votes/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/votes/[id]/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/budget/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/budget/areas/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/parties/route.ts` | Added `requireApiKey` guard |
| `apps/web/app/api/v1/parties/[party]/votes/route.ts` | Added `requireApiKey` guard |
